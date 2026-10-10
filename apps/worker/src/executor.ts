import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import {
  AdapterError,
  createRunWorkspace,
  isContentStableAssetId,
  isCredentialPlatform,
  isLegacyRevisionKey,
  selectSource,
  stageByteStream,
  toPersistableAsset,
  type AdapterCandidate,
  type CredentialPlatform,
  type AssetManifest,
  type QualityPreset,
  type ResolvedAsset,
  type RunCredentials,
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
import { EGRESS_NOT_CONFIRMED, loadKillSwitches, type AdapterCatalog } from './catalog.js';
import { checkedDigestOfStagedFile, importStagedFile, type ImportedBlob } from './blob-import.js';
import {
  CREDENTIAL_MESSAGES,
  isSpecificAuthMessage,
  PlatformCredentials,
  writeRunCredentials
} from './credentials.js';
import { classifyFailure, sourceGoneDisposition, stopsWholeRun, type Disposition } from './failure.js';
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
/** Posts of a feed that are not completely archived and lie behind the part of the feed this run read, looked at again per run. */
const OPEN_POSTS_RETRIED_PER_RUN = 10;
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
  /** KURA_SECRET_KEY, to decrypt stored platform cookies. Without it stored cookies are unreadable. */
  secretKey?: Buffer;
}

/** Why the signal was aborted; the loop sets it as the abort reason. */
export type AbortReason = 'lease_lost' | 'paused' | 'shutdown';

export type ExecutionOutcome =
  | { result: 'stored' }
  | { result: 'problem'; disposition: Disposition; partial: boolean; queue: 'retry_wait' | 'failed' | 'lease_lost' }
  | { result: 'lease_lost' };

