import { createHash } from 'node:crypto';
import { AdapterError } from './errors.js';
import { asRecord, cleanText, identifierText, positiveInteger } from './cli-support.js';
import {
  failureFromProcess,
  failureFromToolError,
  failureOfEmptyProfileListing,
  FeedMessageReader,
  parseDumpJson,
  type FailureContext,
  type ParsedOutput,
  type ParsedPost
} from './gallery-dl-output.js';
import { INSTAGRAM_SHORTCODE } from './instagram-target.js';
import type { ProcessResult, StdoutLine } from './process-runner.js';
import type { CanonicalTarget, SourceType } from './types.js';

/**
 * What a `gallery-dl --dump-json` listing says about posts and their files, per platform (Instagram, Patreon,
 * Pixiv). Everything is untrusted: fields are optional, bounded and checked here, and nothing read here is ever
 * used as an argument of a later process. Output shapes: tests/instagram/fixtures and tests/platforms/fixtures
 * (made by the real extractors of gallery-dl 1.32.16, see generate-fixtures.py there).
 */

export const MAX_FILES_PER_POST = 1_000;
const NUMERIC_ID = /^\d{1,12}$/;
const MEDIA_ID = /^\d{1,25}$/;
const FILE_HASH = /^[0-9a-f]{32}$/;
const MAX_UGOIRA_FRAMES = 5_000;
const MAX_FRAME_DELAY_MS = 600_000;

export interface ListedFile {
  /** 0-based position in the tool's file list; the tool's --range is 1-based. */
  readonly index: number;
  readonly sourceAssetId: string;
  readonly extension: string | null;
  readonly name: string | null;
  readonly width: number | null;
  readonly height: number | null;
  /** gallery-dl would hand this file to a yt-dlp module inside itself (URL scheme "ytdl:"): Kura does not fetch it. */
  readonly viaYtdl: boolean;
}

/** One frame of a Pixiv ugoira as the Pixiv API reports it. */
export interface UgoiraFrame {
  readonly file: string;
  /** Display time of the frame in milliseconds. */
  readonly delay: number;
}

/** A video or other content of another site that is embedded in a Patreon post; gallery-dl does not fetch it. */
export interface ListedEmbed {
  /** Known provider name for the message, or null. Taken from a fixed list, never from the tool's text. */
  readonly provider: string | null;
}

export interface PostListing {
  /** The platform's id of the post as the tool printed it (Instagram: shortcode), or null if absent. */
  readonly postId: string | null;
  /** Instagram only: `reel` when the tool called the post a reel. */
  readonly postType: 'p' | 'reel';
  readonly creatorId: string;
  readonly creatorName: string | null;
  readonly title: string | null;
  readonly date: string | null;
  readonly files: readonly ListedFile[];
  /** A directory entry (the post's own metadata) was printed, even if no file followed. */
  readonly hasPostEntry: boolean;
  /** Patreon: the signed-in account may not view the post (no files are listed for it). */
  readonly locked: boolean;
  readonly embeds: readonly ListedEmbed[];
  /** Pixiv `type` of the work: illust, manga or ugoira. */
  readonly workType: string | null;
  /** Pixiv ugoira: the frame timing, or null when the work is no ugoira or the tool printed none. */
  readonly ugoiraFrames: readonly UgoiraFrame[] | null;
  /** Set when the listing cannot be taken as the full file list of the post. */
  readonly incomplete: { readonly code: string; readonly message: string } | null;
}

export interface FeedListing {
  /** Newest first, without duplicates. */
  readonly posts: readonly PostListing[];
  /** The same posts in the order the tool printed them (pinned posts come first there), for the stop rule. */
  readonly inToolOrder: readonly PostListing[];
  /** The tool stopped with an error after these posts (for example throttled on page 2). */
  readonly stoppedBy: AdapterError | null;
}

/** Embedded sites whose name may be shown. Anything else is "another site". */
const KNOWN_EMBED_HOSTS: ReadonlyMap<string, string> = new Map([
  ['youtube.com', 'YouTube'], ['youtu.be', 'YouTube'], ['vimeo.com', 'Vimeo'], ['soundcloud.com', 'SoundCloud'],
  ['twitch.tv', 'Twitch'], ['dailymotion.com', 'Dailymotion'], ['spotify.com', 'Spotify'], ['bandcamp.com', 'Bandcamp'],
  ['nicovideo.jp', 'Niconico'], ['bilibili.com', 'bilibili'], ['twitter.com', 'X'], ['x.com', 'X']
]);

