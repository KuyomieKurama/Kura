import { AdapterError } from './errors.js';
import { asRecord, cleanText, parseUntrustedJson } from './cli-support.js';
import type { ProcessResult } from './process-runner.js';
import type { SourceType } from './types.js';

/**
 * Reading what gallery-dl prints, and turning what went wrong into an AdapterError.
 *
 * Source of the formats: gallery-dl 1.32.16 (gallery_dl/job.py, DataJob; gallery_dl/exception.py), read from the
 * released source, not from a real Instagram run:
 *  - `--dump-json` prints ONE JSON array after the extraction has finished. Entries are
 *    `[2, directoryMetadata]` (start of a post), `[3, url, fileMetadata]` (one file) and, if the extraction
 *    raised an exception, `[-1, {"error": "<ExceptionClassName>", "message": "<text>"}]`.
 *  - In that mode the process exit code is 0 even if the extraction failed (DataJob.run returns 0), so the exit
 *    code says nothing and the `-1` entry is the only reliable sign of a failure.
 *  - Without `--dump-json` (download runs) errors are logged to stderr and the exit code is a bit mask:
 *    1 other, 4 extraction/HTTP error, 8 challenge, 16 authentication/authorization, 32 input, 64 no extractor, 128 OS.
 */

/** The tool's own error entry. Both fields are untrusted text. */
export interface ToolMessageError {
  readonly name: string;
  readonly message: string;
}

export interface ParsedPost {
  /** Metadata of the `[2, ...]` entry that opened the post; absent if files came before any directory entry. */
  readonly directory: Record<string, unknown> | undefined;
  readonly files: readonly Record<string, unknown>[];
  /** More files than the per-post limit were printed; the rest was dropped. */
  readonly filesTruncated: boolean;
}

export interface ParsedOutput {
  readonly posts: readonly ParsedPost[];
  readonly error: ToolMessageError | null;
}

const MAX_FILES_PER_POST = 1_000;
const MAX_FILES_IN_OUTPUT = 20_000;

/** Parses the `--dump-json` array defensively; entries of an unknown shape are skipped. */
export function parseDumpJson(stdout: string): ParsedOutput {
  const raw = parseUntrustedJson(stdout);
  if (!Array.isArray(raw)) throw new AdapterError('OUTPUT_INVALID', 'gallery-dl listing is not a list');

  const posts: { directory: Record<string, unknown> | undefined; files: Record<string, unknown>[]; filesTruncated: boolean }[] = [];
  let error: ToolMessageError | null = null;
  let totalFiles = 0;

  for (const entry of raw) {
    if (!Array.isArray(entry)) continue;
    if (entry[0] === 2) {
      posts.push({ directory: asRecord(entry[1]), files: [], filesTruncated: false });
    } else if (entry[0] === 3) {
      const metadata = asRecord(entry[2]);
      if (typeof entry[1] !== 'string' || !metadata) continue;
      if (totalFiles >= MAX_FILES_IN_OUTPUT) throw new AdapterError('OUTPUT_INVALID', 'gallery-dl listing has more files than supported');
      if (posts.length === 0) posts.push({ directory: undefined, files: [], filesTruncated: false });
      const current = posts[posts.length - 1]!;
      if (current.files.length >= MAX_FILES_PER_POST) {
        current.filesTruncated = true;
      } else {
        current.files.push(metadata);
        totalFiles += 1;
      }
    } else if (entry[0] === -1) {
      const record = asRecord(entry[1]);
      error ??= {
        name: cleanText(record?.error, 100) ?? 'UnknownError',
        message: cleanText(record?.message, 500) ?? ''
      };
    }
  }
  return { posts, error };
}

// --- Failure classification -------------------------------------------------------------------

export interface FailureContext {
  readonly sourceType: SourceType;
  /** What was being read: one post, or a profile listing. */
  readonly scope: 'post' | 'profile';
  /** The worker handed over a cookies file for this run. */
  readonly hasCookies: boolean;
}

type ToolProblem = 'private' | 'checkpoint' | 'rate_limit' | 'auth' | 'not_found' | 'server';

