import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app.js';
import type { ApiConfig } from '../../apps/api/src/config.js';
import { runMigrations } from '../../packages/storage/src/migrator.js';
import { createTestDatabase, createMigrationsCopy } from '../helpers/database.js';

const config: ApiConfig = { databaseUrl: 'not-logged', port: 3000, trustProxy: false };

describe('GET /healthz', () => {
  it('returns ok after a successful database query', async () => {
    const database = await createTestDatabase();
    const migrations = await createMigrationsCopy();
    try {
      await runMigrations(database.pool, migrations.directory);
      const healthPool = new Pool({ connectionString: database.databaseUrl });
      const app = buildApp(config, healthPool);
      const response = await app.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
      await app.close();
    } finally {
      await migrations.cleanup();
      await database.cleanup();
    }
  });

  it('returns an error when the database cannot be queried', async () => {
    const unavailablePool = new Pool({ connectionString: 'postgres://invalid:invalid@127.0.0.1:1/invalid', connectionTimeoutMillis: 100 });
    const app = buildApp(config, unavailablePool);
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(500);
    await app.close();
  });
});
