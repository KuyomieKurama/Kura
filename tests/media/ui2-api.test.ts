import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMediaFixture, tinyPng, type MediaFixture, type SeededAsset } from './fixture.js';
import type { TestLogin } from '../m4b/api-fixture.js';

const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 fake')]);

async function sleep(ms: number) { await new Promise((resolve) => setTimeout(resolve, ms)); }

// Loosely typed on purpose: these are parsed JSON / database rows that the tests only inspect.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

describe('UI2-A: derived media fields, /media, subscription summary, /overview, thumbnails', () => {
  let fixture: MediaFixture;
  let alice: TestLogin;
  let bob: TestLogin;
  let aliceSubscriptionA: string;
  let aliceSubscriptionB: string;
  let bobSubscription: string;
  const alicePngs: SeededAsset[] = [];
  let aliceVideo: SeededAsset;
  let bobAsset: SeededAsset;
  let adminAsset: SeededAsset;

  beforeAll(async () => {
    fixture = await createMediaFixture();
    alice = await fixture.api.addUser('alice');
    bob = await fixture.api.addUser('bob');
    aliceSubscriptionA = await fixture.createSubscription(alice, 'Abo A');
    aliceSubscriptionB = await fixture.createSubscription(alice, 'Abo B');
    bobSubscription = await fixture.createSubscription(bob, 'Bobs Abo');
    const runA = await fixture.startRun(alice, aliceSubscriptionA, { finished: true });
    const runB = await fixture.startRun(alice, aliceSubscriptionB, { finished: true });
    const bobRun = await fixture.startRun(bob, bobSubscription, { finished: true });

    // Oldest first. Eleven pictures in A (more than the nine of the overview), a video and a picture in B.
    for (let index = 0; index < 11; index += 1) {
      alicePngs.push(await fixture.seedAsset(alice, aliceSubscriptionA, runA, { name: `a-${index}.png`, mime: 'image/png', bytes: tinyPng(`a${index}`), postKey: `pa${index}` }));
      await sleep(5);
    }
    aliceVideo = await fixture.seedAsset(alice, aliceSubscriptionB, runB, { name: 'clip.mp4', mime: 'video/mp4', bytes: Buffer.from('not really a video'), postKey: 'pv' });
    await sleep(5);
    alicePngs.push(await fixture.seedAsset(alice, aliceSubscriptionB, runB, { name: 'b-0.png', mime: 'image/png', bytes: tinyPng('b0'), postKey: 'pb0' }));
    bobAsset = await fixture.seedAsset(bob, bobSubscription, bobRun, { name: 'bob.png', mime: 'image/png', bytes: tinyPng('bob'), postKey: 'bob1' });
    const adminSubscription = await fixture.createSubscription(fixture.api.admin, 'Admin Abo');
    const adminRun = await fixture.startRun(fixture.api.admin, adminSubscription, { finished: true });
    adminAsset = await fixture.seedAsset(fixture.api.admin, adminSubscription, adminRun, { name: 'admin.png', mime: 'image/png', bytes: tinyPng('admin'), postKey: 'adm1' });
  });

  afterAll(async () => { await fixture.cleanup(); });

  const ids = (body: { items: { id: string }[] }) => body.items.map((item) => item.id);

  describe('authentication', () => {
    it('answers 401 without a session', async () => {
      for (const url of ['/api/v1/media', '/api/v1/overview', `/api/v1/assets/${alicePngs[0]!.assetId}/thumbnail`, '/api/v1/subscriptions']) {
        expect((await fixture.get(null, url)).statusCode, url).toBe(401);
      }
    });
  });

  describe('A1 derived fields on MediaAsset', () => {
    it('are null / false until the worker derived them, then carry the values', async () => {
      const before = (await fixture.get(alice, `/api/v1/subscriptions/${aliceSubscriptionB}/media`)).json();
      const plain = before.items.find((item: { id: string }) => item.id === aliceVideo.assetId);
      expect(plain).toMatchObject({ width: null, height: null, durationSeconds: null, averageColor: null, hasThumbnail: false });

      await fixture.api.pool.query(
        `INSERT INTO asset_media_info (asset_id, status, width, height, duration_seconds, average_color, has_thumbnail)
         VALUES ($1, 'done', 1920, 1080, 12.5, '#1080F0', true)`,
        [aliceVideo.assetId]
      );
      const after = (await fixture.get(alice, `/api/v1/subscriptions/${aliceSubscriptionB}/media`)).json();
      expect(after.items.find((item: { id: string }) => item.id === aliceVideo.assetId))
        .toMatchObject({ width: 1920, height: 1080, durationSeconds: 12.5, averageColor: '#1080F0', hasThumbnail: true });
    });

    it('does not let a malformed colour into the table', async () => {
      await expect(fixture.api.pool.query(
        `INSERT INTO asset_media_info (asset_id, status, average_color) VALUES ($1, 'done', 'red')`, [alicePngs[0]!.assetId]
      )).rejects.toThrow();
    });
  });

  describe('A3 GET /api/v1/media', () => {
    it('lists the own files over all subscriptions, newest first, with counts', async () => {
      const response = await fixture.get(alice, '/api/v1/media?limit=100');
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.items).toHaveLength(13);
      expect(ids(body)[0]).toBe(alicePngs[11]!.assetId);
      expect(ids(body)[1]).toBe(aliceVideo.assetId);
      expect(body.counts).toEqual({ all: 13, image: 12, video: 1 });
      expect(body.nextCursor).toBeNull();
      expect(ids(body)).not.toContain(bobAsset.assetId);
      expect(ids(body)).not.toContain(adminAsset.assetId);
    });

    it('filters by kind and by subscription, and the counts do not follow the kind filter', async () => {
      const videos = (await fixture.get(alice, '/api/v1/media?kind=video')).json();
      expect(ids(videos)).toEqual([aliceVideo.assetId]);
      expect(videos.counts.all).toBe(13);
      const images = (await fixture.get(alice, '/api/v1/media?kind=image&limit=100')).json();
      expect(images.items).toHaveLength(12);
      const onlyB = (await fixture.get(alice, `/api/v1/media?subscriptionId=${aliceSubscriptionB}`)).json();
      expect(onlyB.items).toHaveLength(2);
      expect(onlyB.counts).toEqual({ all: 2, image: 1, video: 1 });
    });

    it('pages with a cursor without gaps or repeats', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const url: string = `/api/v1/media?limit=5${cursor ? `&cursor=${cursor}` : ''}`;
        const body: Json = (await fixture.get(alice, url)).json();
        if (pages === 0) expect(body.counts.all).toBe(13);
        else expect(body.counts).toBeUndefined();
        seen.push(...ids(body as { items: { id: string }[] }));
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor);
      expect(pages).toBe(3);
      expect(seen).toHaveLength(13);
      expect(new Set(seen).size).toBe(13);
    });

    it('rejects bad parameters with 400 and a foreign or unknown subscription with 404', async () => {
      for (const url of ['/api/v1/media?kind=audio', '/api/v1/media?limit=0', '/api/v1/media?limit=101', '/api/v1/media?cursor=nonsense']) {
        expect((await fixture.get(alice, url)).statusCode, url).toBe(400);
      }
      const foreign = await fixture.get(alice, `/api/v1/media?subscriptionId=${bobSubscription}`);
      const unknown = await fixture.get(alice, '/api/v1/media?subscriptionId=00000000-0000-4000-8000-000000000000');
      expect(foreign.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(foreign.body).toBe(unknown.body);
      expect((await fixture.get(alice, '/api/v1/media?subscriptionId=nope')).statusCode).toBe(404);
    });

    it('shows an administrator only their own files, like the media view of a subscription', async () => {
      const body = (await fixture.get(fixture.api.admin, '/api/v1/media')).json();
      expect(ids(body)).toEqual([adminAsset.assetId]);
      expect((await fixture.get(fixture.api.admin, `/api/v1/media?subscriptionId=${aliceSubscriptionA}`)).statusCode).toBe(404);
    });

    it('shows the same file once even when two subscriptions hold it', async () => {
      const subscription = await fixture.createSubscription(bob, 'Bobs zweites Abo');
      const run = await fixture.startRun(bob, subscription, { finished: true });
      const copy = await fixture.seedAsset(bob, subscription, run, { name: 'kopie.png', mime: 'image/png', bytes: tinyPng('bob'), postKey: 'bob-copy' });
      const body = (await fixture.get(bob, '/api/v1/media')).json();
      expect(body.items).toHaveLength(1);
      expect(body.counts.all).toBe(1);
      expect([bobAsset.assetId, copy.assetId]).toContain(body.items[0].id);
    });
  });

  describe('A2 GET /api/v1/assets/:id/thumbnail', () => {
    it('answers 404 while no preview exists, so the interface falls back to /content', async () => {
      const response = await fixture.get(alice, `/api/v1/assets/${alicePngs[1]!.assetId}/thumbnail`);
      expect(response.statusCode).toBe(404);
      expect((await fixture.get(alice, `/api/v1/assets/${alicePngs[1]!.assetId}/content`)).statusCode).toBe(200);
    });

    it('serves the stored preview with type, cache headers and ETag, and answers 304 for the ETag', async () => {
      const assetId = alicePngs[2]!.assetId;
      await fixture.api.pool.query('INSERT INTO asset_thumbnails (asset_id, width, mime_type, data) VALUES ($1, 480, $2, $3)', [assetId, 'image/webp', WEBP_BYTES]);
      const response = await fixture.get(alice, `/api/v1/assets/${assetId}/thumbnail?w=480`);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('image/webp');
      expect(response.headers['cache-control']).toBe('private, max-age=3600');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-security-policy']).toContain('sandbox');
      expect(response.headers.vary).toBe('Cookie');
      expect(response.rawPayload.equals(WEBP_BYTES)).toBe(true);
      // 480 is the default width.
      expect((await fixture.get(alice, `/api/v1/assets/${assetId}/thumbnail`)).statusCode).toBe(200);

      const etag = String(response.headers.etag);
      const cached = await fixture.get(alice, `/api/v1/assets/${assetId}/thumbnail?w=480`, { 'if-none-match': etag });
      expect(cached.statusCode).toBe(304);
      expect(cached.rawPayload.length).toBe(0);
      const head = await fixture.api.app.inject({ method: 'HEAD', url: `/api/v1/assets/${assetId}/thumbnail`, headers: { host: 'localhost', cookie: alice.cookie } });
      expect(head.statusCode).toBe(200);
      expect(head.headers['content-length']).toBe(String(WEBP_BYTES.length));

      // The other width does not exist.
      expect((await fixture.get(alice, `/api/v1/assets/${assetId}/thumbnail?w=960`)).statusCode).toBe(404);
    });

    it('rejects other widths with 400', async () => {
      for (const width of ['100', '480.5', 'abc', '']) {
        expect((await fixture.get(alice, `/api/v1/assets/${alicePngs[2]!.assetId}/thumbnail?w=${width}`)).statusCode, width).toBe(400);
      }
    });

    it('answers 404, never 403, for the preview of a foreign asset, exactly like for an unknown id', async () => {
      const assetId = alicePngs[2]!.assetId;
      const foreign = await fixture.get(bob, `/api/v1/assets/${assetId}/thumbnail`);
      const unknown = await fixture.get(bob, '/api/v1/assets/00000000-0000-4000-8000-000000000000/thumbnail');
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).toBe(unknown.body);
      expect(foreign.rawPayload.includes(WEBP_BYTES)).toBe(false);
      expect((await fixture.get(bob, '/api/v1/assets/not-a-uuid/thumbnail')).statusCode).toBe(404);
    });
  });

  describe('A4 summary in GET /api/v1/subscriptions', () => {
    it('adds platform, last run, next run, media count, cover and active run for each subscription', async () => {
      const schedule = await fixture.api.call(alice, 'POST', '/api/v1/schedules', {
        subscriptionId: aliceSubscriptionA,
        rule: { kind: 'cron', expression: '0 3 * * *', timeZone: 'Europe/Berlin', gapPolicy: 'skip' }
      });
      expect(schedule.statusCode).toBe(201);
      const queued = await fixture.api.call(alice, 'POST', `/api/v1/subscriptions/${aliceSubscriptionB}/run-now`);
      expect(queued.statusCode).toBe(202);

      const response = await fixture.api.call(alice, 'GET', '/api/v1/subscriptions');
      expect(response.statusCode).toBe(200);
      const list = response.json().subscriptions as Json[];
      const a = list.find((item) => item.id === aliceSubscriptionA)!;
      const b = list.find((item) => item.id === aliceSubscriptionB)!;

      expect(a.platform).toBe('direct_media');
      expect(a.lastRun).toMatchObject({ state: 'stored', assetsStored: 0, assetsFailed: 0, errorCode: null });
      expect(a.lastRun.finishedAt).toEqual(expect.any(String));
      expect(a.nextRunAt).toEqual(expect.any(String));
      expect(a.mediaCount).toEqual({ all: 11, image: 11, video: 0 });
      expect(a.coverAssetId).toBe(alicePngs[10]!.assetId);
      expect(a.activeRunId).toBeNull();

      expect(b.nextRunAt).toBeNull();
      expect(b.mediaCount).toEqual({ all: 2, image: 1, video: 1 });
      expect(b.coverAssetId).toBe(alicePngs[11]!.assetId);
      expect(b.activeRunId).toBe(queued.json().run.id);
    });

    it('gives a subscription without any history the empty summary and keeps the other fields', async () => {
      const fresh = await fixture.createSubscription(alice, 'Frisch');
      const list = (await fixture.api.call(alice, 'GET', '/api/v1/subscriptions')).json().subscriptions as Json[];
      expect(list.find((item) => item.id === fresh)).toMatchObject({
        name: 'Frisch', status: 'active', platform: null, lastRun: null, nextRunAt: null, mediaCount: { all: 0, image: 0, video: 0 }, coverAssetId: null, activeRunId: null
      });
    });

    it('shows only the own numbers to another user', async () => {
      const list = (await fixture.api.call(bob, 'GET', '/api/v1/subscriptions')).json().subscriptions as Json[];
      expect(list.map((item) => item.id)).not.toContain(aliceSubscriptionA);
      const own = list.find((item) => item.id === bobSubscription)!;
      expect(own.mediaCount).toEqual({ all: 1, image: 1, video: 0 });
      expect(own.coverAssetId).toBe(bobAsset.assetId);
    });

    it('answers a single subscription without the summary (unchanged)', async () => {
      const single = (await fixture.api.call(alice, 'GET', `/api/v1/subscriptions/${aliceSubscriptionA}`)).json().subscription;
      expect(single.mediaCount).toBeUndefined();
    });
  });

  describe('A5 GET /api/v1/overview', () => {
    it('answers recent files, active runs, upcoming runs, attention and last runs in one request', async () => {
      const response = await fixture.get(alice, '/api/v1/overview');
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Object.keys(body).sort()).toEqual(['activeRuns', 'attention', 'lastRuns', 'recentAssets', 'upcoming']);

      expect(body.recentAssets).toHaveLength(9);
      expect(body.recentAssets[0].id).toBe(alicePngs[11]!.assetId);
      expect(body.recentAssets[0]).toHaveProperty('hasThumbnail');

      expect(body.activeRuns).toHaveLength(1);
      expect(body.activeRuns[0]).toMatchObject({ subscriptionId: aliceSubscriptionB, subscriptionName: 'Abo B', queueState: 'queued', state: null });
      expect(body.activeRuns[0].counts).toEqual({ postsFound: 0, stored: 0, failed: 0, pending: 0, downloading: 0, verifying: 0 });

      expect(body.upcoming.map((entry: { subscriptionId: string }) => entry.subscriptionId)).toEqual([aliceSubscriptionA]);
      expect(body.upcoming[0].dueAt).toEqual(expect.any(String));
      expect(body.attention).toEqual([]);
      expect(body.lastRuns).toHaveLength(2);
      expect(body.lastRuns[0]).toMatchObject({ state: 'stored', subscriptionName: 'Test' });
    });

    it('counts files still on their way for the active run', async () => {
      const subscription = await fixture.createSubscription(alice, 'Laufend');
      const queued = (await fixture.api.call(alice, 'POST', `/api/v1/subscriptions/${subscription}/run-now`)).json().run.id as string;
      const run = await fixture.startRun(alice, subscription, { jobRunId: queued });
      await fixture.seedAsset(alice, subscription, run, { name: 'wartet.png', mime: 'image/png', bytes: Buffer.alloc(0), state: 'pending', postKey: 'live' });
      await fixture.seedAsset(alice, subscription, run, { name: 'laedt.png', mime: 'image/png', bytes: Buffer.alloc(0), state: 'downloading', postKey: 'live' });
      await fixture.seedAsset(alice, subscription, run, { name: 'prueft.png', mime: 'image/png', bytes: Buffer.alloc(0), state: 'verifying', postKey: 'live' });
      await fixture.history.updateRun(run, { state: 'downloading', stats: { postsFound: 1, postsSkipped: 0, assetsStored: 4, assetsFailed: 1, bytesStored: 1234 } });

      const body = (await fixture.get(alice, '/api/v1/overview')).json();
      const active = body.activeRuns.find((entry: { subscriptionId: string }) => entry.subscriptionId === subscription);
      expect(active).toMatchObject({ runId: queued, state: 'downloading', platform: 'direct_media', bytesStored: 1234 });
      expect(active.counts).toEqual({ postsFound: 1, stored: 4, failed: 1, pending: 1, downloading: 1, verifying: 1 });
      // The id works with the live view.
      expect((await fixture.get(alice, `/api/v1/runs/${active.runId}/assets`)).statusCode).toBe(200);
    });

    it('lists a subscription whose last run needs a login, failed or only partly worked, and drops it once a later run is fine', async () => {
      const auth = await fixture.createSubscription(alice, 'Anmeldung nötig');
      const failed = await fixture.createSubscription(alice, 'Kaputt');
      const partial = await fixture.createSubscription(alice, 'Teilweise');
      const healing = await fixture.createSubscription(alice, 'Erholt sich');
      const finish = async (subscription: string, state: 'waiting_auth' | 'failed' | 'partially_completed' | 'stored', errorCode: string | null) => {
        const run = await fixture.startRun(alice, subscription);
        await fixture.history.updateRun(run, { state, errorCode, errorMessage: errorCode ? 'Text' : null, finished: true });
        await sleep(5);
      };
      await finish(auth, 'waiting_auth', 'AUTH_REQUIRED');
      await finish(failed, 'failed', 'DOWNLOAD_FAILED');
      await finish(partial, 'partially_completed', null);
      await finish(healing, 'failed', 'DOWNLOAD_FAILED');
      await finish(healing, 'stored', null);

      const body = (await fixture.get(alice, '/api/v1/overview')).json();
      const byName: Json = Object.fromEntries(body.attention.map((entry: { subscriptionName: string }) => [entry.subscriptionName, entry]));
      expect(Object.keys(byName).sort()).toEqual(['Anmeldung nötig', 'Kaputt', 'Teilweise']);
      expect(byName['Anmeldung nötig']).toMatchObject({ kind: 'auth_required', state: 'waiting_auth', errorCode: 'AUTH_REQUIRED' });
      expect(byName.Kaputt.kind).toBe('failed');
      expect(byName.Teilweise.kind).toBe('partial');
      expect(body.lastRuns.length).toBeLessThanOrEqual(5);

      // A paused subscription is not a call for attention.
      expect((await fixture.api.call(alice, 'POST', `/api/v1/subscriptions/${failed}/pause`)).statusCode).toBe(200);
      const later = (await fixture.get(alice, '/api/v1/overview')).json();
      expect(later.attention.map((entry: { subscriptionName: string }) => entry.subscriptionName)).not.toContain('Kaputt');
    });

    it('contains nothing of another user and nothing at all for a user without data', async () => {
      const bobBody = (await fixture.get(bob, '/api/v1/overview')).json();
      expect(bobBody.recentAssets.every((item: { id: string }) => item.id !== alicePngs[0]!.assetId)).toBe(true);
      expect(JSON.stringify(bobBody)).not.toContain('Abo A');
      const empty = await fixture.api.addUser('carol');
      expect((await fixture.get(empty, '/api/v1/overview')).json()).toEqual({ recentAssets: [], activeRuns: [], upcoming: [], attention: [], lastRuns: [] });
    });
  });
});
