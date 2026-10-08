import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeTool, tempDir } from '../adapters/helpers.js';
import { pixivListing, youtubeInfo } from '../adapters/fake-tools.js';
import type { ExternalBinary } from '../../packages/adapters/src/index.js';

export { pixivListing, youtubeInfo };

export interface ToolControl {
  /** 0-based file indexes whose download fails. */
  failIndexes?: number[];
  /** What the failing download prints to stderr. */
  stderr?: string;
  /** Make the metadata call fail with this stderr (exit code 1). */
  listingFailure?: string;
}

export interface ControllableTool {
  binary: ExternalBinary;
  env: Record<string, string>;
  /** Changes the behaviour for later invocations (the tool re-reads its control file on every call). */
  control(next: ToolControl): Promise<void>;
  /** Every invocation's argument array. */
  calls(): Promise<string[][]>;
}

const PRELUDE = `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_TOOL_LOG) fs.appendFileSync(process.env.FAKE_TOOL_LOG, JSON.stringify(args) + '\\n');
let control = {};
try { control = JSON.parse(fs.readFileSync(process.env.FAKE_TOOL_CONTROL, 'utf8')); } catch {}
`;

async function controllable(script: string, initial: ToolControl): Promise<ControllableTool> {
  const binary = await fakeTool(`${PRELUDE}\n${script}`);
  const dir = await tempDir('kura-m5b-tool-');
  const logFile = join(dir, 'calls.jsonl');
  const controlFile = join(dir, 'control.json');
  await writeFile(controlFile, JSON.stringify(initial));
  return {
    binary,
    env: { FAKE_TOOL_LOG: logFile, FAKE_TOOL_CONTROL: controlFile },
    control: (next) => writeFile(controlFile, JSON.stringify(next)),
    async calls() {
      try {
        return (await readFile(logFile, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
      } catch {
        return [];
      }
    }
  };
}

/**
 * gallery-dl stand-in for the Pixiv fixture of M5-A: lists `fileCount` files, `--range N` writes file N
 * (a jpeg with content of its own, so the files have different checksums). Failures are switchable.
 */
export function controllableGalleryDl(fileCount: number, initial: ToolControl = {}): Promise<ControllableTool> {
  const listing = JSON.stringify(pixivListing(fileCount));
  return controllable(`
if (args.includes('--version')) { console.log('1.32.2'); process.exit(0); }
if (args.includes('--dump-json')) {
  if (control.listingFailure) { process.stderr.write(control.listingFailure); process.exit(1); }
  process.stdout.write(${JSON.stringify(listing)}, () => process.exit(0));
} else {
  const index = Number(args[args.indexOf('--range') + 1]) - 1;
  const directory = args[args.indexOf('-D') + 1];
  if ((control.failIndexes ?? []).includes(index)) { process.stderr.write(control.stderr ?? 'unknown error'); process.exit(4); }
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('pixiv file ' + index)]);
  fs.writeFileSync(directory + '/asset.jpg', jpeg);
}
`, initial);
}

/** yt-dlp stand-in: prints the info of one video and writes `asset.mp4` for the download call. */
export function controllableYtDlp(initial: ToolControl = {}): Promise<ControllableTool> {
  const info = JSON.stringify(youtubeInfo());
  return controllable(`
if (args.includes('--version')) { console.log('2026.07.04'); process.exit(0); }
if (args.includes('--dump-single-json')) {
  if (control.listingFailure) { process.stderr.write(control.listingFailure); process.exit(1); }
  process.stdout.write(${JSON.stringify(info)}, () => process.exit(0));
} else {
  if ((control.failIndexes ?? []).includes(0)) { process.stderr.write(control.stderr ?? 'unknown error'); process.exit(1); }
  const mp4 = Buffer.from([0, 0, 0, 0x18, ...Buffer.from('ftypmp42'), ...Buffer.from('own youtube video')]);
  fs.writeFileSync('asset.mp4', mp4);
}
`, initial);
}
