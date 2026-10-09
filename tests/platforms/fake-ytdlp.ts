import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeTool, tempDir } from '../adapters/helpers.js';
import type { ExternalBinary } from '../../packages/adapters/src/index.js';

/**
 * A yt-dlp stand-in for the platform tests of P2. It replays what the real yt-dlp 2026.8.19 printed for synthetic page
 * data (the files under fixtures/ytdlp-*, made by generate-ytdlp-fixtures.py) and answers per URL:
 *
 *  - a call with `--flat-playlist` is a listing: the stored JSON is printed after `--playlist-items 1:N` was applied
 *    to its entries, like the real tool does;
 *  - a call with `--dump-single-json` and no `--flat-playlist` is the metadata of one video;
 *  - every other call is a download and writes `asset.<ext>`.
 *
 * The behaviour is re-read from a control file on every call, so a test can change it between two runs. The tool
 * logs the exact argument list of every call, and, when asked, the content of the cookies file it was given (to
 * prove that the file existed with the right mode and that nothing else carried the secret).
 */
export interface FakeResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface FakeDownload {
  /** Container of the file the download writes. */
  ext?: 'mp4' | 'webm' | 'mkv';
  stderr?: string;
  exitCode?: number;
}

export interface YtDlpControl {
  /** Tool URL (the argument after `--`) -> answer of the listing call. */
  lists?: Record<string, FakeResponse>;
  /** Tool URL -> answer of the metadata call of one video. */
  videos?: Record<string, FakeResponse>;
  /** Tool URL -> behaviour of the download. Without an entry the download succeeds with an mp4. */
  downloads?: Record<string, FakeDownload>;
  /** Version printed by `--version`. */
  version?: string;
}

export interface CookieObservation {
  path: string;
  mode: string;
  content: string;
}

export interface FakeYtDlp {
  binary: ExternalBinary;
  env: Record<string, string>;
  control(next: YtDlpControl): Promise<void>;
  /** Argument arrays of all invocations except `--version`, in order. */
  calls(): Promise<string[][]>;
  /** What the tool saw in the file given with --cookies, one entry per call that had the option. */
  cookies(): Promise<CookieObservation[]>;
}

const SCRIPT = String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
let control = {};
try { control = JSON.parse(fs.readFileSync(process.env.FAKE_TOOL_CONTROL, 'utf8')); } catch {}
if (args.includes('--version')) { console.log(control.version ?? '2026.08.19'); process.exit(0); }
if (process.env.FAKE_TOOL_LOG) fs.appendFileSync(process.env.FAKE_TOOL_LOG, JSON.stringify(args) + '\n');

const cookiesAt = args.indexOf('--cookies');
if (cookiesAt >= 0 && process.env.FAKE_TOOL_COOKIE_LOG) {
  const path = args[cookiesAt + 1];
  let observation = { path, mode: 'missing', content: '' };
  try { observation = { path, mode: (fs.statSync(path).mode & 0o777).toString(8), content: fs.readFileSync(path, 'utf8') }; } catch {}
  fs.appendFileSync(process.env.FAKE_TOOL_COOKIE_LOG, JSON.stringify(observation) + '\n');
}

const url = args[args.indexOf('--') + 1];
const answer = (response) => {
  if (response.stderr) process.stderr.write(response.stderr);
  const done = () => process.exit(response.exitCode ?? 0);
  if (response.stdout !== undefined) process.stdout.write(response.stdout, done); else done();
};

if (args.includes('--flat-playlist')) {
  const response = control.lists && control.lists[url];
  if (!response) { process.stderr.write('ERROR: [generic] Unsupported URL: ' + url + '\n'); process.exit(1); }
  let stdout = response.stdout;
  const itemsAt = args.indexOf('--playlist-items');
  if (stdout !== undefined && itemsAt >= 0 && (response.exitCode ?? 0) === 0) {
    const last = Number(args[itemsAt + 1].split(':')[1]);
    const playlist = JSON.parse(stdout);
    if (Array.isArray(playlist.entries)) playlist.entries = playlist.entries.slice(0, last);
    stdout = JSON.stringify(playlist);
  }
  answer({ ...response, stdout });
} else if (args.includes('--dump-single-json')) {
  const response = control.videos && control.videos[url];
  if (!response) { process.stderr.write('ERROR: [generic] Unsupported URL: ' + url + '\n'); process.exit(1); }
  answer(response);
} else {
  const download = (control.downloads && control.downloads[url]) || {};
  if (download.exitCode) { process.stderr.write(download.stderr ?? 'ERROR: unknown\n'); process.exit(download.exitCode); }
  const ext = download.ext ?? 'mp4';
  const label = Buffer.from('video ' + url);
  const head = ext === 'mp4' ? Buffer.from([0, 0, 0, 0x18, ...Buffer.from('ftypmp42')]) : Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
  fs.writeFileSync('asset.' + ext, Buffer.concat([head, label]));
}
`;

export async function fakeYtDlpTool(initial: YtDlpControl = {}): Promise<FakeYtDlp> {
  const binary = await fakeTool(SCRIPT);
  const dir = await tempDir('kura-ytdlp-tool-');
  const logFile = join(dir, 'calls.jsonl');
  const cookieLog = join(dir, 'cookies.jsonl');
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
    env: { FAKE_TOOL_LOG: logFile, FAKE_TOOL_CONTROL: controlFile, FAKE_TOOL_COOKIE_LOG: cookieLog },
    control: (next) => writeFile(controlFile, JSON.stringify(next)),
    calls: () => readLines<string[]>(logFile),
    cookies: () => readLines<CookieObservation>(cookieLog)
  };
}

// --- fixtures (real yt-dlp output, see fixtures/generate-ytdlp-fixtures.py) ------------------------------------------

export const readFixtureText = (name: string): Promise<string> => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

export async function readFixtureJson<T = Record<string, unknown>>(name: string): Promise<T> {
  return JSON.parse(await readFixtureText(name)) as T;
}

/** A listing fixture as the text the tool prints. */
export const listingOf = async (name: string): Promise<FakeResponse> => ({ stdout: await readFixtureText(name) });

/** The failure the real yt-dlp printed for a fixture, as an answer of the fake (exit code 1, nothing on stdout). */
export const failureOf = async (name: string): Promise<FakeResponse> => ({ stderr: await readFixtureText(name), exitCode: 1 });

/**
 * The metadata of one video: the real -J output of a fixture with the video id replaced, plus optional overrides. The
 * fixtures were made for the id dQw4w9WgXcQ; the id appears in the fields below only.
 */
export async function videoMetadata(fixtureName: string, videoId: string, overrides: Record<string, unknown> = {}): Promise<FakeResponse> {
  const info = await readFixtureJson(fixtureName);
  const replaced = JSON.parse(JSON.stringify(info).replaceAll('dQw4w9WgXcQ', videoId)) as Record<string, unknown>;
  return { stdout: JSON.stringify({ ...replaced, ...overrides }) };
}
