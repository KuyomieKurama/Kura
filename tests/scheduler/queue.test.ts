import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { LeaseLostError, NotFoundError, retryDelaySeconds, type JobLease } from '../../packages/scheduler/src/index.js';
import { createSchedulerFixture, type SchedulerFixture } from './fixture.js';

describe('queue with leases', () => {
  const fixtures: SchedulerFixture[] = [];
  const setup = async (options?: { maxAttempts?: number; retry?: { jitterRatio: number }; random?: () => number }) => {
    const fixture = await createSchedulerFixture('2026-06-01T10:00:00Z', options);
    fixtures.push(fixture);
    return fixture;
  };
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  });

  /** One subscription with one queued manual run. */
  async function queuedRun(fixture: SchedulerFixture, userId?: string) {
    const owner = userId ?? (await fixture.newUser());
    const subscription = await fixture.subscriptions.createSubscription({ userId: owner, name: 'Sub', sourceRef: 'ref' });
    const { run } = await fixture.queue.enqueueManual(owner, subscription.id);
    return { userId: owner, subscription, run };
  }

  const claim = (fixture: SchedulerFixture, workerId = 'worker-1', leaseSeconds = 60, limits = {}) =>
    fixture.queue.claim({ workerId, leaseSeconds, limits });

  it('claims a run, marks it leased and completes it; nothing else is claimable afterwards', async () => {
    const fixture = await setup();
    const { userId, run } = await queuedRun(fixture);

    const lease = await claim(fixture);
    expect(lease).toMatchObject({ runId: run.id, userId, leaseOwner: 'worker-1', leaseGeneration: 1, configSnapshot: { sourceRef: 'ref' } });
    expect(lease?.leaseExpiresAt.toISOString()).toBe('2026-06-01T10:01:00.000Z');
    expect(await claim(fixture, 'worker-2')).toBeNull();
    expect(await fixture.queue.getRun(userId, run.id)).toMatchObject({ state: 'leased', attempts: 1, leaseOwner: 'worker-1' });

    await fixture.queue.complete(lease as JobLease);
    const done = await fixture.queue.getRun(userId, run.id);
    expect(done).toMatchObject({ state: 'succeeded', leaseOwner: null, leaseExpiresAt: null });
    expect(done.finishedAt?.toISOString()).toBe('2026-06-01T10:00:00.000Z');
    await expect(fixture.queue.complete(lease as JobLease)).rejects.toBeInstanceOf(LeaseLostError);
  });

  it('does not claim a run before run_after (start jitter or retry delay)', async () => {
    const fixture = await setup();
    const userId = await fixture.newUser();
    const subscription = await fixture.subscriptions.createSubscription({ userId, name: 'Jittered' });
    await fixture.subscriptions.createSchedule({
      userId, subscriptionId: subscription.id, jitterMaxSeconds: 100,
      rule: { kind: 'interval', everySeconds: 600, anchorUtc: '2026-06-01T00:00:00Z', timeZone: 'UTC' }
    });
    fixture.clock.set('2026-06-01T10:10:00Z');
    await fixture.newGenerator({ randomJitterSeconds: () => 40 }).generateDue();

    expect(await claim(fixture)).toBeNull();
    fixture.clock.set('2026-06-01T10:10:39Z');
    expect(await claim(fixture)).toBeNull();
    fixture.clock.set('2026-06-01T10:10:40Z');
    expect(await claim(fixture)).not.toBeNull();
  });

  it('heartbeat extends a valid lease and keeps the worker from being reclaimed', async () => {
    const fixture = await setup();
    await queuedRun(fixture);
    const lease = (await claim(fixture)) as JobLease;

    fixture.clock.advanceSeconds(50);
    const extendedTo = await fixture.queue.heartbeat(lease, 60);
    expect(extendedTo.toISOString()).toBe('2026-06-01T10:01:50.000Z');

    fixture.clock.advanceSeconds(55); // past the original expiry (10:01:00), before the extended one
    expect(await claim(fixture, 'worker-2')).toBeNull();
    await fixture.queue.complete(lease);
  });

  it('crash recovery: after lease expiry another worker takes over and the old one cannot commit', async () => {
    const fixture = await setup();
    const { userId, run } = await queuedRun(fixture);
    const stale = (await claim(fixture, 'worker-1')) as JobLease;

    fixture.clock.advanceSeconds(61); // worker-1 died without a heartbeat
    await expect(fixture.queue.heartbeat(stale, 60)).rejects.toBeInstanceOf(LeaseLostError);

    const takeover = (await claim(fixture, 'worker-2')) as JobLease;
    expect(takeover).toMatchObject({ runId: run.id, leaseOwner: 'worker-2', leaseGeneration: 2 });

    // The old worker wakes up: completing, failing or extending is refused (plan 08, T18).
    await expect(fixture.queue.complete(stale)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(fixture.queue.fail(stale, { error: 'late' })).rejects.toBeInstanceOf(LeaseLostError);
    await expect(fixture.queue.heartbeat(stale, 60)).rejects.toBeInstanceOf(LeaseLostError);
    // Same worker name, old generation: still refused.
    await expect(fixture.queue.complete({ ...takeover, leaseGeneration: 1 })).rejects.toBeInstanceOf(LeaseLostError);

    await fixture.queue.complete(takeover);
    expect(await fixture.queue.getRun(userId, run.id)).toMatchObject({ state: 'succeeded', attempts: 2 });
  });

  it('a lease that expired but was not reclaimed yet cannot be used either', async () => {
    const fixture = await setup();
    await queuedRun(fixture);
    const lease = (await claim(fixture)) as JobLease;
    fixture.clock.advanceSeconds(60); // exactly at expiry
    await expect(fixture.queue.complete(lease)).rejects.toBeInstanceOf(LeaseLostError);
  });

  it('reclaimExpiredLeases reports requeued and failed runs; repeated crashes end in failed after max attempts', async () => {
    const fixture = await setup({ maxAttempts: 2 });
    const { userId, run } = await queuedRun(fixture);

    await claim(fixture, 'worker-1');
    fixture.clock.advanceSeconds(61);
    expect(await fixture.queue.reclaimExpiredLeases()).toEqual({ requeued: 1, failed: 0 });
    expect(await fixture.queue.getRun(userId, run.id)).toMatchObject({ state: 'retry_wait', attempts: 1 });

    await claim(fixture, 'worker-2');
    fixture.clock.advanceSeconds(61);
    expect(await claim(fixture, 'worker-3')).toBeNull(); // attempts used up: the claim reclaims it as failed
    const failed = await fixture.queue.getRun(userId, run.id);
    expect(failed).toMatchObject({ state: 'failed', attempts: 2 });
    expect(failed.lastError).toContain('Lease expired');
    expect(failed.finishedAt).not.toBeNull();
  });

  it('many workers claiming concurrently never get the same run', async () => {
    const fixture = await setup();
    const userId = await fixture.newUser();
    const runIds = new Set<string>();
    for (let index = 0; index < 20; index += 1) runIds.add((await queuedRun(fixture, userId)).run.id);

    const claims = await Promise.all(Array.from({ length: 30 }, (_, index) => claim(fixture, `worker-${index}`)));
    const leased = claims.filter((lease): lease is JobLease => lease !== null);
    expect(leased).toHaveLength(20);
    expect(new Set(leased.map((lease) => lease.runId))).toEqual(runIds);
  });

  describe('retry with capped exponential backoff', () => {
    it('follows 30 s, 2 min, 8 min, 30 min (cap), 30 min and then fails after max attempts', async () => {
      const fixture = await setup({ maxAttempts: 6, retry: { jitterRatio: 0 } });
      const { userId, run } = await queuedRun(fixture);

      const delays: number[] = [];
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const lease = (await claim(fixture)) as JobLease;
        expect(lease.leaseGeneration).toBe(attempt);
        const failure = await fixture.queue.fail(lease, { error: `network error ${attempt}` });
        expect(failure.state).toBe('retry_wait');
        const waitSeconds = ((failure.runAfter as Date).getTime() - fixture.clock.now().getTime()) / 1000;
        delays.push(waitSeconds);

        fixture.clock.advanceSeconds(waitSeconds - 1);
        expect(await claim(fixture)).toBeNull(); // not before run_after
        fixture.clock.advanceSeconds(1);
      }
      expect(delays).toEqual([30, 120, 480, 1800, 1800]);

      const last = (await claim(fixture)) as JobLease;
      expect(await fixture.queue.fail(last, { error: 'still down' })).toEqual({ state: 'failed', runAfter: null });
      const final = await fixture.queue.getRun(userId, run.id);
      expect(final).toMatchObject({ state: 'failed', attempts: 6, lastError: 'still down' });
      expect(final.scheduledFor).toEqual(run.scheduledFor); // retries never move the logical due time
      expect(await claim(fixture)).toBeNull();
    });

    it('a permanent failure is not retried, and the error text is bounded', async () => {
      const fixture = await setup();
      const { userId, run } = await queuedRun(fixture);
      const lease = (await claim(fixture)) as JobLease;
      expect(await fixture.queue.fail(lease, { error: 'x'.repeat(5000), retryable: false })).toEqual({ state: 'failed', runAfter: null });
      const failed = await fixture.queue.getRun(userId, run.id);
      expect(failed.state).toBe('failed');
      expect(failed.lastError).toHaveLength(2000);
    });

    it('honours Retry-After when it is longer than the backoff, with an upper bound', async () => {
      const fixture = await setup({ retry: { jitterRatio: 0 } });
      await queuedRun(fixture);
      const lease = (await claim(fixture)) as JobLease;
      const failure = await fixture.queue.fail(lease, { error: '429', retryAfterSeconds: 900 });
      expect(((failure.runAfter as Date).getTime() - fixture.clock.now().getTime()) / 1000).toBe(900);
    });

    it('retryDelaySeconds: exponential, capped, jitter within the ratio, Retry-After clamped', () => {
      const policy = { baseDelaySeconds: 30, multiplier: 4, capSeconds: 1800, jitterRatio: 0.1, maxRetryAfterSeconds: 86_400 };
      const noJitter = () => 0;
      expect([1, 2, 3, 4, 5, 9].map((attempt) => retryDelaySeconds(attempt, policy, noJitter))).toEqual([30, 120, 480, 1800, 1800, 1800]);
      expect(retryDelaySeconds(2, policy, () => 0.999)).toBeCloseTo(120 * 1.0999, 5);
      expect(retryDelaySeconds(1, policy, noJitter, 100_000)).toBe(86_400);
      expect(retryDelaySeconds(1, policy, noJitter, -5)).toBe(30);
    });
  });

  describe('pause and resume', () => {
    it('a paused subscription is not claimed; a running job is untouched; resume makes the queued run claimable', async () => {
      const fixture = await setup();
      const running = await queuedRun(fixture);
      const lease = (await claim(fixture)) as JobLease;
      const waiting = await queuedRun(fixture, running.userId);

      await fixture.subscriptions.pauseSubscription(running.userId, waiting.subscription.id);
      await fixture.subscriptions.pauseSubscription(running.userId, running.subscription.id);
      expect(await claim(fixture, 'worker-2')).toBeNull();

      await fixture.queue.complete(lease); // the job that was already running finishes normally
      expect((await fixture.queue.getRun(running.userId, running.run.id)).state).toBe('succeeded');
      expect(await claim(fixture, 'worker-2')).toBeNull();

      await fixture.subscriptions.resumeSubscription(running.userId, waiting.subscription.id);
      expect(await claim(fixture, 'worker-2')).toMatchObject({ runId: waiting.run.id });
    });

    it('requests for a subscription with an open run are coalesced, also while it is leased', async () => {
      const fixture = await setup();
      const { userId, subscription, run } = await queuedRun(fixture);
      await claim(fixture);
      const again = await fixture.queue.enqueueManual(userId, subscription.id);
      expect(again).toMatchObject({ coalesced: true, run: { id: run.id, state: 'leased' } });
    });
  });

  describe('fairness and limits (plan 04, section 10)', () => {
    async function threeUsers(fixture: SchedulerFixture) {
      const users = { a: await fixture.newUser('A'), b: await fixture.newUser('B'), c: await fixture.newUser('C') };
      // A is queued first and has twice the work: FIFO would serve A six times in a row.
      for (let index = 0; index < 6; index += 1) await queuedRun(fixture, users.a);
      fixture.clock.advanceSeconds(10);
      for (let index = 0; index < 3; index += 1) await queuedRun(fixture, users.b);
      fixture.clock.advanceSeconds(10);
      for (let index = 0; index < 3; index += 1) await queuedRun(fixture, users.c);
      fixture.clock.advanceSeconds(10);
      return users;
    }

    it('serves waiting users round-robin: a user with many subscriptions does not starve the others', async () => {
      const fixture = await setup();
      const users = await threeUsers(fixture);
      const order: string[] = [];
      for (let index = 0; index < 12; index += 1) {
        const lease = await claim(fixture, `worker-${index}`);
        order.push(lease?.userId ?? 'none');
      }
      const name = (id: string) => Object.entries(users).find(([, userId]) => userId === id)?.[0] ?? id;

      for (const round of [order.slice(0, 3), order.slice(3, 6), order.slice(6, 9)]) {
        expect(new Set(round).size, `each round serves all three users: ${order.map(name).join('')}`).toBe(3);
      }
      expect(order.slice(0, 9).filter((id) => id === users.a)).toHaveLength(3);
      expect(order.slice(9).map(name)).toEqual(['a', 'a', 'a']); // B and C are exhausted, A gets the rest
    });

    it('prefers the user with fewer running jobs when slots free up', async () => {
      const fixture = await setup();
      const users = await threeUsers(fixture);
      const leases: JobLease[] = [];
      for (let index = 0; index < 4; index += 1) leases.push((await claim(fixture)) as JobLease);
      // 4 running: one user has two. Finish the jobs of the other users, leave the double user running.
      const counts = new Map<string, number>();
      for (const lease of leases) counts.set(lease.userId, (counts.get(lease.userId) ?? 0) + 1);
      const doubleUser = [...counts.entries()].find(([, count]) => count === 2)?.[0] as string;
      for (const lease of leases.filter((candidate) => candidate.userId !== doubleUser)) await fixture.queue.complete(lease);

      const next = (await claim(fixture)) as JobLease;
      expect(next.userId).not.toBe(doubleUser);
      expect(Object.values(users)).toContain(next.userId);
    });

    it('per-user cap: a user never runs more jobs than allowed, an explicit user entry replaces the default', async () => {
      const fixture = await setup();
      const users = await threeUsers(fixture);
      const limits = { maxConcurrentPerUser: 1, perUser: { [users.a]: { maxConcurrent: 2 }, [users.c]: { maxConcurrent: null } } };

      const leases: JobLease[] = [];
      for (let index = 0; index < 10; index += 1) {
        const lease = await claim(fixture, `w${index}`, 60, limits);
        if (lease) leases.push(lease);
      }
      const running = (userId: string) => leases.filter((lease) => lease.userId === userId).length;
      expect(running(users.a)).toBe(2); // explicit 2
      expect(running(users.b)).toBe(1); // default 1
      expect(running(users.c)).toBe(3); // null = no user-level limit; C only has 3 runs
      expect(leases).toHaveLength(6);

      await fixture.queue.complete(leases.find((lease) => lease.userId === users.b) as JobLease);
      expect((await claim(fixture, 'w-next', 60, limits))?.userId).toBe(users.b);
    });

    it('a user limit of 0 pauses that user only', async () => {
      const fixture = await setup();
      const users = await threeUsers(fixture);
      const limits = { perUser: { [users.a]: { maxConcurrent: 0 } } };
      const claimedUsers = new Set<string>();
      for (let index = 0; index < 8; index += 1) {
        const lease = await claim(fixture, `w${index}`, 60, limits);
        if (lease) claimedUsers.add(lease.userId);
      }
      expect(claimedUsers).toEqual(new Set([users.b, users.c]));
    });

    it('global cap: the smaller of global and user limits wins; lowering it never touches running jobs', async () => {
      const fixture = await setup();
      const users = await threeUsers(fixture);

      const first = [] as JobLease[];
      for (let index = 0; index < 3; index += 1) first.push((await claim(fixture, `w${index}`, 60, { maxConcurrentGlobal: 3, maxConcurrentPerUser: 2 })) as JobLease);
      expect(await claim(fixture, 'w-over', 60, { maxConcurrentGlobal: 3, maxConcurrentPerUser: 2 })).toBeNull();

      // Operator lowers the global cap to 1 while 3 jobs run: nothing is interrupted, nothing new starts.
      const lowered = { maxConcurrentGlobal: 1 };
      expect(await claim(fixture, 'w-low', 60, lowered)).toBeNull();
      await fixture.queue.heartbeat(first[0], 60); // still held
      await fixture.queue.complete(first[0]);
      await fixture.queue.complete(first[1]);
      expect(await claim(fixture, 'w-low', 60, lowered)).toBeNull(); // 1 still running, cap 1
      await fixture.queue.complete(first[2]);
      expect(await claim(fixture, 'w-low', 60, lowered)).not.toBeNull();

      expect(await claim(fixture, 'w-zero', 60, { maxConcurrentGlobal: 0 })).toBeNull();
      expect(Object.keys(users)).toHaveLength(3);
    });

    it('rejects invalid limits', async () => {
      const fixture = await setup();
      await expect(claim(fixture, 'w', 60, { maxConcurrentGlobal: -1 })).rejects.toBeInstanceOf(RangeError);
      await expect(claim(fixture, 'w', 60, { maxConcurrentPerUser: 1.5 })).rejects.toBeInstanceOf(RangeError);
    });
  });

  describe('ownership (OWN-01)', () => {
    it('never reveals or modifies runs, subscriptions and schedules of another user', async () => {
      const fixture = await setup();
      const owner = await queuedRun(fixture);
      const intruder = await fixture.newUser('Intruder');

      await expect(fixture.queue.getRun(intruder, owner.run.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(fixture.queue.enqueueManual(intruder, owner.subscription.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(fixture.subscriptions.getSubscription(intruder, owner.subscription.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(fixture.subscriptions.pauseSubscription(intruder, owner.subscription.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(fixture.subscriptions.createSchedule({
        userId: intruder, subscriptionId: owner.subscription.id,
        rule: { kind: 'interval', everySeconds: 60, anchorUtc: '2026-06-01T00:00:00Z', timeZone: 'UTC' }
      })).rejects.toBeInstanceOf(NotFoundError);
      expect((await fixture.subscriptions.getSubscription(owner.userId, owner.subscription.id)).status).toBe('active');

      const lease = (await claim(fixture)) as JobLease;
      await expect(fixture.queue.complete({ ...lease, userId: intruder })).rejects.toBeInstanceOf(LeaseLostError);
      await fixture.queue.complete(lease);
    });

    it('every scheduler table carries a non-null owner and references its parents with composite (id, user_id) keys', async () => {
      const fixture = await setup();
      const tables = ['subscriptions', 'schedules', 'job_runs', 'schedule_occurrences', 'scheduler_user_state'];
      const columns = await fixture.pool.query<{ table_name: string; is_nullable: string }>(
        `SELECT table_name, is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'user_id' AND table_name = ANY($1)`,
        [tables]
      );
      expect(columns.rows.map((row) => row.table_name).sort()).toEqual([...tables].sort());
      expect(columns.rows.every((row) => row.is_nullable === 'NO')).toBe(true);

      // Foreign keys between scheduler tables must include user_id (as the second column of a two-column key).
      const keys = await fixture.pool.query<{ child: string; parent: string; columns: string[] }>(
        `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
                (SELECT array_agg(a.attname::text ORDER BY k.ordinality) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ordinality)
                   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns
           FROM pg_constraint c
          WHERE c.contype = 'f' AND c.conrelid::regclass::text = ANY($1)
            AND c.confrelid::regclass::text IN ('subscriptions', 'schedules', 'job_runs')`,
        [tables]
      );
      expect(keys.rows.length).toBe(6);
      for (const key of keys.rows) expect(key.columns[1], `${key.child} -> ${key.parent}`).toBe('user_id');
    });

    it('the database refuses rows that point at another user\'s parent', async () => {
      const fixture = await setup();
      const owner = await queuedRun(fixture);
      const intruder = await fixture.newUser('Intruder');
      // A subscription without an open run, so that only the ownership constraint can fire.
      const idle = await fixture.subscriptions.createSubscription({ userId: owner.userId, name: 'Idle' });

      await expect(fixture.pool.query(
        `INSERT INTO schedules (id, user_id, subscription_id, rule, rule_kind, time_zone, generated_through)
         VALUES ($1, $2, $3, '{}', 'once', 'UTC', now())`,
        [randomUUID(), intruder, idle.id]
      )).rejects.toMatchObject({ code: '23503' });

      await expect(fixture.pool.query(
        `INSERT INTO job_runs (id, user_id, subscription_id, trigger_kind, scheduled_for, run_after, max_attempts, config_snapshot)
         VALUES ($1, $2, $3, 'manual', now(), now(), 3, '{}')`,
        [randomUUID(), intruder, idle.id]
      )).rejects.toMatchObject({ code: '23503' });
    });
  });
});
