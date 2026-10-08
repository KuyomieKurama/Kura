export type AdapterErrorCode =
  | 'TARGET_INVALID'
  | 'TARGET_UNSUPPORTED'
  | 'TARGET_BROKEN'
  | 'POLICY_UNSUPPORTED'
  | 'ADAPTER_DISABLED'
  | 'ADAPTER_UNKNOWN'
  | 'BINARY_NOT_CONFIGURED'
  | 'BINARY_HASH_MISMATCH'
  | 'BINARY_VERSION_REJECTED'
  | 'EGRESS_NOT_CONFIRMED'
  | 'PROCESS_SPAWN_FAILED'
  | 'PROCESS_FAILED'
  | 'PROCESS_TIMEOUT'
  | 'PROCESS_OUTPUT_LIMIT'
  | 'PROCESS_TEMP_LIMIT'
  | 'PROCESS_ABORTED'
  | 'OUTPUT_INVALID'
  | 'STAGING_REJECTED'
  | 'NETWORK_BLOCKED'
  | 'NETWORK_FAILED'
  | 'REDIRECT_REJECTED'
  | 'MIME_REJECTED'
  | 'SIZE_LIMIT'
  | 'DOWNLOAD_FAILED';

/**
 * The only error type adapters throw on purpose. The message is written by
 * Kura and never contains tool output. Text that came from an external tool
 * or server is kept in `untrustedDiagnostics` (bounded, control characters
 * removed) so it can be stored for support but must never be interpreted.
 */
export class AdapterError extends Error {
  readonly untrustedDiagnostics: string | undefined;

  constructor(readonly code: AdapterErrorCode, message: string, untrustedDiagnostics?: string) {
    super(message);
    this.name = 'AdapterError';
    this.untrustedDiagnostics = untrustedDiagnostics === undefined ? undefined : sanitizeDiagnostics(untrustedDiagnostics);
  }
}

const MAX_DIAGNOSTIC_CHARS = 2_000;

/** Bounds untrusted text and replaces control characters (including newlines) with spaces. */
export function sanitizeDiagnostics(text: string): string {
  return text
    .slice(0, MAX_DIAGNOSTIC_CHARS)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .trim();
}
