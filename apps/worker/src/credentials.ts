import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { credentialAad, credentialKindOf, type CredentialPlatform, type RunCredentials } from '@kura/adapters';
import type { Clock } from '@kura/scheduler';
import { decryptSecret } from './handover.js';

export type CredentialResult = 'ok' | 'auth_required' | 'unknown';

/** Shown when stored cookies were used and Instagram still wants a login. */
export const INSTAGRAM_COOKIES_EXPIRED_MESSAGE = 'Instagram-Anmeldung abgelaufen: bitte Cookies neu hochladen. Das Abonnement wurde pausiert.';
/** Shown when the user has not stored any cookies and Instagram wants a login. */
export const INSTAGRAM_COOKIES_MISSING_MESSAGE = 'Instagram verlangt eine Anmeldung: bitte lade unter Konto, Instagram, deine Cookies hoch und setze das Abonnement danach fort. Das Abonnement wurde pausiert.';
export const INSTAGRAM_COOKIES_UNREADABLE_MESSAGE = 'Die gespeicherten Instagram-Cookies können nicht gelesen werden (Schlüssel fehlt oder wurde geändert): bitte Cookies neu hochladen. Das Abonnement wurde pausiert.';

/**
 * The sentences for a login problem, per platform. "expired": a stored login was used and the platform still wants
 * one. "missing": nothing is stored. "unreadable": something is stored but cannot be decrypted. Instagram keeps
 * its IG-B wording; the others follow it (P1).
 */
export const CREDENTIAL_MESSAGES: Readonly<Record<CredentialPlatform, { expired: string; missing: string; unreadable: string }>> = {
  instagram: {
    expired: INSTAGRAM_COOKIES_EXPIRED_MESSAGE,
    missing: INSTAGRAM_COOKIES_MISSING_MESSAGE,
    unreadable: INSTAGRAM_COOKIES_UNREADABLE_MESSAGE
  },
  patreon: {
    expired: 'Patreon-Anmeldung abgelaufen: bitte unter Konto, Zugänge, die Patreon-Cookies neu hochladen. Das Abonnement wurde pausiert.',
    missing: 'Patreon verlangt eine Anmeldung: bitte lade unter Konto, Zugänge, deine Patreon-Cookies hoch und setze das Abonnement danach fort. Das Abonnement wurde pausiert.',
    unreadable: 'Die gespeicherten Patreon-Cookies können nicht gelesen werden (Schlüssel fehlt oder wurde geändert): bitte Cookies neu hochladen. Das Abonnement wurde pausiert.'
  },
  pixiv: {
    expired: 'Pixiv-Anmeldung abgelaufen: das Token wurde abgelehnt. Erzeuge mit "gallery-dl oauth:pixiv" ein neues Token und hinterlege es unter Konto, Zugänge. Das Abonnement wurde pausiert.',
    missing: 'Pixiv verlangt eine Anmeldung: bitte hinterlege unter Konto, Zugänge, dein Pixiv-Token (mit "gallery-dl oauth:pixiv" erzeugt) und setze das Abonnement danach fort. Das Abonnement wurde pausiert.',
    unreadable: 'Das gespeicherte Pixiv-Token kann nicht gelesen werden (Schlüssel fehlt oder wurde geändert): bitte das Token neu hinterlegen. Das Abonnement wurde pausiert.'
  },
  youtube: {
    expired: 'YouTube-Anmeldung abgelaufen: bitte unter Konto, Zugänge, die YouTube-Cookies neu hochladen. Das Abonnement wurde pausiert.',
    missing: 'YouTube verlangt eine Anmeldung (zum Beispiel bei Videos mit Altersbeschränkung oder nur für Mitglieder): bitte lade unter Konto, Zugänge, deine YouTube-Cookies hoch und setze das Abonnement danach fort. Das Abonnement wurde pausiert.',
    unreadable: 'Die gespeicherten YouTube-Cookies können nicht gelesen werden (Schlüssel fehlt oder wurde geändert): bitte Cookies neu hochladen. Das Abonnement wurde pausiert.'
  }
};

