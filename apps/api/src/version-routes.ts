import type { FastifyInstance } from 'fastify';
import { formatSemver, parseSemver } from './semver.js';
import { UpdateCheckDisabledError, type UpdateChecker } from './update-check.js';
import { adminOnly, responseError, type Audit, type RequireSession } from './route-helpers.js';

/**
 * Version and update check (REQ-DL-007).
 *
 * The API only reports. It has no route that installs, rebuilds or restarts anything: updating Kura is an
 * operator action on the host (deploy/kura-deploy.sh), by design.
 */
export function registerVersionRoutes(input: {
  app: FastifyInstance;
  requireSession: RequireSession;
  checker: UpdateChecker;
  audit: Audit;
}): void {
  const { app, checker, audit } = input;
  const requireAdmin = adminOnly(input.requireSession);

  app.get('/api/v1/version', async (request, reply) => {
    const session = await input.requireSession(request, reply);
    if (!session) return;
    const view = await checker.view();
    // The notice for a new version is for administrators; "dismissed" always refers to the version on offer.
    const dismissed = session.role === 'admin' ? await checker.dismissedVersion(session.userId) : null;
    return { ...view, noticeDismissed: view.latestVersion !== null && dismissed === view.latestVersion };
  });

  app.post('/api/v1/version/check', async (request, reply) => {
    const session = await requireAdmin(request, reply);
    if (!session) return;
    try {
      const view = await checker.checkNow();
      await audit(session.userId, 'version.check', view.latestVersion, request);
      const dismissed = await checker.dismissedVersion(session.userId);
      return { ...view, noticeDismissed: view.latestVersion !== null && dismissed === view.latestVersion };
    } catch (error) {
      if (error instanceof UpdateCheckDisabledError) return reply.code(409).send(responseError('UPDATE_CHECK_DISABLED', error.message));
      throw error;
    }
  });

  app.post('/api/v1/version/dismiss', async (request, reply) => {
    const session = await requireAdmin(request, reply);
    if (!session) return;
    const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as Record<string, unknown>;
    const version = typeof body.version === 'string' ? parseSemver(body.version) : null;
    if (!version) return reply.code(400).send(responseError('VALIDATION_ERROR', 'version muss eine Versionsnummer sein.'));
    await checker.dismiss(session.userId, formatSemver(version));
    return reply.code(204).send();
  });
}
