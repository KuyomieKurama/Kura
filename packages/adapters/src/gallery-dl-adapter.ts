import { createHash } from 'node:crypto';
import { AdapterError } from './errors.js';
import {
  buildToolArguments,
  checkedCredentialPath,
  checkedMaxPosts,
  CliTool,
  compareVersions,
  FEED_DEFAULT_MAX_POSTS_PER_RUN,
  FEED_MAX_POSTS_PER_RUN_LIMIT,
  labelFromName,
  parseVersion,
  type CliToolOptions
} from './cli-support.js';
import { failureFromProcess, type FailureContext } from './gallery-dl-output.js';
import {
  MAX_FILES_PER_POST,
  readFeedListing,
  readPostListing,
  type FeedListing,
  type PostListing,
  type UgoiraFrame
} from './gallery-dl-listing.js';
import { canonicalInstagramUrl, instagramToolUrl, parseInstagramPath, type InstagramTarget } from './instagram-target.js';
import { mediaTypeForExtension } from './media.js';
import { canonicalPatreonUrl, parsePatreonPath } from './patreon-target.js';
import { canonicalPixivUrl, parsePixivPath, pixivScopeFilter, pixivToolUrl, type PixivTarget } from './pixiv-target.js';
import { canonicalPornhubUrl, isPornhubFamilyHost, parsePornhubUrl } from './pornhub-target.js';
import { stageGeneratedFile } from './staging.js';
import { parseHttpsTarget } from './target-url.js';
import type { ProcessResult } from './process-runner.js';
import type {
  AdapterCapabilities,
  AssetManifest,
  CanonicalTarget,
  DiscoveryContext,
  DownloadContext,
  ManifestAsset,
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
   * the bound also limits the first run of a subscription. Default: FEED_DEFAULT_MAX_POSTS_PER_RUN.
   */
  readonly instagramMaxPostsPerRun?: number;
  /** The same bound for a Patreon creator (1-500). */
  readonly patreonMaxPostsPerRun?: number;
  /** The same bound for a Pixiv artist (1-500). */
  readonly pixivMaxPostsPerRun?: number;
}

export const INSTAGRAM_DEFAULT_MAX_POSTS_PER_RUN = FEED_DEFAULT_MAX_POSTS_PER_RUN;
export const INSTAGRAM_MAX_POSTS_PER_RUN_LIMIT = FEED_MAX_POSTS_PER_RUN_LIMIT;

/** Never read configuration files, so nothing from the host user's home can add options or credentials. */
const COMMON_OPTIONS = ['--config-ignore'] as const;
const FILENAME_TEMPLATE = 'asset.{extension}';

/*
 * Options per platform. Every option name below was checked against `gallery-dl --help`, the extractor source and
 * docs/configuration.rst of gallery-dl 1.32.16 (reports IG-A and P1 list each one with its source).
 *
 *  --sleep-request A-B    seconds between two HTTP requests of one extraction (a range is drawn at random).
 *  --sleep-extractor A-B  seconds before each process starts its extraction. Every file, every post and every
 *                         listing is a process of its own, and a fresh process sends its first request at once
 *                         (the request timer is per process), so without this the processes would not be spaced.
 *  --sleep A-B            seconds before each file download.
 *  --retries 0            no automatic retry inside gallery-dl: after a 429 it would sleep and ask again and
 *                         hit the metadata timeout; Kura's queue owns the back-off (waiting_rate_limit).
 *  -o extractor.instagram.videos=merged
 *                         download the ready-made video file instead of assembling DASH parts. The default
 *                         ("dash") imports a yt-dlp module inside gallery-dl, which would bypass the version
 *                         floor and hash check Kura applies to yt-dlp (D-007).
 *  -o extractor.pixiv.sanity=false
 *                         no extra web (ajax) requests for works that the API hides by "sanity level". They need
 *                         a PHPSESSID cookie, which Kura does not have; such works are listed as not retrievable.
 *  -o extractor.pixiv.ugoira=true
 *                         the ugoira as the original zip of frames (the default; the frame timing is stored by
 *                         Kura next to it). "original" (single frames) and any converting post-processor are off.
 *  -C <file>, -o extractor.<site>.cookies-update=false
 *                         cookies of the logged-in session, and do not write the session back into that file.
 *  -c <file>              the configuration file that holds the Pixiv refresh token (extractor.pixiv.refresh-token)
 *                         and the location of the cache file, so that the token never appears in an argument.
 *  --post-range 1-N       stop the feed listing after N posts.
 *  --post-filter EXPR     Pixiv "illustrations" / "manga": a fixed expression (see pixivScopeFilter).
 *
 * The delays are Kura's own choice, not gallery-dl defaults (which are 6-12 s for Instagram and none for Patreon
 * and Pixiv); they are documented in docs/vm-setup.md.
 */
