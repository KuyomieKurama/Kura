import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import {
  AdapterError,
  createRunWorkspace,
  selectSource,
  stageByteStream,
  toPersistableAsset,
  type AdapterCandidate,
  type AssetManifest,
  type QualityPreset,
  type ResolvedAsset,
  type SourcePost,
  type StagedFile
} from '@kura/adapters';
import type { StorageBackend } from '@kura/blobstore';
import {
  LeaseLostError,
  NotFoundError,
  type Clock,
  type JobLease,
  type JobQueue,
  type SubscriptionRepository
} from '@kura/scheduler';
import type { Pool } from 'pg';
import { loadKillSwitches, type AdapterCatalog } from './catalog.js';
import { importStagedFile } from './blob-import.js';
import { classifyFailure, sourceGoneDisposition, type Disposition } from './failure.js';
import type { ImmichHandover } from './handover.js';
import {
  emptyStats,
  type AssetRecord,
  type HistoryRepository,
  type RunStats
} from './history.js';
import type { Logger } from './scheduler-loop.js';

/** More posts than this in one run are left for the next run (and the sync mark does not advance). */
const MAX_POSTS_PER_RUN = 500;
/** Earlier uncertain handovers retried per run. */
const HANDOVER_RETRIES_PER_RUN = 10;
const PAUSED_RETRY_SECONDS = 60;

export interface ExecutorDependencies {
  pool: Pool;
  queue: JobQueue;
  subscriptions: SubscriptionRepository;
  history: HistoryRepository;
  blobstore: StorageBackend;
  catalog: AdapterCatalog;
  handover: ImmichHandover;
  clock: Clock;
  logger: Logger;
  /** Parent directory of the per-post workspaces. */
  workDir: string;
  /** Hard cap for one asset in bytes. */
  maxAssetBytes: number;
  preset?: QualityPreset;
}

/** Why the signal was aborted; the loop sets it as the abort reason. */
export type AbortReason = 'lease_lost' | 'paused' | 'shutdown';

export type ExecutionOutcome =
  | { result: 'stored' }
  | { result: 'problem'; disposition: Disposition; partial: boolean; queue: 'retry_wait' | 'failed' | 'lease_lost' }
  | { result: 'lease_lost' };

/** What stopped a post early: the whole run must stop (login needed, throttled, quota full, aborted). */
class RunStop extends Error {
  constructor(readonly disposition: Disposition) {
    super(disposition.code);
  }
}

interface PostOutcome {
  status: 'skipped' | 'stored' | 'partially_completed' | 'failed';
  discoveryComplete: boolean;
  failure?: Disposition;
}

/**
 * Executes one claimed run (docs/planning/04, sections 3, 4, 6, 7): choose the adapter, validate, probe,
 * discover, resolve the assets, stage each asset, import it into the blob store, record everything in the
 * history and hand the stored file to Immich. It only ever adds data: nothing here deletes a local
 * original, a blob or a history row.
 *
 * Failure rules: a failed discovery never advances the "checked through" mark and so can never look like
 * "no new posts"; a post with a failed asset is partially completed and its finished assets are not
 * downloaded again on the next run; a missing login pauses the subscription instead of retrying forever.
 */
export class JobExecutor {
  private readonly preset: QualityPreset;

  constructor(private readonly deps: ExecutorDependencies) {
    this.preset = deps.preset ?? 'BEST_AVAILABLE';
  }

