import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sha256Digest, type OwnedObjectRef, type StorageBackend } from '@kura/blobstore';
import {
  classifyAddress,
  createGuardedFetch,
  endpointOf,
  ImmichClient,
  ImmichTargetBlockedError,
  normalizeEndpoint,
  TransferRepository,
  TransferService,
  type SecretResolver
} from '@kura/immich-client';
import { isIP } from 'node:net';
import type { Pool } from 'pg';
import { decodeStrictBase64 } from './base64.js';
import type { ApiConfig } from './config.js';
import { PostgresEndpointApprovals } from './immich-endpoint-approvals.js';
import { adminOnly } from './route-helpers.js';

const MAX_TEST_FILE_BYTES = 4 * 1024 * 1024;

export type ImmichSession = { userId: string; role: 'admin' | 'user' };
type RequireSession = (request: FastifyRequest, reply: FastifyReply) => Promise<ImmichSession | undefined>;
type Audit = (actor: string | null, action: string, target: string | null, request: FastifyRequest, outcome?: string) => Promise<void>;

function responseError(code: string, message: string) {
  return { error: { code, message } };
}

function requiredString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * AES-256-GCM with a fresh 12-byte nonce; the 16-byte tag is appended to the ciphertext. The optional additional
 * authenticated data binds a ciphertext to its owner: a blob copied to another row no longer decrypts.
 */
export function encryptSecret(key: Buffer, value: string, aad?: string): { ciphertext: Buffer; nonce: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'));
  return { nonce, ciphertext: Buffer.concat([cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]) };
}

export function decryptSecret(key: Buffer, ciphertext: Buffer, nonce: Buffer, aad?: string): string {
  const tag = ciphertext.subarray(-16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString('utf8');
}

/**
 * Syntax check at save time. Whether the target may be contacted is decided on
 * every connection by the guarded fetch, after DNS resolution.
 */
function isSafeImmichUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    if (url.username || url.password) return false;
    const host = endpointOf(url).host;
    return !isIP(host) || classifyAddress(host) !== 'always-blocked';
  } catch {
    return false;
  }
}

function targetNotAllowed(error: ImmichTargetBlockedError) {
  return {
    error: {
      code: error.code === 'TARGET_BLOCKED' ? 'IMMICH_TARGET_BLOCKED' : 'IMMICH_TARGET_NOT_APPROVED',
      message: error.code === 'TARGET_BLOCKED'
        ? 'Das Immich-Ziel liegt in einem gesperrten Adressbereich (Link-Local oder Metadaten).'
        : 'Das Immich-Ziel liegt in einem privaten Netz und muss zuerst von einem Administrator freigegeben werden.'
    },
    target: { host: error.host, port: error.port }
  };
}

