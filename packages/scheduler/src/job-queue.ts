import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { systemClock, type Clock } from './clock.js';
import { NotFoundError, inTransaction } from './db.js';

export type JobRunState = 'queued' | 'leased' | 'retry_wait' | 'succeeded' | 'failed' | 'cancelled';

export const DEFAULT_MAX_ATTEMPTS = 5;

export interface JobRunRecord {
  id: string;
  userId: string;
  subscriptionId: string;
  scheduleId: string | null;
  scheduleVersion: number | null;
  triggerKind: 'schedule' | 'manual';
  scheduledFor: Date;
  jitterSeconds: number;
  runAfter: Date;
  state: JobRunState;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastError: string | null;
  configSnapshot: Record<string, unknown>;
  createdAt: Date;
  finishedAt: Date | null;
}

interface JobRunRow {
  id: string;
  user_id: string;
  subscription_id: string;
  schedule_id: string | null;
  schedule_version: number | null;
  trigger_kind: 'schedule' | 'manual';
  scheduled_for: Date;
  jitter_seconds: number;
  run_after: Date;
  state: JobRunState;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_error: string | null;
  config_snapshot: Record<string, unknown>;
  created_at: Date;
  finished_at: Date | null;
}

export function toJobRun(row: JobRunRow): JobRunRecord {
  return {
    id: row.id,
    userId: row.user_id,
    subscriptionId: row.subscription_id,
    scheduleId: row.schedule_id,
    scheduleVersion: row.schedule_version,
    triggerKind: row.trigger_kind,
    scheduledFor: row.scheduled_for,
    jitterSeconds: row.jitter_seconds,
    runAfter: row.run_after,
    state: row.state,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,
    configSnapshot: row.config_snapshot,
    createdAt: row.created_at,
    finishedAt: row.finished_at
  };
}

export class SubscriptionPausedError extends Error {
  constructor() {
    super('Subscription is paused; no new runs are created');
    this.name = 'SubscriptionPausedError';
  }
}

export interface NewJobRun {
  userId: string;
  subscriptionId: string;
  scheduleId: string | null;
  scheduleVersion: number | null;
  triggerKind: 'schedule' | 'manual';
  scheduledFor: Date;
  jitterSeconds: number;
  maxAttempts: number;
  configSnapshot: Record<string, unknown>;
}

/**
 * Inserts a queued run unless the subscription already has an open run (queued, leased or
 * retry_wait). The partial unique index decides, so concurrent callers cannot create two.
 * `created: false` means "coalesced into the open run" and carries that run's id.
 */
export async function enqueueUnlessOpen(
  client: PoolClient,
  run: NewJobRun
): Promise<{ runId: string; created: boolean }> {
  const runAfter = new Date(run.scheduledFor.getTime() + run.jitterSeconds * 1000);
  // The open run can finish between a conflicting insert and the lookup; try again in that case.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO job_runs (id, user_id, subscription_id, schedule_id, schedule_version, trigger_kind,
                             scheduled_for, jitter_seconds, run_after, max_attempts, config_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       ON CONFLICT (subscription_id) WHERE state IN ('queued', 'leased', 'retry_wait') DO NOTHING
       RETURNING id`,
      [
        randomUUID(), run.userId, run.subscriptionId, run.scheduleId, run.scheduleVersion, run.triggerKind,
        run.scheduledFor, run.jitterSeconds, runAfter, run.maxAttempts, JSON.stringify(run.configSnapshot)
      ]
    );
    if (inserted.rows[0]) return { runId: inserted.rows[0].id, created: true };

    const open = await client.query<{ id: string }>(
      `SELECT id FROM job_runs
        WHERE subscription_id = $1 AND state IN ('queued', 'leased', 'retry_wait')`,
      [run.subscriptionId]
    );
    if (open.rows[0]) return { runId: open.rows[0].id, created: false };
  }
  throw new Error('Could not enqueue or find an open run for the subscription');
}

export interface JobQueueOptions {
  clock?: Clock;
  maxAttempts?: number;
}

export class JobQueue {
  private readonly clock: Clock;
  private readonly maxAttempts: number;

  constructor(private readonly pool: Pool, options: JobQueueOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  /**
   * "Run now" (plan 04, section 5, immediate start). Returns the existing open run when the
   * subscription already has one (coalesced). Refused for paused subscriptions.
   */
  async enqueueManual(userId: string, subscriptionId: string): Promise<{ run: JobRunRecord; coalesced: boolean }> {
    const now = this.clock.now();
    return inTransaction(this.pool, async (client) => {
      const subscription = await client.query<{ status: string; source_ref: string | null }>(
        'SELECT status, source_ref FROM subscriptions WHERE id = $1 AND user_id = $2 FOR SHARE',
        [subscriptionId, userId]
      );
      if (!subscription.rows[0]) throw new NotFoundError('Subscription');
      if (subscription.rows[0].status === 'paused') throw new SubscriptionPausedError();

      const { runId, created } = await enqueueUnlessOpen(client, {
        userId,
        subscriptionId,
        scheduleId: null,
        scheduleVersion: null,
        triggerKind: 'manual',
        scheduledFor: now,
        jitterSeconds: 0,
        maxAttempts: this.maxAttempts,
        configSnapshot: { sourceRef: subscription.rows[0].source_ref }
      });
      const row = await client.query<JobRunRow>('SELECT * FROM job_runs WHERE id = $1', [runId]);
      return { run: toJobRun(row.rows[0]), coalesced: !created };
    });
  }

  async getRun(userId: string, runId: string): Promise<JobRunRecord> {
    const result = await this.pool.query<JobRunRow>(
      'SELECT * FROM job_runs WHERE id = $1 AND user_id = $2',
      [runId, userId]
    );
    if (!result.rows[0]) throw new NotFoundError('Job run');
    return toJobRun(result.rows[0]);
  }

  async listRuns(userId: string, subscriptionId: string): Promise<JobRunRecord[]> {
    const result = await this.pool.query<JobRunRow>(
      'SELECT * FROM job_runs WHERE user_id = $1 AND subscription_id = $2 ORDER BY scheduled_for, id',
      [userId, subscriptionId]
    );
    return result.rows.map(toJobRun);
  }
}