  async execute(lease: JobLease, signal: AbortSignal): Promise<ExecutionOutcome> {
    const { history, logger } = this.deps;
    const stats = emptyStats();
    let runId: string | undefined;
    try {
      const subscription = await this.deps.subscriptions.getSubscription(lease.userId, lease.subscriptionId);
      const snapshotRef = lease.configSnapshot.sourceRef;
      const sourceUrl = typeof snapshotRef === 'string' ? snapshotRef : subscription.sourceRef;
      runId = await history.startRun({
        userId: lease.userId,
        jobRunId: lease.runId,
        leaseGeneration: lease.leaseGeneration,
        subscriptionId: subscription.id,
        subscriptionName: subscription.name,
        sourceUrl,
        triggerKind: await this.triggerKindOf(lease)
      });
      if (subscription.status === 'paused') throw new RunStop(pausedDisposition());
      if (!sourceUrl) throw new AdapterError('TARGET_INVALID', 'The subscription has no target URL');

      const problem = await this.syncTarget(lease, runId, sourceUrl, stats, signal);
      return await this.conclude(lease, runId, stats, problem);
    } catch (error) {
      if (error instanceof LeaseLostError) return this.leaseLost(lease, runId, stats);
      if (error instanceof NotFoundError) {
        // The subscription is gone (deleting it while leased is refused, so this is rare).
        return this.conclude(lease, runId, stats, {
          disposition: { runState: 'failed', code: 'SUBSCRIPTION_GONE', message: 'Das Abonnement existiert nicht mehr.', retryable: false },
          partial: false
        });
      }
      const disposition = this.dispositionFor(error, signal);
      if (!(error instanceof RunStop) && !signal.aborted) logger.error('run failed', { runId: lease.runId, code: disposition.code });
      this.logUnexpected(lease, disposition, error);
      return this.conclude(lease, runId, stats, { disposition, partial: stats.assetsStored > 0 });
    }
  }

  // --- the work -----------------------------------------------------------------------------

  /** Returns undefined when everything was stored (or already archived), otherwise what went wrong. */
  private async syncTarget(
    lease: JobLease,
    runId: string,
    sourceUrl: string,
    stats: RunStats,
    signal: AbortSignal
  ): Promise<{ disposition: Disposition; partial: boolean } | undefined> {
    const { catalog, history, subscriptions } = this.deps;
    catalog.setKillSwitches(await loadKillSwitches(this.deps.pool));

    const candidate = await this.chooseAdapter(lease, sourceUrl);
    const { adapter, target } = candidate;
    const { adapterId, adapterVersion } = adapter.capabilities();
    await history.updateRun(runId, { platform: target.sourceType, adapterId, adapterVersion });
    await subscriptions.setTargetState(lease.userId, lease.subscriptionId, 'valid', sourceUrl);
    const jobContext = { jobId: lease.runId, leaseGeneration: lease.leaseGeneration, signal };

    const summary = await adapter.probe({ ...jobContext, target });
    if (!summary.available) throw new RunStop(sourceGoneDisposition);

    await history.updateRun(runId, { state: 'discovering', stats });
    const posts: SourcePost[] = [];
    let truncated = false;
    for await (const post of adapter.discover({ ...jobContext, target })) {
      if (posts.length >= MAX_POSTS_PER_RUN) {
        truncated = true;
        break;
      }
      posts.push(post);
    }
    if (posts.length === 0 && target.kind === 'post') {
      // A single post that cannot be listed is a failure, not "nothing new".
      throw new RunStop({ runState: 'retry_wait', code: 'SOURCE_EMPTY', message: 'Die Quelle hat keinen Beitrag geliefert. Der Lauf wird wiederholt.', retryable: true });
    }

    const outcomes: PostOutcome[] = [];
    let firstFailure: Disposition | undefined;
    for (const post of posts) {
      this.throwIfAborted(signal);
      let outcome: PostOutcome;
      try {
        outcome = await this.processPost({ lease, runId, candidate, post, stats, signal });
      } catch (error) {
        if (error instanceof LeaseLostError || error instanceof RunStop) throw error;
        if (signal.aborted) throw error;
        const failure = classifyFailure(error);
        this.logUnexpected(lease, failure, error);
        outcome = { status: 'failed', discoveryComplete: false, failure };
      }
      outcomes.push(outcome);
      firstFailure ??= outcome.failure;
      await history.updateRun(runId, { stats });
    }

    const last = posts.at(-1);
    const enumerationComplete = !truncated && outcomes.every((outcome) => outcome.discoveryComplete);
    await history.saveSyncState({
      subscriptionId: lease.subscriptionId,
      userId: lease.userId,
      targetHash: createHash('sha256').update(target.canonicalUrl).digest('hex'),
      lastSeenPostId: last?.platformPostId ?? null,
      lastSeenRevisionKey: last?.revisionKey ?? null,
      enumerationComplete
    });

    await this.retryEarlierHandovers(lease.userId);
    if (firstFailure) return { disposition: firstFailure, partial: stats.assetsStored > 0 || outcomes.some((o) => o.status === 'partially_completed') };
    return undefined;
  }

