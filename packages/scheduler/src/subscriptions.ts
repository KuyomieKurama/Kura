import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { systemClock, type Clock } from './clock.js';
import { NotFoundError, inTransaction } from './db.js';
import { InvalidScheduleRuleError, nextDue, normalizeRule, type ScheduleRule } from './rules.js';

export type SubscriptionStatus = 'active' | 'paused';

/** Result of checking the target against a platform adapter. Adapters (M5-B) set it; M4 only stores 'unvalidated'. */
export type TargetState = 'unvalidated' | 'valid' | 'invalid';

export interface SubscriptionRecord {
  id: string;
  userId: string;
  name: string;
  sourceRef: string | null;
  platformHint: string | null;
  targetState: TargetState;
  status: SubscriptionStatus;
  pausedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SubscriptionChanges {
  name?: string;
  sourceRef?: string | null;
  platformHint?: string | null;
}

/** The subscription cannot be deleted while a worker holds a lease on one of its runs. */
export class SubscriptionBusyError extends Error {
  constructor() {
    super('Subscription has a running job and cannot be deleted');
    this.name = 'SubscriptionBusyError';
  }
}

export interface ScheduleRecord {
  id: string;
  userId: string;
  subscriptionId: string;
  version: number;
  rule: ScheduleRule;
  jitterMaxSeconds: number;
  enabled: boolean;
  generatedThrough: Date;
  nextDueAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScheduleChanges {
  rule?: ScheduleRule;
  jitterMaxSeconds?: number;
  enabled?: boolean;
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  name: string;
  source_ref: string | null;
  platform_hint: string | null;
  target_state: TargetState;
  status: SubscriptionStatus;
  paused_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ScheduleRow {
  id: string;
  user_id: string;
  subscription_id: string;
  version: number;
  rule: ScheduleRule;
  jitter_max_seconds: number;
  enabled: boolean;
  generated_through: Date;
  next_due_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toSubscription(row: SubscriptionRow): SubscriptionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    sourceRef: row.source_ref,
    platformHint: row.platform_hint,
    targetState: row.target_state,
    status: row.status,
    pausedAt: row.paused_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function toSchedule(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    userId: row.user_id,
    subscriptionId: row.subscription_id,
    version: row.version,
    rule: row.rule,
    jitterMaxSeconds: row.jitter_max_seconds,
    enabled: row.enabled,
    generatedThrough: row.generated_through,
    nextDueAt: row.next_due_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Subscriptions and their schedules. Every method takes the owner's user id and only ever
 * touches rows of that user (OWN-01).
 */
export class SubscriptionRepository {
  constructor(private readonly pool: Pool, private readonly clock: Clock = systemClock) {}

  async createSubscription(input: {
    userId: string;
    name: string;
    sourceRef?: string;
    platformHint?: string;
  }): Promise<SubscriptionRecord> {
    const result = await this.pool.query<SubscriptionRow>(
      `INSERT INTO subscriptions (id, user_id, name, source_ref, platform_hint, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *`,
      [randomUUID(), input.userId, input.name, input.sourceRef ?? null, input.platformHint ?? null, this.clock.now()]
    );
    return toSubscription(result.rows[0]);
  }

  async listSubscriptions(userId: string): Promise<SubscriptionRecord[]> {
    const result = await this.pool.query<SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at, id',
      [userId]
    );
    return result.rows.map(toSubscription);
  }

  /**
   * Changing the target resets its validation: a new URL has not been checked by an adapter.
   * Fields that are not part of `changes` stay as they are; null clears sourceRef and platformHint.
   */
  async updateSubscription(
    userId: string,
    subscriptionId: string,
    changes: SubscriptionChanges
  ): Promise<SubscriptionRecord> {
    return inTransaction(this.pool, async (client) => {
      const current = await client.query<SubscriptionRow>(
        'SELECT * FROM subscriptions WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [subscriptionId, userId]
      );
      if (!current.rows[0]) throw new NotFoundError('Subscription');
      const existing = toSubscription(current.rows[0]);

      const sourceRef = changes.sourceRef === undefined ? existing.sourceRef : changes.sourceRef;
      const targetChanged = sourceRef !== existing.sourceRef;
      const updated = await client.query<SubscriptionRow>(
        `UPDATE subscriptions
            SET name = $3, source_ref = $4, platform_hint = $5, target_state = $6, updated_at = $7
          WHERE id = $1 AND user_id = $2 RETURNING *`,
        [
          subscriptionId,
          userId,
          changes.name ?? existing.name,
          sourceRef,
          changes.platformHint === undefined ? existing.platformHint : changes.platformHint,
          targetChanged ? 'unvalidated' : existing.targetState,
          this.clock.now()
        ]
      );
      return toSubscription(updated.rows[0]);
    });
  }

  /**
   * Removes the subscription with its schedules, occurrences and run history (scheduling metadata
   * only; downloaded media is not touched by M4). Refused while a run is leased by a worker.
   */
  async deleteSubscription(userId: string, subscriptionId: string): Promise<void> {
    await inTransaction(this.pool, async (client) => {
      const current = await client.query(
        'SELECT 1 FROM subscriptions WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [subscriptionId, userId]
      );
      if (!current.rows[0]) throw new NotFoundError('Subscription');

      const leased = await client.query(
        "SELECT 1 FROM job_runs WHERE subscription_id = $1 AND user_id = $2 AND state = 'leased'",
        [subscriptionId, userId]
      );
      if (leased.rows[0]) throw new SubscriptionBusyError();

      const scope = [subscriptionId, userId];
      await client.query('DELETE FROM schedule_occurrences WHERE subscription_id = $1 AND user_id = $2', scope);
      await client.query('DELETE FROM job_runs WHERE subscription_id = $1 AND user_id = $2', scope);
      await client.query('DELETE FROM schedules WHERE subscription_id = $1 AND user_id = $2', scope);
      await client.query('DELETE FROM subscriptions WHERE id = $1 AND user_id = $2', scope);
    });
  }

  async getSubscription(userId: string, subscriptionId: string): Promise<SubscriptionRecord> {
    const result = await this.pool.query<SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE id = $1 AND user_id = $2',
      [subscriptionId, userId]
    );
    if (!result.rows[0]) throw new NotFoundError('Subscription');
    return toSubscription(result.rows[0]);
  }

  /**
   * Records the result of an adapter check (M5-B). It applies only while the stored target is still the one
   * that was checked, because the user may have edited the URL in the meantime. Returns false in that case
   * and for unknown or foreign subscriptions.
   */
  async setTargetState(
    userId: string,
    subscriptionId: string,
    state: 'valid' | 'invalid',
    checkedSourceRef: string
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE subscriptions SET target_state = $3
        WHERE id = $1 AND user_id = $2 AND source_ref = $4`,
      [subscriptionId, userId, state, checkedSourceRef]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** New runs stop; queued runs stay queued but are not claimed; a running job is not touched. Idempotent. */
  async pauseSubscription(userId: string, subscriptionId: string): Promise<SubscriptionRecord> {
    const now = this.clock.now();
    const result = await this.pool.query<SubscriptionRow>(
      `UPDATE subscriptions
          SET status = 'paused', paused_at = COALESCE(paused_at, $3), updated_at = $3
        WHERE id = $1 AND user_id = $2 RETURNING *`,
      [subscriptionId, userId, now]
    );
    if (!result.rows[0]) throw new NotFoundError('Subscription');
    return toSubscription(result.rows[0]);
  }

  /**
   * Resume continues with the next due time after "now": occurrences that fell into the pause
   * are not caught up. Resuming an active subscription changes nothing.
   */
  async resumeSubscription(userId: string, subscriptionId: string): Promise<SubscriptionRecord> {
    const now = this.clock.now();
    return inTransaction(this.pool, async (client) => {
      const current = await client.query<SubscriptionRow>(
        'SELECT * FROM subscriptions WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [subscriptionId, userId]
      );
      if (!current.rows[0]) throw new NotFoundError('Subscription');
      if (current.rows[0].status === 'active') return toSubscription(current.rows[0]);

      const resumed = await client.query<SubscriptionRow>(
        `UPDATE subscriptions SET status = 'active', paused_at = NULL, updated_at = $2
          WHERE id = $1 RETURNING *`,
        [subscriptionId, now]
      );
      const schedules = await client.query<ScheduleRow>(
        'SELECT * FROM schedules WHERE subscription_id = $1 AND enabled FOR UPDATE',
        [subscriptionId]
      );
      for (const schedule of schedules.rows) await skipToNow(client, toSchedule(schedule), now);
      return toSubscription(resumed.rows[0]);
    });
  }

  async createSchedule(input: {
    userId: string;
    subscriptionId: string;
    rule: ScheduleRule;
    jitterMaxSeconds?: number;
  }): Promise<ScheduleRecord> {
    const rule = normalizeRule(input.rule);
    const now = this.clock.now();
    const first = nextDue(rule, now);
    if (!first?.scheduledForUtc) throw new InvalidScheduleRuleError('the rule never fires after its creation time');

    const result = await this.pool.query<ScheduleRow>(
      `INSERT INTO schedules (id, user_id, subscription_id, rule, rule_kind, time_zone,
                              jitter_max_seconds, generated_through, next_due_at, created_at, updated_at)
       SELECT $1, s.user_id, s.id, $4::jsonb, $5, $6, $7, $8, $9, $8, $8
         FROM subscriptions s WHERE s.id = $3 AND s.user_id = $2
       RETURNING *`,
      [
        randomUUID(), input.userId, input.subscriptionId, JSON.stringify(rule), rule.kind, rule.timeZone,
        input.jitterMaxSeconds ?? 0, now, first.scheduledForUtc
      ]
    );
    if (!result.rows[0]) throw new NotFoundError('Subscription');
    return toSchedule(result.rows[0]);
  }

  async listSchedules(userId: string, subscriptionId?: string): Promise<ScheduleRecord[]> {
    const result = await this.pool.query<ScheduleRow>(
      `SELECT * FROM schedules
        WHERE user_id = $1 AND ($2::uuid IS NULL OR subscription_id = $2)
        ORDER BY created_at, id`,
      [userId, subscriptionId ?? null]
    );
    return result.rows.map(toSchedule);
  }

  /**
   * Removes the schedule and its occurrence records. Job runs it created stay as history; they
   * lose the link to the schedule (their config snapshot still names the rule).
   */
  async deleteSchedule(userId: string, scheduleId: string): Promise<void> {
    await inTransaction(this.pool, async (client) => {
      const current = await client.query(
        'SELECT 1 FROM schedules WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [scheduleId, userId]
      );
      if (!current.rows[0]) throw new NotFoundError('Schedule');
      await client.query(
        'UPDATE job_runs SET schedule_id = NULL, schedule_version = NULL WHERE schedule_id = $1 AND user_id = $2',
        [scheduleId, userId]
      );
      await client.query('DELETE FROM schedule_occurrences WHERE schedule_id = $1 AND user_id = $2', [scheduleId, userId]);
      await client.query('DELETE FROM schedules WHERE id = $1 AND user_id = $2', [scheduleId, userId]);
    });
  }

  async getSchedule(userId: string, scheduleId: string): Promise<ScheduleRecord> {
    const result = await this.pool.query<ScheduleRow>(
      'SELECT * FROM schedules WHERE id = $1 AND user_id = $2',
      [scheduleId, userId]
    );
    if (!result.rows[0]) throw new NotFoundError('Schedule');
    return toSchedule(result.rows[0]);
  }

  /**
   * Any edit increases the version. Runs that already exist keep their configuration snapshot.
   * A changed rule or a re-enabled schedule continues after "now"; due occurrences of the old
   * rule that were not generated yet are discarded.
   */
  async updateSchedule(userId: string, scheduleId: string, changes: ScheduleChanges): Promise<ScheduleRecord> {
    const now = this.clock.now();
    return inTransaction(this.pool, async (client) => {
      const current = await client.query<ScheduleRow>(
        'SELECT * FROM schedules WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [scheduleId, userId]
      );
      if (!current.rows[0]) throw new NotFoundError('Schedule');
      const existing = toSchedule(current.rows[0]);

      const rule = changes.rule ? normalizeRule(changes.rule) : existing.rule;
      const enabled = changes.enabled ?? existing.enabled;
      const continuesFromNow = changes.rule !== undefined || (enabled && !existing.enabled);
      const generatedThrough = continuesFromNow && now > existing.generatedThrough ? now : existing.generatedThrough;
      const next = nextDue(rule, generatedThrough);
      if (enabled && !next?.scheduledForUtc) throw new InvalidScheduleRuleError('the rule never fires after the edit');

      const updated = await client.query<ScheduleRow>(
        `UPDATE schedules
            SET version = version + 1, rule = $3::jsonb, rule_kind = $4, time_zone = $5, jitter_max_seconds = $6,
                enabled = $7, generated_through = $8, next_due_at = $9, updated_at = $10
          WHERE id = $1 AND user_id = $2 RETURNING *`,
        [
          scheduleId, userId, JSON.stringify(rule), rule.kind, rule.timeZone,
          changes.jitterMaxSeconds ?? existing.jitterMaxSeconds, enabled, generatedThrough,
          next?.scheduledForUtc ?? null, now
        ]
      );
      return toSchedule(updated.rows[0]);
    });
  }
}

/** Moves the cursor of a locked schedule to "now" and recomputes the next due time. */
async function skipToNow(client: PoolClient, schedule: ScheduleRecord, now: Date): Promise<void> {
  const generatedThrough = now > schedule.generatedThrough ? now : schedule.generatedThrough;
  const next = nextDue(schedule.rule, generatedThrough);
  await client.query(
    'UPDATE schedules SET generated_through = $2, next_due_at = $3, updated_at = $4 WHERE id = $1',
    [schedule.id, generatedThrough, next?.scheduledForUtc ?? null, now]
  );
}
