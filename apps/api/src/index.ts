import { Pool } from 'pg';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const app = buildApp(config, pool);

try {
  await app.listen({ host: '127.0.0.1', port: config.port });
} catch (error) {
  app.log.error(error, 'API startup failed');
  process.exitCode = 1;
  await app.close();
}
