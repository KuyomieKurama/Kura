import { AdapterError, type AdapterErrorCode } from '@kura/adapters';
import { ImportRejectedError, QuotaExceededError } from './blob-import.js';
import type { RunState } from './history.js';

/** What a failure means for the run, for the queue and for the user (docs/planning/04, section 6). */
export interface Disposition {
  /** State shown in the history. */
  runState: RunState;
  /** Stable code; never tool output. */
  code: string;
  /** Short German text for the UI. Contains nothing that came from a tool or a server. */
  message: string;
  /** false = the queue run fails for good. */
  retryable: boolean;
  retryAfterSeconds?: number;
  /** Stop the schedule until the user acts (login or space needed): no unbounded retry. */
  pauseSubscription?: boolean;
}

const RATE_LIMIT_WAIT_SECONDS = 15 * 60;

const authFailure: Disposition = {
  runState: 'waiting_auth',
  code: 'AUTH_REQUIRED',
  message: 'Die Quelle verlangt eine Anmeldung oder die Anmeldung ist abgelaufen. Das Abonnement wurde pausiert.',
  retryable: false,
  pauseSubscription: true
};
const rateLimited: Disposition = {
  runState: 'waiting_rate_limit',
  code: 'RATE_LIMITED',
  message: 'Die Quelle hat zu viele Anfragen gemeldet. Der Lauf wird später wiederholt.',
  retryable: true,
  retryAfterSeconds: RATE_LIMIT_WAIT_SECONDS
};
export const sourceGoneDisposition: Disposition = {
  runState: 'failed',
  code: 'SOURCE_GONE',
  message: 'Die Quelle ist nicht mehr vorhanden. Bereits archivierte Dateien bleiben erhalten.',
  retryable: false
};

const fail = (code: string, message: string): Disposition => ({ runState: 'failed', code, message, retryable: false });
const retry = (code: string, message: string): Disposition => ({ runState: 'retry_wait', code, message, retryable: true });

const toolUnavailable = fail('TOOL_UNAVAILABLE', 'Das benötigte Werkzeug ist auf dem Server nicht installiert oder nicht freigegeben.');

const egressNotConfirmed = fail(
  'EGRESS_NOT_CONFIRMED',
  'Externe Werkzeuge gesperrt: Egress-Schutz nicht bestätigt. Der Administrator muss die Netzwerksperre für den Worker einrichten und bestätigen.'
);

/** Codes for which the adapter's own German sentence may replace the general text. */
const USER_MESSAGE_CODES: ReadonlySet<AdapterErrorCode> = new Set([
  'AUTH_REQUIRED', 'RATE_LIMITED', 'TARGET_NOT_FOUND', 'TARGET_UNSUPPORTED', 'TARGET_INVALID', 'PROCESS_TIMEOUT', 'PROCESS_OUTPUT_LIMIT', 'NETWORK_FAILED'
]);

const targetNotFound = fail(
  'TARGET_NOT_FOUND',
  'Das Ziel wurde nicht gefunden, zum Beispiel ein Profil, das nicht existiert, oder ein gelöschter Beitrag. Bereits archivierte Dateien bleiben erhalten.'
);

const byAdapterCode: Record<AdapterErrorCode, Disposition> = {
  TARGET_INVALID: fail('TARGET_INVALID', 'Die Adresse ist ungültig oder nicht erlaubt.'),
  TARGET_UNSUPPORTED: fail('TARGET_UNSUPPORTED', 'Diese Adresse wird von keinem Adapter unterstützt.'),
  TARGET_BROKEN: fail('TARGET_BROKEN', 'Für diese Art von Adresse ist die Unterstützung zurzeit defekt.'),
  TARGET_NOT_FOUND: targetNotFound,
  AUTH_REQUIRED: authFailure,
  RATE_LIMITED: rateLimited,
  POLICY_UNSUPPORTED: fail('POLICY_UNSUPPORTED', 'Das Qualitätsprofil wird von diesem Adapter nicht unterstützt.'),
  ADAPTER_DISABLED: fail('ADAPTER_DISABLED', 'Der Adapter wurde vom Administrator abgeschaltet.'),
  ADAPTER_UNKNOWN: toolUnavailable,
  BINARY_NOT_CONFIGURED: toolUnavailable,
  BINARY_HASH_MISMATCH: toolUnavailable,
  BINARY_VERSION_REJECTED: toolUnavailable,
  EGRESS_NOT_CONFIRMED: egressNotConfirmed,
  PROCESS_SPAWN_FAILED: retry('PROCESS_SPAWN_FAILED', 'Das Werkzeug konnte nicht gestartet werden.'),
  PROCESS_FAILED: retry('PROCESS_FAILED', 'Das Werkzeug ist fehlgeschlagen. Der Lauf wird wiederholt.'),
  PROCESS_TIMEOUT: retry('PROCESS_TIMEOUT', 'Das Werkzeug hat zu lange gebraucht. Der Lauf wird wiederholt.'),
  // Possible with a tool that prints without end; later tries usually get a normal answer, so it is retried (with the
  // queue's backoff and attempt limit) like a timeout.
  PROCESS_OUTPUT_LIMIT: retry('PROCESS_OUTPUT_LIMIT', 'Das Werkzeug hat die Ausgabegrenze überschritten. Der Lauf wird wiederholt.'),
  PROCESS_TEMP_LIMIT: fail('PROCESS_TEMP_LIMIT', 'Das Werkzeug hat die Grenze für temporären Speicher überschritten.'),
  PROCESS_ABORTED: retry('PROCESS_ABORTED', 'Der Lauf wurde abgebrochen.'),
  OUTPUT_INVALID: fail('OUTPUT_INVALID', 'Die Ausgabe des Werkzeugs war nicht lesbar.'),
  STAGING_REJECTED: fail('STAGING_REJECTED', 'Die Datei wurde abgelehnt und nicht gespeichert (Quarantäne).'),
  NETWORK_BLOCKED: fail('NETWORK_BLOCKED', 'Das Ziel ist durch die Netzwerkregeln gesperrt.'),
  NETWORK_FAILED: retry('NETWORK_FAILED', 'Netzwerkfehler beim Abruf. Der Lauf wird wiederholt.'),
  REDIRECT_REJECTED: fail('REDIRECT_REJECTED', 'Die Weiterleitung der Quelle wurde abgelehnt.'),
  MIME_REJECTED: fail('MIME_REJECTED', 'Der Dateityp ist nicht erlaubt oder passt nicht zum Inhalt.'),
  SIZE_LIMIT: fail('SIZE_LIMIT', 'Die Datei ist größer als das erlaubte Limit.'),
  DOWNLOAD_FAILED: retry('DOWNLOAD_FAILED', 'Der Abruf ist fehlgeschlagen. Der Lauf wird wiederholt.')
};

