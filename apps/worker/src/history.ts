import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ManifestAsset } from '@kura/adapters';
import { systemClock, type Clock } from '@kura/scheduler';

/** Plan 04, section 4. `queued` only exists as job_runs.state. */
export type RunState =
  | 'discovering' | 'downloading' | 'verifying' | 'stored' | 'waiting_auth' | 'waiting_rate_limit'
  | 'retry_wait' | 'paused' | 'cancelled' | 'failed' | 'partially_completed';
export type PostState = 'discovered' | 'downloading' | 'stored' | 'partially_completed' | 'failed';
export type AssetState = 'pending' | 'downloading' | 'verifying' | 'stored' | 'failed';
export type HandoverState =
  | 'not_attempted' | 'no_connection' | 'blocked' | 'error'
  | 'pending' | 'uploading' | 'uploaded_unverified' | 'verified' | 'mismatch' | 'failed' | 'reconciling';

export interface RunStats {
  postsFound: number;
  postsSkipped: number;
  assetsStored: number;
  assetsFailed: number;
  bytesStored: number;
}

export const emptyStats = (): RunStats => ({ postsFound: 0, postsSkipped: 0, assetsStored: 0, assetsFailed: 0, bytesStored: 0 });

export interface NewRun {
  userId: string;
  jobRunId: string;
  leaseGeneration: number;
  subscriptionId: string;
  subscriptionName: string;
  sourceUrl: string | null;
  triggerKind: 'schedule' | 'manual';
}

export interface RunUpdate {
  state?: RunState;
  platform?: string;
  adapterId?: string;
  adapterVersion?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  stats?: RunStats;
  finished?: boolean;
}

export interface PostRecord {
  id: string;
  state: PostState;
  discoveryComplete: boolean;
}

export interface NewPost {
  userId: string;
  runId: string;
  subscriptionId: string;
  platform: string;
  adapterId: string;
  adapterVersion: string;
  creatorPlatformId: string;
  creatorName: string | null;
  platformPostId: string;
  revisionKey: string;
  title: string | null;
  sourceUrl: string;
  publishedAt: string | null;
}

export interface AssetRecord {
  id: string;
  assetIndex: number;
  sourceAssetId: string;
  originalName: string;
  mediaType: string;
  state: AssetState;
  attempts: number;
  byteSize: number | null;
  sha256: string | null;
  sha1: string | null;
  blobObjectId: string | null;
  handoverState: HandoverState;
  transferId: string | null;
  /** Why the asset failed, as recorded by markAssetFailed (null for other states and in handover queries). */
  errorCode: string | null;
}

export interface StoredAssetFacts {
  sha256: string;
  sha1: string;
  byteSize: number;
  blobObjectId: string;
}

/** A revision of a post that is already in the history, and whether it is completely archived. */
export interface KnownRevision {
  revisionKey: string;
  settled: boolean;
}

/** A post of a subscription that is not completely archived and should be looked at again. */
export interface OpenPost {
  platformPostId: string;
  sourceUrl: string;
}

/** An already stored asset whose stored file a new asset row can point to instead of fetching the file again. */
export interface StoredTwin {
  sha256: string;
  sha1: string | null;
  byteSize: number;
  blobObjectId: string;
  handoverState: HandoverState;
  transferId: string | null;
}

export interface SyncState {
  targetHash: string;
  lastSeenPostId: string | null;
  lastSeenRevisionKey: string | null;
  lastSeenAt: Date | null;
  checkedThrough: Date | null;
}

interface AssetRow {
  id: string;
  asset_index: number;
  source_asset_id: string;
  original_name: string;
  media_type: string;
  state: AssetState;
  attempts: number;
  byte_size: string | null;
  sha256: string | null;
  sha1: string | null;
  blob_object_id: string | null;
  handover_state: HandoverState;
  transfer_id: string | null;
  error_code?: string | null;
}

const ASSET_COLUMNS = `id, asset_index, source_asset_id, original_name, media_type, state, attempts, byte_size,
  sha256, sha1, blob_object_id, handover_state, transfer_id, error_code`;

