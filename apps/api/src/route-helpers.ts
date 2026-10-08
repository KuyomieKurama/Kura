import type { FastifyReply, FastifyRequest } from 'fastify';

export type RouteSession = { userId: string; role: 'admin' | 'user' };
export type RequireSession = (request: FastifyRequest, reply: FastifyReply) => Promise<RouteSession | undefined>;
export type Audit = (
  actor: string | null,
  action: string,
  target: string | null,
  request: FastifyRequest,
  outcome?: string
) => Promise<void>;

export function responseError(code: string, message: string) {
  return { error: { code, message } };
}

/** Wraps a session check so that only administrators pass; everyone else gets 403 (401 when not signed in). */
export function adminOnly(requireSession: RequireSession): RequireSession {
  return async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return undefined;
    if (session.role !== 'admin') {
      reply.code(403).send(responseError('FORBIDDEN', 'Administratorrechte erforderlich.'));
      return undefined;
    }
    return session;
  };
}
