import { existsSync } from 'node:fs';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { ApiConfig } from './config.js';

export function buildApp(config: ApiConfig, pool: Pool, webDirectory?: string): FastifyInstance {
  const app = Fastify({ logger: true, trustProxy: config.trustProxy });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Content-Security-Policy', "default-src 'self'");
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });

  app.get('/healthz', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });

  app.get('/api/v1/status', async () => {
    await pool.query('SELECT 1');
    const migrations = await pool.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
    return {
      version: '0.1.0',
      database: 'ok',
      migrations: { appliedCount: migrations.rowCount, latestVersion: migrations.rows.at(-1)?.version ?? null }
    };
  });

  if (webDirectory && existsSync(webDirectory)) {
    void app.register(fastifyStatic, {
      root: webDirectory,
      index: ['index.html'],
      cacheControl: false,
      setHeaders: (reply, filePath) => reply.header('Cache-Control', filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable')
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url === '/healthz') return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Not Found' });
      return reply.type('text/html').sendFile('index.html');
    });
  }

  app.addHook('onClose', async () => { await pool.end(); });
  return app;
}
