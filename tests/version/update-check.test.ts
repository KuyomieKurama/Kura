import { describe, expect, it } from 'vitest';
import type { UpdateCheckConfig } from '../../apps/api/src/config.js';
import { buildVersionView, sanitizeReleaseNotes, UpdateCheckDisabledError, UpdateChecker, type CheckState } from '../../apps/api/src/update-check.js';
import { FakeTime, MemoryStore, ScriptedFetch, settle } from './update-helpers.js';

const TAGS = '/repos/o/r/tags';
const LATEST = '/repos/o/r/releases/latest';
const HOUR = 3_600_000;
const settings: UpdateCheckConfig = { enabled: true, repository: 'o/r', apiBase: 'http://github.invalid', channel: 'stable' };

function setup(overrides: { settings?: Partial<UpdateCheckConfig>; version?: string; store?: MemoryStore; time?: FakeTime; github?: ScriptedFetch } = {}) {
  const time = overrides.time ?? new FakeTime();
  const store = overrides.store ?? new MemoryStore();
  const github = overrides.github ?? new ScriptedFetch()
    .set(TAGS, { body: [{ name: 'v0.3.0' }, { name: 'v0.2.0' }, { name: 'm5' }], headers: { etag: '"t1"' } })
    .set(LATEST, { status: 404, body: { message: 'Not Found' } });
  const checker = new UpdateChecker({
    build: { version: overrides.version ?? '0.2.0', commit: 'abcdef1' },
    settings: { ...settings, ...overrides.settings }, store, clock: time, timers: time, fetchFunction: github.fetch
  });
  return { time, store, github, checker };
}

describe('scheduling with a fake clock', () => {
  it('checks 60 seconds after the start, then every 12 hours', async () => {
    const { time, github, checker } = setup();
    checker.start();
    await time.advance(59_999);
    expect(github.calls).toHaveLength(0);
    await time.advance(1);
    expect(github.callsTo(TAGS)).toHaveLength(1);
    expect(github.callsTo(LATEST)).toHaveLength(1);
    await time.advance(12 * HOUR - 1);
    expect(github.callsTo(TAGS)).toHaveLength(1);
    await time.advance(1);
    expect(github.callsTo(TAGS)).toHaveLength(2);
    await time.advance(12 * HOUR);
    expect(github.callsTo(TAGS)).toHaveLength(3);
    checker.stop();
  });

  it('sends the stored ETag on the next scheduled check and keeps the result on 304', async () => {
    const { time, github, checker } = setup();
    github.set(TAGS, () => (github.callsTo(TAGS).length === 1
      ? { body: [{ name: 'v0.3.0' }], headers: { etag: '"t1"' } }
      : { status: 304 }));
    checker.start();
    await time.advance(60_000);
    await time.advance(12 * HOUR);
    expect(github.callsTo(TAGS)[0]?.headers['if-none-match']).toBeUndefined();
    expect(github.callsTo(TAGS)[1]?.headers['if-none-match']).toBe('"t1"');
    expect((await checker.view()).latestVersion).toBe('0.3.0');
    checker.stop();
  });

  it('stop() cancels the pending check', async () => {
    const { time, github, checker } = setup();
    checker.start();
    checker.stop();
    expect(time.pendingCount).toBe(0);
    await time.advance(24 * HOUR);
    expect(github.calls).toHaveLength(0);
  });

  it('retries after one hour when a check failed, and returns to 12 hours after a success', async () => {
    const { time, github, checker } = setup();
    let healthy = false;
    github.set(TAGS, () => (healthy ? { body: [{ name: 'v0.3.0' }] } : { status: 500, body: {} }));
    checker.start();
    await time.advance(60_000);
    expect(github.callsTo(TAGS)).toHaveLength(1);
    expect(time.nextInMs).toBe(HOUR);
    healthy = true;
    await time.advance(HOUR);
    expect(github.callsTo(TAGS)).toHaveLength(2);
    expect(time.nextInMs).toBe(12 * HOUR);
    checker.stop();
  });

  it('does not start a second timer when start() is called twice', () => {
    const { time, checker } = setup();
    checker.start();
    checker.start();
    expect(time.pendingCount).toBe(1);
    checker.stop();
  });
});

