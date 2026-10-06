import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MigrationChecksumError, runMigrations } from '../../packages/storage/src/migrator.js';
import { alterMigration, createMigrationsCopy, createTestDatabase } from '../helpers/database.js';

describe('PostgreSQL migrations', () => {
  it('apply to an empty database, are idempotent, and reject checksum changes', async () => {
    const database = await createTestDatabase();
    const migrations = await createMigrationsCopy();
    try {
      await runMigrations(database.pool, migrations.directory);
      await runMigrations(database.pool, migrations.directory);
      const applied = await database.pool.query('SELECT version FROM schema_migrations');
      expect(applied.rows).toEqual([{ version: '0001_core' }, { version: '0002_local_auth' }]);

      await alterMigration(migrations.directory);
      await expect(runMigrations(database.pool, migrations.directory)).rejects.toBeInstanceOf(MigrationChecksumError);
    } finally {
      await migrations.cleanup();
      await database.cleanup();
    }
  });

  it('serializes concurrent runners against the same empty database', async () => {
    const database = await createTestDatabase();
    const migrations = await createMigrationsCopy();
    try {
      await expect(Promise.all([
        runMigrations(database.pool, migrations.directory),
        runMigrations(database.pool, migrations.directory)
      ])).resolves.toEqual([undefined, undefined]);

      const applied = await database.pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version'
      );
      expect(applied.rows).toEqual([{ version: '0001_core' }, { version: '0002_local_auth' }]);
    } finally {
      await migrations.cleanup();
      await database.cleanup();
    }
  });

  it('keeps distinct issuer subjects separate even when email is the same', async () => {
    const database = await createTestDatabase();
    const migrations = await createMigrationsCopy();
    try {
      await runMigrations(database.pool, migrations.directory);
      const firstUserId = randomUUID();
      const secondUserId = randomUUID();
      await database.pool.query('INSERT INTO users (id, display_name) VALUES ($1, $2), ($3, $4)', [firstUserId, 'First', secondUserId, 'Second']);
      await database.pool.query(
        'INSERT INTO identities (id, user_id, issuer, subject, email) VALUES ($1, $2, $3, $4, $5), ($6, $7, $3, $8, $5)',
        [randomUUID(), firstUserId, 'https://issuer.example', 'subject-one', 'same@example.test', randomUUID(), secondUserId, 'subject-two']
      );
      const result = await database.pool.query('SELECT user_id FROM identities WHERE email = $1 ORDER BY subject', ['same@example.test']);
      expect(result.rows.map((row) => row.user_id)).toEqual([firstUserId, secondUserId]);
      await expect(database.pool.query('INSERT INTO identities (id, user_id, issuer, subject) VALUES ($1, $2, $3, $4)', [randomUUID(), secondUserId, 'https://issuer.example', 'subject-one'])).rejects.toThrow();
    } finally {
      await migrations.cleanup();
      await database.cleanup();
    }
  });
});
