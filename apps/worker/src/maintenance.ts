import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseBlobStore } from '@kura/blobstore';
import type { WorkerLifecycle } from '@kura/contracts';
import type { Clock } from '@kura/scheduler';
import { systemClock } from '@kura/scheduler';
import type { Pool } from 'pg';
import { loadKillSwitches, type AdapterCatalog } from './catalog.js';
import { HistoryRepository } from './history.js';
import { realWait, type Logger, type Wait } from './scheduler-loop.js';

/** Workspaces of a run that died are left behind; a live run is far younger than this. */
const STALE_WORKSPACE_AGE_MS = 24 * 60 * 60 * 1000;
const WORKSPACE_NAME = /^run-[0-9a-f]{24}$/;

/**
 * Removes abandoned adapter workspaces below `workDir`: only directories that carry the workspace name
 * pattern and have not been touched for `olderThanMs`. Returns how many were removed. This deletes
 * temporary staging data only, never stored media.
 */
export async function removeStaleWorkspaces(workDir: string, olderThanMs: number, clock: Clock = systemClock): Promise<number> {
  let names: string[];
  try {
    names = await readdir(workDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    if (!WORKSPACE_NAME.test(name)) continue;
    const path = join(workDir, name);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isDirectory()) continue;
    if (clock.now().getTime() - info.mtimeMs < olderThanMs) continue;
    await rm(path, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

export interface MaintenanceOptions {
  pool: Pool;
  catalog: AdapterCatalog;
  blobstore: DatabaseBlobStore;
  workDir: string;
  recheckMs: number;
  logger: Logger;
  clock?: Clock;
  wait?: Wait;
}

/**
 * Keeps the download side healthy: checks the external tools again (and publishes the result for the API),
 * clears expired half-written blobs and abandoned staging directories. Starting it checks the tools once,
 * so the first claimed run already sees the real adapter set.
 */
export class DownloadMaintenance implements WorkerLifecycle {
  private readonly wait: Wait;
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly options: MaintenanceOptions) {
    this.wait = options.wait ?? realWait;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.refreshAdapters();
    await this.closeInterruptedRuns();
    const controller = new AbortController();
    this.controller = controller;
    this.running = this.loop(controller.signal);
  }

  async stop(): Promise<void> {
    if (!this.running || !this.controller) return;
    this.controller.abort();
    await this.running;
    this.running = null;
    this.controller = null;
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.wait(this.options.recheckMs, signal);
      if (signal.aborted) break;
      await this.refreshAdapters();
      await this.cleanUp();
    }
  }

  async refreshAdapters(): Promise<void> {
    try {
      this.options.catalog.setKillSwitches(await loadKillSwitches(this.options.pool));
      await this.options.catalog.refresh();
      await this.options.catalog.publish(this.options.pool);
    } catch (error) {
      this.options.logger.error('adapter check failed', { error: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error' });
    }
  }

  /** History rows of attempts whose worker died stay open otherwise; see HistoryRepository.closeOrphanedRuns. */
  async closeInterruptedRuns(): Promise<void> {
    try {
      const closed = await new HistoryRepository(this.options.pool, this.options.clock).closeOrphanedRuns();
      if (closed > 0) this.options.logger.info('closed runs of interrupted workers', { runs: closed });
    } catch (error) {
      this.options.logger.error('closing interrupted runs failed', { error: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error' });
    }
  }

  async cleanUp(): Promise<void> {
    await this.closeInterruptedRuns();
    try {
      const writes = await this.options.blobstore.cleanupStaging();
      const workspaces = await removeStaleWorkspaces(this.options.workDir, STALE_WORKSPACE_AGE_MS, this.options.clock);
      if (writes + workspaces > 0) this.options.logger.info('cleaned up staging', { expiredBlobWrites: writes, staleWorkspaces: workspaces });
    } catch (error) {
      this.options.logger.error('staging cleanup failed', { error: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error' });
    }
  }
}
