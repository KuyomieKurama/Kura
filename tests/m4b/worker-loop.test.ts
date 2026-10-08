import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { loadWorkerConfig } from '../../apps/worker/src/config.js';
import { SchedulerLoop, type Logger, type Wait } from '../../apps/worker/src/scheduler-loop.js';
import { Worker } from '../../apps/worker/src/worker.js';
import { RuntimePolicyRepository, type ScheduleRule } from '../../packages/scheduler/src/index.js';
import { createSchedulerFixture, type SchedulerFixture } from '../scheduler/fixture.js';
import { runMigrations } from '../../packages/storage/src/migrator.js';
import { createMigrationsCopy, createTestDatabase } from '../helpers/database.js';

const every = (seconds: number, anchorUtc = '2026-01-01T00:00:00Z'): ScheduleRule => ({
  kind: 'interval', everySeconds: seconds, anchorUtc, timeZone: 'UTC'
});

interface RecordingLogger extends Logger {
  entries: Array<{ level: string; message: string; fields?: Record<string, unknown> }>;
}

function recordingLogger(): RecordingLogger {
  const entries: RecordingLogger['entries'] = [];
  return {
    entries,
    info: (message, fields) => entries.push({ level: 'info', message, fields }),
    error: (message, fields) => entries.push({ level: 'error', message, fields })
  };
}

/** A wait that never sleeps: every call stays pending until the test releases it (or the loop is stopped). */
function manualWait() {
  const pending: Array<() => void> = [];
  const state = { calls: 0 };
  const wait: Wait = (_milliseconds, signal) =>
    new Promise<void>((resolve) => {
      state.calls += 1;
      if (signal.aborted) {
        resolve();
        return;
      }
      pending.push(resolve);
      signal.addEventListener('abort', () => resolve());
    });
  return { wait, state, release: () => pending.shift()?.() };
}

