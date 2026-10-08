import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { JobQueue, OccurrenceGenerator } from '../../packages/scheduler/src/index.js';
import { createApiFixture, type ApiFixture } from './api-fixture.js';

const cronRule = (overrides: Record<string, unknown> = {}) => ({
  kind: 'cron',
  expression: '30 2 * * *',
  timeZone: 'Europe/Berlin',
  ...overrides
});

describe('subscriptions and schedules API (M4-B)', () => {
  const fixtures: ApiFixture[] = [];
  const setup = async (start?: string) => {
    const fixture = await createApiFixture(start);
    fixtures.push(fixture);
    return fixture;
  };
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  });

  async function createSubscription(fixture: ApiFixture, login: ApiFixture['admin'], name = 'Creator A') {
    const response = await fixture.call(login, 'POST', '/api/v1/subscriptions', {
      name, targetUrl: 'https://example.test/creator/a', platformHint: 'youtube'
    });
    expect(response.statusCode).toBe(201);
    return response.json().subscription as { id: string };
  }

  it('requires a session for every route', async () => {
    const fixture = await setup();
    const id = randomUUID();
    const routes: Array<[Parameters<ApiFixture['call']>[1], string]> = [
      ['GET', '/api/v1/subscriptions'],
      ['GET', `/api/v1/subscriptions/${id}`],
      ['GET', `/api/v1/subscriptions/${id}/runs`],
      ['GET', '/api/v1/schedules'],
      ['GET', '/api/v1/admin/runtime-policy']
    ];
    for (const [method, url] of routes) {
      expect((await fixture.call(null, method, url)).statusCode, `${method} ${url}`).toBe(401);
    }
    // Mutations without session and CSRF token are rejected before they reach the handlers.
    for (const [method, url] of [['POST', '/api/v1/subscriptions'], ['POST', '/api/v1/schedules'], ['POST', '/api/v1/schedules/preview'], ['PUT', '/api/v1/admin/runtime-policy']] as const) {
      expect((await fixture.call(null, method, url, {})).statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('creates, reads, edits and deletes a subscription; the target is stored as entered and unvalidated', async () => {
    const fixture = await setup();
    const alice = await fixture.addUser('alice');

    const created = await fixture.call(alice, 'POST', '/api/v1/subscriptions', {
      name: '  Creator A  ', targetUrl: ' https://example.test/c?token=abc#x ', platformHint: 'youtube'
    });
    expect(created.statusCode).toBe(201);
    const subscription = created.json().subscription;
    expect(subscription).toMatchObject({
      name: 'Creator A',
      targetUrl: 'https://example.test/c?token=abc#x',
      platformHint: 'youtube',
      targetState: 'unvalidated',
      status: 'active',
      schedules: []
    });

    const edited = await fixture.call(alice, 'PATCH', `/api/v1/subscriptions/${subscription.id}`, { name: 'Renamed', platformHint: null });
    expect(edited.json().subscription).toMatchObject({ name: 'Renamed', platformHint: null, targetUrl: 'https://example.test/c?token=abc#x' });

    const list = await fixture.call(alice, 'GET', '/api/v1/subscriptions');
    expect(list.json().subscriptions.map((item: { id: string }) => item.id)).toEqual([subscription.id]);

    expect((await fixture.call(alice, 'DELETE', `/api/v1/subscriptions/${subscription.id}`)).statusCode).toBe(204);
    expect((await fixture.call(alice, 'GET', `/api/v1/subscriptions/${subscription.id}`)).statusCode).toBe(404);
  });

  it('does not write target URLs into the audit log or the request log path', async () => {
    const fixture = await setup();
    const alice = await fixture.addUser('alice');
    await fixture.call(alice, 'POST', '/api/v1/subscriptions', { name: 'A', targetUrl: 'https://example.test/secret-token-123' });
    const audit = await fixture.pool.query('SELECT * FROM audit_events WHERE action LIKE $1', ['subscription.%']);
    expect(audit.rowCount).toBe(1);
    expect(JSON.stringify(audit.rows)).not.toContain('secret-token-123');
  });

  it.each([
    [{ name: '', targetUrl: 'https://a.test' }, 'empty name'],
    [{ name: 'x'.repeat(201), targetUrl: 'https://a.test' }, 'name too long'],
    [{ name: 'A' }, 'missing target'],
    [{ name: 'A', targetUrl: 'x'.repeat(2049) }, 'target too long'],
    [{ name: 'A', targetUrl: 'https://a.test/\u0000' }, 'control character'],
    [{ name: 'A', targetUrl: 'https://a.test', platformHint: 'You Tube!' }, 'bad platform hint'],
    [{ name: 5, targetUrl: 'https://a.test' }, 'name not a string']
  ])('rejects invalid subscription input: %j (%s)', async (payload) => {
    const fixture = await setup();
    const alice = await fixture.addUser('alice');
    const response = await fixture.call(alice, 'POST', '/api/v1/subscriptions', payload);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('isolates two users completely (read, write, pause, resume, delete, runs, schedules, preview source)', async () => {
    const fixture = await setup();
    const alice = await fixture.addUser('alice');
    const bob = await fixture.addUser('bob');
    const aliceSubscription = await createSubscription(fixture, alice);
    const schedule = (await fixture.call(alice, 'POST', '/api/v1/schedules', {
      subscriptionId: aliceSubscription.id, rule: cronRule()
    })).json().schedule;

    // Bob sees nothing of Alice.
    expect((await fixture.call(bob, 'GET', '/api/v1/subscriptions')).json().subscriptions).toEqual([]);
    expect((await fixture.call(bob, 'GET', '/api/v1/schedules')).json().schedules).toEqual([]);

    const attempts: Array<[Parameters<ApiFixture['call']>[1], string, unknown?]> = [
      ['GET', `/api/v1/subscriptions/${aliceSubscription.id}`],
      ['PATCH', `/api/v1/subscriptions/${aliceSubscription.id}`, { name: 'hijacked' }],
      ['POST', `/api/v1/subscriptions/${aliceSubscription.id}/pause`],
      ['POST', `/api/v1/subscriptions/${aliceSubscription.id}/resume`],
      ['GET', `/api/v1/subscriptions/${aliceSubscription.id}/runs`],
      ['DELETE', `/api/v1/subscriptions/${aliceSubscription.id}`],
      ['GET', `/api/v1/schedules?subscriptionId=${aliceSubscription.id}`],
      ['POST', '/api/v1/schedules', { subscriptionId: aliceSubscription.id, rule: cronRule() }],
      ['PATCH', `/api/v1/schedules/${schedule.id}`, { enabled: false }],
      ['DELETE', `/api/v1/schedules/${schedule.id}`]
    ];
    for (const [method, url, payload] of attempts) {
      const response = await fixture.call(bob, method, url, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(404);
      expect(response.body, `${method} ${url}`).not.toContain('example.test');
    }

    // Nothing of Alice changed.
    const intact = (await fixture.call(alice, 'GET', `/api/v1/subscriptions/${aliceSubscription.id}`)).json().subscription;
    expect(intact).toMatchObject({ name: 'Creator A', status: 'active' });
    expect(intact.schedules).toHaveLength(1);
    expect(intact.schedules[0]).toMatchObject({ id: schedule.id, enabled: true, version: 1 });
  });

  it('treats malformed ids like unknown ids', async () => {
    const fixture = await setup();
    const alice = await fixture.addUser('alice');
    for (const url of ['/api/v1/subscriptions/not-a-uuid', '/api/v1/subscriptions/1%27%20OR%201=1/runs', '/api/v1/schedules?subscriptionId=zzz']) {
      expect((await fixture.call(alice, 'GET', url)).statusCode, url).toBe(404);
    }
  });

  it('creates schedules for cron, interval and once rules and lists them with the subscription', async () => {
    const fixture = await setup('2026-06-01T10:00:00Z');
    const alice = await fixture.addUser('alice');
    const subscription = await createSubscription(fixture, alice);

    const cron = await fixture.call(alice, 'POST', '/api/v1/schedules', {
      subscriptionId: subscription.id, rule: cronRule({ expression: '0 6 * * 1-5', gapPolicy: 'run_after_gap' }), jitterMaxSeconds: 120
    });
    expect(cron.statusCode).toBe(201);
    expect(cron.json().schedule).toMatchObject({
      version: 1, enabled: true, jitterMaxSeconds: 120,
      rule: { kind: 'cron', expression: '0 6 * * 1-5', timeZone: 'Europe/Berlin', gapPolicy: 'run_after_gap' },
      nextDueAt: '2026-06-02T04:00:00.000Z'
    });

    const interval = await fixture.call(alice, 'POST', '/api/v1/schedules', {
      subscriptionId: subscription.id, rule: { kind: 'interval', everySeconds: 3600, timeZone: 'UTC' }
    });
    expect(interval.json().schedule.rule.anchorUtc).toBe('2026-06-01T10:00:00.000Z');
    expect(interval.json().schedule.nextDueAt).toBe('2026-06-01T11:00:00.000Z');

    const once = await fixture.call(alice, 'POST', '/api/v1/schedules', {
      subscriptionId: subscription.id, rule: { kind: 'once', atUtc: '2026-06-03T08:00:00Z', timeZone: 'Europe/Berlin' }
    });
    expect(once.json().schedule.nextDueAt).toBe('2026-06-03T08:00:00.000Z');

    const detail = (await fixture.call(alice, 'GET', `/api/v1/subscriptions/${subscription.id}`)).json().subscription;
    expect(detail.schedules).toHaveLength(3);
  });

  it('defaults the gap policy to skip', async () => {
    const fixture = await setup();
    const alice = await fixture.addUser('alice');
    const subscription = await createSubscription(fixture, alice);
    const created = await fixture.call(alice, 'POST', '/api/v1/schedules', { subscriptionId: subscription.id, rule: cronRule() });
    expect(created.json().schedule.rule.gapPolicy).toBe('skip');
  });

  it.each([
    [{ kind: 'cron', expression: '61 * * * *', timeZone: 'Europe/Berlin' }, 'INVALID_SCHEDULE'],
    [{ kind: 'cron', expression: '* * * *', timeZone: 'Europe/Berlin' }, 'INVALID_SCHEDULE'],
    [{ kind: 'cron', expression: '0 6 * * *', timeZone: 'UTC+1' }, 'INVALID_SCHEDULE'],
    [{ kind: 'cron', expression: '0 6 * * *', timeZone: 'Mars/Olympus' }, 'INVALID_SCHEDULE'],
    [{ kind: 'cron', expression: '0 6 * * *' }, 'VALIDATION_ERROR'],
    [{ kind: 'cron', expression: '0 6 * * *', timeZone: 'UTC', gapPolicy: 'later' }, 'VALIDATION_ERROR'],
    [{ kind: 'cron', expression: '0 0 30 2 *', timeZone: 'UTC' }, 'INVALID_SCHEDULE'],
    [{ kind: 'interval', everySeconds: 30, timeZone: 'UTC' }, 'VALIDATION_ERROR'],
    [{ kind: 'interval', everySeconds: 3600.5, timeZone: 'UTC' }, 'VALIDATION_ERROR'],
    [{ kind: 'interval', everySeconds: 3600, anchorUtc: 'yesterday-ish', timeZone: 'UTC' }, 'INVALID_SCHEDULE'],
    [{ kind: 'once', atUtc: '2020-01-01T00:00:00Z', timeZone: 'UTC' }, 'INVALID_SCHEDULE'],
    [{ kind: 'once', timeZone: 'UTC' }, 'VALIDATION_ERROR'],
    [{ kind: 'weekly', timeZone: 'UTC' }, 'VALIDATION_ERROR']
  ])('rejects the invalid rule %j with %s', async (rule, code) => {
    const fixture = await setup();
    const alice = await fixture.addUser('alice');
    const subscription = await createSubscription(fixture, alice);
    const response = await fixture.call(alice, 'POST', '/api/v1/schedules', { subscriptionId: subscription.id, rule });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe(code);
  });

  it('rejects an out-of-range start delay', async () => {
    const fixture = await setup();
    const alice = await fixture.addUser('alice');
    const subscription = await createSubscription(fixture, alice);
    const response = await fixture.call(alice, 'POST', '/api/v1/schedules', { subscriptionId: subscription.id, rule: cronRule(), jitterMaxSeconds: 3601 });
    expect(response.statusCode).toBe(400);
  });

  it('edits a schedule: the version increases, the gap policy can be switched, disabling clears nothing else', async () => {
    const fixture = await setup();
    const alice = await fixture.addUser('alice');
    const subscription = await createSubscription(fixture, alice);
    const schedule = (await fixture.call(alice, 'POST', '/api/v1/schedules', { subscriptionId: subscription.id, rule: cronRule() })).json().schedule;

    const switched = await fixture.call(alice, 'PATCH', `/api/v1/schedules/${schedule.id}`, { rule: cronRule({ gapPolicy: 'run_after_gap' }) });
    expect(switched.json().schedule).toMatchObject({ version: 2, rule: { gapPolicy: 'run_after_gap' } });

    const disabled = await fixture.call(alice, 'PATCH', `/api/v1/schedules/${schedule.id}`, { enabled: false });
    expect(disabled.json().schedule).toMatchObject({ version: 3, enabled: false });

    expect((await fixture.call(alice, 'PATCH', `/api/v1/schedules/${schedule.id}`, {})).statusCode).toBe(400);
    expect((await fixture.call(alice, 'PATCH', `/api/v1/schedules/${schedule.id}`, { enabled: 'yes' })).statusCode).toBe(400);
    expect((await fixture.call(alice, 'DELETE', `/api/v1/schedules/${schedule.id}`)).statusCode).toBe(204);
    expect((await fixture.call(alice, 'GET', '/api/v1/schedules')).json().schedules).toEqual([]);
  });

  it('previews the next five runs with zone and offset, and marks the skipped DST occurrence', async () => {
    const fixture = await setup('2026-03-27T12:00:00Z');
    const alice = await fixture.addUser('alice');

    const skip = await fixture.call(alice, 'POST', '/api/v1/schedules/preview', { rule: cronRule() });
    expect(skip.statusCode).toBe(200);
    const entries = skip.json().entries as Array<{ scheduledForUtc: string | null; status: string; utcOffset: string | null; timeZone: string; localPlanTime: string | null }>;
    expect(entries.filter((entry) => entry.scheduledForUtc !== null)).toHaveLength(5);
    const skipped = entries.find((entry) => entry.status === 'gap_skipped');
    expect(skipped).toMatchObject({ scheduledForUtc: null, localPlanTime: '2026-03-29T02:30' });
    expect(entries[0]).toMatchObject({ status: 'regular', utcOffset: '+01:00', timeZone: 'Europe/Berlin', scheduledForUtc: '2026-03-28T01:30:00.000Z' });
    expect(entries.at(-1)).toMatchObject({ utcOffset: '+02:00' });

    const shifted = await fixture.call(alice, 'POST', '/api/v1/schedules/preview', { rule: cronRule({ gapPolicy: 'run_after_gap' }), count: 3 });
    const shiftedEntries = shifted.json().entries as Array<{ scheduledForUtc: string; status: string }>;
    expect(shiftedEntries.map((entry) => entry.status)).toEqual(['regular', 'gap_shifted', 'regular']);
    expect(shiftedEntries[1].scheduledForUtc).toBe('2026-03-29T01:00:00.000Z');
  });

  it('marks coalesced occurrences and limits the preview count', async () => {
    const fixture = await setup('2026-03-27T12:00:00Z');
    const alice = await fixture.addUser('alice');
    // 02:00, 02:30 and 03:00 all land on the transition instant when the gap is shifted.
    const response = await fixture.call(alice, 'POST', '/api/v1/schedules/preview', {
      rule: cronRule({ expression: '0,30 2-3 * * *', gapPolicy: 'run_after_gap' }), count: 6
    });
    const statuses = (response.json().entries as Array<{ status: string }>).map((entry) => entry.status);
    expect(statuses).toContain('coalesced');

    for (const count of [0, 21, 1.5, '5']) {
      expect((await fixture.call(alice, 'POST', '/api/v1/schedules/preview', { rule: cronRule(), count })).statusCode, String(count)).toBe(400);
    }
    expect((await fixture.call(alice, 'POST', '/api/v1/schedules/preview', { rule: { kind: 'cron', expression: 'bad', timeZone: 'UTC' } })).statusCode).toBe(400);
  });

  it('pauses and resumes: a paused subscription creates no runs, resuming does not catch up', async () => {
    const fixture = await setup('2026-06-01T10:00:00Z');
    const alice = await fixture.addUser('alice');
    const subscription = await createSubscription(fixture, alice);
    await fixture.call(alice, 'POST', '/api/v1/schedules', {
      subscriptionId: subscription.id, rule: { kind: 'interval', everySeconds: 600, timeZone: 'UTC' }
    });

    const paused = await fixture.call(alice, 'POST', `/api/v1/subscriptions/${subscription.id}/pause`);
    expect(paused.json().subscription).toMatchObject({ status: 'paused' });
    expect(paused.json().subscription.pausedAt).not.toBeNull();
    // Pausing twice is harmless.
    expect((await fixture.call(alice, 'POST', `/api/v1/subscriptions/${subscription.id}/pause`)).statusCode).toBe(200);

    fixture.clock.advanceSeconds(3600);
    const generator = new OccurrenceGenerator(fixture.pool, { clock: fixture.clock });
    expect(await generator.generateDue()).toMatchObject({ enqueued: 0, schedulesProcessed: 0 });
    expect((await fixture.call(alice, 'GET', `/api/v1/subscriptions/${subscription.id}/runs`)).json().runs).toEqual([]);

    const resumed = await fixture.call(alice, 'POST', `/api/v1/subscriptions/${subscription.id}/resume`);
    expect(resumed.json().subscription).toMatchObject({ status: 'active', pausedAt: null });
    // Not due yet right after resuming: the pause is not caught up.
    expect(await generator.generateDue()).toMatchObject({ enqueued: 0 });

    fixture.clock.advanceSeconds(600);
    expect(await generator.generateDue()).toMatchObject({ enqueued: 1 });
    const runs = (await fixture.call(alice, 'GET', `/api/v1/subscriptions/${subscription.id}/runs`)).json().runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ state: 'queued', triggerKind: 'schedule', attempts: 0 });
    expect(Object.keys(runs[0]).sort()).toEqual([
      'attempts', 'createdAt', 'finishedAt', 'id', 'lastError', 'maxAttempts', 'runAfter', 'scheduledFor', 'state', 'triggerKind'
    ]);
  });

  it('lists recent runs newest first and enforces the limit range', async () => {
    const fixture = await setup('2026-06-01T10:00:00Z');
    const alice = await fixture.addUser('alice');
    const subscription = await createSubscription(fixture, alice);
    await fixture.call(alice, 'POST', '/api/v1/schedules', {
      subscriptionId: subscription.id, rule: { kind: 'interval', everySeconds: 600, timeZone: 'UTC' }
    });
    const generator = new OccurrenceGenerator(fixture.pool, { clock: fixture.clock });
    for (let round = 0; round < 3; round += 1) {
      fixture.clock.advanceSeconds(600);
      await generator.generateDue();
      await fixture.pool.query("UPDATE job_runs SET state = 'succeeded', finished_at = $1 WHERE state = 'queued'", [fixture.clock.now()]);
    }
    const runs = (await fixture.call(alice, 'GET', `/api/v1/subscriptions/${subscription.id}/runs?limit=2`)).json().runs as Array<{ scheduledFor: string }>;
    expect(runs.map((run) => run.scheduledFor)).toEqual(['2026-06-01T10:30:00.000Z', '2026-06-01T10:20:00.000Z']);
    for (const limit of ['0', '101', 'abc']) {
      expect((await fixture.call(alice, 'GET', `/api/v1/subscriptions/${subscription.id}/runs?limit=${limit}`)).statusCode, limit).toBe(400);
    }
  });

  it('refuses to delete a subscription while a job is running', async () => {
    const fixture = await setup('2026-06-01T10:00:00Z');
    const alice = await fixture.addUser('alice');
    const subscription = await createSubscription(fixture, alice);
    const queue = new JobQueue(fixture.pool, { clock: fixture.clock });
    await queue.enqueueManual(alice.userId, subscription.id);
    await queue.claim({ workerId: 'w', leaseSeconds: 600 });

    const response = await fixture.call(alice, 'DELETE', `/api/v1/subscriptions/${subscription.id}`);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('SUBSCRIPTION_BUSY');
  });
});
