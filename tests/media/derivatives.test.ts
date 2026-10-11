import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDownloadConfig } from '../../apps/worker/src/config.js';
import {
  DerivationLoop,
  MediaDeriver,
  averageColorArguments,
  colorFromPpm,
  locateDerivationTools,
  parseProbe,
  thumbnailArguments
} from '../../apps/worker/src/derivatives.js';
import { createMediaFixture, type MediaFixture, type SeededAsset } from './fixture.js';
import { installFakeTools, type FakeTools } from './fake-media-tools.js';
import type { TestLogin } from '../m4b/api-fixture.js';

type Row = Record<string, any>;

describe('derived media data: pure helpers', () => {
  it('reads dimensions and duration from ffprobe JSON and ignores what is not a sane number', () => {
    expect(parseProbe(JSON.stringify({ streams: [{ codec_type: 'video', width: 640, height: 360 }], format: { duration: '12.5' } })))
      .toEqual({ width: 640, height: 360, durationSeconds: 12.5 });
    expect(parseProbe(JSON.stringify({ streams: [{ codec_type: 'audio', duration: '61.2' }], format: {} })))
      .toEqual({ width: null, height: null, durationSeconds: 61.2 });
    expect(parseProbe(JSON.stringify({ streams: [{ codec_type: 'video', width: 800, height: 600 }], format: { duration: 'N/A' } })))
      .toEqual({ width: 800, height: 600, durationSeconds: null });
    // Not whole, negative, absurdly large: no dimensions rather than wrong ones.
    expect(parseProbe(JSON.stringify({ streams: [{ codec_type: 'video', width: 1.5, height: 600 }], format: {} }))).toMatchObject({ width: null, height: null });
    expect(parseProbe(JSON.stringify({ streams: [{ codec_type: 'video', width: -4, height: 600 }], format: {} }))).toMatchObject({ width: null, height: null });
    expect(parseProbe(JSON.stringify({ streams: [{ codec_type: 'video', width: 10 ** 9, height: 600 }], format: {} }))).toMatchObject({ width: null, height: null });
    expect(parseProbe(JSON.stringify({ streams: [{ codec_type: 'video', width: 10, height: 10 }], format: { duration: '-3' } }))).toMatchObject({ durationSeconds: null });
  });

  it('swaps width and height for a video that is turned by 90 or 270 degrees', () => {
    const turned = (rotation: number) => JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1920, side_data_list: [{ rotation }] }], format: {} });
    expect(parseProbe(turned(-90))).toMatchObject({ width: 1920, height: 1080 });
    expect(parseProbe(turned(270))).toMatchObject({ width: 1920, height: 1080 });
    expect(parseProbe(turned(180))).toMatchObject({ width: 1080, height: 1920 });
    expect(parseProbe(JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1920, tags: { rotate: '90' } }], format: {} })))
      .toMatchObject({ width: 1920, height: 1080 });
  });

  it('rejects text that is not a probe result', () => {
    for (const text of ['', 'nope', '[]', 'null', '{}', '{"streams":[]}']) expect(parseProbe(text), text).toBeNull();
  });

  it('reads the colour of a 1x1 PPM and nothing else', () => {
    const ppm = (pixels: number[]) => Buffer.concat([Buffer.from('P6\n1 1\n255\n'), Buffer.from(pixels)]);
    expect(colorFromPpm(ppm([0x10, 0x80, 0xf0]))).toBe('#1080F0');
    expect(colorFromPpm(ppm([0, 0, 0]))).toBe('#000000');
    expect(colorFromPpm(ppm([1, 2]))).toBeNull();
    expect(colorFromPpm(Buffer.from('P6\n2 2\n255\n' + 'x'.repeat(12)))).toBeNull();
    expect(colorFromPpm(Buffer.from('<html>'))).toBeNull();
  });

  it('builds argument arrays with fixed options and no shell syntax', () => {
    const webp = thumbnailArguments({ source: '/w/original', output: '/w/t.webp', width: 480, format: 'webp', seekSeconds: 0 });
    expect(webp).toContain('libwebp');
    expect(webp).not.toContain('-ss');
    expect(webp.at(-1)).toBe('/w/t.webp');
    expect(webp.join(' ')).toContain("scale='min(480,iw)':-2");
    const jpeg = thumbnailArguments({ source: '/w/original', output: '/w/t.jpg', width: 960, format: 'jpeg', seekSeconds: 1.25 });
    expect(jpeg).toContain('mjpeg');
    expect(jpeg.slice(jpeg.indexOf('-ss'), jpeg.indexOf('-ss') + 2)).toEqual(['-ss', '1.25']);
    expect(jpeg.indexOf('-ss')).toBeLessThan(jpeg.indexOf('-i'));
    expect(averageColorArguments({ source: '/w/t.webp', output: '/w/a.ppm' })).toContain('scale=1:1:flags=area');
  });
});