  /** The first adapter that can run the URL; a missing tool is reported as such, not as "unsupported". */
  private async chooseAdapter(lease: JobLease, sourceUrl: string): Promise<AdapterCandidate> {
    const { catalog, subscriptions } = this.deps;
    try {
      return selectSource(catalog.registry, sourceUrl);
    } catch (error) {
      if (!(error instanceof AdapterError)) throw error;
      if (error.code === 'TARGET_UNSUPPORTED') {
        const wanted = this.recognizedButNotRunnable(sourceUrl);
        if (wanted) {
          // The address is fine; this server just cannot run the tool for it.
          await subscriptions.setTargetState(lease.userId, lease.subscriptionId, 'valid', sourceUrl);
          throw new AdapterError('BINARY_NOT_CONFIGURED', `${wanted} is not available on this server`);
        }
      }
      if (error.code === 'TARGET_UNSUPPORTED' || error.code === 'TARGET_INVALID' || error.code === 'TARGET_BROKEN') {
        await subscriptions.setTargetState(lease.userId, lease.subscriptionId, 'invalid', sourceUrl);
      }
      throw error;
    }
  }

  private recognizedButNotRunnable(sourceUrl: string): string | undefined {
    try {
      const { adapter } = selectSource(this.deps.catalog.recognizer, sourceUrl);
      const { adapterId, adapterVersion } = adapter.capabilities();
      return adapterVersion === 'not-installed' ? adapterId : undefined;
    } catch {
      return undefined;
    }
  }

  private async processPost(input: {
    lease: JobLease;
    runId: string;
    candidate: AdapterCandidate;
    post: SourcePost;
    stats: RunStats;
    signal: AbortSignal;
  }): Promise<PostOutcome> {
    const { lease, runId, candidate, post, stats, signal } = input;
    const { history, catalog } = this.deps;
    const { adapter } = candidate;
    const { adapterId, adapterVersion } = adapter.capabilities();

    const saved = await history.upsertPost({
      userId: lease.userId,
      runId,
      subscriptionId: lease.subscriptionId,
      platform: post.sourceType,
      adapterId,
      adapterVersion,
      creatorPlatformId: post.creator.platformId,
      creatorName: post.creator.displayName,
      platformPostId: post.platformPostId,
      revisionKey: post.revisionKey,
      title: post.title,
      sourceUrl: post.canonicalUrl,
      publishedAt: post.publishedAt
    });
    stats.postsFound += 1;
    if (saved.state === 'stored') {
      // Unchanged and archived: skipped, also if the local copy has meanwhile gone to Immich.
      stats.postsSkipped += 1;
      return { status: 'skipped', discoveryComplete: true };
    }

    catalog.registry.assertEnabled(adapter, post.sourceType);
    const manifest = await adapter.resolveAssets(post, { preset: this.preset });
    const records = await history.upsertAssets(saved.id, lease.userId, manifest.assets.map(toPersistableAsset));
    await history.setPostState(saved.id, 'downloading', manifest.discoveryComplete);

    const workspace = await createRunWorkspace(this.deps.workDir);
    let failure: Disposition | undefined;
    try {
      for (const asset of manifest.assets) {
        const record = records.find((candidateRecord) => candidateRecord.sourceAssetId === asset.sourceAssetId);
        if (!record || record.state === 'stored') continue; // finished assets are never downloaded again
        this.throwIfAborted(signal);
        try {
          await this.storeAsset({ lease, runId, adapter: candidate, post, asset, record, workspace, stats, signal });
        } catch (error) {
          if (error instanceof LeaseLostError || signal.aborted) throw error;
          const disposition = classifyFailure(error);
          await history.markAssetFailed(record.id, disposition.code, disposition.message);
          stats.assetsFailed += 1;
          failure ??= disposition;
          // Login, throttling and a full quota affect every further asset: stop here.
          if (disposition.runState === 'waiting_auth' || disposition.runState === 'waiting_rate_limit' || disposition.runState === 'paused') {
            await this.finishPost(saved.id, manifest);
            throw new RunStop(disposition);
          }
        }
      }
    } finally {
      await workspace.dispose();
    }

    const status = await this.finishPost(saved.id, manifest);
    return { status, discoveryComplete: manifest.discoveryComplete && manifest.errors.length === 0, failure };
  }

