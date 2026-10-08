import { randomInt, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { systemClock, type Clock } from './clock.js';
import { inTransaction } from './db.js';
import { DEFAULT_MAX_ATTEMPTS, enqueueUnlessOpen } from './job-queue.js';
import { nextDue, type ScheduleRule } from './rules.js';
import { toSchedule, type ScheduleRecord } from './subscriptions.js';

export interface GeneratorOptions {
  clock?: Clock;
  maxAttempts?: number;
  /** Returns an integer in [0, maxInclusive]. Injectable for tests. */
  randomJitterSeconds?: (maxInclusive: number) => number;
  /** Upper bound of due occurrences examined per schedule and pass (downtime of a very frequent rule). */
  maxOccurrencesPerPass?: number;
}

export interface GenerationResult {
  schedulesProcessed: number;
  enqueued: number;
  coalesced: number;
  /** Occurrences already recorded by someone else (should only happen with manual database edits). */
  alreadyRecorded: number;
}

const DEFAULT_MAX_OCCURRENCES_PER_PASS = 10_000;

/**
 * Turns due schedules into durable logical occurrences and queued job runs.
 *
 * One pass runs in one transaction. Due schedules are locked with FOR UPDATE SKIP LOCKED, so a
 * second scheduler instance works on other schedules instead of the same ones. Should a bug or a
 * manual edit still lead two writers to the same logical occurrence, the unique constraints on
 * schedule_occurrences make the insert a no-op (ON CONFLICT DO NOTHING).
 */
export class OccurrenceGenerator {
  private readonly clock: Clock;
  private readonly maxAttempts: number;
  private readonly randomJitterSeconds: (maxInclusive: number) => number;
  private readonly maxOccurrencesPerPass: number;

  constructor(private readonly pool: Pool, options: GeneratorOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.randomJitterSeconds = options.randomJitterSeconds ?? ((max) => randomInt(0, max + 1));
    this.maxOccurrencesPerPass = options.maxOccurrencesPerPass ?? DEFAULT_MAX_OCCURRENCES_PER_PASS;
  }

  async generateDue(limit = 100): Promise<GenerationResult> {
    const now = this.clock.now();
    return inTransaction(this.pool, async (client) => {
      const due = await client.query(
        `SELECT sch.*, sub.source_ref
           FROM schedules sch
           JOIN subscriptions sub ON sub.id = sch.subscription_id AND sub.user_id = sch.user_id
          WHERE sch.enabled AND sub.status = 'active'
            AND sch.next_due_at IS NOT NULL AND sch.next_due_at <= $1
          ORDER BY sch.next_due_at, sch.id
          LIMIT $2
            FOR UPDATE OF sch SKIP LOCKED
            FOR SHARE OF sub SKIP LOCKED`,
        [now, limit]
      );

      const result: GenerationResult = { schedulesProcessed: 0, enqueued: 0, coalesced: 0, alreadyRecorded: 0 };
      for (const row of due.rows) {
        const outcome = await this.generateForSchedule(client, toSchedule(row), row.source_ref as string | null, now);
        result.schedulesProcessed += 1;
        if (outcome) result[outcome] += 1;
      }
      return result;
    });
  }

  private async generateForSchedule(
    client: PoolClient,
    schedule: ScheduleRecord,
    sourceRef: string | null,
    now: Date
  ): Promise<'enqueued' | 'coalesced' | 'alreadyRecorded' | null> {
    // catch_up_once (plan 04, section 5): after downtime only the latest due occurrence runs;
    // earlier ones are folded into it and counted.
    const dueOccurrences = this.collectDueOccurrences(schedule.rule, schedule.generatedThrough, now);
    const latest = dueOccurrences.at(-1);

    let outcome: 'enqueued' | 'coalesced' | 'alreadyRecorded' | null = null;
    if (latest) {
      outcome = await this.recordOccurrence(client, schedule, sourceRef, latest, dueOccurrences.length - 1);
    }

    const cursor = latest?.scheduledFor ?? schedule.generatedThrough;
    const next = nextDue(schedule.rule, cursor);
    await client.query(
      'UPDATE schedules SET generated_through = $2, next_due_at = $3, updated_at = $4 WHERE id = $1',
      [schedule.id, cursor, next?.scheduledForUtc ?? null, now]
    );
    return outcome;
  }

  private collectDueOccurrences(
    rule: ScheduleRule,
    after: Date,
    now: Date
  ): Array<{ scheduledFor: Date; localPlanTime: string | null }> {
    const occurrences: Array<{ scheduledFor: Date; localPlanTime: string | null }> = [];
    let cursor = after;
    while (occurrences.length < this.maxOccurrencesPerPass) {
      const candidate = nextDue(rule, cursor);
      if (!candidate?.scheduledForUtc || candidate.scheduledForUtc > now) break;
      occurrences.push({ scheduledFor: candidate.scheduledForUtc, localPlanTime: candidate.localPlanTime });
      cursor = candidate.scheduledForUtc;
    }
    return occurrences;
  }

  private async recordOccurrence(
    client: PoolClient,
    schedule: ScheduleRecord,
    sourceRef: string | null,
    occurrence: { scheduledFor: Date; localPlanTime: string | null },
    missedCount: number
  ): Promise<'enqueued' | 'coalesced' | 'alreadyRecorded'> {
    const occurrenceId = randomUUID();
    const inserted = await client.query(
      `INSERT INTO schedule_occurrences (id, user_id, subscription_id, schedule_id, schedule_version,
                                         scheduled_for, local_plan_time, outcome, missed_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'enqueued', $8)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        occurrenceId, schedule.userId, schedule.subscriptionId, schedule.id, schedule.version,
        occurrence.scheduledFor, occurrence.localPlanTime, missedCount
      ]
    );
    if (inserted.rowCount === 0) return 'alreadyRecorded';

    const jitterSeconds = schedule.jitterMaxSeconds > 0 ? this.randomJitterSeconds(schedule.jitterMaxSeconds) : 0;
    const { runId, created } = await enqueueUnlessOpen(client, {
      userId: schedule.userId,
      subscriptionId: schedule.subscriptionId,
      scheduleId: schedule.id,
      scheduleVersion: schedule.version,
      triggerKind: 'schedule',
      scheduledFor: occurrence.scheduledFor,
      jitterSeconds,
      maxAttempts: this.maxAttempts,
      configSnapshot: { scheduleVersion: schedule.version, rule: schedule.rule, sourceRef }
    });
    await client.query(
      'UPDATE schedule_occurrences SET job_run_id = $2, outcome = $3 WHERE id = $1',
      [occurrenceId, runId, created ? 'enqueued' : 'coalesced']
    );
    return created ? 'enqueued' : 'coalesced';
  }
}
