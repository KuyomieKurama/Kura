import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InvalidScheduleRuleError,
  NotFoundError,
  SubscriptionPausedError,
  type ScheduleRule
} from '../../packages/scheduler/src/index.js';
import { createSchedulerFixture, type SchedulerFixture } from './fixture.js';

const every = (seconds: number, anchorUtc = '2026-06-01T00:00:00Z'): ScheduleRule => ({
  kind: 'interval',
  everySeconds: seconds,
  anchorUtc,
  timeZone: 'UTC'
});

describe('logical occurrence generation', () => {
  const fixtures: SchedulerFixture[] = [];
  const setup = async (start?: string, options?: { maxAttempts?: number }) => {
    const fixture = await createSchedulerFixture(start, options);
    fixtures.push(fixture);
    return fixture;
  };
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  });

  async function subscriptionWithSchedule(fixture: SchedulerFixture, rule: ScheduleRule, jitterMaxSeconds = 0) {
    const userId = await fixture.newUser();
    const subscription = await fixture.subscriptions.createSubscription({ userId, name: 'Creator A', sourceRef: 'creator-a' });
    const schedule = await fixture.subscriptions.createSchedule({ userId, subscriptionId: subscription.id, rule, jitterMaxSeconds });
    return { userId, subscription, schedule };
  }

  it('creates a run and one occurrence when a schedule becomes due, and nothing before', async () => {
    const fixture = await setup('2026-06-01T10:00:00Z');
    const { userId, subscription, schedule } = await subscriptionWithSchedule(fixture, every(600));
    expect(schedule.nextDueAt?.toISOString()).toBe('2026-06-01T10:10:00.000Z');
    expect(schedule.version).toBe(1);

    expect(await fixture.generator.generateDue()).toMatchObject({ schedulesProcessed: 0 });

    fixture.clock.set('2026-06-01T10:10:00Z');
    expect(await fixture.generator.generateDue()).toEqual({ schedulesProcessed: 1, enqueued: 1, coalesced: 0, alreadyRecorded: 0 });

    const runs = await fixture.queue.listRuns(userId, subscription.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      state: 'queued', triggerKind: 'schedule', scheduleVersion: 1, attempts: 0,
      configSnapshot: { scheduleVersion: 1, sourceRef: 'creator-a', rule: { kind: 'interval', everySeconds: 600 } }
    });
    expect(runs[0].scheduledFor.toISOString()).toBe('2026-06-01T10:10:00.000Z');
    expect((await fixture.subscriptions.getSchedule(userId, schedule.id)).nextDueAt?.toISOString()).toBe('2026-06-01T10:20:00.000Z');

    expect(await fixture.generator.generateDue()).toMatchObject({ schedulesProcessed: 0 });
  });

  it('never creates a logical occurrence twice with many concurrent generator instances over several periods', async () => {
    const fixture = await setup('2026-06-01T10:00:00Z');
    const users = await Promise.all([fixture.newUser('A'), fixture.newUser('B'), fixture.newUser('C')]);
    const scheduleCount = 30;
    for (let index = 0; index < scheduleCount; index += 1) {
      const userId = users[index % users.length];
      const subscription = await fixture.subscriptions.createSubscription({ userId, name: `Subscription ${index}` });
      await fixture.subscriptions.createSchedule({ userId, subscriptionId: subscription.id, rule: every(600) });
    }

    const rounds = 5;
    for (let round = 1; round <= rounds; round += 1) {
      fixture.clock.advanceSeconds(600);
      const generators = Array.from({ length: 8 }, () => fixture.newGenerator());
      const results = await Promise.all(generators.map((generator) => generator.generateDue(7)));
      // Keep going until every schedule of this round has been picked up by some instance.
      let processed = results.reduce((sum, result) => sum + result.schedulesProcessed, 0);
      while (processed < scheduleCount) {
        const more = await Promise.all(generators.map((generator) => generator.generateDue(7)));
        processed += more.reduce((sum, result) => sum + result.schedulesProcessed, 0);
        await fixture.finishOpenRuns();
      }
      await fixture.finishOpenRuns();
      expect(processed).toBe(scheduleCount);
    }

    const duplicates = await fixture.pool.query(
      `SELECT subscription_id, scheduled_for, count(*) FROM schedule_occurrences
        GROUP BY subscription_id, scheduled_for HAVING count(*) > 1`
    );
    expect(duplicates.rows).toEqual([]);
    const total = await fixture.pool.query<{ count: string }>('SELECT count(*) FROM schedule_occurrences');
    expect(Number(total.rows[0].count)).toBe(scheduleCount * rounds);
    const runTotal = await fixture.pool.query<{ count: string }>('SELECT count(*) FROM job_runs');
    expect(Number(runTotal.rows[0].count)).toBe(scheduleCount * rounds);
  });

  it('a second instance skips schedules that another instance holds locked instead of waiting or duplicating', async () => {
    const fixture = await setup('2026-06-01T10:00:00Z');
    const { userId, subscription } = await subscriptionWithSchedule(fixture, every(600));
    fixture.clock.set('2026-06-01T10:10:00Z');

    const otherInstance = await fixture.pool.connect();
    try {
      await otherInstance.query('BEGIN');
      await otherInstance.query('SELECT id FROM schedules WHERE next_due_at IS NOT NULL FOR UPDATE');
      // Returns at once with nothing to do although a schedule is due.
      expect(await fixture.generator.generateDue()).toMatchObject({ schedulesProcessed: 0 });
      await otherInstance.query('ROLLBACK');
    } finally {
      otherInstance.release();
    }

    expect(await fixture.generator.generateDue()).toMatchObject({ schedulesProcessed: 1, enqueued: 1 });
    expect(await fixture.queue.listRuns(userId, subscription.id)).toHaveLength(1);
  });

  it('a restarted scheduler continues without repeating occurrences', async () => {
    const fixture = await setup('2026-06-01T10:00:00Z');
    const { userId, subscription } = await subscriptionWithSchedule(fixture, every(600));
    fixture.clock.set('2026-06-01T10:10:00Z');
    await fixture.generator.generateDue();
    await fixture.finishOpenRuns();

    const restarted = fixture.newGenerator();
    expect(await restarted.generateDue()).toMatchObject({ schedulesProcessed: 0 });
    fixture.clock.set('2026-06-01T10:20:00Z');
    expect(await restarted.generateDue()).toMatchObject({ enqueued: 1 });
    expect(await fixture.queue.listRuns(userId, subscription.id)).toHaveLength(2);
  });

  it('a crash in the middle of a pass leaves nothing behind and the next pass creates exactly one occurrence', async () => {
    const fixture = await setup('2026-06-01T10:00:00Z');
    const { userId, subscription, schedule } = await subscriptionWithSchedule(fixture, every(600), 30);
    fixture.clock.set('2026-06-01T10:10:00Z');

    const crashing = fixture.newGenerator({
      randomJitterSeconds: () => {
        throw new Error('simulated crash after the occurrence row was inserted');
      }
    });
    await expect(crashing.generateDue()).rejects.toThrow('simulated crash');

    const occurrences = await fixture.pool.query('SELECT 1 FROM schedule_occurrences');
    expect(occurrences.rowCount).toBe(0);
    expect((await fixture.subscriptions.getSchedule(userId, schedule.id)).generatedThrough.toISOString()).toBe('2026-06-01T10:00:00.000Z');

    expect(await fixture.generator.generateDue()).toMatchObject({ enqueued: 1 });
    expect(await fixture.queue.listRuns(userId, subscription.id)).toHaveLength(1);
  });

  it('the database itself rejects or ignores a second insert of the same logical occurrence', async () => {
    const fixture = await setup('2026-06-01T10:00:00Z');
    const { userId, subscription, schedule } = await subscriptionWithSchedule(fixture, every(600));
    const insert = (version: number, scheduledFor: string, localPlanTime: string | null, suffix: string) =>
      fixture.pool.query(
        `INSERT INTO schedule_occurrences (id, user_id, subscription_id, schedule_id, schedule_version,
                                           scheduled_for, local_plan_time, outcome)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'coalesced') ${suffix}`,
        [randomUUID(), userId, subscription.id, schedule.id, version, scheduledFor, localPlanTime]
      );

    // Ten writers race for the same instant: exactly one row survives, nobody fails.
    const racers = await Promise.all(
      Array.from({ length: 10 }, () => insert(1, '2026-06-01T11:00:00Z', null, 'ON CONFLICT DO NOTHING'))
    );
    expect(racers.reduce((sum, result) => sum + (result.rowCount ?? 0), 0)).toBe(1);

    // Without ON CONFLICT the constraint raises unique_violation, also for another schedule version.
    await expect(insert(1, '2026-06-01T11:00:00Z', null, '')).rejects.toMatchObject({ code: '23505' });
    await expect(insert(2, '2026-06-01T11:00:00Z', null, '')).rejects.toMatchObject({ code: '23505' });

    // Autumn overlap: same wall-clock plan time of one rule generation at a different instant.
    await insert(1, '2026-10-25T00:30:00Z', '2026-10-25T02:30', '');
    await expect(insert(1, '2026-10-25T01:30:00Z', '2026-10-25T02:30', '')).rejects.toMatchObject({ code: '23505' });
    await insert(2, '2026-10-25T01:30:00Z', '2026-10-25T02:30', ''); // a new rule generation may run it
  });

  it('catch_up_once: after downtime only the latest due occurrence runs and the rest is counted', async () => {
    const fixture = await setup('2026-06-01T10:00:00Z');
    const { userId, subscription, schedule } = await subscriptionWithSchedule(fixture, every(60));
    fixture.clock.set('2026-06-01T12:00:30Z'); // server was off for two hours

    expect(await fixture.generator.generateDue()).toMatchObject({ enqueued: 1 });
    const runs = await fixture.queue.listRuns(userId, subscription.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].scheduledFor.toISOString()).toBe('2026-06-01T12:00:00.000Z');
    const occurrence = await fixture.pool.query('SELECT missed_count FROM schedule_occurrences');
    expect(occurrence.rows).toEqual([{ missed_count: 119 }]);

    const after = await fixture.subscriptions.getSchedule(userId, schedule.id);
    expect(after.nextDueAt?.toISOString()).toBe('2026-06-01T12:01:00.000Z');
    expect(await fixture.generator.generateDue()).toMatchObject({ schedulesProcessed: 0 });
  });

  it('coalesces an occurrence into the open run instead of starting a parallel scan', async () => {
    const fixture = await setup('2026-06-01T10:00:00Z');
    const { userId, subscription } = await subscriptionWithSchedule(fixture, every(600));
    fixture.clock.set('2026-06-01T10:10:00Z');
    await fixture.generator.generateDue();

    fixture.clock.set('2026-06-01T10:20:00Z'); // first run is still queued/open
    expect(await fixture.generator.generateDue()).toEqual({ schedulesProcessed: 1, enqueued: 0, coalesced: 1, alreadyRecorded: 0 });

    const runs = await fixture.queue.listRuns(userId, subscription.id);
    expect(runs).toHaveLength(1);
    const occurrences = await fixture.pool.query('SELECT outcome, job_run_id FROM schedule_occurrences ORDER BY scheduled_for');
    expect(occurrences.rows).toEqual([
      { outcome: 'enqueued', job_run_id: runs[0].id },
      { outcome: 'coalesced', job_run_id: runs[0].id }
    ]);
  });

  it('draws the start jitter once; scheduled_for keeps the original due time', async () => {
    const fixture = await setup('2026-06-01T10:00:00Z');
    const { userId, subscription } = await subscriptionWithSchedule(fixture, every(600), 120);
    fixture.clock.set('2026-06-01T10:10:00Z');
    const seen: number[] = [];
    const generator = fixture.newGenerator({ randomJitterSeconds: (max) => { seen.push(max); return 45; } });
    await generator.generateDue();

    const [run] = await fixture.queue.listRuns(userId, subscription.id);
    expect(seen).toEqual([120]);
    expect(run.jitterSeconds).toBe(45);
    expect(run.scheduledFor.toISOString()).toBe('2026-06-01T10:10:00.000Z');
    expect(run.runAfter.toISOString()).toBe('2026-06-01T10:10:45.000Z');
  });

  it('follows the wall clock across the autumn overlap: one run for the doubled 02:30', async () => {
    const fixture = await setup('2026-10-24T12:00:00Z');
    const { userId, subscription } = await subscriptionWithSchedule(fixture, { kind: 'cron', expression: '30 2 * * *', timeZone: 'Europe/Berlin' });
    for (const instant of ['2026-10-25T00:29:00Z', '2026-10-25T00:31:00Z', '2026-10-25T01:31:00Z', '2026-10-25T23:00:00Z', '2026-10-26T01:31:00Z']) {
      fixture.clock.set(instant);
      await fixture.generator.generateDue();
      await fixture.finishOpenRuns();
    }
    const runs = await fixture.queue.listRuns(userId, subscription.id);
    expect(runs.map((run) => run.scheduledFor.toISOString())).toEqual(['2026-10-25T00:30:00.000Z', '2026-10-26T01:30:00.000Z']);
    const plans = await fixture.pool.query('SELECT local_plan_time FROM schedule_occurrences ORDER BY scheduled_for');
    expect(plans.rows.map((row) => row.local_plan_time)).toEqual(['2026-10-25T02:30', '2026-10-26T02:30']);
  });

  it.each([
    ['skip', ['2026-03-28T01:30:00.000Z', '2026-03-30T00:30:00.000Z']],
    ['run_after_gap', ['2026-03-28T01:30:00.000Z', '2026-03-29T01:00:00.000Z', '2026-03-30T00:30:00.000Z']]
  ] as const)('follows the wall clock across the spring gap with gapPolicy %s', async (gapPolicy, expectedRuns) => {
    const fixture = await setup('2026-03-27T12:00:00Z');
    const { userId, subscription } = await subscriptionWithSchedule(fixture, { kind: 'cron', expression: '30 2 * * *', timeZone: 'Europe/Berlin', gapPolicy });
    for (const instant of ['2026-03-28T01:31:00Z', '2026-03-29T01:00:30Z', '2026-03-29T12:00:00Z', '2026-03-30T00:31:00Z']) {
      fixture.clock.set(instant);
      await fixture.generator.generateDue();
      await fixture.finishOpenRuns();
    }
    const runs = await fixture.queue.listRuns(userId, subscription.id);
    expect(runs.map((run) => run.scheduledFor.toISOString())).toEqual(expectedRuns);
  });

  it('keeps the occurrence history when a schedule is edited: the new version continues after the cursor', async () => {
    const fixture = await setup('2026-06-01T10:00:00Z');
    const { userId, subscription, schedule } = await subscriptionWithSchedule(fixture, every(600));
    fixture.clock.set('2026-06-01T10:10:00Z');
    await fixture.generator.generateDue();

    const edited = await fixture.subscriptions.updateSchedule(userId, schedule.id, { rule: every(300, '2026-06-01T10:00:00Z') });
    expect(edited.version).toBe(2);
    expect(edited.nextDueAt?.toISOString()).toBe('2026-06-01T10:15:00.000Z');

    await fixture.finishOpenRuns();
    expect(await fixture.generator.generateDue()).toMatchObject({ schedulesProcessed: 0 }); // 10:10 is not generated again
    fixture.clock.set('2026-06-01T10:15:00Z');
    await fixture.generator.generateDue();

    const runs = await fixture.queue.listRuns(userId, subscription.id);
    expect(runs.map((run) => [run.scheduledFor.toISOString(), run.scheduleVersion, run.configSnapshot.scheduleVersion])).toEqual([
      ['2026-06-01T10:10:00.000Z', 1, 1], // the started run keeps its snapshot of version 1
      ['2026-06-01T10:15:00.000Z', 2, 2]
    ]);
  });

  it('pause stops new runs, resume does not catch up the pause, manual runs are refused while paused', async () => {
    const fixture = await setup('2026-06-01T10:00:00Z');
    const { userId, subscription } = await subscriptionWithSchedule(fixture, every(600));
    await fixture.subscriptions.pauseSubscription(userId, subscription.id);
    expect((await fixture.subscriptions.getSubscription(userId, subscription.id)).status).toBe('paused');

    fixture.clock.set('2026-06-01T12:00:00Z');
    expect(await fixture.generator.generateDue()).toMatchObject({ schedulesProcessed: 0 });
    await expect(fixture.queue.enqueueManual(userId, subscription.id)).rejects.toBeInstanceOf(SubscriptionPausedError);
    expect(await fixture.queue.listRuns(userId, subscription.id)).toHaveLength(0);

    await fixture.subscriptions.resumeSubscription(userId, subscription.id);
    expect(await fixture.generator.generateDue()).toMatchObject({ schedulesProcessed: 0 }); // two hours of pause are not caught up
    fixture.clock.set('2026-06-01T12:10:00Z');
    expect(await fixture.generator.generateDue()).toMatchObject({ enqueued: 1 });
    const runs = await fixture.queue.listRuns(userId, subscription.id);
    expect(runs.map((run) => run.scheduledFor.toISOString())).toEqual(['2026-06-01T12:10:00.000Z']);
  });

  it('resuming an active subscription is a no-op that does not skip due occurrences', async () => {
    const fixture = await setup('2026-06-01T10:00:00Z');
    const { userId, subscription } = await subscriptionWithSchedule(fixture, every(600));
    fixture.clock.set('2026-06-01T10:10:00Z');
    await fixture.subscriptions.resumeSubscription(userId, subscription.id);
    expect(await fixture.generator.generateDue()).toMatchObject({ enqueued: 1 });
  });

  it('"run now" creates one manual run and coalesces repeated requests', async () => {
    const fixture = await setup('2026-06-01T10:00:00Z');
    const userId = await fixture.newUser();
    const subscription = await fixture.subscriptions.createSubscription({ userId, name: 'Manual only', sourceRef: 'x' });
    const first = await fixture.queue.enqueueManual(userId, subscription.id);
    const second = await fixture.queue.enqueueManual(userId, subscription.id);
    expect(first).toMatchObject({ coalesced: false, run: { triggerKind: 'manual', state: 'queued', scheduleId: null } });
    expect(second.coalesced).toBe(true);
    expect(second.run.id).toBe(first.run.id);
  });

  it('rejects rules that never fire and unknown or foreign subscriptions', async () => {
    const fixture = await setup('2026-06-01T10:00:00Z');
    const { userId, subscription } = await subscriptionWithSchedule(fixture, every(600));
    await expect(fixture.subscriptions.createSchedule({
      userId, subscriptionId: subscription.id, rule: { kind: 'once', atUtc: '2026-05-01T00:00:00Z', timeZone: 'UTC' }
    })).rejects.toBeInstanceOf(InvalidScheduleRuleError);
    await expect(fixture.subscriptions.createSchedule({
      userId, subscriptionId: subscription.id, rule: { kind: 'cron', expression: '0 0 31 2 *', timeZone: 'UTC' }
    })).rejects.toBeInstanceOf(InvalidScheduleRuleError);
    await expect(fixture.subscriptions.getSubscription(userId, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });
});