  /** Derives the post state from the per-asset states in the database, not from this run's memory. */
  private async finishPost(postId: string, manifest: AssetManifest): Promise<'stored' | 'partially_completed' | 'failed'> {
    const assets = await this.deps.history.assetsOfPost(postId);
    const stored = assets.filter((asset) => asset.state === 'stored').length;
    const complete = assets.length > 0
      && stored === assets.length
      && stored === manifest.assets.length
      && manifest.discoveryComplete
      && manifest.errors.length === 0;
    const state = complete ? 'stored' : stored > 0 ? 'partially_completed' : 'failed';
    await this.deps.history.setPostState(postId, state, manifest.discoveryComplete);
    return state;
  }

  private async storeAsset(input: {
    lease: JobLease;
    runId: string;
    adapter: AdapterCandidate;
    post: SourcePost;
    asset: ResolvedAsset;
    record: AssetRecord;
    workspace: Awaited<ReturnType<typeof createRunWorkspace>>;
    stats: RunStats;
    signal: AbortSignal;
  }): Promise<void> {
    const { lease, runId, post, asset, record, workspace, stats, signal } = input;
    const { adapter } = input.adapter;
    const { history, blobstore } = this.deps;
    const context = {
      jobId: lease.runId,
      leaseGeneration: lease.leaseGeneration,
      signal,
      post,
      policy: { preset: this.preset },
      limits: { maxBytes: this.deps.maxAssetBytes }
    };

    await history.startAsset(record.id);
    await history.updateRun(runId, { state: 'downloading', stats });
    const staged: StagedFile = adapter.stage
      ? await adapter.stage(asset, { ...context, workspace })
      : await stageByteStream(adapter.download(asset, context), workspace, asset.assetIndex, asset.mediaType, this.deps.maxAssetBytes);

    await history.markAssetVerifying(record.id);
    await history.updateRun(runId, { state: 'verifying' });
    const imported = await importStagedFile({ blobstore, ownerUserId: lease.userId, staged, signal });
    await rm(staged.absolutePath, { force: true });

    await history.markAssetStored(record.id, {
      sha256: imported.sha256,
      sha1: imported.sha1,
      byteSize: imported.byteSize,
      blobObjectId: imported.objectId
    });
    stats.assetsStored += 1;
    stats.bytesStored += imported.byteSize;
    await history.updateRun(runId, { state: 'downloading', stats });

    await this.handOver(record.id, {
      userId: lease.userId,
      objectId: imported.objectId,
      sha256: imported.sha256,
      sha1: imported.sha1,
      byteLength: imported.byteSize,
      fileName: asset.originalName,
      createdAt: post.publishedAt ? new Date(post.publishedAt) : this.deps.clock.now(),
      modifiedAt: this.deps.clock.now()
    });
  }

  /** The stored file stays in Kura whatever happens here. A failure only changes the recorded handover state. */
  private async handOver(assetId: string, input: Parameters<ImmichHandover['handOver']>[0]): Promise<void> {
    try {
      const result = await this.deps.handover.handOver(input);
      await this.deps.history.setHandover(assetId, result.state, result.transferId);
    } catch (error) {
      this.deps.logger.error('immich handover failed', { assetId, error: error instanceof Error ? error.name : 'unknown' });
      await this.deps.history.setHandover(assetId, 'error').catch(() => undefined);
    }
  }

  private async retryEarlierHandovers(userId: string): Promise<void> {
    try {
      const candidates = await this.deps.history.assetsNeedingHandoverRetry(userId, HANDOVER_RETRIES_PER_RUN);
      for (const asset of candidates) {
        if (!asset.blobObjectId || !asset.sha256 || !asset.sha1 || asset.byteSize === null) continue;
        await this.handOver(asset.id, {
          userId,
          objectId: asset.blobObjectId,
          sha256: asset.sha256,
          sha1: asset.sha1,
          byteLength: asset.byteSize,
          fileName: asset.originalName,
          createdAt: asset.createdAt,
          modifiedAt: asset.modifiedAt
        });
      }
    } catch (error) {
      this.deps.logger.error('handover retry failed', { error: error instanceof Error ? error.name : 'unknown' });
    }
  }

