import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeTool, tempDir } from './helpers.js';
import type { ExternalBinary } from '../../packages/adapters/src/index.js';

export type DownloadMode =
  | 'ok'
  | 'fail'
  | 'extra-file'
  | 'html'
  | 'symlink'
  | 'wrong-extension'
  | 'hang'
  | 'flood-disk';

export interface FakeYtDlpConfig {
  version?: string;
  info?: unknown;
  /** Raw stdout of the metadata call, overrides `info`. */
  rawInfoOutput?: string;
  infoExitCode?: number;
  /** The metadata call never answers. */
  infoHang?: boolean;
  download?: DownloadMode;
}

export interface FakeTool {
  binary: ExternalBinary;
  /** Environment for the adapter's extraEnv so the fake can log its arguments. */
  env: Record<string, string>;
  /** One entry per invocation: the exact argument array the tool received. */
  calls(): Promise<string[][]>;
}

const MP4 = [0, 0, 0, 0x18, ...Buffer.from('ftypmp42'), ...Buffer.from('fake mp4 payload')];

async function withLog(script: string): Promise<FakeTool> {
  const binary = await fakeTool(script);
  const logFile = join(await tempDir('kura-faketool-log-'), 'calls.jsonl');
  return {
    binary,
    env: { FAKE_TOOL_LOG: logFile },
    async calls() {
      try {
        return (await readFile(logFile, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
      } catch {
        return [];
      }
    }
  };
}

const COMMON_PRELUDE = `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_TOOL_LOG) fs.appendFileSync(process.env.FAKE_TOOL_LOG, JSON.stringify(args) + '\\n');
`;

/** A yt-dlp stand-in that prints realistic JSON and writes `asset.mp4` like the real template would. */
export function fakeYtDlp(config: FakeYtDlpConfig = {}): Promise<FakeTool> {
  return withLog(`${COMMON_PRELUDE}
const config = ${JSON.stringify(config)};
const MP4 = Buffer.from(${JSON.stringify(MP4)});
if (args.includes('--version')) { console.log(config.version ?? '2026.07.04'); process.exit(0); }
if (args.includes('--dump-single-json')) {
  if (config.infoHang) {
    setInterval(() => {}, 1000);
  } else {
    process.stdout.write(config.rawInfoOutput ?? JSON.stringify(config.info));
    process.exit(config.infoExitCode ?? 0);
  }
}
else switch (config.download ?? 'ok') {
  case 'ok': fs.writeFileSync('asset.mp4', MP4); break;
  case 'fail': process.stderr.write('ERROR: [youtube] abc: Sign in to confirm --exec=touch /tmp/pwned\\n'); process.exit(1);
  case 'extra-file': fs.writeFileSync('asset.mp4', MP4); fs.writeFileSync('asset.mp4.part', 'partial'); break;
  case 'html': fs.writeFileSync('asset.mp4', '<html><body>consent required</body></html>'); break;
  case 'symlink': fs.symlinkSync('/etc/hostname', 'asset.mp4'); break;
  case 'wrong-extension': fs.writeFileSync('asset.exe', MP4); break;
  case 'hang': setInterval(() => {}, 1000); break;
  case 'flood-disk': fs.writeFileSync('asset.mp4', Buffer.alloc(80 * 1024 * 1024)); setInterval(() => {}, 1000); break;
}
`);
}

export interface FakeGalleryDlConfig {
  version?: string;
  listing?: unknown;
  rawListingOutput?: string;
  listingExitCode?: number;
  /** 0-based file indexes whose download fails. */
  failIndexes?: number[];
  /** File extension and bytes per 0-based index; default is a jpeg. */
  fileExtensions?: Record<number, string>;
}

/** A gallery-dl stand-in: `--dump-json` lists files, `--range N` downloads file N into `-D <dir>`. */
export function fakeGalleryDl(config: FakeGalleryDlConfig = {}): Promise<FakeTool> {
  return withLog(`${COMMON_PRELUDE}
const config = ${JSON.stringify(config)};
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake jpeg payload')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png payload')]);
if (args.includes('--version')) { console.log(config.version ?? '1.32.2'); process.exit(0); }
if (args.includes('--dump-json')) {
  process.stdout.write(config.rawListingOutput ?? JSON.stringify(config.listing));
  process.exit(config.listingExitCode ?? 0);
}
const rangeIndex = Number(args[args.indexOf('--range') + 1]) - 1;
const directory = args[args.indexOf('-D') + 1];
if (!Number.isInteger(rangeIndex) || rangeIndex < 0 || !directory) { process.stderr.write('bad arguments'); process.exit(64); }
if ((config.failIndexes ?? []).includes(rangeIndex)) { process.stderr.write('HttpError: 429 Too Many Requests'); process.exit(4); }
const extension = (config.fileExtensions ?? {})[rangeIndex] ?? 'jpg';
fs.writeFileSync(directory + '/asset.' + extension, extension === 'png' ? PNG : JPEG);
`);
}

/** yt-dlp -J output of a single video, trimmed to what the adapter reads plus noise a real run would contain. */
export function youtubeInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dQw4w9WgXcQ',
    title: 'Own test video',
    ext: 'mp4',
    channel_id: 'UC1234567890abcdefghijkl',
    channel: 'Own Test Channel',
    uploader: 'Own Test Channel',
    upload_date: '20260105',
    duration: 42,
    width: 1920,
    height: 1080,
    extractor_key: 'Youtube',
    webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    formats: [{ format_id: '137', url: 'https://rr1.example.invalid/videoplayback?sig=SECRET', ext: 'mp4', width: 1920, height: 1080 }],
    ...overrides
  };
}

export function pixivListing(fileCount = 3, metadataOverrides: Record<string, unknown> = {}): unknown[] {
  const messages: unknown[] = [[2, { category: 'pixiv', subcategory: 'work' }]];
  for (let index = 0; index < fileCount; index += 1) {
    messages.push([3, `https://i.pximg.net/img-original/img/2026/01/01/00/00/00/98765_p${index}.png`, {
      id: 98765,
      num: index,
      extension: 'png',
      filename: `98765_p${index}`,
      title: 'Own test artwork',
      date: '2026-01-01T00:00:00',
      user: { id: 12345, name: 'own_artist' },
      width: 1200,
      height: 900,
      ...metadataOverrides
    }]);
  }
  return messages;
}