function embedProvider(value: unknown): string | null {
  const url = typeof value === 'string' ? value : undefined;
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    for (const [suffix, name] of KNOWN_EMBED_HOSTS) {
      if (host === suffix || host.endsWith(`.${suffix}`)) return name;
    }
  } catch {
    // not a URL: another site
  }
  return null;
}

/**
 * Reads the output of a single-post listing. A failure of the tool without any file becomes the matching
 * AdapterError; a failure after some files makes the listing incomplete instead.
 */
export function readPostListing(result: ProcessResult, target: CanonicalTarget, context: FailureContext): PostListing {
  const hasOutput = result.untrustedStdout.trim().length > 0;
  if (result.exitCode !== 0 && !hasOutput) throw failureFromProcess(result, context, 'listing files');
  const output = parseDumpJson(result.untrustedStdout);

  const metadataList = output.posts.flatMap((post) => post.files);
  const truncated = output.posts.some((post) => post.filesTruncated);
  if (output.error && metadataList.length === 0) throw failureFromToolError(output.error, context, result.untrustedStderr);

  const merged: ParsedPost = {
    directory: output.posts[0]?.directory,
    files: metadataList.slice(0, MAX_FILES_PER_POST),
    filesTruncated: truncated || metadataList.length > MAX_FILES_PER_POST,
    ytdlFiles: new Set(output.posts.flatMap((post, postIndex) => {
      const offset = output.posts.slice(0, postIndex).reduce((sum, earlier) => sum + earlier.files.length, 0);
      return [...post.ytdlFiles].map((index) => index + offset);
    }))
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

/** Reads the listing of a creator's or user's feed: the newest `maxPosts` posts, newest first. */
export function readFeedListing(result: ProcessResult, context: FailureContext, maxPosts: number): FeedListing {
  const hasOutput = result.untrustedStdout.trim().length > 0;
  if (result.exitCode !== 0 && !hasOutput) throw failureFromProcess(result, context, 'listing posts');
  const output: ParsedOutput = parseDumpJson(result.untrustedStdout);
  const stoppedBy = output.error ? failureFromToolError(output.error, context, result.untrustedStderr) : null;

  const seen = new Set<string>();
  const listings: PostListing[] = [];
  for (const post of output.posts) {
    const listing = listingOfPost(post, context.sourceType);
    // A post without a usable id cannot be addressed later, so it cannot be archived.
    if (listing.postId === null || seen.has(listing.postId)) continue;
    seen.add(listing.postId);
    listings.push(listing);
  }

  if (listings.length === 0) {
    if (stoppedBy) throw stoppedBy;
    // Instagram answers a missing session with empty pages. Patreon and Pixiv list an empty feed as empty.
    if (context.sourceType === 'instagram') throw failureOfEmptyProfileListing(result.untrustedStderr, context);
  }
  return { posts: newestFirst(listings).slice(0, maxPosts), inToolOrder: listings.slice(0, maxPosts), stoppedBy };
}

/**
 * The posts of a feed listing printed as JSON lines, read while the tool runs: each line goes in, and every post that
 * is complete comes out as a PostListing, in the order the tool printed it. Posts without a usable id and posts seen
 * twice are left out, as in readFeedListing. Holds the post being collected and the ids of the posts handed out.
 */
export class FeedStreamReader {
  private readonly reader = new FeedMessageReader();
  private readonly seen = new Set<string>();

  constructor(private readonly sourceType: SourceType) {}

  /** Posts the tool has begun to print. gallery-dl's --post-range counts exactly these. */
  get postsBegun(): number {
    return this.reader.postsBegun;
  }

  get oversizeLines(): number {
    return this.reader.oversizeLines;
  }

  push(line: StdoutLine): PostListing | undefined {
    if (line.kind === 'oversize') {
      this.reader.dropped();
      return undefined;
    }
    return this.accept(this.reader.push(line.bytes));
  }

  finish(): PostListing | undefined {
    return this.accept(this.reader.finish());
  }

  private accept(post: ParsedPost | undefined): PostListing | undefined {
    if (!post) return undefined;
    const listing = listingOfPost(post, this.sourceType);
    if (listing.postId === null || this.seen.has(listing.postId)) return undefined;
    this.seen.add(listing.postId);
    return listing;
  }
}

/** This many known posts in a row, with nothing newer behind them, mark the end of what is new in a feed. */
export const KNOWN_POSTS_TO_STOP = 3;

/**
 * The stop rule of an incremental feed run. A feed is walked newest first; the walk can end as soon as it has
 * reached the posts that are already completely archived. That is only believed when
 *  - KNOWN_POSTS_TO_STOP consecutive posts are known (the overlap window of plan 04: a late or changed post
 *    shortly behind the newest ones is still seen), and
 *  - no post that comes after them is newer than the first of them. Pinned posts (Instagram, Patreon) are printed
 *    first although they are old; they are known, but newer posts follow them, so they are no frontier.
 * A post without a date cannot be placed in time, so such a listing never ends early. Returns how many posts of
 * `listings` are needed (up to the end of the known run), or null if the walk has to go on.
 */
export function endOfNewPosts(listings: readonly Pick<PostListing, 'postId' | 'date'>[], known: ReadonlySet<string>): number | null {
  for (let start = 0; start + KNOWN_POSTS_TO_STOP <= listings.length; start += 1) {
    const run = listings.slice(start, start + KNOWN_POSTS_TO_STOP);
    if (!run.every((listing) => listing.postId !== null && known.has(listing.postId))) continue;
    const frontierDate = run[0]!.date;
    const rest = listings.slice(start);
    if (frontierDate === null || rest.some((listing) => listing.date === null || listing.date > frontierDate)) continue;
    return start + KNOWN_POSTS_TO_STOP;
  }
  return null;
}

/**
 * Feeds can put older posts first (pinned posts on Instagram and Patreon). A stable sort by date gives "newest first"
 * whenever every post has a date; with a missing date the tool's own order is kept rather than guessing.
 */
function newestFirst(listings: PostListing[]): PostListing[] {
  if (listings.some((listing) => listing.date === null)) return listings;
  return [...listings].sort((left, right) => (left.date! < right.date! ? 1 : left.date! > right.date! ? -1 : 0));
}

/** One post as the tool printed it. Everything is optional; nothing read here is ever used as an argument. */
export function listingOfPost(post: ParsedPost, sourceType: SourceType): PostListing {
  const instagram = sourceType === 'instagram';
  const patreon = sourceType === 'patreon';
  const pixiv = sourceType === 'pixiv';
  const pornhub = sourceType === 'pornhub';
  const first = instagram ? (post.directory ?? post.files[0]) : (post.files[0] ?? post.directory);
  const workType = pixiv ? cleanText(first?.type, 20) : null;

  const files: ListedFile[] = [];
  const usedAssetIds = new Set<string>();
  for (const metadata of post.files) {
    const index = files.length;
    const preferredId = preferredAssetId(sourceType, metadata, workType, index);
    const sourceAssetId = usedAssetIds.has(preferredId) ? `file-${index}` : preferredId;
    usedAssetIds.add(sourceAssetId);
    files.push({
      index,
      sourceAssetId,
      extension: typeof metadata.extension === 'string' && /^[A-Za-z0-9]{1,5}$/.test(metadata.extension) ? metadata.extension.toLowerCase() : null,
      name: instagram ? instagramFileName(post.directory, metadata, index) : cleanText(metadata.filename, 200),
      width: positiveInteger(metadata.width),
      height: positiveInteger(metadata.height),
      viaYtdl: post.ytdlFiles.has(index)
    });
  }

  // Instagram prints the post's own data (date, owner, caption) in the directory entry; the file entries of a
  // carousel carry the date of the single item. Other sites are read from the first file, as before.
  const user = asObject(first?.user) ?? asObject(first?.creator) ?? asObject(first?.owner);
  // Pornhub albums: `gallery` holds the album (id, title); `id` of a file entry is the photo's, `user` is a plain text.
  const gallery = pornhub ? asObject(first?.gallery) : undefined;
  const dateText = typeof first?.date === 'string' ? first.date : typeof first?.post_date === 'string' ? first.post_date : undefined;
  const parsedDate = dateText === undefined ? undefined : new Date(asUtcTimestamp(dateText));
  const embed = patreon ? asObject(first?.embed) : undefined;
  return {
    postId: first
      ? (instagram ? identifierText(first.post_shortcode, INSTAGRAM_SHORTCODE) : pornhub ? identifierText(gallery?.id, NUMERIC_ID) : identifierText(first.id, NUMERIC_ID))
      : null,
    postType: first?.type === 'reel' ? 'reel' : 'p',
    creatorId: (instagram
      ? identifierText(first?.owner_id, /^[A-Za-z0-9][\w.@:-]{0,99}$/)
      : identifierText(user?.id, /^[A-Za-z0-9][\w.@:-]{0,99}$/)) ?? 'unknown',
    creatorName: instagram
      ? cleanText(first?.fullname, 200) ?? cleanText(first?.username, 200)
      : pornhub ? cleanText(first?.user, 200) : cleanText(user?.name ?? user?.full_name, 200),
    title: instagram ? firstLine(first?.description, 300) : pornhub ? cleanText(gallery?.title, 300) : cleanText(first?.title, 300),
    date: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null,
    files,
    hasPostEntry: post.directory !== undefined,
    locked: patreon && first?.current_user_can_view === false,
    embeds: embed && Object.keys(embed).length > 0 ? [{ provider: embedProvider(embed.url) ?? embedProvider(embed.provider_url) }] : [],
    workType,
    ugoiraFrames: workType === 'ugoira' ? ugoiraFramesOf(first?.frames) : null,
    incomplete: post.filesTruncated
      ? { code: 'LISTING_TRUNCATED', message: `More than ${MAX_FILES_PER_POST} files; the list was cut off` }
      : post.oversize
        ? { code: 'MESSAGE_TOO_LARGE', message: 'A message of the tool for this post was too large to read; the list of files may be incomplete' }
        : null
  };
}

/**
 * A stable id for a file, so that a changed order or a new file in a post does not make an old file look new, and
 * so that the revision key of a post (see revisionKeyOf) depends on which files it has and on nothing else.
 *  - Instagram: the media id. Pornhub: the photo id.
 *  - Patreon: the MD5 that Patreon puts into the path of the file URL (gallery-dl: `hash`, the same file keeps it).
 *  - Pixiv: the page number and a digest of the original image URL without query and file extension. The path of
 *    an original holds the upload time, so a replaced page gets another id. The single ugoira archive is "ugoira".
 * Anything the tool does not give an id for is identified by its position in the tool's file list ("file-N"),
 * which is how single posts of these sites were identified before feeds existed. A position says nothing about
 * the content, so such an id is never used to recognise an already stored file (see isContentStableAssetId).
 */
function preferredAssetId(sourceType: SourceType, metadata: Record<string, unknown>, workType: string | null, index: number): string {
  if (sourceType === 'instagram') {
    const mediaId = identifierText(metadata.media_id, MEDIA_ID);
    return mediaId ? `media-${mediaId}` : `file-${index}`;
  }
  if (sourceType === 'patreon') {
    const hash = typeof metadata.hash === 'string' && FILE_HASH.test(metadata.hash) ? metadata.hash : undefined;
    return hash ? `hash-${hash}` : `file-${index}`;
  }
  if (sourceType === 'pixiv') {
    if (workType === 'ugoira') return 'ugoira';
    const page = pixivPageId(metadata);
    return page ?? `file-${index}`;
  }
  if (sourceType === 'pornhub') {
    const photoId = identifierText(metadata.id, MEDIA_ID);
    return photoId ? `photo-${photoId}` : `file-${index}`;
  }
  return `file-${index}`;
}

/** `page-<number>-<digest>` from the original image URL of a Pixiv page; null if there is no usable URL. */
function pixivPageId(metadata: Record<string, unknown>): string | null {
  const number = typeof metadata.num === 'number' && Number.isInteger(metadata.num) && metadata.num >= 0 ? metadata.num : undefined;
  if (number === undefined || typeof metadata.url !== 'string') return null;
  try {
    const path = new URL(metadata.url).pathname.replace(/\.[A-Za-z0-9]{1,5}$/, '');
    return `page-${number}-${createHash('sha256').update(path).digest('hex').slice(0, 12)}`;
  } catch {
    return null;
  }
}

/** The frame list of an ugoira, or null if it is missing or not usable (a wrong timing would be worse than none). */
function ugoiraFramesOf(value: unknown): UgoiraFrame[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_UGOIRA_FRAMES) return null;
  const frames: UgoiraFrame[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const file = record?.file;
    const delay = record?.delay;
    if (typeof file !== 'string' || !/^\d{1,8}\.(?:jpe?g|png|gif)$/i.test(file)) return null;
    if (typeof delay !== 'number' || !Number.isInteger(delay) || delay < 0 || delay > MAX_FRAME_DELAY_MS) return null;
    frames.push({ file, delay });
  }
  return frames;
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
  // A post without files and without an id of its own (an empty listing) cannot be compared; it is reported as such.
  if (listing.files.length === 0 && (!listing.hasPostEntry || listing.postId === null)) return;
  if (listing.postId === null) throw new AdapterError('OUTPUT_INVALID', 'gallery-dl metadata has no usable post id');
  if (listing.postId !== target.platformId) {
    throw new AdapterError('OUTPUT_INVALID', 'gallery-dl returned files for a different post than requested');
  }
}
