import type { WorkerLifecycle } from '@kura/contracts';
import { Pool } from 'pg';
import type { WorkerConfig } from './config.js';
import { SchedulerLoop, consoleLogger, type Logger } from './scheduler-loop.js';

/** The worker process: owns the database pool and the scheduler loop. Download execution follows in M5-B. */
export class Worker implements WorkerLifecycle {
  private readonly pool: Pool;
  private readonly loop: SchedulerLoop;

  constructor(config: WorkerConfig, logger: Logger = consoleLogger) {
    this.pool = new Pool({ connectionString: config.databaseUrl });
    // An idle connection that breaks must not crash the process; the next tick reconnects.
    this.pool.on('error', (error) => logger.error('database connection error', { error: error.message }));
    this.loop = new SchedulerLoop({
      pool: this.pool,
      logger,
      tickIntervalMs: config.tickIntervalMs,
      retentionIntervalMs: config.retentionIntervalMs
    });
  }

  async start(): Promise<void> {
    await this.loop.start();
  }

  async stop(): Promise<void> {
    await this.loop.stop();
    await this.pool.end();
  }
}
