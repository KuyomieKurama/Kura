import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

/**
 * Private working area of one job (docs/planning/04, sections 3 and 7).
 *
 *   <root>/media/      validated files only; this is what an importer reads
 *   <root>/scratch/N/  one directory per tool invocation, used as its cwd
 *   <root>/home/       HOME, XDG_* and TMPDIR of the tool; nothing is shared with the host user
 *
 * The caller owns the workspace and must call dispose(), also on failure.
 */
export interface RunWorkspace {
  readonly rootDir: string;
  readonly mediaDir: string;
  readonly homeDir: string;
  createScratchDir(): Promise<string>;
  /** Total size of everything below rootDir, without following symlinks. */
  usedBytes(): Promise<number>;
  dispose(): Promise<void>;
}

export async function createRunWorkspace(parentDir: string): Promise<RunWorkspace> {
  if (!isAbsolute(parentDir)) throw new Error('Workspace parent directory must be absolute');
  await mkdir(parentDir, { recursive: true, mode: 0o700 });
  const rootDir = join(parentDir, `run-${randomBytes(12).toString('hex')}`);
  const mediaDir = join(rootDir, 'media');
  const homeDir = join(rootDir, 'home');
  const scratchRoot = join(rootDir, 'scratch');
  await mkdir(rootDir, { mode: 0o700 });
  await mkdir(mediaDir, { mode: 0o700 });
  await mkdir(homeDir, { mode: 0o700 });
  await mkdir(scratchRoot, { mode: 0o700 });

  let scratchCounter = 0;
  let disposed = false;

  return {
    rootDir,
    mediaDir,
    homeDir,
    async createScratchDir() {
      if (disposed) throw new Error('Workspace was already disposed');
      scratchCounter += 1;
      const dir = join(scratchRoot, String(scratchCounter));
      await mkdir(dir, { mode: 0o700 });
      return dir;
    },
    usedBytes: () => directorySize(rootDir),
    async dispose() {
      disposed = true;
      await rm(rootDir, { recursive: true, force: true });
    }
  };
}

/** Sums file sizes below `dir`; symlinks are counted as links, never followed. */
export async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(path);
    } else {
      try {
        total += (await lstat(path)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return total;
}