/**
 * The adapters word two login problems precisely: a private Instagram profile and a security check (Instagram
 * checkpoint, Patreon's Cloudflare check). Those sentences say more than "expired" or "missing" and are kept.
 * tests/instagram/credentials-worker.test.ts pins this against the adapter's wording.
 */
export function isSpecificAuthMessage(message: string): boolean {
  return /\bprivat\b|Sicherheitsprüfung/.test(message);
}

export type SecretLoad =
  | { status: 'none' }
  | { status: 'unreadable' }
  | { status: 'ok'; secret: string };

/**
 * Reads the stored login of one user and platform and records how it fared (IG-B, P1). The secret (the cookie text
 * or the token) only ever lives in memory of the caller; nothing here logs it.
 */
export class PlatformCredentials {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
    private readonly secretKey?: Buffer
  ) {}

  async load(userId: string, platform: CredentialPlatform): Promise<SecretLoad> {
    const found = await this.pool.query<{ cookies_ciphertext: Buffer; cookies_nonce: Buffer }>(
      'SELECT cookies_ciphertext, cookies_nonce FROM platform_credentials WHERE user_id = $1 AND platform = $2',
      [userId, platform]
    );
    const row = found.rows[0];
    if (!row) return { status: 'none' };
    if (!this.secretKey) return { status: 'unreadable' };
    try {
      // Same additional authenticated data as the API: credentialAad() in @kura/adapters.
      return { status: 'ok', secret: decryptSecret(this.secretKey, row.cookies_ciphertext, row.cookies_nonce, credentialAad(platform, userId)) };
    } catch {
      return { status: 'unreadable' };
    }
  }

  async recordUse(userId: string, platform: CredentialPlatform): Promise<void> {
    await this.pool.query(
      'UPDATE platform_credentials SET last_used_at = $3 WHERE user_id = $1 AND platform = $2',
      [userId, platform, this.clock.now()]
    );
  }

  async recordResult(userId: string, platform: CredentialPlatform, result: CredentialResult): Promise<void> {
    await this.pool.query(
      'UPDATE platform_credentials SET last_result = $3 WHERE user_id = $1 AND platform = $2',
      [userId, platform, result]
    );
  }
}

/** Writes a new file (mode 0600, never overwriting an existing file) inside the private run directory. */
async function writePrivateFile(directory: string, name: string, content: string): Promise<string> {
  const path = join(directory, name);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    // The creation mode is reduced by the umask, never widened; this makes the final mode explicit.
    await handle.chmod(0o600);
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
  return path;
}

/**
 * Writes the cookies to a new file in the private run directory. The caller deletes it again; see JobExecutor.
 */
export async function writeCookiesFile(directory: string, netscapeText: string): Promise<string> {
  return writePrivateFile(directory, 'cookies.txt', netscapeText);
}

/**
 * Writes the gallery-dl configuration of a Pixiv run: the refresh token (`extractor.pixiv.refresh-token`,
 * extractor/pixiv.py) and the location of gallery-dl's cache file (`cache.file`, cache.py) inside the same private
 * directory. The cache holds the access token that gallery-dl gets for the refresh token; without this line it would
 * land in a cache file that is shared by every run. Both are removed with the directory. The file is JSON, which
 * gallery-dl reads as its default configuration format.
 */
export async function writePixivConfigFile(directory: string, refreshToken: string): Promise<string> {
  const configuration = {
    extractor: { pixiv: { 'refresh-token': refreshToken } },
    cache: { file: join(directory, 'gallery-dl-cache.sqlite3') }
  };
  return writePrivateFile(directory, 'gallery-dl.conf', `${JSON.stringify(configuration)}\n`);
}

/** The file the tool gets for a platform: a cookies file, or for Pixiv a configuration file with the token. */
export async function writeRunCredentials(platform: CredentialPlatform, directory: string, secret: string): Promise<RunCredentials> {
  return credentialKindOf(platform) === 'token'
    ? { configFilePath: await writePixivConfigFile(directory, secret) }
    : { cookiesFilePath: await writeCookiesFile(directory, secret) };
}
