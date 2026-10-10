import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeTool, tempDir } from '../adapters/helpers.js';
import type { ExternalBinary } from '../../packages/adapters/src/index.js';

/*
 * A gallery-dl stand-in for the duplicate-download tests (D3). It answers like tests/instagram/fake-instagram-tool.ts
 * (the listing JSON of a URL, `--post-range 1-N`, `--range N` downloads), but the bytes of a file depend only on the
 * media id of the listing entry. The same media id therefore always gives the same file, in another post as well, which
 * is what the checksum tests need. Behaviour is re-read from a control file on every call.
 */

export interface FeedToolControl {
  /** Tool URL (the argument after `--`) -> the array `--dump-json` prints for it. */
  listings?: Record<string, unknown[]>;
  /** Makes every listing fail with this stderr and exit code, without any output. */
  listingFailure?: { stderr: string; exitCode: number };
  /** Media ids whose download fails with exit code 4. */
  failMediaIds?: string[];
}

export interface FeedTool {
  binary: ExternalBinary;
  env: Record<string, string>;
  control(next: FeedToolControl): Promise<void>;
  calls(): Promise<string[][]>;
}

const SCRIPT = String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('1.32.16'); process.exit(0); }
if (process.env.FAKE_TOOL_LOG) fs.appendFileSync(process.env.FAKE_TOOL_LOG, JSON.stringify(args) + '\n');
let control = {};
try { control = JSON.parse(fs.readFileSync(process.env.FAKE_TOOL_CONTROL, 'utf8')); } catch {}
const url = args[args.indexOf('--') + 1];
const listing = control.listings && control.listings[url];

if (args.includes('--dump-json')) {
  if (control.listingFailure) { process.stderr.write(control.listingFailure.stderr); process.exit(control.listingFailure.exitCode); }
  if (listing === undefined) { process.stderr.write('[gallery-dl][error] Unsupported URL ' + url); process.exit(64); }
  const rangeAt = args.indexOf('--post-range');
  const limit = rangeAt >= 0 ? Number(args[rangeAt + 1].split('-')[1]) : Infinity;
  const out = [];
  let posts = 0;
  for (const entry of listing) {
    if (entry[0] === 2) posts += 1;
    if (entry[0] === -1 || posts <= limit) out.push(entry);
  }
  process.stdout.write(JSON.stringify(out) + '\n', () => process.exit(0));
} else {
  const position = Number(args[args.indexOf('--range') + 1]) - 1;
  const directory = args[args.indexOf('-D') + 1];
  const files = (listing || []).filter((entry) => entry[0] === 3);
  const file = files[position];
  if (!file) { process.stderr.write('no such file'); process.exit(64); }
  if ((control.failMediaIds || []).includes(String(file[2].media_id))) { process.stderr.write('unknown error'); process.exit(4); }
  const extension = file[2].extension;
  const head = extension === 'mp4' ? Buffer.from([0, 0, 0, 0x18, ...Buffer.from('ftypmp42')]) : Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  fs.writeFileSync(directory + '/asset.' + extension, Buffer.concat([head, Buffer.from('media ' + file[2].media_id)]));
}
`;

export async function fakeFeedTool(initial: FeedToolControl = {}): Promise<FeedTool> {
  const binary = await fakeTool(SCRIPT);
  const dir = await tempDir('kura-feed-tool-');
  const logFile = join(dir, 'calls.jsonl');
  const controlFile = join(dir, 'control.json');
  await writeFile(controlFile, JSON.stringify(initial));
  return {
    binary,
    env: { FAKE_TOOL_LOG: logFile, FAKE_TOOL_CONTROL: controlFile },
    control: (next) => writeFile(controlFile, JSON.stringify(next)),
    calls: async () => {
      try {
        return (await readFile(logFile, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
      } catch {
        return [];
      }
    }
  };
}

// --- synthetic Instagram profiles --------------------------------------------------------------------------------

export const INSTAGRAM_ROOT = 'https://www.instagram.com';
export const PROFILE = `${INSTAGRAM_ROOT}/own_test_account/`;
export const PROFILE_TOOL_URL = `${INSTAGRAM_ROOT}/own_test_account/posts/`;
export const postUrl = (code: string): string => `${INSTAGRAM_ROOT}/p/${code}/`;

export interface FeedPost {
  code: string;
  /** "YYYY-MM-DD HH:MM:SS", as gallery-dl prints naive UTC dates. */
  date: string;
  /** One entry per file: media id and extension. */
  files: { mediaId: string; extension?: string }[];
}

/** The listing of one post as the extractor prints it: the post entry, then one entry per file. */
export function postEntries(post: FeedPost): unknown[] {
  const metadata = (file: FeedPost['files'][number], num: number) => ({
    post_shortcode: post.code, owner_id: '4242424242', username: 'own_test_account', fullname: 'Own Test Account', type: 'post',
    date: post.date, post_date: post.date, num, count: post.files.length, extension: file.extension ?? 'jpg', media_id: file.mediaId, width: 640, height: 480
  });
  const directory = metadata(post.files[0]!, 1);
  return [
    [2, directory],
    ...post.files.map((file, index) => [3, `https://scontent.example.invalid/${post.code}/${file.mediaId}.${file.extension ?? 'jpg'}?sig=${Math.random()}`, metadata(file, index + 1)])
  ];
}

/** The listings of a profile (in the given order: pinned posts first) and of each of its posts. */
export function feedListings(posts: readonly FeedPost[]): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = { [PROFILE_TOOL_URL]: posts.flatMap(postEntries) };
  for (const post of posts) result[postUrl(post.code)] = postEntries(post);
  return result;
}

/** gallery-dl prints naive UTC timestamps: "2026-03-30 10:00:00". */
export const galleryDlDate = (milliseconds: number): string => new Date(milliseconds).toISOString().slice(0, 19).replace('T', ' ');

/** `count` posts of one photo each, newest first (index 0 is the newest), one per day backwards from 2026-03-30. */
export function plainPosts(count: number, options: { prefix?: string; firstMediaId?: number; hour?: number; extension?: string } = {}): FeedPost[] {
  const { prefix = 'DDedupe', firstMediaId = 1000, hour = 10, extension } = options;
  return Array.from({ length: count }, (_unused, index) => ({
    code: `${prefix}${String(index).padStart(4, '0')}`,
    date: galleryDlDate(Date.UTC(2026, 2, 30, hour) - index * 86_400_000),
    files: [{ mediaId: String(firstMediaId + index), ...(extension ? { extension } : {}) }]
  }));
}
