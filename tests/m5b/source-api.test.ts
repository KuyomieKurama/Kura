import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DownloadLoop } from '../../apps/worker/src/download-loop.js';
import { HistoryRepository } from '../../apps/worker/src/history.js';
import { RuntimePolicyRepository } from '../../packages/scheduler/src/index.js';
import { createApiFixture, type ApiFixture, type TestLogin } from '../m4b/api-fixture.js';
import { createPipelineFixture, jpeg, type PipelineFixture } from './fixture.js';

describe('source validation, adapters, run-now, history and kill switches (API on real PostgreSQL)', () => {
  const open: Array<{ api: ApiFixture; pipeline?: PipelineFixture; loop?: DownloadLoop }> = [];
  afterEach(async () => {
    for (const entry of open.splice(0)) {
      await entry.loop?.stop();
      await entry.pipeline?.cleanup();
      await entry.api.cleanup();
    }
  });

  async function start(withPipeline = false) {
    const api = await createApiFixture();
    const entry: { api: ApiFixture; pipeline?: PipelineFixture; loop?: DownloadLoop } = { api };
    open.push(entry);
    const alice = await api.addUser('alice');
    const bob = await api.addUser('bob');
    if (withPipeline) entry.pipeline = await createPipelineFixture({ database: { pool: api.pool }, clock: api.clock });
    return { api, alice, bob, entry };
  }

  const subscribe = async (api: ApiFixture, login: TestLogin, targetUrl: string, name = 'Source') =>
    (await api.call(login, 'POST', '/api/v1/subscriptions', { name, targetUrl })).json().subscription as { id: string };

  describe('POST /api/v1/sources/validate', () => {
    it.each([
      ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', { platform: 'youtube', platformLabel: 'YouTube', adapter: { id: 'yt-dlp' }, capabilities: { videos: true, images: false, creatorFeed: true, authKind: 'cookies' } }],
      ['https://www.pixiv.net/en/artworks/98765?x=1', { platform: 'pixiv', canonicalUrl: 'https://www.pixiv.net/artworks/98765', adapter: { id: 'gallery-dl' }, capabilities: { images: true, videos: false } }],
      ['https://www.instagram.com/p/Cabc12345/', { platform: 'instagram', adapter: { id: 'gallery-dl' }, capabilities: { creatorFeed: true, videos: true, images: true, authKind: 'cookies', authLabel: 'Cookies' } }],
      ['https://www.patreon.com/posts/own-post-123456', { platform: 'patreon', adapter: { id: 'gallery-dl' } }],
      ['https://media.example.test/files/pic.jpg', { platform: 'direct_media', platformLabel: 'Direkte Medien-URL', adapter: { id: 'direct-url', availability: 'available' }, runnable: true, capabilities: { images: true, videos: true } }]
    ])('recognises %s', async (url, expected) => {
      const { api, alice } = await start();
      const response = await api.call(alice, 'POST', '/api/v1/sources/validate', { url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ supported: true, targetKind: 'post', ...expected });
    });

    it.each([
      ['https://www.youtube.com/feed/subscriptions', 'TARGET_UNSUPPORTED', /YouTube-Adresse ist zurzeit nicht unterstützt/],
      ['https://www.youtube.com/playlist?list=PL12345', 'TARGET_INVALID', /Kennung der YouTube-Playlist ist ungültig/],
      ['https://www.pornhub.com/categories', 'TARGET_UNSUPPORTED', /Pornhub-Adresse ist zurzeit nicht unterstützt/],
      ['https://www.pornhub.com/view_video.php?viewkey=abc', 'TARGET_INVALID', /Kennung \(viewkey\) des Pornhub-Videos ist ungültig/],
      ['https://www.instagram.com/stories/someprofile/', 'TARGET_UNSUPPORTED', /Stories sind zurzeit nicht unterstützt/],
      ['https://www.instagram.com/someprofile/highlights/', 'TARGET_UNSUPPORTED', /Highlights sind zurzeit nicht unterstützt/],
      ['https://www.instagram.com/explore/', 'TARGET_UNSUPPORTED', /kein Profil, kein Beitrag und kein Reel/],
      ['http://media.example.test/pic.jpg', 'TARGET_INVALID', /nur https-Adressen/],
      ['https://user:secret@media.example.test/pic.jpg', 'TARGET_INVALID', /nur https-Adressen/],
      ['ftp://media.example.test/pic.jpg', 'TARGET_INVALID', /nur https-Adressen/]
    ] as Array<[string, string, RegExp]>)('answers %s with a clear German message', async (url, code, message) => {
      const { api, alice } = await start();
      const response = await api.call(alice, 'POST', '/api/v1/sources/validate', { url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ supported: false, code });
      expect(response.json().message).toMatch(message);
    });

    it('rejects malformed requests and needs a session', async () => {
      const { api, alice } = await start();
      for (const payload of [{}, { url: 5 }, { url: '' }, { url: 'x'.repeat(2049) }, { url: 'https://a.test/\u0000' }, []]) {
        expect((await api.call(alice, 'POST', '/api/v1/sources/validate', payload)).statusCode, JSON.stringify(payload).slice(0, 40)).toBe(400);
      }
      expect([401, 403]).toContain((await api.call(null, 'POST', '/api/v1/sources/validate', { url: 'https://a.test/x.jpg' })).statusCode);
    });

    it('tells whether the tool behind a platform is usable, as reported by the worker', async () => {
      const { api, alice } = await start();
      const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

      const unknown = (await api.call(alice, 'POST', '/api/v1/sources/validate', { url })).json();
      expect(unknown.adapter).toMatchObject({ id: 'yt-dlp', availability: 'unknown' });
      expect(unknown.runnable).toBe(true);
      expect(unknown.notices.join(' ')).toMatch(/noch nicht gemeldet/);

      await api.pool.query("INSERT INTO adapter_status (adapter_id, availability, reason_code) VALUES ('yt-dlp', 'unavailable', 'BINARY_NOT_CONFIGURED')");
      const missing = (await api.call(alice, 'POST', '/api/v1/sources/validate', { url })).json();
      expect(missing).toMatchObject({ supported: true, runnable: false, adapter: { availability: 'unavailable' } });
      expect(missing.notices.join(' ')).toMatch(/nicht installiert oder nicht freigegeben/);

      await api.pool.query("UPDATE adapter_status SET availability = 'available', adapter_version = '2026.07.04', reason_code = NULL");
      const ready = (await api.call(alice, 'POST', '/api/v1/sources/validate', { url })).json();
      expect(ready).toMatchObject({ runnable: true, adapter: { availability: 'available', version: '2026.07.04' } });
    });

    it('does not run anything and makes no network request', async () => {
      const { api, alice } = await start();
      const before = Date.now();
      const response = await api.call(alice, 'POST', '/api/v1/sources/validate', { url: 'https://203.0.113.9:81/never-requested.jpg' });
      expect(response.json()).toMatchObject({ supported: true, platform: 'direct_media' });
      expect(Date.now() - before).toBeLessThan(2000);
    });
  });

  describe('GET /api/v1/adapters', () => {
    it('lists the adapters with capabilities and availability', async () => {
      const { api, alice } = await start();
      await api.pool.query("INSERT INTO adapter_status (adapter_id, adapter_version, availability) VALUES ('gallery-dl', '1.32.2', 'available'), ('yt-dlp', NULL, 'unavailable')");
      const response = await api.call(alice, 'GET', '/api/v1/adapters');
      expect(response.statusCode).toBe(200);
      const adapters = response.json().adapters as Array<Record<string, unknown>>;
      expect(adapters.map((adapter) => [adapter.id, adapter.availability])).toEqual([['gallery-dl', 'available'], ['yt-dlp', 'unavailable'], ['direct-url', 'available']]);
      expect(adapters.find((adapter) => adapter.id === 'gallery-dl')).toMatchObject({ version: '1.32.2', label: expect.stringContaining('gallery-dl'), sourceTypes: [{ id: 'pixiv', label: 'Pixiv' }, { id: 'instagram', label: 'Instagram' }, { id: 'patreon', label: 'Patreon' }, { id: 'pornhub', label: 'Pornhub' }] });
      expect(adapters.find((adapter) => adapter.id === 'yt-dlp')!.message).toMatch(/nicht installiert/);
      expect([401, 403]).toContain((await api.call(null, 'GET', '/api/v1/adapters')).statusCode);
    });
  });

  describe('kill switches', () => {
    it('are managed by administrators only and take effect in validation', async () => {
      const { api, alice } = await start();
      const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      expect((await api.call(alice, 'GET', '/api/v1/admin/adapter-kill-switches')).statusCode).toBe(403);
      expect((await api.call(alice, 'POST', '/api/v1/admin/adapter-kill-switches', { adapterId: 'yt-dlp', reason: 'x' })).statusCode).toBe(403);

      const created = await api.call(api.admin, 'POST', '/api/v1/admin/adapter-kill-switches', { adapterId: 'yt-dlp', reason: 'Extraktor defekt' });
      expect(created.statusCode).toBe(201);
      expect(created.json().killSwitch).toMatchObject({ adapterId: 'yt-dlp', adapterVersion: null, sourceType: null, reason: 'Extraktor defekt' });
      expect((await api.call(api.admin, 'POST', '/api/v1/admin/adapter-kill-switches', { adapterId: 'yt-dlp', reason: 'again' })).statusCode).toBe(409);

      expect((await api.call(alice, 'POST', '/api/v1/sources/validate', { url })).json()).toMatchObject({ supported: false, code: 'ADAPTER_DISABLED' });
      expect((await api.call(alice, 'GET', '/api/v1/adapters')).json().adapters.find((a: { id: string }) => a.id === 'yt-dlp').disabledByAdministrator).toBe(true);
      // Other adapters are not affected.
      expect((await api.call(alice, 'POST', '/api/v1/sources/validate', { url: 'https://www.pixiv.net/artworks/98765' })).json().supported).toBe(true);

      const id = created.json().killSwitch.id as string;
      expect((await api.call(api.admin, 'DELETE', `/api/v1/admin/adapter-kill-switches/${id}`)).statusCode).toBe(204);
      expect((await api.call(api.admin, 'DELETE', `/api/v1/admin/adapter-kill-switches/${id}`)).statusCode).toBe(404);
      expect((await api.call(alice, 'POST', '/api/v1/sources/validate', { url })).json().supported).toBe(true);
      const audit = await api.pool.query("SELECT action FROM audit_events WHERE action LIKE 'adapter.kill_switch%' ORDER BY occurred_at");
      expect(audit.rows.map((row) => row.action)).toEqual(['adapter.kill_switch_set', 'adapter.kill_switch_lift']);
    });

    it('can be limited to a version and a source type and validates its input', async () => {
      const { api } = await start();
      for (const payload of [
        { adapterId: 'nope', reason: 'x' },
        { adapterId: 'yt-dlp' },
        { adapterId: 'yt-dlp', reason: '' },
        { adapterId: 'yt-dlp', reason: 'x'.repeat(501) },
        { adapterId: 'yt-dlp', sourceType: 'myspace', reason: 'x' },
        { adapterId: 'yt-dlp', adapterVersion: 5, reason: 'x' }
      ]) {
        expect((await api.call(api.admin, 'POST', '/api/v1/admin/adapter-kill-switches', payload)).statusCode, JSON.stringify(payload)).toBe(400);
      }
      const scoped = await api.call(api.admin, 'POST', '/api/v1/admin/adapter-kill-switches', { adapterId: 'gallery-dl', adapterVersion: '1.32.2', sourceType: 'pixiv', reason: 'nur Pixiv' });
      expect(scoped.json().killSwitch).toMatchObject({ adapterVersion: '1.32.2', sourceType: 'pixiv' });
      expect((await api.call(api.admin, 'GET', '/api/v1/admin/adapter-kill-switches')).json().killSwitches).toHaveLength(1);
    });
  });

  describe('subscriptions: validate and run now', () => {
    it('validates the stored target and records the result on the subscription', async () => {
      const { api, alice, bob } = await start();
      const good = await subscribe(api, alice, 'https://www.pixiv.net/artworks/98765');
      const bad = await subscribe(api, alice, 'https://www.youtube.com/feed/subscriptions');

      const valid = await api.call(alice, 'POST', `/api/v1/subscriptions/${good.id}/validate`);
      expect(valid.json()).toMatchObject({ targetState: 'valid', validation: { supported: true, platform: 'pixiv' } });
      const invalid = await api.call(alice, 'POST', `/api/v1/subscriptions/${bad.id}/validate`);
      expect(invalid.json()).toMatchObject({ targetState: 'invalid', validation: { supported: false, code: 'TARGET_UNSUPPORTED' } });
      expect((await api.call(alice, 'GET', `/api/v1/subscriptions/${good.id}`)).json().subscription.targetState).toBe('valid');

      // Another user's subscription is simply not found.
      expect((await api.call(bob, 'POST', `/api/v1/subscriptions/${good.id}/validate`)).statusCode).toBe(404);
      expect((await api.call(alice, 'POST', '/api/v1/subscriptions/not-a-uuid/validate')).statusCode).toBe(404);
    });

    it('a disabled adapter does not turn a good address into an invalid one', async () => {
      const { api, alice } = await start();
      const subscription = await subscribe(api, alice, 'https://www.pixiv.net/artworks/98765');
      await api.call(api.admin, 'POST', '/api/v1/admin/adapter-kill-switches', { adapterId: 'gallery-dl', reason: 'Wartung' });
      const result = await api.call(alice, 'POST', `/api/v1/subscriptions/${subscription.id}/validate`);
      expect(result.json()).toMatchObject({ targetState: 'unvalidated', validation: { supported: false, code: 'ADAPTER_DISABLED' } });
    });

    it('"Jetzt ausführen" queues one manual run, coalesces a second click and refuses foreign and paused subscriptions', async () => {
      const { api, alice, bob } = await start();
      const subscription = await subscribe(api, alice, 'https://media.example.test/a.jpg');

      const first = await api.call(alice, 'POST', `/api/v1/subscriptions/${subscription.id}/run-now`);
      expect(first.statusCode).toBe(202);
      expect(first.json()).toMatchObject({ coalesced: false, run: { state: 'queued', triggerKind: 'manual' } });
      const second = await api.call(alice, 'POST', `/api/v1/subscriptions/${subscription.id}/run-now`);
      expect(second.statusCode).toBe(202);
      expect(second.json()).toMatchObject({ coalesced: true, run: { id: first.json().run.id } });
      expect((await api.pool.query('SELECT 1 FROM job_runs')).rowCount).toBe(1);

      expect((await api.call(bob, 'POST', `/api/v1/subscriptions/${subscription.id}/run-now`)).statusCode).toBe(404);
      await api.call(alice, 'POST', `/api/v1/subscriptions/${(await subscribe(api, alice, 'https://media.example.test/b.jpg', 'B')).id}/pause`);
      const paused = (await api.call(alice, 'GET', '/api/v1/subscriptions')).json().subscriptions.find((s: { name: string }) => s.name === 'B');
      const refused = await api.call(alice, 'POST', `/api/v1/subscriptions/${paused.id}/run-now`);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toMatchObject({ code: 'SUBSCRIPTION_PAUSED' });
      const audit = await api.pool.query("SELECT target_id, details FROM audit_events WHERE action = 'subscription.run_now'");
      expect(audit.rows).toHaveLength(2);
      expect(JSON.stringify(audit.rows)).not.toContain('media.example.test');
    });
  });

  describe('the whole way: subscription -> Jetzt ausführen -> worker -> blob -> history -> Immich', () => {
    it('shows the finished download with its per-asset state and the Immich evidence, only to its owner', async () => {
      const { api, alice, bob, entry } = await start(true);
      const pipeline = entry.pipeline!;
      const bytes = jpeg('whole way');
      pipeline.files.serve('/pics/whole.jpg', { body: bytes, contentType: 'image/jpeg', etag: '"w"' });
      await pipeline.connectImmich(alice.userId);
      const url = pipeline.files.url('/pics/whole.jpg');

      const subscription = await subscribe(api, alice, url, 'Whole way');
      expect((await api.call(alice, 'POST', `/api/v1/subscriptions/${subscription.id}/validate`)).json().targetState).toBe('valid');
      expect((await api.call(alice, 'POST', `/api/v1/subscriptions/${subscription.id}/run-now`)).statusCode).toBe(202);
      expect((await api.call(alice, 'GET', '/api/v1/history')).json().runs).toEqual([]);

      const loop = new DownloadLoop({
        queue: pipeline.queue, executor: pipeline.executor, policies: new RuntimePolicyRepository(api.pool),
        subscriptions: pipeline.subscriptions, logger: pipeline.logger, concurrency: 1, pollIntervalMs: 20, leaseSeconds: 30, heartbeatEveryMs: 1000
      });
      entry.loop = loop;
      await loop.start();
      await vi.waitFor(async () => expect((await api.call(alice, 'GET', '/api/v1/history')).json().runs[0]?.state).toBe('stored'), { timeout: 10_000 });

      const history = (await api.call(alice, 'GET', '/api/v1/history')).json();
      expect(history.runs).toHaveLength(1);
      expect(history.runs[0]).toMatchObject({
        subscriptionName: 'Whole way', sourceUrl: url, triggerKind: 'manual', platform: 'direct_media', adapterId: 'direct-url',
        state: 'stored', postsFound: 1, postsSkipped: 0, assetsStored: 1, assetsFailed: 0, bytesStored: bytes.length, errorCode: null
      });
      expect(history.posts).toHaveLength(1);
      expect(history.posts[0]).toMatchObject({ subscriptionName: 'Whole way', platform: 'direct_media', state: 'stored', discoveryComplete: true, creatorId: '127.0.0.1' });
      expect(history.posts[0].assets).toHaveLength(1);
      expect(history.posts[0].assets[0]).toMatchObject({
        index: 0, originalName: 'whole.jpg', mediaType: 'image/jpeg', state: 'stored', byteSize: bytes.length, localOriginalRetained: true,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        handover: { state: 'verified', transferStatus: 'verified', evidence: { serverVersion: '3.2.1', byteLength: bytes.length, album: 'none' } }
      });
      // The existing transfer endpoint shows the same evidence to the owner and nothing to anybody else.
      const transferId = history.posts[0].assets[0].handover.transferId as string;
      expect((await api.call(alice, 'GET', `/api/v1/immich/transfers/${transferId}`)).json().transfer).toMatchObject({ status: 'verified', localOriginalRetained: true });
      expect((await api.call(bob, 'GET', `/api/v1/immich/transfers/${transferId}`)).statusCode).toBe(404);
      expect(JSON.stringify(history)).not.toMatch(/blob_object_id|blobObjectId/);

      // Isolation: neither another user nor an administrator sees this history.
      for (const login of [bob, api.admin]) {
        const other = (await api.call(login, 'GET', '/api/v1/history')).json();
        expect(other).toEqual({ runs: [], posts: [] });
      }
      // Filter by subscription, with the same ownership rules.
      expect((await api.call(alice, 'GET', `/api/v1/history?subscriptionId=${subscription.id}`)).json().runs).toHaveLength(1);
      expect((await api.call(alice, 'GET', `/api/v1/history?subscriptionId=${randomUUID()}`)).json()).toEqual({ runs: [], posts: [] });
      expect((await api.call(bob, 'GET', `/api/v1/history?subscriptionId=${subscription.id}`)).json()).toEqual({ runs: [], posts: [] });

      const sync = (await api.call(alice, 'GET', `/api/v1/subscriptions/${subscription.id}/sync-state`)).json().syncState;
      expect(sync).toMatchObject({ lastSeenRevisionKey: expect.stringMatching(/^h-/), checkedThrough: expect.any(String) });
      expect((await api.call(bob, 'GET', `/api/v1/subscriptions/${subscription.id}/sync-state`)).statusCode).toBe(404);
    });
  });

  describe('GET /api/v1/history', () => {
    it('validates its parameters and returns newest first', async () => {
      const { api, alice } = await start();
      const history = new HistoryRepository(api.pool);
      const subscription = await subscribe(api, alice, 'https://media.example.test/a.jpg');
      for (let index = 0; index < 3; index += 1) {
        const runId = await history.startRun({ userId: alice.userId, jobRunId: randomUUID(), leaseGeneration: 1, subscriptionId: subscription.id, subscriptionName: `Run ${index}`, sourceUrl: 'https://media.example.test/a.jpg', triggerKind: 'manual' });
        await history.updateRun(runId, { state: 'stored', finished: true });
        api.clock.advanceSeconds(60);
      }
      const response = await api.call(alice, 'GET', '/api/v1/history?limit=2');
      expect(response.json().runs).toHaveLength(2);
      for (const limit of ['0', '101', 'x', '1.5']) {
        expect((await api.call(alice, 'GET', `/api/v1/history?limit=${limit}`)).statusCode, limit).toBe(400);
      }
      expect((await api.call(alice, 'GET', '/api/v1/history?subscriptionId=nope')).statusCode).toBe(404);
      expect([401, 403]).toContain((await api.call(null, 'GET', '/api/v1/history')).statusCode);
    });

    it('survives deleting the subscription: the history stays', async () => {
      const { api, alice } = await start();
      const history = new HistoryRepository(api.pool);
      const subscription = await subscribe(api, alice, 'https://media.example.test/a.jpg', 'Doomed');
      const runId = await history.startRun({ userId: alice.userId, jobRunId: randomUUID(), leaseGeneration: 1, subscriptionId: subscription.id, subscriptionName: 'Doomed', sourceUrl: null, triggerKind: 'schedule' });
      await history.updateRun(runId, { state: 'failed', errorCode: 'X', errorMessage: 'Fehler', finished: true });

      expect((await api.call(alice, 'DELETE', `/api/v1/subscriptions/${subscription.id}`)).statusCode).toBe(204);

      const response = (await api.call(alice, 'GET', '/api/v1/history')).json();
      expect(response.runs).toMatchObject([{ subscriptionName: 'Doomed', state: 'failed', errorMessage: 'Fehler' }]);
    });
  });
});
