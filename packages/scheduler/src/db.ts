import type { Pool, PoolClient } from 'pg';

/** Raised when a row does not exist or belongs to another user (the two cases are deliberately indistinguishable). */
export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

export async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original error is the useful one; a broken connection is discarded by release(error).
    }
    throw error;
  } finally {
    client.release();
  }
}
