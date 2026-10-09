import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * R-05 / R-12: this card must not add any way to remove a local original, a blob or a history row. The check is
 * deliberately crude (a text search over the new code), so that a deletion path cannot slip in unnoticed:
 * whoever adds one has to touch this test and explain why.
 */
const root = join(process.cwd());

async function sources(directory: string): Promise<Array<{ file: string; code: string }>> {
  const found: Array<{ file: string; code: string }> = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') found.push(...await sources(path));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      found.push({ file: relative(root, join(root, path)), code: stripComments(await readFile(join(root, path), 'utf8')) });
    }
  }
  return found;
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const worker = await sources('apps/worker/src');
const apiFiles = (await sources('apps/api/src')).filter((entry) => /source-routes|history-routes|kill-switch/.test(entry.file));

describe('no deletion path (R-05, R-12)', () => {
  it('finds the code it is supposed to check', () => {
    expect(worker.map((entry) => entry.file)).toEqual(expect.arrayContaining([
      'apps/worker/src/executor.ts', 'apps/worker/src/handover.ts', 'apps/worker/src/history.ts', 'apps/worker/src/blob-import.ts'
    ]));
    expect(apiFiles.length).toBeGreaterThan(0);
  });

  it.each([
    ['SQL DELETE', /\bDELETE\s+FROM\b/i],
    ['TRUNCATE', /\bTRUNCATE\b/i],
    ['DROP', /\bDROP\s+(TABLE|COLUMN)\b/i],
    ['blob store remove()', /\.remove\s*\(/],
    ['deletion permit', /DeletionPermit|permit\s*:/],
    ['Immich asset deletion', /deleteAsset|decideLocalDeletion/],
    ['cleanup intents', /immich_cleanup_intents|cleanup_intent|delete_pending/i],
    ['unlink', /\bunlink(Sync)?\s*\(/],
    ['rmdir', /\brmdir(Sync)?\s*\(/]
  ])('the worker has no %s', (_label, pattern) => {
    expect(worker.filter((entry) => pattern.test(entry.code)).map((entry) => entry.file)).toEqual([]);
  });

  it('removes files only in two places: the staged copy after a successful import and abandoned workspaces', () => {
    const removing = worker.filter((entry) => /\brm\s*\(/.test(entry.code)).map((entry) => entry.file).sort();
    expect(removing).toEqual(['apps/worker/src/executor.ts', 'apps/worker/src/maintenance.ts']);
    const executor = worker.find((entry) => entry.file.endsWith('executor.ts'))!.code;
    expect(executor.match(/\brm\s*\([^)]*\)/g)).toEqual(['rm(staged.absolutePath, { force: true })']);
    const maintenance = worker.find((entry) => entry.file.endsWith('maintenance.ts'))!.code;
    expect(maintenance.match(/\brm\s*\([^)]*\)/g)).toEqual(['rm(path, { recursive: true, force: true })']);
  });

  it('the history and blob statements of the worker only insert and update', () => {
    const statements = worker.flatMap((entry) => entry.code.match(/`[^`]*\b(INSERT|UPDATE)\b[^`]*`/g) ?? []);
    expect(statements.length).toBeGreaterThan(10);
    expect(statements.filter((statement) => /\bDELETE\b/i.test(statement))).toEqual([]);
  });

  it('the API routes of this card delete nothing except an administrator lifting a kill switch', () => {
    for (const entry of apiFiles) {
      const deletes = entry.code.match(/DELETE\s+FROM\s+\w+/gi) ?? [];
      expect(deletes.every((statement) => /adapter_kill_switches$/i.test(statement)), entry.file).toBe(true);
      expect(entry.code).not.toMatch(/\.remove\s*\(|deleteAsset|unlink|\brm\s*\(/);
    }
  });

  it('the migrations of this card only create tables and indexes', async () => {
    const files = (await readdir(join(root, 'migrations'))).filter((name) => /^005\d_/.test(name));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const name of files) {
      const sql = (await readFile(join(root, 'migrations', name), 'utf8')).replace(/--.*$/gm, '');
      // Replacing a CHECK constraint (P1, 0053) needs DROP CONSTRAINT; it removes a rule, never data.
      expect(sql, name).not.toMatch(/\bDELETE\s+FROM\b|\bDROP\b(?!\s+CONSTRAINT\b)|\bTRUNCATE\b/i);
    }
  });
});
