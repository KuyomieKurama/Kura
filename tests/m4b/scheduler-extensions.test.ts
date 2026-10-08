import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RUNTIME_POLICY,
  InvalidRuntimePolicyError,
  NotFoundError,
  PolicyVersionConflictError,
  RetentionCleaner,
  RuntimePolicyRepository,
  SubscriptionBusyError,
  parseRuntimePolicy,
  toQueueLimits,
  type ScheduleRule
} from '../../packages/scheduler/src/index.js';
import { createSchedulerFixture, type SchedulerFixture } from '../scheduler/fixture.js';

const hourly: ScheduleRule = {
  kind: 'interval',
  everySeconds: 3600,
  anchorUtc: '2026-01-01T00:00:00Z',
  timeZone: 'UTC'
};

describe('subscription repository additions (M4-B)', () => {
  const fixtures: SchedulerFixture[] = [];
  const setup = async (start?: string) => {
    const fixture = await createSchedulerFixture(start);
    fixtures.push(fixture);
    return fixture;
  };
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  });

  it('stores the platform hint and starts every target as unvalidated', async () => {
    const fixture = await setup();
    const userId = await fixture.newUser();
    const created = await fixture.subscriptions.createSubscription({
      userId, name: 'Channel', sourceRef: 'https://example.test/c/1', platformHint: 'youtube'
    });
    expect(created).toMatchObject({ platformHint: 'youtube', targetState: 'unvalidated' });
  });

  it('lists only the own subscriptions and schedules', async () => {
    const fixture = await setup();
    const alice = await fixture.newUser('Alice');
    const bob = await fixture.newUser('Bob');
    const aliceSubscription = await fixture.subscriptions.createSubscription({ userId: alice, name: 'A' });
    const bobSubscription = await fixture.subscriptions.createSubscription({ userId: bob, name: 'B' });
    await fixture.subscriptions.createSchedule({ userId: alice, subscriptionId: aliceSubscription.id, rule: hourly });
    await fixture.subscriptions.createSchedule({ userId: bob, subscriptionId: bobSubscription.id, rule: hourly });

    expect((await fixture.subscriptions.listSubscriptions(alice)).map((item) => item.id)).toEqual([aliceSubscription.id]);
    expect(await fixture.subscriptions.listSchedules(alice)).toHaveLength(1);
    expect(await fixture.subscriptions.listSchedules(alice, bobSubscription.id)).toEqual([]);
  });

  it('resets the target state when the target changes, but not for other edits', async () => {
    const fixture = await setup();
    const userId = await fixture.newUser();
    const created = await fixture.subscriptions.createSubscription({ userId, name: 'Old', sourceRef: 'https://a.test/1' });
    await fixture.pool.query("UPDATE subscriptions SET target_state = 'valid' WHERE id = $1", [created.id]);

    const renamed = await fixture.subscriptions.updateSubscription(userId, created.id, { name: 'New' });
    expect(renamed).toMatchObject({ name: 'New', targetState: 'valid', sourceRef: 'https://a.test/1' });

    const retargeted = await fixture.subscriptions.updateSubscription(userId, created.id, { sourceRef: 'https://a.test/2' });
    expect(retargeted).toMatchObject({ targetState: 'unvalidated', sourceRef: 'https://a.test/2', name: 'New' });

    const cleared = await fixture.subscriptions.updateSubscription(userId, created.id, { platformHint: null });
    expect(cleared.platformHint).toBeNull();
  });

  it('refuses to edit or delete a foreign subscription', async () => {
    const fixture = await setup();
    const alice = await fixture.newUser('Alice');
    const bob = await fixture.newUser('Bob');
    const subscription = await fixture.subscriptions.createSubscription({ userId: alice, name: 'A' });

    await expect(fixture.subscriptions.updateSubscription(bob, subscription.id, { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(fixture.subscriptions.deleteSubscription(bob, subscription.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await fixture.subscriptions.getSubscription(alice, subscription.id)).toMatchObject({ name: 'A' });
  });

  it('deletes a subscription with schedules, occurrences and runs, but not while a run is leased', async () => {
    const fixture = await setup('2026-06-01T10:00:00Z');
    const userId = await fixture.newUser();
    const subscription = await fixture.subscriptions.createSubscription({ userId, name: 'A' });
    await fixture.subscriptions.createSchedule({ userId, subscriptionId: subscription.id, rule: hourly });
    fixture.clock.advanceSeconds(3600);
    await fixture.generator.generateDue();
    const lease = await fixture.queue.claim({ workerId: 'w1', leaseSeconds: 600 });
    expect(lease).not.toBeNull();

    await expect(fixture.subscriptions.deleteSubscription(userId, subscription.id)).rejects.toBeInstanceOf(SubscriptionBusyError);

    await fixture.queue.complete(lease!);
    await fixture.subscriptions.deleteSubscription(userId, subscription.id);
    for (const table of ['subscriptions', 'schedules', 'schedule_occurrences', 'job_runs']) {
      const count = await fixture.pool.query(`SELECT count(*)::int AS count FROM ${table}`);
      expect(count.rows[0].count, table).toBe(0);
    }
  });

  it('deletes a schedule and keeps its runs as history without the schedule link', async () => {
    const fixture = await setup('2026-06-01T10:00:00Z');
    const userId = await fixture.newUser();
    const subscription = await fixture.subscriptions.createSubscription({ userId, name: 'A' });
    const schedule = await fixture.subscriptions.createSchedule({ userId, subscriptionId: subscription.id, rule: hourly });
    fixture.clock.advanceSeconds(3600);
    await fixture.generator.generateDue();

    await fixture.subscriptions.deleteSchedule(userId, schedule.id);

    await expect(fixture.subscriptions.getSchedule(userId, schedule.id)).rejects.toBeInstanceOf(NotFoundError);
    const runs = await fixture.queue.listRecentRuns(userId, subscription.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ scheduleId: null, scheduleVersion: null, triggerKind: 'schedule' });
  });

  it('lists recent runs newest first and respects the limit', async () => {
    const fixture = await setup('2026-06-01T10:00:00Z');
    const userId = await fixture.newUser();
    const subscription = await fixture.subscriptions.createSubscription({ userId, name: 'A' });
    await fixture.subscriptions.createSchedule({ userId, subscriptionId: subscription.id, rule: hourly });
    for (let hour = 0; hour < 3; hour += 1) {
      fixture.clock.advanceSeconds(3600);
      await fixture.generator.generateDue();
      await fixture.finishOpenRuns();
    }
    const runs = await fixture.queue.listRecentRuns(userId, subscription.id, 2);
    expect(runs.map((run) => run.scheduledFor.toISOString())).toEqual([
      '2026-06-01T13:00:00.000Z',
      '2026-06-01T12:00:00.000Z'
    ]);
  });
});

describe('runtime policy', () => {
  const fixtures: SchedulerFixture[] = [];
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  });

  it('returns the plan defaults for missing values', () => {
    expect(parseRuntimePolicy({})).toEqual(DEFAULT_RUNTIME_POLICY);
    expect(DEFAULT_RUNTIME_POLICY.workers).toEqual({ downloadSlots: 4, transferSlots: 2, lifecycleReservedSlots: 1 });
    expect(DEFAULT_RUNTIME_POLICY.retention.finishedRunDays).toBe(90);
  });

  it.each([
    [{ downloads: { maxConcurrentGlobal: -1 } }, 'downloads.maxConcurrentGlobal'],
    [{ downloads: { maxConcurrentPerUser: 1.5 } }, 'downloads.maxConcurrentPerUser'],
    [{ downloads: { maxConcurrentGlobal: '3' } }, 'downloads.maxConcurrentGlobal'],
    [{ downloads: { maxConcurrentGlobal: 10_001 } }, 'downloads.maxConcurrentGlobal'],
    [{ downloads: { maxBytesPerDayPerUser: Number.MAX_SAFE_INTEGER + 2 } }, 'downloads.maxBytesPerDayPerUser'],
    [{ downloads: { unknownLimit: 1 } }, 'downloads.unknownLimit'],
    [{ downloads: { perUser: { 'not-a-uuid': { maxConcurrent: 1 } } } }, 'downloads.perUser.not-a-uuid'],
    [{ downloads: { perUser: { [randomUUID()]: { maxConcurrent: -2 } } } }, 'maxConcurrent'],
    [{ downloads: { perAdapter: { 'Bad Adapter': { maxConcurrent: 1 } } } }, 'downloads.perAdapter'],
    [{ workers: { downloadSlots: null } }, 'workers.downloadSlots'],
    [{ workers: { transferSlots: 1001 } }, 'workers.transferSlots'],
    [{ retention: { finishedRunDays: 0 } }, 'retention.finishedRunDays'],
    [{ retention: { finishedRunDays: 4000 } }, 'retention.finishedRunDays'],
    [{ other: {} }, 'other'],
    [[], 'object'],
    ['text', 'object']
  ])('rejects invalid input %j', (input, expectedProblem) => {
    expect(() => parseRuntimePolicy(input)).toThrow(InvalidRuntimePolicyError);
    try {
      parseRuntimePolicy(input);
    } catch (error) {
      expect((error as InvalidRuntimePolicyError).problems.join(' ')).toContain(expectedProblem);
    }
  });

  it('reports all problems at once', () => {
    try {
      parseRuntimePolicy({ downloads: { maxConcurrentGlobal: -1, maxConcurrentPerUser: -1 }, retention: { finishedRunDays: 0 } });
      expect.unreachable();
    } catch (error) {
      expect((error as InvalidRuntimePolicyError).problems).toHaveLength(3);
    }
  });

  it('accepts null and 0 for limits (null = no limit, 0 = paused)', () => {
    const parsed = parseRuntimePolicy({ downloads: { maxConcurrentGlobal: 0, maxConcurrentPerUser: null } });
    expect(parsed.downloads.maxConcurrentGlobal).toBe(0);
    expect(parsed.downloads.maxConcurrentPerUser).toBeNull();
  });

  it('maps to queue limits', () => {
    const userId = randomUUID();
    const policy = parseRuntimePolicy({
      downloads: { maxConcurrentGlobal: 5, maxConcurrentPerUser: 2, perUser: { [userId]: { maxConcurrent: 1 } } }
    });
    expect(toQueueLimits(policy)).toEqual({
      maxConcurrentGlobal: 5,
      maxConcurrentPerUser: 2,
      perUser: { [userId]: { maxConcurrent: 1 } }
    });
  });

  it('versions activations, detects stale writers and rejects unknown users', async () => {
    const fixture = await createSchedulerFixture();
    fixtures.push(fixture);
    const admin = await fixture.newUser('Admin');
    const repository = new RuntimePolicyRepository(fixture.pool);

    expect(await repository.current()).toMatchObject({ version: 0, policy: DEFAULT_RUNTIME_POLICY });

    const first = await repository.activate({ downloads: { maxConcurrentGlobal: 3 } }, 0, admin);
    expect(first.version).toBe(1);
    expect((await repository.current()).policy.downloads.maxConcurrentGlobal).toBe(3);

    await expect(repository.activate({}, 0, admin)).rejects.toBeInstanceOf(PolicyVersionConflictError);
    await expect(
      repository.activate({ downloads: { perUser: { [randomUUID()]: { maxConcurrent: 1 } } } }, 1, admin)
    ).rejects.toBeInstanceOf(InvalidRuntimePolicyError);
    expect((await repository.current()).version).toBe(1);

    const second = await repository.activate({ downloads: { maxConcurrentGlobal: 4 } }, 1, admin);
    expect(second.version).toBe(2);
    const history = await fixture.pool.query('SELECT version FROM runtime_policy_versions ORDER BY version');
    expect(history.rows.map((row) => row.version)).toEqual([1, 2]);
  });

  it('lets exactly one of two concurrent activations of the same version win', async () => {
    const fixture = await createSchedulerFixture();
    fixtures.push(fixture);
    const admin = await fixture.newUser('Admin');
    const repository = new RuntimePolicyRepository(fixture.pool);

    const results = await Promise.allSettled([
      repository.activate({ downloads: { maxConcurrentGlobal: 1 } }, 0, admin),
      repository.activate({ downloads: { maxConcurrentGlobal: 2 } }, 0, admin)
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(PolicyVersionConflictError);
  });

  it('is enforced by the queue: a global limit of 0 starts nothing', async () => {
    const fixture = await createSchedulerFixture('2026-06-01T10:00:00Z');
    fixtures.push(fixture);
    const userId = await fixture.newUser();
    const subscription = await fixture.subscriptions.createSubscription({ userId, name: 'A' });
    await fixture.queue.enqueueManual(userId, subscription.id);

    const paused = toQueueLimits(parseRuntimePolicy({ downloads: { maxConcurrentGlobal: 0 } }));
    expect(await fixture.queue.claim({ workerId: 'w', leaseSeconds: 60, limits: paused })).toBeNull();
    const open = toQueueLimits(parseRuntimePolicy({}));
    expect(await fixture.queue.claim({ workerId: 'w', leaseSeconds: 60, limits: open })).not.toBeNull();
  });
});

describe('retention cleanup', () => {
  const fixtures: SchedulerFixture[] = [];
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  });

  async function counts(fixture: SchedulerFixture) {
    const runs = await fixture.pool.query('SELECT count(*)::int AS count FROM job_runs');
    const occurrences = await fixture.pool.query('SELECT count(*)::int AS count FROM schedule_occurrences');
    return { runs: runs.rows[0].count as number, occurrences: occurrences.rows[0].count as number };
  }

  it('removes finished history older than the cutoff and keeps everything else', async () => {
    const fixture = await createSchedulerFixture('2026-01-01T00:00:00Z');
    fixtures.push(fixture);
    const userId = await fixture.newUser();

    // Old finished run with occurrence (hourly schedule, one pass).
    const oldSubscription = await fixture.subscriptions.createSubscription({ userId, name: 'old' });
    await fixture.subscriptions.createSchedule({ userId, subscriptionId: oldSubscription.id, rule: hourly });
    fixture.clock.advanceSeconds(3600);
    await fixture.generator.generateDue();
    const oldLease = await fixture.queue.claim({ workerId: 'w', leaseSeconds: 600 });
    await fixture.queue.complete(oldLease!);

    // Old run that is still queued (a paused subscription would hold it for months).
    const stuckSubscription = await fixture.subscriptions.createSubscription({ userId, name: 'stuck' });
    await fixture.queue.enqueueManual(userId, stuckSubscription.id);

    expect(await counts(fixture)).toEqual({ runs: 2, occurrences: 1 });

    // 89 days later nothing is old enough.
    fixture.clock.set('2026-03-31T01:00:00Z');
    const cleaner = new RetentionCleaner(fixture.pool, { clock: fixture.clock, batchSize: 1 });
    expect(await cleaner.run(90)).toMatchObject({ occurrencesDeleted: 0, runsDeleted: 0 });

    // 91 days after the finish: the finished run and its occurrence go, the open run stays.
    fixture.clock.set('2026-04-03T00:00:00Z');
    expect(await cleaner.run(90)).toMatchObject({ occurrencesDeleted: 1, runsDeleted: 1 });
    expect(await counts(fixture)).toEqual({ runs: 1, occurrences: 0 });
    const remaining = await fixture.pool.query('SELECT state FROM job_runs');
    expect(remaining.rows[0].state).toBe('queued');
  });

  it('never deletes a recent finished run, and deletes in batches', async () => {
    const fixture = await createSchedulerFixture('2026-01-01T00:00:00Z');
    fixtures.push(fixture);
    const userId = await fixture.newUser();
    for (let index = 0; index < 5; index += 1) {
      const subscription = await fixture.subscriptions.createSubscription({ userId, name: `s${index}` });
      await fixture.queue.enqueueManual(userId, subscription.id);
    }
    await fixture.finishOpenRuns();
    fixture.clock.set('2026-06-01T00:00:00Z');
    const recent = await fixture.subscriptions.createSubscription({ userId, name: 'recent' });
    await fixture.queue.enqueueManual(userId, recent.id);
    await fixture.finishOpenRuns();

    const cleaner = new RetentionCleaner(fixture.pool, { clock: fixture.clock, batchSize: 2 });
    const result = await cleaner.run(90);
    expect(result.runsDeleted).toBe(5);
    expect((await counts(fixture)).runs).toBe(1);
  });

  it('rejects a retention period below one day', async () => {
    const fixture = await createSchedulerFixture();
    fixtures.push(fixture);
    await expect(new RetentionCleaner(fixture.pool).run(0)).rejects.toBeInstanceOf(RangeError);
  });
});
