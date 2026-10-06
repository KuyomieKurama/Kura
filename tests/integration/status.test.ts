import { resolve } from 'node:path';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app.js';
import { runMigrations } from '../../packages/storage/src/migrator.js';
import { createMigrationsCopy, createTestDatabase } from '../helpers/database.js';

const config = { databaseUrl: 'not-logged', host: '127.0.0.1', port: 8080, trustProxy: false };

describe('status and static UI', () => {
  it('exposes only the status contract and serves the SPA safely', async () => {
    const database = await createTestDatabase();
    const migrations = await createMigrationsCopy();
    try {
      await runMigrations(database.pool, migrations.directory);
      const appPool = new Pool({ connectionString: database.databaseUrl });
      const app = buildApp(config, appPool, resolve(process.cwd(), 'apps/web/dist'));
      const status = await app.inject('/api/v1/status');
      expect(status.statusCode).toBe(200);
      expect(Object.keys(status.json()).sort()).toEqual(['database', 'migrations', 'version']);
      expect(status.json().database).toBe('ok');
      const reported = status.json().migrations as { appliedCount: number; latestVersion: string };
      expect(reported.appliedCount).toBeGreaterThanOrEqual(3);
      expect(reported.latestVersion >= '0003_auth_hardening').toBe(true);
      const page = await app.inject('/not-a-page');
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-security-policy']).toBe("default-src 'self'");
      expect(page.headers['x-content-type-options']).toBe('nosniff');
      expect(page.headers['referrer-policy']).toBe('no-referrer');
      expect(page.headers['cache-control']).toBe('no-cache');
      const api = await app.inject('/api/unknown');
      expect(api.statusCode).toBe(404);
      expect(api.json()).toMatchObject({ statusCode: 404 });
      await app.close();
    } finally {
      await migrations.cleanup();
      await database.cleanup();
    }
  });
});
