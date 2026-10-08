import { createHash } from 'node:crypto';
import { AdapterError } from './errors.js';
import {
  asRecord,
  assertToolSucceeded,
  buildToolArguments,
  cleanText,
  CliTool,
  compareVersions,
  identifierText,
  labelFromName,
  parseUntrustedJson,
  parseVersion,
  positiveInteger,
  type CliToolOptions
} from './cli-support.js';
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
  ResolvedAsset,
  SourceAdapter,
  SourcePost,
  SourceSummary,
  SourceType,
  StageContext,
  StagedFile
} from './types.js';

export const GALLERY_DL_ADAPTER_ID = 'gallery-dl';

export interface GalleryDlAdapterOptions extends CliToolOptions {
  /**
   * Optional version floor. There is no security floor for gallery-dl in the
   * decisions (D-008 records v1.32.2 as the last known release, nothing more).
   */
  readonly minimumVersion?: string;
}

/** Never read configuration files, so nothing from the host user's home can add options or credentials. */
const COMMON_OPTIONS = ['--config-ignore'] as const;
const FILENAME_TEMPLATE = 'asset.{extension}';
const MAX_FILES_PER_POST = 1_000;

const PIXIV_HOSTS = new Set(['pixiv.net', 'www.pixiv.net']);
const INSTAGRAM_HOSTS = new Set(['instagram.com', 'www.instagram.com']);
const PATREON_HOSTS = new Set(['patreon.com', 'www.patreon.com']);
const NUMERIC_ID = /^\d{1,12}$/;
const INSTAGRAM_ID = /^[A-Za-z0-9_-]{5,40}$/;
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
  readonly creatorId: string;
  readonly creatorName: string | null;
  readonly title: string | null;
  readonly date: string | null;
  readonly files: readonly ListedFile[];
  /** Set when the listing cannot be taken as the full file list of the post. */
  readonly incomplete: { readonly code: string; readonly message: string } | null;
}

/**
 * gallery-dl as a CLI adapter for single posts (Pixiv, Instagram, Patreon).
 * The listing (`--dump-json`) is untrusted; downloads address files only by
 * their numeric position (`--range N`) in a listing of the validated URL, so
 * no URL or name from the tool's output is ever passed back as an argument.
 */
export class GalleryDlAdapter implements SourceAdapter {
  private readonly tool: CliTool;