const unexpected = retry('UNEXPECTED', 'Unerwarteter Fehler. Der Lauf wird wiederholt.');

/**
 * Patterns for what a CLI tool says when the source wants a login, throttles us or no longer has the
 * item. They are heuristics written from memory of the tools' messages and are NOT verified against the
 * real programs. They only decide which German text and which retry rule applies; they never decide
 * that a post has no news: a failed tool run never advances the "checked through" mark.
 */
const TOOL_AUTH = /http error 40[13]|login required|sign in to confirm|log in to|authentication required|cookies?\b.*\b(required|expired|invalid)|private (video|account)|members[- ]only/i;
const TOOL_RATE_LIMIT = /http error 429|too many requests|rate.?limit/i;
const TOOL_GONE = /http error (404|410)|video unavailable|has been removed|no longer available|does not exist/i;

/** Direct adapter messages look like "Server answered with status 403" (written by Kura, not by the server). */
function httpStatusOf(error: AdapterError): number | undefined {
  const match = /status (\d{3})\b/.exec(error.message);
  return match ? Number(match[1]) : undefined;
}

function byHttpStatus(status: number): Disposition | undefined {
  if (status === 401 || status === 403) return authFailure;
  if (status === 404 || status === 410) return sourceGoneDisposition;
  if (status === 429) return rateLimited;
  if (status >= 500) return retry('SOURCE_ERROR', 'Die Quelle meldet einen Serverfehler. Der Lauf wird wiederholt.');
  return fail('SOURCE_REJECTED', 'Die Quelle hat den Abruf abgelehnt.');
}

export function classifyFailure(error: unknown): Disposition {
  if (error instanceof QuotaExceededError) {
    return {
      runState: 'paused',
      code: 'QUOTA_EXCEEDED',
      message: 'Das Speicherkontingent ist erschöpft. Das Abonnement wurde pausiert; schaffen Sie Platz und setzen Sie es fort.',
      retryable: false,
      pauseSubscription: true
    };
  }
  if (error instanceof ImportRejectedError) {
    return fail('INTEGRITY_MISMATCH', 'Die Datei stimmt nicht mit dem Bericht des Adapters überein und wurde nicht gespeichert (Quarantäne).');
  }
  if (!(error instanceof AdapterError)) return unexpected;

  const general = byAdapterCode[error.code];
  // A fixed German sentence of the adapter (for example "this profile is private") is more precise than the
  // general text. It replaces the text only; it never changes what happens to the run.
  if (error.userMessage && USER_MESSAGE_CODES.has(error.code)) {
    return { ...general, message: error.userMessage };
  }

  if (error.code === 'DOWNLOAD_FAILED') {
    const status = httpStatusOf(error);
    if (status !== undefined) return byHttpStatus(status) ?? byAdapterCode.DOWNLOAD_FAILED;
  }
  if (error.code === 'PROCESS_FAILED' && error.untrustedDiagnostics) {
    if (TOOL_AUTH.test(error.untrustedDiagnostics)) return authFailure;
    if (TOOL_RATE_LIMIT.test(error.untrustedDiagnostics)) return rateLimited;
    if (TOOL_GONE.test(error.untrustedDiagnostics)) return sourceGoneDisposition;
  }
  return general ?? unexpected;
}

/**
 * A failure that affects every further post of the run: continuing would only repeat the login attempt or
 * make the throttling worse. The run stops and the "checked through" mark stays where it was.
 */
export function stopsWholeRun(disposition: Disposition): boolean {
  return disposition.runState === 'waiting_auth' || disposition.runState === 'waiting_rate_limit' || disposition.runState === 'paused';
}
