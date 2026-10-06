import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Pool } from 'pg';
import { runMigrations } from './migrator.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(packageDirectory, '../../../migrations');
const pool = new Pool({ connectionString: databaseUrl });

try {
  await runMigrations(pool, migrationsDirectory);
} finally {
  await pool.end();
}
