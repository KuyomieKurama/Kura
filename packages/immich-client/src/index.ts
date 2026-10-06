import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export type TransferStatus = 'pending' | 'uploading' | 'uploaded_unverified' | 'verified' | 'mismatch' | 'failed' | 'reconciling';
export interface SecretResolver { resolve(reference: `secret://immich/${string}`): Promise<string>; }
export interface VerificationEvidence { serverVersion: string; targetAccountId: string; connectionGeneration: number; }
export interface TransferRecord {
  id: string; userId: string; objectId: string; targetId: string; status: TransferStatus; attempts: number; immichAssetId: string | null; sha256: string; verifiedAt: Date | null; verifiedServerVersion: string | null; verifiedTargetAccountId: string | null; verifiedConnectionGeneration: number | null; error: string | null;
}
export interface LocalObject { bytes: AsyncIterable<Uint8Array>; sha256: string; byteLength: number; fileName: string; createdAt: Date; modifiedAt: Date; sha1?: string; }
export interface ImmichAsset { id: string; ownerId?: string; fileCreatedAt?: string; }
export interface UploadResult { assetId: string; duplicate: boolean; }
export interface CleanupDecisionInput { verified: boolean; correctAccount: boolean; historyCommitted: boolean; validApproval: boolean; graceElapsed: boolean; noReference: boolean; configGenerationMatches: boolean; albumComplete: boolean; }
export interface CleanupDecision { allowed: boolean; reasons: string[]; }

/**
 * API contract source: Immich v3.2.1 OpenAPI, commit tag v3.2.1:
 * https://raw.githubusercontent.com/immich-app/immich/v3.2.1/open-api/immich-openapi-specs.json
 * This is an evidence source, not a Kura-supported version pin. D-004 requires a real contract test before pinning.
 */
export class ImmichClient {
  constructor(private readonly baseUrl: string, private readonly secretReference: `secret://immich/${string}`, private readonly secrets: SecretResolver, private readonly fetcher: typeof fetch = fetch) {}
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const key = await this.secrets.resolve(this.secretReference);
    const response = await this.fetcher(new URL(`/api/${path}`, this.baseUrl), { ...init, headers: { 'x-api-key': key, ...init.headers } });
    if (!response.ok) throw new Error(`Immich request failed (${response.status})`);
    return response;
  }
  async connectionTest(): Promise<{ version: string; userId: string }> {
    await this.request('server/ping');
    const version = await (await this.request('server/version')).json() as { major?: number; minor?: number; patch?: number; prerelease?: number | null };
    const user = await (await this.request('users/me')).json() as { id?: string };
    if (![version.major, version.minor, version.patch].every(Number.isInteger) || !user.id) throw new Error('Immich connection response was incomplete');
    const suffix = version.prerelease === null || version.prerelease === undefined ? '' : `-rc.${version.prerelease}`;
    return { version: `${version.major}.${version.minor}.${version.patch}${suffix}`, userId: user.id };
  }
  /**
   * v3.2.1 AssetMediaCreateDto documents assetData, fileCreatedAt and
   * fileModifiedAt. deviceId/deviceAssetId are intentionally not sent: their
   * requested use is unverified for this evidenced contract (D-004).
   */
  async upload(object: LocalObject): Promise<UploadResult> {
    const boundary = `----kura-${randomUUID()}`;
    const body = multipartStream(boundary, object);
    const result = await (await this.request('assets', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
      // Node fetch requires duplex for a ReadableStream request body.
      duplex: 'half'
    } as RequestInit & { duplex: 'half' })).json() as { id?: string; status?: unknown };
    if (!result.id || (result.status !== 'created' && result.status !== 'duplicate')) throw new Error('Immich upload response had an invalid id or status');
    return { assetId: result.id, duplicate: result.status === 'duplicate' };
  }
  async findDuplicate(sha1: string, clientId = 'kura-reconcile'): Promise<string | undefined> {
    const result = await (await this.request('assets/bulk-upload-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assets: [{ id: clientId, checksum: sha1 }] }) })).json() as { results?: Array<{ id?: string; assetId?: string }> };
    return result.results?.[0]?.assetId ?? result.results?.[0]?.id;
  }
  async asset(assetId: string): Promise<ImmichAsset> { return await (await this.request(`assets/${encodeURIComponent(assetId)}`)).json() as ImmichAsset; }
  async original(assetId: string): Promise<AsyncIterable<Uint8Array>> { const body = (await this.request(`assets/${encodeURIComponent(assetId)}/original`)).body; if (!body) throw new Error('Immich original response had no body'); return body as AsyncIterable<Uint8Array>; }
  async createAlbum(name: string): Promise<string> { const result = await (await this.request('albums', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ albumName: name }) })).json() as { id?: string }; if (!result.id) throw new Error('Immich album response had no id'); return result.id; }
  async addToAlbum(albumId: string, assetIds: string[]): Promise<void> { await this.request(`albums/${encodeURIComponent(albumId)}/assets`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: assetIds }) }); }
  /** OpenAPI v3.2.1 specifies bulk DELETE /assets, not singular DELETE /assets/{id}. */
  async deleteAsset(assetId: string): Promise<void> { await this.request('assets', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [assetId] }) }); }
}