/** What a run did with the owner's stored platform credentials; read when the run ends. */
interface RunAccess {
  /** The platform of the target if it can have a stored login (Instagram, Patreon, Pixiv, YouTube), else undefined. */
  platform: CredentialPlatform | undefined;
  /** The stored login was decrypted and handed to the tool for this run. */
  used: boolean;
}

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
  private readonly credentials: PlatformCredentials;

  constructor(private readonly deps: ExecutorDependencies) {
    this.preset = deps.preset ?? 'BEST_AVAILABLE';
    this.credentials = new PlatformCredentials(deps.pool, deps.clock, deps.secretKey);
  }

  async execute(lease: JobLease, signal: AbortSignal): Promise<ExecutionOutcome> {
    const { history, logger } = this.deps;
    const stats = emptyStats();
    const access: RunAccess = { platform: undefined, used: false };
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

      const problem = await this.syncTarget(lease, runId, sourceUrl, stats, signal, access);
      return await this.conclude(lease, runId, stats, problem, access);
    } catch (error) {
      if (error instanceof LeaseLostError) return this.leaseLost(lease, runId, stats);
      if (error instanceof NotFoundError) {
        // The subscription is gone (deleting it while leased is refused, so this is rare).
        return this.conclude(lease, runId, stats, {
          disposition: { runState: 'failed', code: 'SUBSCRIPTION_GONE', message: 'Das Abonnement existiert nicht mehr.', retryable: false },
          partial: false
        }, access);
      }
      const disposition = this.dispositionFor(error, signal);
      if (!(error instanceof RunStop) && !signal.aborted) logger.error('run failed', { runId: lease.runId, code: disposition.code });
      this.logUnexpected(lease, disposition, error);
      return this.conclude(lease, runId, stats, { disposition, partial: stats.assetsStored > 0 }, access);
    }
  }

  // --- the work -----------------------------------------------------------------------------

  /** Returns undefined when everything was stored (or already archived), otherwise what went wrong. */
  private async syncTarget(
    lease: JobLease,
    runId: string,
    sourceUrl: string,
    stats: RunStats,
    signal: AbortSignal,
    access: RunAccess
  ): Promise<{ disposition: Disposition; partial: boolean } | undefined> {
    const { catalog, history, subscriptions } = this.deps;
    catalog.setKillSwitches(await loadKillSwitches(this.deps.pool));

    const candidate = await this.chooseAdapter(lease, sourceUrl);
    const { adapter, target } = candidate;
    const { adapterId, adapterVersion } = adapter.capabilities();
    await history.updateRun(runId, { platform: target.sourceType, adapterId, adapterVersion });
    await subscriptions.setTargetState(lease.userId, lease.subscriptionId, 'valid', sourceUrl);

    // The credentials file exists only while this run needs it: it is removed in the finally block, together with
    // the private directory it lives in.
    const credentials = await this.provideCredentials(lease, candidate, access);
    try {
      return await this.syncWithCredentials({ lease, runId, candidate, stats, signal, credentials: credentials.value });
    } finally {
      await credentials.dispose();
    }
  }

  private async syncWithCredentials(input: {
    lease: JobLease;
    runId: string;
    candidate: AdapterCandidate;
    stats: RunStats;
    signal: AbortSignal;
    credentials?: RunCredentials;
  }): Promise<{ disposition: Disposition; partial: boolean } | undefined> {
    const { lease, runId, candidate, stats, signal, credentials } = input;
    const { history } = this.deps;
    const { adapter, target } = candidate;
    const jobContext = { jobId: lease.runId, leaseGeneration: lease.leaseGeneration, signal, ...(credentials ? { credentials } : {}) };

    const summary = await adapter.probe({ ...jobContext, target });
    if (!summary.available) throw new RunStop(sourceGoneDisposition);

    await history.updateRun(runId, { state: 'discovering', stats });
    const posts: SourcePost[] = [];
    let truncated = false;
    // A profile listing can stop half way (login wall, throttling). What was listed before is still worth
    // archiving, but the run must end with that error and the "checked through" mark must not advance.
    let discoveryStop: Disposition | undefined;
    const knownPostIds = await this.knownPostsOfFeed(lease, runId, candidate);
    try {
      for await (const post of adapter.discover({ ...jobContext, target, ...(knownPostIds ? { knownPostIds } : {}) })) {
        if (posts.length >= MAX_POSTS_PER_RUN) {
          truncated = true;
          break;
        }
        posts.push(post);
      }
    } catch (error) {
      if (error instanceof LeaseLostError || signal.aborted) throw error;
      const failure = classifyFailure(error);
      if (posts.length === 0 || !stopsWholeRun(failure)) throw error;
      discoveryStop = failure;
    }
    if (posts.length === 0 && target.kind === 'post') {
      // A single post that cannot be listed is a failure, not "nothing new".
      throw new RunStop({ runState: 'retry_wait', code: 'SOURCE_EMPTY', message: 'Die Quelle hat keinen Beitrag geliefert. Der Lauf wird wiederholt.', retryable: true });
    }

    // A feed that was read only as far as the archived posts still owes the posts behind that point which failed earlier.
    const reread = discoveryStop ? [] : await this.rediscoverOpenPosts({ lease, candidate, jobContext, listed: posts });
    const outcomes: PostOutcome[] = [];
    let firstFailure: Disposition | undefined;
    for (const post of [...posts, ...reread]) {
      this.throwIfAborted(signal);
      let outcome: PostOutcome;
      try {
        outcome = await this.processPost({ lease, runId, candidate, post, stats, signal, credentials });
      } catch (error) {
        if (error instanceof LeaseLostError || error instanceof RunStop) throw error;
        if (signal.aborted) throw error;
        const failure = classifyFailure(error);
        this.logUnexpected(lease, failure, error);
        // Resolving a post can hit the login wall or the rate limit just like a download; the next post would too.
        if (stopsWholeRun(failure)) throw new RunStop(failure);
        outcome = { status: 'failed', discoveryComplete: false, failure };
      }
      outcomes.push(outcome);
      firstFailure ??= outcome.failure;
      await history.updateRun(runId, { stats });
    }

    if (discoveryStop) throw new RunStop(discoveryStop);

    const last = posts.at(-1);
    const enumerationComplete = !truncated && outcomes.every((outcome) => outcome.discoveryComplete);
    await history.saveSyncState({
      subscriptionId: lease.subscriptionId,
      userId: lease.userId,
      targetHash: targetHashOf(target.canonicalUrl),
      lastSeenPostId: last?.platformPostId ?? null,
      lastSeenRevisionKey: last?.revisionKey ?? null,
      enumerationComplete
    });

    await this.retryEarlierHandovers(lease.userId);
    if (firstFailure) return { disposition: firstFailure, partial: stats.assetsStored > 0 || outcomes.some((o) => o.status === 'partially_completed') };
    return undefined;
  }

  /**
   * The posts of a feed that a listing may stop at (the stop rule of endOfNewPosts), or undefined when the feed has
   * to be read in full. Stopping at archived posts is only right if everything behind them was archived by an
   * earlier run, so it needs all of this: the sync state belongs to this target, the feed was once read to its
   * end ("checked through"), and the run before this one ended without a problem. After a crashed or failed run
   * the posts that were stored are a part of the feed, not its tail, and the next run reads the whole range again.
   */
  private async knownPostsOfFeed(lease: JobLease, runId: string, candidate: AdapterCandidate): Promise<ReadonlySet<string> | undefined> {
    const { history } = this.deps;
    const { target } = candidate;
    if (target.kind !== 'creator_feed') return undefined;
    const state = await history.getSyncState(lease.subscriptionId, lease.userId);
    if (!state || state.checkedThrough === null || state.targetHash !== targetHashOf(target.canonicalUrl)) return undefined;
    if ((await history.lastFinishedRunState(lease.userId, lease.subscriptionId, runId)) !== 'stored') return undefined;
    const known = await history.settledPostIds(lease.userId, target.sourceType);
    return known.size > 0 ? known : undefined;
  }

  /**
   * Posts of this subscription that are not completely archived (a download failed, an asset is pending) and that the
   * feed listing of this run did not reach because it stopped at the archived posts. Each is read again as a single
   * post, so a partially failed post is retried and a completed one is not. A post that cannot be read now is left
   * for the next run; it already has its own record of what went wrong.
   */
  private async rediscoverOpenPosts(input: {
    lease: JobLease;
    candidate: AdapterCandidate;
    jobContext: { jobId: string; leaseGeneration: number; signal: AbortSignal; credentials?: RunCredentials };
    listed: readonly SourcePost[];
  }): Promise<SourcePost[]> {
    const { lease, candidate, jobContext, listed } = input;
    const { adapter, target } = candidate;
    if (target.kind !== 'creator_feed') return [];
    const alreadyListed = new Set(listed.map((post) => post.platformPostId));
    const open = (await this.deps.history.openPosts(lease.userId, lease.subscriptionId, target.sourceType, OPEN_POSTS_RETRIED_PER_RUN * 4))
      .filter((post) => !alreadyListed.has(post.platformPostId))
      .slice(0, OPEN_POSTS_RETRIED_PER_RUN);

    const posts: SourcePost[] = [];
    for (const entry of open) {
      this.throwIfAborted(jobContext.signal);
      try {
        const single = adapter.validateTarget(entry.sourceUrl);
        if (single.kind !== 'post' || single.platformId !== entry.platformPostId) continue;
        for await (const post of adapter.discover({ ...jobContext, target: single })) posts.push(post);
      } catch (error) {
        if (error instanceof LeaseLostError || jobContext.signal.aborted) throw error;
        const failure = classifyFailure(error);
        if (stopsWholeRun(failure)) throw new RunStop(failure);
        this.logUnexpected(lease, failure, error);
      }
    }
    return posts;
  }

  /**
   * Targets of a platform with stored logins get the owner's login as a file in a private directory of its own:
   * cookies for Instagram, Patreon and YouTube, a gallery-dl configuration with the token for Pixiv. Other targets
   * get nothing. The returned dispose() removes the file and the directory and never throws.
   */
  private async provideCredentials(
    lease: JobLease,
    candidate: AdapterCandidate,
    access: RunAccess
  ): Promise<{ value?: RunCredentials; dispose: () => Promise<void> }> {
    const nothing = { dispose: async () => undefined };
    const platform = candidate.target.sourceType;
    if (!isCredentialPlatform(platform)) return nothing;
    access.platform = platform;

    const stored = await this.credentials.load(lease.userId, platform);
    if (stored.status === 'none') return nothing;
    if (stored.status === 'unreadable') throw new RunStop(unreadableCredentialsDisposition(platform));

    const directory = await createRunWorkspace(this.deps.workDir);
    const dispose = async () => {
      await directory.dispose().catch(() => this.deps.logger.error('could not remove the private credentials directory', { runId: lease.runId }));
    };
    try {
      const value = await writeRunCredentials(platform, directory.rootDir, stored.secret);
      access.used = true;
      await this.credentials.recordUse(lease.userId, platform);
      return { value, dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  }

  /**
   * Records how a stored login fared and words the login problem for the user: with a stored login it is expired,
   * without one it is missing. The adapter's precise sentences (private profile, security check) are kept; the code
   * and the retry rules stay as classified.
   */
  private async settleCredentialAccess(
    lease: JobLease,
    access: RunAccess,
    problem: { disposition: Disposition; partial: boolean } | undefined
  ): Promise<{ disposition: Disposition; partial: boolean } | undefined> {
    const { platform } = access;
    if (!platform) return problem;
    try {
      if (!problem) {
        if (access.used) await this.credentials.recordResult(lease.userId, platform, 'ok');
        return problem;
      }
      const { disposition } = problem;
      if (disposition.code === 'CREDENTIALS_UNREADABLE') {
        await this.credentials.recordResult(lease.userId, platform, 'auth_required');
      } else if (disposition.code === 'AUTH_REQUIRED') {
        if (access.used) await this.credentials.recordResult(lease.userId, platform, 'auth_required');
        if (isSpecificAuthMessage(disposition.message)) return problem;
        const messages = CREDENTIAL_MESSAGES[platform];
        return { ...problem, disposition: { ...disposition, message: access.used ? messages.expired : messages.missing } };
      }
    } catch (error) {
      this.deps.logger.error('could not record the result of the stored login', { runId: lease.runId, error: error instanceof Error ? error.name : 'unknown' });
    }
    return problem;
  }

  /** The first adapter that can run the URL; a missing tool is reported as such, not as "unsupported". */
  private async chooseAdapter(lease: JobLease, sourceUrl: string): Promise<AdapterCandidate> {
    const { catalog, subscriptions } = this.deps;
    try {
      return selectSource(catalog.registry, sourceUrl);
    } catch (error) {
      if (!(error instanceof AdapterError)) throw error;
      // TARGET_BROKEN: yt-dlp refuses an Instagram profile; the real answer may be that gallery-dl is not installed.
      if (error.code === 'TARGET_UNSUPPORTED' || error.code === 'TARGET_BROKEN') {
        const wanted = this.recognizedButNotRunnable(sourceUrl);
        if (wanted) {
          // The address is fine; this server just cannot run the tool for it.
          await subscriptions.setTargetState(lease.userId, lease.subscriptionId, 'valid', sourceUrl);
          // A tool that is blocked by the missing egress confirmation says so, instead of "not installed".
          const blocked = catalog.availability.some((entry) => entry.adapterId === wanted && entry.reasonCode === EGRESS_NOT_CONFIRMED);
          if (blocked) throw new AdapterError(EGRESS_NOT_CONFIRMED, `${wanted} is blocked: no external egress barrier was confirmed`);
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
    credentials?: RunCredentials;
  }): Promise<PostOutcome> {
    const { lease, runId, candidate, post, stats, signal, credentials } = input;
    const { history, catalog } = this.deps;
    const { adapter } = candidate;
    const { adapterId, adapterVersion } = adapter.capabilities();

    // Unchanged and archived: skipped, also if the local copy has meanwhile gone to Immich, and without asking the
    // platform for anything. A post archived before the revision key was derived from stable ids only (old format)
    // counts as unchanged: its old key says nothing about the content and cannot be compared with the new one.
    if (await this.isArchivedUnchanged(lease.userId, post)) {
      stats.postsFound += 1;
      stats.postsSkipped += 1;
      return { status: 'skipped', discoveryComplete: true };
    }

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
      // Stored between the check above and now (another run of the same user): nothing to do.
      stats.postsSkipped += 1;
      return { status: 'skipped', discoveryComplete: true };
    }

    catalog.registry.assertEnabled(adapter, post.sourceType);
    const manifest = await adapter.resolveAssets(post, { preset: this.preset }, { signal, ...(credentials ? { credentials } : {}) });
    const records = await history.upsertAssets(saved.id, lease.userId, manifest.assets.map(toPersistableAsset));
    await history.setPostState(saved.id, 'downloading', manifest.discoveryComplete);

    const workspace = await createRunWorkspace(this.deps.workDir);
    let failure: Disposition | undefined;
    try {
      for (const asset of manifest.assets) {
        const record = records.find((candidateRecord) => candidateRecord.sourceAssetId === asset.sourceAssetId);
        if (!record || record.state === 'stored') continue; // finished assets are never downloaded again
        this.throwIfAborted(signal);
        if (asset.unavailable) {
          // Known to be impossible to fetch (embedded video of another site, locked post, file type). It is recorded
          // as failed with its reason, once as a problem of the run; later runs repeat nothing and only keep the record.
          await history.markAssetFailed(record.id, asset.unavailable.code, asset.unavailable.message);
          // Something that is expected to appear later (a running livestream, a premiere) is recorded for the entry
          // but is no failure of the run; the post is looked at again on the next run.
          if (asset.unavailable.code !== 'ASSET_NOT_YET_AVAILABLE' && record.errorCode !== asset.unavailable.code) {
            stats.assetsFailed += 1;
            failure ??= { runState: 'failed', code: asset.unavailable.code, message: asset.unavailable.message, retryable: false };
          }
          continue;
        }
        try {
          if (await this.referenceStoredFileOfSameAsset(lease.userId, post, asset, record)) continue;
          await this.storeAsset({ lease, runId, adapter: candidate, post, asset, record, workspace, stats, signal, credentials });
        } catch (error) {
          if (error instanceof LeaseLostError || signal.aborted) throw error;
          const disposition = classifyFailure(error);
          await history.markAssetFailed(record.id, disposition.code, disposition.message);
          stats.assetsFailed += 1;
          failure ??= disposition;
          // Login, throttling and a full quota affect every further asset: stop here.
          if (stopsWholeRun(disposition)) {
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

  private async isArchivedUnchanged(userId: string, post: SourcePost): Promise<boolean> {
    const revisions = await this.deps.history.revisionsOf(userId, post.sourceType, post.platformPostId);
    const same = revisions.find((revision) => revision.revisionKey === post.revisionKey);
    if (same) return same.settled;
    return !isLegacyRevisionKey(post.revisionKey)
      && revisions.some((revision) => revision.settled && isLegacyRevisionKey(revision.revisionKey));
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

  /**
   * Asset-level safety net, before anything is fetched: when another revision of this post already holds a stored
   * file under the same asset id, and that id says which content it is (a media id, a file hash, a Pixiv page), this
   * asset points at that stored file. A new revision that only adds a file therefore downloads only that file.
   */
  private async referenceStoredFileOfSameAsset(userId: string, post: SourcePost, asset: ResolvedAsset, record: AssetRecord): Promise<boolean> {
    if (!isContentStableAssetId(post.sourceType, asset.sourceAssetId)) return false;
    const { history } = this.deps;
    const twin = await history.findStoredByAssetId(userId, post.sourceType, post.platformPostId, asset.sourceAssetId, record.id);
    if (!twin) return false;
    await history.referenceStoredAsset(record.id, userId, twin);
    return true;
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
    credentials?: RunCredentials;
  }): Promise<void> {
    const { lease, runId, post, asset, record, workspace, stats, signal, credentials } = input;
    const { adapter } = input.adapter;
    const { history, blobstore } = this.deps;
    const context = {
      jobId: lease.runId,
      leaseGeneration: lease.leaseGeneration,
      signal,
      post,
      policy: { preset: this.preset },
      limits: { maxBytes: this.deps.maxAssetBytes },
      ...(credentials ? { credentials } : {})
    };

    await history.startAsset(record.id);
    await history.updateRun(runId, { state: 'downloading', stats });
    const staged: StagedFile = adapter.stage
      ? await adapter.stage(asset, { ...context, workspace })
      : await stageByteStream(adapter.download(asset, context), workspace, asset.assetIndex, asset.mediaType, this.deps.maxAssetBytes);

    // The same bytes are already stored for this subscription: refer to them instead of importing a second time.
    const digest = await checkedDigestOfStagedFile(staged, signal);
    const sameBytes = await history.findStoredBySha256(lease.userId, lease.subscriptionId, digest, record.id);
    let imported: ImportedBlob | undefined;
    if (!sameBytes) {
      await history.markAssetVerifying(record.id);
      await history.updateRun(runId, { state: 'verifying' });
      imported = await importStagedFile({ blobstore, ownerUserId: lease.userId, staged, signal });
    }
    await rm(staged.absolutePath, { force: true });

    if (!imported) {
      await history.referenceStoredAsset(record.id, lease.userId, sameBytes!);
      return;
    }
    await history.markAssetStored(record.id, {
      sha256: imported.sha256,
      sha1: imported.sha1,
      byteSize: imported.byteSize,
      blobObjectId: imported.objectId
    });
    stats.assetsStored += 1;
    stats.bytesStored += imported.byteSize;
    await history.updateRun(runId, { state: 'downloading', stats });

    // Immich takes photos and videos; a file Kura generated itself (the ugoira timing) stays in Kura.
    if (staged.mediaType === 'application/json') return;
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
    outcomeOfSync: { disposition: Disposition; partial: boolean } | undefined,
    access: RunAccess = { platform: undefined, used: false }
  ): Promise<ExecutionOutcome> {
    const { history, queue, subscriptions, logger } = this.deps;
    const problem = await this.settleCredentialAccess(lease, access, outcomeOfSync);
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

function targetHashOf(canonicalUrl: string): string {
  return createHash('sha256').update(canonicalUrl).digest('hex');
}

function unreadableCredentialsDisposition(platform: CredentialPlatform): Disposition {
  return {
    runState: 'waiting_auth',
    code: 'CREDENTIALS_UNREADABLE',
    message: CREDENTIAL_MESSAGES[platform].unreadable,
    retryable: false,
    pauseSubscription: true
  };
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