interface TwinRow {
  sha256: string;
  sha1: string | null;
  byte_size: string;
  blob_object_id: string;
  handover_state: HandoverState;
  transfer_id: string | null;
}

const TWIN_COLUMNS = 'a.sha256, a.sha1, a.byte_size, a.blob_object_id, a.handover_state, a.transfer_id';

function toTwin(row: TwinRow): StoredTwin {
  return {
    sha256: row.sha256,
    sha1: row.sha1,
    byteSize: Number(row.byte_size),
    blobObjectId: row.blob_object_id,
    handoverState: row.handover_state,
    transferId: row.transfer_id
  };
}

function toAsset(row: AssetRow): AssetRecord {
  return {
    id: row.id,
    assetIndex: row.asset_index,
    sourceAssetId: row.source_asset_id,
    originalName: row.original_name,
    mediaType: row.media_type,
    state: row.state,
    attempts: row.attempts,
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    sha256: row.sha256,
    sha1: row.sha1,
    blobObjectId: row.blob_object_id,
    handoverState: row.handover_state,
    transferId: row.transfer_id,
    errorCode: row.error_code ?? null
  };
}

/** The target URL without query and fragment: signed links must not end up in the history. */
export function sanitizedSourceUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.slice(0, 2048);
  } catch {
    return null;
  }
}

/**
 * "Completely archived", for a row of download_posts aliased `alias`: stored, or finished with nothing left to try.
 * A post whose remaining assets can never be fetched (an embedded video of another site, a file type that is not
 * allowed) is settled too, and so is a post that the account may not view (ASSET_LOCKED): when that changes, the
 * platform lists files for the post, which gives it another revision key. A post with a failed download, a pending
 * asset, an enumeration that was not complete or an asset that is not accessible now (private: that can change without
 * the revision key changing) is not settled, and is looked at again.
 */
const settledPost = (alias: string): string => `(${alias}.state = 'stored' OR (
  ${alias}.state IN ('partially_completed', 'failed') AND ${alias}.discovery_complete
  AND EXISTS (SELECT 1 FROM download_assets s WHERE s.post_id = ${alias}.id)
  AND NOT EXISTS (
    SELECT 1 FROM download_assets s
     WHERE s.post_id = ${alias}.id AND s.state <> 'stored'
       AND NOT (s.state = 'failed' AND s.error_code IN ('ASSET_UNSUPPORTED', 'ASSET_LOCKED'))
  )
))`;

const ORPHANED_RUN_MESSAGE = 'Der Worker wurde unterbrochen; der Lauf wird erneut versucht oder ist beendet.';

/**
 * Durable history of downloads (docs/planning/05, section 7). The rows reference nothing that is pruned
 * elsewhere (see migration 0050), so nothing here is deleted when a subscription or a queue run is.
 * This class never deletes a row at all.
 */
export class HistoryRepository {
  constructor(private readonly pool: Pool, private readonly clock: Clock = systemClock) {}

