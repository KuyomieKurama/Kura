import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  JobQueue,
  ManualClock,
  OccurrenceGenerator,
  SubscriptionRepository,
  type GeneratorOptions,
  type JobQueueOptions
} from '../../packages/scheduler/src/index.js';
import { runMigrations } from '../../packages/storage/src/migrator.js';
import { createMigrationsCopy, createTestDatabase } from '../helpers/database.js';

export interface SchedulerFixture {
  pool: Pool;
  clock: ManualClock;
  subscriptions: SubscriptionRepository;
  queue: JobQueue;
  generator: OccurrenceGenerator;
  newGenerator: (options?: GeneratorOptions) => OccurrenceGenerator;
  newUser: (name?: string) => Promise<string>;
  /** Marks all open runs as succeeded so the next due occurrence is not coalesced. Test shortcut, plain SQL. */
  finishOpenRuns: () => Promise<void>;
  cleanup: () => Promise<void>;
}

export async function createSchedulerFixture(
  start = '2026-06-01T10:00:00Z',
  queueOptions: Omit<JobQueueOptions, 'clock'> = {}
): Promise<SchedulerFixture> {
  const database = await createTestDatabase();
  const migrations = await createMigrationsCopy();
  await runMigrations(database.pool, migrations.directory);

  const clock = new ManualClock(start);
  const { pool } = database;
  return {
    pool,
    clock,
    subscriptions: new SubscriptionRepository(pool, clock),
    queue: new JobQueue(pool, { clock, ...queueOptions }),
    generator: new OccurrenceGenerator(pool, { clock, ...queueOptions }),
    newGenerator: (options = {}) => new OccurrenceGenerator(pool, { clock, ...queueOptions, ...options }),
    newUser: async (name = 'Scheduler User') => {
      const id = randomUUID();
      await pool.query('INSERT INTO users (id, display_name) VALUES ($1, $2)', [id, name]);
      return id;
    },
    finishOpenRuns: async () => {
      await pool.query(
        `UPDATE job_runs SET state = 'succeeded', finished_at = $1, lease_owner = NULL, lease_expires_at = NULL
          WHERE state IN ('queued', 'leased', 'retry_wait')`,
        [clock.now()]
      );
    },
    cleanup: async () => {
      await migrations.cleanup();
      await database.cleanup();
    }
  };
}
