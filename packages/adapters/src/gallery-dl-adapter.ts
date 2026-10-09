import { createHash } from 'node:crypto';
import { AdapterError } from './errors.js';
import {
  buildToolArguments,
  cleanText,
  CliTool,
  compareVersions,
  identifierText,
  labelFromName,
  parseVersion,
  positiveInteger,
  type CliToolOptions
} from './cli-support.js';
import {
  failureFromProcess,
  failureFromToolError,
  failureOfEmptyProfileListing,
  parseDumpJson,
  type FailureContext,
  type ParsedOutput,
  type ParsedPost
} from './gallery-dl-output.js';
import { canonicalInstagramUrl, INSTAGRAM_SHORTCODE, instagramToolUrl, parseInstagramPath, type InstagramTarget } from './instagram-target.js';
import { mediaTypeForExtension } from './media.js';
import { parseHttpsTarget } from './target-url.js';
import type { ProcessResult } from './process-runner.js';
import type {
  AdapterCapabilities,
  AssetManifest,
  CanonicalTarget,
  DiscoveryContext,
  DownloadContext,
  ManifestError,
  ProbeContext,
  QualityPolicy,
  ResolveContext,
  ResolvedAsset,
  RunCredentials,
  SourceAdapter,
  SourcePost,
  SourceSummary,
  SourceType,
  StageContext,
  StagedFile,
  TargetKind
} from './types.js';

export const GALLERY_DL_ADAPTER_ID = 'gallery-dl';

/** Version label of an instance that cannot run the tool (see forTargetValidationOnly). */
const VALIDATION_ONLY_VERSION = 'not-installed';

export interface GalleryDlAdapterOptions extends CliToolOptions {
  /**
   * Optional version floor. There is no security floor for gallery-dl in the
   * decisions (D-008 records v1.32.2 as the last known release, nothing more).
   */
  readonly minimumVersion?: string;
  /**
   * Upper bound of posts read from an Instagram profile in one run (1-500). The newest posts come first, so
   * the bound also limits the first run of a subscription. Default: INSTAGRAM_DEFAULT_MAX_POSTS_PER_RUN.
   */
  readonly instagramMaxPostsPerRun?: number;
}

/** Posts read from an Instagram profile per run when the administrator sets nothing else. */
export const INSTAGRAM_DEFAULT_MAX_POSTS_PER_RUN = 50;
export const INSTAGRAM_MAX_POSTS_PER_RUN_LIMIT = 500;

/** Never read configuration files, so nothing from the host user's home can add options or credentials. */
const COMMON_OPTIONS = ['--config-ignore'] as const;
const FILENAME_TEMPLATE = 'asset.{extension}';
const MAX_FILES_PER_POST = 1_000;

/*
 * Instagram options. Every option name below was checked against `gallery-dl --help` and the extractor source of
 * gallery-dl 1.32.16 (see the report IG-A-implementer.md for the list with sources).
 *
 *  --sleep-request 8-15   seconds between two HTTP requests of the extraction (a range is drawn at random).
 *                         gallery-dl's own default for Instagram is 6-12; Kura is slower on purpose.
 *  --sleep 2-5            seconds before each file download.
 *  --retries 0            no automatic retry inside gallery-dl: after a 429 it would sleep and ask again and
 *                         hit the metadata timeout; Kura's queue owns the back-off (waiting_rate_limit).
 *  -o extractor.instagram.videos=merged
 *                         download the ready-made video file instead of assembling DASH parts. The default
 *                         ("dash") imports a yt-dlp module inside gallery-dl, which would bypass the version
 *                         floor and hash check Kura applies to yt-dlp (D-007).
 *  -C <file>, -o extractor.instagram.cookies-update=false
 *                         cookies of the logged-in session, and do not write the session back into that file.
 *  --post-range 1-N       stop the profile listing after N posts.
 */
const INSTAGRAM_REQUEST_SLEEP = '8-15';
const INSTAGRAM_DOWNLOAD_SLEEP = '2-5';
/** Reading a profile is slow by design (pacing between requests, one request per reel in the reels tab). */
const INSTAGRAM_PROFILE_LISTING_TIMEOUT_MS = 30 * 60_000;
const INSTAGRAM_MAX_COOKIES_PATH_CHARS = 4_096;