interface PlatformSettings {
  readonly requestSleep: string;
  readonly extractorSleep: string;
  readonly downloadSleep: string;
  readonly fixedOptions: readonly string[];
}

const PLATFORM_SETTINGS: Readonly<Partial<Record<SourceType, PlatformSettings>>> = {
  instagram: {
    requestSleep: '8-15',
    extractorSleep: '8-15',
    downloadSleep: '2-5',
    fixedOptions: ['-o', 'extractor.instagram.videos=merged']
  },
  patreon: {
    requestSleep: '3-6',
    extractorSleep: '3-6',
    downloadSleep: '2-5',
    fixedOptions: []
  },
  pixiv: {
    requestSleep: '2-4',
    extractorSleep: '2-4',
    downloadSleep: '1-3',
    fixedOptions: ['-o', 'extractor.pixiv.sanity=false', '-o', 'extractor.pixiv.ugoira=true']
  },
  // Pornhub photo albums: Kura's own pacing, as for the other sites (extractor/pornhub.py sets the age cookie itself).
  pornhub: {
    requestSleep: '2-4',
    extractorSleep: '2-4',
    downloadSleep: '1-3',
    fixedOptions: []
  }
};

/** Reading a feed is slow by design (pacing between requests, extra requests per post). */
const FEED_LISTING_TIMEOUT_MS = 30 * 60_000;

const PIXIV_HOSTS = new Set(['pixiv.net', 'www.pixiv.net']);
const INSTAGRAM_HOSTS = new Set(['instagram.com', 'www.instagram.com']);
const PATREON_HOSTS = new Set(['patreon.com', 'www.patreon.com']);

/** The asset of a Pixiv ugoira that carries the frame timing (generated by Kura, not downloaded). */
const UGOIRA_TIMING_ASSET_ID = 'ugoira-timing';
const UGOIRA_TIMING_VARIANT = 'ugoira-timing';
const GENERATED_FILE_MAX_BYTES = 1024 * 1024;

type FeedSourceType = 'instagram' | 'patreon' | 'pixiv';

/**
 * gallery-dl as a CLI adapter: single posts and creator feeds of Instagram, Patreon and Pixiv.
 * The listing (`--dump-json`) is untrusted; downloads address files only by their numeric position
 * (`--range N`) in a listing of the validated URL, so no URL or name from the tool's output is ever passed
 * back as an argument. A feed is only ever listed; each of its posts is then handled like a single post.
 */
export class GalleryDlAdapter implements SourceAdapter {
  private readonly tool: CliTool;
  private readonly maxPostsPerFeed: Readonly<Record<FeedSourceType, number>>;