describe('result of a check', () => {
  it('reports an outdated version with the tag URL when no release exists', async () => {
    const { checker } = setup();
    const view = await checker.checkNow();
    expect(view).toMatchObject({
      status: 'outdated', version: '0.2.0', commit: 'abcdef1', latestVersion: '0.3.0', latestTag: 'v0.3.0', hasRelease: false,
      releaseUrl: 'https://github.com/o/r/tree/v0.3.0', releaseNotes: null, reason: null, checkEnabled: true
    });
    expect(view.checkedAt).toBe('2026-10-11T12:00:00.000Z');
  });

  it('uses the release page and the notes when a release exists for the newest tag', async () => {
    const { checker, github } = setup();
    github.set(LATEST, { body: { tag_name: 'v0.3.0', body: 'Neu: Versionspr\u00fcfung\r\n\u0007 <b>fett</b>' }, headers: { etag: '"r1"' } });
    const view = await checker.checkNow();
    expect(view).toMatchObject({ hasRelease: true, releaseUrl: 'https://github.com/o/r/releases/tag/v0.3.0' });
    expect(view.releaseNotes).toBe('Neu: Versionspr\u00fcfung\n <b>fett</b>');
  });

  it('ignores a release that belongs to an older tag', async () => {
    const { checker, github } = setup();
    github.set(LATEST, { body: { tag_name: 'v0.2.0', body: 'alt' } });
    expect(await checker.checkNow()).toMatchObject({ hasRelease: false, releaseNotes: null, releaseUrl: 'https://github.com/o/r/tree/v0.3.0' });
  });

  it('is current when the running version equals or exceeds the newest tag', async () => {
    expect((await setup({ version: '0.3.0' }).checker.checkNow()).status).toBe('current');
    expect((await setup({ version: '0.4.0-dev.1' }).checker.checkNow()).status).toBe('current');
  });

  it('compares with semver rules: a pre-release is older than its release', async () => {
    expect((await setup({ version: '0.3.0-rc.1' }).checker.checkNow()).status).toBe('outdated');
  });

  it('does not offer a pre-release on the stable channel, but does on the prerelease channel', async () => {
    const tags = [{ name: 'v0.3.0-rc.1' }, { name: 'v0.2.0' }];
    expect((await setup({ github: new ScriptedFetch().set(TAGS, { body: tags }).set(LATEST, { status: 404 }) }).checker.checkNow()).status).toBe('current');
    const prerelease = setup({ settings: { channel: 'prerelease' }, github: new ScriptedFetch().set(TAGS, { body: tags }).set(LATEST, { status: 404 }) });
    expect(await prerelease.checker.checkNow()).toMatchObject({ status: 'outdated', latestVersion: '0.3.0-rc.1', channel: 'prerelease' });
  });

  it('is unknown when no tag is a version, and when the own version is not one', async () => {
    const noTags = new ScriptedFetch().set(TAGS, { body: [{ name: 'm3' }] }).set(LATEST, { status: 404 });
    expect(await setup({ github: noTags }).checker.checkNow()).toMatchObject({ status: 'unknown', latestVersion: null });
    const unknownOwn = await setup({ version: 'unbekannt' }).checker.checkNow();
    expect(unknownOwn).toMatchObject({ status: 'unknown', latestVersion: '0.3.0' });
    expect(unknownOwn.reason).toContain('unbekannt');
  });

  it('is unknown before the first check', async () => {
    const view = await setup().checker.view();
    expect(view).toMatchObject({ status: 'unknown', checkedAt: null });
    expect(view.reason).toContain('Noch nicht geprüft');
  });

  it('shares one request between concurrent on-demand checks', async () => {
    const { checker, github } = setup();
    await Promise.all([checker.checkNow(), checker.checkNow(), checker.checkNow()]);
    expect(github.callsTo(TAGS)).toHaveLength(1);
  });
});

describe('errors never break anything', () => {
  it('states unknown with the reason after a failed first check', async () => {
    const { checker, github } = setup();
    github.set(TAGS, { status: 500, body: {} });
    const view = await checker.checkNow();
    expect(view).toMatchObject({ status: 'unknown', checkedAt: null, reason: 'GitHub antwortete mit dem Status 500.' });
    expect(view.attemptedAt).not.toBeNull();
  });

  it('keeps the last known result when a later check fails', async () => {
    const { checker, github } = setup();
    await checker.checkNow();
    github.set(TAGS, { status: 500, body: {} });
    const view = await checker.checkNow();
    expect(view).toMatchObject({ status: 'outdated', latestVersion: '0.3.0', reason: 'GitHub antwortete mit dem Status 500.' });
  });

  it('survives a throwing fetch, a failing store and a failing load', async () => {
    const store = new MemoryStore();
    store.failSave = true;
    store.failLoad = true;
    const { checker } = setup({ store });
    const thrower = setup({ store });
    thrower.github.set(TAGS, () => { throw new Error('boom'); });
    expect(await checker.checkNow()).toMatchObject({ status: 'outdated' });
    expect(await thrower.checker.checkNow()).toMatchObject({ status: 'unknown' });
  });

  it('records a failed release lookup but keeps the tag result', async () => {
    const { checker, github } = setup();
    github.set(LATEST, { status: 500, body: {} });
    const view = await checker.checkNow();
    expect(view).toMatchObject({ status: 'outdated', latestVersion: '0.3.0', hasRelease: false });
    expect(view.reason).toBe('GitHub antwortete mit dem Status 500.');
  });
});

