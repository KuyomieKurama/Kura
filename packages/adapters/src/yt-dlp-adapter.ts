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
import { extensionForMediaType, mediaTypeForExtension } from './media.js';
import { parseHttpsTarget } from './target-url.js';
import type {
  AdapterCapabilities,
  AssetManifest,
  CanonicalTarget,
  DiscoveryContext,
  DownloadContext,
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

export const YT_DLP_ADAPTER_ID = 'yt-dlp';

/**
 * Security floor from D-007: the 2026.07.04 release fixed the advisories
 * about --exec, --netrc-cmd, --write-link and aria2c. Older builds are
 * never started, whatever the hash says.
 */
export const YT_DLP_MINIMUM_VERSION = '2026.07.04';

export interface YtDlpAdapterOptions extends CliToolOptions {
  /** May only raise the floor; a lower value than YT_DLP_MINIMUM_VERSION is ignored. */
  readonly minimumVersion?: string;
}

/**
 * Options present in every yt-dlp call. Nothing here reads configuration,
 * caches or updates, and none of the options from the 2026 advisories
 * (--exec, --netrc-cmd, --write-link, external downloaders) is ever passed.
 */
const COMMON_OPTIONS = ['--ignore-config', '--no-update', '--no-cache-dir', '--no-playlist', '--no-warnings'] as const;
const OUTPUT_TEMPLATE = 'asset.%(ext)s';
const FORMAT_BEST_AVAILABLE = 'bestvideo*+bestaudio/best';

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
const INSTAGRAM_HOSTS = new Set(['instagram.com', 'www.instagram.com']);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const INSTAGRAM_ID = /^[A-Za-z0-9_-]{5,40}$/;

interface VideoInfo {
  readonly id: string;
  readonly title: string | null;
  readonly creatorId: string;
  readonly creatorName: string | null;
  readonly uploadDate: string | null;
  readonly duration: number | null;
  readonly extension: string | null;
  readonly width: number | null;
  readonly height: number | null;
}

/**
 * yt-dlp as a CLI adapter (docs/planning/04). Arguments are built only from
 * the validated target, the quality preset and numbers Kura computed; the JSON
 * the tool prints is untrusted data and never turns into an option (D-007).
 * Capabilities are what the code implements for single videos; playlists,
 * channels and profiles are not offered.
 */
export class YtDlpAdapter implements SourceAdapter {
  private readonly tool: CliTool;

  private constructor(options: YtDlpAdapterOptions, private readonly version: string) {
    this.tool = new CliTool(options);
  }

  /**
   * Asks the binary (after the runner's hash check) for its version and
   * enforces the security floor before an adapter instance exists.
   */
  static async create(options: YtDlpAdapterOptions): Promise<YtDlpAdapter> {
    const version = await new CliTool(options).readVersionLine();
    const parsed = parseVersion(version);
    if (!parsed) throw new AdapterError('BINARY_VERSION_REJECTED', 'yt-dlp reported a version in an unexpected format', version);
    const floor = [YT_DLP_MINIMUM_VERSION, options.minimumVersion]
      .map((value) => (value === undefined ? undefined : parseVersion(value)))
      .filter((value): value is number[] => value !== undefined)
      .reduce((highest, value) => (compareVersions(value, highest) > 0 ? value : highest));
    if (compareVersions(parsed, floor) < 0) {
      throw new AdapterError('BINARY_VERSION_REJECTED', `yt-dlp ${version} is older than the required ${floor.join('.')}`);
    }
    return new YtDlpAdapter(options, version);
  }

  capabilities(): AdapterCapabilities {
    return {
      adapterId: YT_DLP_ADAPTER_ID,
      adapterVersion: this.version,
      sourceTypes: ['youtube', 'instagram'],
      single_post: true,
      creator_feed: false,
      pagination: false,
      resume: false,
      images: false,
      videos: true,
      page_snapshot: false,
      quality_variants: false,
      auth_kind: 'none', // no credential channel in this slice; sources that need a login will fail
      presets: ['BEST_AVAILABLE']
    };
  }

  validateTarget(url: string): CanonicalTarget {
    const parsed = parseHttpsTarget(url);
    const host = parsed.hostname.toLowerCase();
    const segments = parsed.pathname.split('/').filter(Boolean);

    if (YOUTUBE_HOSTS.has(host)) return this.youtubeTarget(parsed, host, segments);
    if (INSTAGRAM_HOSTS.has(host)) return this.instagramTarget(host, segments);
    if (host === 'pixiv.net' || host.endsWith('.pixiv.net')) {
      throw new AdapterError('TARGET_UNSUPPORTED', 'Pixiv is only supported through gallery-dl (D-008)');
    }
    throw new AdapterError('TARGET_UNSUPPORTED', 'This host is not enabled for yt-dlp');
  }

  async probe(context: ProbeContext): Promise<SourceSummary> {
    const info = await this.fetchInfo(context.target, context.signal);
    return {
      target: context.target,
      available: true,
      title: info.title,
      creatorId: info.creatorId,
      creatorName: info.creatorName
    };
  }

  async *discover(context: DiscoveryContext): AsyncIterable<SourcePost> {
    const info = await this.fetchInfo(context.target, context.signal);
    yield {
      adapterId: YT_DLP_ADAPTER_ID,
      sourceType: context.target.sourceType,
      platformPostId: context.target.platformId,
      creator: { platformId: info.creatorId, displayName: info.creatorName },
      title: info.title,
      publishedAt: isoDate(info.uploadDate),
      // yt-dlp reports no revision. Title edits are deliberately not part of the key: they must not trigger a re-download.
      revisionKey: `d-${createHash('sha256').update(`${info.id}|${info.uploadDate ?? ''}|${info.duration ?? ''}`).digest('hex').slice(0, 24)}`,
      canonicalUrl: context.target.canonicalUrl
    };
  }

  async resolveAssets(post: SourcePost, policy: QualityPolicy): Promise<AssetManifest> {
    assertPresetSupported(policy);
    const target = this.targetOfPost(post);
    const info = await this.fetchInfo(target);
    const mediaType = info.extension ? mediaTypeForExtension(info.extension) : undefined;

    const errors = mediaType ? [] : [{ code: 'ASSET_UNSUPPORTED', message: 'The reported container is not an allowed media type' }];
    const assets: ResolvedAsset[] = mediaType
      ? [{
        sourceAssetId: 'video',
        assetIndex: 0,
        originalName: `${labelFromName(info.title, info.id)}.${extensionForMediaType(mediaType)}`,
        mediaType,
        role: 'original',
        variant: 'best',
        quality: { preset: policy.preset, width: info.width, height: info.height, container: info.extension },
        declaredBytes: null, // yt-dlp sizes are estimates and are not treated as a declaration
        completeness: 'complete'
      }]
      : [];
    return {
      schemaVersion: 1,
      adapterId: YT_DLP_ADAPTER_ID,
      adapterVersion: this.version,
      sourceType: post.sourceType,
      platformPostId: post.platformPostId,
      creatorId: post.creator.platformId,
      revisionKey: post.revisionKey,
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
    const target = this.targetOfPost(context.post);
    const maxBytes = context.limits.maxBytes;
    return this.tool.stageOneFile(context.workspace, asset.assetIndex, maxBytes, () => buildToolArguments([
      ...COMMON_OPTIONS,
      '--no-progress',
      '--no-mtime',
      '--max-filesize', String(maxBytes),
      '-f', FORMAT_BEST_AVAILABLE,
      '-o', OUTPUT_TEMPLATE
    ], [target.canonicalUrl]), context.signal);
  }

  private async fetchInfo(target: CanonicalTarget, signal?: AbortSignal): Promise<VideoInfo> {
    const result = await this.tool.runMetadata(buildToolArguments([...COMMON_OPTIONS, '--dump-single-json'], [target.canonicalUrl]), signal);
    assertToolSucceeded(result, 'reading metadata');
    return readVideoInfo(parseUntrustedJson(result.untrustedStdout), target);
  }

  /** Re-validates the URL stored in a post, so a tampered post cannot reach the tool. */
  private targetOfPost(post: SourcePost): CanonicalTarget {
    if (post.adapterId !== YT_DLP_ADAPTER_ID) throw new AdapterError('TARGET_INVALID', 'Post belongs to a different adapter');
    const target = this.validateTarget(post.canonicalUrl);
    if (target.canonicalUrl !== post.canonicalUrl || target.platformId !== post.platformPostId || target.sourceType !== post.sourceType) {
      throw new AdapterError('TARGET_INVALID', 'Post does not match its canonical URL');
    }
    return target;
  }

  private youtubeTarget(parsed: URL, host: string, segments: string[]): CanonicalTarget {
    let id: string | undefined;
    if (host === 'youtu.be') {
      id = segments.length === 1 ? segments[0] : undefined;
    } else if (segments[0] === 'watch' && segments.length === 1) {
      id = parsed.searchParams.get('v') ?? undefined;
    } else if (segments[0] === 'shorts' && segments.length === 2) {
      id = segments[1];
    } else {
      throw new AdapterError('TARGET_UNSUPPORTED', 'Only single YouTube videos are supported; playlists and channels are not');
    }
    if (!id || !YOUTUBE_ID.test(id)) throw new AdapterError('TARGET_INVALID', 'YouTube video id has an unexpected format');
    return this.targetOf('youtube', `https://www.youtube.com/watch?v=${id}`, id);
  }

  private instagramTarget(host: string, segments: string[]): CanonicalTarget {
    const kind = segments[0];
    if ((kind === 'p' || kind === 'reel' || kind === 'tv') && segments.length >= 2) {
      const id = segments[1]!;
      if (!INSTAGRAM_ID.test(id)) throw new AdapterError('TARGET_INVALID', 'Instagram post id has an unexpected format');
      return this.targetOf('instagram', `https://www.instagram.com/${kind}/${id}/`, id);
    }
    if (segments.length === 1) {
      // yt-dlp's supported-sites list marks the instagram:user extractor as broken (plan 04, section 2).
      throw new AdapterError('TARGET_BROKEN', 'Instagram profiles are not supported: yt-dlp marks instagram:user as broken');
    }
    throw new AdapterError('TARGET_UNSUPPORTED', 'Only single Instagram posts and reels are supported');
  }

  private targetOf(sourceType: SourceType, canonicalUrl: string, platformId: string): CanonicalTarget {
    return { adapterId: YT_DLP_ADAPTER_ID, sourceType, kind: 'post', canonicalUrl, platformId };
  }
}

function assertPresetSupported(policy: QualityPolicy): void {
  if (policy.preset !== 'BEST_AVAILABLE') {
    throw new AdapterError('POLICY_UNSUPPORTED', `Preset ${policy.preset} is not supported by the yt-dlp adapter`);
  }
}

/** Reads only the fields Kura needs, with type and length checks; everything else is ignored. */
function readVideoInfo(raw: unknown, target: CanonicalTarget): VideoInfo {
  const record = asRecord(raw);
  if (!record) throw new AdapterError('OUTPUT_INVALID', 'yt-dlp metadata is not an object');
  if (record._type !== undefined && record._type !== 'video') {
    throw new AdapterError('OUTPUT_INVALID', 'yt-dlp returned something other than a single video');
  }
  const id = identifierText(record.id, /^[A-Za-z0-9_-]{1,64}$/);
  if (!id) throw new AdapterError('OUTPUT_INVALID', 'yt-dlp metadata has no usable video id');
  // The YouTube id format is certain, so a different id means the tool was sent somewhere else.
  if (target.sourceType === 'youtube' && id !== target.platformId) {
    throw new AdapterError('OUTPUT_INVALID', 'yt-dlp returned metadata for a different video than requested');
  }
  const uploadDate = typeof record.upload_date === 'string' && /^\d{8}$/.test(record.upload_date) ? record.upload_date : null;
  const extension = typeof record.ext === 'string' && /^[a-z0-9]{1,5}$/.test(record.ext) ? record.ext : null;
  return {
    id,
    title: cleanText(record.title, 300),
    creatorId: identifierText(record.channel_id ?? record.uploader_id, /^[\w.@:-]{1,100}$/) ?? 'unknown',
    creatorName: cleanText(record.channel ?? record.uploader, 200),
    uploadDate,
    duration: typeof record.duration === 'number' && Number.isFinite(record.duration) ? Math.round(record.duration) : null,
    extension,
    width: positiveInteger(record.width),
    height: positiveInteger(record.height)
  };
}

function isoDate(compact: string | null): string | null {
  if (!compact) return null;
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T00:00:00.000Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) || date.toISOString() !== iso ? null : iso;
}
