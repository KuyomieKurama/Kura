import type { WorkerLifecycle } from '@kura/contracts';
import { DatabaseBlobStore } from '@kura/blobstore';
import {
  JobQueue,
  RuntimePolicyRepository,
  SubscriptionRepository,
  systemClock,
  type Clock
} from '@kura/scheduler';
import { Pool } from 'pg';
import { AdapterCatalog, approveNothing, type DirectUrlSettings } from './catalog.js';
import type { WorkerConfig } from './config.js';
import { DerivationLoop, MediaDeriver } from './derivatives.js';
import { DownloadLoop } from './download-loop.js';
import { JobExecutor } from './executor.js';
import { ImmichHandover } from './handover.js';
import { HistoryRepository } from './history.js';
import { DownloadMaintenance } from './maintenance.js';
import { SchedulerLoop, consoleLogger, type Logger, type Wait } from './scheduler-loop.js';

/** Replaceable parts, for tests. Production passes nothing. */
export interface WorkerDependencies {
  clock?: Clock;
  wait?: Wait;
  /** Network policy of the direct URL adapter. Default: no loopback or private destination is approved. */
  directUrl?: DirectUrlSettings;
  /** Name resolution for the user's Immich server. */
  resolveImmichHost?: (host: string) => Promise<string[]>;
  workerName?: string;
  /** Heartbeat interval override for tests. */
  heartbeatEveryMs?: number;
}

/**
 * The worker process: owns the database pool, the scheduler loop (M4) and, when configured, the download
 * executor (M5-B) with the blob store, the adapters and their upkeep.
 */
export class Worker implements WorkerLifecycle {
  private readonly pool: Pool;
  private readonly scheduler: SchedulerLoop;
  private readonly lifecycles: WorkerLifecycle[] = [];

  constructor(config: WorkerConfig, logger: Logger = consoleLogger, dependencies: WorkerDependencies = {}) {
    this.pool = new Pool({ connectionString: config.databaseUrl });
    // An idle connection that breaks must not crash the process; the next tick reconnects.
    this.pool.on('error', (error) => logger.error('database connection error', { error: error.message }));
    const clock = dependencies.clock ?? systemClock;
    this.scheduler = new SchedulerLoop({
      pool: this.pool,
      logger,
      clock: dependencies.clock,
      wait: dependencies.wait,
      tickIntervalMs: config.tickIntervalMs,
      retentionIntervalMs: config.retentionIntervalMs
    });

    const downloads = config.downloads;
    if (!downloads) return;

    // The worker uses the database store so that the API (another process) sees the same objects.
    const blobstore = new DatabaseBlobStore(this.pool, { quotaBytes: downloads.quotaBytes });
    const catalog = new AdapterCatalog({
      tools: downloads.tools,
      externalToolsEgressConfirmed: downloads.externalToolsEgressConfirmed,
      workDir: downloads.workDir,
      maxAssetBytes: downloads.maxAssetBytes,
      instagramMaxPostsPerRun: downloads.instagramMaxPostsPerRun,
      patreonMaxPostsPerRun: downloads.patreonMaxPostsPerRun,
      pixivMaxPostsPerRun: downloads.pixivMaxPostsPerRun,
      youtubeMaxPostsPerRun: downloads.youtubeMaxPostsPerRun,
      pornhubMaxPostsPerRun: downloads.pornhubMaxPostsPerRun,
      directUrl: dependencies.directUrl ?? { approvals: approveNothing },
      logger
    });
    const history = new HistoryRepository(this.pool, clock);
    const subscriptions = new SubscriptionRepository(this.pool, clock);
    const queue = new JobQueue(this.pool, { clock });
    const executor = new JobExecutor({
      pool: this.pool,
      queue,
      subscriptions,
      history,
      blobstore,
      catalog,
      handover: new ImmichHandover({ pool: this.pool, blobstore, secretKey: downloads.secretKey, resolveHost: dependencies.resolveImmichHost }),
      clock,
      logger,
      workDir: downloads.workDir,
      maxAssetBytes: downloads.maxAssetBytes,
      secretKey: downloads.secretKey
    });
    // Maintenance first: it checks the tools once, so the loop starts with the real adapter set.
    this.lifecycles.push(
      new DownloadMaintenance({
        pool: this.pool, catalog, blobstore, workDir: downloads.workDir, recheckMs: downloads.adapterRecheckMs, logger, clock, wait: dependencies.wait
      }),
      new DownloadLoop({
        queue,
        executor,
        policies: new RuntimePolicyRepository(this.pool),
        subscriptions,
        logger,
        concurrency: downloads.concurrency,
        pollIntervalMs: downloads.pollIntervalMs,
        leaseSeconds: downloads.leaseSeconds,
        heartbeatEveryMs: dependencies.heartbeatEveryMs,
        wait: dependencies.wait,
        workerName: dependencies.workerName
      })
    );
    if (downloads.derivatives) {
      this.lifecycles.push(new DerivationLoop({
        deriver: new MediaDeriver({ pool: this.pool, blobstore, workDir: downloads.workDir, toolPath: downloads.tools.toolPath, logger }),
        pollIntervalMs: downloads.derivatives.pollIntervalMs,
        logger,
        wait: dependencies.wait
      }));
    }
  }

  async start(): Promise<void> {
    await this.scheduler.start();
    for (const part of this.lifecycles) await part.start();
  }

  async stop(): Promise<void> {
    for (const part of [...this.lifecycles].reverse()) await part.stop();
    await this.scheduler.stop();
    await this.pool.end();
  }
}
