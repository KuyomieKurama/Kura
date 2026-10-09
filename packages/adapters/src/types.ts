/**
 * Source adapter contract (docs/planning/04, section 3) and the normalized
 * types it exchanges with the core. Adapters translate one platform into
 * this format; storage, history, Immich and mail never live in an adapter.
 */
import type { RunWorkspace } from './workspace.js';

export type SourceType = 'direct_media' | 'youtube' | 'instagram' | 'patreon' | 'pixiv' | 'pornhub';
export type TargetKind = 'post' | 'creator_feed';
export type AuthKind = 'none' | 'cookies' | 'token' | 'login';
export type QualityPreset = 'BEST_AVAILABLE' | 'SOURCE_BYTES' | 'WITH_EXTRAS';

/**
 * What an adapter can do. Anything the adapter cannot prove is declared
 * false / 'none'; the UI shows only declared capabilities.
 */
export interface AdapterCapabilities {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly sourceTypes: readonly SourceType[];
  readonly single_post: boolean;
  readonly creator_feed: boolean;
  readonly pagination: boolean;
  readonly resume: boolean;
  readonly images: boolean;
  readonly videos: boolean;
  readonly page_snapshot: boolean;
  readonly quality_variants: boolean;
  readonly auth_kind: AuthKind;
  readonly presets: readonly QualityPreset[];
  /**
   * One adapter can serve platforms that differ in what it can do (gallery-dl: Instagram profiles yes, Pixiv
   * profiles no). The flat fields above are the union over all source types; an entry here narrows or widens
   * single fields for one source type. Read it through capabilitiesForSourceType().
   */
  readonly bySourceType?: Partial<Record<SourceType, SourceTypeCapabilities>>;
}

export type SourceTypeCapabilities = Partial<Pick<
  AdapterCapabilities,
  'single_post' | 'creator_feed' | 'pagination' | 'resume' | 'images' | 'videos' | 'auth_kind'
>>;

/** What the adapter can do for one source type: the flat declaration with that type's entry applied. */
export function capabilitiesForSourceType(capabilities: AdapterCapabilities, sourceType: SourceType): AdapterCapabilities {
  const { bySourceType, ...flat } = capabilities;
  return { ...flat, ...bySourceType?.[sourceType] };
}

/** A target that passed validation. `canonicalUrl` is rebuilt from parsed parts, never the raw input. */
export interface CanonicalTarget {
  readonly adapterId: string;
  readonly sourceType: SourceType;
  readonly kind: TargetKind;
  readonly canonicalUrl: string;
  /** Platform id of the post (kind 'post') or creator (kind 'creator_feed'). */
  readonly platformId: string;
}

/**
 * Credentials the worker provides for exactly one run. The adapter only hands them to the tool; it never reads,
 * copies, logs or stores what is behind them.
 */
export interface RunCredentials {
  /**
   * Absolute path of a Netscape-format cookies file that the worker created for this run (mode 0600, inside the
   * private run directory) and removes afterwards. Used for Instagram and Patreon targets (gallery-dl `-C`) and
   * for YouTube targets (yt-dlp `--cookies`).
   */
  readonly cookiesFilePath?: string;
  /**
   * Absolute path of a gallery-dl configuration file that the worker created for this run (mode 0600, inside the
   * private run directory) and removes afterwards. It carries the Pixiv refresh token, which gallery-dl reads only
   * from its configuration (extractor.pixiv.refresh-token) and which must not appear on a command line.
   * Used for Pixiv targets (gallery-dl `-c`).
   */
  readonly configFilePath?: string;
}

export interface JobContext {
  readonly jobId: string;
  readonly leaseGeneration: number;
  readonly signal?: AbortSignal;
  readonly credentials?: RunCredentials;
}

/** What resolveAssets() gets besides the post: it has no job of its own, but needs the same signal and credentials. */
export type ResolveContext = Pick<JobContext, 'signal' | 'credentials'>;

export interface ProbeContext extends JobContext {
  readonly target: CanonicalTarget;
}

export interface DiscoveryContext extends JobContext {
  readonly target: CanonicalTarget;
}

export interface SourceSummary {
  readonly target: CanonicalTarget;
  readonly available: boolean;
  readonly title: string | null;
  readonly creatorId: string | null;
  readonly creatorName: string | null;
}

export interface SourceCreator {
  readonly platformId: string;
  readonly displayName: string | null;
}

