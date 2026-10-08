import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { systemClock, type Clock } from './clock.js';
import { NotFoundError, inTransaction } from './db.js';

export type JobRunState = 'queued' | 'leased' | 'retry_wait' | 'succeeded' | 'failed' | 'cancelled';

export const DEFAULT_MAX_ATTEMPTS = 5;

/** Advisory lock that serializes claim decisions so that concurrency caps are exact. */
const CLAIM_ADVISORY_LOCK_KEY = 724311649;
const UNLIMITED = 2_147_483_647;
const MAX_ERROR_LENGTH = 2000;

/**
 * Concurrency limits from plan 04, section 10. null = no additional operator limit, 0 = nothing
 * starts, positive = limit. A user entry in `perUser` replaces the default for that user (null there
 * means "no user-level limit"); the global limit applies on top, the smaller limit wins.
 * Lowering a limit never touches running jobs; it only stops new starts until the count is below it.
 */
export interface QueueLimits {
  maxConcurrentGlobal?: number | null;
  maxConcurrentPerUser?: number | null;
  perUser?: Record<string, { maxConcurrent: number | null }>;
}

/** Capped exponential backoff: min(cap, base * multiplier^(attempt-1)), plus up to jitterRatio of that as jitter. */
export interface RetryPolicy {
  baseDelaySeconds: number;
  multiplier: number;
  capSeconds: number;
  jitterRatio: number;
  /** Upper bound for a provider's Retry-After (HTTP 429) that is honoured. */
  maxRetryAfterSeconds: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseDelaySeconds: 30,
  multiplier: 4,
  capSeconds: 1800,
  jitterRatio: 0.1,
  maxRetryAfterSeconds: 86_400
};

/** `attempt` is the number of the attempt that just failed (1 = first). `random` returns [0, 1). */
export function retryDelaySeconds(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
  retryAfterSeconds?: number
): number {
  const exponential = Math.min(policy.capSeconds, policy.baseDelaySeconds * policy.multiplier ** (attempt - 1));
  const withJitter = exponential * (1 + policy.jitterRatio * random());
  const honouredRetryAfter = Math.min(Math.max(retryAfterSeconds ?? 0, 0), policy.maxRetryAfterSeconds);
  return Math.max(withJitter, honouredRetryAfter);
}

/** The worker no longer holds the lease (expired, reclaimed by another worker, or already finished). */
export class LeaseLostError extends Error {
  constructor(runId: string) {
    super(`Lease of job run ${runId} is no longer held`);
    this.name = 'LeaseLostError';
  }
}

/** Handle for a claimed run. leaseGeneration is the fencing token: only the latest generation may finish the run. */
export interface JobLease {
  runId: string;
  userId: string;
  subscriptionId: string;
  scheduleId: string | null;
  scheduleVersion: number | null;
  scheduledFor: Date;
  leaseOwner: string;
  leaseGeneration: number;
  leaseExpiresAt: Date;
  configSnapshot: Record<string, unknown>;
}

export interface ClaimRequest {
  workerId: string;
  leaseSeconds: number;
  limits?: QueueLimits;
}

export interface FailureReport {
  /** Short, already redacted message. Stored truncated to 2000 characters. Never put secrets here. */
  error: string;
  /** false = permanent failure, no retry. Default true. */
  retryable?: boolean;
  /** Provider's Retry-After (HTTP 429), honoured up to the policy maximum. */
  retryAfterSeconds?: number;
}

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
  retry?: Partial<RetryPolicy>;
  /** Returns [0, 1). Injectable for tests. */
  random?: () => number;
}

export class JobQueue {
  private readonly clock: Clock;
  private readonly maxAttempts: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly random: () => number;

