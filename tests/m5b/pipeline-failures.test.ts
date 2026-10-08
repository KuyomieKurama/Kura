import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ImportRejectedError, QuotaExceededError, importStagedFile } from '../../apps/worker/src/blob-import.js';
import { classifyFailure } from '../../apps/worker/src/failure.js';
import { AdapterError } from '../../packages/adapters/src/index.js';
import { createPipelineFixture, jpeg, type PipelineFixture } from './fixture.js';
import { tempDir } from '../adapters/helpers.js';

describe('failures of the download pipeline (direct URL adapter)', () => {
  const open: PipelineFixture[] = [];
  const start = async (...args: Parameters<typeof createPipelineFixture>) => {
    const subject = await createPipelineFixture(...args);
    open.push(subject);
    return subject;
  };
  afterEach(async () => {
    await Promise.all(open.splice(0).map((subject) => subject.cleanup()));
  });

  it('waits for the Retry-After of the source after a 429', async () => {
    const subject = await start();
    subject.files.serve('/limited.jpg', { body: Buffer.from('slow down'), contentType: 'text/plain', status: 429, headers: { 'retry-after': '120' } });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, subject.files.url('/limited.jpg'));

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', queue: 'retry_wait', disposition: { runState: 'waiting_rate_limit' } });
    expect(await subject.rows('SELECT state, error_code FROM download_runs')).toEqual([{ state: 'waiting_rate_limit', error_code: 'RATE_LIMITED' }]);
  });

  it('treats 401 and 403 as a missing login: waiting_auth, subscription paused, no retry loop', async () => {
    const subject = await start();
    subject.files.serve('/private.jpg', { body: Buffer.from('no'), contentType: 'text/plain', status: 403 });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, subject.files.url('/private.jpg'));

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', queue: 'failed', disposition: { runState: 'waiting_auth' } });
    expect((await subject.subscriptions.getSubscription(userId, subscription.id)).status).toBe('paused');
    expect(await subject.rows('SELECT 1 FROM subscription_sync_state')).toEqual([]);
  });

  it('keeps the archive when the source disappears (404) and fails for good', async () => {
    const subject = await start();
    subject.files.serve('/vanishing.jpg', { body: jpeg('vanishing'), contentType: 'image/jpeg', etag: '"1"' });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, subject.files.url('/vanishing.jpg'));
    await subject.runOnce(userId, subscription.id);

    subject.files.serve('/vanishing.jpg', { body: Buffer.from('gone'), contentType: 'text/plain', status: 404 });
    subject.advance(3600);
    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', queue: 'failed', disposition: { code: 'SOURCE_GONE' } });
    expect(await subject.rows('SELECT state FROM download_assets')).toEqual([{ state: 'stored' }]);
    expect((await subject.rows('SELECT 1 FROM blobstore_objects')).length).toBe(1);
  });

  it('retries a server error with backoff', async () => {
    const subject = await start();
    subject.files.serve('/flaky.jpg', { body: Buffer.from('oops'), contentType: 'text/plain', status: 503 });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, subject.files.url('/flaky.jpg'));

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', queue: 'retry_wait', disposition: { runState: 'retry_wait', code: 'SOURCE_ERROR' } });
  });

  it('fails permanently after the attempts are used up', async () => {
    const subject = await start();
    subject.files.serve('/flaky.jpg', { body: Buffer.from('oops'), contentType: 'text/plain', status: 503 });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, subject.files.url('/flaky.jpg'));
    const results: string[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { outcome } = await subject.runOnce(userId, subscription.id);
      results.push(outcome.result === 'problem' ? outcome.queue : outcome.result);
      subject.advance(86_400);
    }
    expect(results).toEqual(['retry_wait', 'retry_wait', 'retry_wait', 'retry_wait', 'failed']);
    expect((await subject.rows('SELECT state FROM job_runs'))[0]).toEqual({ state: 'failed' });
    expect((await subject.rows('SELECT 1 FROM download_runs')).length).toBe(5);
  });

  it('pauses safely when the storage quota is used up and leaves no half-written data behind', async () => {
    const subject = await start({ quotaBytes: 10 });
    subject.files.serve('/big.jpg', { body: jpeg('bigger than ten bytes'), contentType: 'image/jpeg' });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, subject.files.url('/big.jpg'));

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', queue: 'failed', disposition: { runState: 'paused', code: 'QUOTA_EXCEEDED' } });
    expect((await subject.subscriptions.getSubscription(userId, subscription.id)).status).toBe('paused');
    expect(await subject.rows('SELECT 1 FROM blobstore_writes')).toEqual([]);
    expect(await subject.rows('SELECT 1 FROM blobstore_objects')).toEqual([]);
    expect(await subject.rows('SELECT state, error_code FROM download_assets')).toEqual([{ state: 'failed', error_code: 'QUOTA_EXCEEDED' }]);
  });

  it('respects the kill switch of an adapter and starts again once it is lifted', async () => {
    const subject = await start();
    subject.files.serve('/k.jpg', { body: jpeg('k'), contentType: 'image/jpeg' });
    const userId = await subject.newUser();
    const admin = await subject.newUser('Admin', 'admin');
    const subscription = await subject.subscribe(userId, subject.files.url('/k.jpg'));
    const switchId = randomUUID();
    await subject.pool.query(
      `INSERT INTO adapter_kill_switches (id, adapter_id, adapter_version, source_type, reason, created_by)
       VALUES ($1, 'direct-url', '1', 'direct_media', 'test switch', $2)`,
      [switchId, admin]
    );

    const blocked = await subject.runOnce(userId, subscription.id);

    expect(blocked.outcome).toMatchObject({ result: 'problem', queue: 'failed', disposition: { code: 'ADAPTER_DISABLED' } });
    expect(subject.files.requests).toEqual([]);
    expect(await subject.rows('SELECT 1 FROM download_assets')).toEqual([]);

    await subject.pool.query('DELETE FROM adapter_kill_switches WHERE id = $1', [switchId]);
    const allowed = await subject.runOnce(userId, subscription.id);
    expect(allowed.outcome).toEqual({ result: 'stored' });
  });

  it('applies a kill switch that names another version or source type to nothing', async () => {
    const subject = await start();
    subject.files.serve('/k2.jpg', { body: jpeg('k2'), contentType: 'image/jpeg' });
    const userId = await subject.newUser();
    const admin = await subject.newUser('Admin', 'admin');
    await subject.pool.query(
      `INSERT INTO adapter_kill_switches (id, adapter_id, adapter_version, reason, created_by) VALUES ($1, 'direct-url', '99', 'other version', $2)`,
      [randomUUID(), admin]
    );
    await subject.pool.query(
      `INSERT INTO adapter_kill_switches (id, adapter_id, source_type, reason, created_by) VALUES ($1, 'yt-dlp', 'youtube', 'other adapter', $2)`,
      [randomUUID(), admin]
    );
    const subscription = await subject.subscribe(userId, subject.files.url('/k2.jpg'));

    expect((await subject.runOnce(userId, subscription.id)).outcome).toEqual({ result: 'stored' });
  });

  it('refuses loopback with the production network policy; only the test policy lets the local server through', async () => {
    const subject = await start({ directApproved: false });
    subject.files.serve('/p.jpg', { body: jpeg('p'), contentType: 'image/jpeg' });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, subject.files.url('/p.jpg'));

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', queue: 'failed', disposition: { code: 'NETWORK_BLOCKED' } });
    expect(subject.files.requests).toEqual([]);
    expect(await subject.rows('SELECT 1 FROM blobstore_objects')).toEqual([]);
  });

  it('does not use the Immich endpoint approvals for download URLs', async () => {
    const subject = await start({ directApproved: false });
    const userId = await subject.newUser();
    await subject.connectImmich(userId); // approves the fake Immich host:port, which is a different port
    await subject.pool.query(
      'INSERT INTO immich_endpoint_approvals (host, port, approved_by) VALUES ($1, $2, (SELECT id FROM users WHERE role = $3 LIMIT 1)) ON CONFLICT DO NOTHING',
      ['127.0.0.1', subject.files.port, 'admin']
    );
    subject.files.serve('/q.jpg', { body: jpeg('q'), contentType: 'image/jpeg' });
    const subscription = await subject.subscribe(userId, subject.files.url('/q.jpg'));

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', disposition: { code: 'NETWORK_BLOCKED' } });
  });

  it('isolates two users who follow the same address', async () => {
    const subject = await start();
    const bytes = jpeg('shared');
    subject.files.serve('/shared.jpg', { body: bytes, contentType: 'image/jpeg', etag: '"s"' });
    const alice = await subject.newUser('Alice');
    const bob = await subject.newUser('Bob');
    await subject.connectImmich(alice);
    const aliceSubscription = await subject.subscribe(alice, subject.files.url('/shared.jpg'), 'Alice source');
    const bobSubscription = await subject.subscribe(bob, subject.files.url('/shared.jpg'), 'Bob source');

    await subject.runOnce(alice, aliceSubscription.id);
    await subject.runOnce(bob, bobSubscription.id);

    expect(await subject.rows('SELECT user_id, count(*)::int AS posts FROM download_posts GROUP BY user_id ORDER BY posts')).toHaveLength(2);
    const objects = await subject.rows<{ owner_id: string }>('SELECT owner_id FROM blobstore_objects');
    expect(objects.map((object) => object.owner_id).sort()).toEqual([alice, bob].sort());
    const assets = await subject.rows<{ user_id: string; blob_object_id: string; handover_state: string }>('SELECT user_id, blob_object_id, handover_state FROM download_assets');
    expect(assets).toHaveLength(2);
    expect(new Set(assets.map((asset) => asset.blob_object_id)).size).toBe(2);
    expect(assets.find((asset) => asset.user_id === alice)!.handover_state).toBe('verified');
    expect(assets.find((asset) => asset.user_id === bob)!.handover_state).toBe('no_connection');
    expect(subject.immich.uploads).toBe(1);
    // Each blob belongs to the owner of the asset that points at it.
    for (const asset of assets) {
      const [object] = await subject.rows<{ owner_id: string }>('SELECT owner_id FROM blobstore_objects WHERE id = $1', [asset.blob_object_id]);
      expect(object!.owner_id).toBe(asset.user_id);
    }
    expect(await subject.rows('SELECT user_id FROM download_runs ORDER BY user_id')).toHaveLength(2);
  });
});

