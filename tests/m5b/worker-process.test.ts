import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDownloadConfig, loadWorkerConfig } from '../../apps/worker/src/config.js';
import { DownloadLoop } from '../../apps/worker/src/download-loop.js';
import { removeStaleWorkspaces } from '../../apps/worker/src/maintenance.js';
import { Worker } from '../../apps/worker/src/worker.js';
import { RuntimePolicyRepository, systemClock } from '../../packages/scheduler/src/index.js';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from '../adapters/helpers.js';
import { createPipelineFixture, jpeg, type PipelineFixture } from './fixture.js';

describe('download configuration of the worker', () => {
  const base = { DATABASE_URL: 'postgres://h/db' };

  it('has working defaults and leaves the scheduler configuration unchanged', () => {
    expect(loadWorkerConfig(base)).toEqual({ databaseUrl: 'postgres://h/db', tickIntervalMs: 15_000, retentionIntervalMs: 3_600_000 });
    const downloads = loadDownloadConfig(base)!;
    expect(downloads).toMatchObject({ concurrency: 2, pollIntervalMs: 5000, leaseSeconds: 120, maxAssetBytes: 2 * 1024 ** 3, quotaBytes: 10 * 1024 ** 3 });
    expect(downloads.tools).toEqual({ ytDlp: undefined, galleryDl: undefined, toolPath: undefined });
    expect(downloads.secretKey).toBeUndefined();
  });

  it('can be switched off, so a process only schedules', () => {
    expect(loadDownloadConfig({ ...base, WORKER_DOWNLOADS: 'false' })).toBeUndefined();
    expect(() => loadDownloadConfig({ ...base, WORKER_DOWNLOADS: 'maybe' })).toThrow(/WORKER_DOWNLOADS/);
  });

  it('reads the tool paths with their expected hashes and refuses half a pair', () => {
    const hash = 'a'.repeat(64);
    const config = loadDownloadConfig({ ...base, KURA_YTDLP_PATH: '/opt/tools/yt-dlp', KURA_YTDLP_SHA256: hash, KURA_GALLERYDL_PATH: '/opt/tools/gallery-dl', KURA_GALLERYDL_SHA256: hash, KURA_TOOL_PATH: '/opt/ffmpeg/bin' })!;
    expect(config.tools).toEqual({ ytDlp: { path: '/opt/tools/yt-dlp', sha256: hash }, galleryDl: { path: '/opt/tools/gallery-dl', sha256: hash }, toolPath: '/opt/ffmpeg/bin' });
    expect(() => loadDownloadConfig({ ...base, KURA_YTDLP_PATH: '/opt/tools/yt-dlp' })).toThrow(/KURA_YTDLP_PATH and KURA_YTDLP_SHA256 must be set together/);
    expect(() => loadDownloadConfig({ ...base, KURA_YTDLP_SHA256: hash })).toThrow(/must be set together/);
    expect(() => loadDownloadConfig({ ...base, KURA_YTDLP_PATH: 'yt-dlp', KURA_YTDLP_SHA256: hash })).toThrow(/absolute path/);
    expect(() => loadDownloadConfig({ ...base, KURA_YTDLP_PATH: '/opt/tools/yt-dlp', KURA_YTDLP_SHA256: 'ABC' })).toThrow(/64 lowercase hex/);
  });

  it('validates numbers and the secret key', () => {
    expect(() => loadDownloadConfig({ ...base, WORKER_DOWNLOAD_CONCURRENCY: '0' })).toThrow(/WORKER_DOWNLOAD_CONCURRENCY/);
    expect(() => loadDownloadConfig({ ...base, WORKER_LEASE_SECONDS: '5' })).toThrow(/WORKER_LEASE_SECONDS/);
    expect(() => loadDownloadConfig({ ...base, KURA_SECRET_KEY: 'short' })).toThrow(/KURA_SECRET_KEY/);
    expect(loadDownloadConfig({ ...base, KURA_SECRET_KEY: Buffer.alloc(32, 1).toString('base64') })!.secretKey).toHaveLength(32);
  });
});

describe('abandoned workspaces', () => {
  it('removes only old directories with the workspace name and nothing else', async () => {
    const root = await tempDir('kura-m5b-stale-');
    const old = join(root, `run-${'a'.repeat(24)}`);
    const young = join(root, `run-${'b'.repeat(24)}`);
    const foreign = join(root, 'media-archive');
    for (const directory of [old, young, foreign]) {
      await mkdir(directory);
      await writeFile(join(directory, 'file'), 'x');
    }
    const yesterday = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    await utimes(old, yesterday, yesterday);
    await utimes(foreign, yesterday, yesterday);

    expect(await removeStaleWorkspaces(root, 24 * 3600 * 1000, systemClock)).toBe(1);
    expect(await removeStaleWorkspaces(root, 24 * 3600 * 1000, systemClock)).toBe(0);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(root)).sort()).toEqual([`run-${'b'.repeat(24)}`, 'media-archive'].sort());
    expect(await removeStaleWorkspaces(join(root, 'does-not-exist'), 1, systemClock)).toBe(0);
  });
});