describe('derived media data: worker', () => {
  let fixture: MediaFixture;
  let alice: TestLogin;
  let subscription: string;
  let run: string;
  let tools: FakeTools;
  let workDir: string;
  let counter = 0;
  const logs: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  const logger = {
    info: (message: string, fields?: Record<string, unknown>) => { logs.push({ level: 'info', message, fields }); },
    error: (message: string, fields?: Record<string, unknown>) => { logs.push({ level: 'error', message, fields }); }
  };

  const never = new AbortController().signal;
  const deriver = (overrides: { toolPath?: string; probeTimeoutMs?: number; encodeTimeoutMs?: number } = {}) => new MediaDeriver({
    pool: fixture.api.pool, blobstore: fixture.blobs, workDir, toolPath: overrides.toolPath ?? tools.directory, logger,
    probeTimeoutMs: overrides.probeTimeoutMs ?? 5_000, encodeTimeoutMs: overrides.encodeTimeoutMs ?? 5_000
  });
  const seed = async (marker: string, mime = 'image/png', state?: 'pending'): Promise<SeededAsset> => {
    counter += 1;
    return fixture.seedAsset(alice, subscription, run, {
      name: `${marker.toLowerCase()}-${counter}.bin`, mime, bytes: Buffer.from(`${marker} unique ${counter} ${'x'.repeat(100)}`),
      postKey: `post-${counter}`, ...(state ? { state } : {})
    });
  };
  const info = async (assetId: string): Promise<Row | undefined> =>
    (await fixture.api.pool.query('SELECT * FROM asset_media_info WHERE asset_id = $1', [assetId])).rows[0];
  const thumbnails = async (assetId: string): Promise<Row[]> =>
    (await fixture.api.pool.query('SELECT width, mime_type, data FROM asset_thumbnails WHERE asset_id = $1 ORDER BY width', [assetId])).rows;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    fixture = await createMediaFixture();
    alice = await fixture.api.addUser('alice');
    subscription = await fixture.createSubscription(alice, 'Abo');
    run = await fixture.startRun(alice, subscription, { finished: true });
    tools = await installFakeTools();
    workDir = await mkdtemp(join(tmpdir(), 'kura-derive-work-'));
  });

  afterAll(async () => {
    await fixture.cleanup();
    await tools.cleanup();
    await rm(workDir, { recursive: true, force: true });
  });

  it('finds the tools in the tool path and reports missing ones', async () => {
    const found = await locateDerivationTools(tools.directory);
    expect(found?.ffmpeg.path).toBe(join(tools.directory, 'ffmpeg'));
    expect(found?.ffprobe.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await locateDerivationTools('/nonexistent/dir')).toBeNull();
    const onlyProbe = await installFakeTools({ ffmpeg: false });
    try {
      expect(await locateDerivationTools(onlyProbe.directory)).toBeNull();
    } finally {
      await onlyProbe.cleanup();
    }
    // A relative directory in the path is not searched.
    expect(await locateDerivationTools('relative/dir')).toBeNull();
  });

  it('derives size, colour and two previews for a picture and serves them through the API; the original stays as it is', async () => {
    const asset = await seed('IMAGE');
    const beforeOriginal = (await fixture.get(alice, `/api/v1/assets/${asset.assetId}/content`)).rawPayload;

    const result = await deriver().processBatch(10, never);
    expect(result).toEqual({ processed: 1, toolsMissing: false });

    expect(await info(asset.assetId)).toMatchObject({ status: 'done', attempts: 1, width: 800, height: 600, duration_seconds: null, average_color: '#1080F0', has_thumbnail: true });
    const stored = await thumbnails(asset.assetId);
    expect(stored.map((row) => [row.width, row.mime_type])).toEqual([[480, 'image/webp'], [960, 'image/webp']]);
    expect(stored[0]!.data.toString('latin1')).toContain('fake-480');
    expect(stored[1]!.data.toString('latin1')).toContain('fake-960');

    // Through the API: the new fields, the preview, and the untouched original with the same checksum.
    const listed = (await fixture.get(alice, `/api/v1/subscriptions/${subscription}/media?limit=100`)).json().items.find((item: Row) => item.id === asset.assetId);
    expect(listed).toMatchObject({ width: 800, height: 600, averageColor: '#1080F0', hasThumbnail: true, durationSeconds: null });
    const preview = await fixture.get(alice, `/api/v1/assets/${asset.assetId}/thumbnail?w=960`);
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toBe('image/webp');
    const afterOriginal = (await fixture.get(alice, `/api/v1/assets/${asset.assetId}/content`)).rawPayload;
    expect(createHash('sha256').update(afterOriginal).digest('hex')).toBe(asset.sha256);
    expect(afterOriginal.equals(beforeOriginal)).toBe(true);
    const row = (await fixture.api.pool.query('SELECT state, sha256, byte_size FROM download_assets WHERE id = $1', [asset.assetId])).rows[0];
    expect(row).toMatchObject({ state: 'stored', sha256: asset.sha256 });

    // The tools got fixed argument arrays and the private copy, never the original name or a shell string.
    const calls = await tools.calls();
    expect(calls.every((call) => Array.isArray(call.args))).toBe(true);
    expect(JSON.stringify(calls)).not.toContain(asset.assetId);
    // The workspace is gone afterwards.
    expect(await readdir(workDir)).toEqual([]);
  });

  it('takes a still image of a video after the start, with the duration and the dimensions from ffprobe', async () => {
    const asset = await seed('KIND-VIDEO', 'video/mp4');
    await deriver().processBatch(10, never);
    expect(await info(asset.assetId)).toMatchObject({ status: 'done', width: 640, height: 360, duration_seconds: 12.5, has_thumbnail: true });
    const call = (await tools.calls()).filter((entry) => entry.tool === 'ffmpeg' && entry.args.includes('libwebp')).at(-1)!;
    expect(call.args[call.args.indexOf('-ss') + 1]).toBe('1.25');
  });

  it('swaps the dimensions of a turned video', async () => {
    const asset = await seed('KIND-ROTATED', 'video/quicktime');
    await deriver().processBatch(10, never);
    expect(await info(asset.assetId)).toMatchObject({ status: 'done', width: 1920, height: 1080, duration_seconds: 3 });
  });

  it('derives only the duration of an audio file and makes no preview', async () => {
    const asset = await seed('KIND-AUDIO', 'audio/mpeg');
    await deriver().processBatch(10, never);
    expect(await info(asset.assetId)).toMatchObject({ status: 'done', width: null, height: null, duration_seconds: 61.2, has_thumbnail: false, average_color: null });
    expect(await thumbnails(asset.assetId)).toEqual([]);
  });

  it('falls back to JPEG when this ffmpeg cannot write WebP', async () => {
    const asset = await seed('NO-WEBP');
    await deriver().processBatch(10, never);
    expect((await thumbnails(asset.assetId)).map((row) => row.mime_type)).toEqual(['image/jpeg', 'image/jpeg']);
    const preview = await fixture.get(alice, `/api/v1/assets/${asset.assetId}/thumbnail`);
    expect(preview.headers['content-type']).toBe('image/jpeg');
  });

  it('keeps the previews when only the colour cannot be computed', async () => {
    const asset = await seed('COLOR-FAIL');
    await deriver().processBatch(10, never);
    expect(await info(asset.assetId)).toMatchObject({ status: 'done', average_color: null, has_thumbnail: true });
  });

  describe('a file that cannot be processed', () => {
    const expectStoredAndServed = async (asset: SeededAsset) => {
      expect((await fixture.api.pool.query('SELECT state FROM download_assets WHERE id = $1', [asset.assetId])).rows[0].state).toBe('stored');
      expect((await fixture.get(alice, `/api/v1/assets/${asset.assetId}/content`)).statusCode).toBe(200);
      expect((await fixture.get(alice, `/api/v1/assets/${asset.assetId}/thumbnail`)).statusCode).toBe(404);
    };
    const lastError = (assetId: string) => logs.filter((entry) => entry.level === 'error' && entry.fields?.assetId === assetId).at(-1);

    it.each([
      ['PROBE-FAIL', 'PROCESS_FAILED'],
      ['PROBE-GARBAGE', 'OUTPUT_INVALID'],
      ['ENC-FAIL', 'OUTPUT_INVALID'],
      ['ENC-NOFILE', 'OUTPUT_INVALID']
    ])('%s: no preview, the file stays stored, one log line with the asset id and a code', async (marker, code) => {
      const asset = await seed(marker);
      const outcome = await deriver().processBatch(10, never);
      expect(outcome.processed).toBeGreaterThanOrEqual(1);
      expect(await info(asset.assetId)).toMatchObject({ status: 'failed', attempts: 1, has_thumbnail: false, average_color: null });
      expect(await thumbnails(asset.assetId)).toEqual([]);
      await expectStoredAndServed(asset);

      const entry = lastError(asset.assetId)!;
      expect(entry.message).toBe('media derivation failed');
      expect(entry.fields).toEqual({ assetId: asset.assetId, code });
      // Neither paths nor tool output nor the file name reach the log.
      const text = JSON.stringify(logs);
      expect(text).not.toContain(workDir);
      expect(text).not.toContain(tools.directory);
      expect(text).not.toContain('boom');
      expect(text).not.toContain('encoder failed');
    });

    it('keeps the dimensions when only the preview failed', async () => {
      const asset = await seed('ENC-FAIL');
      await deriver().processBatch(10, never);
      expect(await info(asset.assetId)).toMatchObject({ status: 'failed', width: 800, height: 600, has_thumbnail: false });
      const listed = (await fixture.get(alice, `/api/v1/subscriptions/${subscription}/media?limit=100`)).json().items.find((item: Row) => item.id === asset.assetId);
      expect(listed).toMatchObject({ width: 800, height: 600, hasThumbnail: false });
    });

    it('ends a tool that hangs at the timeout, records the failure and goes on', async () => {
      const hanging = await seed('PROBE-HANG');
      const fine = await seed('IMAGE');
      const started = Date.now();
      await deriver({ probeTimeoutMs: 700 }).processBatch(10, never);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(await info(hanging.assetId)).toMatchObject({ status: 'failed' });
      expect(lastError(hanging.assetId)!.fields).toEqual({ assetId: hanging.assetId, code: 'PROCESS_TIMEOUT' });
      expect(await info(fine.assetId)).toMatchObject({ status: 'done' });
      expect(await readdir(workDir)).toEqual([]);
    });

    it('ends an encoder that hangs at the timeout', async () => {
      const hanging = await seed('ENC-HANG');
      await deriver({ encodeTimeoutMs: 700 }).processBatch(10, never);
      expect(await info(hanging.assetId)).toMatchObject({ status: 'failed', width: 800, has_thumbnail: false });
      expect(lastError(hanging.assetId)!.fields).toMatchObject({ code: 'OUTPUT_INVALID' });
    });
  });

  it('leaves everything alone and says so once when ffmpeg or ffprobe is not installed', async () => {
    const asset = await seed('IMAGE');
    const empty = await installFakeTools({ ffmpeg: false, ffprobe: false });
    try {
      const missing = deriver({ toolPath: empty.directory });
      const before = logs.length;
      expect(await missing.processBatch(10, never)).toEqual({ processed: 0, toolsMissing: true });
      expect(await missing.processBatch(10, never)).toEqual({ processed: 0, toolsMissing: true });
      expect(logs.slice(before).filter((entry) => entry.message.includes('no previews are derived'))).toHaveLength(1);
      expect(await info(asset.assetId)).toBeUndefined();
      expect((await fixture.get(alice, `/api/v1/assets/${asset.assetId}/content`)).statusCode).toBe(200);
    } finally {
      await empty.cleanup();
    }
    // Once the tools are there, the same file is picked up.
    await deriver().processBatch(10, never);
    expect(await info(asset.assetId)).toMatchObject({ status: 'done' });
  });

  describe('backfill', () => {
    it('works through the existing files in limited, newest-first batches and is idempotent', async () => {
      const subscriptionTwo = await fixture.createSubscription(alice, 'Backfill');
      const runTwo = await fixture.startRun(alice, subscriptionTwo, { finished: true });
      const seeded: SeededAsset[] = [];
      for (let index = 0; index < 5; index += 1) {
        counter += 1;
        seeded.push(await fixture.seedAsset(alice, subscriptionTwo, runTwo, { name: `old-${index}.png`, mime: 'image/png', bytes: Buffer.from(`IMAGE backfill ${index} ${counter}`), postKey: `bf-${index}` }));
        await sleep(5);
      }
      const mine = new Set(seeded.map((asset) => asset.assetId));
      const candidates = async () => (await deriver().findCandidates(100)).filter((candidate) => mine.has(candidate.id)).map((candidate) => candidate.id);
      expect(await candidates()).toEqual([...seeded].reverse().map((asset) => asset.assetId));

      const worker = deriver();
      expect((await worker.processBatch(2, never)).processed).toBe(2);
      // Newest first: the two newest are done, the oldest three are still waiting.
      expect((await candidates())).toEqual([seeded[2]!, seeded[1]!, seeded[0]!].map((asset) => asset.assetId));
      expect((await worker.processBatch(2, never)).processed).toBe(2);
      expect((await worker.processBatch(2, never)).processed).toBe(1);
      expect(await candidates()).toEqual([]);

      // Nothing left: further passes do no work and change no data.
      const snapshot = JSON.stringify((await fixture.api.pool.query('SELECT asset_id, attempts, processed_at FROM asset_media_info ORDER BY asset_id')).rows);
      const callsBefore = (await tools.calls()).length;
      expect((await worker.processBatch(20, never)).processed).toBe(0);
      expect((await worker.processBatch(20, never)).processed).toBe(0);
      expect(JSON.stringify((await fixture.api.pool.query('SELECT asset_id, attempts, processed_at FROM asset_media_info ORDER BY asset_id')).rows)).toBe(snapshot);
      expect((await tools.calls()).length).toBe(callsBefore);
      for (const asset of seeded) expect(await thumbnails(asset.assetId)).toHaveLength(2);
    });

    it('does not take files that are not stored, not media, or SVG', async () => {
      const pending = await seed('IMAGE', 'image/png', 'pending');
      const pdf = await seed('IMAGE', 'application/pdf');
      const svg = await seed('IMAGE', 'image/svg+xml');
      const ids = (await deriver().findCandidates(100)).map((candidate) => candidate.id);
      for (const asset of [pending, pdf, svg]) expect(ids).not.toContain(asset.assetId);
    });

    it('tries a failed file again only after the pause and at most three times in total', async () => {
      const asset = await seed('PROBE-FAIL');
      const worker = deriver();
      const isCandidate = async () => (await worker.findCandidates(500)).some((candidate) => candidate.id === asset.assetId);
      await worker.processBatch(100, never);
      expect(await info(asset.assetId)).toMatchObject({ status: 'failed', attempts: 1 });
      expect(await isCandidate()).toBe(false);

      const age = (hours: number) => fixture.api.pool.query(`UPDATE asset_media_info SET processed_at = now() - make_interval(hours => $2) WHERE asset_id = $1`, [asset.assetId, hours]);
      await age(7);
      expect(await isCandidate()).toBe(true);
      await worker.processBatch(100, never);
      expect(await info(asset.assetId)).toMatchObject({ status: 'failed', attempts: 2 });
      await age(7);
      await worker.processBatch(100, never);
      expect(await info(asset.assetId)).toMatchObject({ status: 'failed', attempts: 3 });
      await age(48);
      expect(await isCandidate()).toBe(false);
    });

    it('stops when aborted, also in the middle of a file, and writes nothing for the file in progress', async () => {
      const already = new AbortController();
      already.abort();
      const first = await seed('IMAGE');
      expect((await deriver().processBatch(10, already.signal)).processed).toBe(0);
      expect(await info(first.assetId)).toBeUndefined();

      const hanging = await seed('PROBE-HANG');
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 400);
      const candidate = (await deriver().findCandidates(500)).find((entry) => entry.id === hanging.assetId)!;
      const found = (await locateDerivationTools(tools.directory))!;
      const started = Date.now();
      expect(await deriver({ probeTimeoutMs: 20_000 }).deriveOne(candidate, found, controller.signal)).toBe('aborted');
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(await info(hanging.assetId)).toBeUndefined();
      expect(await readdir(workDir)).toEqual([]);
      // Both are picked up by the next pass.
      const ids = (await deriver().findCandidates(500)).map((entry) => entry.id);
      expect(ids).toEqual(expect.arrayContaining([first.assetId, hanging.assetId]));
    });
  });

  it('the loop derives newly stored files by itself and stops cleanly', async () => {
    const loop = new DerivationLoop({ deriver: deriver(), pollIntervalMs: 50, logger });
    await loop.start();
    try {
      // Everything older is processed or failed by now; a new file is picked up within a few polls.
      const asset = await seed('IMAGE');
      let row: Row | undefined;
      for (let attempt = 0; attempt < 100 && !row; attempt += 1) {
        await sleep(100);
        row = await info(asset.assetId);
      }
      expect(row).toMatchObject({ status: 'done' });
    } finally {
      await loop.stop();
    }
    await loop.stop();
  });

  it('is configured by WORKER_DERIVATIVES and WORKER_DERIVATIVES_POLL_SECONDS', () => {
    const base = { WORKER_DOWNLOADS: 'true' };
    expect(loadDownloadConfig(base)!.derivatives).toEqual({ pollIntervalMs: 30_000 });
    expect(loadDownloadConfig({ ...base, WORKER_DERIVATIVES_POLL_SECONDS: '5' })!.derivatives).toEqual({ pollIntervalMs: 5_000 });
    expect(loadDownloadConfig({ ...base, WORKER_DERIVATIVES: 'false' })!.derivatives).toBeUndefined();
    expect(() => loadDownloadConfig({ ...base, WORKER_DERIVATIVES_POLL_SECONDS: '1' })).toThrow();
    expect(() => loadDownloadConfig({ ...base, WORKER_DERIVATIVES: 'maybe' })).toThrow();
  });
});
