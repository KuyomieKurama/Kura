import type { Pool } from 'pg';
import type { BuildInfo } from './build-info.js';
import type { UpdateCheckConfig, UpdateChannel } from './config.js';
import { GithubCheckError, GithubReleaseClient } from './github-releases.js';
import { compareSemver, formatSemver, highestVersionTag, parseSemver } from './semver.js';

/**
 * The update check (REQ-DL-007): finds out which Kura version is the newest on GitHub and compares it with the
 * running one. It runs inside the API process only, never in the browser, and it only reads: nothing here can
 * change, rebuild or restart the installation. The result is kept in memory and in the database.
 */

export type UpdateStatus = 'current' | 'outdated' | 'unknown' | 'disabled';

const HOUR_MS = 60 * 60_000;
const NOTES_MAX_CHARACTERS = 4000;

export interface CheckState {
  repository: string;
  channel: UpdateChannel;
  latestTag: string | null;
  latestVersion: string | null;
  tagsEtag: string | null;
  /** Tag of the newest published release (not necessarily the newest tag). */
  releaseTag: string | null;
  releaseNotes: string | null;
  releaseEtag: string | null;
  /** Last time the tags were read successfully. */
  checkedAt: Date | null;
  /** Last time a check ran, successful or not. */
  attemptedAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  /** No request to GitHub before this time (rate limit). */
  backoffUntil: Date | null;
}

export interface UpdateCheckStore {
  load(): Promise<CheckState | null>;
  save(state: CheckState): Promise<void>;
  dismissedVersion(userId: string): Promise<string | null>;
  dismiss(userId: string, version: string): Promise<void>;
}

export interface VersionView {
  version: string;
  commit: string;
  status: UpdateStatus;
  latestVersion: string | null;
  latestTag: string | null;
  checkedAt: string | null;
  attemptedAt: string | null;
  /** Why the status is unknown or disabled, or what went wrong at the last attempt. German, safe to show. */
  reason: string | null;
  hasRelease: boolean;
  releaseUrl: string | null;
  /** Plain text, length-capped. The UI must show it as text, never as HTML. */
  releaseNotes: string | null;
  channel: UpdateChannel;
  repository: string;
  checkEnabled: boolean;
}

export interface Timers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface UpdateCheckLog {
  info(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
}

export interface UpdateCheckerOptions {
  build: BuildInfo;
  settings: UpdateCheckConfig;
  store: UpdateCheckStore;
  clock: { now(): Date };
  timers?: Timers;
  log?: UpdateCheckLog;
  fetchFunction?: typeof fetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
  startDelayMs?: number;
  intervalMs?: number;
  retryAfterFailureMs?: number;
}

export class UpdateCheckDisabledError extends Error {
  constructor() {
    super('Die Versionsprüfung ist ausgeschaltet.');
    this.name = 'UpdateCheckDisabledError';
  }
}

const realTimers: Timers = {
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
};
const silentLog: UpdateCheckLog = { info: () => undefined, warn: () => undefined };

/** Control characters (except newline and tab) and bidirectional overrides have no place in release notes. */
function isUnwantedCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  if (code === 0x0a || code === 0x09) return false;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x200e || code === 0x200f
    || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

/** Release notes are text from the internet: drop unwanted characters, cap the length. */
export function sanitizeReleaseNotes(raw: string): string | null {
  const cleaned = Array.from(raw.replace(/\r\n?/g, '\n')).filter((character) => !isUnwantedCharacter(character)).join('').trim();
  if (!cleaned) return null;
  const characters = Array.from(cleaned);
  return characters.length > NOTES_MAX_CHARACTERS ? `${characters.slice(0, NOTES_MAX_CHARACTERS).join('')}\n[gekürzt]` : cleaned;
}

function blankState(settings: UpdateCheckConfig): CheckState {
  return {
    repository: settings.repository, channel: settings.channel, latestTag: null, latestVersion: null, tagsEtag: null,
    releaseTag: null, releaseNotes: null, releaseEtag: null, checkedAt: null, attemptedAt: null,
    lastErrorCode: null, lastErrorMessage: null, backoffUntil: null
  };
}

/** Pure: what the API says about the version, derived from the build, the settings and the cached state. */
export function buildVersionView(build: BuildInfo, settings: UpdateCheckConfig, state: CheckState | null): VersionView {
  const base = {
    version: build.version, commit: build.commit, channel: settings.channel, repository: settings.repository, checkEnabled: settings.enabled,
    latestVersion: null, latestTag: null, checkedAt: null, attemptedAt: null, hasRelease: false, releaseUrl: null, releaseNotes: null
  };
  if (!settings.enabled) {
    return { ...base, status: 'disabled', reason: 'Die Versionsprüfung ist ausgeschaltet (KURA_UPDATE_CHECK=false). Es werden keine Anfragen an GitHub gesendet.' };
  }
  const running = parseSemver(build.version);
  const cached = state && state.repository === settings.repository && state.channel === settings.channel ? state : null;
  const timestamps = { checkedAt: cached?.checkedAt?.toISOString() ?? null, attemptedAt: cached?.attemptedAt?.toISOString() ?? null };
  if (!cached || !cached.checkedAt) {
    const reason = cached?.lastErrorMessage ?? (cached?.attemptedAt ? null : 'Noch nicht geprüft. Die erste Prüfung folgt kurz nach dem Start.');
    return { ...base, ...timestamps, status: 'unknown', reason };
  }
  const latest = cached.latestVersion ? parseSemver(cached.latestVersion) : null;
  if (!cached.latestTag || !latest) {
    return { ...base, ...timestamps, status: 'unknown', reason: cached.lastErrorMessage ?? 'Im Repository gibt es noch keine veröffentlichte Version (Tag vX.Y.Z).' };
  }
  const hasRelease = cached.releaseTag === cached.latestTag;
  const tag = encodeURIComponent(cached.latestTag);
  const known = {
    ...base, ...timestamps, latestVersion: cached.latestVersion, latestTag: cached.latestTag, hasRelease,
    releaseUrl: hasRelease ? `https://github.com/${settings.repository}/releases/tag/${tag}` : `https://github.com/${settings.repository}/tree/${tag}`,
    releaseNotes: hasRelease ? cached.releaseNotes : null
  };
  if (!running) {
    return { ...known, status: 'unknown', reason: cached.lastErrorMessage ?? 'Die eigene Version ist unbekannt, ein Vergleich ist nicht möglich.' };
  }
  return { ...known, status: compareSemver(running, latest) < 0 ? 'outdated' : 'current', reason: cached.lastErrorMessage };
}

export class UpdateChecker {
  private readonly client: GithubReleaseClient;
  private readonly timers: Timers;
  private readonly log: UpdateCheckLog;
  private readonly startDelayMs: number;
  private readonly intervalMs: number;
  private readonly retryAfterFailureMs: number;
  private state: CheckState | null = null;
  private timer: unknown;
  private stopped = true;
  private inFlight: Promise<void> | undefined;