  // --- ending a run -------------------------------------------------------------------------

  private async conclude(
    lease: JobLease,
    runId: string | undefined,
    stats: RunStats,
    problem: { disposition: Disposition; partial: boolean } | undefined
  ): Promise<ExecutionOutcome> {
    const { history, queue, subscriptions, logger } = this.deps;
    try {
      if (!problem) {
        if (runId) await history.updateRun(runId, { state: 'stored', stats, errorCode: null, errorMessage: null, finished: true });
        await queue.complete(lease);
        return { result: 'stored' };
      }

      const { disposition } = problem;
      // "Partially completed" describes a post with failed assets; the more urgent waiting states stay visible.
      const state = problem.partial && (disposition.runState === 'failed' || disposition.runState === 'retry_wait')
        ? 'partially_completed'
        : disposition.runState;
      if (runId) {
        await history.updateRun(runId, { state, stats, errorCode: disposition.code, errorMessage: disposition.message, finished: true });
      }
      if (disposition.pauseSubscription) {
        await subscriptions.pauseSubscription(lease.userId, lease.subscriptionId).catch(() => undefined);
      }
      const failed = await queue.fail(lease, {
        error: `${disposition.code}: ${disposition.message}`,
        retryable: disposition.retryable,
        retryAfterSeconds: disposition.retryAfterSeconds
      });
      return { result: 'problem', disposition, partial: problem.partial, queue: failed.state };
    } catch (error) {
      if (error instanceof LeaseLostError) return this.leaseLost(lease, runId, stats);
      logger.error('could not record the end of a run', { runId: lease.runId, error: error instanceof Error ? error.name : 'unknown' });
      throw error;
    }
  }

  /** Another worker owns the run now. This attempt only records that it ended without a result. */
  private async leaseLost(lease: JobLease, runId: string | undefined, stats: RunStats): Promise<ExecutionOutcome> {
    this.deps.logger.info('lease lost', { runId: lease.runId });
    if (runId) {
      await this.deps.history.updateRun(runId, {
        state: 'retry_wait', stats, errorCode: 'LEASE_LOST',
        errorMessage: 'Der Lauf wurde von einem anderen Worker übernommen.', finished: true
      }).catch(() => undefined);
    }
    return { result: 'lease_lost' };
  }

  private dispositionFor(error: unknown, signal: AbortSignal): Disposition {
    if (error instanceof RunStop) return error.disposition;
    if (signal.aborted) {
      const reason = signal.reason as AbortReason | undefined;
      if (reason === 'paused') return pausedDisposition();
      if (reason === 'lease_lost') return { runState: 'retry_wait', code: 'LEASE_LOST', message: 'Der Lauf wurde von einem anderen Worker übernommen.', retryable: true };
      return { runState: 'retry_wait', code: 'SHUTDOWN', message: 'Der Worker wurde beendet. Der Lauf wird wiederholt.', retryable: true };
    }
    return classifyFailure(error);
  }

  /** An error Kura did not anticipate is logged with its name and message (no stack, no history text). */
  private logUnexpected(lease: JobLease, disposition: Disposition, error: unknown): void {
    if (disposition.code !== 'UNEXPECTED') return;
    this.deps.logger.error('unexpected error in run', {
      runId: lease.runId,
      error: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'
    });
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new AdapterError('PROCESS_ABORTED', 'The run was aborted');
  }

  private async triggerKindOf(lease: JobLease): Promise<'schedule' | 'manual'> {
    const result = await this.deps.pool.query<{ trigger_kind: 'schedule' | 'manual' }>(
      'SELECT trigger_kind FROM job_runs WHERE id = $1 AND user_id = $2',
      [lease.runId, lease.userId]
    );
    return result.rows[0]?.trigger_kind ?? 'schedule';
  }
}

function pausedDisposition(): Disposition {
  return {
    runState: 'paused',
    code: 'SUBSCRIPTION_PAUSED',
    message: 'Das Abonnement ist pausiert. Der Lauf wird nach dem Fortsetzen wiederholt.',
    retryable: true,
    retryAfterSeconds: PAUSED_RETRY_SECONDS
  };
}
