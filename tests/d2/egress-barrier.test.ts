import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AdapterCatalog, EGRESS_NOT_CONFIRMED, approveNothing } from '../../apps/worker/src/catalog.js';
import { loadDownloadConfig } from '../../apps/worker/src/config.js';
import { classifyFailure } from '../../apps/worker/src/failure.js';
import { AdapterError } from '../../packages/adapters/src/index.js';
import { createApiFixture, type ApiFixture } from '../m4b/api-fixture.js';
import { tempDir } from '../adapters/helpers.js';
import { createPipelineFixture, jpeg, type PipelineFixture } from '../m5b/fixture.js';
import { controllableGalleryDl, controllableYtDlp } from '../m5b/tools.js';

// Finding 2 of verifier V3 (risk R-09, docs/planning/04 "Externe Prozessausführung"): yt-dlp and gallery-dl have no
// network allowlist of their own (D-008), so Kura starts them only after the operator confirmed an external egress
// barrier with KURA_EXTERNAL_TOOLS_EGRESS_CONFIRMED=true. Default: closed, even with path and hash configured.

const BLOCKED_TEXT = 'Externe Werkzeuge gesperrt: Egress-Schutz nicht bestätigt';
const YOUTUBE = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const PIXIV = 'https://www.pixiv.net/artworks/98765';

const silentLogger = { info: () => undefined, error: () => undefined };

describe('configuration: KURA_EXTERNAL_TOOLS_EGRESS_CONFIRMED', () => {
  const base = { DATABASE_URL: 'postgres://h/db' };

  it('is off by default and only an explicit "true" turns it on', () => {
    expect(loadDownloadConfig(base)!.externalToolsEgressConfirmed).toBe(false);
    expect(loadDownloadConfig({ ...base, KURA_EXTERNAL_TOOLS_EGRESS_CONFIRMED: '' })!.externalToolsEgressConfirmed).toBe(false);
    expect(loadDownloadConfig({ ...base, KURA_EXTERNAL_TOOLS_EGRESS_CONFIRMED: 'false' })!.externalToolsEgressConfirmed).toBe(false);
    expect(loadDownloadConfig({ ...base, KURA_EXTERNAL_TOOLS_EGRESS_CONFIRMED: 'true' })!.externalToolsEgressConfirmed).toBe(true);
  });

  it('refuses any other value instead of guessing', () => {
    for (const value of ['1', 'yes', 'TRUE', 'on']) {
      expect(() => loadDownloadConfig({ ...base, KURA_EXTERNAL_TOOLS_EGRESS_CONFIRMED: value }), value).toThrow(/KURA_EXTERNAL_TOOLS_EGRESS_CONFIRMED must be true or false/);
    }
  });

  it('does not change anything for the tool paths: path and hash alone never enable a tool', () => {
    const hash = 'a'.repeat(64);
    const config = loadDownloadConfig({ ...base, KURA_YTDLP_PATH: '/opt/kura-tools/yt-dlp', KURA_YTDLP_SHA256: hash })!;
    expect(config.tools.ytDlp).toEqual({ path: '/opt/kura-tools/yt-dlp', sha256: hash });
    expect(config.externalToolsEgressConfirmed).toBe(false);
  });
});

function expectOnlyDirectUrl(catalog: AdapterCatalog): void {
  for (const url of [YOUTUBE, PIXIV]) {
    const candidates = catalog.registry.lookup(url).candidates.map((candidate) => candidate.adapter.capabilities().adapterId);
    expect(candidates, url).not.toContain('yt-dlp');
    expect(candidates, url).not.toContain('gallery-dl');
  }
}

