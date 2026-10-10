import { describe, expect, it } from 'vitest';
import { AdapterError, GalleryDlAdapter, type SourcePost } from '../../packages/adapters/src/index.js';
import { tempDir } from '../adapters/helpers.js';
import {
  fakePatreonGalleryDl, feedCalls, hashOf, optionValue, PATREON_CREATOR_URL, postId, type PatreonControl, type PatreonTool
} from './fake-patreon-tool.js';

/*
 * F2: a creator feed of tens of megabytes is read message by message. The listing is made like the real one (the whole
 * post metadata again for every file), more than 40 MiB for 50 posts, and printed slowly in odd pieces.
 */

const jobContext = { jobId: 'job-patreon', leaseGeneration: 1 };
const MiB = 1024 * 1024;

async function setup(control: PatreonControl, options: { feedListingIdleTimeoutMs?: number; patreonMaxPostsPerRun?: number } = {}) {
  const tool = await fakePatreonGalleryDl(control);
  const adapter = await GalleryDlAdapter.create({ binary: tool.binary, workRoot: await tempDir('kura-patreon-work-'), extraEnv: tool.env, ...options });
  return { adapter, tool };
}

/** Reads the feed to its end, or to the failure; the posts delivered before a failure are kept. */
async function discover(adapter: GalleryDlAdapter, knownPostIds?: ReadonlySet<string>): Promise<{ posts: SourcePost[]; error?: AdapterError }> {
  const posts: SourcePost[] = [];
  try {
    for await (const post of adapter.discover({ ...jobContext, target: adapter.validateTarget(PATREON_CREATOR_URL), ...(knownPostIds ? { knownPostIds } : {}) })) posts.push(post);
    return { posts };
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterError);
    return { posts, error: error as AdapterError };
  }
}

const ids = (posts: readonly SourcePost[]): string[] => posts.map((post) => post.platformPostId);
const firstPostIds = (count: number): string[] => Array.from({ length: count }, (_unused, index) => postId(index));

