import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  GalleryDlAdapter,
  type SourcePost
} from '../../packages/adapters/src/index.js';
import { tempDir, testWorkspace } from '../adapters/helpers.js';
import { fakeInstagramGalleryDl, type FakeInstagramTool } from '../instagram/fake-instagram-tool.js';

/*
 * Pornhub photo albums through gallery-dl. The fixtures are what the real gallery-dl 1.32.16 Pornhub extractor prints for
 * synthetic page data (fixtures/generate-pornhub-album-fixture.py): no real request was made.
 */

const jobContext = { jobId: 'job-album', leaseGeneration: 1 };
const ALBUM = 'https://www.pornhub.com/album/4242';
const fixture = async (name: string): Promise<unknown> => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as unknown;

async function setup(listings?: Record<string, unknown>): Promise<{ adapter: GalleryDlAdapter; tool: FakeInstagramTool }> {
  const tool = await fakeInstagramGalleryDl({
    listings: listings ?? {
      [ALBUM]: await fixture('pornhub-album'),
      'https://www.pornhub.com/album/4243': await fixture('pornhub-album-norights'),
      'https://www.pornhub.com/album/4244': await fixture('pornhub-album-notfound')
    }
  });
  const adapter = await GalleryDlAdapter.create({ binary: tool.binary, workRoot: await tempDir('kura-album-workroot-'), extraEnv: tool.env });
  return { adapter, tool };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

async function failureOf(promise: Promise<unknown>): Promise<AdapterError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterError);
    return error as AdapterError;
  }
  throw new Error('expected a failure');
}

describe('Pornhub photo albums (gallery-dl)', () => {
  it('lists an album as one post with one asset per photo, identified by the photo id', async () => {
    const { adapter, tool } = await setup();
    const target = adapter.validateTarget('https://www.pornhub.com/album/4242?utm_source=x');
    expect(await adapter.probe({ ...jobContext, target })).toMatchObject({ available: true, title: 'Own test album' });

    const [post] = await collect(adapter.discover({ ...jobContext, target }));
    expect(post).toMatchObject({
      adapterId: 'gallery-dl', sourceType: 'pornhub', platformPostId: '4242', canonicalUrl: ALBUM, title: 'Own test album'
    });
    const manifest = await adapter.resolveAssets(post!, { preset: 'BEST_AVAILABLE' });
    expect(manifest).toMatchObject({ discoveryComplete: true, errors: [], sourceType: 'pornhub' });
    expect(manifest.assets.map((asset) => [asset.sourceAssetId, asset.assetIndex, asset.mediaType, asset.originalName])).toEqual([
      ['photo-111', 0, 'image/jpeg', '111_large.jpg'],
      ['photo-222', 1, 'image/jpeg', '222_large.jpg'],
      ['photo-333', 2, 'image/png', '333_large.png']
    ]);

    // The listing call: Kura's pacing, no configuration files, no login of any kind, the address after "--".
    const [listing] = await tool.calls().then((all) => all.filter((args) => args.includes('--dump-json')));
    expect(listing).toEqual([
      '--config-ignore', '--dump-json', '--sleep-request', '2-4', '--sleep-extractor', '2-4', '--retries', '0', '--', ALBUM
    ]);
  });

  it('downloads one photo by its position and passes no cookies, even if cookies exist', async () => {
    const { adapter, tool } = await setup();
    const credentials = { cookiesFilePath: '/run/kura/private/cookies.txt' };
    const target = adapter.validateTarget(ALBUM);
    const [post] = await collect(adapter.discover({ ...jobContext, target, credentials }));
    const manifest = await adapter.resolveAssets(post!, { preset: 'BEST_AVAILABLE' }, { credentials });
    const staged = await adapter.stage!(manifest.assets[1]!, {
      ...jobContext, post: post as SourcePost, policy: { preset: 'BEST_AVAILABLE' }, limits: { maxBytes: 1024 * 1024 }, workspace: await testWorkspace(), credentials
    });
    expect(staged).toMatchObject({ assetIndex: 1, mediaType: 'image/jpeg' });

    for (const args of await tool.calls()) {
      expect(args).not.toContain('-C');
      expect(args).not.toContain('-c');
      expect(args.join(' ')).not.toContain('cookies');
    }
    const download = (await tool.calls()).find((args) => args.includes('--range'))!;
    expect(download[download.indexOf('--range') + 1]).toBe('2');
    expect(download.slice(-2)).toEqual(['--', ALBUM]);
    expect(download).toEqual(expect.arrayContaining(['--sleep', '1-3', '--sleep-request', '2-4', '--retries', '0']));
  });

  it('maps an album without rights to AUTH_REQUIRED with a Pornhub sentence, and a missing album to TARGET_NOT_FOUND', async () => {
    const { adapter } = await setup();
    const hidden = await failureOf(collect(adapter.discover({ ...jobContext, target: adapter.validateTarget('https://www.pornhub.com/album/4243') })));
    expect(hidden.code).toBe('AUTH_REQUIRED');
    expect(hidden.userMessage).toMatch(/Pornhub-Album ist nicht öffentlich zugänglich/);

    const missing = await failureOf(collect(adapter.discover({ ...jobContext, target: adapter.validateTarget('https://www.pornhub.com/album/4244') })));
    expect(missing.code).toBe('TARGET_NOT_FOUND');
    expect(missing.userMessage).toMatch(/Pornhub-Album wurde nicht gefunden/);
  });

  it('refuses files that belong to another album than the one asked for', async () => {
    const swapped = JSON.parse(JSON.stringify(await fixture('pornhub-album')).replace(/"id":4242/g, '"id":9999')) as unknown;
    const { adapter } = await setup({ [ALBUM]: swapped });
    const error = await failureOf(collect(adapter.discover({ ...jobContext, target: adapter.validateTarget(ALBUM) })));
    expect(error.code).toBe('OUTPUT_INVALID');
  });
});