const PIXIV_HOSTS = new Set(['pixiv.net', 'www.pixiv.net']);
const INSTAGRAM_HOSTS = new Set(['instagram.com', 'www.instagram.com']);
const PATREON_HOSTS = new Set(['patreon.com', 'www.patreon.com']);
const NUMERIC_ID = /^\d{1,12}$/;
const MEDIA_ID = /^\d{1,25}$/;
const PATREON_SLUG = /^(?:[A-Za-z0-9_-]{0,120}-)?(\d{1,12})$/;

interface ListedFile {
  /** 0-based position in the tool's file list; the tool's --range is 1-based. */
  readonly index: number;
  readonly sourceAssetId: string;
  readonly extension: string | null;
  readonly name: string | null;
  readonly width: number | null;
  readonly height: number | null;
}

interface PostListing {
  /** The platform's id of the post as the tool printed it (Instagram: shortcode), or null if absent. */
  readonly postId: string | null;
  /** Instagram only: `reel` when the tool called the post a reel. */
  readonly postType: 'p' | 'reel';
  readonly creatorId: string;
  readonly creatorName: string | null;
  readonly title: string | null;
  readonly date: string | null;
  readonly files: readonly ListedFile[];
  /** Set when the listing cannot be taken as the full file list of the post. */
  readonly incomplete: { readonly code: string; readonly message: string } | null;
}

interface ProfileListing {
  /** Newest first, without duplicates. */
  readonly posts: readonly PostListing[];
  /** The tool stopped with an error after these posts (for example throttled on page 2). */
  readonly stoppedBy: AdapterError | null;
}

/**
 * gallery-dl as a CLI adapter: single posts (Pixiv, Patreon, Instagram) and Instagram profiles.
 * The listing (`--dump-json`) is untrusted; downloads address files only by their numeric position
 * (`--range N`) in a listing of the validated URL, so no URL or name from the tool's output is ever passed
 * back as an argument. A profile is only ever listed; each of its posts is then handled like a single post.
 */
export class GalleryDlAdapter implements SourceAdapter {
  private readonly tool: CliTool;
  private readonly instagramMaxPosts: number;

  private constructor(options: GalleryDlAdapterOptions, private readonly version: string) {
    this.tool = new CliTool(options);
    const maxPosts = options.instagramMaxPostsPerRun ?? INSTAGRAM_DEFAULT_MAX_POSTS_PER_RUN;
    if (!Number.isInteger(maxPosts) || maxPosts < 1 || maxPosts > INSTAGRAM_MAX_POSTS_PER_RUN_LIMIT) {
      throw new AdapterError('BINARY_NOT_CONFIGURED', `instagramMaxPostsPerRun must be an integer between 1 and ${INSTAGRAM_MAX_POSTS_PER_RUN_LIMIT}`);
    }
    this.instagramMaxPosts = maxPosts;
  }

  static async create(options: GalleryDlAdapterOptions): Promise<GalleryDlAdapter> {
    const version = await new CliTool(options).readVersionLine();
    const parsed = parseVersion(version);
    if (!parsed) throw new AdapterError('BINARY_VERSION_REJECTED', 'gallery-dl reported a version in an unexpected format', version);
    const floor = options.minimumVersion === undefined ? undefined : parseVersion(options.minimumVersion);
    if (options.minimumVersion !== undefined && !floor) throw new AdapterError('BINARY_NOT_CONFIGURED', 'minimumVersion has an unexpected format');
    if (floor && compareVersions(parsed, floor) < 0) {
      throw new AdapterError('BINARY_VERSION_REJECTED', `gallery-dl ${version} is older than the required ${options.minimumVersion}`);
    }
    return new GalleryDlAdapter(options, version);
  }

  /** See YtDlpAdapter.forTargetValidationOnly: recognises targets, never runs the tool. */
  static forTargetValidationOnly(): GalleryDlAdapter {
    return new GalleryDlAdapter(
      { binary: { path: '/nonexistent/gallery-dl', sha256: '0'.repeat(64) }, workRoot: '/nonexistent', validationOnly: true },
      VALIDATION_ONLY_VERSION
    );
  }

