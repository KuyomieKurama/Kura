import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { credentialAad, type CredentialPlatform } from '../../packages/adapters/src/index.js';
import { encryptSecret } from '../../apps/api/src/immich-routes.js';
import { JobExecutor } from '../../apps/worker/src/executor.js';
import { CREDENTIAL_MESSAGES } from '../../apps/worker/src/credentials.js';
import { createPipelineFixture, type PipelineFixture } from '../m5b/fixture.js';
import type { ControllableTool } from '../m5b/tools.js';
import { withCookieProbe, type CookieProbeTool } from '../instagram/cookie-probe-tool.js';
import { fakeInstagramGalleryDl, type InstagramToolControl } from '../instagram/fake-instagram-tool.js';
import { FAKE_PATREON_SESSION, FAKE_PIXIV_TOKEN, patreonCookieFile } from './credential-samples.js';

const PATREON = 'https://www.patreon.com';
const PIXIV = 'https://www.pixiv.net';
const PATREON_CREATOR = `${PATREON}/owntestcreator`;
const PATREON_TOOL_URL = `${PATREON}/c/owntestcreator/posts`;
const PIXIV_ARTIST = `${PIXIV}/users/4242`;
const PIXIV_TOOL_URL = `${PIXIV}/users/4242/artworks`;
const errorEntry = (error: string, message: string): unknown[] => [[-1, { error, message }]];
const PATREON_FORBIDDEN = errorEntry('HttpError', "'403 Forbidden' for 'https://www.patreon.com/api/posts'");
const PIXIV_NO_TOKEN = errorEntry('AuthenticationError', "'refresh-token' required.\nRun `gallery-dl oauth:pixiv` to get one.");
const PIXIV_REVOKED = errorEntry('AuthenticationError', 'Invalid refresh token');

