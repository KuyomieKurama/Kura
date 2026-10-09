import { AdapterError } from './errors.js';
import { asRecord, cleanText, identifierText, parseUntrustedJson } from './cli-support.js';
import { PORNHUB_VIEW_KEY } from './pornhub-target.js';
import type { ProcessResult } from './process-runner.js';
import type { ManifestAsset } from './types.js';
import { YOUTUBE_VIDEO_ID } from './youtube-target.js';

/**
 * Reading what yt-dlp prints and turning what went wrong into an AdapterError or a per-entry state.
 *
 * Source of the shapes: yt-dlp 2026.8.19, started with the argument lists of yt-dlp-adapter.ts. The fixtures in
 * tests/platforms/fixtures/ytdlp-* were written by the real yt-dlp code (extractor helpers, format selection and
 * the error output of the command line) on synthetic page data; see generate-ytdlp-fixtures.py there.
 *
 *  - `--flat-playlist --dump-single-json` prints ONE JSON object: `_type: "playlist"`, the playlist or channel data
 *    (`id`, `title`, `channel`, `channel_id`, `uploader`) and `entries`, each `_type: "url"` with `url`, `title`,
 *    `duration`, `live_status` (is_live / is_upcoming / was_live / null), `availability` (public, subscriber_only ...
 *    or null) and, for YouTube, `id` and the channel fields. Pornhub entries carry no `id`; the viewkey is in `url`.
 *  - Errors go to stderr as `ERROR: [extractor] id: message` and the exit code is 1.
 */

export type ListedSite = 'youtube' | 'pornhub';

export interface ListedEntry {
  /** YouTube video id or Pornhub viewkey. */
  readonly id: string;
  readonly title: string | null;
  readonly durationSeconds: number | null;
  /** is_live, is_upcoming, was_live, post_live or null, as reported by the listing. */
  readonly liveStatus: string | null;
  readonly availability: string | null;
  readonly channelId: string | null;
  readonly channelName: string | null;
  /** ISO 8601 if the listing carried a usable Unix timestamp (YouTube lists normally do not). */
  readonly publishedAt: string | null;
}

export interface FlatListing {
  readonly title: string | null;
  readonly ownerId: string | null;
  readonly ownerName: string | null;
  /** In the order the tool delivered them (the site's order: newest first for channels), without duplicates. */
  readonly entries: readonly ListedEntry[];
}

