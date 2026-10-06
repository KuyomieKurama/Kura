import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';

const migrationFilePattern = /^(\d+_[a-z0-9_]+)\.sql$/;
const MIGRATION_ADVISORY_LOCK_KEY = 724311648;

export class MigrationChecksumError extends Error {
  constructor(version: string) {
    super(`Checksum mismatch for applied migration ${version}`);
    this.name = 'MigrationChecksumError';
  }
}

interface MigrationFile {
  version: string;
  checksum: string;
  sql: string;
}

async function loadMigrations(migrationsDirectory: string): Promise<MigrationFile[]> {
  const names = await readdir(migrationsDirectory);
  const matchingNames = names.filter((name) => migrationFilePattern.test(name)).sort();
  return Promise.all(matchingNames.map(async (name) => {
    const match = migrationFilePattern.exec(name);
    if (!match) throw new Error(`Invalid migration file name: ${name}`);
    const sql = await readFile(join(migrationsDirectory, name), 'utf8');
    return {
      version: match[1],
      checksum: createHash('sha256').update(sql).digest('hex'),
      sql
    };
  }));
}

export async function runMigrations(pool: Pool, migrationsDirectory: string): Promise<void> {
  const client = await pool.connect();
  let lockAcquired = false;
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]);
    lockAcquired = true;

    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    const migrations = await loadMigrations(migrationsDirectory);
    const appliedResult = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version'
    );
    const applied = new Map(appliedResult.rows.map((row) => [row.version, row.checksum]));

    for (const migration of migrations) {
      const knownChecksum = applied.get(migration.version);
      if (knownChecksum !== undefined) {
        if (knownChecksum !== migration.checksum) throw new MigrationChecksumError(migration.version);
        continue;
      }

      try {
      await client.query('BEGIN');
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
        [migration.version, migration.checksum]
      );
      await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    if (lockAcquired) await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]);
    client.release();
  }
}
