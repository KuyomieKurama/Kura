import type { WorkerLifecycle } from '@kura/contracts';
import {
  JobQueue,
  OccurrenceGenerator,
  RetentionCleaner,
  RuntimePolicyRepository,
  systemClock,
  type Clock
} from '@kura/scheduler';
import type { Pool } from 'pg';

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  info: (message, fields) => console.log(JSON.stringify({ level: 'info', message, ...fields })),
  error: (message, fields) => console.error(JSON.stringify({ level: 'error', message, ...fields }))
};

/** Resolves after `milliseconds` or as soon as the signal aborts, whichever comes first. */
export type Wait = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export const realWait: Wait = (milliseconds, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish);
  });

export interface SchedulerLoopOptions {
  pool: Pool;
  clock?: Clock;
  logger?: Logger;
  /** Pause between ticks. */
  tickIntervalMs?: number;
  /** Minimum time between two retention runs. */
  retentionIntervalMs?: number;
  /** Schedules per generator pass; a tick repeats passes while a pass was full. */
  generatorBatchSize?: number;
  /** Injectable for tests so that no real time has to pass. */
  wait?: Wait;
}

export interface TickResult {
  reclaimed: { requeued: number; failed: number };
  generated: { schedulesProcessed: number; enqueued: number; coalesced: number };
  retention: { occurrencesDeleted: number; runsDeleted: number } | null;
  /** Names of the steps that threw. The other steps still ran. */
  failedSteps: string[];
}

const MAX_GENERATOR_PASSES_PER_TICK = 20;

/**
 * Periodic housekeeping of the scheduler (M4): creates the runs that are due, takes back expired
 * leases and cleans up old history. It does not execute downloads (M5-B).
 *
 * The three steps are independent: a failing step is logged and the others still run in the same
 * tick. Several worker processes may run this loop at the same time; the generator locks schedules
 * with SKIP LOCKED and the unique constraints prevent duplicate occurrences.
 */
export class SchedulerLoop implements WorkerLifecycle {
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly tickIntervalMs: number;
  private readonly retentionIntervalMs: number;
  private readonly generatorBatchSize: number;
  private readonly wait: Wait;
  private readonly queue: JobQueue;
  private readonly generator: OccurrenceGenerator;
  private readonly retention: RetentionCleaner;
  private readonly policies: RuntimePolicyRepository;
  private lastRetentionAt: Date | null = null;
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;

  constructor(options: SchedulerLoopOptions) {
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? consoleLogger;
    this.tickIntervalMs = options.tickIntervalMs ?? 15_000;
    this.retentionIntervalMs = options.retentionIntervalMs ?? 3_600_000;
    this.generatorBatchSize = options.generatorBatchSize ?? 100;
    this.wait = options.wait ?? realWait;
    this.queue = new JobQueue(options.pool, { clock: this.clock });
    this.generator = new OccurrenceGenerator(options.pool, { clock: this.clock });
    this.retention = new RetentionCleaner(options.pool, { clock: this.clock });
    this.policies = new RuntimePolicyRepository(options.pool);
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const controller = new AbortController();
    this.controller = controller;
    this.running = this.loop(controller.signal);
  }

  /** Lets the tick in progress finish, then returns. Safe to call twice. */
  async stop(): Promise<void> {
    if (!this.running || !this.controller) return;
    this.controller.abort();
    await this.running;
    this.running = null;
    this.controller = null;
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.tick();
      await this.wait(this.tickIntervalMs, signal);
    }
  }

  /** One round of housekeeping. Never throws; problems are reported in `failedSteps`. */
  async tick(): Promise<TickResult> {
    const result: TickResult = {
      reclaimed: { requeued: 0, failed: 0 },
      generated: { schedulesProcessed: 0, enqueued: 0, coalesced: 0 },
      retention: null,
      failedSteps: []
    };

    await this.step(result, 'reclaim-leases', async () => {
      result.reclaimed = await this.queue.reclaimExpiredLeases();
    });
    await this.step(result, 'generate-occurrences', async () => {
      for (let pass = 0; pass < MAX_GENERATOR_PASSES_PER_TICK; pass += 1) {
        const generated = await this.generator.generateDue(this.generatorBatchSize);
        result.generated.schedulesProcessed += generated.schedulesProcessed;
        result.generated.enqueued += generated.enqueued;
        result.generated.coalesced += generated.coalesced;
        if (generated.schedulesProcessed < this.generatorBatchSize) break;
      }
    });
    if (this.retentionIsDue()) {
      await this.step(result, 'retention', async () => {
        const { policy } = await this.policies.current();
        const cleaned = await this.retention.run(policy.retention.finishedRunDays);
        result.retention = { occurrencesDeleted: cleaned.occurrencesDeleted, runsDeleted: cleaned.runsDeleted };
        // Only a successful run postpones the next one.
        this.lastRetentionAt = this.clock.now();
      });
    }

    if (result.reclaimed.requeued + result.reclaimed.failed > 0 || result.generated.enqueued + result.generated.coalesced > 0 || result.retention) {
      this.logger.info('scheduler tick', {
        reclaimed: result.reclaimed,
        generated: result.generated,
        retention: result.retention
      });
    }
    return result;
  }

  private retentionIsDue(): boolean {
    if (this.lastRetentionAt === null) return true;
    return this.clock.now().getTime() - this.lastRetentionAt.getTime() >= this.retentionIntervalMs;
  }

  private async step(result: TickResult, name: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      result.failedSteps.push(name);
      // Name and message only: no stack, no connection details.
      this.logger.error('scheduler step failed', {
        step: name,
        error: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'
      });
    }
  }
}