const recordColumns = 'id,user_id AS "userId",object_id AS "objectId",target_id AS "targetId",status,attempts,immich_asset_id AS "immichAssetId",own_sha256 AS sha256,verified_at AS "verifiedAt",verified_server_version AS "verifiedServerVersion",verified_target_account_id AS "verifiedTargetAccountId",verified_connection_generation AS "verifiedConnectionGeneration",error';
export class TransferRepository {
  constructor(private readonly pool: Pool) {}
  async create(input: Omit<TransferRecord, 'id' | 'status' | 'attempts' | 'immichAssetId' | 'verifiedAt' | 'verifiedServerVersion' | 'verifiedTargetAccountId' | 'verifiedConnectionGeneration' | 'error'>): Promise<TransferRecord> {
    const result = await this.pool.query<TransferRecord>(`INSERT INTO immich_transfers (id,user_id,object_id,target_id,status,own_sha256) VALUES ($1,$2,$3,$4,'pending',$5) RETURNING ${recordColumns}`, [randomUUID(), input.userId, input.objectId, input.targetId, input.sha256]);
    return toTransferRecord(result.rows[0]!);
  }
  async get(id: string): Promise<TransferRecord | undefined> { const row = (await this.pool.query<TransferRecord>(`SELECT ${recordColumns} FROM immich_transfers WHERE id=$1`, [id])).rows[0]; return row ? toTransferRecord(row) : undefined; }
  async transition(id: string, from: TransferStatus[], to: TransferStatus, patch: { assetId?: string; error?: string | null; evidence?: VerificationEvidence } = {}): Promise<TransferRecord> {
    const result = await this.pool.query<TransferRecord>(`UPDATE immich_transfers SET status=$3, attempts=attempts+CASE WHEN $3='uploading' THEN 1 ELSE 0 END, immich_asset_id=COALESCE($4,immich_asset_id), error=$5, verified_at=CASE WHEN $6::text IS NOT NULL THEN now() ELSE verified_at END, verified_server_version=COALESCE($6,verified_server_version), verified_target_account_id=COALESCE($7,verified_target_account_id), verified_connection_generation=COALESCE($8,verified_connection_generation), updated_at=now() WHERE id=$1 AND status=ANY($2::text[]) RETURNING ${recordColumns}`, [id, from, to, patch.assetId ?? null, patch.error ?? null, patch.evidence?.serverVersion ?? null, patch.evidence?.targetAccountId ?? null, patch.evidence?.connectionGeneration ?? null]);
    if (!result.rows[0]) throw new Error(`Invalid or concurrent transfer transition for ${id}`);
    return toTransferRecord(result.rows[0]);
  }
}
function toTransferRecord(row: TransferRecord): TransferRecord {
  return { ...row, verifiedConnectionGeneration: row.verifiedConnectionGeneration === null ? null : Number(row.verifiedConnectionGeneration) };
}

