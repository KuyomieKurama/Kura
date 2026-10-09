import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GalleryDlAdapter, type RunCredentials, type SourcePost } from '../../packages/adapters/src/index.js';
import { pixivListing } from '../adapters/fake-tools.js';
import { tempDir, testWorkspace } from '../adapters/helpers.js';
import { fakeInstagramGalleryDl, fixture, INSTAGRAM_ROOT, type FakeInstagramTool } from './fake-instagram-tool.js';

const jobContext = { jobId: 'job-ig', leaseGeneration: 1 };
const POST = `${INSTAGRAM_ROOT}/p/DCarous0001/`;
const PROFILE_TOOL_URL = `${INSTAGRAM_ROOT}/own_test_account/posts/`;
const COOKIE_SECRET = 'sessionid=SECRET-SESSION-VALUE-9f3a';

interface Setup { adapter: GalleryDlAdapter; tool: FakeInstagramTool }

async function setup(): Promise<Setup> {
  const tool = await fakeInstagramGalleryDl({
    listings: {
      [POST]: await fixture('post-carousel'),
      [PROFILE_TOOL_URL]: await fixture('profile-posts'),
      'https://www.pixiv.net/artworks/98765': pixivListing(2)
    }
  });
  const adapter = await GalleryDlAdapter.create({ binary: tool.binary, workRoot: await tempDir('kura-ig-workroot-'), extraEnv: tool.env });
  return { adapter, tool };
}

/** The part of an argument list before the `--` separator. */
const options = (args: string[]): string[] => args.slice(0, args.indexOf('--'));

describe('cookies file of a run (interface for the per-user cookies of slice B)', () => {
  it('is passed with -C to every call for an Instagram target and cookies-update is switched off', async () => {
    const { adapter, tool } = await setup();
    // The file does not even exist: whoever passes the path, the adapter must not touch it.
    const credentials: RunCredentials = { cookiesFilePath: '/run/kura/runs/job-ig/private/cookies.txt' };

    await adapter.probe({ ...jobContext, target: adapter.validateTarget(POST), credentials });
    const [post] = await collect(adapter.discover({ ...jobContext, target: adapter.validateTarget(POST), credentials }));
    const manifest = await adapter.resolveAssets(post!, { preset: 'BEST_AVAILABLE' }, { credentials });
    await adapter.stage(manifest.assets[1]!, {
      ...jobContext, post: post!, policy: { preset: 'BEST_AVAILABLE' }, limits: { maxBytes: 1024 * 1024 }, workspace: await testWorkspace(), credentials
    });
    await collect(adapter.discover({ ...jobContext, target: adapter.validateTarget('https://www.instagram.com/own_test_account/'), credentials }));

    const calls = (await tool.calls()).filter((args) => !args.includes('--version'));
    expect(calls).toHaveLength(5);
    for (const args of calls) {
      const before = options(args);
      const at = before.indexOf('-C');
      expect(at, JSON.stringify(args)).toBeGreaterThanOrEqual(0);
      expect(before[at + 1]).toBe('/run/kura/runs/job-ig/private/cookies.txt');
      expect(before).toContain('extractor.instagram.cookies-update=false');
      // The path is never the last element, so it can only be read as the value of -C.
      expect(args.slice(-2)[0]).toBe('--');
    }
  });

  it('passes nothing without credentials and nothing to other platforms', async () => {
    const { adapter, tool } = await setup();
    await collect(adapter.discover({ ...jobContext, target: adapter.validateTarget(POST) }));
    await collect(adapter.discover({ ...jobContext, target: adapter.validateTarget('https://www.pixiv.net/artworks/98765'), credentials: { cookiesFilePath: '/run/cookies.txt' } }));
    for (const args of (await tool.calls()).filter((call) => !call.includes('--version'))) {
      expect(args).not.toContain('-C');
      expect(args.join(' ')).not.toContain('cookies');
    }
  });

  it('neither reads the file nor lets its path or content reach the environment, results or logs of the run', async () => {
    const { adapter, tool } = await setup();
    const directory = await tempDir('kura-ig-private-');
    const cookiesFilePath = join(directory, 'cookies.txt');
    await writeFile(cookiesFilePath, `# Netscape HTTP Cookie File\n.instagram.com\tTRUE\t/\tTRUE\t0\t${COOKIE_SECRET}\n`, { mode: 0o600 });
    await chmod(cookiesFilePath, 0o600);
    const credentials = { cookiesFilePath };

    const posts = await collect(adapter.discover({ ...jobContext, target: adapter.validateTarget(POST), credentials }));
    const manifest = await adapter.resolveAssets(posts[0]!, { preset: 'BEST_AVAILABLE' }, { credentials });
    const staged = await adapter.stage(manifest.assets[0]!, {
      ...jobContext, post: posts[0]!, policy: { preset: 'BEST_AVAILABLE' }, limits: { maxBytes: 1024 * 1024 }, workspace: await testWorkspace(), credentials
    });

    // The path appears in the argument list only (the tool needs it there) ...
    expect((await tool.calls()).some((args) => args.includes(cookiesFilePath))).toBe(true);
    // ... never in the process environment of the tool ...
    expect(JSON.stringify(await tool.environments())).not.toContain(cookiesFilePath);
    expect(JSON.stringify(await tool.environments())).not.toContain('SECRET-SESSION-VALUE');
    // ... and nothing the adapter returns mentions the path or the content.
    const returned = JSON.stringify({ posts, manifest, staged });
    expect(returned).not.toContain(cookiesFilePath);
    expect(returned).not.toContain('SECRET-SESSION-VALUE');
  });

  it('keeps the path out of the error when a run fails', async () => {
    const tool = await fakeInstagramGalleryDl({ listings: { [POST]: [[-1, { error: 'HttpError', message: "'403 Forbidden' for 'https://www.instagram.com/api/'" }]] } });
    const adapter = await GalleryDlAdapter.create({ binary: tool.binary, workRoot: await tempDir(), extraEnv: tool.env });
    const cookiesFilePath = '/run/kura/runs/job-ig/private/cookies.txt';
    const error = await collect(adapter.discover({ ...jobContext, target: adapter.validateTarget(POST), credentials: { cookiesFilePath } })).catch((caught: Error) => caught);
    expect(error).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(JSON.stringify({ message: (error as Error).message, userMessage: (error as { userMessage?: string }).userMessage })).not.toContain(cookiesFilePath);
  });

  it.each([
    ['a relative path', 'cookies.txt'],
    ['a path that looks like an option', '-o'],
    ['an empty path', ''],
    ['a path with a line break', '/run/kura/cookies.txt\n--exec=id'],
    ['a path with a NUL byte', '/run/kura/cookies\u0000.txt'],
    ['a very long path', `/${'a'.repeat(5_000)}`]
  ])('refuses %s and starts no process', async (_name, cookiesFilePath) => {
    const { adapter, tool } = await setup();
    const before = (await tool.calls()).length;
    const error = await collect(adapter.discover({ ...jobContext, target: adapter.validateTarget(POST), credentials: { cookiesFilePath } })).catch((caught: Error) => caught);
    expect(error).toMatchObject({ code: 'PROCESS_SPAWN_FAILED' });
    expect((await tool.calls()).length).toBe(before);
  });
});

async function collect(iterable: AsyncIterable<SourcePost>): Promise<SourcePost[]> {
  const items: SourcePost[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
