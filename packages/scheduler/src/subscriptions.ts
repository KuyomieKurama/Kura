import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { systemClock, type Clock } from './clock.js';
import { NotFoundError, inTransaction } from './db.js';
import { InvalidScheduleRuleError, nextDue, normalizeRule, type ScheduleRule } from './rules.js';

export type SubscriptionStatus = 'active' | 'paused';

export interface SubscriptionRecord {
  id: string;
  userId: string;
  name: string;
  sourceRef: string | null;
  status: SubscriptionStatus;
  pausedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
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

  async createSubscription(input: { userId: string; name: string; sourceRef?: string }): Promise<SubscriptionRecord> {
    const result = await this.pool.query<SubscriptionRow>(
      `INSERT INTO subscriptions (id, user_id, name, source_ref, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5) RETURNING *`,
      [randomUUID(), input.userId, input.name, input.sourceRef ?? null, this.clock.now()]
    );
    return toSubscription(result.rows[0]);
  }

  async getSubscription(userId: string, subscriptionId: string): Promise<SubscriptionRecord> {
    const result = await this.pool.query<SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE id = $1 AND user_id = $2',
      [subscriptionId, userId]
    );
    if (!result.rows[0]) throw new NotFoundError('Subscription');
    return toSubscription(result.rows[0]);
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