  constructor(private readonly options: UpdateCheckerOptions) {
    this.timers = options.timers ?? realTimers;
    this.log = options.log ?? silentLog;
    this.startDelayMs = options.startDelayMs ?? 60_000;
    this.intervalMs = options.intervalMs ?? 12 * HOUR_MS;
    this.retryAfterFailureMs = options.retryAfterFailureMs ?? HOUR_MS;
    this.client = new GithubReleaseClient({
      apiBase: options.settings.apiBase,
      repository: options.settings.repository,
      userAgent: `Kura/${options.build.version} (+https://github.com/${options.settings.repository})`,
      timeoutMs: options.timeoutMs ?? 10_000,
      maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
      now: () => options.clock.now().getTime(),
      fetchFunction: options.fetchFunction
    });
  }

  get enabled(): boolean {
    return this.options.settings.enabled;
  }

  async view(): Promise<VersionView> {
    await this.ensureLoaded();
    return buildVersionView(this.options.build, this.options.settings, this.state);
  }

  /** On-demand check (administrator). Concurrent calls share one request. */
  async checkNow(): Promise<VersionView> {
    if (!this.enabled) throw new UpdateCheckDisabledError();
    await this.runOnce();
    return this.view();
  }

  /** Schedules the first check after the start delay, then every interval. Does nothing when the check is off. */
  start(): void {
    if (!this.enabled || !this.stopped) return;
    this.stopped = false;
    this.schedule(this.startDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  async dismissedVersion(userId: string): Promise<string | null> {
    return this.options.store.dismissedVersion(userId);
  }

  async dismiss(userId: string, version: string): Promise<void> {
    await this.options.store.dismiss(userId, version);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      void this.runScheduled();
    }, delayMs);
  }

  private async runScheduled(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      // runOnce records its own failures; this is a last line of defence, the loop must go on.
      this.log.warn({ message: error instanceof Error ? error.message : String(error) }, 'update check failed unexpectedly');
    }
    const state = this.state;
    let delay = state?.lastErrorCode ? this.retryAfterFailureMs : this.intervalMs;
    if (state?.backoffUntil) delay = Math.max(delay, state.backoffUntil.getTime() - this.options.clock.now().getTime());
    this.schedule(delay);
  }

  private async ensureLoaded(): Promise<CheckState> {
    if (this.state) return this.state;
    let loaded: CheckState | null = null;
    try {
      loaded = await this.options.store.load();
    } catch (error) {
      this.log.warn({ message: error instanceof Error ? error.message : String(error) }, 'update check state could not be loaded');
    }
    const { settings } = this.options;
    // A state from another repository or channel says nothing about this configuration.
    this.state = this.state ?? (loaded && loaded.repository === settings.repository && loaded.channel === settings.channel ? loaded : blankState(settings));
    return this.state;
  }