describe('stored logins of Patreon and Pixiv in the worker (fake gallery-dl, real PostgreSQL, no network)', () => {
  const open: PipelineFixture[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((subject) => subject.cleanup()));
  });

  async function start(control: InstagramToolControl) {
    const inner = await fakeInstagramGalleryDl(control);
    const probe: CookieProbeTool = await withCookieProbe(inner);
    const subject = await createPipelineFixture({ tools: { galleryDl: probe as unknown as ControllableTool } });
    open.push(subject);
    const executor = new JobExecutor({
      pool: subject.pool, queue: subject.queue, subscriptions: subject.subscriptions, history: subject.history, blobstore: subject.blobstore,
      catalog: subject.catalog, handover: subject.handover, clock: subject.clock, logger: subject.logger, workDir: subject.workDir,
      maxAssetBytes: 10 * 1024 * 1024, secretKey: subject.secretKey
    });
    const runOnce = async (userId: string, subscriptionId: string) => executor.execute(await subject.queueAndClaim(userId, subscriptionId), new AbortController().signal);
    return { subject, inner, probe, runOnce };
  }

  /** Stores a login the way the API does (same crypto, additional authenticated data of the platform). */
  async function store(subject: PipelineFixture, userId: string, platform: CredentialPlatform, secret: string, key: Buffer = subject.secretKey) {
    const encrypted = encryptSecret(key, secret, credentialAad(platform, userId));
    await subject.pool.query(
      `INSERT INTO platform_credentials (id, user_id, platform, cookies_ciphertext, cookies_nonce, cookie_count, earliest_expiry, kind)
       VALUES ($1, $2, $3, $4, $5, 1, NULL, $6)`,
      [randomUUID(), userId, platform, encrypted.ciphertext, encrypted.nonce, platform === 'pixiv' ? 'token' : 'cookies']
    );
  }

  const credentialRow = async (subject: PipelineFixture, userId: string, platform: string) =>
    (await subject.rows<{ last_used_at: Date | null; last_result: string }>('SELECT last_used_at, last_result FROM platform_credentials WHERE user_id = $1 AND platform = $2', [userId, platform]))[0]!;

  async function expectNothingLeft(subject: PipelineFixture, observations: Array<{ path?: string }>) {
    for (const observation of observations) if (observation.path) expect(existsSync(observation.path)).toBe(false);
    expect((await readdir(subject.workDir)).filter((name) => name.startsWith('run-'))).toEqual([]);
  }

  it('hands the Patreon cookies to gallery-dl as a 0600 file and deletes it afterwards', async () => {
    const { subject, probe, runOnce } = await start({ listings: { [PATREON_TOOL_URL]: PATREON_FORBIDDEN } });
    const userId = await subject.newUser();
    const cookies = patreonCookieFile();
    await store(subject, userId, 'patreon', cookies);
    const subscription = await subject.subscribe(userId, PATREON_CREATOR);

    const outcome = await runOnce(userId, subscription.id);

    const observations = await probe.observations();
    expect(observations.length).toBeGreaterThan(0);
    for (const observation of observations) expect(observation).toMatchObject({ cookies: true, mode: '600', directoryMode: '700', content: cookies });
    await expectNothingLeft(subject, observations);
    // A refused session: "expired", worded for Patreon, and the stored login is marked.
    expect(outcome).toMatchObject({ result: 'problem', disposition: { runState: 'waiting_auth', code: 'AUTH_REQUIRED', pauseSubscription: true } });
    expect(await subject.rows('SELECT error_message FROM download_runs')).toEqual([{ error_message: CREDENTIAL_MESSAGES.patreon.expired }]);
    expect((await credentialRow(subject, userId, 'patreon')).last_result).toBe('auth_required');
    expect(JSON.stringify(subject.logs)).not.toContain(FAKE_PATREON_SESSION);
  });

  it('without a stored Patreon login says that cookies are missing and starts without -C', async () => {
    const { subject, probe, runOnce } = await start({ listings: { [PATREON_TOOL_URL]: PATREON_FORBIDDEN } });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, PATREON_CREATOR);

    await runOnce(userId, subscription.id);

    expect((await probe.observations()).every((observation) => !observation.cookies)).toBe(true);
    expect(await subject.rows('SELECT error_message FROM download_runs')).toEqual([{ error_message: CREDENTIAL_MESSAGES.patreon.missing }]);
  });

  it('writes the Pixiv token only into a 0600 configuration file and never into an argument', async () => {
    const { subject, inner, probe, runOnce } = await start({ listings: { [PIXIV_TOOL_URL]: PIXIV_REVOKED } });
    const userId = await subject.newUser();
    await store(subject, userId, 'pixiv', FAKE_PIXIV_TOKEN);
    const subscription = await subject.subscribe(userId, PIXIV_ARTIST);

    const outcome = await runOnce(userId, subscription.id);

    const observations = await probe.observations();
    expect(observations.length).toBeGreaterThan(0);
    for (const observation of observations) {
      expect(observation).toMatchObject({ cookies: true, mode: '600', directoryMode: '700' });
      const configuration = JSON.parse(observation.content!) as { extractor: { pixiv: Record<string, string> }; cache: { file: string } };
      expect(configuration.extractor.pixiv['refresh-token']).toBe(FAKE_PIXIV_TOKEN);
      // The access token that gallery-dl gets lives next to the config, in the private directory, not in a shared cache.
      expect(configuration.cache.file.startsWith(observation.path!.replace(/\/gallery-dl\.conf$/, '/'))).toBe(true);
    }
    expect(JSON.stringify(await inner.calls())).not.toContain(FAKE_PIXIV_TOKEN);
    await expectNothingLeft(subject, observations);

    expect(outcome).toMatchObject({ result: 'problem', disposition: { code: 'AUTH_REQUIRED', pauseSubscription: true } });
    expect(await subject.rows('SELECT error_message FROM download_runs')).toEqual([{ error_message: CREDENTIAL_MESSAGES.pixiv.expired }]);
    expect((await credentialRow(subject, userId, 'pixiv')).last_result).toBe('auth_required');
    expect(JSON.stringify(subject.logs)).not.toContain(FAKE_PIXIV_TOKEN);
    expect(JSON.stringify(await subject.rows('SELECT * FROM download_runs'))).not.toContain(FAKE_PIXIV_TOKEN);
  });

  it('without a Pixiv token tells the user to create one', async () => {
    const { subject, probe, runOnce } = await start({ listings: { [PIXIV_TOOL_URL]: PIXIV_NO_TOKEN } });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, PIXIV_ARTIST);

    await runOnce(userId, subscription.id);

    expect((await probe.observations()).every((observation) => !observation.cookies)).toBe(true);
    expect(await subject.rows('SELECT error_message FROM download_runs')).toEqual([{ error_message: CREDENTIAL_MESSAGES.pixiv.missing }]);
    expect(CREDENTIAL_MESSAGES.pixiv.missing).toContain('gallery-dl oauth:pixiv');
  });

  it('does not start the tool when the Pixiv token cannot be decrypted', async () => {
    const { subject, probe, runOnce } = await start({ listings: {} });
    const userId = await subject.newUser();
    await store(subject, userId, 'pixiv', FAKE_PIXIV_TOKEN, randomBytes(32));
    const subscription = await subject.subscribe(userId, PIXIV_ARTIST);

    const outcome = await runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', disposition: { code: 'CREDENTIALS_UNREADABLE', pauseSubscription: true } });
    expect(await subject.rows('SELECT error_message FROM download_runs')).toEqual([{ error_message: CREDENTIAL_MESSAGES.pixiv.unreadable }]);
    expect(await probe.observations()).toEqual([]);
  });

  it('never gives the login of one platform to another and never the login of another user', async () => {
    const { subject, probe, runOnce } = await start({ listings: { [PATREON_TOOL_URL]: PATREON_FORBIDDEN } });
    const alice = await subject.newUser('Alice');
    const bob = await subject.newUser('Bob');
    await store(subject, alice, 'patreon', patreonCookieFile());
    await store(subject, bob, 'pixiv', FAKE_PIXIV_TOKEN);
    const subscription = await subject.subscribe(bob, PATREON_CREATOR);

    await runOnce(bob, subscription.id);

    expect((await probe.observations()).every((observation) => !observation.cookies)).toBe(true);
    expect(await credentialRow(subject, alice, 'patreon')).toMatchObject({ last_used_at: null, last_result: 'unknown' });
    expect(await credentialRow(subject, bob, 'pixiv')).toMatchObject({ last_used_at: null, last_result: 'unknown' });
  });

  it('keeps every wording free of dashes and in du-form', () => {
    for (const platform of Object.keys(CREDENTIAL_MESSAGES) as CredentialPlatform[]) {
      for (const message of Object.values(CREDENTIAL_MESSAGES[platform])) {
        expect(message).not.toMatch(/[—–]/);
        expect(message).toMatch(/Das Abonnement wurde pausiert\.$/);
      }
    }
  });
});

