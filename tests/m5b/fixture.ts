import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseBlobStore } from '../../packages/blobstore/src/index.js';
import { createGuardedFetch } from '../../packages/immich-client/src/index.js';
import {
  JobQueue,
  ManualClock,
  SubscriptionRepository,
  type Clock,
  type JobLease,
  type SubscriptionRecord
} from '../../packages/scheduler/src/index.js';
import { runMigrations } from '../../packages/storage/src/migrator.js';
import { AdapterCatalog, approveNothing, type DirectUrlSettings } from '../../apps/worker/src/catalog.js';
import { JobExecutor, type ExecutionOutcome } from '../../apps/worker/src/executor.js';
import { ImmichHandover } from '../../apps/worker/src/handover.js';
import { HistoryRepository } from '../../apps/worker/src/history.js';
import type { Logger } from '../../apps/worker/src/scheduler-loop.js';
import { createMigrationsCopy, createTestDatabase } from '../helpers/database.js';
import { tempDir } from '../adapters/helpers.js';
import { FakeImmich, type UploadMode } from './fake-immich.js';
import { FileServer } from './file-server.js';
import type { ControllableTool } from './tools.js';

export const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
/** A small jpeg-looking file whose checksum depends on `label`. */
export const jpeg = (label: string): Buffer => Buffer.concat([JPEG_HEAD, Buffer.from(`kura test image ${label}`)]);

export interface FixtureOptions {
  quotaBytes?: number;
  clock?: Clock;
  tools?: { ytDlp?: ControllableTool; galleryDl?: ControllableTool };
  /** false = production behaviour: the guard refuses the loopback test server. */
  directApproved?: boolean;
  immichMode?: UploadMode;
  maxAssetBytes?: number;
}

export interface LogEntry { level: 'info' | 'error'; message: string; fields?: Record<string, unknown> }

export async function createPipelineFixture(options: FixtureOptions = {}) {
  const database = await createTestDatabase();
  const migrations = await createMigrationsCopy();
  await runMigrations(database.pool, migrations.directory);
  const { pool } = database;

  const clock = options.clock ?? new ManualClock('2026-06-01T10:00:00Z');
  const workDir = await tempDir('kura-m5b-work-');
  const files = new FileServer();
  await files.start();
  const immich = new FakeImmich(options.immichMode ?? 'normal');
  const immichUrl = await immich.start();
  const secretKey = randomBytes(32);

  const logs: LogEntry[] = [];
  const logger: Logger = {
    info: (message, fields) => logs.push({ level: 'info', message, fields }),
    error: (message, fields) => logs.push({ level: 'error', message, fields })
  };

  // Test-only network policy: loopback of the file server is approved and the https URL is carried over
  // plain HTTP. The guard itself (address classification, approval check, no redirects) is the real one.
  const approvals = { isApproved: async (host: string, port: number) => host === '127.0.0.1' && port === files.port };
  const guarded = createGuardedFetch({ approvals });
  const directUrl: DirectUrlSettings = options.directApproved === false
    ? { approvals: approveNothing }
    : { approvals, fetcher: (input, init) => guarded(String(input).replace(/^https:/, 'http:'), init) };

  const catalog = new AdapterCatalog({
    tools: {
      ytDlp: options.tools?.ytDlp ? options.tools.ytDlp.binary : undefined,
      galleryDl: options.tools?.galleryDl ? options.tools.galleryDl.binary : undefined,
      toolPath: undefined
    },
    workDir,
    maxAssetBytes: options.maxAssetBytes ?? 10 * 1024 * 1024,
    directUrl,
    logger,
    toolEnvironment: { ytDlp: options.tools?.ytDlp?.env, galleryDl: options.tools?.galleryDl?.env }
  });
  await catalog.refresh();

  const blobstore = new DatabaseBlobStore(pool, { quotaBytes: options.quotaBytes ?? 50 * 1024 * 1024 });
  const history = new HistoryRepository(pool, clock);
  const subscriptions = new SubscriptionRepository(pool, clock);
  const queue = new JobQueue(pool, { clock, random: () => 0 });
  const handover = new ImmichHandover({ pool, blobstore, secretKey });
  const executor = new JobExecutor({
    pool, queue, subscriptions, history, blobstore, catalog, handover, clock, logger, workDir,
    maxAssetBytes: options.maxAssetBytes ?? 10 * 1024 * 1024
  });

  let adminId: string | undefined;
  const newUser = async (name = 'User', role: 'admin' | 'user' = 'user'): Promise<string> => {
    const id = randomUUID();
    await pool.query('INSERT INTO users (id, display_name, role) VALUES ($1, $2, $3)', [id, name, role]);
    return id;
  };

  /** Gives the user an Immich connection to the fake server, approved through the administrator mechanism. */
  const connectImmich = async (userId: string): Promise<void> => {
    adminId ??= await newUser('Admin', 'admin');
    const url = new URL(immichUrl);
    await pool.query(
      'INSERT INTO immich_endpoint_approvals (host, port, approved_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [url.hostname, Number(url.port), adminId]
    );
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', secretKey, nonce);
    const ciphertext = Buffer.concat([cipher.update('fake-api-key', 'utf8'), cipher.final(), cipher.getAuthTag()]);
    await pool.query(
      'INSERT INTO immich_connections (user_id, server_url, api_key_ciphertext, api_key_nonce) VALUES ($1, $2, $3, $4)',
      [userId, immichUrl, ciphertext, nonce]
    );
  };

  const subscribe = (userId: string, targetUrl: string, name = 'Test source'): Promise<SubscriptionRecord> =>
    subscriptions.createSubscription({ userId, name, sourceRef: targetUrl });

  /** "Jetzt ausführen" and the claim a worker would do. */
  const queueAndClaim = async (userId: string, subscriptionId: string): Promise<JobLease> => {
    await queue.enqueueManual(userId, subscriptionId);
    const lease = await queue.claim({ workerId: 'test-worker', leaseSeconds: 120 });
    if (!lease) throw new Error('nothing to claim');
    return lease;
  };

  const runOnce = async (userId: string, subscriptionId: string, signal: AbortSignal = new AbortController().signal): Promise<{ lease: JobLease; outcome: ExecutionOutcome }> => {
    const lease = await queueAndClaim(userId, subscriptionId);
    return { lease, outcome: await executor.execute(lease, signal) };
  };

  /** Moves the test clock (queue backoff, lease expiry). Not available with a real clock. */
  const advance = (seconds: number): void => {
    if (!(clock instanceof ManualClock)) throw new Error('advance() needs the manual clock');
    clock.advanceSeconds(seconds);
  };

  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await pool.query(sql, params)).rows as T[];

  return {
    pool, clock, advance, workDir, files, immich, immichUrl, secretKey, logs, logger, directUrl, catalog, blobstore, history,
    subscriptions, queue, executor, handover, newUser, connectImmich, subscribe, queueAndClaim, runOnce, rows,
    async cleanup() {
      await files.stop();
      await immich.stop();
      await migrations.cleanup();
      await database.cleanup();
    }
  };
}

export type PipelineFixture = Awaited<ReturnType<typeof createPipelineFixture>>;
