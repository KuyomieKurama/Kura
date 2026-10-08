import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Pool } from 'pg';

const baseUrl = process.env.DATABASE_URL ?? 'postgres://kura_dev:kura_dev@127.0.0.1:5432/kura_dev';
const parsed = new URL(baseUrl);
const databaseName = `kura_test_${randomUUID().replaceAll('-', '')}`;
parsed.pathname = `/${databaseName}`;
const databaseUrl = parsed.toString();

export async function createTestDatabase(): Promise<{ pool: Pool; databaseUrl: string; cleanup: () => Promise<void> }> {
  const admin = new Pool({ connectionString: baseUrl });
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await admin.end();
  const pool = new Pool({ connectionString: databaseUrl });
  // cleanup() terminates backends right after pool.end(). A client that is still closing then reports
  // 57P01 on the pool; without a listener that 'error' event is unhandled and fails the whole run.
  pool.on('error', () => undefined);

  return {
    pool,
    databaseUrl,
    cleanup: async () => {
      await pool.end();
      const cleanupPool = new Pool({ connectionString: baseUrl });
      await cleanupPool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [databaseName]);
      await cleanupPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await cleanupPool.end();
    }
  };
}

export async function createMigrationsCopy(): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(resolve(tmpdir(), 'kura-migrations-'));
  await cp(resolve(process.cwd(), 'migrations'), directory, { recursive: true });
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

export async function alterMigration(directory: string): Promise<void> {
  const file = resolve(directory, '0001_core.sql');
  await writeFile(file, `${await (await import('node:fs/promises')).readFile(file, 'utf8')}\n-- altered\n`);
}