describe('scheduler loop in the worker (M4-B)', () => {
  const fixtures: SchedulerFixture[] = [];
  const setup = async (start = '2026-06-01T10:00:00Z') => {
    const fixture = await createSchedulerFixture(start);
    fixtures.push(fixture);
    return fixture;
  };
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  });

  async function addScheduledSubscription(fixture: SchedulerFixture, everySeconds = 600) {
    const userId = await fixture.newUser();
    const subscription = await fixture.subscriptions.createSubscription({ userId, name: 'A', sourceRef: 'https://a.test' });
    await fixture.subscriptions.createSchedule({ userId, subscriptionId: subscription.id, rule: every(everySeconds) });
    return { userId, subscription };
  }

  it('generates due occurrences on a tick and nothing before they are due', async () => {
    const fixture = await setup();
    const { userId, subscription } = await addScheduledSubscription(fixture);
    const loop = new SchedulerLoop({ pool: fixture.pool, clock: fixture.clock, logger: recordingLogger() });

    expect((await loop.tick()).generated.enqueued).toBe(0);

    fixture.clock.advanceSeconds(600);
    const result = await loop.tick();
    expect(result.generated).toMatchObject({ schedulesProcessed: 1, enqueued: 1 });
    expect(result.failedSteps).toEqual([]);
    const runs = await fixture.queue.listRuns(userId, subscription.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].state).toBe('queued');

    expect((await loop.tick()).generated.enqueued).toBe(0);
  });

  it('keeps going while a generator pass is full', async () => {
    const fixture = await setup();
    for (let index = 0; index < 5; index += 1) await addScheduledSubscription(fixture);
    fixture.clock.advanceSeconds(600);
    const loop = new SchedulerLoop({ pool: fixture.pool, clock: fixture.clock, logger: recordingLogger(), generatorBatchSize: 2 });

    const result = await loop.tick();
    expect(result.generated).toMatchObject({ schedulesProcessed: 5, enqueued: 5 });
  });

  it('takes back an expired lease: the run becomes claimable again', async () => {
    const fixture = await setup();
    const { userId, subscription } = await addScheduledSubscription(fixture);
    await fixture.queue.enqueueManual(userId, subscription.id);
    const lease = await fixture.queue.claim({ workerId: 'crashed-worker', leaseSeconds: 60 });
    expect(lease).not.toBeNull();

    const loop = new SchedulerLoop({ pool: fixture.pool, clock: fixture.clock, logger: recordingLogger() });
    expect((await loop.tick()).reclaimed).toEqual({ requeued: 0, failed: 0 });

    fixture.clock.advanceSeconds(61);
    const result = await loop.tick();
    expect(result.reclaimed).toEqual({ requeued: 1, failed: 0 });
    const reclaimed = await fixture.queue.getRun(userId, lease!.runId);
    expect(reclaimed.state).toBe('retry_wait');
    await expect(fixture.queue.complete(lease!)).rejects.toThrow(/no longer held/);
    expect(await fixture.queue.claim({ workerId: 'second-worker', leaseSeconds: 60 })).toMatchObject({ runId: lease!.runId });
  });

  it('runs the retention cleanup with the configured period and not more often than its interval', async () => {
    const fixture = await setup('2026-01-01T00:00:00Z');
    const { userId, subscription } = await addScheduledSubscription(fixture, 3600);
    fixture.clock.advanceSeconds(3600);
    const loop = new SchedulerLoop({ pool: fixture.pool, clock: fixture.clock, logger: recordingLogger(), retentionIntervalMs: 3_600_000 });
    await loop.tick();
    await fixture.finishOpenRuns();

    // Default policy: 90 days. 60 days later the finished run is still kept.
    fixture.clock.set('2026-03-03T00:00:00Z');
    expect((await loop.tick()).retention).toEqual({ occurrencesDeleted: 0, runsDeleted: 0 });
    expect(await fixture.queue.listRuns(userId, subscription.id)).toHaveLength(2);

    // An admin shortens the retention to 30 days; the loop waits for its interval first.
    await new RuntimePolicyRepository(fixture.pool).activate({ retention: { finishedRunDays: 30 } }, 0, userId);
    fixture.clock.advanceSeconds(60);
    expect((await loop.tick()).retention).toBeNull();

    fixture.clock.advanceSeconds(3600);
    const cleaned = await loop.tick();
    expect(cleaned.retention?.runsDeleted).toBeGreaterThanOrEqual(1);
    expect(cleaned.failedSteps).toEqual([]);
  });

  it('does not stop the other steps when one fails, logs without details, and retries retention next tick', async () => {
    const fixture = await setup();
    await addScheduledSubscription(fixture);
    fixture.clock.advanceSeconds(600);
    await fixture.pool.query('ALTER TABLE runtime_policy_versions RENAME TO runtime_policy_versions_broken');
    const logger = recordingLogger();
    const loop = new SchedulerLoop({ pool: fixture.pool, clock: fixture.clock, logger });

    const broken = await loop.tick();
    expect(broken.failedSteps).toEqual(['retention']);
    expect(broken.generated.enqueued).toBe(1);
    const failure = logger.entries.find((entry) => entry.level === 'error');
    expect(failure?.fields?.step).toBe('retention');
    expect(JSON.stringify(failure)).not.toContain('postgres://');

    await fixture.pool.query('ALTER TABLE runtime_policy_versions_broken RENAME TO runtime_policy_versions');
    const repaired = await loop.tick();
    expect(repaired.failedSteps).toEqual([]);
    expect(repaired.retention).not.toBeNull();
  });

  it('is safe with several worker instances at the same time: no duplicate runs', async () => {
    const fixture = await setup();
    const users = [];
    for (let index = 0; index < 10; index += 1) users.push(await addScheduledSubscription(fixture));
    fixture.clock.advanceSeconds(600);
    const loops = Array.from({ length: 4 }, () => new SchedulerLoop({ pool: fixture.pool, clock: fixture.clock, logger: recordingLogger(), generatorBatchSize: 3 }));

    const results = await Promise.all(loops.map((loop) => loop.tick()));
    expect(results.flatMap((result) => result.failedSteps)).toEqual([]);

    const runs = await fixture.pool.query('SELECT subscription_id FROM job_runs');
    expect(runs.rowCount).toBe(10);
    expect(new Set(runs.rows.map((row) => row.subscription_id)).size).toBe(10);
    const occurrences = await fixture.pool.query('SELECT count(*)::int AS count FROM schedule_occurrences');
    expect(occurrences.rows[0].count).toBe(10);
  });

  it('start() ticks immediately and after every wait; stop() ends the loop gracefully and is idempotent', async () => {
    const fixture = await setup();
    const { userId, subscription } = await addScheduledSubscription(fixture);
    const waiting = manualWait();
    const loop = new SchedulerLoop({ pool: fixture.pool, clock: fixture.clock, logger: recordingLogger(), wait: waiting.wait });
    expect(loop.isRunning).toBe(false);

    await loop.start();
    expect(loop.isRunning).toBe(true);
    await loop.start(); // second start is a no-op
    await vi.waitFor(() => expect(waiting.state.calls).toBe(1));
    expect(await fixture.queue.listRuns(userId, subscription.id)).toHaveLength(0);

    fixture.clock.advanceSeconds(600);
    waiting.release();
    await vi.waitFor(() => expect(waiting.state.calls).toBe(2));
    expect(await fixture.queue.listRuns(userId, subscription.id)).toHaveLength(1);

    await loop.stop();
    expect(loop.isRunning).toBe(false);
    await loop.stop();

    // Nothing ticks after stop, even when time passes.
    await fixture.finishOpenRuns();
    fixture.clock.advanceSeconds(1200);
    waiting.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(waiting.state.calls).toBe(2);
    expect(await fixture.queue.listRuns(userId, subscription.id)).toHaveLength(1);

    // A stopped loop can be started again.
    await loop.start();
    await vi.waitFor(() => expect(waiting.state.calls).toBe(3));
    await loop.stop();
    expect(await fixture.queue.listRuns(userId, subscription.id)).toHaveLength(2);
  });

  it('stop() waits for the tick that is in progress', async () => {
    const fixture = await setup();
    await addScheduledSubscription(fixture);
    fixture.clock.advanceSeconds(600);
    let tickStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { tickStarted = resolve; });
    let letTickFinish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { letTickFinish = resolve; });
    const logger: Logger = {
      // The info line is written at the end of a productive tick; hold it back to keep the tick "in progress".
      info: () => undefined,
      error: () => undefined
    };
    const loop = new SchedulerLoop({ pool: fixture.pool, clock: fixture.clock, logger, wait: manualWait().wait });
    const originalTick = loop.tick.bind(loop);
    loop.tick = async () => {
      tickStarted();
      await gate;
      return originalTick();
    };

    await loop.start();
    await started;
    let stopped = false;
    const stopping = loop.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);

    letTickFinish();
    await stopping;
    expect(stopped).toBe(true);
    const runs = await fixture.pool.query('SELECT 1 FROM job_runs');
    expect(runs.rowCount).toBe(1);
  });
});

