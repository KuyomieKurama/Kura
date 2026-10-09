import { createDecipheriv } from 'node:crypto';
import type { OwnedObjectRef, StorageBackend } from '@kura/blobstore';
import {
  createGuardedFetch,
  ImmichClient,
  ImmichTargetBlockedError,
  TransferRepository,
  TransferService,
  type EndpointApprovals,
  type SecretResolver
} from '@kura/immich-client';
import type { Pool } from 'pg';
import type { HandoverState } from './history.js';

export interface HandoverInput {
  userId: string;
  objectId: string;
  sha256: string;
  sha1: string;
  byteLength: number;
  fileName: string;
  createdAt: Date;
  modifiedAt: Date;
}

export interface HandoverResult {
  state: HandoverState;
  transferId?: string;
}

/** Approved Immich endpoints on loopback or private addresses (the existing administrative mechanism). */
export class PostgresEndpointApprovals implements EndpointApprovals {
  constructor(private readonly pool: Pool) {}

  async isApproved(host: string, port: number): Promise<boolean> {
    const result = await this.pool.query('SELECT 1 FROM immich_endpoint_approvals WHERE host=$1 AND port=$2', [host, port]);
    return (result.rowCount ?? 0) > 0;
  }
}

/** Same scheme as the API's encryptSecret (apps/api/src/immich-routes.ts); keep the two in step. */
export function decryptSecret(key: Buffer, ciphertext: Buffer, nonce: Buffer, aad?: string): string {
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(ciphertext.subarray(-16));
  return Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString('utf8');
}

interface ImmichHandoverOptions {
  pool: Pool;
  blobstore: StorageBackend;
  /** Same key as the API's KURA_SECRET_KEY. Without it the stored API keys cannot be read. */
  secretKey?: Buffer;
  /** Replaceable in tests (resolver for the fake server's host name). Production uses the system resolver. */
  resolveHost?: (host: string) => Promise<string[]>;
}

/**
 * Hands a stored asset to the user's Immich through the existing TransferService (M3): upload, then the
 * original is read back and compared by SHA-256 and byte count. The local original is never touched here.
 * An uncertain outcome (lost response, readback not possible) stays uncertain; it is recorded as such and
 * retried later, never turned into success. Nothing in this class can delete anything.
 */
export class ImmichHandover {
  private readonly transfers: TransferRepository;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: ImmichHandoverOptions) {
    this.transfers = new TransferRepository(options.pool);
    this.fetcher = createGuardedFetch({
      approvals: new PostgresEndpointApprovals(options.pool),
      resolveHost: options.resolveHost
    });
  }

  async handOver(input: HandoverInput): Promise<HandoverResult> {
    const connection = await this.options.pool.query<{ server_url: string; generation: string }>(
      'SELECT server_url, generation FROM immich_connections WHERE user_id = $1',
      [input.userId]
    );
    const row = connection.rows[0];
    if (!row) return { state: 'no_connection' };
    if (!this.options.secretKey) return { state: 'error' };

    const client = new ImmichClient(row.server_url, `secret://immich/${input.userId}`, this.secretResolver(input.userId), this.fetcher);
    let target: { version: string; userId: string };
    try {
      target = await client.connectionTest();
    } catch (error) {
      return { state: error instanceof ImmichTargetBlockedError ? 'blocked' : 'error' };
    }

    let transferId: string | undefined;
    try {
      const transfer = await this.findOrCreateTransfer(input, target.userId);
      transferId = transfer.id;
      const result = await new TransferService(this.transfers, client).run(
        transfer.id,
        {
          bytes: this.options.blobstore.openRead({ id: input.objectId, ownerUserId: input.userId } as OwnedObjectRef),
          sha256: input.sha256,
          sha1: input.sha1,
          byteLength: input.byteLength,
          fileName: input.fileName,
          createdAt: input.createdAt,
          modifiedAt: input.modifiedAt
        },
        target.userId,
        Number(row.generation)
      );
      return { state: result.status, transferId: result.id };
    } catch {
      // The transfer row (if any) keeps its last durable state; the next run looks at it again.
      return { state: 'error', transferId };
    }
  }

  private async findOrCreateTransfer(input: HandoverInput, targetId: string) {
    const existing = await this.options.pool.query<{ id: string }>(
      'SELECT id FROM immich_transfers WHERE user_id = $1 AND object_id = $2 AND target_id = $3',
      [input.userId, input.objectId, targetId]
    );
    const found = existing.rows[0] ? await this.transfers.get(existing.rows[0].id) : undefined;
    if (found) return found;
    return this.transfers.create({ userId: input.userId, objectId: input.objectId, targetId, sha256: input.sha256 });
  }

  private secretResolver(userId: string): SecretResolver {
    return {
      resolve: async () => {
        const key = this.options.secretKey;
        if (!key) throw new Error('KURA_SECRET_KEY is not configured');
        const row = await this.options.pool.query<{ api_key_ciphertext: Buffer; api_key_nonce: Buffer }>(
          'SELECT api_key_ciphertext, api_key_nonce FROM immich_connections WHERE user_id = $1',
          [userId]
        );
        if (!row.rows[0]) throw new Error('Immich connection not found');
        return decryptSecret(key, row.rows[0].api_key_ciphertext, row.rows[0].api_key_nonce);
      }
    };
  }
}