  /**
   * The flat values are the union over all source types; `bySourceType` narrows them for Pixiv and Patreon,
   * which stay single-post sources. Instagram: single posts and reels work without a login in principle (often
   * Instagram answers with a login wall anyway), profiles need a logged-in session in practice, so `auth_kind`
   * is `cookies` for Instagram.
   */
  capabilities(): AdapterCapabilities {
    return {
      adapterId: GALLERY_DL_ADAPTER_ID,
      adapterVersion: this.version,
      sourceTypes: ['pixiv', 'instagram', 'patreon'],
      single_post: true,
      creator_feed: true,
      pagination: true,
      resume: false,
      images: true,
      videos: true,
      page_snapshot: false,
      quality_variants: false,
      auth_kind: 'cookies',
      presets: ['BEST_AVAILABLE', 'SOURCE_BYTES'],
      bySourceType: {
        // Pixiv and Patreon: single posts only; videos stay with yt-dlp (plan 04, section 2); no credential channel.
        pixiv: { creator_feed: false, pagination: false, videos: false, auth_kind: 'none' },
        patreon: { creator_feed: false, pagination: false, videos: false, auth_kind: 'none' }
      }
    };
  }

  validateTarget(url: string): CanonicalTarget {
    const parsed = parseHttpsTarget(url);
    const host = parsed.hostname.toLowerCase();
    const segments = parsed.pathname.split('/').filter(Boolean);

    if (PIXIV_HOSTS.has(host)) return this.pixivTarget(segments);
    if (INSTAGRAM_HOSTS.has(host)) return this.instagramTarget(segments);
    if (PATREON_HOSTS.has(host)) return this.patreonTarget(segments);
    throw new AdapterError('TARGET_UNSUPPORTED', 'This host is not enabled for gallery-dl');
  }

  async probe(context: ProbeContext): Promise<SourceSummary> {
    const target = this.recheck(context.target);
    if (target.kind === 'creator_feed') {
      // One post is enough to learn who the creator is, and a login problem shows up here after a few requests.
      const profile = await this.listProfile(target, 1, context.signal, context.credentials);
      const first = profile.posts[0];
      return {
        target: context.target,
        available: profile.posts.length > 0,
        title: first?.creatorName ? `Instagram: ${first.creatorName}` : null,
        creatorId: first?.creatorId ?? null,
        creatorName: first?.creatorName ?? null
      };
    }
    const listing = await this.listPost(target, context.signal, context.credentials);
    return {
      target: context.target,
      available: listing.files.length > 0,
      title: listing.title,
      creatorId: listing.creatorId,
      creatorName: listing.creatorName
    };
  }

  async *discover(context: DiscoveryContext): AsyncIterable<SourcePost> {
    const target = this.recheck(context.target);
    if (target.kind === 'creator_feed') {
      const profile = await this.listProfile(target, this.instagramMaxPosts, context.signal, context.credentials);
      for (const listing of profile.posts) yield this.instagramPostFrom(listing);
      // Posts that were listed before the tool stopped are delivered first; the run then ends with the error
      // (login, throttling) instead of looking like a complete, quiet profile.
      if (profile.stoppedBy) throw profile.stoppedBy;
      return;
    }
    const listing = await this.listPost(target, context.signal, context.credentials);
    yield this.postFrom(target, listing);
  }

  async resolveAssets(post: SourcePost, policy: QualityPolicy, context?: ResolveContext): Promise<AssetManifest> {
    assertPresetSupported(policy);
    const target = this.targetOfPost(post);
    const listing = await this.listPost(target, context?.signal, context?.credentials);

    const errors: ManifestError[] = [];
    const assets: ResolvedAsset[] = [];
    for (const file of listing.files) {
      const mediaType = file.extension ? mediaTypeForExtension(file.extension) : undefined;
      if (!mediaType || !file.extension) {
        errors.push({ code: 'ASSET_UNSUPPORTED', message: `File ${file.index + 1} has a type that is not allowed` });
        continue;
      }
      assets.push({
        sourceAssetId: file.sourceAssetId,
        assetIndex: file.index,
        originalName: `${labelFromName(file.name, `file-${file.index + 1}`)}.${file.extension}`,
        mediaType,
        role: 'original',
        variant: 'original',
        quality: { preset: policy.preset, width: file.width, height: file.height, container: file.extension },
        declaredBytes: null,
        completeness: 'complete'
      });
    }
    if (listing.incomplete) errors.push(listing.incomplete);
    if (listing.files.length === 0) errors.push({ code: 'NO_FILES', message: 'The tool listed no files for this post' });

    return {
      schemaVersion: 1,
      adapterId: GALLERY_DL_ADAPTER_ID,
      adapterVersion: this.version,
      sourceType: post.sourceType,
      platformPostId: post.platformPostId,
      creatorId: post.creator.platformId,
      revisionKey: post.revisionKey,
      // Only a clean listing counts as a complete enumeration.
      discoveryComplete: errors.length === 0,
      assets,
      errors
    };
  }

