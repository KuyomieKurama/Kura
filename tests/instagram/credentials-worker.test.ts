import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { encryptSecret } from '../../apps/api/src/immich-routes.js';
import { credentialAad } from '../../apps/api/src/instagram-routes.js';
import { JobExecutor } from '../../apps/worker/src/executor.js';
import {
  INSTAGRAM_COOKIES_EXPIRED_MESSAGE, INSTAGRAM_COOKIES_MISSING_MESSAGE, INSTAGRAM_COOKIES_UNREADABLE_MESSAGE
} from '../../apps/worker/src/credentials.js';
import { createPipelineFixture, type PipelineFixture } from '../m5b/fixture.js';
import type { ControllableTool } from '../m5b/tools.js';
import { FAKE_CSRF_VALUE, FAKE_FOREIGN_VALUE, FAKE_SESSION_VALUE } from './cookie-samples.js';
import { withCookieProbe, type CookieProbeTool } from './cookie-probe-tool.js';
import { fakeInstagramGalleryDl, fixture, INSTAGRAM_ROOT, type InstagramToolControl } from './fake-instagram-tool.js';

const PROFILE = `${INSTAGRAM_ROOT}/own_test_account/`;
const PROFILE_TOOL_URL = `${INSTAGRAM_ROOT}/own_test_account/posts/`;
const POST = `${INSTAGRAM_ROOT}/p/DPhoto00001/`;
const errorEntry = (error: string, message: string): unknown[] => [[-1, { error, message }]];
const LOGIN_WALL = errorEntry('AbortExtraction', 'HTTP redirect to login page (https://www.instagram.com/accounts/login/)');

const STORED_COOKIES = [
  '# Netscape HTTP Cookie File',
  `#HttpOnly_.instagram.com\tTRUE\t/\tTRUE\t1900000000\tsessionid\t${FAKE_SESSION_VALUE}`,
  `.instagram.com\tTRUE\t/\tTRUE\t1850000000\tcsrftoken\t${FAKE_CSRF_VALUE}`,
  ''
].join('\n');

/** The listings of the profile fixture and of each of its posts, as the real extractor prints them. */
async function profileListings(): Promise<Record<string, unknown>> {
  const entries = (await fixture('profile-posts')) as Array<[number, ...unknown[]]>;
  const byPost = new Map<string, unknown[]>();
  let current: unknown[] | undefined;
  for (const entry of entries) {
    if (entry[0] === 2) {
      current = [];
      byPost.set((entry.at(-1) as { post_shortcode: string }).post_shortcode, current);
    }
    current?.push(entry);
  }
  const result: Record<string, unknown> = { [PROFILE_TOOL_URL]: entries };
  for (const [code, messages] of byPost) {
    const type = (messages[0] as [number, { type: string }])[1].type;
    result[`${INSTAGRAM_ROOT}/${type === 'reel' ? 'reel' : 'p'}/${code}/`] = messages;
  }
  return result;
}

