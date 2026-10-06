import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export type TransferStatus = 'pending' | 'uploading' | 'uploaded_unverified' | 'verified' | 'mismatch' | 'failed' | 'reconciling';
export interface SecretResolver { resolve(reference: `secret://immich/${string}`): Promise<string>; }
export interface TransferRecord { id: string; userId: string; objectId: string; targetId: string; status: TransferStatus; attempts: number; immichAssetId: string | null; sha256: string; verifiedAt: Date | null; error: string | null; }
export interface LocalObject { bytes: AsyncIterable<Uint8Array>; sha256: string; byteLength: number; fileName: string; createdAt: Date; modifiedAt: Date; sha1?: string; }
export interface ImmichAsset { id: string; ownerId?: string; fileCreatedAt?: string; }
export interface UploadResult { assetId: string; duplicate: boolean; }
export interface CleanupDecisionInput { verified: boolean; correctAccount: boolean; historyCommitted: boolean; validApproval: boolean; graceElapsed: boolean; noReference: boolean; configGenerationMatches: boolean; albumComplete: boolean; }
export interface CleanupDecision { allowed: boolean; reasons: string[]; }

/** Minimal Immich HTTP port. Route shapes are contract-tested only against Fake Immich.
 * Their exact release contract is unverified until a selected real Immich release is tested (D-004/D-005). */
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
    const version = await (await this.request('server/version')).json() as { version?: string };
    const user = await (await this.request('users/me')).json() as { id?: string };
    if (!version.version || !user.id) throw new Error('Immich connection response was incomplete');
    return { version: version.version, userId: user.id };
  }
  async upload(object: LocalObject, deviceId: string, deviceAssetId: string): Promise<UploadResult> {
    const form = new FormData();
    form.set('assetData', new Blob([Buffer.from(await collect(object.bytes))]), object.fileName);
    form.set('deviceId', deviceId); form.set('deviceAssetId', deviceAssetId);
    form.set('fileCreatedAt', object.createdAt.toISOString()); form.set('fileModifiedAt', object.modifiedAt.toISOString());
    const result = await (await this.request('assets', { method: 'POST', body: form })).json() as { id?: string; duplicate?: boolean };
    if (!result.id) throw new Error('Immich upload response had no asset id');
    return { assetId: result.id, duplicate: result.duplicate === true };
  }
  async findDuplicate(sha1: string): Promise<string | undefined> {
    const result = await (await this.request('assets/bulk-upload-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assets: [{ sha1 }] }) })).json() as Array<{ id?: string }>;
    return result[0]?.id;
  }
  async asset(assetId: string): Promise<ImmichAsset> { return await (await this.request(`assets/${encodeURIComponent(assetId)}`)).json() as ImmichAsset; }
  async original(assetId: string): Promise<AsyncIterable<Uint8Array>> {
    const body = (await this.request(`assets/${encodeURIComponent(assetId)}/original`)).body;
    if (!body) throw new Error('Immich original response had no body');
    return body as AsyncIterable<Uint8Array>;
  }
  async createAlbum(name: string): Promise<string> { const result = await (await this.request('albums', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ albumName: name }) })).json() as { id?: string }; if (!result.id) throw new Error('Immich album response had no id'); return result.id; }
  async addToAlbum(albumId: string, assetIds: string[]): Promise<void> { await this.request(`albums/${encodeURIComponent(albumId)}/assets`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: assetIds }) }); }
  async deleteAsset(assetId: string): Promise<void> { await this.request(`assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' }); }
}

export class TransferRepository {
  constructor(private readonly pool: Pool) {}
  async create(input: Omit<TransferRecord, 'id' | 'status' | 'attempts' | 'immichAssetId' | 'verifiedAt' | 'error'>): Promise<TransferRecord> {
    const id = randomUUID();
    const result = await this.pool.query<TransferRecord>('INSERT INTO immich_transfers (id,user_id,object_id,target_id,status,own_sha256) VALUES ($1,$2,$3,$4,\'pending\',$5) RETURNING id,user_id AS "userId",object_id AS "objectId",target_id AS "targetId",status,attempts,immich_asset_id AS "immichAssetId",own_sha256 AS sha256,verified_at AS "verifiedAt",error', [id, input.userId, input.objectId, input.targetId, input.sha256]);
    return result.rows[0]!;
  }
  async get(id: string): Promise<TransferRecord | undefined> { return (await this.pool.query<TransferRecord>('SELECT id,user_id AS "userId",object_id AS "objectId",target_id AS "targetId",status,attempts,immich_asset_id AS "immichAssetId",own_sha256 AS sha256,verified_at AS "verifiedAt",error FROM immich_transfers WHERE id=$1', [id])).rows[0]; }
  async transition(id: string, from: TransferStatus[], to: TransferStatus, patch: { assetId?: string; error?: string | null; verified?: boolean } = {}): Promise<TransferRecord> {
    const result = await this.pool.query<TransferRecord>('UPDATE immich_transfers SET status=$3, attempts=attempts+CASE WHEN $3=\'uploading\' THEN 1 ELSE 0 END, immich_asset_id=COALESCE($4,immich_asset_id), error=$5, verified_at=CASE WHEN $6 THEN now() ELSE verified_at END, updated_at=now() WHERE id=$1 AND status=ANY($2::text[]) RETURNING id,user_id AS "userId",object_id AS "objectId",target_id AS "targetId",status,attempts,immich_asset_id AS "immichAssetId",own_sha256 AS sha256,verified_at AS "verifiedAt",error', [id, from, to, patch.assetId ?? null, patch.error ?? null, patch.verified === true]);
    if (!result.rows[0]) throw new Error(`Invalid or concurrent transfer transition for ${id}`);
    return result.rows[0];
  }
}

export class TransferService {
  constructor(private readonly transfers: TransferRepository, private readonly client: ImmichClient) {}
  async run(id: string, object: LocalObject, expectedAccountId: string, deviceId: string): Promise<TransferRecord> {
    const transfer = await this.transfers.get(id); if (!transfer) throw new Error('Transfer not found');
    if (transfer.status === 'verified' || transfer.status === 'mismatch') return transfer;
    let assetId = transfer.immichAssetId;
    if (!assetId) {
      await this.transfers.transition(id, ['pending', 'failed', 'reconciling', 'uploading'], 'uploading');
      try { assetId = (await this.client.upload(object, deviceId, id)).assetId; }
      catch (error) {
        const duplicate = object.sha1 ? await this.client.findDuplicate(object.sha1).catch(() => undefined) : undefined;
        if (!duplicate) return this.transfers.transition(id, ['uploading'], 'reconciling', { error: safeError(error) });
        assetId = duplicate;
      }
      await this.transfers.transition(id, ['uploading', 'reconciling'], 'uploaded_unverified', { assetId, error: null });
    }
    const asset = await this.client.asset(assetId);
    if (asset.ownerId !== expectedAccountId) return this.transfers.transition(id, ['uploaded_unverified', 'reconciling'], 'mismatch', { error: 'Remote asset belongs to a different account' });
    const remote = await digest(await this.client.original(assetId));
    if (remote.sha256 !== object.sha256 || remote.bytes !== object.byteLength) return this.transfers.transition(id, ['uploaded_unverified'], 'mismatch', { error: 'Original byte readback differs from local object' });
    return this.transfers.transition(id, ['uploaded_unverified'], 'verified', { verified: true, error: null });
  }
}

export function decideLocalDeletion(input: CleanupDecisionInput): CleanupDecision {
  const checks: Array<[boolean, string]> = [[input.verified, 'transfer is not verified'], [input.correctAccount, 'target account is not proven correct'], [input.historyCommitted, 'history is not durably committed'], [input.validApproval, 'no valid deletion approval'], [input.graceElapsed, 'grace period has not elapsed'], [input.noReference, 'local object still has a reference'], [input.configGenerationMatches, 'connection generation changed'], [input.albumComplete, 'required album assignment is incomplete']];
  const reasons = checks.filter(([ok]) => !ok).map(([, reason]) => reason); return { allowed: reasons.length === 0, reasons };
}
async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> { const values: Uint8Array[] = []; let length = 0; for await (const value of chunks) { values.push(value); length += value.length; } const result = new Uint8Array(length); let offset = 0; for (const value of values) { result.set(value, offset); offset += value.length; } return result; }
async function digest(chunks: AsyncIterable<Uint8Array>): Promise<{ sha256: string; bytes: number }> { const hash = createHash('sha256'); let bytes = 0; for await (const chunk of chunks) { hash.update(chunk); bytes += chunk.byteLength; } return { sha256: hash.digest('hex'), bytes }; }
function safeError(error: unknown): string { return error instanceof Error ? error.message.replace(/secret:\/\/immich\/[^\s]+/g, 'secret://immich/[redacted]') : 'Unknown upload failure'; }