  private constructor(options: GalleryDlAdapterOptions, private readonly version: string) {
    this.tool = new CliTool(options);
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

  capabilities(): AdapterCapabilities {
    return {
      adapterId: GALLERY_DL_ADAPTER_ID,
      adapterVersion: this.version,
      sourceTypes: ['pixiv', 'instagram', 'patreon'],
      single_post: true,
      creator_feed: false,
      pagination: false,
      resume: false,
      images: true,
      videos: false, // videos are left to yt-dlp (plan 04, section 2); not declared until a contract test proves otherwise
      page_snapshot: false,
      quality_variants: false,
      auth_kind: 'none', // no credential channel in this slice; sources that need a login will fail
      presets: ['BEST_AVAILABLE', 'SOURCE_BYTES']
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
    const listing = await this.list(context.target, context.signal);
    return {
      target: context.target,
      available: listing.files.length > 0,
      title: listing.title,
      creatorId: listing.creatorId,
      creatorName: listing.creatorName
    };
  }

  async *discover(context: DiscoveryContext): AsyncIterable<SourcePost> {
    const listing = await this.list(context.target, context.signal);
    yield this.postFrom(context.target, listing);
  }

  async resolveAssets(post: SourcePost, policy: QualityPolicy): Promise<AssetManifest> {
    assertPresetSupported(policy);
    const target = this.targetOfPost(post);
    const listing = await this.list(target);

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
    return this.tool.stageOneFile(context.workspace, asset.assetIndex, maxBytes, (scratch) => buildToolArguments([
      ...COMMON_OPTIONS,
      '-D', scratch,
      '-f', FILENAME_TEMPLATE,
      '--range', String(asset.assetIndex + 1),
      '--filesize-max', String(maxBytes)
    ], [target.canonicalUrl]), context.signal);
  }

  private async list(target: CanonicalTarget, signal?: AbortSignal): Promise<PostListing> {
    const result = await this.tool.runMetadata(buildToolArguments([...COMMON_OPTIONS, '--dump-json'], [target.canonicalUrl]), signal);
    return readListing(result, target);
  }

  private postFrom(target: CanonicalTarget, listing: PostListing): SourcePost {
    return {
      adapterId: GALLERY_DL_ADAPTER_ID,
      sourceType: target.sourceType,
      platformPostId: target.platformId,
      creator: { platformId: listing.creatorId, displayName: listing.creatorName },
      title: listing.title,
      publishedAt: listing.date,
      // No revision field is known for these sites; the key changes when the date or the file list changes.
      revisionKey: `l-${createHash('sha256')
        .update(`${target.platformId}|${listing.date ?? ''}|${listing.files.map((file) => file.extension ?? '?').join(',')}`)
        .digest('hex').slice(0, 24)}`,
      canonicalUrl: target.canonicalUrl
    };
  }

  /** Re-validates the URL stored in a post, so a tampered post cannot reach the tool. */
  private targetOfPost(post: SourcePost): CanonicalTarget {
    if (post.adapterId !== GALLERY_DL_ADAPTER_ID) throw new AdapterError('TARGET_INVALID', 'Post belongs to a different adapter');
    const target = this.validateTarget(post.canonicalUrl);
    if (target.canonicalUrl !== post.canonicalUrl || target.platformId !== post.platformPostId || target.sourceType !== post.sourceType) {
      throw new AdapterError('TARGET_INVALID', 'Post does not match its canonical URL');
    }
    return target;
  }

  private pixivTarget(segments: string[]): CanonicalTarget {
    // /artworks/ID or /<language>/artworks/ID
    const rest = segments[0] === 'artworks' ? segments : segments.length === 3 && /^[a-z]{2}(-[a-z]{2})?$/.test(segments[0]!) ? segments.slice(1) : undefined;
    if (!rest || rest[0] !== 'artworks' || rest.length !== 2) {
      throw new AdapterError('TARGET_UNSUPPORTED', 'Only single Pixiv artworks are supported');
    }
    const id = rest[1]!;
    if (!NUMERIC_ID.test(id)) throw new AdapterError('TARGET_INVALID', 'Pixiv artwork id has an unexpected format');
    return this.targetOf('pixiv', `https://www.pixiv.net/artworks/${id}`, id);
  }

  private instagramTarget(segments: string[]): CanonicalTarget {
    const kind = segments[0];
    if ((kind === 'p' || kind === 'reel') && segments.length >= 2) {
      const id = segments[1]!;
      if (!INSTAGRAM_ID.test(id)) throw new AdapterError('TARGET_INVALID', 'Instagram post id has an unexpected format');
      return this.targetOf('instagram', `https://www.instagram.com/${kind}/${id}/`, id);
    }
    throw new AdapterError('TARGET_UNSUPPORTED', 'Only single Instagram posts and reels are supported; profiles are not');
  }

  private patreonTarget(segments: string[]): CanonicalTarget {
    if (segments[0] !== 'posts' || segments.length !== 2) {
      throw new AdapterError('TARGET_UNSUPPORTED', 'Only single Patreon posts are supported');
    }
    const match = PATREON_SLUG.exec(segments[1]!);
    if (!match) throw new AdapterError('TARGET_INVALID', 'Patreon post slug has an unexpected format');
    return this.targetOf('patreon', `https://www.patreon.com/posts/${segments[1]}`, match[1]!);
  }

  private targetOf(sourceType: SourceType, canonicalUrl: string, platformId: string): CanonicalTarget {
    return { adapterId: GALLERY_DL_ADAPTER_ID, sourceType, kind: 'post', canonicalUrl, platformId };
  }
}

function assertPresetSupported(policy: QualityPolicy): void {
  if (policy.preset !== 'BEST_AVAILABLE' && policy.preset !== 'SOURCE_BYTES') {
    throw new AdapterError('POLICY_UNSUPPORTED', `Preset ${policy.preset} is not supported by the gallery-dl adapter`);
  }
}

/**
 * Reads the `--dump-json` message list: `[3, url, metadata]` entries are
 * files, `[2, metadata]` entries are directory info and are ignored. The
 * file URLs themselves are not kept.
 */
function readListing(result: ProcessResult, target: CanonicalTarget): PostListing {
  const hasOutput = result.untrustedStdout.trim().length > 0;
  if (result.exitCode !== 0 && !hasOutput) assertToolSucceeded(result, 'listing files');
  const raw = parseUntrustedJson(result.untrustedStdout);
  if (!Array.isArray(raw)) throw new AdapterError('OUTPUT_INVALID', 'gallery-dl listing is not a list');

  const files: ListedFile[] = [];
  let first: Record<string, unknown> | undefined;
  let truncated = false;
  for (const message of raw) {
    if (!Array.isArray(message) || message[0] !== 3) continue;
    const metadata = asRecord(message[2]);
    if (typeof message[1] !== 'string' || !metadata) continue;
    if (files.length >= MAX_FILES_PER_POST) {
      truncated = true;
      break;
    }
    first ??= metadata;
    const number = positiveInteger(metadata.num, 100_000);
    files.push({
      index: files.length,
      sourceAssetId: `file-${number ?? files.length + 1}`,
      extension: typeof metadata.extension === 'string' && /^[A-Za-z0-9]{1,5}$/.test(metadata.extension) ? metadata.extension.toLowerCase() : null,
      name: cleanText(metadata.filename, 200),
      width: positiveInteger(metadata.width),
      height: positiveInteger(metadata.height)
    });
  }

  const postId = first ? postIdOf(first, target) : null;
  assertSamePost(target, postId, first);
  const user = asRecord(first?.user) ?? asRecord(first?.creator) ?? asRecord(first?.owner);
  const parsedDate = typeof first?.date === 'string' ? new Date(first.date) : undefined;
  const incomplete = truncated
    ? { code: 'LISTING_TRUNCATED', message: `More than ${MAX_FILES_PER_POST} files; the list was cut off` }
    : result.exitCode !== 0
      ? { code: 'TOOL_REPORTED_ERRORS', message: `The tool exited with code ${result.exitCode} after listing; the list may be partial` }
      : null;
  return {
    creatorId: identifierText(user?.id, /^[\w.@:-]{1,100}$/) ?? 'unknown',
    creatorName: cleanText(user?.name ?? user?.full_name, 200),
    title: cleanText(first?.title, 300),
    date: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null,
    files,
    incomplete
  };
}

function postIdOf(metadata: Record<string, unknown>, target: CanonicalTarget): string | null {
  if (target.sourceType === 'instagram') return identifierText(metadata.post_shortcode, INSTAGRAM_ID);
  return identifierText(metadata.id, NUMERIC_ID);
}

/**
 * The tool was given the target URL, so its files must belong to that post.
 * A different id means a redirect or an extractor surprise: stop.
 * Instagram's shortcode key is not verified against a real run, so for
 * Instagram a missing key is tolerated while a wrong one is not.
 */
function assertSamePost(target: CanonicalTarget, postId: string | null, first: Record<string, unknown> | undefined): void {
  if (!first) return;
  if (postId === null) {
    if (target.sourceType === 'instagram') return;
    throw new AdapterError('OUTPUT_INVALID', 'gallery-dl metadata has no usable post id');
  }
  if (postId !== target.platformId) {
    throw new AdapterError('OUTPUT_INVALID', 'gallery-dl returned files for a different post than requested');
  }
}