describe('claim loop (real clock, real timers)', () => {
  const open: Array<{ subject: PipelineFixture; loop?: DownloadLoop }> = [];
  afterEach(async () => {
    for (const entry of open.splice(0)) {
      entry.subject.files.release();
      await entry.loop?.stop();
      await entry.subject.cleanup();
    }
  });

  async function setup(options: { stalled: boolean; concurrency?: number; users?: number }) {
    const subject = await createPipelineFixture({ clock: systemClock });
    const entry: { subject: PipelineFixture; loop?: DownloadLoop } = { subject };
    open.push(entry);
    const body = Buffer.concat([jpeg('loop'), Buffer.alloc(100_000, 3)]);
    subject.files.serve('/loop.jpg', { body, contentType: 'image/jpeg', etag: '"l"', ...(options.stalled ? { stallAfterBytes: 500 } : {}) });
    const subscriptions = [];
    for (let index = 0; index < (options.users ?? 1); index += 1) {
      const userId = await subject.newUser(`User ${index}`);
      const subscription = await subject.subscribe(userId, subject.files.url('/loop.jpg'));
      await subject.queue.enqueueManual(userId, subscription.id);
      subscriptions.push({ userId, subscription });
    }
    const loop = new DownloadLoop({
      queue: subject.queue,
      executor: subject.executor,
      policies: new RuntimePolicyRepository(subject.pool),
      subscriptions: subject.subscriptions,
      logger: subject.logger,
      concurrency: options.concurrency ?? 1,
      pollIntervalMs: 20,
      leaseSeconds: 30,
      heartbeatEveryMs: 25,
      workerName: 'test'
    });
    entry.loop = loop;
    return { subject, loop, subscriptions };
  }

  const leased = (subject: PipelineFixture) => subject.rows<{ lease_expires_at: Date; heartbeat_at: Date; lease_owner: string }>("SELECT lease_expires_at, heartbeat_at, lease_owner FROM job_runs WHERE state = 'leased'");

  it('claims a queued run and executes it', async () => {
    const { subject, loop } = await setup({ stalled: false });
    await loop.start();
    await vi.waitFor(async () => expect(await subject.rows('SELECT state FROM job_runs')).toEqual([{ state: 'succeeded' }]), { timeout: 5000 });
    expect(await subject.rows('SELECT state FROM download_runs')).toEqual([{ state: 'stored' }]);
    expect(subject.logs.filter((entry) => entry.level === 'error')).toEqual([]);
  });

  it('keeps the lease alive while a long download runs', async () => {
    const { subject, loop } = await setup({ stalled: true });
    await loop.start();
    await vi.waitFor(async () => expect((await leased(subject)).length).toBe(1), { timeout: 5000 });
    await vi.waitFor(async () => expect(await subject.rows("SELECT 1 FROM download_assets WHERE state = 'downloading'")).toHaveLength(1), { timeout: 5000 });
    const first = (await leased(subject))[0]!;
    await vi.waitFor(async () => expect((await leased(subject))[0]!.heartbeat_at.getTime()).toBeGreaterThan(first.heartbeat_at.getTime()), { timeout: 5000 });
    expect((await leased(subject))[0]!.lease_expires_at.getTime()).toBeGreaterThan(first.lease_expires_at.getTime());
    subject.files.release();
    await vi.waitFor(async () => expect(await subject.rows('SELECT state FROM job_runs')).toEqual([{ state: 'succeeded' }]), { timeout: 5000 });
  });

  it('abandons a run whose lease another worker took over, without touching the queue', async () => {
    const { subject, loop } = await setup({ stalled: true });
    await loop.start();
    await vi.waitFor(async () => expect(await subject.rows("SELECT 1 FROM download_assets WHERE state = 'downloading'")).toHaveLength(1), { timeout: 5000 });

    // Another worker takes the run over: owner and generation change.
    await subject.pool.query("UPDATE job_runs SET lease_owner = 'thief', attempts = attempts + 1, max_attempts = max_attempts + 1");

    await vi.waitFor(async () => expect(await subject.rows('SELECT state, error_code FROM download_runs')).toEqual([{ state: 'retry_wait', error_code: 'LEASE_LOST' }]), { timeout: 5000 });
    expect(await subject.rows('SELECT state, lease_owner FROM job_runs')).toEqual([{ state: 'leased', lease_owner: 'thief' }]);
    expect(await subject.rows('SELECT 1 FROM blobstore_objects')).toEqual([]);
  });

  it('stops a run when its subscription is paused', async () => {
    const { subject, loop, subscriptions } = await setup({ stalled: true });
    await loop.start();
    await vi.waitFor(async () => expect(await subject.rows("SELECT 1 FROM download_assets WHERE state = 'downloading'")).toHaveLength(1), { timeout: 5000 });

    await subject.subscriptions.pauseSubscription(subscriptions[0]!.userId, subscriptions[0]!.subscription.id);

    await vi.waitFor(async () => expect(await subject.rows('SELECT state, error_code FROM download_runs')).toEqual([{ state: 'paused', error_code: 'SUBSCRIPTION_PAUSED' }]), { timeout: 5000 });
    expect(await subject.rows('SELECT state FROM job_runs')).toEqual([{ state: 'retry_wait' }]);
    expect(await subject.rows('SELECT 1 FROM blobstore_objects')).toEqual([]);
  });

  it('hands the run back when the process shuts down', async () => {
    const { subject, loop } = await setup({ stalled: true });
    await loop.start();
    await vi.waitFor(async () => expect(await subject.rows("SELECT 1 FROM download_assets WHERE state = 'downloading'")).toHaveLength(1), { timeout: 5000 });

    await loop.stop();

    expect(await subject.rows('SELECT state, error_code FROM download_runs')).toEqual([{ state: 'retry_wait', error_code: 'SHUTDOWN' }]);
    expect(await subject.rows('SELECT state FROM job_runs')).toEqual([{ state: 'retry_wait' }]);
  });

  it.each([[1, 1], [2, 2]])('runs at most `concurrency` jobs at once (concurrency %i -> %i leased)', async (concurrency, expectedLeased) => {
    const { subject, loop } = await setup({ stalled: true, concurrency, users: 2 });
    await loop.start();
    await vi.waitFor(async () => expect((await leased(subject)).length).toBe(expectedLeased), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await leased(subject)).length).toBe(expectedLeased);
    expect((await leased(subject)).every((row) => row.lease_owner.startsWith('test:'))).toBe(true);
  });
});