/*
 * Patterns for the text of gallery-dl's exception names/messages and its stderr log lines. Where a pattern
 * comes from the gallery-dl source it is said so; the rest are heuristics for text that Instagram or a
 * proxy might produce and that was NOT observed in a real run.
 */
const PRIVATE_PATTERN = /\bposts are private\b/i; // instagram.py: log.warning("%s'%s posts are private")
const CHECKPOINT_PATTERN = /redirect to challenge page|checkpoint[_ ]required|challenge[_ ]required|\bchallenge \(/i; // instagram.py request(): "HTTP redirect to challenge page"; ChallengeError
const RATE_LIMIT_PATTERN = /'429 |\b429\b[^a-z]{0,10}too many|too many requests|please wait a few minutes|rate.?limit/i; // common.py: "'429 Too Many Requests' for '<url>'"; the other two are heuristics
const AUTH_PATTERN = /redirect to (?:login|home) page|'40[13] |login[_ ]required|\bauthrequired\b|\bauthorizationerror\b|\bauthenticationerror\b|cookies? needed|needed to access/i; // instagram.py request(): "HTTP redirect to login page"; common.py: "'401 Unauthorized' for ..."
const NOT_FOUND_PATTERN = /'(?:404|410) |could not be found|\bnotfounderror\b/i; // exception.py NotFoundError: "Requested <what> could not be found"
const SERVER_PATTERN = /'5\d\d /; // common.py: "'503 Service Unavailable' for ..."

function problemOf(text: string): ToolProblem | undefined {
  if (PRIVATE_PATTERN.test(text)) return 'private';
  if (CHECKPOINT_PATTERN.test(text)) return 'checkpoint';
  if (RATE_LIMIT_PATTERN.test(text)) return 'rate_limit';
  if (AUTH_PATTERN.test(text)) return 'auth';
  if (NOT_FOUND_PATTERN.test(text)) return 'not_found';
  if (SERVER_PATTERN.test(text)) return 'server';
  return undefined;
}

const AUTH_EXCEPTIONS = new Set(['AuthRequired', 'AuthorizationError', 'AuthenticationError']);

// Fixed German sentences for Instagram. They are shown to users, so they contain nothing from the tool.
const INSTAGRAM_TEXT = {
  authNoCookies: 'Instagram verlangt eine Anmeldung. Hinterlegen Sie gültige Instagram-Cookies für diese Quelle. Das Abonnement wurde pausiert.',
  authWithCookies: 'Instagram hat die Anmeldung abgelehnt. Die Cookies sind abgelaufen oder ungültig; hinterlegen Sie neue Instagram-Cookies. Das Abonnement wurde pausiert.',
  private: 'Das Instagram-Profil ist privat, und mit den hinterlegten Zugangsdaten besteht kein Zugriff. Das Konto muss dem Profil folgen dürfen. Das Abonnement wurde pausiert.',
  checkpoint: 'Instagram verlangt eine Sicherheitsprüfung (Checkpoint). Bestätigen Sie sie im Browser und hinterlegen Sie danach neue Cookies. Das Abonnement wurde pausiert.',
  profileNotFound: 'Das Instagram-Profil wurde nicht gefunden. Prüfen Sie den Benutzernamen; das Profil wurde vielleicht umbenannt, gelöscht oder gesperrt.',
  postNotFound: 'Der Instagram-Beitrag wurde nicht gefunden. Er wurde gelöscht oder ist für das verwendete Konto nicht sichtbar.',
  emptyNoCookies: 'Instagram hat für dieses Profil ohne Anmeldung keine Beiträge geliefert. Hinterlegen Sie gültige Instagram-Cookies. Das Abonnement wurde pausiert.',
  emptyWithCookies: 'Instagram hat für dieses Profil keine Beiträge geliefert. Die Cookies sind womöglich abgelaufen, oder das Profil ist leer oder privat. Erneuern Sie die Cookies und prüfen Sie das Profil. Das Abonnement wurde pausiert.'
} as const;

function adapterErrorFor(problem: ToolProblem, context: FailureContext, diagnostics: string): AdapterError {
  const instagram = context.sourceType === 'instagram';
  switch (problem) {
    case 'private':
      return new AdapterError('AUTH_REQUIRED', 'The profile is private and the session has no access', diagnostics, instagram ? INSTAGRAM_TEXT.private : undefined);
    case 'checkpoint':
      return new AdapterError('AUTH_REQUIRED', 'The source asks for a security check (checkpoint or challenge)', diagnostics, instagram ? INSTAGRAM_TEXT.checkpoint : undefined);
    case 'auth':
      return new AdapterError('AUTH_REQUIRED', 'The source requires a login or the session was rejected', diagnostics,
        instagram ? (context.hasCookies ? INSTAGRAM_TEXT.authWithCookies : INSTAGRAM_TEXT.authNoCookies) : undefined);
    case 'rate_limit':
      return new AdapterError('RATE_LIMITED', 'The source reported too many requests', diagnostics);
    case 'not_found':
      return new AdapterError('TARGET_NOT_FOUND', 'The source reported that the target does not exist', diagnostics,
        instagram ? (context.scope === 'profile' ? INSTAGRAM_TEXT.profileNotFound : INSTAGRAM_TEXT.postNotFound) : undefined);
    case 'server':
      return new AdapterError('NETWORK_FAILED', 'The source answered with a server error', diagnostics);
  }
}

/** Maps the error entry of a `--dump-json` run. Unknown errors become PROCESS_FAILED with the text kept as diagnostics. */
export function failureFromToolError(error: ToolMessageError, context: FailureContext): AdapterError {
  const text = `${error.name}: ${error.message}`;
  if (error.name === 'NotFoundError') return adapterErrorFor('not_found', context, text);
  if (error.name === 'ChallengeError') return adapterErrorFor('checkpoint', context, text);
  if (AUTH_EXCEPTIONS.has(error.name)) return adapterErrorFor('auth', context, text);

  const problem = problemOf(text);
  if (problem) return adapterErrorFor(problem, context, text);
  // A page that should have been JSON but was not (an HTML login wall answered with 200). Heuristic, Instagram only.
  if (error.name === 'JSONDecodeError' && context.sourceType === 'instagram') return adapterErrorFor('auth', context, text);
  return new AdapterError('PROCESS_FAILED', `External tool reported ${error.name} while reading the listing`, text);
}

/**
 * Maps a failed download run (no JSON output): first the log text on stderr, then the exit code bits for
 * authentication (16) and challenge (8). Anything else stays PROCESS_FAILED with stderr as diagnostics.
 */
export function failureFromProcess(result: ProcessResult, context: FailureContext, action: string): AdapterError {
  const problem = problemOf(result.untrustedStderr);
  if (problem) return adapterErrorFor(problem, context, result.untrustedStderr);
  const code = result.exitCode ?? 0;
  if (code > 0 && (code & 16) !== 0) return adapterErrorFor('auth', context, result.untrustedStderr);
  if (code > 0 && (code & 8) !== 0) return adapterErrorFor('checkpoint', context, result.untrustedStderr);
  const how = result.terminatedBySignal ? `signal ${result.terminatedBySignal}` : `exit code ${result.exitCode}`;
  return new AdapterError('PROCESS_FAILED', `External tool failed while ${action} (${how})`, result.untrustedStderr);
}

/**
 * A profile listing that ended without a single post and without an error entry. Instagram answers a
 * missing or expired session with empty pages or with a warning, not always with an error (instagram.py:
 * `_pagination_graphql` simply stops when the response has no data; a private profile only logs a warning).
 * That must never look like "no new posts", so the run is treated as a login problem.
 */
export function failureOfEmptyProfileListing(stderr: string, context: FailureContext): AdapterError {
  if (PRIVATE_PATTERN.test(stderr)) return adapterErrorFor('private', context, stderr);
  return new AdapterError('AUTH_REQUIRED', 'The profile listing is empty; treated as a missing or expired session', stderr,
    context.hasCookies ? INSTAGRAM_TEXT.emptyWithCookies : INSTAGRAM_TEXT.emptyNoCookies);
}