describe('adapter catalog: no process without the confirmation', () => {
  async function catalogFor(options: { confirmed?: boolean | 'omitted'; configureTools?: boolean }) {
    const ytDlp = await controllableYtDlp();
    const galleryDl = await controllableGalleryDl(1);
    const configure = options.configureTools ?? true;
    const catalog = new AdapterCatalog({
      tools: configure ? { ytDlp: ytDlp.binary, galleryDl: galleryDl.binary } : {},
      ...(options.confirmed === 'omitted' || options.confirmed === undefined ? {} : { externalToolsEgressConfirmed: options.confirmed }),
      workDir: await tempDir('kura-d2-work-'),
      maxAssetBytes: 1024 * 1024,
      directUrl: { approvals: approveNothing },
      logger: silentLogger,
      toolEnvironment: { ytDlp: ytDlp.env, galleryDl: galleryDl.env }
    });
    await catalog.refresh();
    return { catalog, ytDlp, galleryDl };
  }

  const availabilityOf = (catalog: AdapterCatalog) =>
    Object.fromEntries(catalog.availability.map((entry) => [entry.adapterId, [entry.available, entry.reasonCode]]));

  it.each([['omitted' as const], [false]])('keeps both tools closed when the setting is %s, although path and hash are configured', async (confirmed) => {
    const { catalog, ytDlp, galleryDl } = await catalogFor({ confirmed });

    expect(availabilityOf(catalog)).toEqual({
      'direct-url': [true, null],
      'gallery-dl': [false, EGRESS_NOT_CONFIRMED],
      'yt-dlp': [false, EGRESS_NOT_CONFIRMED]
    });
    // The fake executables record every start, including `--version`: none happened.
    expect(await ytDlp.calls()).toEqual([]);
    expect(await galleryDl.calls()).toEqual([]);
    // The tools are not registered, so no job can be handed to them.
    expectOnlyDirectUrl(catalog);
  });

  it('starts and registers the tools once the operator confirmed the barrier', async () => {
    const { catalog, ytDlp, galleryDl } = await catalogFor({ confirmed: true });

    expect(availabilityOf(catalog)).toEqual({ 'direct-url': [true, null], 'gallery-dl': [true, null], 'yt-dlp': [true, null] });
    expect((await ytDlp.calls()).length).toBeGreaterThan(0);
    expect((await galleryDl.calls()).length).toBeGreaterThan(0);
  });

  it('keeps reporting "not installed" for a tool that is not configured at all', async () => {
    const { catalog } = await catalogFor({ confirmed: false, configureTools: false });
    expect(availabilityOf(catalog)).toMatchObject({ 'gallery-dl': [false, 'BINARY_NOT_CONFIGURED'], 'yt-dlp': [false, 'BINARY_NOT_CONFIGURED'] });
  });

  it('leaves the direct URL adapter alone', async () => {
    const { catalog } = await catalogFor({ confirmed: false });
    expectOnlyDirectUrl(catalog);
    expect(catalog.registry.select('https://media.example.test/pic.jpg').adapter.capabilities().adapterId).toBe('direct-url');
  });

  it('tells the operator once in the log, not on every check', async () => {
    const lines: string[] = [];
    const catalog = new AdapterCatalog({
      tools: { ytDlp: { path: '/opt/x/yt-dlp', sha256: 'a'.repeat(64) }, galleryDl: { path: '/opt/x/gallery-dl', sha256: 'a'.repeat(64) } },
      workDir: '/nonexistent',
      maxAssetBytes: 1,
      directUrl: { approvals: approveNothing },
      logger: { info: (message) => lines.push(message), error: (message) => lines.push(`error: ${message}`) }
    });
    await catalog.refresh();
    await catalog.refresh();
    expect(lines).toEqual(['external tools blocked: egress protection not confirmed (KURA_EXTERNAL_TOOLS_EGRESS_CONFIRMED)']);
  });
});

describe('failure mapping', () => {
  it('maps the blocked tool to a stable code and a clear German text, not retried', () => {
    const disposition = classifyFailure(new AdapterError('EGRESS_NOT_CONFIRMED', 'yt-dlp is blocked'));
    expect(disposition).toMatchObject({ runState: 'failed', code: 'EGRESS_NOT_CONFIRMED', retryable: false });
    expect(disposition.message.startsWith(BLOCKED_TEXT)).toBe(true);
  });
});