  download(asset: ResolvedAsset, context: DownloadContext): AsyncIterable<Uint8Array> {
    return this.tool.streamThroughStaging((workspace) => this.stage(asset, { ...context, workspace }));
  }

  async stage(asset: ResolvedAsset, context: StageContext): Promise<StagedFile> {
    assertPresetSupported(context.policy);
    if (!Number.isInteger(asset.assetIndex) || asset.assetIndex < 0 || asset.assetIndex >= MAX_FILES_PER_POST) {
      throw new AdapterError('TARGET_INVALID', 'Asset index is outside the supported range');
    }
    const target = this.targetOfPost(context.post);
    const maxBytes = context.limits.maxBytes;
    const failureContext = failureContextOf(target, context.credentials);
    return this.tool.stageOneFile(context.workspace, asset.assetIndex, maxBytes, (scratch) => buildToolArguments([
      ...COMMON_OPTIONS,
      ...sourceOptions(target, context.credentials, 'download'),
      '-D', scratch,
      '-f', FILENAME_TEMPLATE,
      '--range', String(asset.assetIndex + 1),
      '--filesize-max', String(maxBytes)
    ], [toolUrlOf(target)]), context.signal, (result) => failureFromProcess(result, failureContext, 'downloading'));
  }

  // --- listing ------------------------------------------------------------------------------

  /** All files of one post. Several `[2, ...]` entries (a tool that splits a post) are read as one file list. */
  private async listPost(target: CanonicalTarget, signal?: AbortSignal, credentials?: RunCredentials): Promise<PostListing> {
    const failureContext = failureContextOf(target, credentials);
    const result = await this.tool.runMetadata(buildToolArguments([
      ...COMMON_OPTIONS,
      '--dump-json',
      ...sourceOptions(target, credentials, 'list')
    ], [toolUrlOf(target)]), signal);
    return readPostListing(result, target, failureContext);
  }

  /** The newest `maxPosts` posts of a profile (or of its reels tab), newest first. */
  private async listProfile(target: CanonicalTarget, maxPosts: number, signal?: AbortSignal, credentials?: RunCredentials): Promise<ProfileListing> {
    const failureContext = failureContextOf(target, credentials);
    const result = await this.tool.runMetadata(buildToolArguments([
      ...COMMON_OPTIONS,
      '--dump-json',
      ...sourceOptions(target, credentials, 'list'),
      '--post-range', `1-${maxPosts}`
    ], [toolUrlOf(target)]), signal, INSTAGRAM_PROFILE_LISTING_TIMEOUT_MS);
    return readProfileListing(result, failureContext, maxPosts);
  }

  // --- posts --------------------------------------------------------------------------------

  private postFrom(target: CanonicalTarget, listing: PostListing): SourcePost {
    return this.buildPost({ sourceType: target.sourceType, platformPostId: target.platformId, canonicalUrl: target.canonicalUrl }, listing);
  }

  /** A post found in a profile: it is addressed by its own /p/ or /reel/ URL from here on. */
  private instagramPostFrom(listing: PostListing): SourcePost {
    const shortcode = listing.postId!;
    return this.buildPost({
      sourceType: 'instagram',
      platformPostId: shortcode,
      canonicalUrl: canonicalInstagramUrl({ kind: 'post', shortcode, postType: listing.postType })
    }, listing);
  }

  private buildPost(identity: { sourceType: SourceType; platformPostId: string; canonicalUrl: string }, listing: PostListing): SourcePost {
    return {
      adapterId: GALLERY_DL_ADAPTER_ID,
      sourceType: identity.sourceType,
      platformPostId: identity.platformPostId,
      creator: { platformId: listing.creatorId, displayName: listing.creatorName },
      title: listing.title,
      publishedAt: listing.date,
      // No revision field is known for these sites; the key changes when the date or the file list changes.
      revisionKey: `l-${createHash('sha256')
        .update(`${identity.platformPostId}|${listing.date ?? ''}|${listing.files.map((file) => file.extension ?? '?').join(',')}`)
        .digest('hex').slice(0, 24)}`,
      canonicalUrl: identity.canonicalUrl
    };
  }