describe('rate limit', () => {
  it('stops asking until the reset time, also for on-demand checks, then resumes', async () => {
    const { time, github, checker } = setup();
    github.set(TAGS, { status: 403, body: {}, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '7200' } });
    checker.start();
    await time.advance(60_000);
    expect(github.callsTo(TAGS)).toHaveLength(1);
    const during = await checker.checkNow();
    expect(github.callsTo(TAGS)).toHaveLength(1);
    expect(during.status).toBe('unknown');
    expect(during.reason).toContain('begrenzt');
    github.set(TAGS, { body: [{ name: 'v0.3.0' }] });
    await time.advance(HOUR);
    expect(github.callsTo(TAGS)).toHaveLength(1);
    await time.advance(HOUR);
    expect(github.callsTo(TAGS)).toHaveLength(2);
    expect((await checker.view()).status).toBe('outdated');
    checker.stop();
  });

  it('remembers the back-off across a restart', async () => {
    const store = new MemoryStore();
    const first = setup({ store });
    first.github.set(TAGS, { status: 429, body: {}, headers: { 'retry-after': '3600' } });
    await first.checker.checkNow();
    const second = setup({ store, time: first.time });
    await second.checker.checkNow();
    expect(second.github.calls).toHaveLength(0);
  });
});

describe('persistence', () => {
  it('survives a restart: the new process knows the result and the ETag without asking first', async () => {
    const store = new MemoryStore();
    await setup({ store }).checker.checkNow();
    const restarted = setup({ store });
    expect(await restarted.checker.view()).toMatchObject({ status: 'outdated', latestVersion: '0.3.0' });
    expect(restarted.github.calls).toHaveLength(0);
    restarted.github.set(TAGS, { status: 304 });
    await restarted.checker.checkNow();
    expect(restarted.github.callsTo(TAGS)[0]?.headers['if-none-match']).toBe('"t1"');
    expect((await restarted.checker.view()).latestVersion).toBe('0.3.0');
  });

  it('ignores a stored result of another repository or channel', async () => {
    const store = new MemoryStore();
    await setup({ store }).checker.checkNow();
    expect(await setup({ store, settings: { repository: 'other/repo' } }).checker.view()).toMatchObject({ status: 'unknown', latestVersion: null });
    expect(await setup({ store, settings: { channel: 'prerelease' } }).checker.view()).toMatchObject({ status: 'unknown', latestVersion: null });
  });

  it('keeps the dismissal per user', async () => {
    const { checker } = setup();
    expect(await checker.dismissedVersion('u1')).toBeNull();
    await checker.dismiss('u1', '0.3.0');
    expect(await checker.dismissedVersion('u1')).toBe('0.3.0');
    expect(await checker.dismissedVersion('u2')).toBeNull();
  });
});

describe('disabled mode', () => {
  it('makes no request, starts no timer, saves nothing, and refuses an on-demand check', async () => {
    const { time, github, store, checker } = setup({ settings: { enabled: false } });
    checker.start();
    expect(time.pendingCount).toBe(0);
    await time.advance(48 * HOUR);
    await settle();
    expect(await checker.view()).toMatchObject({ status: 'disabled', checkEnabled: false, latestVersion: null, version: '0.2.0' });
    await expect(checker.checkNow()).rejects.toBeInstanceOf(UpdateCheckDisabledError);
    expect(github.calls).toHaveLength(0);
    expect(store.saves).toBe(0);
  });

  it('shows disabled even when an earlier result is stored', () => {
    const state = { repository: 'o/r', channel: 'stable', latestTag: 'v9.0.0', latestVersion: '9.0.0', checkedAt: new Date() } as CheckState;
    expect(buildVersionView({ version: '0.2.0', commit: 'x' }, { ...settings, enabled: false }, state)).toMatchObject({ status: 'disabled', latestVersion: null });
  });
});

describe('sanitizeReleaseNotes', () => {
  it('returns null for empty notes and removes control and bidi characters', () => {
    expect(sanitizeReleaseNotes('  \n ')).toBeNull();
    expect(sanitizeReleaseNotes('a\u0000b\u202ec\td\ne')).toBe('abc\td\ne');
  });

  it('caps the length at 4000 characters', () => {
    const result = sanitizeReleaseNotes('x'.repeat(10_000))!;
    expect(result.startsWith('x'.repeat(4000))).toBe(true);
    expect(result.endsWith('[gekürzt]')).toBe(true);
    expect(result.length).toBeLessThan(4020);
  });
});
