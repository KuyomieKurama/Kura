import { Pool } from 'pg';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '@kura/storage';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
await runMigrations(pool, migrationsDirectory);
const app = buildApp(config, pool, resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error, 'API startup failed');
  process.exitCode = 1;
  await app.close();
}