export interface SourcePost {
  readonly adapterId: string;
  readonly sourceType: SourceType;
  readonly platformPostId: string;
  readonly creator: SourceCreator;
  readonly title: string | null;
  /** ISO 8601 when the platform reported one that parsed, else null. */
  readonly publishedAt: string | null;
  /** Source revision or a key derived from stable fields; a new key means a new asset version. */
  readonly revisionKey: string;
  /** Taken from the validated target, never from platform metadata. */
  readonly canonicalUrl: string;
}

export interface QualityPolicy {
  readonly preset: QualityPreset;
}

export interface QualityParameters {
  readonly preset: QualityPreset;
  readonly width: number | null;
  readonly height: number | null;
  readonly container: string | null;
}

export type Completeness = 'complete' | 'incomplete';

/** The persistable part of an asset. Contains no signed or otherwise volatile URL. */
export interface ManifestAsset {
  readonly sourceAssetId: string;
  readonly assetIndex: number;
  readonly originalName: string;
  readonly mediaType: string;
  readonly role: 'original' | 'variant';
  readonly variant: string;
  readonly quality: QualityParameters;
  readonly declaredBytes: number | null;
  readonly completeness: Completeness;
  /**
   * Set when the asset is known to be impossible to fetch (an embedded video of another site, a file type that is
   * not allowed, a post the account may not view). It is listed and recorded as failed with this fixed German
   * sentence and the code, instead of being downloaded or silently left out. Never contains tool output.
   * ASSET_NOT_YET_AVAILABLE is the same for something that is expected to become available (a livestream that is
   * running, a premiere): it is recorded for the entry, is not a failure of the run, and is checked again next time.
   */
  readonly unavailable?: { readonly code: 'ASSET_UNSUPPORTED' | 'ASSET_NOT_ACCESSIBLE' | 'ASSET_NOT_YET_AVAILABLE'; readonly message: string };
}

/** Volatile access data. Lives only in the job context and must never be persisted or logged. */
export interface ShortLivedAccess {
  readonly downloadUrl: string;
  readonly obtainedAt: Date;
  readonly expiresAt: Date | null;
}

export interface ResolvedAsset extends ManifestAsset {
  readonly shortLived?: ShortLivedAccess;
}

export interface ManifestError {
  readonly code: string;
  readonly message: string;
}

export interface AssetManifest {
  readonly schemaVersion: 1;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly sourceType: SourceType;
  readonly platformPostId: string;
  readonly creatorId: string;
  readonly revisionKey: string;
  /** True only if the enumeration of assets is known to be finished and trustworthy. */
  readonly discoveryComplete: boolean;
  readonly assets: readonly ResolvedAsset[];
  readonly errors: readonly ManifestError[];
}

export interface DownloadLimits {
  /** Hard cap for one asset in bytes. */
  readonly maxBytes: number;
}

export interface DownloadContext extends JobContext {
  readonly post: SourcePost;
  readonly policy: QualityPolicy;
  readonly limits: DownloadLimits;
}

export interface StageContext extends DownloadContext {
  /** Per-job workspace owned by the caller; staged files end up in its media/ directory. */
  readonly workspace: RunWorkspace;
}

/** A file that passed the adapter's own checks and now sits in `workspace.mediaDir`. */
export interface StagedFile {
  readonly assetIndex: number;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly mediaType: string;
}

export interface SourceAdapter {
  capabilities(): AdapterCapabilities;
  validateTarget(url: string): CanonicalTarget;
  probe(context: ProbeContext): Promise<SourceSummary>;
  discover(context: DiscoveryContext): AsyncIterable<SourcePost>;
  resolveAssets(post: SourcePost, policy: QualityPolicy, context?: ResolveContext): Promise<AssetManifest>;
  download(asset: ResolvedAsset, context: DownloadContext): AsyncIterable<Uint8Array>;
  /**
   * Optional alternative delivery for CLI adapters (plan 04, section 3): the
   * tool writes into a private scratch directory and the adapter hands over
   * one checked file in `workspace.mediaDir`. The trusted importer still
   * re-checks everything.
   */
  stage?(asset: ResolvedAsset, context: StageContext): Promise<StagedFile>;
}

/** Drops volatile access data so the result is safe to persist. */
export function toPersistableAsset(asset: ResolvedAsset): ManifestAsset {
  const { shortLived: _shortLived, ...persistable } = asset;
  void _shortLived;
  return persistable;
}