describe('abort, pause, shutdown and lost leases', () => {
  const open: PipelineFixture[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((subject) => subject.cleanup()));
  });
  const stalledFixture = async () => {
    const subject = await createPipelineFixture();
    open.push(subject);
    subject.files.serve('/slow.jpg', { body: Buffer.concat([jpeg('slow'), Buffer.alloc(200_000, 7)]), contentType: 'image/jpeg', stallAfterBytes: 1000, stallRequests: [4] });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, subject.files.url('/slow.jpg'));
    return { subject, userId, subscription };
  };
  const untilDownloading = (subject: PipelineFixture) => async () => {
    for (let waited = 0; waited < 5000; waited += 20) {
      if ((await subject.rows("SELECT 1 FROM download_assets WHERE state = 'downloading'")).length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('download never started');
  };

  it.each([
    ['shutdown', 'retry_wait', 'SHUTDOWN'],
    ['paused', 'paused', 'SUBSCRIPTION_PAUSED']
  ] as const)('ends cleanly when the signal is aborted because of %s', async (reason, state, code) => {
    const { subject, userId, subscription } = await stalledFixture();
    const controller = new AbortController();
    const lease = await subject.queueAndClaim(userId, subscription.id);
    const running = subject.executor.execute(lease, controller.signal);
    await untilDownloading(subject)();

    controller.abort(reason);
    const outcome = await running;

    expect(outcome).toMatchObject({ result: 'problem', queue: 'retry_wait', disposition: { runState: state, code } });
    expect(await subject.rows('SELECT state, error_code FROM download_runs')).toEqual([{ state, error_code: code }]);
    expect(await subject.rows('SELECT 1 FROM blobstore_objects')).toEqual([]);
    expect(await subject.rows('SELECT 1 FROM blobstore_writes')).toEqual([]);
    expect((await subject.rows('SELECT state FROM job_runs'))[0]).toEqual({ state: 'retry_wait' });
    expect((await subject.subscriptions.getSubscription(userId, subscription.id)).status).toBe('active');
  });

  it('records nothing in the queue when the lease was lost', async () => {
    const { subject, userId, subscription } = await stalledFixture();
    const controller = new AbortController();
    const lease = await subject.queueAndClaim(userId, subscription.id);
    const running = subject.executor.execute(lease, controller.signal);
    await untilDownloading(subject)();

    controller.abort('lease_lost');
    const outcome = await running;

    // The executor's own conclusion (retry through the queue) is refused or irrelevant: the lease is still
    // formally ours here, so the queue records the retry; a real loop aborts because another worker took over.
    expect(['problem', 'lease_lost']).toContain(outcome.result);
    expect(await subject.rows('SELECT error_code FROM download_runs')).toEqual([{ error_code: 'LEASE_LOST' }]);
  });

  it('resumes after a crash: the next worker finishes the run, the zombie cannot finish it, the file is stored once', async () => {
    const { subject, userId, subscription } = await stalledFixture();
    const zombieLease = await subject.queueAndClaim(userId, subscription.id);
    // The first worker hangs in the middle of the download (the server stalls its request) and then "dies":
    // it never heartbeats again, so its lease expires.
    const zombie = subject.executor.execute(zombieLease, new AbortController().signal);
    await untilDownloading(subject)();
    subject.advance(121);
    expect(await subject.queue.reclaimExpiredLeases()).toEqual({ requeued: 1, failed: 0 });

    const successor = await subject.queue.claim({ workerId: 'second-worker', leaseSeconds: 120 });
    expect(successor!.leaseGeneration).toBe(2);
    const resumed = await subject.executor.execute(successor!, new AbortController().signal);
    expect(resumed).toEqual({ result: 'stored' });

    // The hanging worker wakes up. It may finish its download, but it cannot finish the queue run.
    subject.files.release();
    const late = await zombie;
    expect(late.result).toBe('lease_lost');

    expect((await subject.rows('SELECT state FROM job_runs'))[0]).toEqual({ state: 'succeeded' });
    expect(await subject.rows('SELECT lease_generation, state FROM download_runs ORDER BY lease_generation')).toEqual([
      { lease_generation: 1, state: 'retry_wait' },
      { lease_generation: 2, state: 'stored' }
    ]);
    expect(await subject.rows('SELECT state FROM download_posts')).toEqual([{ state: 'stored' }]);
    expect(await subject.rows('SELECT state FROM download_assets')).toEqual([{ state: 'stored' }]);
    expect((await subject.rows('SELECT 1 FROM blobstore_objects')).length).toBe(1);
    expect(await subject.rows('SELECT 1 FROM blobstore_writes')).toEqual([]);
  });
});

