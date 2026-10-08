import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { createRunWorkspace, type ExternalBinary, type ProcessLimits, type RunWorkspace } from '../../packages/adapters/src/index.js';

export const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake jpeg payload')]);
export const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png payload')]);
export const MP4_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.from('fake mp4 payload')]);

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export const generousLimits: ProcessLimits = {
  timeoutMs: 10_000,
  maxStdoutBytes: 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  maxTempBytes: 64 * 1024 * 1024
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** A temporary directory that is removed after the test. */
export async function tempDir(prefix = 'kura-adapters-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A job workspace that is disposed after the test. */
export async function testWorkspace(): Promise<RunWorkspace> {
  const workspace = await createRunWorkspace(await tempDir());
  cleanups.push(() => workspace.dispose());
  return workspace;
}

/**
 * Writes an executable Node script. The shebang uses the absolute Node path
 * because the runner starts tools with a minimal PATH.
 */
export async function fakeTool(script: string): Promise<ExternalBinary> {
  const dir = await tempDir('kura-faketool-');
  const path = join(dir, 'tool');
  const content = `#!${process.execPath}\n${script}\n`;
  await writeFile(path, content);
  await chmod(path, 0o755);
  return { path, sha256: sha256Hex(Buffer.from(content)) };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}