describe('the worker process', () => {
  const open: Array<{ subject: PipelineFixture; worker?: Worker }> = [];
  afterEach(async () => {
    for (const entry of open.splice(0)) {
      await entry.worker?.stop();
      await entry.subject.cleanup();
    }
  });

  it('executes a "Jetzt ausführen" run end to end and publishes which adapters it can run', async () => {
    const subject = await createPipelineFixture({ clock: systemClock });
    const entry: { subject: PipelineFixture; worker?: Worker } = { subject };
    open.push(entry);
    const bytes = jpeg('worker e2e');
    subject.files.serve('/e2e.jpg', { body: bytes, contentType: 'image/jpeg', etag: '"e"' });
    const userId = await subject.newUser('Alice');
    await subject.connectImmich(userId);
    const subscription = await subject.subscribe(userId, subject.files.url('/e2e.jpg'), 'E2E');
    await subject.queue.enqueueManual(userId, subscription.id);

    const worker = new Worker(
      {
        databaseUrl: subject.databaseUrl,
        tickIntervalMs: 60_000,
        retentionIntervalMs: 3_600_000,
        downloads: {
          concurrency: 1, pollIntervalMs: 20, leaseSeconds: 30, workDir: subject.workDir, quotaBytes: 50 * 1024 * 1024,
          maxAssetBytes: 10 * 1024 * 1024, secretKey: subject.secretKey, tools: {}, adapterRecheckMs: 3_600_000
        }
      },
      subject.logger,
      { directUrl: subject.directUrl, heartbeatEveryMs: 50, workerName: 'e2e' }
    );
    entry.worker = worker;
    await worker.start();

    await vi.waitFor(async () => expect(await subject.rows('SELECT state FROM download_runs')).toEqual([{ state: 'stored' }]), { timeout: 10_000 });
    expect(await subject.rows('SELECT state, handover_state FROM download_assets')).toEqual([{ state: 'stored', handover_state: 'verified' }]);
    expect([...subject.immich.assets.values()][0]).toEqual(bytes);
    expect(await subject.rows('SELECT state FROM job_runs')).toEqual([{ state: 'succeeded' }]);
    expect(await subject.rows('SELECT adapter_id, availability, reason_code FROM adapter_status ORDER BY adapter_id')).toEqual([
      { adapter_id: 'direct-url', availability: 'available', reason_code: null },
      { adapter_id: 'gallery-dl', availability: 'unavailable', reason_code: 'BINARY_NOT_CONFIGURED' },
      { adapter_id: 'yt-dlp', availability: 'unavailable', reason_code: 'BINARY_NOT_CONFIGURED' }
    ]);
    expect(subject.logs.filter((log) => log.level === 'error')).toEqual([]);
  });
});
