import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeTool, tempDir } from '../adapters/helpers.js';
import type { ExternalBinary } from '../../packages/adapters/src/index.js';

/** What the fake gallery-dl does on the next call. Re-read from a control file on every call, so a test can change it between runs. */
export interface InstagramToolControl {
  /** URL given after `--` -> the array that `--dump-json` prints for it (fixtures made by the real extractor code). */
  listings?: Record<string, unknown>;
  /** Raw stdout of a listing, overrides `listings`. */
  rawOutput?: string;
  /** Text written to stderr by a listing that succeeds (for example gallery-dl's warnings). */
  listingStderr?: string;
  /** Makes every listing fail with this stderr and exit code, without any output. */
  listingFailure?: { stderr: string; exitCode: number };
  /** Makes every download fail with this stderr and exit code. */
  downloadFailure?: { stderr: string; exitCode: number };
  /** 0-based file positions of a post whose download fails (with the `downloadFailure` text). */
  failPositions?: number[];
}

export interface FakeInstagramTool {
  binary: ExternalBinary;
  env: Record<string, string>;
  control(next: InstagramToolControl): Promise<void>;
  /** Argument arrays of all invocations, in order. */
  calls(): Promise<string[][]>;
  /** Environment variables of all invocations, in order. */
  environments(): Promise<Record<string, string>[]>;
}

const SCRIPT = String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_TOOL_LOG) fs.appendFileSync(process.env.FAKE_TOOL_LOG, JSON.stringify(args) + '\n');
if (process.env.FAKE_TOOL_ENV_LOG) fs.appendFileSync(process.env.FAKE_TOOL_ENV_LOG, JSON.stringify(process.env) + '\n');
let control = {};
try { control = JSON.parse(fs.readFileSync(process.env.FAKE_TOOL_CONTROL, 'utf8')); } catch {}

if (args.includes('--version')) { console.log('1.32.16'); process.exit(0); }

const separator = args.indexOf('--');
const url = separator >= 0 ? args[separator + 1] : undefined;
const listing = control.listings && url ? control.listings[url] : undefined;

if (args.includes('--dump-json')) {
  if (control.listingFailure) { process.stderr.write(control.listingFailure.stderr); process.exit(control.listingFailure.exitCode); }
  if (control.listingStderr) process.stderr.write(control.listingStderr);
  if (control.rawOutput !== undefined) { process.stdout.write(control.rawOutput, () => process.exit(0)); return; }
  if (listing === undefined) { process.stderr.write('[gallery-dl][error] Unsupported URL ' + url); process.exit(64); }
  // --post-range 1-N keeps the first N posts (a post starts at a [2, ...] entry), like the real tool.
  const rangeAt = args.indexOf('--post-range');
  const limit = rangeAt >= 0 ? Number(args[rangeAt + 1].split('-')[1]) : Infinity;
  const out = [];
  let posts = 0;
  for (const entry of listing) {
    if (entry[0] === 2) posts += 1;
    if (entry[0] === -1 || posts <= limit) out.push(entry);
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n', () => process.exit(0));
} else {
  if (control.downloadFailure) { process.stderr.write(control.downloadFailure.stderr); process.exit(control.downloadFailure.exitCode); }
  const position = Number(args[args.indexOf('--range') + 1]) - 1;
  const directory = args[args.indexOf('-D') + 1];
  if (!Number.isInteger(position) || position < 0 || !directory || !listing) { process.stderr.write('bad arguments'); process.exit(64); }
  const files = listing.filter((entry) => entry[0] === 3);
  const file = files[position];
  if (!file) { process.stderr.write('no such file'); process.exit(64); }
  const extension = file[2].extension;
  const label = Buffer.from('instagram ' + url + ' #' + position);
  const head = extension === 'mp4' ? Buffer.from([0, 0, 0, 0x18, ...Buffer.from('ftypmp42')]) : Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  if ((control.failPositions ?? []).includes(position)) { process.stderr.write(control.downloadFailure ? control.downloadFailure.stderr : 'unknown error'); process.exit(4); }
  fs.writeFileSync(directory + '/asset.' + extension, Buffer.concat([head, label]));
}
`;

export async function fakeInstagramGalleryDl(initial: InstagramToolControl = {}): Promise<FakeInstagramTool> {
  const binary = await fakeTool(SCRIPT);
  const dir = await tempDir('kura-instagram-tool-');
  const logFile = join(dir, 'calls.jsonl');
  const environmentFile = join(dir, 'environments.jsonl');
  const controlFile = join(dir, 'control.json');
  await writeFile(controlFile, JSON.stringify(initial));
  const readLines = async <T>(file: string): Promise<T[]> => {
    try {
      return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
    } catch {
      return [];
    }
  };
  return {
    binary,
    env: { FAKE_TOOL_LOG: logFile, FAKE_TOOL_ENV_LOG: environmentFile, FAKE_TOOL_CONTROL: controlFile },
    control: (next) => writeFile(controlFile, JSON.stringify(next)),
    calls: () => readLines<string[]>(logFile),
    environments: () => readLines<Record<string, string>>(environmentFile)
  };
}

/** The fixture files under tests/instagram/fixtures were printed by the real gallery-dl 1.32.16 extractor code (see the README there). */
export async function fixture(name: string): Promise<unknown[]> {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as unknown[];
}

export const INSTAGRAM_ROOT = 'https://www.instagram.com';