describe('worker process wiring (M4-B)', () => {
  it('reads and validates its configuration', () => {
    expect(() => loadWorkerConfig({})).toThrow(/DATABASE_URL is required/);
    expect(() => loadWorkerConfig({ DATABASE_URL: 'not a url' })).toThrow(/must be a URL/);
    expect(() => loadWorkerConfig({ DATABASE_URL: 'postgres://h/db', WORKER_TICK_SECONDS: '0' })).toThrow(/WORKER_TICK_SECONDS/);
    expect(() => loadWorkerConfig({ DATABASE_URL: 'postgres://h/db', WORKER_RETENTION_INTERVAL_SECONDS: '5' })).toThrow(/WORKER_RETENTION_INTERVAL_SECONDS/);
    expect(loadWorkerConfig({ DATABASE_URL: 'postgres://h/db' })).toEqual({
      databaseUrl: 'postgres://h/db', tickIntervalMs: 15_000, retentionIntervalMs: 3_600_000
    });
    expect(loadWorkerConfig({ DATABASE_URL: 'postgres://h/db', WORKER_TICK_SECONDS: '5' }).tickIntervalMs).toBe(5000);
  });

  it('starts against a real database and stops cleanly, closing its connections', async () => {
    const database = await createTestDatabase();
    const migrations = await createMigrationsCopy();
    const probe = new Pool({ connectionString: database.databaseUrl, max: 1 });
    probe.on('error', () => undefined);
    const connectionCount = async () => {
      const result = await probe.query(
        'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()'
      );
      return result.rows[0].count as number;
    };
    try {
      await runMigrations(database.pool, migrations.directory);
      const before = await connectionCount();

      const logger = recordingLogger();
      const worker = new Worker({ databaseUrl: database.databaseUrl, tickIntervalMs: 60_000, retentionIntervalMs: 3_600_000 }, logger);
      await worker.start();
      await vi.waitFor(async () => expect(await connectionCount()).toBeGreaterThan(before));

      await worker.stop();
      expect(await connectionCount()).toBe(before);
      expect(logger.entries.filter((entry) => entry.level === 'error')).toEqual([]);
    } finally {
      await probe.end();
      await migrations.cleanup();
      await database.cleanup();
    }
  });
});