  private constructor(options: GalleryDlAdapterOptions, private readonly version: string) {
    this.tool = new CliTool(options);
    this.maxPostsPerFeed = {
      instagram: checkedMaxPosts('instagramMaxPostsPerRun', options.instagramMaxPostsPerRun),
      patreon: checkedMaxPosts('patreonMaxPostsPerRun', options.patreonMaxPostsPerRun),
      pixiv: checkedMaxPosts('pixivMaxPostsPerRun', options.pixivMaxPostsPerRun)
    };
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
   * The flat values are the union over all source types; `bySourceType` states what each platform really offers.
   * Instagram: single posts and reels work without a login in principle (often Instagram answers with a login wall
   * anyway), profiles need a logged-in session in practice, so `auth_kind` is `cookies`. Patreon: the posts of a
   * creator that the account may view, `cookies`. Pixiv: the works of an artist, `token` (OAuth refresh token);
   * ugoira are stored as zip, so `videos` is false.
   */
  capabilities(): AdapterCapabilities {
    return {
      adapterId: GALLERY_DL_ADAPTER_ID,
      adapterVersion: this.version,
      sourceTypes: ['pixiv', 'instagram', 'patreon', 'pornhub'],
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
        pixiv: { creator_feed: true, pagination: true, videos: false, auth_kind: 'token' },
        patreon: { creator_feed: true, pagination: true, videos: true, auth_kind: 'cookies' },
        // Pornhub: one photo album as a post (/album/<number>); videos and video lists are yt-dlp's.
        pornhub: { single_post: true, creator_feed: false, pagination: false, images: true, videos: false, auth_kind: 'none' }
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
    if (isPornhubFamilyHost(host)) return this.pornhubTarget(parsed, host, segments);
    throw new AdapterError('TARGET_UNSUPPORTED', 'This host is not enabled for gallery-dl');
  }

  async probe(context: ProbeContext): Promise<SourceSummary> {
    const target = this.recheck(context.target);
    if (target.kind === 'creator_feed') {
      // One post is enough to learn who the creator is, and a login problem shows up here after a few requests.
      const feed = await this.listFeed(target, 1, context.signal, context.credentials);
      const first = feed.posts[0];
      return {
        target: context.target,
        // Instagram throws for an empty listing (an expired session looks like that); the other platforms list a
        // creator without posts as an empty one, which is a fine target.
        available: true,
        title: first?.creatorName ? `${PLATFORM_LABELS[target.sourceType]}: ${first.creatorName}` : null,
        creatorId: first?.creatorId ?? null,
        creatorName: first?.creatorName ?? null
      };
    }
    const listing = await this.listPost(target, context.signal, context.credentials);
    return {
      target: context.target,
      // Patreon and Pixiv print the post itself even when nothing can be fetched from it (locked, embed only).
      available: listing.files.length > 0 || (listing.hasPostEntry && target.sourceType !== 'instagram'),
      title: listing.title,
      creatorId: listing.creatorId,
      creatorName: listing.creatorName
    };
  }

  async *discover(context: DiscoveryContext): AsyncIterable<SourcePost> {
    const target = this.recheck(context.target);
    if (target.kind === 'creator_feed') {
      const feed = await this.listFeed(target, this.maxPostsPerFeed[feedTypeOf(target)], context.signal, context.credentials);
      for (const listing of feed.posts) yield this.feedPostFrom(target.sourceType, listing);
      // Posts that were listed before the tool stopped are delivered first; the run then ends with the error
      // (login, throttling) instead of looking like a complete, quiet feed.
      if (feed.stoppedBy) throw feed.stoppedBy;
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
    const patreon = target.sourceType === 'patreon';
    for (const file of listing.files) {
      const mediaType = file.extension ? mediaTypeForExtension(file.extension) : undefined;
      if (patreon && file.viaYtdl) {
        assets.push(unavailableAsset(file.index, file.sourceAssetId, 'Videostream (HLS)', 'application/octet-stream', policy, {
          code: 'ASSET_UNSUPPORTED',
          message: 'Nicht unterstützt: Videostream (HLS) von Patreon. gallery-dl würde dafür ein eigenes yt-dlp-Modul laden, das Kura nicht prüfen kann.'
        }));
      } else if (!mediaType || !file.extension) {
        if (patreon) {
          const label = file.extension ? `.${file.extension}` : 'unbekannt';
          assets.push(unavailableAsset(file.index, file.sourceAssetId, `Datei (${label})`, 'application/octet-stream', policy, {
            code: 'ASSET_UNSUPPORTED',
            message: `Nicht unterstützt: Dateityp ${label}. Erlaubt sind Bilder, Videos, Audio, PDF und ZIP.`
          }));
        } else {
          errors.push({ code: 'ASSET_UNSUPPORTED', message: `File ${file.index + 1} has a type that is not allowed` });
        }
      } else {
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
    }

    let nextIndex = listing.files.length;
    for (const [number, embed] of listing.embeds.entries()) {
      const where = embed.provider ?? 'einer anderen Seite';
      assets.push(unavailableAsset(nextIndex, `embed-${number}`, `Eingebettetes Video (${embed.provider ?? 'andere Seite'})`, 'application/octet-stream', policy, {
        code: 'ASSET_UNSUPPORTED',
        message: `Nicht unterstützt: Video oder Medium von ${where}, das in den Beitrag eingebettet ist. Dafür gibt es keinen Adapter; der Beitrag auf Patreon enthält es weiterhin.`
      }));
      nextIndex += 1;
    }
    if (listing.locked) {
      assets.push(unavailableAsset(nextIndex, 'locked', 'Beitrag nicht zugänglich', 'application/octet-stream', policy, {
        code: 'ASSET_NOT_ACCESSIBLE',
        message: 'Der Beitrag ist für das hinterlegte Patreon-Konto nicht zugänglich (zum Beispiel nur für Mitglieder einer höheren Stufe). Er wird erneut geprüft, sobald sich der Beitrag ändert.'
      }));
      nextIndex += 1;
    }
    if (target.sourceType === 'pixiv' && listing.hasPostEntry && listing.files.length === 0) {
      assets.push(unavailableAsset(nextIndex, 'not-retrievable', 'Werk nicht abrufbar', 'application/octet-stream', policy, {
        code: 'ASSET_NOT_ACCESSIBLE',
        message: 'Das Werk liefert für das hinterlegte Pixiv-Konto keine Datei (eingeschränkt, nur für "My pixiv", gelöscht oder von Pixiv ausgeblendet).'
      }));
      nextIndex += 1;
    }
    if (listing.workType === 'ugoira' && listing.files.length > 0) {
      if (listing.ugoiraFrames) {
        assets.push(ugoiraTimingAsset(nextIndex, listing.postId ?? post.platformPostId, policy));
      } else {
        errors.push({ code: 'UGOIRA_TIMING_MISSING', message: 'The tool printed no usable frame timing for the ugoira' });
      }
    }

    if (listing.incomplete) errors.push(listing.incomplete);
    if (assets.length === 0) errors.push({ code: 'NO_FILES', message: 'The tool listed no files for this post' });

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
    if (!Number.isInteger(asset.assetIndex) || asset.assetIndex < 0 || asset.assetIndex >= MAX_FILES_PER_POST + 16) {
      throw new AdapterError('TARGET_INVALID', 'Asset index is outside the supported range');
    }
    if (asset.unavailable) throw new AdapterError('STAGING_REJECTED', 'The asset is marked as not retrievable and is never downloaded');
    const target = this.targetOfPost(context.post);
    if (asset.sourceAssetId === UGOIRA_TIMING_ASSET_ID) return this.stageUgoiraTiming(asset, context, target);
    if (asset.assetIndex >= MAX_FILES_PER_POST) throw new AdapterError('TARGET_INVALID', 'Asset index is outside the supported range');

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

  /**
   * The frame timing of a Pixiv ugoira, next to the archive of frames (plan 04: "Originalgruppe mit Timingdaten").
   * The timing is part of the work's metadata, not a file, so the post is listed once more and the frames are
   * written as a small JSON file by Kura. Nothing is converted.
   */
  private async stageUgoiraTiming(asset: ResolvedAsset, context: StageContext, target: CanonicalTarget): Promise<StagedFile> {
    if (target.sourceType !== 'pixiv') throw new AdapterError('TARGET_INVALID', 'Only Pixiv works have a frame timing');
    const listing = await this.listPost(target, context.signal, context.credentials);
    if (!listing.ugoiraFrames) throw new AdapterError('OUTPUT_INVALID', 'gallery-dl printed no usable frame timing for the ugoira');
    const content = JSON.stringify({
      schema: 'kura-ugoira-timing-1',
      source: 'pixiv',
      workId: target.platformId,
      // The zip next to this file holds these frames; "delay" is the display time of a frame in milliseconds.
      frames: listing.ugoiraFrames.map((frame: UgoiraFrame) => ({ file: frame.file, delay: frame.delay }))
    }, null, 2);
    return stageGeneratedFile(Buffer.from(`${content}\n`, 'utf8'), context.workspace, asset.assetIndex, { extension: 'json', mediaType: 'application/json' }, GENERATED_FILE_MAX_BYTES);
  }

  // --- listing ------------------------------------------------------------------------------

  /** All files of one post. Several `[2, ...]` entries (a tool that splits a post) are read as one file list. */
  private async listPost(target: CanonicalTarget, signal?: AbortSignal, credentials?: RunCredentials): Promise<PostListing> {
    const failureContext = failureContextOf(target, credentials);
    const result = await this.runMetadata(buildToolArguments([
      ...COMMON_OPTIONS,
      '--dump-json',
      ...sourceOptions(target, credentials, 'list')
    ], [toolUrlOf(target)]), signal);
    return readPostListing(result, target, failureContext);
  }

  /** The newest `maxPosts` posts of a feed (Instagram profile or reels tab, Patreon creator, Pixiv artist), newest first. */
  private async listFeed(target: CanonicalTarget, maxPosts: number, signal?: AbortSignal, credentials?: RunCredentials): Promise<FeedListing> {
    const failureContext = failureContextOf(target, credentials);
    const result = await this.runMetadata(buildToolArguments([
      ...COMMON_OPTIONS,
      '--dump-json',
      ...sourceOptions(target, credentials, 'list'),
      ...feedFilterOptions(target),
      '--post-range', `1-${maxPosts}`
    ], [toolUrlOf(target)]), signal, FEED_LISTING_TIMEOUT_MS);
    return readFeedListing(result, failureContext, maxPosts);
  }

  /**
   * Runs a metadata process. A process that gallery-dl itself made wait for a rate limit (Pixiv sleeps five minutes
   * after "rate limit", extractor/pixiv.py `_call`) is killed by the timeout; its log says why, and that is a
   * rate limit for Kura, not a defect.
   */
  private async runMetadata(args: string[], signal?: AbortSignal, timeoutMs?: number): Promise<ProcessResult> {
    try {
      return await this.tool.runMetadata(args, signal, timeoutMs);
    } catch (error) {
      if (error instanceof AdapterError && error.code === 'PROCESS_TIMEOUT' && /Waiting for .{1,40} \(rate limit\)/.test(error.untrustedDiagnostics ?? '')) {
        throw new AdapterError('RATE_LIMITED', 'The source reported a rate limit and the tool was waiting for it', error.untrustedDiagnostics);
      }
      throw error;
    }
  }

  // --- posts --------------------------------------------------------------------------------

  private postFrom(target: CanonicalTarget, listing: PostListing): SourcePost {
    return this.buildPost({ sourceType: target.sourceType, platformPostId: target.platformId, canonicalUrl: target.canonicalUrl }, listing);
  }

  /** A post found in a feed: it is addressed by its own post URL from here on. */
  private feedPostFrom(sourceType: SourceType, listing: PostListing): SourcePost {
    const id = listing.postId!;
    const canonicalUrl = sourceType === 'instagram'
      ? canonicalInstagramUrl({ kind: 'post', shortcode: id, postType: listing.postType })
      : sourceType === 'patreon'
        ? canonicalPatreonUrl({ kind: 'post', slugAndId: id, postId: id })
        : canonicalPixivUrl({ kind: 'artwork', artworkId: id });
    return this.buildPost({ sourceType, platformPostId: id, canonicalUrl }, listing);
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
        .update(`${identity.platformPostId}|${listing.date ?? ''}|${listing.files.map((file) => file.extension ?? '?').join(',')}|${listing.locked ? 'locked' : ''}`)
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
    const parsed: PixivTarget = parsePixivPath(segments);
    return this.targetOf(
      'pixiv',
      parsed.kind === 'user' ? 'creator_feed' : 'post',
      canonicalPixivUrl(parsed),
      parsed.kind === 'user' ? parsed.userId : parsed.artworkId
    );
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
    const parsed = parsePatreonPath(segments);
    return this.targetOf(
      'patreon',
      parsed.kind === 'creator' ? 'creator_feed' : 'post',
      canonicalPatreonUrl(parsed),
      parsed.kind === 'creator' ? parsed.slug : parsed.postId
    );
  }

  private pornhubTarget(parsed: URL, host: string, segments: string[]): CanonicalTarget {
    const target = parsePornhubUrl(host, segments, parsed.searchParams);
    // Videos and video lists are yt-dlp's; this adapter answers for photo albums only.
    if (target.kind !== 'album') throw new AdapterError('TARGET_UNSUPPORTED', 'Pornhub videos and video lists are handled by yt-dlp');
    return this.targetOf('pornhub', 'post', canonicalPornhubUrl(target), target.albumId);
  }

  private targetOf(sourceType: SourceType, kind: TargetKind, canonicalUrl: string, platformId: string): CanonicalTarget {
    return { adapterId: GALLERY_DL_ADAPTER_ID, sourceType, kind, canonicalUrl, platformId };
  }
}

const PLATFORM_LABELS: Readonly<Record<SourceType, string>> = {
  direct_media: 'Direkte Medien-URL', youtube: 'YouTube', instagram: 'Instagram', patreon: 'Patreon', pixiv: 'Pixiv', pornhub: 'Pornhub'
};

function assertPresetSupported(policy: QualityPolicy): void {
  if (policy.preset !== 'BEST_AVAILABLE' && policy.preset !== 'SOURCE_BYTES') {
    throw new AdapterError('POLICY_UNSUPPORTED', `Preset ${policy.preset} is not supported by the gallery-dl adapter`);
  }
}

function feedTypeOf(target: CanonicalTarget): FeedSourceType {
  if (target.sourceType === 'instagram' || target.sourceType === 'patreon' || target.sourceType === 'pixiv') return target.sourceType;
  throw new AdapterError('TARGET_INVALID', 'This source type has no feed');
}

// --- assets ------------------------------------------------------------------------------------

function unavailableAsset(
  assetIndex: number,
  sourceAssetId: string,
  originalName: string,
  mediaType: string,
  policy: QualityPolicy,
  unavailable: NonNullable<ManifestAsset['unavailable']>
): ResolvedAsset {
  return {
    sourceAssetId,
    assetIndex,
    originalName,
    mediaType,
    role: 'original',
    variant: 'original',
    quality: { preset: policy.preset, width: null, height: null, container: null },
    declaredBytes: null,
    completeness: 'incomplete',
    unavailable
  };
}

function ugoiraTimingAsset(assetIndex: number, workId: string, policy: QualityPolicy): ResolvedAsset {
  return {
    sourceAssetId: UGOIRA_TIMING_ASSET_ID,
    assetIndex,
    originalName: `${workId}_ugoira_timing.json`,
    mediaType: 'application/json',
    role: 'variant',
    variant: UGOIRA_TIMING_VARIANT,
    quality: { preset: policy.preset, width: null, height: null, container: 'json' },
    declaredBytes: null,
    completeness: 'complete'
  };
}

// --- arguments -------------------------------------------------------------------------------

/**
 * The URL given to the tool. An Instagram profile gets its explicit /posts/ page (see instagramToolUrl), a Pixiv
 * artist always the /artworks page (the other pages are the same extractor, see pixiv-target.ts).
 */
function toolUrlOf(target: CanonicalTarget): string {
  const segments = new URL(target.canonicalUrl).pathname.split('/').filter(Boolean);
  if (target.sourceType === 'instagram') return instagramToolUrl(parseInstagramPath(segments));
  if (target.sourceType === 'pixiv') return pixivToolUrl(parsePixivPath(segments));
  return target.canonicalUrl;
}

function failureContextOf(target: CanonicalTarget, credentials: RunCredentials | undefined): FailureContext {
  return {
    sourceType: target.sourceType,
    scope: target.kind === 'creator_feed' ? 'profile' : 'post',
    hasLogin: loginOptionOf(target.sourceType, credentials) !== undefined
  };
}

/** The credential path that matters for this platform, if the worker handed one over. */
function loginOptionOf(sourceType: SourceType, credentials: RunCredentials | undefined): { kind: 'cookies' | 'config'; path: string } | undefined {
  if (!credentials) return undefined;
  if ((sourceType === 'instagram' || sourceType === 'patreon') && credentials.cookiesFilePath !== undefined) {
    return { kind: 'cookies', path: credentials.cookiesFilePath };
  }
  if (sourceType === 'pixiv' && credentials.configFilePath !== undefined) return { kind: 'config', path: credentials.configFilePath };
  return undefined;
}

/**
 * Options that depend on the platform. Only fixed strings and numbers computed by Kura end up here; the one
 * variable value is the path of the cookies or configuration file the worker provides, checked for shape and
 * passed as the value of -C or -c. The file itself is never opened by Kura, and what is inside (cookies, the
 * Pixiv token) never reaches an argument.
 */
function sourceOptions(target: CanonicalTarget, credentials: RunCredentials | undefined, phase: 'list' | 'download'): string[] {
  const sourceType = target.sourceType;
  const settings = PLATFORM_SETTINGS[sourceType];
  if (!settings) return [];
  const options = [
    '--sleep-request', settings.requestSleep,
    '--sleep-extractor', settings.extractorSleep,
    '--retries', '0',
    ...settings.fixedOptions
  ];
  if (phase === 'download') options.push('--sleep', settings.downloadSleep);
  return [...options, ...loginOptions(sourceType, credentials)];
}

function loginOptions(sourceType: SourceType, credentials: RunCredentials | undefined): string[] {
  const login = loginOptionOf(sourceType, credentials);
  if (!login) return [];
  const path = checkedCredentialPath(login.path);
  return login.kind === 'config'
    ? ['-c', path]
    : ['-C', path, '-o', `extractor.${sourceType}.cookies-update=false`];
}

/** Pixiv: restricts the artist's feed to illustrations or to manga with gallery-dl's own post filter. */
function feedFilterOptions(target: CanonicalTarget): string[] {
  if (target.sourceType !== 'pixiv') return [];
  const parsed = parsePixivPath(new URL(target.canonicalUrl).pathname.split('/').filter(Boolean));
  const expression = parsed.kind === 'user' ? pixivScopeFilter(parsed.scope) : undefined;
  return expression === undefined ? [] : ['--post-filter', expression];
}
