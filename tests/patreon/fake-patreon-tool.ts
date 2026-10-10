import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeTool, tempDir } from '../adapters/helpers.js';
import type { ExternalBinary } from '../../packages/adapters/src/index.js';

/*
 * A gallery-dl 1.32.16 stand-in for a Patreon creator (F2). It prints what the real extractor prints: for every post one
 * `[2, post]` message, and for every file of the post one `[3, url, post + file fields]` message, so the whole post
 * metadata (the content HTML, the campaign, the image map of every image) is repeated per file. With the default
 * settings of the big tests that makes a listing of about 50 MiB for 50 posts, which the old 32 MiB buffer could not
 * hold. Messages are printed one by one with a pause between posts, like a tool that waits between requests, and in
 * the format the options ask for: `-o output.jsonl=true` prints lines and never an error entry (job.py DataJob),
 * otherwise one array. Behaviour is re-read from a control file on every call, so a test can change it between runs.
 */

export interface PatreonControl {
  /** Posts in the creator's feed, newest first (index 0 is the newest). */
  posts: number;
  filesPerPost: number;
  /** Size of the content HTML of a post. It is repeated in every message of the post. */
  contentBytes?: number;
  /** 0-based indexes of posts the signed-in account may not view (Patreon prints them without files). */
  locked?: number[];
  /** Pause before each post of a stream, in milliseconds. */
  postDelayMs?: number;
  /** Writes stream output in pieces of this many bytes, so that lines are cut at odd places. */
  chunkBytes?: number;
  /** The stream ends after this many posts without any word about why (exactly what a failed extraction looks like). */
  streamEndsAfter?: { posts: number; how: 'silent' | 'crash' | 'hang' };
  /** What a request for the post after the cut-off (array format) answers: the truth (default) or a throttling error. */
  afterCutOff?: 'truth' | 'throttled';
  /** Index of a post whose messages are this many bytes each (to test the limit for one message). */
  hugePost?: { index: number; bytes: number };
  /** Makes every listing and every download fail with this stderr and exit code, without any output. */
  failure?: { stderr: string; exitCode: number };
  /** Bytes of a downloaded file are these plus a label, so that equal hashes give equal files. */
  downloadFails?: boolean;
}

export interface PatreonTool {
  binary: ExternalBinary;
  env: Record<string, string>;
  control(next: PatreonControl): Promise<void>;
  calls(): Promise<string[][]>;
  /** Bytes the tool wrote to stdout in all calls so far (it records them when a call ends normally). */
  bytesWritten(): Promise<number>;
}

export const PATREON_CREATOR_URL = 'https://www.patreon.com/cw/AIusagichan/posts';
export const PATREON_TOOL_URL = 'https://www.patreon.com/c/AIusagichan/posts';
export const FIRST_POST_ID = 9000;
export const postId = (index: number): string => String(FIRST_POST_ID + index);
export const postUrl = (index: number): string => `https://www.patreon.com/posts/${postId(index)}`;
export const hashOf = (index: number, file: number): string => (BigInt(FIRST_POST_ID + index) * 1000n + BigInt(file)).toString(16).padStart(32, '0');

const SCRIPT = String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('1.32.16'); process.exit(0); }
if (process.env.FAKE_TOOL_LOG) fs.appendFileSync(process.env.FAKE_TOOL_LOG, JSON.stringify(args) + '\n');
let control = {};
try { control = JSON.parse(fs.readFileSync(process.env.FAKE_TOOL_CONTROL, 'utf8')); } catch {}
const url = args[args.indexOf('--') + 1];
const FIRST = 9000;
const hex = (index, file) => (BigInt(FIRST + index) * 1000n + BigInt(file)).toString(16).padStart(32, '0');
let written = 0;
const record = () => { if (process.env.FAKE_TOOL_STATS) fs.appendFileSync(process.env.FAKE_TOOL_STATS, written + '\n'); };

if (control.failure) { process.stderr.write(control.failure.stderr); process.exit(control.failure.exitCode); }

