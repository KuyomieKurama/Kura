import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeTool, tempDir } from '../adapters/helpers.js';
import type { FakeInstagramTool } from './fake-instagram-tool.js';

export interface CookieObservation {
  cookies: boolean;
  path?: string;
  /** Mode of the cookie file and of the directory it lives in, as octal text, seen by the tool while it ran. */
  mode?: string;
  directoryMode?: string;
  content?: string;
  missing?: boolean;
}

export interface CookieProbeTool {
  binary: FakeInstagramTool['binary'];
  env: Record<string, string>;
  /** What the tool saw of its `-C` argument on each call (listing and download calls). */
  observations(): Promise<CookieObservation[]>;
}

/**
 * Wraps the fake gallery-dl: before it runs, the wrapper looks at the file given with `-C` (exists? mode? content?)
 * and writes that down. It is the only thing that reads the cookie file; the adapter never does. With `delayMs` the
 * tool then stays busy for that long, so a test can interrupt a run while the file exists.
 */
export async function withCookieProbe(inner: FakeInstagramTool, options: { delayMs?: number } = {}): Promise<CookieProbeTool> {
  const dir = await tempDir('kura-cookie-probe-');
  const logFile = join(dir, 'observations.jsonl');
  const script = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const args = process.argv.slice(2);
if (!args.includes('--version')) {
  const at = args.indexOf('-C');
  let record = { cookies: false };
  if (at >= 0) {
    const file = args[at + 1];
    record = { cookies: true, path: file };
    try {
      record.mode = (fs.statSync(file).mode & 0o777).toString(8);
      record.directoryMode = (fs.statSync(path.dirname(file)).mode & 0o777).toString(8);
      record.content = fs.readFileSync(file, 'utf8');
    } catch {
      record.missing = true;
    }
  }
  fs.appendFileSync(process.env.COOKIE_PROBE_LOG, JSON.stringify(record) + '\n');
  const delay = Number(process.env.COOKIE_PROBE_DELAY_MS || 0);
  if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
}
const result = childProcess.spawnSync(${JSON.stringify(inner.binary.path)}, args, { stdio: 'inherit', env: process.env });
process.exit(result.status === null ? 1 : result.status);
`;
  const binary = await fakeTool(script);
  return {
    binary,
    env: { ...inner.env, COOKIE_PROBE_LOG: logFile, ...(options.delayMs ? { COOKIE_PROBE_DELAY_MS: String(options.delayMs) } : {}) },
    async observations() {
      try {
        return (await readFile(logFile, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as CookieObservation);
      } catch {
        return [];
      }
    }
  };
}