export function registerImmichRoutes(input: {
  app: FastifyInstance;
  pool: Pool;
  config: ApiConfig;
  blobstore: StorageBackend;
  clock: { now: () => Date };
  requireSession: RequireSession;
  audit: Audit;
  resolveHost?: (host: string) => Promise<string[]>;
}): void {
  const { app, pool, config, blobstore, clock, requireSession, audit } = input;
  const guardedFetch = createGuardedFetch({ approvals: new PostgresEndpointApprovals(pool), resolveHost: input.resolveHost });
  const newClient = (serverUrl: string, userId: string) =>
    new ImmichClient(serverUrl, `secret://immich/${userId}`, secretResolver, guardedFetch);
  const secretResolver: SecretResolver = {
    resolve: async (reference) => {
      if (!config.secretKey) throw new Error('KURA_SECRET_KEY is not configured');
      const userId = reference.slice('secret://immich/'.length);
      const row = await pool.query<{ api_key_ciphertext: Buffer; api_key_nonce: Buffer }>(
        'SELECT api_key_ciphertext,api_key_nonce FROM immich_connections WHERE user_id=$1',
        [userId]
      );
      if (!row.rowCount) throw new Error('Immich connection not found');
      return decryptSecret(config.secretKey, row.rows[0].api_key_ciphertext, row.rows[0].api_key_nonce);
    }
  };
  const transfers = new TransferRepository(pool);

  const requireAdmin = adminOnly(requireSession);

  app.get('/api/v1/admin/immich/endpoint-approvals', async (request, reply) => {
    const session = await requireAdmin(request, reply);
    if (!session) return;
    const rows = await pool.query<{ host: string; port: number; approved_at: Date }>(
      'SELECT host,port,approved_at FROM immich_endpoint_approvals ORDER BY host,port'
    );
    return { approvals: rows.rows.map((row) => ({ host: row.host, port: row.port, approvedAt: row.approved_at })) };
  });

  app.post('/api/v1/admin/immich/endpoint-approvals', async (request, reply) => {
    const session = await requireAdmin(request, reply);
    if (!session) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const endpoint = typeof body.host === 'string' && typeof body.port === 'number'
      ? normalizeEndpoint(body.host, body.port)
      : undefined;
    if (!endpoint) return reply.code(400).send(responseError('VALIDATION_ERROR', 'Host oder Port ist ungültig.'));
    if (isIP(endpoint.host) && classifyAddress(endpoint.host) === 'always-blocked') {
      return reply.code(400).send(responseError('IMMICH_TARGET_BLOCKED', 'Link-Local- und Metadaten-Adressen können nicht freigegeben werden.'));
    }
    await pool.query(
      'INSERT INTO immich_endpoint_approvals (host,port,approved_by) VALUES ($1,$2,$3) ON CONFLICT (host,port) DO NOTHING',
      [endpoint.host, endpoint.port, session.userId]
    );
    await audit(session.userId, 'immich.endpoint_approve', `${endpoint.host}:${endpoint.port}`, request);
    return reply.code(201).send({ approval: endpoint });
  });

  app.delete('/api/v1/admin/immich/endpoint-approvals/:host/:port', async (request, reply) => {
    const session = await requireAdmin(request, reply);
    if (!session) return;
    const params = request.params as { host: string; port: string };
    const endpoint = normalizeEndpoint(params.host, Number(params.port));
    if (!endpoint) return reply.code(400).send(responseError('VALIDATION_ERROR', 'Host oder Port ist ungültig.'));
    await pool.query('DELETE FROM immich_endpoint_approvals WHERE host=$1 AND port=$2', [endpoint.host, endpoint.port]);
    await audit(session.userId, 'immich.endpoint_revoke', `${endpoint.host}:${endpoint.port}`, request);
    return reply.code(204).send();
  });

  app.get('/api/v1/immich/connection', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const row = await pool.query<{ server_url: string; generation: string; updated_at: Date }>(
      'SELECT server_url,generation,updated_at FROM immich_connections WHERE user_id=$1',
      [session.userId]
    );
    return { connection: row.rows[0] ? { serverUrl: row.rows[0].server_url, generation: Number(row.rows[0].generation), updatedAt: row.rows[0].updated_at } : null };
  });

  app.put('/api/v1/immich/connection', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    if (!config.secretKey) return reply.code(503).send(responseError('SECRET_KEY_REQUIRED', 'Immich-Schlüssel können erst nach Konfiguration von KURA_SECRET_KEY gespeichert werden.'));
    const body = request.body as Record<string, unknown>;
    const serverUrl = requiredString(body.serverUrl);
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
    if (!isSafeImmichUrl(serverUrl) || !apiKey || apiKey.length > 4096) return reply.code(400).send(responseError('VALIDATION_ERROR', 'Server-URL oder API-Schlüssel ist ungültig.'));
    const encrypted = encryptSecret(config.secretKey, apiKey);
    await pool.query(
      'INSERT INTO immich_connections (user_id,server_url,api_key_ciphertext,api_key_nonce) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id) DO UPDATE SET server_url=EXCLUDED.server_url,api_key_ciphertext=EXCLUDED.api_key_ciphertext,api_key_nonce=EXCLUDED.api_key_nonce,generation=immich_connections.generation+1,updated_at=now()',
      [session.userId, serverUrl, encrypted.ciphertext, encrypted.nonce]
    );
    await audit(session.userId, 'immich.connection_save', session.userId, request);
    return reply.code(204).send();
  });

  app.delete('/api/v1/immich/connection', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    await pool.query('DELETE FROM immich_connections WHERE user_id=$1', [session.userId]);
    await audit(session.userId, 'immich.connection_delete', session.userId, request);
    return reply.code(204).send();
  });

  app.post('/api/v1/immich/connection/test', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const row = await pool.query<{ server_url: string }>('SELECT server_url FROM immich_connections WHERE user_id=$1', [session.userId]);
    if (!row.rowCount) return reply.code(404).send(responseError('NOT_FOUND', 'Keine Immich-Verbindung gespeichert.'));
    try {
      const result = await newClient(row.rows[0].server_url, session.userId).connectionTest();
      return { version: result.version || 'unbekannt', supported: false };
    } catch (cause) {
      if (cause instanceof ImmichTargetBlockedError) {
        return { version: 'unbekannt', supported: false, ...targetNotAllowed(cause) };
      }
      return { version: 'unbekannt', supported: false };
    }
  });

  app.post('/api/v1/immich/test-transfer', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const body = request.body as Record<string, unknown>;
    const encoded = typeof body.contentBase64 === 'string' ? body.contentBase64 : '';
    const fileName = requiredString(body.fileName) || 'test-upload.bin';
    const decoded = decodeStrictBase64(encoded, MAX_TEST_FILE_BYTES);
    if (!decoded.ok) {
      if (decoded.reason === 'invalid') return reply.code(400).send(responseError('VALIDATION_ERROR', 'Testdatei ist ungültig.'));
      return reply.code(400).send(responseError('VALIDATION_ERROR', 'Testdatei fehlt oder ist größer als 4 MiB.'));
    }
    const bytes = decoded.bytes;
    const connection = await pool.query<{ server_url: string; generation: string }>('SELECT server_url,generation FROM immich_connections WHERE user_id=$1', [session.userId]);
    if (!connection.rowCount) return reply.code(404).send(responseError('NOT_FOUND', 'Keine Immich-Verbindung gespeichert.'));

    const client = newClient(connection.rows[0].server_url, session.userId);
    let target: { version: string; userId: string };
    try {
      target = await client.connectionTest();
    } catch (cause) {
      if (cause instanceof ImmichTargetBlockedError) return reply.code(403).send(targetNotAllowed(cause));
      throw cause;
    }

    const write = await blobstore.beginWrite({ ownerUserId: session.userId });
    try {
      await blobstore.append(write, bytes);
      const digest = sha256Digest(bytes);
      const stored = await blobstore.finalize(write, digest);
      const local = {
        bytes: blobstore.openRead({ id: stored.id, ownerUserId: session.userId } as OwnedObjectRef),
        sha256: Buffer.from(digest.value).toString('hex'),
        sha1: createHash('sha1').update(bytes).digest('hex'),
        byteLength: bytes.length,
        fileName,
        createdAt: clock.now(),
        modifiedAt: clock.now()
      };
      const transfer = await transfers.create({ userId: session.userId, objectId: stored.id, targetId: target.userId, sha256: local.sha256 });
      const result = await new TransferService(transfers, client).run(transfer.id, local, target.userId, Number(connection.rows[0].generation));
      await audit(session.userId, 'immich.test_transfer', result.id, request);
      return { transfer: { id: result.id, status: result.status, localOriginalRetained: true } };
    } catch (cause) {
      await blobstore.abort(write);
      throw cause;
    }
  });

  app.get('/api/v1/immich/transfers/:id', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const id = (request.params as { id: string }).id;
    const transfer = await transfers.get(id);
    if (!transfer || transfer.userId !== session.userId) return reply.code(404).send(responseError('NOT_FOUND', 'Transfer nicht gefunden.'));
    return {
      transfer: {
        id: transfer.id,
        status: transfer.status,
        evidence: transfer.verifiedAt ? { serverVersion: transfer.verifiedServerVersion, byteLength: transfer.verifiedByteLength, album: transfer.verifiedAlbumState } : null,
        localOriginalRetained: true
      }
    };
  });
}