function filler(bytes, seed) {
  const unit = '<p>Own test text ' + seed + ' lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>';
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

function post(index) {
  const locked = (control.locked || []).includes(index);
  const huge = control.hugePost && control.hugePost.index === index ? control.hugePost.bytes : 0;
  const id = FIRST + index;
  const day = new Date(Date.UTC(2026, 2, 30, 10) - index * 86400000);
  const date = day.toISOString().slice(0, 19).replace('T', ' ');
  const images = [];
  for (let file = 0; file < control.filesPerPost; file += 1) {
    const h = hex(index, file);
    images.push({
      download_url: 'https://c10.patreonusercontent.com/4/patreon-media/p/post/' + id + '/' + h + '/file-' + file + '.jpg?a=1&p=1',
      file_name: 'file-' + file + '.jpg',
      image_urls: { default: 'https://c10.patreonusercontent.com/a/' + h + '/default.jpg?token-time=1', original: 'https://c10.patreonusercontent.com/a/' + h + '/original.jpg?token-time=1', thumbnail: 'https://c10.patreonusercontent.com/a/' + h + '/thumb.jpg?token-time=1' },
      metadata: { dimensions: { w: 1200, h: 900 } }
    });
  }
  return {
    attachments: [], attachments_media: [],
    campaign: { name: 'Own Test Creator', url: 'https://www.patreon.com/AIusagichan', currency: 'USD', is_nsfw: false },
    category: 'patreon',
    content: locked ? null : '<p>Post ' + id + '</p>' + filler(huge || control.contentBytes || 2000, id),
    content_json_string: null,
    creator: { full_name: 'Own Test Creator', id: '55', url: 'https://www.patreon.com/AIusagichan', created: '2020-01-01T00:00:00.000+00:00', date: '2020-01-01 00:00:00' },
    current_user_can_view: !locked,
    date: date, embed: null, id: id, image: null,
    images: locked ? [] : images,
    patreon_url: '/posts/' + id, post_file: null, post_type: 'image_file', published_at: date.replace(' ', 'T') + '.000+00:00',
    subcategory: 'creator', tags: [], teaser_text: null, title: 'Own post ' + id, url: 'https://www.patreon.com/posts/' + id
  };
}

function messages(index) {
  const p = post(index);
  const out = [[2, p]];
  if (p.current_user_can_view) {
    p.images.forEach((image, file) => {
      out.push([3, image.download_url, Object.assign({}, p, { extension: 'jpg', file: image, filename: 'file-' + file, hash: hex(index, file), num: file + 1, type: 'image' })]);
    });
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const write = (text) => new Promise((resolve) => {
  written += Buffer.byteLength(text);
  const size = control.chunkBytes;
  if (!size) { process.stdout.write(text, resolve); return; }
  const buffer = Buffer.from(text);
  let at = 0;
  (function next() {
    if (at >= buffer.length) { resolve(); return; }
    process.stdout.write(buffer.subarray(at, at + size), () => { at += size; next(); });
  })();
});

async function main() {
  const feed = /\/c\/AIusagichan\/posts$/.test(url);
  const single = /\/posts\/(\d+)$/.exec(url);
  if (!feed && !single) { process.stderr.write('[gallery-dl][error] Unsupported URL ' + url); process.exit(64); }

  if (args.includes('--dump-json')) {
    const rangeAt = args.indexOf('--post-range');
    const spec = rangeAt >= 0 ? args[rangeAt + 1] : '1-' + control.posts;
    const [first, last] = spec.includes('-') ? spec.split('-').map(Number) : [Number(spec), Number(spec)];
    const indexes = [];
    if (single) indexes.push(Number(single[1]) - FIRST);
    else for (let n = first; n <= Math.min(last, control.posts); n += 1) indexes.push(n - 1);
    const jsonl = args.includes('output.jsonl=true');
    const cut = control.streamEndsAfter;

    if (jsonl) {
      let posts = 0;
      for (const index of indexes) {
        if (cut && posts >= cut.posts) {
          record();
          if (cut.how === 'silent') process.exit(0);
          if (cut.how === 'crash') { process.stderr.write('Traceback (most recent call last): boom'); process.exit(1); }
          setInterval(() => {}, 1000); return;
        }
        if (control.postDelayMs) await sleep(control.postDelayMs);
        for (const message of messages(index)) await write(JSON.stringify(message) + '\n');
        posts += 1;
      }
      record();
      process.exit(0);
    }

    // Array format: the whole listing at the end, and the error entry if the extraction failed.
    const out = [];
    for (const index of indexes) {
      if (cut && !single && control.afterCutOff === 'throttled' && index >= cut.posts) {
        out.push([-1, { error: 'HttpError', message: "'429 Too Many Requests' for 'https://www.patreon.com/api/posts'" }]);
        break;
      }
      out.push(...messages(index));
    }
    await write(JSON.stringify(out) + '\n');
    record();
    process.exit(0);
  }

  // A download: --range N picks the file of the post, -D is the target directory.
  if (control.downloadFails) { process.stderr.write('[patreon][error] HttpError: \'500 Internal Server Error\''); process.exit(4); }
  const fileNumber = Number(args[args.indexOf('--range') + 1]);
  const directory = args[args.indexOf('-D') + 1];
  if (!single || !Number.isInteger(fileNumber) || fileNumber < 1 || !directory) { process.stderr.write('bad arguments'); process.exit(64); }
  const index = Number(single[1]) - FIRST;
  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('patreon file ' + hex(index, fileNumber - 1))]);
  fs.writeFileSync(directory + '/asset.jpg', bytes);
}
main();
`;

export async function fakePatreonGalleryDl(initial: PatreonControl): Promise<PatreonTool> {
  const binary = await fakeTool(SCRIPT);
  const dir = await tempDir('kura-patreon-tool-');
  const logFile = join(dir, 'calls.jsonl');
  const controlFile = join(dir, 'control.json');
  const statsFile = join(dir, 'stats.txt');
  await writeFile(controlFile, JSON.stringify(initial));
  return {
    binary,
    env: { FAKE_TOOL_LOG: logFile, FAKE_TOOL_CONTROL: controlFile, FAKE_TOOL_STATS: statsFile },
    control: (next) => writeFile(controlFile, JSON.stringify(next)),
    calls: async () => {
      try {
        return (await readFile(logFile, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
      } catch {
        return [];
      }
    },
    bytesWritten: async () => {
      try {
        return (await readFile(statsFile, 'utf8')).trim().split('\n').filter(Boolean).reduce((sum, line) => sum + Number(line), 0);
      } catch {
        return 0;
      }
    }
  };
}

/** The calls that read the creator's feed, not a single post. */
export const feedCalls = (calls: readonly string[][]): string[][] => calls.filter((args) => args.includes('--dump-json') && args.at(-1) === PATREON_TOOL_URL);
export const streamCalls = (calls: readonly string[][]): string[][] => feedCalls(calls).filter((args) => args.includes('output.jsonl=true'));
export const optionValue = (args: readonly string[], option: string): string | undefined => {
  const at = args.indexOf(option);
  return at >= 0 ? args[at + 1] : undefined;
};