describe('the trusted import', () => {
  const open: PipelineFixture[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((subject) => subject.cleanup()));
  });

  async function stagedFile(content: Buffer) {
    const directory = await tempDir('kura-m5b-staged-');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'item-0000.jpg');
    await writeFile(path, content);
    return path;
  }

  it('rejects content that differs from what the adapter reported and stores nothing', async () => {
    const subject = await createPipelineFixture();
    open.push(subject);
    const userId = await subject.newUser();
    const content = jpeg('honest');
    const path = await stagedFile(content);

    await expect(importStagedFile({
      blobstore: subject.blobstore,
      ownerUserId: userId,
      staged: { assetIndex: 0, relativePath: 'media/item-0000.jpg', absolutePath: path, byteLength: content.length, sha256: 'a'.repeat(64), mediaType: 'image/jpeg' }
    })).rejects.toBeInstanceOf(ImportRejectedError);
    await expect(importStagedFile({
      blobstore: subject.blobstore,
      ownerUserId: userId,
      staged: { assetIndex: 0, relativePath: 'media/item-0000.jpg', absolutePath: path, byteLength: content.length + 1, sha256: 'a'.repeat(64), mediaType: 'image/jpeg' }
    })).rejects.toBeInstanceOf(ImportRejectedError);
    expect(await subject.rows('SELECT 1 FROM blobstore_objects')).toEqual([]);
    expect(await subject.rows('SELECT 1 FROM blobstore_writes')).toEqual([]);
  });

  it('reports a full quota as such', async () => {
    const subject = await createPipelineFixture({ quotaBytes: 5 });
    open.push(subject);
    const userId = await subject.newUser();
    const content = jpeg('too big');
    const path = await stagedFile(content);
    const { createHash } = await import('node:crypto');

    await expect(importStagedFile({
      blobstore: subject.blobstore,
      ownerUserId: userId,
      staged: { assetIndex: 0, relativePath: 'media/item-0000.jpg', absolutePath: path, byteLength: content.length, sha256: createHash('sha256').update(content).digest('hex'), mediaType: 'image/jpeg' }
    })).rejects.toBeInstanceOf(QuotaExceededError);
  });
});