const PORNHUB_VIDEO_URL = /^https?:\/\/(?:[a-z0-9-]+\.)?pornhub\.com\/view_video\.php\?(?:[^#]*&)?viewkey=([0-9a-z]{6,32})(?:&|$)/;
const OWNER_ID = /^[A-Za-z0-9@][\w.@:/-]{0,119}$/;
const KNOWN_LIVE_STATUSES: ReadonlySet<string> = new Set(['is_live', 'is_upcoming', 'was_live', 'post_live', 'not_live']);

function entryId(site: ListedSite, entry: Record<string, unknown>): string | null {
  if (site === 'youtube') {
    // Nested results (a channel's playlists tab, a channel inside a search) have another ie_key and are not videos.
    if (entry.ie_key !== undefined && entry.ie_key !== 'Youtube') return null;
    return identifierText(entry.id, YOUTUBE_VIDEO_ID);
  }
  if (entry.ie_key !== undefined && entry.ie_key !== 'PornHub') return null;
  const fromId = identifierText(entry.id, PORNHUB_VIEW_KEY);
  if (fromId) return fromId;
  return typeof entry.url === 'string' ? PORNHUB_VIDEO_URL.exec(entry.url)?.[1] ?? null : null;
}

function isoFromUnix(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 4_102_444_800) return null;
  return new Date(Math.floor(value) * 1000).toISOString();
}

/**
 * Reads the flat listing of a channel, playlist or Pornhub video list. Everything is untrusted: fields are optional,
 * bounded and checked, ids must match their site's format, and nothing read here is ever used as an argument.
 */
export function readFlatListing(stdout: string, site: ListedSite, maxEntries: number): FlatListing {
  const record = asRecord(parseUntrustedJson(stdout));
  if (!record) throw new AdapterError('OUTPUT_INVALID', 'yt-dlp listing is not an object');
  if (record._type !== 'playlist' && record._type !== 'multi_video') {
    throw new AdapterError('OUTPUT_INVALID', 'yt-dlp returned something other than a list of videos');
  }
  if (!Array.isArray(record.entries)) throw new AdapterError('OUTPUT_INVALID', 'yt-dlp listing has no entries list');

  const seen = new Set<string>();
  const entries: ListedEntry[] = [];
  for (const raw of record.entries) {
    if (entries.length >= maxEntries) break;
    const entry = asRecord(raw);
    if (!entry) continue;
    const id = entryId(site, entry);
    // An entry without a usable id cannot be addressed later, so it cannot be archived.
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    const liveStatus = typeof entry.live_status === 'string' && KNOWN_LIVE_STATUSES.has(entry.live_status) ? entry.live_status : null;
    entries.push({
      id,
      title: cleanText(entry.title, 300),
      durationSeconds: typeof entry.duration === 'number' && Number.isFinite(entry.duration) && entry.duration >= 0 ? Math.round(entry.duration) : null,
      liveStatus,
      availability: cleanText(entry.availability, 40),
      channelId: identifierText(entry.channel_id ?? entry.uploader_id, OWNER_ID),
      channelName: cleanText(entry.channel ?? entry.uploader, 200),
      publishedAt: isoFromUnix(entry.timestamp)
    });
  }
  return {
    title: cleanText(record.title, 300),
    ownerId: identifierText(record.channel_id ?? record.uploader_id ?? record.id, OWNER_ID),
    ownerName: cleanText(record.channel ?? record.uploader ?? record.title, 200),
    entries
  };
}

// --- Failure classification ---------------------------------------------------------------------------------------

export type ToolProblem =
  | 'rate_limit'
  | 'bot_check'
  | 'members'
  | 'age'
  | 'private'
  | 'upcoming'
  | 'geo'
  | 'unavailable'
  | 'locked'
  | 'redirect'
  | 'refused'
  | 'not_found'
  | 'tab_missing'
  | 'login'
  | 'server';

/*
 * Patterns for the ERROR lines of yt-dlp. The wording of the error comes from three places: yt-dlp itself (the
 * cookies hint, "Redirection detected ...", "PornHub said: ...", "This channel does not have a ... tab", HTTP
 * errors), YouTube's player response (the reason texts, passed on by yt-dlp unchanged, for example "Sign in to
 * confirm you're not a bot", "Private video", "Video unavailable", "Premieres in ...") and Pornhub's pages. The
 * first group is from the source, the second from observed or reported YouTube wording that the source only passes
 * through, so the second group is a heuristic: it decides the German text and the retry rule, never whether
 * something was archived. Order matters: the first match wins.
 */
const PATTERNS: readonly (readonly [ToolProblem, RegExp])[] = [
  ['rate_limit', /http error 429|too many requests|rate.?limited by youtube|isn.t available, try again later/i],
  ['bot_check', /not a bot|confirm you.{1,3}re not/i],
  ['members', /members[- ]only|join this channel|channel.s members|available to members/i],
  ['age', /confirm your age|age[- ]restricted|age verification|inappropriate for some users/i],
  ['private', /private video|this video is private|video is private/i],
  ['upcoming', /premieres in|premiere will begin|live event will begin|will begin in \d|this live event|scheduled for/i],
  ['geo', /geo.?restrict|not available from your location|available in your country|blocked it in your country|unavailable in your country/i],
  ['tab_missing', /does not have an? .{1,20} tab|unable to find selected tab/i],
  ['not_found', /does not exist|failed to resolve url|http error 404|404: not found|playlist is (?:private|empty)|channel is not available|this channel (?:no longer|doesn)/i],
  ['unavailable', /video unavailable|no longer available|not available|has been removed|removed by the uploader|account associated with this video has been terminated|has been deleted|copyright|violat|pornhub said:/i],
  ['locked', /video \w+ is locked|is locked/i],
  ['redirect', /redirection detected/i],
  ['refused', /http error (?:401|403)/i],
  ['login', /sign in|log in|login required|use --cookies|only available for registered users/i],
  ['server', /http error 5\d\d|timed out|connection (?:reset|refused|aborted)|temporary failure in name resolution|network is unreachable|unable to download/i]
];

/** Looks only at the lines that yt-dlp marks as errors (warnings and progress text must not decide anything). */
export function problemOf(stderr: string): ToolProblem | undefined {
  const errors = stderr.split('\n').filter((line) => line.startsWith('ERROR:')).join('\n');
  if (errors.length === 0) return undefined;
  for (const [problem, pattern] of PATTERNS) {
    if (pattern.test(errors)) return problem;
  }
  return undefined;
}

export interface YtDlpContext {
  readonly site: ListedSite;
  /** A single video, or a list (channel, playlist, user, ...). */
  readonly scope: 'video' | 'feed';
  /** The worker handed over a cookies file for this run (YouTube only). */
  readonly hasLogin: boolean;
}

/**
 * What is wrong with one entry: the video itself, not the run. Recorded for the entry with a fixed German sentence
 * and the code; the run goes on with the next entry. `retryLater` entries are expected to become available.
 */
export interface EntryProblem {
  readonly kind: ToolProblem | 'live';
  readonly code: NonNullable<ManifestAsset['unavailable']>['code'];
  readonly message: string;
}

const ENTRY_TEXT: Readonly<Record<string, string>> = {
  private: 'Das Video ist privat oder nur für bestimmte Konten freigegeben.',
  unavailable: 'Das Video ist nicht mehr verfügbar (gelöscht, vom Uploader entfernt oder gesperrt).',
  geo: 'Das Video ist von der Region dieses Servers aus nicht abrufbar (Regionssperre).',
  members: 'Das Video ist nur für Kanalmitglieder. Das hinterlegte YouTube-Konto ist kein Mitglied dieses Kanals.',
  age: 'Das Video hat eine Altersbeschränkung, und das hinterlegte YouTube-Konto darf es nicht abrufen.',
  live: 'Der Livestream läuft gerade und wird nicht aufgezeichnet. Das Video wird nach dem Ende des Streams erneut geprüft.',
  upcoming: 'Das Video ist angekündigt (Premiere oder geplanter Livestream) und noch nicht abrufbar. Es wird später erneut geprüft.',
  locked: 'Das Video ist gesperrt (zum Beispiel nur für Premium-Konten).',
  redirect: 'Pornhub hat auf eine andere Seite weitergeleitet. Das Video wurde gelöscht oder verlangt eine Anmeldung.',
  pornhub_unavailable: 'Das Video wurde von Pornhub entfernt oder zur Prüfung gesperrt.'
};

/** The per-entry state for a live stream that the listing or the metadata marked as running now. */
export function liveEntryProblem(): EntryProblem {
  return { kind: 'live', code: 'ASSET_NOT_YET_AVAILABLE', message: ENTRY_TEXT.live! };
}

function entryProblem(problem: ToolProblem, site: ListedSite): EntryProblem | undefined {
  switch (problem) {
    case 'upcoming':
      return { kind: problem, code: 'ASSET_NOT_YET_AVAILABLE', message: ENTRY_TEXT.upcoming! };
    case 'private':
    case 'geo':
    case 'locked':
    case 'redirect':
      return { kind: problem, code: 'ASSET_NOT_ACCESSIBLE', message: ENTRY_TEXT[problem]! };
    case 'unavailable':
      return { kind: problem, code: 'ASSET_NOT_ACCESSIBLE', message: site === 'pornhub' ? ENTRY_TEXT.pornhub_unavailable! : ENTRY_TEXT.unavailable! };
    default:
      return undefined;
  }
}

const YOUTUBE_TEXT = {
  botCheck: 'YouTube verlangt eine Sicherheitsprüfung (Bestätigung, dass kein Bot abruft). Laden Sie unter Konto, Zugänge, die Cookies eines angemeldeten YouTube-Kontos hoch und setzen Sie das Abonnement danach fort. Das Abonnement wurde pausiert.',
  botCheckWithLogin: 'YouTube verlangt trotz der hinterlegten Cookies eine Sicherheitsprüfung (Bestätigung, dass kein Bot abruft). Die Cookies sind abgelaufen oder wurden von YouTube verworfen; laden Sie neue YouTube-Cookies hoch. Das Abonnement wurde pausiert.',
  feedNotFound: 'Der YouTube-Kanal oder die Playlist wurde nicht gefunden oder ist nicht öffentlich. Prüfen Sie die Adresse.',
  videoNotFound: 'Das YouTube-Video wurde nicht gefunden.',
  tabMissing: 'Der Kanal hat diesen Reiter nicht (zum Beispiel keine Livestreams oder Shorts). Wählen Sie einen anderen Reiter.'
} as const;

const PORNHUB_TEXT = {
  feedNotFound: 'Die Pornhub-Seite wurde nicht gefunden (Model, Pornstar, Kanal, Benutzer oder Playlist). Prüfen Sie die Adresse.',
  refused: 'Pornhub hat den Abruf abgelehnt (Zugriffsprüfung oder Regionssperre). Prüfen Sie, ob pornhub.com von diesem Server aus erreichbar ist. Das Abonnement wurde pausiert.'
} as const;

export type Classified =
  | { readonly kind: 'error'; readonly error: AdapterError }
  | { readonly kind: 'entry'; readonly problem: EntryProblem };

/**
 * Decides whether a failed run stops everything (an AdapterError: login, throttling, target missing, unknown) or
 * concerns one entry only (a per-entry state). Without a recognised cause it is PROCESS_FAILED with stderr as untrusted
 * diagnostics, as before.
 */
export function classifyYtDlpFailure(result: ProcessResult, context: YtDlpContext, action: string): Classified {
  const diagnostics = result.untrustedStderr;
  const problem = problemOf(diagnostics);
  const youtube = context.site === 'youtube';

  switch (problem) {
    case 'rate_limit':
      return { kind: 'error', error: new AdapterError('RATE_LIMITED', 'The source reported too many requests', diagnostics) };
    case 'bot_check':
      return { kind: 'error', error: new AdapterError('AUTH_REQUIRED', 'The source asks for proof that no bot is calling', diagnostics, context.hasLogin ? YOUTUBE_TEXT.botCheckWithLogin : YOUTUBE_TEXT.botCheck) };
    case 'members':
    case 'age':
    case 'login':
      // Without a login this is the signal to upload cookies. With one, a single video is not for this account.
      if (!context.hasLogin || context.scope === 'feed' || !youtube) {
        return { kind: 'error', error: new AdapterError('AUTH_REQUIRED', 'The source requires a login or the session was rejected', diagnostics) };
      }
      return problem === 'login'
        ? { kind: 'error', error: new AdapterError('AUTH_REQUIRED', 'The source requires a login or the session was rejected', diagnostics) }
        : { kind: 'entry', problem: { kind: problem, code: 'ASSET_NOT_ACCESSIBLE', message: ENTRY_TEXT[problem]! } };
    case 'refused':
      return { kind: 'error', error: new AdapterError('AUTH_REQUIRED', 'The source refused the request (HTTP 401 or 403)', diagnostics, youtube ? undefined : PORNHUB_TEXT.refused) };
    case 'tab_missing':
      return { kind: 'error', error: new AdapterError('TARGET_NOT_FOUND', 'The channel does not have this tab', diagnostics, YOUTUBE_TEXT.tabMissing) };
    case 'not_found':
      return { kind: 'error', error: notFound(context, diagnostics) };
    case 'server':
      return { kind: 'error', error: new AdapterError('NETWORK_FAILED', 'The source answered with a server or network error', diagnostics) };
    case undefined:
      return { kind: 'error', error: failed(result, action) };
    default: {
      const entry = entryProblem(problem, context.site);
      if (!entry) return { kind: 'error', error: failed(result, action) };
      // A list that cannot be read at all (a private playlist) is a missing target, not one unavailable entry.
      if (context.scope === 'feed') return { kind: 'error', error: notFound(context, diagnostics) };
      return { kind: 'entry', problem: entry };
    }
  }
}

function notFound(context: YtDlpContext, diagnostics: string): AdapterError {
  const text = context.site === 'youtube'
    ? (context.scope === 'feed' ? YOUTUBE_TEXT.feedNotFound : YOUTUBE_TEXT.videoNotFound)
    : PORNHUB_TEXT.feedNotFound;
  return new AdapterError('TARGET_NOT_FOUND', 'The source reported that the target does not exist', diagnostics, text);
}

function failed(result: ProcessResult, action: string): AdapterError {
  const how = result.terminatedBySignal ? `signal ${result.terminatedBySignal}` : `exit code ${result.exitCode}`;
  return new AdapterError('PROCESS_FAILED', `External tool failed while ${action} (${how})`, result.untrustedStderr);
}

/** For callers that can only throw: an entry problem of a download becomes TARGET_NOT_FOUND with the fixed sentence. */
export function errorOfEntryProblem(problem: EntryProblem): AdapterError {
  return new AdapterError('TARGET_NOT_FOUND', `The entry cannot be fetched (${problem.kind})`, undefined, problem.message);
}
