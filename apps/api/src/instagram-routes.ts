import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { ApiConfig } from './config.js';
import { encryptSecret } from './immich-routes.js';
import { CookieFileError, MAX_COOKIE_FILE_BYTES, parseInstagramCookies } from './instagram-cookies.js';
import { responseError, type Audit, type RequireSession } from './route-helpers.js';

const PLATFORM = 'instagram';

/**
 * Binds a ciphertext to its owner and platform (plan 06, SEC-01). The worker builds the same string to decrypt:
 * apps/worker/src/credentials.ts.
 */
export function credentialAad(userId: string): string {
  return `kura:credential:${PLATFORM}:${userId}`;
}

interface CredentialRow {
  cookie_count: number;
  earliest_expiry: Date | null;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
  last_result: 'ok' | 'auth_required' | 'unknown';
}

/**
 * Instagram session cookies per user (IG-B). The cookie file is validated, reduced to the Instagram cookies and
 * stored encrypted. No response of these routes, no audit entry and no log line contains cookie content.
 */
export function registerInstagramCredentialRoutes(input: {
  app: FastifyInstance;
  pool: Pool;
  config: ApiConfig;
  clock: { now: () => Date };
  requireSession: RequireSession;
  audit: Audit;
}): void {
  const { app, pool, config, clock, requireSession, audit } = input;

  app.get('/api/v1/credentials/instagram', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const found = await pool.query<CredentialRow>(
      `SELECT cookie_count, earliest_expiry, created_at, updated_at, last_used_at, last_result
         FROM platform_credentials WHERE user_id = $1 AND platform = $2`,
      [session.userId, PLATFORM]
    );
    const row = found.rows[0];
    const base = { secretKeyConfigured: Boolean(config.secretKey) };
    if (!row) return { ...base, present: false };
    return {
      ...base,
      present: true,
      cookieCount: row.cookie_count,
      earliestExpiry: row.earliest_expiry,
      expired: row.earliest_expiry !== null && row.earliest_expiry <= clock.now(),
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
      lastResult: row.last_result
    };
  });

  // The body is the cookies.txt as plain text. The route accepts up to 1 MiB so that the 256 KiB rule is
  // answered with Kura's own message instead of a generic parser error.
  app.put('/api/v1/credentials/instagram', { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    if (!config.secretKey) {
      return reply.code(503).send(responseError('SECRET_KEY_REQUIRED', 'Instagram-Cookies können erst nach Konfiguration von KURA_SECRET_KEY gespeichert werden.'));
    }
    if (typeof request.body !== 'string') {
      return reply.code(400).send(responseError('VALIDATION_ERROR', 'Die Datei muss als Text (text/plain) gesendet werden.'));
    }
    if (Buffer.byteLength(request.body, 'utf8') > MAX_COOKIE_FILE_BYTES) {
      return reply.code(413).send(responseError('FILE_TOO_LARGE', 'Die Datei ist größer als 256 KiB.'));
    }

    let parsed;
    try {
      parsed = parseInstagramCookies(request.body, clock.now());
    } catch (error) {
      if (error instanceof CookieFileError) return reply.code(400).send(responseError('COOKIES_INVALID', error.userMessage));
      throw error;
    }

    const encrypted = encryptSecret(config.secretKey, parsed.text, credentialAad(session.userId));
    await pool.query(
      `INSERT INTO platform_credentials (id, user_id, platform, cookies_ciphertext, cookies_nonce, cookie_count, earliest_expiry)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, platform) DO UPDATE SET
         cookies_ciphertext = EXCLUDED.cookies_ciphertext,
         cookies_nonce = EXCLUDED.cookies_nonce,
         cookie_count = EXCLUDED.cookie_count,
         earliest_expiry = EXCLUDED.earliest_expiry,
         last_result = 'unknown',
         updated_at = now()`,
      [randomUUID(), session.userId, PLATFORM, encrypted.ciphertext, encrypted.nonce, parsed.keptCount, parsed.earliestExpiry]
    );
    await audit(session.userId, 'credential.instagram_save', session.userId, request);
    return {
      present: true,
      cookieCount: parsed.keptCount,
      droppedCount: parsed.droppedCount,
      earliestExpiry: parsed.earliestExpiry
    };
  });

  app.delete('/api/v1/credentials/instagram', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    await pool.query('DELETE FROM platform_credentials WHERE user_id = $1 AND platform = $2', [session.userId, PLATFORM]);
    await audit(session.userId, 'credential.instagram_delete', session.userId, request);
    return reply.code(204).send();
  });
}
