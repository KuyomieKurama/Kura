import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { Clock } from '@kura/scheduler';
import { decryptSecret } from './handover.js';

export type CredentialResult = 'ok' | 'auth_required' | 'unknown';

/** Shown when stored cookies were used and Instagram still wants a login. */
export const INSTAGRAM_COOKIES_EXPIRED_MESSAGE = 'Instagram-Anmeldung abgelaufen: bitte Cookies neu hochladen. Das Abonnement wurde pausiert.';
/** Shown when the user has not stored any cookies and Instagram wants a login. */
export const INSTAGRAM_COOKIES_MISSING_MESSAGE = 'Instagram verlangt eine Anmeldung: bitte lade unter Konto, Instagram, deine Cookies hoch und setze das Abonnement danach fort. Das Abonnement wurde pausiert.';
export const INSTAGRAM_COOKIES_UNREADABLE_MESSAGE = 'Die gespeicherten Instagram-Cookies können nicht gelesen werden (Schlüssel fehlt oder wurde geändert): bitte Cookies neu hochladen. Das Abonnement wurde pausiert.';

/**
 * The adapter words two Instagram login problems precisely: a private profile and a security check (checkpoint).
 * Those sentences say more than "expired" or "missing" and are kept. tests/instagram/credentials-worker.test.ts
 * pins this against the adapter's wording.
 */
export function isSpecificInstagramAuthMessage(message: string): boolean {
  return /\bprivat\b|Sicherheitsprüfung/.test(message);
}

export type CookieLoad =
  | { status: 'none' }
  | { status: 'unreadable' }
  | { status: 'ok'; netscapeText: string };

/**
 * Reads the stored Instagram cookies of one user and records how they fared (IG-B). The cookie text only ever
 * lives in memory of the caller; nothing here logs it.
 */
export class InstagramCredentials {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
    private readonly secretKey?: Buffer
  ) {}

  async load(userId: string): Promise<CookieLoad> {
    const found = await this.pool.query<{ cookies_ciphertext: Buffer; cookies_nonce: Buffer }>(
      "SELECT cookies_ciphertext, cookies_nonce FROM platform_credentials WHERE user_id = $1 AND platform = 'instagram'",
      [userId]
    );
    const row = found.rows[0];
    if (!row) return { status: 'none' };
    if (!this.secretKey) return { status: 'unreadable' };
    try {
      // Same additional authenticated data as the API: apps/api/src/instagram-routes.ts, credentialAad().
      return { status: 'ok', netscapeText: decryptSecret(this.secretKey, row.cookies_ciphertext, row.cookies_nonce, `kura:credential:instagram:${userId}`) };
    } catch {
      return { status: 'unreadable' };
    }
  }

  async recordUse(userId: string): Promise<void> {
    await this.pool.query(
      "UPDATE platform_credentials SET last_used_at = $2 WHERE user_id = $1 AND platform = 'instagram'",
      [userId, this.clock.now()]
    );
  }

  async recordResult(userId: string, result: CredentialResult): Promise<void> {
    await this.pool.query(
      "UPDATE platform_credentials SET last_result = $2 WHERE user_id = $1 AND platform = 'instagram'",
      [userId, result]
    );
  }
}

/**
 * Writes the cookies to a new file (mode 0600, never overwriting an existing file) inside the private run
 * directory. The caller deletes it again; see JobExecutor.
 */
export async function writeCookiesFile(directory: string, netscapeText: string): Promise<string> {
  const path = join(directory, 'instagram-cookies.txt');
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    // The creation mode is reduced by the umask, never widened; this makes the final mode explicit.
    await handle.chmod(0o600);
    await handle.writeFile(netscapeText, 'utf8');
  } finally {
    await handle.close();
  }
  return path;
}
