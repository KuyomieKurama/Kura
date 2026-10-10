import { AdapterError } from './errors.js';
import {
  asRecord,
  buildToolArguments,
  checkedCredentialPath,
  checkedMaxPosts,
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
import { INSTAGRAM_RESERVED_PATHS } from './instagram-target.js';
import { extensionForMediaType, mediaTypeForExtension } from './media.js';
import { canonicalPornhubUrl, isPornhubFamilyHost, parsePornhubUrl, pornhubPlatformId, type PornhubTarget } from './pornhub-target.js';
import { videoRevisionKey } from './revision.js';
import { parseHttpsTarget } from './target-url.js';
import {
  classifyYtDlpFailure,
  errorOfEntryProblem,
  liveEntryProblem,
  readFlatListing,
  type EntryProblem,
  type FlatListing,
  type ListedEntry,
  type ListedSite,
  type YtDlpContext
} from './yt-dlp-output.js';
import { canonicalYoutubeUrl, parseYoutubeUrl, youtubePlatformId, YOUTUBE_VIDEO_ID, type YoutubeTarget } from './youtube-target.js';
import type { ProcessResult } from './process-runner.js';
import type {
  AdapterCapabilities,
  AssetManifest,
  CanonicalTarget,
  DiscoveryContext,
  DownloadContext,
  ManifestAsset,
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

export const YT_DLP_ADAPTER_ID = 'yt-dlp';

/** Version label of an instance that cannot run the tool (see forTargetValidationOnly). */
const VALIDATION_ONLY_VERSION = 'not-installed';

/**
 * Security floor from D-007: the 2026.07.04 release fixed the advisories
 * about --exec, --netrc-cmd, --write-link and aria2c. Older builds are
 * never started, whatever the hash says.
 */
export const YT_DLP_MINIMUM_VERSION = '2026.07.04';

export interface YtDlpAdapterOptions extends CliToolOptions {
  /** May only raise the floor; a lower value than YT_DLP_MINIMUM_VERSION is ignored. */
  readonly minimumVersion?: string;
  /**
   * Upper bound of videos read from a YouTube channel or playlist in one run (1-500, default 50). The listing is
   * newest first for channels, so the bound also limits the first run of a subscription.
   */
  readonly youtubeMaxPostsPerRun?: number;
  /** The same bound for a Pornhub video list (1-500, default 50). */
  readonly pornhubMaxPostsPerRun?: number;
}

/*
 * Options of every yt-dlp call. Each option below was checked against options.py of yt-dlp 2026.8.19 (the report
 * P2-implementer.md lists the line of each). Nothing here reads configuration, caches or updates, and none of the
 * options from the 2026 advisories (--exec, --netrc-cmd, --write-link, external downloaders) is ever passed.
 *
 *  --ignore-config        no configuration files of the host
 *  --no-update            never replace the binary
 *  --no-cache-dir         no cache directory
 *  --no-warnings          warnings are not output; only the ERROR lines decide anything (yt-dlp-output.ts)
 */
const COMMON_OPTIONS = ['--ignore-config', '--no-update', '--no-cache-dir', '--no-warnings'] as const;
const OUTPUT_TEMPLATE = 'asset.%(ext)s';

/*
 * Single video:
 *  --no-playlist          a URL that names a video and a list is the video (YoutubeIE / YoutubeTabIE `_yes_playlist`)
 *  -f bestvideo*+bestaudio/best
 *                         the best video stream (also one that carries audio) plus the best audio stream, merged by
 *                         ffmpeg; one file with both if the site offers no separate streams. "bv*+ba/b" is
 *                         yt-dlp's own default; spelled out so a change of the default cannot change Kura.
 *  --merge-output-format mp4/webm/mkv
 *                         containers allowed for the merge, in this order: the first one that can hold the chosen
 *                         codecs without re-encoding (YoutubeDL.py `get_compatible_ext`: mp4 for h264/av1/aac,
 *                         webm for vp9/opus, mkv for anything). No transcoding happens; all three are allowed
 *                         media types of Kura. The metadata call gets the same options so that `ext` there is the
 *                         container of the download.
 *  --abort-on-unavailable-fragments
 *                         a fragmented download that misses a fragment fails instead of being stored incomplete
 *                         (yt-dlp's default is to skip such fragments).
 */
const FORMAT_BEST_AVAILABLE = 'bestvideo*+bestaudio/best';
const MERGE_CONTAINERS = 'mp4/webm/mkv';

/*
 * Lists (channel, playlist, user, model):
 *  --yes-playlist         read the list
 *  --flat-playlist        the entries as they stand in the list; no request per video
 *  --dump-single-json     one JSON object with the list data and `entries`
 *  --playlist-items 1:N   the first N entries; later pages are not requested (the list is read lazily)
 */

/*
 * Courtesy towards the site, for YouTube and Pornhub (Kura's own choice, documented in docs/vm-setup.md):
 *  --extractor-retries 0  no automatic retry of extractor errors: after a 429 or a bot check a second request
 *                         makes it worse; Kura's queue owns the back-off (waiting_rate_limit)
 *  --sleep-requests 1     one second between two requests of an extraction
 *  --sleep-interval 3 --max-sleep-interval 8
 *                         3 to 8 seconds before each download (every download is a process of its own, so this
 *                         spaces consecutive videos)
 */
function pacingOptions(sourceType: SourceType, phase: 'metadata' | 'download'): string[] {
  if (sourceType !== 'youtube' && sourceType !== 'pornhub') return [];
  const options = ['--extractor-retries', '0', '--sleep-requests', '1'];
  if (phase === 'download') options.push('--sleep-interval', '3', '--max-sleep-interval', '8');
  return options;
}

/** Reading a list at a polite request rate. */
const FEED_LISTING_TIMEOUT_MS = 10 * 60_000;

/**
 * YouTube only: the user's cookies.txt, if the worker handed one over (`--cookies FILE`, yt-dlp options.py). Other
 * targets never get it. yt-dlp writes its cookie jar back into that file at the end; it is the run's own copy and is
 * deleted afterwards.
 */
function cookieOptions(target: CanonicalTarget, credentials: RunCredentials | undefined): string[] {
  if (target.sourceType !== 'youtube' || credentials?.cookiesFilePath === undefined) return [];
  return ['--cookies', checkedCredentialPath(credentials.cookiesFilePath)];
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
const INSTAGRAM_HOSTS = new Set(['instagram.com', 'www.instagram.com']);
const INSTAGRAM_ID = /^[A-Za-z0-9_-]{5,40}$/;
const OWNER_ID = /^[A-Za-z0-9][\w.@:-]{0,99}$/;

const PLATFORM_LABELS: Readonly<Partial<Record<SourceType, string>>> = { youtube: 'YouTube', pornhub: 'Pornhub' };

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
  readonly liveStatus: string | null;
}

type VideoOutcome = { readonly info: VideoInfo } | { readonly problem: EntryProblem };

/**
 * yt-dlp as a CLI adapter (docs/planning/04): single videos of YouTube, Instagram (posts and reels) and Pornhub,
 * and lists of videos: YouTube channels (tabs videos, shorts, streams) and playlists, Pornhub models, pornstars,
 * channels, users and playlists. Arguments are built only from the validated target, the quality preset and numbers
 * Kura computed; the JSON the tool prints is untrusted data and never turns into an option (D-007). A list is only ever
 * listed (flat, newest N); each of its videos is then handled like a single video, addressed by its own canonical URL.
 */
export class YtDlpAdapter implements SourceAdapter {
  private readonly tool: CliTool;
  private readonly maxPostsPerFeed: Readonly<Record<'youtube' | 'pornhub', number>>;

  private constructor(options: YtDlpAdapterOptions, private readonly version: string) {
    this.tool = new CliTool(options);
    this.maxPostsPerFeed = {
      youtube: checkedMaxPosts('youtubeMaxPostsPerRun', options.youtubeMaxPostsPerRun),
      pornhub: checkedMaxPosts('pornhubMaxPostsPerRun', options.pornhubMaxPostsPerRun)
    };
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

  /**
   * An instance that validates targets and lists capabilities but can never run the tool. For processes
   * that must recognise a platform without having the tool (API) and to explain "tool not installed" (worker).
   */
  static forTargetValidationOnly(): YtDlpAdapter {
    return new YtDlpAdapter(
      { binary: { path: '/nonexistent/yt-dlp', sha256: '0'.repeat(64) }, workRoot: '/nonexistent', validationOnly: true },
      VALIDATION_ONLY_VERSION
    );
  }

  /**
   * The flat values are the union over all source types; `bySourceType` states what each platform really offers.
   * YouTube: single videos, playlists and channel tabs, optional cookies (age-restricted or members-only videos).
   * Pornhub: single videos and video lists, no login. Instagram stays a fallback for single posts and reels.
   */
  capabilities(): AdapterCapabilities {
    return {
      adapterId: YT_DLP_ADAPTER_ID,
      adapterVersion: this.version,
      sourceTypes: ['youtube', 'pornhub', 'instagram'],
      single_post: true,
      creator_feed: true,
      pagination: true,
      resume: false,
      images: false,
      videos: true,
      page_snapshot: false,
      quality_variants: false,
      auth_kind: 'none',
      presets: ['BEST_AVAILABLE'],
      bySourceType: {
        youtube: { creator_feed: true, pagination: true, auth_kind: 'cookies' },
        pornhub: { creator_feed: true, pagination: true, auth_kind: 'none' },
        // Instagram goes through gallery-dl (it wins the selection); this adapter has no login and no profiles for it
        instagram: { creator_feed: false, pagination: false, auth_kind: 'none' }
      }
    };
  }

  validateTarget(url: string): CanonicalTarget {
    const parsed = parseHttpsTarget(url);
    const host = parsed.hostname.toLowerCase();
    const segments = parsed.pathname.split('/').filter(Boolean);

    if (YOUTUBE_HOSTS.has(host)) return this.youtubeTarget(parsed, host, segments);
    if (INSTAGRAM_HOSTS.has(host)) return this.instagramTarget(host, segments);
    if (isPornhubFamilyHost(host)) return this.pornhubTarget(parsed, host, segments);
    if (host === 'pixiv.net' || host.endsWith('.pixiv.net')) {
      throw new AdapterError('TARGET_UNSUPPORTED', 'Pixiv is only supported through gallery-dl (D-008)');
    }
    throw new AdapterError('TARGET_UNSUPPORTED', 'This host is not enabled for yt-dlp');
  }

  async probe(context: ProbeContext): Promise<SourceSummary> {
    const target = this.recheck(context.target);
    if (target.kind === 'creator_feed') {
      // One entry is enough to learn that the list exists and who owns it; a login or throttling problem shows up here.
      const listing = await this.listFeed(target, 1, context.signal, context.credentials);
      const label = PLATFORM_LABELS[target.sourceType];
      return {
        target: context.target,
        available: true,
        title: listing.title ? (label ? `${label}: ${listing.title}` : listing.title) : null,
        creatorId: this.feedOwner(target, listing).platformId,
        creatorName: this.feedOwner(target, listing).displayName
      };
    }
    const outcome = await this.readVideo(target, context.signal, context.credentials);
    // A video that is private, removed or live is still a target: the entry carries the reason (see resolveAssets).
    if ('problem' in outcome) return { target: context.target, available: true, title: null, creatorId: null, creatorName: null };
    return {
      target: context.target,
      available: true,
      title: outcome.info.title,
      creatorId: outcome.info.creatorId,
      creatorName: outcome.info.creatorName
    };
  }

  async *discover(context: DiscoveryContext): AsyncIterable<SourcePost> {
    const target = this.recheck(context.target);
    if (target.kind === 'creator_feed') {
      const listing = await this.listFeed(target, this.maxPostsPerFeed[feedSiteOf(target)], context.signal, context.credentials);
      for (const entry of listing.entries) yield this.feedPost(target, listing, entry);
      return;
    }
    const outcome = await this.readVideo(target, context.signal, context.credentials);
    if ('problem' in outcome) {
      // No metadata to read; the post stays addressable by its id and carries the reason once the assets are resolved.
      yield this.videoPost(target, { id: target.platformId, title: null, creatorId: 'unknown', creatorName: null, uploadDate: null, duration: null, extension: null, width: null, height: null, liveStatus: null });
      return;
    }
    yield this.videoPost(target, outcome.info);
  }

  async resolveAssets(post: SourcePost, policy: QualityPolicy, context?: ResolveContext): Promise<AssetManifest> {
    assertPresetSupported(policy);
    const target = this.targetOfPost(post);
    const outcome = await this.readVideo(target, context?.signal, context?.credentials);

    const base = {
      schemaVersion: 1 as const,
      adapterId: YT_DLP_ADAPTER_ID,
      adapterVersion: this.version,
      sourceType: post.sourceType,
      platformPostId: post.platformPostId,
      creatorId: post.creator.platformId,
      revisionKey: post.revisionKey
    };
    if ('problem' in outcome) {
      // The entry is recorded as it is: not downloadable now, with the reason; the run goes on with the next entry.
      return { ...base, discoveryComplete: true, assets: [unavailableAsset(policy, outcome.problem)], errors: [] };
    }
    const { info } = outcome;
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
    return { ...base, discoveryComplete: errors.length === 0, assets, errors };
  }

  download(asset: ResolvedAsset, context: DownloadContext): AsyncIterable<Uint8Array> {
    return this.tool.streamThroughStaging((workspace) => this.stage(asset, { ...context, workspace }));
  }

  async stage(asset: ResolvedAsset, context: StageContext): Promise<StagedFile> {
    assertPresetSupported(context.policy);
    if (asset.unavailable) throw new AdapterError('STAGING_REJECTED', 'The asset is marked as not retrievable and is never downloaded');
    const target = this.targetOfPost(context.post);
    const maxBytes = context.limits.maxBytes;
    const failureContext = contextOf(target, 'video', context.credentials);
    return this.tool.stageOneFile(context.workspace, asset.assetIndex, maxBytes, () => buildToolArguments([
      ...COMMON_OPTIONS,
      '--no-playlist',
      ...cookieOptions(target, context.credentials),
      ...pacingOptions(target.sourceType, 'download'),
      '--no-progress',
      '--no-mtime',
      '--max-filesize', String(maxBytes),
      '-f', FORMAT_BEST_AVAILABLE,
      '--merge-output-format', MERGE_CONTAINERS,
      '--abort-on-unavailable-fragments',
      '-o', OUTPUT_TEMPLATE
    ], [target.canonicalUrl]), context.signal, (result) => failureOf(result, failureContext, 'downloading'));
  }

  // --- tool calls ---------------------------------------------------------------------------------------

  /**
   * Metadata of one video. A failure that concerns the run (login, throttling, unknown) is thrown; one that concerns
   * only this video (private, removed, region, premiere) is returned as the reason for the entry.
   */
  private async readVideo(target: CanonicalTarget, signal?: AbortSignal, credentials?: RunCredentials): Promise<VideoOutcome> {
    const result = await this.tool.runMetadata(buildToolArguments([
      ...COMMON_OPTIONS,
      '--no-playlist',
      ...cookieOptions(target, credentials),
      ...pacingOptions(target.sourceType, 'metadata'),
      '-f', FORMAT_BEST_AVAILABLE,
      '--merge-output-format', MERGE_CONTAINERS,
      '--dump-single-json'
    ], [target.canonicalUrl]), signal);
    if (result.exitCode !== 0) {
      const classified = classifyYtDlpFailure(result, contextOf(target, 'video', credentials), 'reading metadata');
      if (classified.kind === 'error') throw classified.error;
      return { problem: classified.problem };
    }
    const info = readVideoInfo(parseUntrustedJson(result.untrustedStdout), target);
    // A running stream (or one that YouTube is still processing) is not recorded; the entry says so and is checked again.
    if (info.liveStatus === 'is_live' || info.liveStatus === 'post_live') return { problem: liveEntryProblem() };
    if (info.liveStatus === 'is_upcoming') {
      return { problem: { kind: 'upcoming', code: 'ASSET_NOT_YET_AVAILABLE', message: 'Das Video ist angekündigt (Premiere oder geplanter Livestream) und noch nicht abrufbar. Es wird später erneut geprüft.' } };
    }
    return { info };
  }

  /** The first `maxEntries` entries of a channel tab, playlist or Pornhub list, in the order the site delivers them. */
  private async listFeed(target: CanonicalTarget, maxEntries: number, signal?: AbortSignal, credentials?: RunCredentials): Promise<FlatListing> {
    const site = feedSiteOf(target);
    const result = await this.tool.runMetadata(buildToolArguments([
      ...COMMON_OPTIONS,
      '--yes-playlist',
      ...cookieOptions(target, credentials),
      ...pacingOptions(target.sourceType, 'metadata'),
      '--flat-playlist',
      '--dump-single-json',
      '--playlist-items', `1:${maxEntries}`
    ], [target.canonicalUrl]), signal, FEED_LISTING_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      const classified = classifyYtDlpFailure(result, contextOf(target, 'feed', credentials), 'listing videos');
      throw classified.kind === 'error' ? classified.error : errorOfEntryProblem(classified.problem);
    }
    return readFlatListing(result.untrustedStdout, site, maxEntries);
  }

  // --- posts --------------------------------------------------------------------------------------------

  private videoPost(target: CanonicalTarget, info: VideoInfo): SourcePost {
    return {
      adapterId: YT_DLP_ADAPTER_ID,
      sourceType: target.sourceType,
      platformPostId: target.platformId,
      creator: { platformId: info.creatorId, displayName: info.creatorName },
      title: info.title,
      publishedAt: isoDate(info.uploadDate),
      // yt-dlp reports no revision. Title edits, upload date and duration are deliberately not part of the key: they
      // must not trigger a re-download, and the same video must get the same key as a single video and in a list.
      revisionKey: videoRevisionKey(info.id),
      canonicalUrl: target.canonicalUrl
    };
  }

  /**
   * A video found in a list: addressed by its own canonical URL from here on. The revision depends on the id only
   * (as for a single video): a video that is already stored is never downloaded again because of a title edit or
   * a changed view count.
   */
  private feedPost(target: CanonicalTarget, listing: FlatListing, entry: ListedEntry): SourcePost {
    const canonicalUrl = target.sourceType === 'youtube'
      ? canonicalYoutubeUrl({ kind: 'video', videoId: entry.id })
      : canonicalPornhubUrl({ kind: 'video', viewKey: entry.id });
    const owner = this.feedOwner(target, listing);
    return {
      adapterId: YT_DLP_ADAPTER_ID,
      sourceType: target.sourceType,
      platformPostId: entry.id,
      creator: { platformId: entry.channelId ?? owner.platformId, displayName: entry.channelName ?? owner.displayName },
      title: entry.title,
      publishedAt: entry.publishedAt,
      revisionKey: videoRevisionKey(entry.id),
      canonicalUrl
    };
  }

  /** The owner of a list: a YouTube channel or the Pornhub account, taken from the list data or the validated address. */
  private feedOwner(target: CanonicalTarget, listing: FlatListing): { platformId: string; displayName: string | null } {
    if (target.sourceType === 'pornhub') {
      const parsed = this.pornhubParts(target);
      return parsed.kind === 'videos'
        ? { platformId: `${parsed.owner}:${parsed.name}`, displayName: parsed.name }
        : { platformId: `playlist:${parsed.kind === 'playlist' ? parsed.playlistId : 'unknown'}`, displayName: null };
    }
    return { platformId: listing.ownerId && OWNER_ID.test(listing.ownerId) ? listing.ownerId : 'unknown', displayName: listing.ownerName };
  }

  private pornhubParts(target: CanonicalTarget): PornhubTarget {
    const url = new URL(target.canonicalUrl);
    return parsePornhubUrl('www.pornhub.com', url.pathname.split('/').filter(Boolean), url.searchParams);
  }

  /** Re-validates the URL stored in a post, so a tampered post cannot reach the tool. */
  private targetOfPost(post: SourcePost): CanonicalTarget {
    if (post.adapterId !== YT_DLP_ADAPTER_ID) throw new AdapterError('TARGET_INVALID', 'Post belongs to a different adapter');
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

  // --- target grammar -----------------------------------------------------------------------------------

  private youtubeTarget(parsed: URL, host: string, segments: string[]): CanonicalTarget {
    const target: YoutubeTarget = parseYoutubeUrl(host, segments, parsed.searchParams);
    return this.targetOf('youtube', target.kind === 'video' ? 'post' : 'creator_feed', canonicalYoutubeUrl(target), youtubePlatformId(target));
  }

  private pornhubTarget(parsed: URL, host: string, segments: string[]): CanonicalTarget {
    const target = parsePornhubUrl(host, segments, parsed.searchParams);
    // Photo albums are gallery-dl's; this adapter says nothing about them and leaves the answer to gallery-dl.
    if (target.kind === 'album') throw new AdapterError('TARGET_UNSUPPORTED', 'Pornhub photo albums are handled by gallery-dl');
    return this.targetOf('pornhub', target.kind === 'video' ? 'post' : 'creator_feed', canonicalPornhubUrl(target), pornhubPlatformId(target));
  }

  private instagramTarget(host: string, segments: string[]): CanonicalTarget {
    const kind = segments[0];
    if ((kind === 'p' || kind === 'reel' || kind === 'tv') && segments.length >= 2) {
      const id = segments[1]!;
      if (!INSTAGRAM_ID.test(id)) throw new AdapterError('TARGET_INVALID', 'Instagram post id has an unexpected format');
      return this.targetOf('instagram', 'post', `https://www.instagram.com/${kind}/${id}/`, id);
    }
    if (segments.length === 1 && !INSTAGRAM_RESERVED_PATHS.has(segments[0]!.toLowerCase())) {
      // yt-dlp's supported-sites list marks the instagram:user extractor as broken (plan 04, section 2).
      // Profiles are served by gallery-dl; this answer only appears where gallery-dl is not in the picture.
      throw new AdapterError('TARGET_BROKEN', 'Instagram profiles are not supported: yt-dlp marks instagram:user as broken');
    }
    throw new AdapterError('TARGET_UNSUPPORTED', 'Only single Instagram posts and reels are supported');
  }

  private targetOf(sourceType: SourceType, kind: TargetKind, canonicalUrl: string, platformId: string): CanonicalTarget {
    return { adapterId: YT_DLP_ADAPTER_ID, sourceType, kind, canonicalUrl, platformId };
  }
}

function assertPresetSupported(policy: QualityPolicy): void {
  if (policy.preset !== 'BEST_AVAILABLE') {
    throw new AdapterError('POLICY_UNSUPPORTED', `Preset ${policy.preset} is not supported by the yt-dlp adapter`);
  }
}

function feedSiteOf(target: CanonicalTarget): 'youtube' | 'pornhub' {
  if (target.sourceType === 'youtube' || target.sourceType === 'pornhub') return target.sourceType;
  throw new AdapterError('TARGET_INVALID', 'This source type has no feed');
}

function contextOf(target: CanonicalTarget, scope: 'video' | 'feed', credentials: RunCredentials | undefined): YtDlpContext {
  const site: ListedSite = target.sourceType === 'pornhub' ? 'pornhub' : 'youtube';
  return { site, scope, hasLogin: target.sourceType === 'youtube' && credentials?.cookiesFilePath !== undefined };
}

/** A failed download: a problem of the run is thrown as it is, a problem of this video becomes a failed asset. */
function failureOf(result: ProcessResult, context: YtDlpContext, action: string): AdapterError {
  const classified = classifyYtDlpFailure(result, context, action);
  return classified.kind === 'error' ? classified.error : errorOfEntryProblem(classified.problem);
}

function unavailableAsset(policy: QualityPolicy, problem: EntryProblem): ResolvedAsset {
  const unavailable: NonNullable<ManifestAsset['unavailable']> = { code: problem.code, message: problem.message };
  return {
    sourceAssetId: 'video',
    assetIndex: 0,
    originalName: 'Video nicht abrufbar',
    mediaType: 'application/octet-stream',
    role: 'original',
    variant: 'best',
    quality: { preset: policy.preset, width: null, height: null, container: null },
    declaredBytes: null,
    completeness: 'incomplete',
    unavailable
  };
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
  // The id format of YouTube and Pornhub is certain, so a different id means the tool was sent somewhere else.
  if ((target.sourceType === 'youtube' || target.sourceType === 'pornhub') && id !== target.platformId) {
    throw new AdapterError('OUTPUT_INVALID', 'yt-dlp returned metadata for a different video than requested');
  }
  if (target.sourceType === 'youtube' && !YOUTUBE_VIDEO_ID.test(id)) throw new AdapterError('OUTPUT_INVALID', 'yt-dlp metadata has no usable video id');
  const uploadDate = typeof record.upload_date === 'string' && /^\d{8}$/.test(record.upload_date) ? record.upload_date : null;
  const extension = typeof record.ext === 'string' && /^[a-z0-9]{1,5}$/.test(record.ext) ? record.ext : null;
  const liveStatus = typeof record.live_status === 'string' ? record.live_status : record.is_live === true ? 'is_live' : null;
  return {
    id,
    title: cleanText(record.title, 300),
    creatorId: creatorIdOf(record, target) ?? 'unknown',
    creatorName: cleanText(record.channel ?? record.uploader, 200),
    uploadDate,
    duration: typeof record.duration === 'number' && Number.isFinite(record.duration) ? Math.round(record.duration) : null,
    extension,
    width: positiveInteger(record.width),
    height: positiveInteger(record.height),
    liveStatus
  };
}

/** YouTube: the channel id. Pornhub reports "/users/name"; that becomes "users:name". */
function creatorIdOf(record: Record<string, unknown>, target: CanonicalTarget): string | null {
  if (target.sourceType === 'pornhub' && typeof record.uploader_id === 'string') {
    return identifierText(record.uploader_id.replace(/^\/+/, '').replace(/\//g, ':'), OWNER_ID);
  }
  return identifierText(record.channel_id ?? record.uploader_id, OWNER_ID);
}

function isoDate(compact: string | null): string | null {
  if (!compact) return null;
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T00:00:00.000Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) || date.toISOString() !== iso ? null : iso;
}