describe('stored Instagram cookies in the worker (fake gallery-dl, real PostgreSQL, no network)', () => {
  const open: PipelineFixture[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((subject) => subject.cleanup()));
  });

  async function start(control: InstagramToolControl, options: { workerKey?: Buffer | null; toolDelayMs?: number } = {}) {
    const inner = await fakeInstagramGalleryDl(control);
    const probe: CookieProbeTool = await withCookieProbe(inner, { delayMs: options.toolDelayMs });
    const subject = await createPipelineFixture({ tools: { galleryDl: probe as unknown as ControllableTool } });
    open.push(subject);
    // The fixture's own executor has no secret key; this one is built like the worker builds it.
    const workerKey = options.workerKey === undefined ? subject.secretKey : options.workerKey ?? undefined;
    const executor = new JobExecutor({
      pool: subject.pool, queue: subject.queue, subscriptions: subject.subscriptions, history: subject.history, blobstore: subject.blobstore,
      catalog: subject.catalog, handover: subject.handover, clock: subject.clock, logger: subject.logger, workDir: subject.workDir,
      maxAssetBytes: 10 * 1024 * 1024, ...(workerKey ? { secretKey: workerKey } : {})
    });
    const runOnce = async (userId: string, subscriptionId: string, signal: AbortSignal = new AbortController().signal) => {
      const lease = await subject.queueAndClaim(userId, subscriptionId);
      return executor.execute(lease, signal);
    };
    return { subject, inner, probe, runOnce };
  }

  /** Stores cookies the way the API does (same crypto, same additional authenticated data). */
  async function storeCookies(subject: PipelineFixture, userId: string, key: Buffer = subject.secretKey, text = STORED_COOKIES) {
    const encrypted = encryptSecret(key, text, credentialAad(userId));
    await subject.pool.query(
      `INSERT INTO platform_credentials (id, user_id, platform, cookies_ciphertext, cookies_nonce, cookie_count, earliest_expiry)
       VALUES ($1, $2, 'instagram', $3, $4, 2, to_timestamp(1850000000))`,
      [randomUUID(), userId, encrypted.ciphertext, encrypted.nonce]
    );
  }

  const credentialRow = async (subject: PipelineFixture, userId: string) =>
    (await subject.rows<{ last_used_at: Date | null; last_result: string }>('SELECT last_used_at, last_result FROM platform_credentials WHERE user_id = $1', [userId]))[0]!;

  async function expectNothingLeft(subject: PipelineFixture, observations: Array<{ path?: string }>) {
    for (const observation of observations) if (observation.path) expect(existsSync(observation.path)).toBe(false);
    expect((await readdir(subject.workDir)).filter((name) => name.startsWith('run-'))).toEqual([]);
  }

  function expectNoSecretIn(text: string) {
    for (const needle of [FAKE_SESSION_VALUE, FAKE_CSRF_VALUE, FAKE_FOREIGN_VALUE, 'sessionid', 'instagram-cookies']) expect(text).not.toContain(needle);
  }

  it('hands the decrypted cookies to gallery-dl as a 0600 file and deletes it afterwards', async () => {
    const { subject, probe, runOnce } = await start({ listings: await profileListings() });
    const userId = await subject.newUser();
    await storeCookies(subject, userId);
    const subscription = await subject.subscribe(userId, PROFILE);

    expect(await runOnce(userId, subscription.id)).toEqual({ result: 'stored' });

    const observations = await probe.observations();
    expect(observations.length).toBeGreaterThan(5); // the listings and every download
    for (const observation of observations) {
      expect(observation).toMatchObject({ cookies: true, mode: '600', directoryMode: '700' });
      expect(observation.content).toBe(STORED_COOKIES);
    }
    expect(new Set(observations.map((observation) => observation.path)).size).toBe(1);
    await expectNothingLeft(subject, observations);

    const row = await credentialRow(subject, userId);
    expect(row.last_result).toBe('ok');
    expect(row.last_used_at).toEqual(new Date('2026-06-01T10:00:00Z'));
  });

  it('never writes cookie content or the cookie file path to the log or to the history', async () => {
    const { subject, probe, runOnce } = await start({ listings: { [PROFILE_TOOL_URL]: LOGIN_WALL } });
    const userId = await subject.newUser();
    await storeCookies(subject, userId);
    const subscription = await subject.subscribe(userId, PROFILE);
    await runOnce(userId, subscription.id);

    const [observation] = await probe.observations();
    expect(observation!.path).toBeDefined();
    expectNoSecretIn(JSON.stringify(subject.logs));
    expect(JSON.stringify(subject.logs)).not.toContain(observation!.path!);
    const history = JSON.stringify(await subject.rows('SELECT * FROM download_runs'));
    expectNoSecretIn(history);
    expect(history).not.toContain(observation!.path!);
  });

  it('shows "Anmeldung abgelaufen", records auth_required and pauses when Instagram rejects the stored cookies', async () => {
    const { subject, probe, runOnce } = await start({ listings: { [PROFILE_TOOL_URL]: LOGIN_WALL } });
    const userId = await subject.newUser();
    await storeCookies(subject, userId);
    const subscription = await subject.subscribe(userId, PROFILE);

    const outcome = await runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', disposition: { runState: 'waiting_auth', code: 'AUTH_REQUIRED', pauseSubscription: true } });
    expect(await subject.rows('SELECT state, error_code, error_message FROM download_runs')).toEqual([
      { state: 'waiting_auth', error_code: 'AUTH_REQUIRED', error_message: INSTAGRAM_COOKIES_EXPIRED_MESSAGE }
    ]);
    expect(INSTAGRAM_COOKIES_EXPIRED_MESSAGE).toMatch(/^Instagram-Anmeldung abgelaufen: bitte Cookies neu hochladen/);
    expect((await credentialRow(subject, userId)).last_result).toBe('auth_required');
    expect((await subject.subscriptions.getSubscription(userId, subscription.id)).status).toBe('paused');
    await expectNothingLeft(subject, await probe.observations());
  });

  it('deletes the file also when the tool fails for another reason and leaves last_result alone', async () => {
    const { subject, probe, runOnce } = await start({ listingFailure: { stderr: 'something broke', exitCode: 1 } });
    const userId = await subject.newUser();
    await storeCookies(subject, userId);
    const subscription = await subject.subscribe(userId, PROFILE);

    const outcome = await runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', disposition: { code: 'PROCESS_FAILED' } });
    const observations = await probe.observations();
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every((observation) => observation.cookies && observation.mode === '600')).toBe(true);
    await expectNothingLeft(subject, observations);
    expect((await credentialRow(subject, userId)).last_result).toBe('unknown');
  });

  it('deletes the file when the run is aborted while the tool is running', async () => {
    const { subject, probe, runOnce } = await start({ listings: await profileListings() }, { toolDelayMs: 10_000 });
    const userId = await subject.newUser();
    await storeCookies(subject, userId);
    const subscription = await subject.subscribe(userId, PROFILE);
    const controller = new AbortController();

    const running = runOnce(userId, subscription.id, controller.signal);
    const started = Date.now();
    while ((await probe.observations()).length === 0 && Date.now() - started < 8_000) await new Promise((resolve) => setTimeout(resolve, 25));
    const [observation] = await probe.observations();
    expect(observation).toMatchObject({ cookies: true, mode: '600' });
    expect(existsSync(observation!.path!)).toBe(true); // it exists while the tool runs

    controller.abort('shutdown');
    const outcome = await running;

    expect(outcome).toMatchObject({ result: 'problem' });
    await expectNothingLeft(subject, await probe.observations());
  });

  it('without stored cookies runs the tool without -C and tells the user to upload cookies', async () => {
    const { subject, probe, runOnce } = await start({ listings: { [PROFILE_TOOL_URL]: LOGIN_WALL } });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, PROFILE);

    const outcome = await runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', disposition: { runState: 'waiting_auth', code: 'AUTH_REQUIRED', pauseSubscription: true } });
    expect(await subject.rows('SELECT state, error_message FROM download_runs')).toEqual([
      { state: 'waiting_auth', error_message: INSTAGRAM_COOKIES_MISSING_MESSAGE }
    ]);
    expect(INSTAGRAM_COOKIES_MISSING_MESSAGE).toMatch(/Cookies hoch/);
    expect((await probe.observations()).every((observation) => !observation.cookies)).toBe(true);
    expect((await subject.subscriptions.getSubscription(userId, subscription.id)).status).toBe('paused');
  });

  it('keeps the precise sentence for a private profile (no cookies) and for a checkpoint (with cookies)', async () => {
    const { subject, inner, runOnce } = await start({
      listings: { [PROFILE_TOOL_URL]: [] },
      listingStderr: "[instagram][warning] own_test_account's posts are private\n"
    });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, PROFILE);
    await runOnce(userId, subscription.id);

    await inner.control({ listings: { [PROFILE_TOOL_URL]: errorEntry('AbortExtraction', 'HTTP redirect to challenge page (https://www.instagram.com/challenge/)') } });
    await storeCookies(subject, userId);
    await subject.subscriptions.resumeSubscription(userId, subscription.id);
    subject.advance(3600);
    await runOnce(userId, subscription.id);

    const messages = (await subject.rows<{ error_message: string }>('SELECT error_message FROM download_runs ORDER BY started_at, id')).map((row) => row.error_message);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(/Profil ist privat/);
    expect(messages[1]).toMatch(/Sicherheitsprüfung/);
    for (const message of messages) {
      expect(message).not.toBe(INSTAGRAM_COOKIES_EXPIRED_MESSAGE);
      expect(message).not.toBe(INSTAGRAM_COOKIES_MISSING_MESSAGE);
    }
  });

  it('does the same for a single post that needs a login', async () => {
    const { subject, runOnce } = await start({
      listings: { [POST]: errorEntry('HttpError', "'401 Unauthorized' for 'https://www.instagram.com/api/v1/media/1/info/'") }
    });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, POST);

    await runOnce(userId, subscription.id);

    expect(await subject.rows('SELECT state, error_message FROM download_runs')).toEqual([
      { state: 'waiting_auth', error_message: INSTAGRAM_COOKIES_MISSING_MESSAGE }
    ]);
  });

  it('never uses the cookies of another user', async () => {
    const { subject, probe, runOnce } = await start({ listings: { [PROFILE_TOOL_URL]: LOGIN_WALL } });
    const alice = await subject.newUser('Alice');
    const bob = await subject.newUser('Bob');
    await storeCookies(subject, alice);
    const subscription = await subject.subscribe(bob, PROFILE);

    await runOnce(bob, subscription.id);

    expect((await probe.observations()).every((observation) => !observation.cookies)).toBe(true);
    expect(await subject.rows('SELECT error_message FROM download_runs')).toEqual([{ error_message: INSTAGRAM_COOKIES_MISSING_MESSAGE }]);
    expect(await credentialRow(subject, alice)).toMatchObject({ last_used_at: null, last_result: 'unknown' });
  });

  it('does not start the tool when the stored cookies cannot be decrypted (wrong key)', async () => {
    const { subject, probe, runOnce } = await start({ listings: await profileListings() });
    const userId = await subject.newUser();
    await storeCookies(subject, userId, randomBytes(32));
    const subscription = await subject.subscribe(userId, PROFILE);

    const outcome = await runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', disposition: { runState: 'waiting_auth', code: 'CREDENTIALS_UNREADABLE', pauseSubscription: true } });
    expect(await subject.rows('SELECT error_message FROM download_runs')).toEqual([{ error_message: INSTAGRAM_COOKIES_UNREADABLE_MESSAGE }]);
    expect(await probe.observations()).toEqual([]);
    expect((await credentialRow(subject, userId)).last_result).toBe('auth_required');
  });

  it('does not start the tool when the worker has no secret key', async () => {
    const { subject, probe, runOnce } = await start({ listings: await profileListings() }, { workerKey: null });
    const userId = await subject.newUser();
    await storeCookies(subject, userId);
    const subscription = await subject.subscribe(userId, PROFILE);

    const outcome = await runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', disposition: { code: 'CREDENTIALS_UNREADABLE' } });
    expect(await probe.observations()).toEqual([]);
  });

  it('does not touch the stored cookies for other platforms', async () => {
    const { subject, runOnce } = await start({});
    const userId = await subject.newUser();
    await storeCookies(subject, userId);
    const subscription = await subject.subscribe(userId, 'https://example.com/not-instagram.jpg');

    await runOnce(userId, subscription.id);

    expect(await credentialRow(subject, userId)).toMatchObject({ last_used_at: null, last_result: 'unknown' });
  });
});