  /** Re-validates the URL stored in a post, so a tampered post cannot reach the tool. */
  private targetOfPost(post: SourcePost): CanonicalTarget {
    if (post.adapterId !== GALLERY_DL_ADAPTER_ID) throw new AdapterError('TARGET_INVALID', 'Post belongs to a different adapter');
    const target = this.validateTarget(post.canonicalUrl);
    if (target.kind !== 'post' || target.canonicalUrl !== post.canonicalUrl || target.platformId !== post.platformPostId || target.sourceType !== post.sourceType) {
      throw new AdapterError('TARGET_INVALID', 'Post does not match its canonical URL');
    }
    return target;
  }

  /** The same check for a target handed to probe() or discover(): only what validateTarget() would produce passes. */
  private recheck(target: CanonicalTarget): CanonicalTarget {
    const checked = this.validateTarget(target.canonicalUrl);
    if (checked.canonicalUrl !== target.canonicalUrl || checked.platformId !== target.platformId || checked.sourceType !== target.sourceType || checked.kind !== target.kind) {
      throw new AdapterError('TARGET_INVALID', 'Target does not match its canonical URL');
    }
    return checked;
  }

  // --- target grammar -----------------------------------------------------------------------

  private pixivTarget(segments: string[]): CanonicalTarget {
    // /artworks/ID or /<language>/artworks/ID
    const rest = segments[0] === 'artworks' ? segments : segments.length === 3 && /^[a-z]{2}(-[a-z]{2})?$/.test(segments[0]!) ? segments.slice(1) : undefined;
    if (!rest || rest[0] !== 'artworks' || rest.length !== 2) {
      throw new AdapterError('TARGET_UNSUPPORTED', 'Only single Pixiv artworks are supported');
    }
    const id = rest[1]!;
    if (!NUMERIC_ID.test(id)) throw new AdapterError('TARGET_INVALID', 'Pixiv artwork id has an unexpected format');
    return this.targetOf('pixiv', 'post', `https://www.pixiv.net/artworks/${id}`, id);
  }

  private instagramTarget(segments: string[]): CanonicalTarget {
    const parsed: InstagramTarget = parseInstagramPath(segments);
    return this.targetOf(
      'instagram',
      parsed.kind === 'profile' ? 'creator_feed' : 'post',
      canonicalInstagramUrl(parsed),
      parsed.kind === 'profile' ? parsed.username : parsed.shortcode
    );
  }

  private patreonTarget(segments: string[]): CanonicalTarget {
    if (segments[0] !== 'posts' || segments.length !== 2) {
      throw new AdapterError('TARGET_UNSUPPORTED', 'Only single Patreon posts are supported');
    }
    const match = PATREON_SLUG.exec(segments[1]!);
    if (!match) throw new AdapterError('TARGET_INVALID', 'Patreon post slug has an unexpected format');
    return this.targetOf('patreon', 'post', `https://www.patreon.com/posts/${segments[1]}`, match[1]!);
  }

  private targetOf(sourceType: SourceType, kind: TargetKind, canonicalUrl: string, platformId: string): CanonicalTarget {
    return { adapterId: GALLERY_DL_ADAPTER_ID, sourceType, kind, canonicalUrl, platformId };
  }
}

function assertPresetSupported(policy: QualityPolicy): void {
  if (policy.preset !== 'BEST_AVAILABLE' && policy.preset !== 'SOURCE_BYTES') {
    throw new AdapterError('POLICY_UNSUPPORTED', `Preset ${policy.preset} is not supported by the gallery-dl adapter`);
  }
}

// --- arguments -------------------------------------------------------------------------------

/** The URL given to the tool. An Instagram profile gets its explicit /posts/ page (see instagramToolUrl). */
function toolUrlOf(target: CanonicalTarget): string {
  if (target.sourceType !== 'instagram') return target.canonicalUrl;
  const parsed = parseInstagramPath(new URL(target.canonicalUrl).pathname.split('/').filter(Boolean));
  return instagramToolUrl(parsed);
}

function failureContextOf(target: CanonicalTarget, credentials: RunCredentials | undefined): FailureContext {
  return {
    sourceType: target.sourceType,
    scope: target.kind === 'creator_feed' ? 'profile' : 'post',
    hasCookies: target.sourceType === 'instagram' && credentials?.cookiesFilePath !== undefined
  };
}