describe('assets that cannot be fetched (Patreon, fake gallery-dl, real PostgreSQL, no network)', () => {
  const open: PipelineFixture[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((subject) => subject.cleanup()));
  });

  it('records the embedded video, the locked post and the hosted stream with their reasons and stores the rest', async () => {
    const entries = JSON.parse(await readFile(new URL('./fixtures/patreon-creator.json', import.meta.url), 'utf8')) as Array<[number, ...unknown[]]>;
    // Posts 1002 (embedded video), 1003 (locked), 1004 (HLS stream) and 1005 (one jpeg); the fake writes jpeg bytes.
    const posts = new Map<string, Array<[number, ...unknown[]]>>();
    let current: Array<[number, ...unknown[]]> | undefined;
    for (const entry of entries) {
      if (entry[0] === 2) posts.set(String((entry.at(-1) as { id: number }).id), (current = []));
      current?.push(entry);
    }
    const listings: Record<string, unknown> = {
      [PATREON_TOOL_URL]: ['1002', '1003', '1004', '1005'].flatMap((id) => posts.get(id)!)
    };
    for (const id of ['1002', '1003', '1004', '1005']) listings[`${PATREON}/posts/${id}`] = posts.get(id);

    const inner = await fakeInstagramGalleryDl({ listings });
    const subject = await createPipelineFixture({ tools: { galleryDl: inner as unknown as ControllableTool } });
    open.push(subject);
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, PATREON_CREATOR);

    const first = (await subject.runOnce(userId, subscription.id)).outcome;
    expect(first).toMatchObject({ result: 'problem', disposition: { code: expect.stringMatching(/^ASSET_/) } });
    const query = `SELECT p.platform_post_id AS post, a.source_asset_id AS asset, a.state, a.error_code
                   FROM download_assets a JOIN download_posts p ON p.id = a.post_id ORDER BY p.platform_post_id`;
    const assets = await subject.rows<{ post: string; asset: string; state: string; error_code: string | null }>(query);
    expect(assets.map((asset) => [asset.post, asset.asset, asset.state, asset.error_code])).toEqual([
      ['1002', 'embed-0', 'failed', 'ASSET_UNSUPPORTED'],
      ['1003', 'locked', 'failed', 'ASSET_NOT_ACCESSIBLE'],
      ['1004', 'file-0', 'failed', 'ASSET_UNSUPPORTED'],
      ['1005', 'file-0', 'stored', null]
    ]);
    expect((await subject.rows('SELECT 1 FROM blobstore_objects')).length).toBe(1);

    // A later run repeats nothing: the records stay, nothing is downloaded again.
    subject.advance(3600);
    await subject.subscriptions.resumeSubscription(userId, subscription.id).catch(() => undefined);
    const downloadsBefore = (await inner.calls()).filter((args) => args.includes('--range')).length;
    await subject.runOnce(userId, subscription.id);
    expect((await inner.calls()).filter((args) => args.includes('--range')).length).toBe(downloadsBefore);
    expect(await subject.rows(query)).toHaveLength(4);
  });
});