  async startRun(run: NewRun): Promise<string> {
    // Earlier attempts of this queued run are over (their lease generation is no longer the live one).
    await this.closeOrphanedRuns(run.jobRunId);
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO download_runs (id, user_id, job_run_id, lease_generation, subscription_id, subscription_name,
                                  source_url, trigger_kind, state, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'discovering', $9)
       ON CONFLICT (job_run_id, lease_generation) DO UPDATE SET state = 'discovering', finished_at = NULL
       RETURNING id`,
      [
        randomUUID(), run.userId, run.jobRunId, run.leaseGeneration, run.subscriptionId, run.subscriptionName,
        run.sourceUrl === null ? null : sanitizedSourceUrl(run.sourceUrl), run.triggerKind, this.clock.now()
      ]
    );
    return result.rows[0]!.id;
  }

  /**
   * Closes runs of attempts that died: still open (no finished_at) but no longer backed by a live lease of
   * the same generation. The queue row may already be gone through retention, hence NOT EXISTS. Only UPDATEs;
   * an attempt that ends normally sets finished_at before it releases its lease, so a live run is never hit.
   * Pass `jobRunId` to look at one queued run only (used when a successor starts). Returns the closed count.
   */
  async closeOrphanedRuns(jobRunId?: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE download_runs d
          SET state = 'retry_wait',
              error_code = 'LEASE_LOST',
              error_message = $2,
              finished_at = $3
        WHERE d.finished_at IS NULL
          AND ($1::uuid IS NULL OR d.job_run_id = $1::uuid)
          AND NOT EXISTS (
            SELECT 1 FROM job_runs j
             WHERE j.id = d.job_run_id AND j.state = 'leased' AND j.attempts = d.lease_generation
          )`,
      [jobRunId ?? null, ORPHANED_RUN_MESSAGE, this.clock.now()]
    );
    return result.rowCount ?? 0;
  }

  async updateRun(runId: string, update: RunUpdate): Promise<void> {
    const assignments: string[] = [];
    const values: unknown[] = [runId];
    const set = (column: string, value: unknown) => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };
    if (update.state !== undefined) set('state', update.state);
    if (update.platform !== undefined) set('platform', update.platform);
    if (update.adapterId !== undefined) set('adapter_id', update.adapterId);
    if (update.adapterVersion !== undefined) set('adapter_version', update.adapterVersion);
    if (update.errorCode !== undefined) set('error_code', update.errorCode);
    if (update.errorMessage !== undefined) set('error_message', update.errorMessage?.slice(0, 1000) ?? null);
    if (update.stats) {
      set('posts_found', update.stats.postsFound);
      set('posts_skipped', update.stats.postsSkipped);
      set('assets_stored', update.stats.assetsStored);
      set('assets_failed', update.stats.assetsFailed);
      set('bytes_stored', update.stats.bytesStored);
    }
    if (update.finished) set('finished_at', this.clock.now());
    if (assignments.length === 0) return;
    await this.pool.query(`UPDATE download_runs SET ${assignments.join(', ')} WHERE id = $1`, values);
  }

  /**
   * Inserts the post or, if this revision is already known, returns it. The post stays linked to the run
   * that found it first, so the history of that run does not change when later runs see the post again.
   */
  async upsertPost(post: NewPost): Promise<PostRecord> {
    const result = await this.pool.query<{ id: string; state: PostState; discovery_complete: boolean }>(
      `INSERT INTO download_posts (id, user_id, run_id, subscription_id, platform, adapter_id, adapter_version,
                                   creator_platform_id, creator_name, platform_post_id, revision_key, title,
                                   source_url, published_at, state, discovered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'discovered', $15)
       ON CONFLICT (user_id, platform, platform_post_id, revision_key)
         DO UPDATE SET adapter_version = EXCLUDED.adapter_version
       RETURNING id, state, discovery_complete`,
      [
        randomUUID(), post.userId, post.runId, post.subscriptionId, post.platform, post.adapterId, post.adapterVersion,
        post.creatorPlatformId, post.creatorName, post.platformPostId, post.revisionKey, post.title?.slice(0, 500) ?? null,
        sanitizedSourceUrl(post.sourceUrl), post.publishedAt, this.clock.now()
      ]
    );
    const row = result.rows[0]!;
    return { id: row.id, state: row.state, discoveryComplete: row.discovery_complete };
  }

  async setPostState(postId: string, state: PostState, discoveryComplete?: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE download_posts
          SET state = $2,
              discovery_complete = COALESCE($3, discovery_complete),
              completed_at = CASE WHEN $2 = 'stored' THEN $4 ELSE completed_at END
        WHERE id = $1`,
      [postId, state, discoveryComplete ?? null, this.clock.now()]
    );
  }

  /**
   * Records the assets of a manifest. Assets that are already stored are not touched, so a repeated
   * run never resets finished work. Returns every asset of the post.
   */
  async upsertAssets(postId: string, userId: string, assets: readonly ManifestAsset[]): Promise<AssetRecord[]> {
    for (const asset of assets) {
      await this.pool.query(
        `INSERT INTO download_assets (id, post_id, user_id, asset_index, source_asset_id, original_name, media_type, role, variant, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
         ON CONFLICT (post_id, source_asset_id) DO UPDATE
           SET original_name = EXCLUDED.original_name, media_type = EXCLUDED.media_type, updated_at = now()
         WHERE download_assets.state <> 'stored'`,
        [randomUUID(), postId, userId, asset.assetIndex, asset.sourceAssetId, asset.originalName.slice(0, 255), asset.mediaType, asset.role, asset.variant]
      );
    }
    return this.assetsOfPost(postId);
  }

  async assetsOfPost(postId: string): Promise<AssetRecord[]> {
    const result = await this.pool.query<AssetRow>(
      `SELECT ${ASSET_COLUMNS} FROM download_assets WHERE post_id = $1 ORDER BY asset_index`,
      [postId]
    );
    return result.rows.map(toAsset);
  }

  async startAsset(assetId: string): Promise<void> {
    await this.pool.query(
      `UPDATE download_assets SET state = 'downloading', attempts = attempts + 1, error_code = NULL, error_message = NULL, updated_at = now()
        WHERE id = $1 AND state <> 'stored'`,
      [assetId]
    );
  }

  async markAssetVerifying(assetId: string): Promise<void> {
    await this.pool.query(`UPDATE download_assets SET state = 'verifying', updated_at = now() WHERE id = $1 AND state <> 'stored'`, [assetId]);
  }

  async markAssetStored(assetId: string, facts: StoredAssetFacts): Promise<void> {
    await this.pool.query(
      `UPDATE download_assets
          SET state = 'stored', sha256 = $2, sha1 = $3, byte_size = $4, blob_object_id = $5,
              stored_at = $6, error_code = NULL, error_message = NULL, updated_at = now()
        WHERE id = $1`,
      [assetId, facts.sha256, facts.sha1, facts.byteSize, facts.blobObjectId, this.clock.now()]
    );
  }

  async markAssetFailed(assetId: string, errorCode: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE download_assets SET state = 'failed', error_code = $2, error_message = $3, updated_at = now()
        WHERE id = $1 AND state <> 'stored'`,
      [assetId, errorCode.slice(0, 64), message.slice(0, 1000)]
    );
  }

  async setHandover(assetId: string, state: HandoverState, transferId?: string): Promise<void> {
    await this.pool.query(
      `UPDATE download_assets
          SET handover_state = $2, transfer_id = COALESCE($3::uuid, transfer_id), handover_at = $4, updated_at = now()
        WHERE id = $1`,
      [assetId, state, transferId ?? null, this.clock.now()]
    );
  }

  /**
   * Stored assets of a user whose earlier handover ended in an uncertain or failed state. "No connection"
   * is not retried: a later Immich connection must not suddenly upload the whole history.
   */
  async assetsNeedingHandoverRetry(userId: string, limit: number): Promise<(AssetRecord & { postId: string; createdAt: Date; modifiedAt: Date })[]> {
    const result = await this.pool.query<AssetRow & { post_id: string; stored_at: Date; published_at: Date | null }>(
      `SELECT a.id, a.asset_index, a.source_asset_id, a.original_name, a.media_type, a.state, a.attempts, a.byte_size,
              a.sha256, a.sha1, a.blob_object_id, a.handover_state, a.transfer_id, a.post_id, a.stored_at, p.published_at
         FROM download_assets a JOIN download_posts p ON p.id = a.post_id
        WHERE a.user_id = $1 AND a.state = 'stored'
          AND a.handover_state IN ('blocked', 'error', 'pending', 'uploading', 'uploaded_unverified', 'failed', 'reconciling')
        ORDER BY a.handover_at NULLS FIRST, a.stored_at
        LIMIT $2`,
      [userId, limit]
    );
    return result.rows.map((row) => ({
      ...toAsset(row),
      postId: row.post_id,
      createdAt: row.published_at ?? row.stored_at,
      modifiedAt: row.stored_at
    }));
  }

  // --- what is already archived (incremental runs, asset-level safety net) ---------------------

  /** Every revision of one post in the history, whatever subscription found it. */
  async revisionsOf(userId: string, platform: string, platformPostId: string): Promise<KnownRevision[]> {
    const result = await this.pool.query<{ revision_key: string; settled: boolean }>(
      `SELECT p.revision_key, ${settledPost('p')} AS settled
         FROM download_posts p WHERE p.user_id = $1 AND p.platform = $2 AND p.platform_post_id = $3`,
      [userId, platform, platformPostId]
    );
    return result.rows.map((row) => ({ revisionKey: row.revision_key, settled: row.settled }));
  }

  /** The ids of all posts of the user on one platform that have a completely archived revision. */
  async settledPostIds(userId: string, platform: string): Promise<Set<string>> {
    const result = await this.pool.query<{ platform_post_id: string }>(
      `SELECT DISTINCT p.platform_post_id FROM download_posts p
        WHERE p.user_id = $1 AND p.platform = $2 AND ${settledPost('p')}`,
      [userId, platform]
    );
    return new Set(result.rows.map((row) => row.platform_post_id));
  }

  /**
   * Posts of a subscription whose newest revision is not completely archived (failed downloads, pending assets,
   * an enumeration that was not complete). Newest first, at most `limit`.
   */
  async openPosts(userId: string, subscriptionId: string, platform: string, limit: number): Promise<OpenPost[]> {
    const result = await this.pool.query<{ platform_post_id: string; source_url: string }>(
      `SELECT platform_post_id, source_url FROM (
         SELECT DISTINCT ON (p.platform_post_id) p.platform_post_id, p.source_url, p.discovered_at, ${settledPost('p')} AS settled
           FROM download_posts p
          WHERE p.user_id = $1 AND p.subscription_id = $2 AND p.platform = $3 AND p.source_url IS NOT NULL
          ORDER BY p.platform_post_id, p.discovered_at DESC, p.id DESC
       ) newest WHERE NOT settled ORDER BY discovered_at DESC LIMIT $4`,
      [userId, subscriptionId, platform, limit]
    );
    return result.rows.map((row) => ({ platformPostId: row.platform_post_id, sourceUrl: row.source_url }));
  }

  /** The state of the most recent finished run of a subscription, other than `exceptRunId`; null if there is none. */
  async lastFinishedRunState(userId: string, subscriptionId: string, exceptRunId: string): Promise<RunState | null> {
    const result = await this.pool.query<{ state: RunState }>(
      `SELECT state FROM download_runs
        WHERE user_id = $1 AND subscription_id = $2 AND id <> $3 AND finished_at IS NOT NULL
        ORDER BY started_at DESC LIMIT 1`,
      [userId, subscriptionId, exceptRunId]
    );
    return result.rows[0]?.state ?? null;
  }

  /** A stored asset with the same id in another revision of the same post (the id must identify the content). */
  async findStoredByAssetId(userId: string, platform: string, platformPostId: string, sourceAssetId: string, exceptAssetId: string): Promise<StoredTwin | null> {
    const result = await this.pool.query<TwinRow>(
      `SELECT ${TWIN_COLUMNS} FROM download_assets a JOIN download_posts p ON p.id = a.post_id
        WHERE a.user_id = $1 AND p.platform = $2 AND p.platform_post_id = $3 AND a.source_asset_id = $4
          AND a.state = 'stored' AND a.id <> $5
        ORDER BY a.stored_at DESC, a.id DESC LIMIT 1`,
      [userId, platform, platformPostId, sourceAssetId, exceptAssetId]
    );
    return result.rows[0] ? toTwin(result.rows[0]) : null;
  }

  /** A stored asset of the same subscription with exactly these bytes. */
  async findStoredBySha256(userId: string, subscriptionId: string, sha256: string, exceptAssetId: string): Promise<StoredTwin | null> {
    const result = await this.pool.query<TwinRow>(
      `SELECT ${TWIN_COLUMNS} FROM download_assets a JOIN download_posts p ON p.id = a.post_id
        WHERE a.user_id = $1 AND p.subscription_id = $2 AND a.sha256 = $3 AND a.state = 'stored' AND a.id <> $4
        ORDER BY a.stored_at DESC, a.id DESC LIMIT 1`,
      [userId, subscriptionId, sha256, exceptAssetId]
    );
    return result.rows[0] ? toTwin(result.rows[0]) : null;
  }

  /**
   * Marks an asset as stored by pointing it at the file another asset row already holds, instead of storing the
   * file again. The blob store keeps one object per owner and checksum and counts how many stored files refer
   * to it (blobstore_objects.reference_count, which a removal checks); this count goes up by one here, exactly as
   * importing the same bytes again would raise it. The handover state is the twin's: it is the same file for the
   * same Immich target, and that transfer is found again by its object id.
   */
  async referenceStoredAsset(assetId: string, userId: string, twin: StoredTwin): Promise<void> {
    await this.pool.query(
      `WITH counted AS (
         UPDATE blobstore_objects SET reference_count = reference_count + 1
          WHERE id::text = $5 AND owner_id = $6
            AND EXISTS (SELECT 1 FROM download_assets WHERE id = $1 AND state <> 'stored')
        RETURNING id
       )
       UPDATE download_assets
          SET state = 'stored', sha256 = $2, sha1 = $3, byte_size = $4, blob_object_id = $5,
              stored_at = $7, error_code = NULL, error_message = NULL,
              handover_state = $8, transfer_id = $9::uuid, handover_at = $7, updated_at = now()
        WHERE id = $1 AND state <> 'stored'`,
      [assetId, twin.sha256, twin.sha1, twin.byteSize, twin.blobObjectId, userId, this.clock.now(), twin.handoverState, twin.transferId]
    );
  }

  async getSyncState(subscriptionId: string, userId: string): Promise<SyncState | null> {
    const result = await this.pool.query<{
      target_hash: string; last_seen_post_id: string | null; last_seen_revision_key: string | null;
      last_seen_at: Date | null; checked_through: Date | null;
    }>(
      `SELECT target_hash, last_seen_post_id, last_seen_revision_key, last_seen_at, checked_through
         FROM subscription_sync_state WHERE subscription_id = $1 AND user_id = $2`,
      [subscriptionId, userId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      targetHash: row.target_hash,
      lastSeenPostId: row.last_seen_post_id,
      lastSeenRevisionKey: row.last_seen_revision_key,
      lastSeenAt: row.last_seen_at,
      checkedThrough: row.checked_through
    };
  }

  /**
   * Remembers what discovery saw. `checkedThrough` moves only when `enumerationComplete` is true; a
   * changed target (different hash) starts from scratch.
   */
  async saveSyncState(input: {
    subscriptionId: string;
    userId: string;
    targetHash: string;
    lastSeenPostId: string | null;
    lastSeenRevisionKey: string | null;
    enumerationComplete: boolean;
  }): Promise<void> {
    const now = this.clock.now();
    await this.pool.query(
      `INSERT INTO subscription_sync_state (subscription_id, user_id, target_hash, last_seen_post_id,
                                            last_seen_revision_key, last_seen_at, checked_through, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $6)
       ON CONFLICT (subscription_id) DO UPDATE SET
         target_hash = EXCLUDED.target_hash,
         last_seen_post_id = COALESCE(EXCLUDED.last_seen_post_id, CASE WHEN subscription_sync_state.target_hash = EXCLUDED.target_hash THEN subscription_sync_state.last_seen_post_id END),
         last_seen_revision_key = COALESCE(EXCLUDED.last_seen_revision_key, CASE WHEN subscription_sync_state.target_hash = EXCLUDED.target_hash THEN subscription_sync_state.last_seen_revision_key END),
         last_seen_at = EXCLUDED.last_seen_at,
         checked_through = CASE
           WHEN EXCLUDED.checked_through IS NOT NULL THEN EXCLUDED.checked_through
           WHEN subscription_sync_state.target_hash = EXCLUDED.target_hash THEN subscription_sync_state.checked_through
           ELSE NULL END,
         updated_at = EXCLUDED.updated_at`,
      [
        input.subscriptionId, input.userId, input.targetHash, input.lastSeenPostId, input.lastSeenRevisionKey,
        now, input.enumerationComplete ? now : null
      ]
    );
  }
}