describe('a Patreon creator feed of more than 40 MiB', () => {
  const big: PatreonControl = { posts: 50, filesPerPost: 8, contentBytes: 110 * 1024, postDelayMs: 5, chunkBytes: 40_000 };

  it('is read completely, one message at a time, and the memory stays small', async () => {
    const { adapter, tool } = await setup(big);

    // The memory the process holds on top of what it held before: heap and buffers, sampled while the feed is read.
    // Holding the listing would take more than the listing (40 MiB as text, and then the parsed copy).
    const held = () => process.memoryUsage().heapUsed + process.memoryUsage().external;
    const before = held();
    let peak = 0;
    const sampler = setInterval(() => { peak = Math.max(peak, held() - before); }, 5);
    let result: Awaited<ReturnType<typeof discover>>;
    try {
      result = await discover(adapter);
    } finally {
      clearInterval(sampler);
    }

    expect(result.error).toBeUndefined();
    expect(ids(result.posts)).toEqual(firstPostIds(50));
    expect(result.posts[0]).toMatchObject({
      sourceType: 'patreon', title: 'Own post 9000', canonicalUrl: 'https://www.patreon.com/posts/9000', creator: { platformId: '55', displayName: 'Own Test Creator' }
    });
    const written = await tool.bytesWritten();
    expect(written, 'the listing has to be bigger than the old buffer of 32 MiB and than 40 MiB').toBeGreaterThan(40 * MiB);
    expect(peak, `peak ${(peak / MiB).toFixed(1)} MiB for a listing of ${(written / MiB).toFixed(1)} MiB`).toBeLessThan(written / 2);
    expect(peak).toBeLessThan(80 * MiB);
  }, 120_000);

  it('asks for the feed with line output and a bound, once, and checks nothing when the bound was reached', async () => {
    const { adapter, tool } = await setup({ posts: 50, filesPerPost: 1, contentBytes: 1000 });
    await discover(adapter);
    const calls = feedCalls(await tool.calls());
    expect(calls).toHaveLength(1);
    expect(optionValue(calls[0]!, '-o')).toBe('output.jsonl=true');
    expect(optionValue(calls[0]!, '--post-range')).toBe('1-50');
  });

  it('takes the id of a file from the hash in its address, so the key of a post does not depend on anything else', async () => {
    const { adapter } = await setup({ posts: 3, filesPerPost: 2, contentBytes: 1000 });
    const first = await discover(adapter);
    const again = await discover(adapter);
    expect(again.posts.map((post) => post.revisionKey)).toEqual(first.posts.map((post) => post.revisionKey));
    expect(hashOf(0, 0)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('stops the tool as soon as the posts read so far end in archived ones (and never before 12 posts)', async () => {
    const { adapter, tool } = await setup(big);
    const known = new Set(firstPostIds(50));

    const result = await discover(adapter, known);

    expect(result.error).toBeUndefined();
    expect(ids(result.posts)).toEqual(firstPostIds(12));
    // The tool was stopped: it did not print its 50 posts (it records its bytes only when it ends by itself).
    expect(await tool.bytesWritten()).toBe(0);
    expect(feedCalls(await tool.calls()).map((args) => optionValue(args, '--post-range'))).toEqual(['1-50']);
  }, 60_000);

  it('does not stop at archived posts that are followed by newer ones', async () => {
    const { adapter } = await setup({ posts: 30, filesPerPost: 1, contentBytes: 1000 });
    // Only the oldest 20 are archived; the newest 10 are new.
    const known = new Set(Array.from({ length: 20 }, (_unused, index) => postId(10 + index)));
    const result = await discover(adapter, known);
    expect(ids(result.posts).slice(0, 10)).toEqual(firstPostIds(10));
    // 10 new posts, then known posts: the stream stops once 12 posts were read and the last ones are known.
    expect(result.posts.length).toBeGreaterThanOrEqual(13);
  });

  it('cuts a listing at the configured bound', async () => {
    const { adapter, tool } = await setup({ posts: 50, filesPerPost: 1, contentBytes: 1000 }, { patreonMaxPostsPerRun: 7 });
    const result = await discover(adapter);
    expect(ids(result.posts)).toEqual(firstPostIds(7));
    expect(optionValue(feedCalls(await tool.calls())[0]!, '--post-range')).toBe('1-7');
  });

  it('reads a feed that has fewer posts than the bound, and then checks once that the feed really ended', async () => {
    const { adapter, tool } = await setup({ posts: 9, filesPerPost: 2, contentBytes: 1000 });
    const result = await discover(adapter);

    expect(result.error).toBeUndefined();
    expect(ids(result.posts)).toEqual(firstPostIds(9));
    const calls = feedCalls(await tool.calls());
    expect(calls.map((args) => [args.includes('output.jsonl=true'), optionValue(args, '--post-range')])).toEqual([[true, '1-50'], [false, '10']]);
    // The check asks for no file names of the posts it skips.
    expect(calls[1]).toContain('extractor.patreon.files=[]');
    expect(calls[0]).not.toContain('extractor.patreon.files=[]');
  });
});

describe('a listing that ends without saying why', () => {
  const control: PatreonControl = { posts: 30, filesPerPost: 2, contentBytes: 2000 };

  it('keeps the posts read before the end and fails with a retry and a message naming Patreon', async () => {
    const { adapter, tool } = await setup({ ...control, streamEndsAfter: { posts: 11, how: 'silent' } });

    const { posts, error } = await discover(adapter);

    expect(ids(posts)).toEqual(firstPostIds(11));
    expect(error).toMatchObject({ code: 'NETWORK_FAILED' });
    expect(error!.userMessage).toMatch(/Patreon.*unvollständig.*erneut/s);
    // The check asked for post 12 and found it.
    expect(optionValue(feedCalls(await tool.calls()).at(-1)!, '--post-range')).toBe('12');
  });

  it('is the throttling that it was, when the check meets the error entry', async () => {
    const { adapter } = await setup({ ...control, streamEndsAfter: { posts: 5, how: 'silent' }, afterCutOff: 'throttled' });
    const { posts, error } = await discover(adapter);
    expect(ids(posts)).toEqual(firstPostIds(5));
    expect(error).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('fails with the tool\'s own failure when the process crashed', async () => {
    const { adapter } = await setup({ ...control, streamEndsAfter: { posts: 4, how: 'crash' } });
    const { posts, error } = await discover(adapter);
    // The fourth post was being printed when the tool died: its list of files cannot be trusted, so it is not taken.
    expect(ids(posts)).toEqual(firstPostIds(3));
    expect(error).toMatchObject({ code: 'PROCESS_FAILED' });
  });

  it('gives up on a tool that goes quiet, after the posts it printed, with a message naming Patreon', async () => {
    const { adapter } = await setup({ ...control, streamEndsAfter: { posts: 6, how: 'hang' } }, { feedListingIdleTimeoutMs: 1_500 });
    const { posts, error } = await discover(adapter);
    // The sixth post was being printed when the tool went quiet; it is complete only when the next one begins.
    expect(ids(posts)).toEqual(firstPostIds(5));
    expect(error).toMatchObject({ code: 'PROCESS_TIMEOUT' });
    expect(error!.userMessage).toMatch(/Patreon hat nicht rechtzeitig geantwortet.*erneut/s);
  }, 30_000);

  it('does not mistake a feed that really ended for a failure', async () => {
    const { adapter } = await setup({ posts: 11, filesPerPost: 1, contentBytes: 1000 });
    const { posts, error } = await discover(adapter);
    expect(error).toBeUndefined();
    expect(posts).toHaveLength(11);
  });
});

describe('a message over the size limit', () => {
  it('is dropped without being held, the other posts arrive, and the run is told that a post could not be read', async () => {
    // Post 3 is 9 MiB per message, over the 8 MiB limit of one message.
    const { adapter } = await setup({ posts: 8, filesPerPost: 1, contentBytes: 1000, hugePost: { index: 3, bytes: 9 * MiB } });
    const { posts, error } = await discover(adapter);

    expect(ids(posts)).toEqual(['9000', '9001', '9002', '9004', '9005', '9006', '9007']);
    expect(error).toMatchObject({ code: 'PROCESS_OUTPUT_LIMIT' });
    expect(error!.userMessage).toMatch(/Patreon.*zu groß/);
  }, 60_000);
});

describe('failures of the tool before any post', () => {
  const failing = (tool: PatreonTool) => tool.control({ posts: 5, filesPerPost: 1, failure: { stderr: "[patreon][error] HttpError: '429 Too Many Requests' for 'https://www.patreon.com/api/posts'", exitCode: 4 } });

  it('name what happened (throttling) and are not taken for an empty feed', async () => {
    const { adapter, tool } = await setup({ posts: 5, filesPerPost: 1 });
    await failing(tool);
    const { posts, error } = await discover(adapter);
    expect(posts).toEqual([]);
    expect(error).toMatchObject({ code: 'RATE_LIMITED' });
  });
});