/**
 * Options that depend on the platform. Only fixed strings and numbers computed by Kura end up here; the one
 * variable value is the cookies file path the worker provides, checked for shape and passed as the value of -C.
 * The file itself is never opened by Kura.
 */
function sourceOptions(target: CanonicalTarget, credentials: RunCredentials | undefined, phase: 'list' | 'download'): string[] {
  if (target.sourceType !== 'instagram') return [];
  const options = [
    '--sleep-request', INSTAGRAM_REQUEST_SLEEP,
    '--retries', '0',
    '-o', 'extractor.instagram.videos=merged'
  ];
  if (phase === 'download') options.push('--sleep', INSTAGRAM_DOWNLOAD_SLEEP);
  return [...options, ...cookieOptions(credentials)];
}

function cookieOptions(credentials: RunCredentials | undefined): string[] {
  const path = credentials?.cookiesFilePath;
  if (path === undefined) return [];
  // The path is the value of -C. It must be absolute (so it can never look like an option) and free of control characters.
  // eslint-disable-next-line no-control-regex
  if (!path.startsWith('/') || path.length > INSTAGRAM_MAX_COOKIES_PATH_CHARS || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new AdapterError('PROCESS_SPAWN_FAILED', 'The cookies file path must be absolute and free of control characters');
  }
  return ['-C', path, '-o', 'extractor.instagram.cookies-update=false'];
}

// --- reading the listing ---------------------------------------------------------------------

/**
 * Reads the output of a single-post listing. A failure of the tool without any file becomes the matching
 * AdapterError; a failure after some files makes the listing incomplete instead.
 */
function readPostListing(result: ProcessResult, target: CanonicalTarget, context: FailureContext): PostListing {
  const hasOutput = result.untrustedStdout.trim().length > 0;
  if (result.exitCode !== 0 && !hasOutput) throw failureFromProcess(result, context, 'listing files');
  const output = parseDumpJson(result.untrustedStdout);

  const metadataList = output.posts.flatMap((post) => post.files);
  const truncated = output.posts.some((post) => post.filesTruncated);
  if (output.error && metadataList.length === 0) throw failureFromToolError(output.error, context);

  const merged: ParsedPost = {
    directory: output.posts[0]?.directory,
    files: metadataList.slice(0, MAX_FILES_PER_POST),
    filesTruncated: truncated || metadataList.length > MAX_FILES_PER_POST
  };
  const listing = listingOfPost(merged, target.sourceType);
  assertSamePost(target, listing);
  if (listing.incomplete) return listing;
  if (output.error) {
    return { ...listing, incomplete: { code: 'TOOL_REPORTED_ERRORS', message: 'The tool reported an error after listing files; the list may be partial' } };
  }
  if (result.exitCode !== 0) {
    return { ...listing, incomplete: { code: 'TOOL_REPORTED_ERRORS', message: `The tool exited with code ${result.exitCode} after listing; the list may be partial` } };
  }
  return listing;
}

function readProfileListing(result: ProcessResult, context: FailureContext, maxPosts: number): ProfileListing {
  const hasOutput = result.untrustedStdout.trim().length > 0;
  if (result.exitCode !== 0 && !hasOutput) throw failureFromProcess(result, context, 'listing posts');
  const output: ParsedOutput = parseDumpJson(result.untrustedStdout);
  const stoppedBy = output.error ? failureFromToolError(output.error, context) : null;

  const seen = new Set<string>();
  const listings: PostListing[] = [];
  for (const post of output.posts) {
    const listing = listingOfPost(post, 'instagram');
    // A post without a usable shortcode cannot be addressed later, so it cannot be archived.
    if (listing.postId === null || seen.has(listing.postId)) continue;
    seen.add(listing.postId);
    listings.push(listing);
  }

  if (listings.length === 0) throw stoppedBy ?? failureOfEmptyProfileListing(result.untrustedStderr, context);
  return { posts: newestFirst(listings).slice(0, maxPosts), stoppedBy };
}

/**
 * Profile pages put pinned posts first. A stable sort by date gives "newest first" whenever every post has a
 * date; with a missing date the tool's own order is kept rather than guessing.
 */
function newestFirst(listings: PostListing[]): PostListing[] {
  if (listings.some((listing) => listing.date === null)) return listings;
  return [...listings].sort((left, right) => (left.date! < right.date! ? 1 : left.date! > right.date! ? -1 : 0));
}