  private runOnce(): Promise<void> {
    this.inFlight ??= this.check().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async check(): Promise<void> {
    const previous = await this.ensureLoaded();
    const now = this.options.clock.now();
    if (previous.backoffUntil && previous.backoffUntil > now) return;
    const next: CheckState = { ...previous, attemptedAt: now };
    try {
      const tags = await this.client.listTagNames(previous.tagsEtag);
      if (tags.status === 'not-found') throw new GithubCheckError('http_error', 'Das Repository wurde auf GitHub nicht gefunden.');
      if (tags.status === 'ok') {
        const best = highestVersionTag(tags.body, this.options.settings.channel);
        next.latestTag = best?.tag ?? null;
        next.latestVersion = best ? formatSemver(best.version) : null;
        next.tagsEtag = tags.etag;
      }
      next.checkedAt = now;
      next.lastErrorCode = null;
      next.lastErrorMessage = null;
      next.backoffUntil = null;
      await this.readRelease(previous, next);
    } catch (error) {
      this.recordFailure(next, error, now);
    }
    this.state = next;
    this.log.info({ latestVersion: next.latestVersion, failed: next.lastErrorCode }, 'update check finished');
    try {
      await this.options.store.save(next);
    } catch (error) {
      this.log.warn({ message: error instanceof Error ? error.message : String(error) }, 'update check state could not be saved');
    }
  }

  /** The release notes are optional: a failure here keeps the tag result and only records the problem. */
  private async readRelease(previous: CheckState, next: CheckState): Promise<void> {
    if (!next.latestTag) return;
    try {
      const release = await this.client.latestRelease(previous.releaseEtag);
      if (release.status === 'ok') {
        next.releaseTag = release.body.tagName;
        next.releaseNotes = sanitizeReleaseNotes(release.body.notes);
        next.releaseEtag = release.etag;
      } else if (release.status === 'not-found') {
        next.releaseTag = null;
        next.releaseNotes = null;
        next.releaseEtag = null;
      }
    } catch (error) {
      this.recordFailure(next, error, next.attemptedAt ?? this.options.clock.now());
    }
  }

  private recordFailure(next: CheckState, error: unknown, now: Date): void {
    if (error instanceof GithubCheckError) {
      next.lastErrorCode = error.code;
      next.lastErrorMessage = error.message;
      if (error.code === 'rate_limited' && error.retryAfterMs !== undefined) next.backoffUntil = new Date(now.getTime() + error.retryAfterMs);
      this.log.warn({ code: error.code }, 'update check could not reach GitHub');
      return;
    }
    next.lastErrorCode = 'internal';
    next.lastErrorMessage = 'Die Prüfung ist aus einem unerwarteten Grund fehlgeschlagen.';
    this.log.warn({ message: error instanceof Error ? error.message : String(error) }, 'update check failed unexpectedly');
  }
}

export class PostgresUpdateCheckStore implements UpdateCheckStore {
  constructor(private readonly pool: Pool) {}

  async load(): Promise<CheckState | null> {
    const result = await this.pool.query(
      `SELECT repository, channel, latest_tag, latest_version, tags_etag, release_tag, release_notes, release_etag,
              checked_at, attempted_at, last_error_code, last_error_message, backoff_until
         FROM update_check_state WHERE id`
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      repository: row.repository, channel: row.channel, latestTag: row.latest_tag, latestVersion: row.latest_version,
      tagsEtag: row.tags_etag, releaseTag: row.release_tag, releaseNotes: row.release_notes, releaseEtag: row.release_etag,
      checkedAt: row.checked_at, attemptedAt: row.attempted_at, lastErrorCode: row.last_error_code,
      lastErrorMessage: row.last_error_message, backoffUntil: row.backoff_until
    };
  }

  async save(state: CheckState): Promise<void> {
    await this.pool.query(
      `INSERT INTO update_check_state (id, repository, channel, latest_tag, latest_version, tags_etag, release_tag, release_notes,
                                       release_etag, checked_at, attempted_at, last_error_code, last_error_message, backoff_until, updated_at)
       VALUES (true, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
       ON CONFLICT (id) DO UPDATE SET repository = EXCLUDED.repository, channel = EXCLUDED.channel, latest_tag = EXCLUDED.latest_tag,
         latest_version = EXCLUDED.latest_version, tags_etag = EXCLUDED.tags_etag, release_tag = EXCLUDED.release_tag,
         release_notes = EXCLUDED.release_notes, release_etag = EXCLUDED.release_etag, checked_at = EXCLUDED.checked_at,
         attempted_at = EXCLUDED.attempted_at, last_error_code = EXCLUDED.last_error_code,
         last_error_message = EXCLUDED.last_error_message, backoff_until = EXCLUDED.backoff_until, updated_at = now()`,
      [state.repository, state.channel, state.latestTag, state.latestVersion, state.tagsEtag, state.releaseTag, state.releaseNotes,
        state.releaseEtag, state.checkedAt, state.attemptedAt, state.lastErrorCode, state.lastErrorMessage, state.backoffUntil]
    );
  }

  async dismissedVersion(userId: string): Promise<string | null> {
    const result = await this.pool.query<{ dismissed_version: string }>('SELECT dismissed_version FROM update_notice_dismissals WHERE user_id = $1', [userId]);
    return result.rows[0]?.dismissed_version ?? null;
  }

  async dismiss(userId: string, version: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO update_notice_dismissals (user_id, dismissed_version) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET dismissed_version = EXCLUDED.dismissed_version, dismissed_at = now()`,
      [userId, version]
    );
  }
}
