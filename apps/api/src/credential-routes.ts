import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import {
  CREDENTIAL_PLATFORMS,
  credentialAad,
  credentialKindOf,
  isCredentialPlatform,
  type CredentialKind,
  type CredentialPlatform
} from '@kura/adapters';
import type { ApiConfig } from './config.js';
import {
  CookieFileError,
  MAX_COOKIE_FILE_BYTES,
  MAX_TOKEN_BYTES,
  parseCookieFile,
  parseRefreshToken
} from './credential-validators.js';
import { encryptSecret } from './immich-routes.js';
import { responseError, type Audit, type RequireSession } from './route-helpers.js';

interface CredentialRow {
  platform: CredentialPlatform;
  kind: CredentialKind;
  cookie_count: number;
  earliest_expiry: Date | null;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
  last_result: 'ok' | 'auth_required' | 'unknown';
}

/** Shown when the upload cannot be encrypted because the server has no KURA_SECRET_KEY. */
const SECRET_KEY_REQUIRED_MESSAGES: Readonly<Record<CredentialPlatform, string>> = {
  instagram: 'Instagram-Cookies können erst nach Konfiguration von KURA_SECRET_KEY gespeichert werden.',
  patreon: 'Patreon-Cookies können erst nach Konfiguration von KURA_SECRET_KEY gespeichert werden.',
  pixiv: 'Das Pixiv-Token kann erst nach Konfiguration von KURA_SECRET_KEY gespeichert werden.',
  youtube: 'YouTube-Cookies können erst nach Konfiguration von KURA_SECRET_KEY gespeichert werden.'
};

/**
 * The stored logins of the signed-in user, one per platform (IG-B, P1): Instagram, Patreon and YouTube cookies and
 * a Pixiv refresh token. The upload is validated per platform and stored encrypted. No response of these routes, no
 * audit entry and no log line contains the uploaded content.
 *
 *   GET    /api/v1/credentials             status of all platforms
 *   GET    /api/v1/credentials/:platform   status of one platform
 *   PUT    /api/v1/credentials/:platform   the cookies.txt or the token as text/plain
 *   DELETE /api/v1/credentials/:platform
 */
export function registerCredentialRoutes(input: {
  app: FastifyInstance;
  pool: Pool;
  config: ApiConfig;
  clock: { now: () => Date };
  requireSession: RequireSession;
  audit: Audit;
}): void {
  const { app, pool, config, clock, requireSession, audit } = input;

  const statusOf = (row: CredentialRow | undefined) => {
    if (!row) return { present: false as const };
    return {
      present: true as const,
      cookieCount: row.cookie_count,
      earliestExpiry: row.earliest_expiry,
      expired: row.earliest_expiry !== null && row.earliest_expiry <= clock.now(),
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
      lastResult: row.last_result
    };
  };

  const platformOf = (params: unknown, reply: FastifyReply): CredentialPlatform | undefined => {
    const platform = (params as { platform?: string }).platform;
    if (isCredentialPlatform(platform)) return platform;
    void reply.code(404).send(responseError('NOT_FOUND', 'Für diese Plattform können keine Zugangsdaten hinterlegt werden.'));
    return undefined;
  };

  app.get('/api/v1/credentials', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const found = await pool.query<CredentialRow>(
      `SELECT platform, kind, cookie_count, earliest_expiry, created_at, updated_at, last_used_at, last_result
         FROM platform_credentials WHERE user_id = $1`,
      [session.userId]
    );
    return {
      secretKeyConfigured: Boolean(config.secretKey),
      credentials: CREDENTIAL_PLATFORMS.map((platform) => ({
        platform,
        kind: credentialKindOf(platform),
        ...statusOf(found.rows.find((row) => row.platform === platform))
      }))
    };
  });

  app.get('/api/v1/credentials/:platform', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const platform = platformOf(request.params, reply);
    if (!platform) return;
    const found = await pool.query<CredentialRow>(
      `SELECT platform, kind, cookie_count, earliest_expiry, created_at, updated_at, last_used_at, last_result
         FROM platform_credentials WHERE user_id = $1 AND platform = $2`,
      [session.userId, platform]
    );
    return { secretKeyConfigured: Boolean(config.secretKey), ...statusOf(found.rows[0]) };
  });

  // The body is the cookies.txt (or the token) as plain text. The route accepts up to 1 MiB so that the size rule
  // is answered with Kura's own message instead of a generic parser error.
  app.put('/api/v1/credentials/:platform', { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const platform = platformOf(request.params, reply);
    if (!platform) return;
    const kind = credentialKindOf(platform);
    if (!config.secretKey) {
      return reply.code(503).send(responseError('SECRET_KEY_REQUIRED', SECRET_KEY_REQUIRED_MESSAGES[platform]));
    }
    if (typeof request.body !== 'string') {
      return reply.code(400).send(responseError('VALIDATION_ERROR', kind === 'token' ? 'Das Token muss als Text (text/plain) gesendet werden.' : 'Die Datei muss als Text (text/plain) gesendet werden.'));
    }
    const limit = kind === 'token' ? MAX_TOKEN_BYTES : MAX_COOKIE_FILE_BYTES;
    if (Buffer.byteLength(request.body, 'utf8') > limit) {
      return reply.code(413).send(responseError('FILE_TOO_LARGE', kind === 'token' ? 'Der Wert ist größer als 1 KiB.' : 'Die Datei ist größer als 256 KiB.'));
    }

    let secret: string;
    let itemCount = 1;
    let droppedCount = 0;
    let earliestExpiry: Date | null = null;
    try {
      if (platform === 'pixiv') {
        secret = parseRefreshToken(request.body);
      } else {
        const parsed = parseCookieFile(platform, request.body, clock.now());
        secret = parsed.text;
        itemCount = parsed.keptCount;
        droppedCount = parsed.droppedCount;
        earliestExpiry = parsed.earliestExpiry;
      }
    } catch (error) {
      if (error instanceof CookieFileError) return reply.code(400).send(responseError('COOKIES_INVALID', error.userMessage));
      throw error;
    }

    const encrypted = encryptSecret(config.secretKey, secret, credentialAad(platform, session.userId));
    await pool.query(
      `INSERT INTO platform_credentials (id, user_id, platform, kind, cookies_ciphertext, cookies_nonce, cookie_count, earliest_expiry)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, platform) DO UPDATE SET
         cookies_ciphertext = EXCLUDED.cookies_ciphertext,
         cookies_nonce = EXCLUDED.cookies_nonce,
         cookie_count = EXCLUDED.cookie_count,
         earliest_expiry = EXCLUDED.earliest_expiry,
         last_result = 'unknown',
         updated_at = now()`,
      [randomUUID(), session.userId, platform, kind, encrypted.ciphertext, encrypted.nonce, itemCount, earliestExpiry]
    );
    await audit(session.userId, `credential.${platform}_save`, session.userId, request);
    return { present: true, cookieCount: itemCount, droppedCount, earliestExpiry };
  });

  app.delete('/api/v1/credentials/:platform', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const platform = platformOf(request.params, reply);
    if (!platform) return;
    await pool.query('DELETE FROM platform_credentials WHERE user_id = $1 AND platform = $2', [session.userId, platform]);
    await audit(session.userId, `credential.${platform}_delete`, session.userId, request);
    return reply.code(204).send();
  });
}
