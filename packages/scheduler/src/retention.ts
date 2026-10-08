import type { Pool } from 'pg';
import { systemClock, type Clock } from './clock.js';

/**
 * Cleanup of finished scheduler history (risk R-D of M4-A: job_runs and schedule_occurrences grow
 * without bound).
 *
 * Only history is removed:
 * - runs that are finished (succeeded, failed, cancelled) and were finished before the cutoff;
 * - occurrence records whose logical due time lies before the cutoff and whose run, if any, is finished.
 * Queued, leased and retry_wait runs and everything newer than the cutoff are never touched.
 * Deleting an occurrence cannot cause a duplicate run: schedules keep their own cursor
 * (generated_through), which only moves forward.
 */
export interface RetentionResult {
  cutoff: Date;
  occurrencesDeleted: number;
  runsDeleted: number;
}

export interface RetentionOptions {
  clock?: Clock;
  /** Rows per DELETE statement, so that the cleanup never holds long locks. */
  batchSize?: number;
}

const DAY_MS = 86_400_000;
const FINISHED_STATES = "('succeeded', 'failed', 'cancelled')";

export class RetentionCleaner {
  private readonly clock: Clock;
  private readonly batchSize: number;

  constructor(private readonly pool: Pool, options: RetentionOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.batchSize = options.batchSize ?? 1000;
  }

  async run(finishedRunDays: number): Promise<RetentionResult> {
    if (!Number.isInteger(finishedRunDays) || finishedRunDays < 1) {
      throw new RangeError('finishedRunDays must be an integer >= 1');
    }
    const cutoff = new Date(this.clock.now().getTime() - finishedRunDays * DAY_MS);
    // Occurrences first: they reference runs, so a run can only go once its occurrences are gone.
    const occurrencesDeleted = await this.deleteInBatches(
      `DELETE FROM schedule_occurrences
        WHERE id IN (
          SELECT o.id
            FROM schedule_occurrences o
            LEFT JOIN job_runs jr ON jr.id = o.job_run_id AND jr.user_id = o.user_id
           WHERE o.scheduled_for < $1
             AND (o.job_run_id IS NULL OR jr.state IN ${FINISHED_STATES})
           ORDER BY o.scheduled_for
           LIMIT $2)`,
      cutoff
    );
    const runsDeleted = await this.deleteInBatches(
      `DELETE FROM job_runs
        WHERE id IN (
          SELECT jr.id
            FROM job_runs jr
           WHERE jr.state IN ${FINISHED_STATES} AND jr.finished_at < $1
             AND NOT EXISTS (SELECT 1 FROM schedule_occurrences o WHERE o.job_run_id = jr.id)
           ORDER BY jr.finished_at
           LIMIT $2)`,
      cutoff
    );
    return { cutoff, occurrencesDeleted, runsDeleted };
  }

  private async deleteInBatches(statement: string, cutoff: Date): Promise<number> {
    let total = 0;
    for (;;) {
      const result = await this.pool.query(statement, [cutoff, this.batchSize]);
      const deleted = result.rowCount ?? 0;
      total += deleted;
      if (deleted < this.batchSize) return total;
    }
  }
}
