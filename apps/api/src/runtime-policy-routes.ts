import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import {
  InvalidRuntimePolicyError,
  PolicyVersionConflictError,
  RuntimePolicyRepository,
  type PolicyVersion
} from '@kura/scheduler';
import { adminOnly, responseError, type Audit, type RequireSession } from './route-helpers.js';

function presentPolicy(current: PolicyVersion) {
  return {
    version: current.version,
    policy: current.policy,
    updatedBy: current.createdBy,
    updatedAt: current.createdAt,
    // Honest status for the admin UI: what is wired up today and what is only stored.
    enforced: [
      'downloads.maxConcurrentGlobal',
      'downloads.maxConcurrentPerUser',
      'downloads.perUser',
      'retention.finishedRunDays'
    ]
  };
}

/** Admin-only runtime policy (plan 07: GET/PUT /admin/runtime-policy). */
export function registerRuntimePolicyRoutes(input: {
  app: FastifyInstance;
  pool: Pool;
  requireSession: RequireSession;
  audit: Audit;
}): void {
  const { app, pool, audit } = input;
  const requireAdmin = adminOnly(input.requireSession);
  const policies = new RuntimePolicyRepository(pool);

  app.get('/api/v1/admin/runtime-policy', async (request, reply) => {
    const session = await requireAdmin(request, reply);
    if (!session) return;
    return presentPolicy(await policies.current());
  });

  app.put('/api/v1/admin/runtime-policy', async (request, reply) => {
    const session = await requireAdmin(request, reply);
    if (!session) return;
    const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as Record<string, unknown>;
    const expectedVersion = body.expectedVersion;
    if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      return reply.code(400).send(responseError('VALIDATION_ERROR', 'expectedVersion (aktuelle Versionsnummer) ist erforderlich.'));
    }
    try {
      const activated = await policies.activate(body.policy, expectedVersion, session.userId);
      await audit(session.userId, 'runtime_policy.activate', String(activated.version), request);
      return presentPolicy(activated);
    } catch (error) {
      if (error instanceof InvalidRuntimePolicyError) {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'Die Limits sind ungültig.', problems: error.problems }
        });
      }
      if (error instanceof PolicyVersionConflictError) {
        return reply.code(409).send({
          error: {
            code: 'VERSION_CONFLICT',
            message: 'Die Limits wurden zwischenzeitlich geändert. Bitte laden Sie die aktuelle Version neu.'
          },
          currentVersion: error.currentVersion
        });
      }
      throw error;
    }
  });
}