  constructor(private readonly pool: Pool, options: JobQueueOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.random = options.random ?? Math.random;
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

  /** Newest runs first (by logical due time), for the subscription page. */
  async listRecentRuns(userId: string, subscriptionId: string, limit = 20): Promise<JobRunRecord[]> {
    const result = await this.pool.query<JobRunRow>(
      `SELECT * FROM job_runs WHERE user_id = $1 AND subscription_id = $2
        ORDER BY scheduled_for DESC, id DESC LIMIT $3`,
      [userId, subscriptionId, limit]
    );
    return result.rows.map(toJobRun);
  }

  /**
   * Gives the worker the next run it may start, or null. Order of decisions:
   * 1. Runs whose lease expired are reclaimed (crash recovery).
   * 2. Global cap, then per-user cap (see QueueLimits).
   * 3. Fairness: among users that may start another run, the one with the fewest running jobs goes
   *    first; ties go to the user whose last claim is oldest (round-robin). Within a user the run
   *    with the earliest run_after wins.
   * Runs of paused subscriptions are not claimed. Candidates are locked with FOR UPDATE SKIP LOCKED;
   * the advisory lock additionally serializes claims so that the caps cannot be overshot by races.
   */
  async claim(request: ClaimRequest): Promise<JobLease | null> {
    const limits = validateLimits(request.limits ?? {});
    const now = this.clock.now();
    const leaseExpiresAt = new Date(now.getTime() + request.leaseSeconds * 1000);

    return inTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [CLAIM_ADVISORY_LOCK_KEY]);
      await reclaimExpired(client, now);

      if (limits.global !== null) {
        const running = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM job_runs WHERE state = 'leased'"
        );
        if (running.rows[0].count >= limits.global) return null;
      }

      const candidate = await client.query<{ id: string }>(
        `SELECT jr.id
           FROM job_runs jr
           JOIN subscriptions sub
             ON sub.id = jr.subscription_id AND sub.user_id = jr.user_id AND sub.status = 'active'
           LEFT JOIN (SELECT user_id, count(*)::int AS running FROM job_runs WHERE state = 'leased' GROUP BY user_id) r
             ON r.user_id = jr.user_id
           LEFT JOIN scheduler_user_state us ON us.user_id = jr.user_id
          CROSS JOIN LATERAL (
                SELECT CASE WHEN jsonb_exists($2::jsonb, jr.user_id::text)
                            THEN ($2::jsonb ->> jr.user_id::text)::int
                            ELSE $3::int END AS user_cap) limit_of
          WHERE jr.state IN ('queued', 'retry_wait') AND jr.run_after <= $1
            AND (limit_of.user_cap IS NULL OR COALESCE(r.running, 0) < limit_of.user_cap)
          ORDER BY COALESCE(r.running, 0), COALESCE(us.last_claim_no, 0), jr.run_after, jr.id
          LIMIT 1
            FOR UPDATE OF jr SKIP LOCKED`,
        [now, JSON.stringify(limits.perUser), limits.userDefault]
      );
      if (!candidate.rows[0]) return null;