describe('download pipeline (real PostgreSQL, fake tools)', () => {
  const open: PipelineFixture[] = [];
  const start = async (...args: Parameters<typeof createPipelineFixture>) => {
    const subject = await createPipelineFixture(...args);
    open.push(subject);
    return subject;
  };
  afterEach(async () => {
    await Promise.all(open.splice(0).map((subject) => subject.cleanup()));
  });

  it.each([
    ['yt-dlp', YOUTUBE],
    ['gallery-dl', PIXIV]
  ])('fails a %s job with EGRESS_NOT_CONFIRMED and never starts the tool', async (_adapter, url) => {
    const ytDlp = await controllableYtDlp();
    const galleryDl = await controllableGalleryDl(2);
    const subject = await start({ tools: { ytDlp, galleryDl }, externalToolsEgressConfirmed: false });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, url);

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', queue: 'failed', disposition: { code: 'EGRESS_NOT_CONFIRMED', runState: 'failed', retryable: false } });
    expect(await subject.rows('SELECT state, error_code, error_message FROM download_runs')).toEqual([
      expect.objectContaining({ state: 'failed', error_code: 'EGRESS_NOT_CONFIRMED', error_message: expect.stringContaining(BLOCKED_TEXT) })
    ]);
    expect(await subject.rows('SELECT 1 FROM blobstore_objects')).toEqual([]);
    // Nothing was started: neither the listing, nor a download, nor `--version`.
    expect(await ytDlp.calls()).toEqual([]);
    expect(await galleryDl.calls()).toEqual([]);
    // The address itself is fine; the subscription is not marked invalid because of the missing barrier.
    expect((await subject.subscriptions.getSubscription(userId, subscription.id)).targetState).toBe('valid');
  });

  it('still downloads a direct URL while the tools are closed', async () => {
    const ytDlp = await controllableYtDlp();
    const subject = await start({ tools: { ytDlp }, externalToolsEgressConfirmed: false });
    subject.files.serve('/pics/cat.jpg', { body: jpeg('egress'), contentType: 'image/jpeg', etag: '"e"' });
    const userId = await subject.newUser();
    await subject.connectImmich(userId);
    const subscription = await subject.subscribe(userId, subject.files.url('/pics/cat.jpg'));

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toEqual({ result: 'stored' });
    expect(await ytDlp.calls()).toEqual([]);
  });

  it('runs the same job with the tool once the barrier is confirmed', async () => {
    const ytDlp = await controllableYtDlp();
    const subject = await start({ tools: { ytDlp }, externalToolsEgressConfirmed: true });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, YOUTUBE);

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toEqual({ result: 'stored' });
    expect((await ytDlp.calls()).length).toBeGreaterThan(0);
  });
});

describe('adapter overview of the API', () => {
  const open: Array<{ api: ApiFixture; pipeline: PipelineFixture }> = [];
  afterEach(async () => {
    for (const entry of open.splice(0)) {
      await entry.pipeline.cleanup();
      await entry.api.cleanup();
    }
  });

  it('shows why the external tools are blocked, as published by the worker', async () => {
    const api = await createApiFixture();
    const alice = await api.addUser('alice');
    const ytDlp = await controllableYtDlp();
    const galleryDl = await controllableGalleryDl(1);
    const pipeline = await createPipelineFixture({ database: { pool: api.pool }, clock: api.clock, tools: { ytDlp, galleryDl }, externalToolsEgressConfirmed: false });
    open.push({ api, pipeline });

    // What the worker does at its start: check the tools and publish the result.
    await pipeline.catalog.publish(api.pool);

    const overview = (await api.call(alice, 'GET', '/api/v1/adapters')).json().adapters as Array<{ id: string; availability: string; reasonCode: string | null; message: string | null }>;
    for (const id of ['yt-dlp', 'gallery-dl']) {
      const adapter = overview.find((entry) => entry.id === id)!;
      expect(adapter).toMatchObject({ availability: 'unavailable', reasonCode: 'EGRESS_NOT_CONFIRMED' });
      expect(adapter.message!.startsWith(BLOCKED_TEXT)).toBe(true);
    }
    expect(overview.find((entry) => entry.id === 'direct-url')).toMatchObject({ availability: 'available', message: null });

    // The source check tells the user the same and marks the source as not runnable.
    const check = (await api.call(alice, 'POST', '/api/v1/sources/validate', { url: YOUTUBE })).json();
    expect(check).toMatchObject({ supported: true, runnable: false, adapter: { id: 'yt-dlp', availability: 'unavailable' } });
    expect(check.notices.join(' ')).toContain(BLOCKED_TEXT);
  });
});

describe('construction sites of the CLI adapters', () => {
  const appsDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps');

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
      if (name === 'node_modules' || name === 'dist') return [];
      const path = join(directory, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }

  it('exist only in AdapterCatalog, the one place that applies the egress confirmation', () => {
    const creators = sourceFiles(appsDirectory)
      .filter((file) => /(YtDlpAdapter|GalleryDlAdapter)\.create\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(appsDirectory, file));
    expect(creators).toEqual([join('worker', 'src', 'catalog.ts')]);
  });
});
