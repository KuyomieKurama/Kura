import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { ApiConfig } from './config.js';

export function buildApp(config: ApiConfig, pool: Pool): FastifyInstance {
  const app = Fastify({ logger: true, trustProxy: config.trustProxy });

  app.get('/healthz', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });

  app.addHook('onClose', async () => {
    await pool.end();
  });

  return app;
}