export class TransferService {
  constructor(private readonly transfers: TransferRepository, private readonly client: ImmichClient) {}
  async run(id: string, object: LocalObject, expectedAccountId: string, connectionGeneration: number): Promise<TransferRecord> {
    const transfer = await this.transfers.get(id); if (!transfer) throw new Error('Transfer not found');
    if (transfer.status === 'verified' || transfer.status === 'mismatch') return transfer;
    const connection = await this.client.connectionTest();
    if (connection.userId !== expectedAccountId) return this.transfers.transition(id, ['pending', 'uploading', 'uploaded_unverified', 'reconciling', 'failed'], 'mismatch', { error: 'Connection belongs to a different account' });
    let assetId = transfer.immichAssetId;
    if (!assetId) {
      const resumingUncertainUpload = transfer.status === 'uploading' || transfer.status === 'reconciling';
      if (resumingUncertainUpload && object.sha1) {
        // A prior process may have uploaded successfully before its local checkpoint.
        // Reconcile the remote original before risking another upload.
        assetId = await this.client.findDuplicate(object.sha1, id).catch(() => undefined);
      }
      if (!assetId) {
        await this.transfers.transition(id, ['pending', 'failed', 'reconciling', 'uploading'], 'uploading');
        try { assetId = (await this.client.upload(object)).assetId; }
        catch (error) {
          const duplicate = object.sha1 ? await this.client.findDuplicate(object.sha1, id).catch(() => undefined) : undefined;
          if (!duplicate) return this.transfers.transition(id, ['uploading'], 'reconciling', { error: safeError(error) });
          assetId = duplicate;
        }
      }
      await this.transfers.transition(id, ['uploading', 'reconciling'], 'uploaded_unverified', { assetId, error: null });
    }
    const asset = await this.client.asset(assetId);
    if (asset.ownerId !== expectedAccountId) return this.transfers.transition(id, ['uploaded_unverified', 'reconciling'], 'mismatch', { error: 'Remote asset belongs to a different account' });
    const remote = await digest(await this.client.original(assetId));
    if (remote.sha256 !== object.sha256 || remote.bytes !== object.byteLength) return this.transfers.transition(id, ['uploaded_unverified'], 'mismatch', { error: 'Original byte readback differs from local object' });
    return this.transfers.transition(id, ['uploaded_unverified'], 'verified', { evidence: { serverVersion: connection.version, targetAccountId: connection.userId, connectionGeneration }, error: null });
  }
}

export function decideLocalDeletion(input: CleanupDecisionInput): CleanupDecision {
  const checks: Array<[boolean, string]> = [[input.verified, 'transfer is not verified'], [input.correctAccount, 'target account is not proven correct'], [input.historyCommitted, 'history is not durably committed'], [input.validApproval, 'no valid deletion approval'], [input.graceElapsed, 'grace period has not elapsed'], [input.noReference, 'local object still has a reference'], [input.configGenerationMatches, 'connection generation changed'], [input.albumComplete, 'required album assignment is incomplete']];
  const reasons = checks.filter(([ok]) => !ok).map(([, reason]) => reason); return { allowed: reasons.length === 0, reasons };
}

function multipartStream(boundary: string, object: LocalObject): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const field = (name: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const prefix = `${field('fileCreatedAt', object.createdAt.toISOString())}${field('fileModifiedAt', object.modifiedAt.toISOString())}--${boundary}\r\nContent-Disposition: form-data; name="assetData"; filename="${object.fileName.replaceAll('"', '')}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const iterator = object.bytes[Symbol.asyncIterator](); let stage = 0;
  return new ReadableStream<Uint8Array>({ async pull(controller) {
    if (stage === 0) { stage = 1; controller.enqueue(encoder.encode(prefix)); return; }
    if (stage === 1) { const next = await iterator.next(); if (!next.done) { controller.enqueue(next.value); return; } stage = 2; }
    controller.enqueue(encoder.encode(`\r\n--${boundary}--\r\n`)); controller.close();
  }, async cancel() { await iterator.return?.(); } });
}
async function digest(chunks: AsyncIterable<Uint8Array>): Promise<{ sha256: string; bytes: number }> { const hash = createHash('sha256'); let bytes = 0; for await (const chunk of chunks) { hash.update(chunk); bytes += chunk.byteLength; } return { sha256: hash.digest('hex'), bytes }; }
function safeError(error: unknown): string { return error instanceof Error ? error.message.replace(/secret:\/\/immich\/[^\s]+/g, 'secret://immich/[redacted]') : 'Unknown upload failure'; }