      const claimed = await client.query<JobRunRow>(
        `UPDATE job_runs
            SET state = 'leased', attempts = attempts + 1, lease_owner = $2, lease_expires_at = $3,
                claimed_at = $4, heartbeat_at = $4, updated_at = $4
          WHERE id = $1 RETURNING *`,
        [candidate.rows[0].id, request.workerId, leaseExpiresAt, now]
      );
      const run = toJobRun(claimed.rows[0]);
      await client.query(
        `INSERT INTO scheduler_user_state (user_id, last_claim_no) VALUES ($1, nextval('scheduler_claim_no_seq'))
         ON CONFLICT (user_id) DO UPDATE SET last_claim_no = EXCLUDED.last_claim_no`,
        [run.userId]
      );
      return {
        runId: run.id,
        userId: run.userId,
        subscriptionId: run.subscriptionId,
        scheduleId: run.scheduleId,
        scheduleVersion: run.scheduleVersion,
        scheduledFor: run.scheduledFor,
        leaseOwner: request.workerId,
        leaseGeneration: run.attempts,
        leaseExpiresAt,
        configSnapshot: run.configSnapshot
      };
    });
  }

  /** Extends a lease that is still valid. Throws LeaseLostError once it expired or was taken over. */
  async heartbeat(lease: JobLease, extendSeconds: number): Promise<Date> {
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + extendSeconds * 1000);
    const result = await this.pool.query(
      `UPDATE job_runs SET lease_expires_at = $6, heartbeat_at = $5, updated_at = $5
        WHERE ${HOLDS_LEASE}`,
      [lease.runId, lease.userId, lease.leaseOwner, lease.leaseGeneration, now, expiresAt]
    );
    if (result.rowCount === 0) throw new LeaseLostError(lease.runId);
    return expiresAt;
  }

  async complete(lease: JobLease): Promise<void> {
    const now = this.clock.now();
    const result = await this.pool.query(
      `UPDATE job_runs
          SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL, finished_at = $5, updated_at = $5
        WHERE ${HOLDS_LEASE}`,
      [lease.runId, lease.userId, lease.leaseOwner, lease.leaseGeneration, now]
    );
    if (result.rowCount === 0) throw new LeaseLostError(lease.runId);
  }

  /**
   * Records a failed attempt. Retryable failures go to retry_wait with capped exponential backoff
   * until max_attempts is reached; then, and for permanent failures, the run is failed.
   * scheduled_for never changes and no new start jitter is drawn.
   */
  async fail(lease: JobLease, report: FailureReport): Promise<{ state: 'retry_wait' | 'failed'; runAfter: Date | null }> {
    const now = this.clock.now();
    const message = report.error.slice(0, MAX_ERROR_LENGTH);
    return inTransaction(this.pool, async (client) => {
      const current = await client.query<{ attempts: number; max_attempts: number }>(
        `SELECT attempts, max_attempts FROM job_runs WHERE ${HOLDS_LEASE} FOR UPDATE`,
        [lease.runId, lease.userId, lease.leaseOwner, lease.leaseGeneration, now]
      );
      if (!current.rows[0]) throw new LeaseLostError(lease.runId);

      const retry = (report.retryable ?? true) && current.rows[0].attempts < current.rows[0].max_attempts;
      if (!retry) {
        await client.query(
          `UPDATE job_runs
              SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL, last_error = $2,
                  finished_at = $3, updated_at = $3
            WHERE id = $1`,
          [lease.runId, message, now]
        );
        return { state: 'failed' as const, runAfter: null };
      }

      const delaySeconds = retryDelaySeconds(
        current.rows[0].attempts, this.retryPolicy, this.random, report.retryAfterSeconds
      );
      const runAfter = new Date(now.getTime() + Math.round(delaySeconds * 1000));
      await client.query(
        `UPDATE job_runs
            SET state = 'retry_wait', lease_owner = NULL, lease_expires_at = NULL, last_error = $2,
                run_after = $3, updated_at = $4
          WHERE id = $1`,
        [lease.runId, message, runAfter, now]
      );
      return { state: 'retry_wait' as const, runAfter };
    });
  }

  /**
   * Crash recovery: runs whose lease expired return to retry_wait (claimable at once), or fail when
   * their attempts are used up. claim() does this itself; call it separately for monitoring.
   */
  async reclaimExpiredLeases(): Promise<{ requeued: number; failed: number }> {
    const now = this.clock.now();
    return inTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [CLAIM_ADVISORY_LOCK_KEY]);
      return reclaimExpired(client, now);
    });
  }
}

/** Parameters: $1 run id, $2 user id, $3 lease owner, $4 lease generation, $5 now. */
const HOLDS_LEASE = `id = $1 AND user_id = $2 AND state = 'leased' AND lease_owner = $3
  AND attempts = $4 AND lease_expires_at > $5`;

interface ValidatedLimits {
  global: number | null;
  userDefault: number | null;
  perUser: Record<string, number | null>;
}

function validateLimits(limits: QueueLimits): ValidatedLimits {
  const check = (value: number | null | undefined, name: string): number | null => {
    if (value === undefined || value === null) return null;
    if (!Number.isInteger(value) || value < 0 || value > UNLIMITED) {
      throw new RangeError(`${name} must be null or an integer >= 0`);
    }
    return value;
  };
  return {
    global: check(limits.maxConcurrentGlobal, 'maxConcurrentGlobal'),
    userDefault: check(limits.maxConcurrentPerUser, 'maxConcurrentPerUser'),
    perUser: Object.fromEntries(
      Object.entries(limits.perUser ?? {}).map(([userId, entry]) => [userId, check(entry.maxConcurrent, `perUser.${userId}`)])
    )
  };
}

async function reclaimExpired(client: PoolClient, now: Date): Promise<{ requeued: number; failed: number }> {
  const reclaimed = await client.query<{ state: JobRunState }>(
    `UPDATE job_runs
        SET state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'retry_wait' END,
            lease_owner = NULL, lease_expires_at = NULL,
            last_error = 'Lease expired: the worker stopped without finishing or extending it',
            run_after = $1,
            finished_at = CASE WHEN attempts >= max_attempts THEN $1 END,
            updated_at = $1
      WHERE state = 'leased' AND lease_expires_at <= $1
      RETURNING state`,
    [now]
  );
  const failed = reclaimed.rows.filter((row) => row.state === 'failed').length;
  return { requeued: reclaimed.rows.length - failed, failed };
}
