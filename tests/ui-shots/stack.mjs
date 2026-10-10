/* global process, URL, fetch, setTimeout */
// Starts the real Kura API (built web files included) against a throwaway database and loads Playwright.
// Shared by capture.mjs (screenshots) and keyboard.mjs (keyboard path check). Nothing here is committed output.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '../..');

const baseDatabaseUrl = process.env.DATABASE_URL ?? 'postgres://kura_dev:kura_dev@127.0.0.1:5432/kura_dev';

/**
 * Playwright is not a dependency of this repository. Point PLAYWRIGHT_CORE_DIR at an installed playwright-core
 * (the directory that contains its package.json). The browsers come from PLAYWRIGHT_BROWSERS_PATH.
 */
export async function loadPlaywright() {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/work/.ms-playwright';
  const candidates = [
    process.env.PLAYWRIGHT_CORE_DIR,
    '/work/SuperTakt/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core'
  ].filter(Boolean);
  const directory = candidates.find((candidate) => existsSync(resolve(candidate, 'package.json')));
  if (!directory) throw new Error('playwright-core not found. Set PLAYWRIGHT_CORE_DIR to an installed playwright-core directory.');
  const require = createRequire(resolve(directory, 'package.json'));
  return require(directory);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function withAdminPool(callback) {
  const { default: pg } = await import(resolve(repoRoot, 'node_modules/pg/lib/index.js')).catch(() => import('pg'));
  const pool = new pg.Pool({ connectionString: baseDatabaseUrl });
  try {
    return await callback(pool);
  } finally {
    await pool.end();
  }
}

/** Builds the web app (unless skipped), creates a database, starts the API on a free port. */
export async function startStack({ skipBuild = false } = {}) {
  if (!skipBuild) {
    execFileSync('corepack', ['pnpm', '--filter', '@kura/web', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  }
  if (!existsSync(resolve(repoRoot, 'apps/api/dist/index.js'))) {
    throw new Error('apps/api/dist/index.js is missing. Run "corepack pnpm build" first.');
  }
  const databaseName = `kura_shots_${randomUUID().replaceAll('-', '')}`;
  await withAdminPool((pool) => pool.query(`CREATE DATABASE "${databaseName}"`));
  const databaseUrl = new URL(baseDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;

  const port = await freePort();
  const output = [];
  const child = spawn('node', ['apps/api/dist/index.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl.toString(),
      KURA_STORAGE_BACKEND: 'database',
      KURA_SECRET_KEY: randomBytes(32).toString('base64'),
      COOKIE_SECURE: 'false',
      HOST: '127.0.0.1',
      PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));

  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) break;
    } catch {
      // not up yet
    }
    if (child.exitCode !== null) throw new Error(`API exited early:\n${output.join('')}`);
    await new Promise((done) => setTimeout(done, 200));
    if (attempt === 99) throw new Error(`API did not become healthy:\n${output.join('')}`);
  }

  return {
    origin,
    databaseUrl: databaseUrl.toString(),
    async stop() {
      child.kill('SIGTERM');
      await new Promise((done) => child.once('exit', done));
      await withAdminPool(async (pool) => {
        await pool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [databaseName]);
        await pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      });
    }
  };
}
