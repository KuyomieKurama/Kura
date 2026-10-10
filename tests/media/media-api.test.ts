import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createMediaFixture, patternBytes, tinyPng, type MediaFixture, type SeededAsset } from './fixture.js';
import type { TestLogin } from '../m4b/api-fixture.js';

const VIDEO_BYTES = patternBytes(300 * 1024 + 123);

describe('media API', () => {
  let fixture: MediaFixture;
  let alice: TestLogin;
  let bob: TestLogin;
  let aliceSubscription: string;
  let bobSubscription: string;
  let aliceRun: string;
  const aliceAssets: Record<string, SeededAsset> = {};
  let bobAsset: SeededAsset;

  beforeAll(async () => {
    fixture = await createMediaFixture();
    alice = await fixture.api.addUser('alice');
    bob = await fixture.api.addUser('bob');
    aliceSubscription = await fixture.createSubscription(alice, 'Alices Abo');
    bobSubscription = await fixture.createSubscription(bob, 'Bobs Abo');
    aliceRun = await fixture.startRun(alice, aliceSubscription, { finished: true });
    const bobRun = await fixture.startRun(bob, bobSubscription, { finished: true });

    // Seeded oldest first: the list shows them newest first.
    aliceAssets.png = await fixture.seedAsset(alice, aliceSubscription, aliceRun, { name: 'bild-1.png', mime: 'image/png', bytes: tinyPng('one'), postKey: 'post-a' });
    aliceAssets.png2 = await fixture.seedAsset(alice, aliceSubscription, aliceRun, { name: 'bild-2.png', mime: 'image/png', bytes: tinyPng('two'), postKey: 'post-a' });
    aliceAssets.video = await fixture.seedAsset(alice, aliceSubscription, aliceRun, { name: 'clip.mp4', mime: 'video/mp4', bytes: VIDEO_BYTES, postKey: 'post-b', postTitle: null });
    aliceAssets.svg = await fixture.seedAsset(alice, aliceSubscription, aliceRun, { name: 'zeichnung.svg', mime: 'image/svg+xml', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), postKey: 'post-c' });
    aliceAssets.html = await fixture.seedAsset(alice, aliceSubscription, aliceRun, { name: 'seite.html', mime: 'text/html', bytes: Buffer.from('<script>alert(1)</script>'), postKey: 'post-c' });
    aliceAssets.unicode = await fixture.seedAsset(alice, aliceSubscription, aliceRun, { name: 'Übergrößé "☃".png', mime: 'image/png', bytes: tinyPng('unicode'), postKey: 'post-d' });
    bobAsset = await fixture.seedAsset(bob, bobSubscription, bobRun, { name: 'geheim.png', mime: 'image/png', bytes: tinyPng('bob'), postKey: 'post-x' });
  });

  afterAll(async () => { await fixture.cleanup(); });

  describe('authentication', () => {
    it('answers every media route with 401 without a session', async () => {
      for (const url of [
        `/api/v1/subscriptions/${aliceSubscription}/media`,
        `/api/v1/runs/${aliceRun}/assets`,
        `/api/v1/assets/${aliceAssets.png!.assetId}/content`
      ]) {
        const response = await fixture.get(null, url);
        expect(response.statusCode, url).toBe(401);
      }
    });
  });

  describe('owner isolation', () => {
    it('lists only the own subscription and answers 404 for a foreign one', async () => {
      const own = await fixture.get(bob, `/api/v1/subscriptions/${bobSubscription}/media`);
      expect(own.statusCode).toBe(200);
      expect(own.json().items.map((item: { id: string }) => item.id)).toEqual([bobAsset.assetId]);

      const foreign = await fixture.get(bob, `/api/v1/subscriptions/${aliceSubscription}/media`);
      expect(foreign.statusCode).toBe(404);
      const unknown = await fixture.get(bob, '/api/v1/subscriptions/00000000-0000-4000-8000-000000000000/media');
      expect(unknown.statusCode).toBe(404);
      // A foreign id and an unknown id are indistinguishable.
      expect(foreign.body).toBe(unknown.body);
      expect((await fixture.get(bob, '/api/v1/subscriptions/not-a-uuid/media')).statusCode).toBe(404);
    });

    it('answers 404, never 403, for the content of a foreign asset and never sends a byte of it', async () => {
      const foreign = await fixture.get(bob, `/api/v1/assets/${aliceAssets.png!.assetId}/content`);
      expect(foreign.statusCode).toBe(404);
      const unknown = await fixture.get(bob, '/api/v1/assets/00000000-0000-4000-8000-000000000000/content');
      expect(unknown.statusCode).toBe(404);
      expect(foreign.body).toBe(unknown.body);
      expect(foreign.headers['content-type']).toContain('application/json');
      expect(foreign.rawPayload.includes(tinyPng('one'))).toBe(false);
      expect((await fixture.get(alice, `/api/v1/assets/${aliceAssets.png!.assetId}/content`)).statusCode).toBe(200);
    });

    it('does not let a foreign user read the assets of a run, neither by history id nor by queue id', async () => {
      expect((await fixture.get(bob, `/api/v1/runs/${aliceRun}/assets`)).statusCode).toBe(404);
      const jobRunId = (await fixture.api.pool.query('SELECT job_run_id FROM download_runs WHERE id=$1', [aliceRun])).rows[0].job_run_id;
      expect((await fixture.get(bob, `/api/v1/runs/${jobRunId}/assets`)).statusCode).toBe(404);
      expect((await fixture.get(alice, `/api/v1/runs/${jobRunId}/assets`)).statusCode).toBe(200);
    });

    it('does not serve an object of another owner even if an asset row points at it', async () => {
      // Defence in depth: the blob store checks the owner on its own. Point Bob\'s asset at Alice\'s blob.
      const crossed = await fixture.seedAsset(bob, bobSubscription, (await fixture.api.pool.query('SELECT id FROM download_runs WHERE user_id=$1', [bob.userId])).rows[0].id, { name: 'x.png', mime: 'image/png', bytes: tinyPng('crossed') });
      await fixture.api.pool.query('UPDATE download_assets SET blob_object_id=$2 WHERE id=$1', [crossed.assetId, aliceAssets.png!.blobObjectId]);
      const response = await fixture.get(bob, `/api/v1/assets/${crossed.assetId}/content`);
      expect(response.statusCode).toBe(410);
      expect(response.rawPayload.includes(tinyPng('one'))).toBe(false);
    });
  });

  describe('subscription list', () => {
    it('lists stored assets newest first with the post data and the totals', async () => {
      const response = await fixture.get(alice, `/api/v1/subscriptions/${aliceSubscription}/media`);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.items.map((item: { originalName: string }) => item.originalName)).toEqual([
        'Übergrößé "☃".png', 'seite.html', 'zeichnung.svg', 'clip.mp4', 'bild-2.png', 'bild-1.png'
      ]);
      expect(body.counts).toEqual({ all: 6, image: 4, video: 1 });
      expect(body.nextCursor).toBeNull();

      const video = body.items.find((item: { originalName: string }) => item.originalName === 'clip.mp4');
      expect(video).toMatchObject({
        id: aliceAssets.video!.assetId,
        mediaKind: 'video',
        mimeType: 'video/mp4',
        byteSize: VIDEO_BYTES.length,
        runId: aliceRun,
        platform: 'direct_media',
        creatorName: 'Creator Eins',
        postTitle: null,
        state: 'stored',
        immich: { state: 'not_attempted', verified: false, verifiedAt: null }
      });
      expect(Date.parse(video.storedAt)).not.toBeNaN();
      // The history keeps the address without query and fragment; the signature of the seed must not come back.
      expect(video.postUrl).toMatch(/^https:\/\/example\.com\/post\/post-b$/);
      expect(JSON.stringify(body)).not.toContain('signature');
      expect(JSON.stringify(body)).not.toContain('blob_object_id');
      expect(JSON.stringify(body)).not.toContain(aliceAssets.video!.blobObjectId);

      const first = body.items.find((item: { originalName: string }) => item.originalName === 'bild-1.png');
      const second = body.items.find((item: { originalName: string }) => item.originalName === 'bild-2.png');
      expect(first.postId).toBe(second.postId);
      expect(first.assetIndex).toBe(0);
      expect(second.assetIndex).toBe(1);
    });

    it('filters by type and keeps the totals', async () => {
      const images = (await fixture.get(alice, `/api/v1/subscriptions/${aliceSubscription}/media?type=image`)).json();
      expect(images.items.every((item: { mediaKind: string }) => item.mediaKind === 'image')).toBe(true);
      expect(images.items).toHaveLength(4);
      const videos = (await fixture.get(alice, `/api/v1/subscriptions/${aliceSubscription}/media?type=video`)).json();
      expect(videos.items.map((item: { originalName: string }) => item.originalName)).toEqual(['clip.mp4']);
      expect(videos.counts.all).toBe(6);
      expect((await fixture.get(alice, `/api/v1/subscriptions/${aliceSubscription}/media?type=everything`)).statusCode).toBe(400);
    });

    it('pages with a cursor without gaps or repeats', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const url: string = `/api/v1/subscriptions/${aliceSubscription}/media?limit=4${cursor ? `&cursor=${cursor}` : ''}`;
        const body: { items: { originalName: string }[]; nextCursor: string | null; counts?: unknown } = (await fixture.get(alice, url)).json();
        seen.push(...body.items.map((item) => item.originalName));
        // Totals only come with the first page.
        expect(body.counts !== undefined).toBe(pages === 0);
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor && pages < 5);
      expect(pages).toBe(2);
      expect(seen).toEqual(['Übergrößé "☃".png', 'seite.html', 'zeichnung.svg', 'clip.mp4', 'bild-2.png', 'bild-1.png']);
    });

    it('rejects a broken cursor or limit with 400', async () => {
      expect((await fixture.get(alice, `/api/v1/subscriptions/${aliceSubscription}/media?cursor=%25%25`)).statusCode).toBe(400);
      expect((await fixture.get(alice, `/api/v1/subscriptions/${aliceSubscription}/media?limit=0`)).statusCode).toBe(400);
      expect((await fixture.get(alice, `/api/v1/subscriptions/${aliceSubscription}/media?limit=1000`)).statusCode).toBe(400);
    });

    it('does not list assets that are not stored yet', async () => {
      const run = await fixture.startRun(alice, aliceSubscription);
      await fixture.seedAsset(alice, aliceSubscription, run, { name: 'laedt.jpg', mime: 'image/jpeg', bytes: Buffer.alloc(0), state: 'downloading' });
      const body = (await fixture.get(alice, `/api/v1/subscriptions/${aliceSubscription}/media`)).json();
      expect(body.items.map((item: { originalName: string }) => item.originalName)).not.toContain('laedt.jpg');
      await fixture.api.pool.query("UPDATE download_runs SET finished_at=now() WHERE id=$1", [run]);
    });

    it('shows the Immich verification only with evidence', async () => {
      const subscription = await fixture.createSubscription(alice, 'Immich');
      const run = await fixture.startRun(alice, subscription, { finished: true });
      const verified = await fixture.seedAsset(alice, subscription, run, { name: 'v.png', mime: 'image/png', bytes: tinyPng('v') });
      const claimed = await fixture.seedAsset(alice, subscription, run, { name: 'c.png', mime: 'image/png', bytes: tinyPng('c') });
      const transferId = await insertVerifiedTransfer(fixture, alice.userId, verified);
      await fixture.history.setHandover(verified.assetId, 'verified', transferId);
      await fixture.history.setHandover(claimed.assetId, 'verified');
      const items = (await fixture.get(alice, `/api/v1/subscriptions/${subscription}/media`)).json().items as { id: string; immich: { verified: boolean; state: string; verifiedAt: string | null } }[];
      expect(items.find((item) => item.id === verified.assetId)!.immich).toMatchObject({ state: 'verified', verified: true });
      expect(items.find((item) => item.id === verified.assetId)!.immich.verifiedAt).not.toBeNull();
      // A state without the evidence record is not shown as verified.
      expect(items.find((item) => item.id === claimed.assetId)!.immich).toMatchObject({ state: 'verified', verified: false, verifiedAt: null });
    });
  });

  describe('content route', () => {
    const png = tinyPng('one');

    it('streams an image with type, length, ETag and the security headers', async () => {
      const response = await fixture.get(alice, `/api/v1/assets/${aliceAssets.png!.assetId}/content`);
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload.equals(png)).toBe(true);
      expect(response.headers['content-type']).toBe('image/png');
      expect(response.headers['content-length']).toBe(String(png.length));
      expect(response.headers.etag).toBe(`"${aliceAssets.png!.sha256}"`);
      expect(response.headers['accept-ranges']).toBe('bytes');
      expect(response.headers['cache-control']).toMatch(/\bprivate\b/);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(response.headers['content-disposition']).toMatch(/^inline; filename="bild-1.png"; filename\*=UTF-8''bild-1\.png$/);
    });

    it('answers HEAD with the headers and no body', async () => {
      const response = await fixture.api.app.inject({ method: 'HEAD', url: `/api/v1/assets/${aliceAssets.png!.assetId}/content`, headers: { cookie: alice.cookie, host: 'localhost' } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-length']).toBe(String(png.length));
      expect(response.rawPayload.length).toBe(0);
    });

    it('serves a multi-chunk video byte-exact, whole and by range', async () => {
      const url = `/api/v1/assets/${aliceAssets.video!.assetId}/content`;
      const whole = await fixture.get(alice, url);
      expect(whole.statusCode).toBe(200);
      expect(whole.headers['content-type']).toBe('video/mp4');
      expect(whole.rawPayload.equals(VIDEO_BYTES)).toBe(true);

      const middle = await fixture.get(alice, url, { range: 'bytes=70000-200000' });
      expect(middle.statusCode).toBe(206);
      expect(middle.headers['content-range']).toBe(`bytes 70000-200000/${VIDEO_BYTES.length}`);
      expect(middle.headers['content-length']).toBe('130001');
      expect(middle.rawPayload.equals(VIDEO_BYTES.subarray(70000, 200001))).toBe(true);
      expect(middle.headers['content-type']).toBe('video/mp4');

      const open = await fixture.get(alice, url, { range: `bytes=${VIDEO_BYTES.length - 100}-` });
      expect(open.statusCode).toBe(206);
      expect(open.rawPayload.equals(VIDEO_BYTES.subarray(VIDEO_BYTES.length - 100))).toBe(true);

      const suffix = await fixture.get(alice, url, { range: 'bytes=-10' });
      expect(suffix.statusCode).toBe(206);
      expect(suffix.headers['content-range']).toBe(`bytes ${VIDEO_BYTES.length - 10}-${VIDEO_BYTES.length - 1}/${VIDEO_BYTES.length}`);
      expect(suffix.rawPayload.equals(VIDEO_BYTES.subarray(VIDEO_BYTES.length - 10))).toBe(true);

      const first = await fixture.get(alice, url, { range: 'bytes=0-0' });
      expect(first.statusCode).toBe(206);
      expect(first.rawPayload.equals(VIDEO_BYTES.subarray(0, 1))).toBe(true);
    });

    it('answers an unsatisfiable or malformed range with 416 and the size', async () => {
      const url = `/api/v1/assets/${aliceAssets.video!.assetId}/content`;
      for (const range of [`bytes=${VIDEO_BYTES.length}-`, 'bytes=999999999-', 'bytes=10-5', 'bytes=abc', 'bytes=-0']) {
        const response = await fixture.get(alice, url, { range });
        expect(response.statusCode, range).toBe(416);
        expect(response.headers['content-range'], range).toBe(`bytes */${VIDEO_BYTES.length}`);
        expect(response.headers['content-type'], range).toContain('application/json');
        expect(response.headers['x-content-type-options']).toBe('nosniff');
      }
    });

    it('ignores a range of another unit or several ranges and sends the whole file', async () => {
      const url = `/api/v1/assets/${aliceAssets.png!.assetId}/content`;
      expect((await fixture.get(alice, url, { range: 'items=0-3' })).statusCode).toBe(200);
      expect((await fixture.get(alice, url, { range: 'bytes=0-1,4-5' })).rawPayload.equals(png)).toBe(true);
    });

    it('honours If-Range only with a matching validator', async () => {
      const url = `/api/v1/assets/${aliceAssets.video!.assetId}/content`;
      const etag = `"${aliceAssets.video!.sha256}"`;
      expect((await fixture.get(alice, url, { range: 'bytes=0-9', 'if-range': etag })).statusCode).toBe(206);
      const stale = await fixture.get(alice, url, { range: 'bytes=0-9', 'if-range': '"old"' });
      expect(stale.statusCode).toBe(200);
      expect(stale.rawPayload.length).toBe(VIDEO_BYTES.length);
    });

    it('answers 304 for a matching If-None-Match, without a body but with the headers', async () => {
      const url = `/api/v1/assets/${aliceAssets.png!.assetId}/content`;
      const etag = `"${aliceAssets.png!.sha256}"`;
      const response = await fixture.get(alice, url, { 'if-none-match': etag });
      expect(response.statusCode).toBe(304);
      expect(response.rawPayload.length).toBe(0);
      expect(response.headers.etag).toBe(etag);
      expect(response.headers['cache-control']).toMatch(/\bprivate\b/);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect((await fixture.get(alice, url, { 'if-none-match': 'W/' + etag })).statusCode).toBe(304);
      expect((await fixture.get(alice, url, { 'if-none-match': '"other"' })).statusCode).toBe(200);
      // A foreign user must not learn anything from the conditional request either.
      expect((await fixture.get(bob, url, { 'if-none-match': etag })).statusCode).toBe(404);
    });

    it('sends SVG and HTML as an attachment of an opaque type, with nosniff and the sandbox policy', async () => {
      for (const [key, name] of [['svg', 'zeichnung.svg'], ['html', 'seite.html']] as const) {
        const response = await fixture.get(alice, `/api/v1/assets/${aliceAssets[key]!.assetId}/content`);
        expect(response.statusCode, name).toBe(200);
        expect(response.headers['content-disposition'], name).toMatch(new RegExp(`^attachment; filename="${name.replace('.', '\\.')}"`));
        expect(response.headers['content-type'], name).toBe('application/octet-stream');
        expect(response.headers['x-content-type-options'], name).toBe('nosniff');
        expect(response.headers['content-security-policy'], name).toBe("default-src 'none'; sandbox");
      }
    });

    it('offers an explicit download of an image as an attachment', async () => {
      const response = await fixture.get(alice, `/api/v1/assets/${aliceAssets.png!.assetId}/content?download=1`);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-disposition']).toMatch(/^attachment; /);
      expect(response.headers['content-type']).toBe('image/png');
      expect(response.rawPayload.equals(png)).toBe(true);
    });

    it('encodes a name with quotes, umlauts and symbols safely', async () => {
      const response = await fixture.get(alice, `/api/v1/assets/${aliceAssets.unicode!.assetId}/content`);
      const disposition = String(response.headers['content-disposition']);
      expect(disposition).toBe("inline; filename=\"_bergr___ ___.png\"; filename*=UTF-8''%C3%9Cbergr%C3%B6%C3%9F%C3%A9%20%22%E2%98%83%22.png");
      expect(disposition).toMatch(/^[\x20-\x7e]+$/);
    });

    it('does not let the app-wide policy replace the sandbox policy, and keeps it for ordinary routes', async () => {
      const content = await fixture.get(alice, `/api/v1/assets/${aliceAssets.png!.assetId}/content`);
      expect(content.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      const list = await fixture.get(alice, `/api/v1/subscriptions/${aliceSubscription}/media`);
      expect(list.headers['content-security-policy']).toBe("default-src 'self'");
      expect(list.headers['x-content-type-options']).toBe('nosniff');
    });

    it('answers 410 when the local copy is gone and 404 for an asset that is not stored', async () => {
      const subscription = await fixture.createSubscription(alice, 'Weg');
      const run = await fixture.startRun(alice, subscription, { finished: true });
      const gone = await fixture.seedAsset(alice, subscription, run, { name: 'weg.png', mime: 'image/png', bytes: tinyPng('gone') });
      // Simulates a copy that was removed elsewhere; Kura itself has no deletion path.
      await fixture.api.pool.query('DELETE FROM blobstore_objects WHERE id=$1', [gone.blobObjectId]);
      const response = await fixture.get(alice, `/api/v1/assets/${gone.assetId}/content`);
      expect(response.statusCode).toBe(410);
      expect(response.json().error.code).toBe('CONTENT_UNAVAILABLE');

      const pending = await fixture.seedAsset(alice, subscription, run, { name: 'p.png', mime: 'image/png', bytes: Buffer.alloc(0), state: 'pending' });
      expect((await fixture.get(alice, `/api/v1/assets/${pending.assetId}/content`)).statusCode).toBe(404);
    });

    it('has no way to delete or change anything through the media routes', async () => {
      const url = `/api/v1/assets/${aliceAssets.png!.assetId}/content`;
      for (const method of ['DELETE', 'PUT', 'PATCH', 'POST'] as const) {
        const response = await fixture.api.call(alice, method, url, method === 'DELETE' ? undefined : {});
        expect(response.statusCode, method).toBe(404);
      }
      expect((await fixture.get(alice, url)).statusCode).toBe(200);
    });
  });

  describe('streaming', () => {
    it('streams a multi-chunk object from the database backend chunk by chunk and releases the lease', async () => {
      const address = await fixture.api.app.listen({ port: 0, host: '127.0.0.1' });
      const port = (fixture.api.app.server.address() as AddressInfo).port;
      expect(address).toContain(String(port));
      const url = `http://127.0.0.1:${port}/api/v1/assets/${aliceAssets.video!.assetId}/content`;
      const objectId = aliceAssets.video!.blobObjectId!;
      const leases = async () => Number((await fixture.api.pool.query('SELECT leases FROM blobstore_objects WHERE id=$1', [objectId])).rows[0].leases);

      // The 300 KiB object is stored as 5 chunks of 64 KiB. The client receives it as several pieces, none of
      // which is the whole object, which shows that the route does not collect the object before sending.
      const response = await fetch(url, { headers: { cookie: alice.cookie, connection: 'close' } });
      expect(response.status).toBe(200);
      const pieces: number[] = [];
      const received: Buffer[] = [];
      for await (const piece of response.body!) {
        pieces.push(piece.length);
        received.push(Buffer.from(piece));
      }
      expect(Buffer.concat(received).equals(VIDEO_BYTES)).toBe(true);
      expect(pieces.length).toBeGreaterThan(1);
      expect(Math.max(...pieces)).toBeLessThan(VIDEO_BYTES.length);
      await waitFor(async () => (await leases()) === 0);

      // A client that goes away in the middle gives the lease back as well.
      const aborted = await fetch(url, { headers: { cookie: alice.cookie, connection: 'close' } });
      const reader = aborted.body!.getReader();
      await reader.read();
      await reader.cancel();
      await waitFor(async () => (await leases()) === 0);
    });
  });

  describe('run assets', () => {
    it('shows assets in progress and stored assets of a running run, and the counts', async () => {
      const subscription = await fixture.createSubscription(alice, 'Live');
      const run = await fixture.startRun(alice, subscription);
      const stored = await fixture.seedAsset(alice, subscription, run, { name: 'fertig.png', mime: 'image/png', bytes: tinyPng('live-1'), postKey: 'live-post' });
      await fixture.seedAsset(alice, subscription, run, { name: 'laedt.mp4', mime: 'video/mp4', bytes: Buffer.alloc(0), state: 'downloading', postKey: 'live-post' });
      await fixture.seedAsset(alice, subscription, run, { name: 'wartet.png', mime: 'image/png', bytes: Buffer.alloc(0), state: 'pending', postKey: 'live-post' });
      await fixture.seedAsset(alice, subscription, run, { name: 'kaputt.png', mime: 'image/png', bytes: Buffer.alloc(0), state: 'failed', postKey: 'live-post-2' });

      const body = (await fixture.get(alice, `/api/v1/runs/${run}/assets`)).json();
      expect(body.active).toBe(true);
      expect(body.run).toMatchObject({ id: run, state: 'downloading', subscriptionId: subscription, finishedAt: null });
      expect(body.counts).toEqual({ pending: 1, downloading: 1, verifying: 0, stored: 1, failed: 1 });
      const byName = Object.fromEntries(body.assets.map((asset: { originalName: string }) => [asset.originalName, asset]));
      expect(byName['fertig.png']).toMatchObject({ id: stored.assetId, state: 'stored', mediaKind: 'image' });
      expect(byName['laedt.mp4']).toMatchObject({ state: 'downloading', mediaKind: 'video', storedAt: null });
      expect(byName['wartet.png'].state).toBe('pending');
      expect(byName['kaputt.png']).toMatchObject({ state: 'failed', errorCode: 'DOWNLOAD_FAILED' });
      expect(body.truncated).toBe(false);

      // The next poll sees the file that was stored in the meantime, and the end of the run.
      await fixture.history.markAssetStored(byName['laedt.mp4'].id, { sha256: 'a'.repeat(64), sha1: 'b'.repeat(40), byteSize: 1, blobObjectId: 'x' });
      await fixture.history.updateRun(run, { state: 'partially_completed', finished: true });
      const later = (await fixture.get(alice, `/api/v1/runs/${run}/assets`)).json();
      expect(later.active).toBe(false);
      expect(later.run.finishedAt).not.toBeNull();
      expect(later.counts.stored).toBe(2);
      expect(later.counts.downloading).toBe(0);
    });

    it('answers for the queued run that "Jetzt ausführen" returns, before and after a worker took it', async () => {
      const subscription = await fixture.createSubscription(alice, 'Warteschlange');
      const queued = await fixture.api.call(alice, 'POST', `/api/v1/subscriptions/${subscription}/run-now`);
      expect(queued.statusCode).toBe(202);
      const jobRunId = queued.json().run.id as string;

      const waiting = (await fixture.get(alice, `/api/v1/runs/${jobRunId}/assets`)).json();
      expect(waiting).toMatchObject({ run: null, active: true, assets: [], queue: { state: 'queued' } });

      // The worker starts: a history run appears for the same queued run.
      const run = await fixture.startRun(alice, subscription, { jobRunId });
      await fixture.seedAsset(alice, subscription, run, { name: 'neu.png', mime: 'image/png', bytes: tinyPng('queued-1') });
      const started = (await fixture.get(alice, `/api/v1/runs/${jobRunId}/assets`)).json();
      expect(started.run.id).toBe(run);
      expect(started.assets.map((asset: { originalName: string }) => asset.originalName)).toEqual(['neu.png']);
      // The same answer by the id of the history run.
      expect((await fixture.get(alice, `/api/v1/runs/${run}/assets`)).json().run.id).toBe(run);
    });

    it('includes files that a later run loads for an older post', async () => {
      const subscription = await fixture.createSubscription(alice, 'Zweiter Lauf');
      const first = await fixture.startRun(alice, subscription, { finished: true });
      await fixture.seedAsset(alice, subscription, first, { name: 'frueh.png', mime: 'image/png', bytes: tinyPng('early'), postKey: 'alt' });
      const retry = await fixture.seedAsset(alice, subscription, first, { name: 'spaeter.png', mime: 'image/png', bytes: Buffer.alloc(0), state: 'failed', postKey: 'alt' });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const second = await fixture.startRun(alice, subscription);
      // The older post stays with the first run; the retry of its file belongs to the second.
      await fixture.history.startAsset(retry.assetId);
      const body = (await fixture.get(alice, `/api/v1/runs/${second}/assets`)).json();
      expect(body.assets.map((asset: { originalName: string }) => asset.originalName)).toEqual(['spaeter.png']);
      expect(body.assets[0].state).toBe('downloading');
    });

    it('answers 404 for an unknown id', async () => {
      expect((await fixture.get(alice, '/api/v1/runs/00000000-0000-4000-8000-000000000000/assets')).statusCode).toBe(404);
      expect((await fixture.get(alice, '/api/v1/runs/nope/assets')).statusCode).toBe(404);
    });
  });
});

async function insertVerifiedTransfer(fixture: MediaFixture, userId: string, asset: SeededAsset): Promise<string> {
  const id = randomUUID();
  await fixture.api.pool.query(
    `INSERT INTO immich_transfers (id, user_id, object_id, target_id, status, own_sha256, verified_at, verified_server_version,
                                   verified_byte_size, verified_album_state)
     VALUES ($1, $2, $3, 'target-1', 'verified', $4, now(), '2.5.0', 1, 'none')`,
    [id, userId, asset.blobObjectId, asset.sha256]
  );
  return id;
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition not met in time');
}