/** One post as the tool printed it. Everything is optional; nothing read here is ever used as an argument. */
function listingOfPost(post: ParsedPost, sourceType: SourceType): PostListing {
  const files: ListedFile[] = [];
  const usedAssetIds = new Set<string>();
  for (const metadata of post.files) {
    const index = files.length;
    const mediaId = sourceType === 'instagram' ? identifierText(metadata.media_id, MEDIA_ID) : null;
    // A stable media id survives a change in the order of a carousel; the position does not.
    const preferredId = mediaId ? `media-${mediaId}` : `file-${index}`;
    const sourceAssetId = usedAssetIds.has(preferredId) ? `file-${index}` : preferredId;
    usedAssetIds.add(sourceAssetId);
    files.push({
      index,
      sourceAssetId,
      extension: typeof metadata.extension === 'string' && /^[A-Za-z0-9]{1,5}$/.test(metadata.extension) ? metadata.extension.toLowerCase() : null,
      name: sourceType === 'instagram' ? instagramFileName(post.directory, metadata, index) : cleanText(metadata.filename, 200),
      width: positiveInteger(metadata.width),
      height: positiveInteger(metadata.height)
    });
  }

  const instagram = sourceType === 'instagram';
  // Instagram prints the post's own data (date, owner, caption) in the directory entry; the file entries of a
  // carousel carry the date of the single item. Other sites are read from the first file, as before.
  const first = instagram ? (post.directory ?? post.files[0]) : (post.files[0] ?? post.directory);
  const user = asObject(first?.user) ?? asObject(first?.creator) ?? asObject(first?.owner);
  const dateText = typeof first?.date === 'string' ? first.date : typeof first?.post_date === 'string' ? first.post_date : undefined;
  const parsedDate = dateText === undefined ? undefined : new Date(asUtcTimestamp(dateText));
  return {
    postId: first ? (instagram ? identifierText(first.post_shortcode, INSTAGRAM_SHORTCODE) : identifierText(first.id, NUMERIC_ID)) : null,
    postType: first?.type === 'reel' ? 'reel' : 'p',
    creatorId: (instagram
      ? identifierText(first?.owner_id, /^[A-Za-z0-9][\w.@:-]{0,99}$/)
      : identifierText(user?.id, /^[A-Za-z0-9][\w.@:-]{0,99}$/)) ?? 'unknown',
    creatorName: instagram
      ? cleanText(first?.fullname, 200) ?? cleanText(first?.username, 200)
      : cleanText(user?.name ?? user?.full_name, 200),
    title: instagram ? firstLine(first?.description, 300) : cleanText(first?.title, 300),
    date: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null,
    files,
    incomplete: post.filesTruncated
      ? { code: 'LISTING_TRUNCATED', message: `More than ${MAX_FILES_PER_POST} files; the list was cut off` }
      : null
  };
}

/** `<shortcode>_<position>`: the CDN file names ("481..._n") say nothing to a person. */
function instagramFileName(directory: Record<string, unknown> | undefined, metadata: Record<string, unknown>, index: number): string | null {
  const shortcode = identifierText(metadata.post_shortcode ?? directory?.post_shortcode, INSTAGRAM_SHORTCODE);
  return shortcode ? `${shortcode}_${index + 1}` : null;
}

function firstLine(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' ? cleanText(value.split('\n')[0], maxLength) : null;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** gallery-dl prints naive timestamps ("2026-01-01T00:00:00" or "2026-01-01 00:00:00"); they are UTC, not local time. */
function asUtcTimestamp(value: string): string {
  const withT = value.replace(' ', 'T');
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(withT) ? withT : `${withT}Z`;
}

/**
 * The tool was given the target URL, so its files must belong to that post.
 * A different id means a redirect or an extractor surprise: stop. The key that carries the id is
 * `id` for Pixiv and Patreon and `post_shortcode` for Instagram (gallery_dl/extractor/instagram.py).
 */
function assertSamePost(target: CanonicalTarget, listing: PostListing): void {
  if (listing.files.length === 0) return;
  if (listing.postId === null) throw new AdapterError('OUTPUT_INVALID', 'gallery-dl metadata has no usable post id');
  if (listing.postId !== target.platformId) {
    throw new AdapterError('OUTPUT_INVALID', 'gallery-dl returned files for a different post than requested');
  }
}