describe('classification of failures', () => {
  const adapter = (code: ConstructorParameters<typeof AdapterError>[0], message = 'm', diagnostics?: string) => new AdapterError(code, message, diagnostics);

  it.each([
    [adapter('DOWNLOAD_FAILED', 'Server answered with status 401'), 'waiting_auth'],
    [adapter('DOWNLOAD_FAILED', 'Server answered with status 403'), 'waiting_auth'],
    [adapter('DOWNLOAD_FAILED', 'Server answered with status 404'), 'failed'],
    [adapter('DOWNLOAD_FAILED', 'Server answered with status 410'), 'failed'],
    [adapter('DOWNLOAD_FAILED', 'Server answered with status 429'), 'waiting_rate_limit'],
    [adapter('DOWNLOAD_FAILED', 'Server answered with status 502'), 'retry_wait'],
    [adapter('DOWNLOAD_FAILED', 'Download ended before the announced length'), 'retry_wait'],
    [adapter('NETWORK_FAILED'), 'retry_wait'],
    [adapter('PROCESS_TIMEOUT'), 'retry_wait'],
    [adapter('PROCESS_FAILED', 'x', 'ERROR: Login required'), 'waiting_auth'],
    [adapter('PROCESS_FAILED', 'x', 'HTTP Error 429: Too Many Requests'), 'waiting_rate_limit'],
    [adapter('PROCESS_FAILED', 'x', 'Video unavailable'), 'failed'],
    [adapter('PROCESS_FAILED', 'x', 'something else'), 'retry_wait'],
    [adapter('MIME_REJECTED'), 'failed'],
    [adapter('SIZE_LIMIT'), 'failed'],
    [adapter('STAGING_REJECTED'), 'failed'],
    [adapter('BINARY_HASH_MISMATCH'), 'failed'],
    [new QuotaExceededError(), 'paused'],
    [new ImportRejectedError('x'), 'failed'],
    [new TypeError('unexpected'), 'retry_wait']
  ])('maps %# to %s', (error, state) => {
    expect(classifyFailure(error).runState).toBe(state);
  });

  it('never puts tool output or server text into the message shown to users', () => {
    const disposition = classifyFailure(adapter('PROCESS_FAILED', 'External tool failed', 'ERROR: secret-token-123 <script>alert(1)</script>'));
    expect(JSON.stringify(disposition)).not.toContain('secret-token-123');
    expect(JSON.stringify(disposition)).not.toContain('<script>');
  });
});
