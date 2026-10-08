import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import {
  InvalidCronExpressionError,
  InvalidScheduleRuleError,
  InvalidTimeZoneError,
  JobQueue,
  NotFoundError,
  SubscriptionBusyError,
  SubscriptionRepository,
  previewSchedule,
  type Candidate,
  type JobRunRecord,
  type ScheduleRecord,
  type ScheduleRule,
  type SubscriptionRecord
} from '@kura/scheduler';
import { responseError, type Audit, type RequireSession, type RouteSession } from './route-helpers.js';

const MAX_NAME_LENGTH = 200;
const MAX_TARGET_LENGTH = 2048;
const MAX_CRON_LENGTH = 200;
const MAX_JITTER_SECONDS = 3600;
const DEFAULT_PREVIEW_COUNT = 5;
const MAX_PREVIEW_COUNT = 20;
const DEFAULT_RUN_LIMIT = 20;
const MAX_RUN_LIMIT = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLATFORM_HINT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Control characters would only make later processing harder (NUL is rejected by PostgreSQL text).
function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

class ValidationError extends Error {}

type PlainObject = Record<string, unknown>;

function asObject(value: unknown): PlainObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError('Die Anfrage muss ein JSON-Objekt sein.');
  return value as PlainObject;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ValidationError(`${field} ist erforderlich.`);
  const text = value.trim();
  if (text.length > maxLength) throw new ValidationError(`${field} darf höchstens ${maxLength} Zeichen lang sein.`);
  if (hasControlCharacter(text)) throw new ValidationError(`${field} enthält ungültige Zeichen.`);
  return text;
}

function optionalPlatformHint(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !PLATFORM_HINT_PATTERN.test(value)) {
    throw new ValidationError('Der Plattformhinweis darf nur Kleinbuchstaben, Ziffern, "-" und "_" enthalten (höchstens 64 Zeichen).');
  }
  return value;
}

function integerInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(`${field} muss eine ganze Zahl zwischen ${min} und ${max} sein.`);
  }
  return value;
}

/** Builds a rule from request data. Only known fields are taken over; semantic checks are done by the scheduler package. */
function parseRule(input: unknown, now: Date): ScheduleRule {
  const rule = asObject(input);
  const timeZone = requiredText(rule.timeZone, 'Die Zeitzone', 64);
  if (rule.kind === 'cron') {
    const gapPolicy = rule.gapPolicy ?? 'skip';
    if (gapPolicy !== 'skip' && gapPolicy !== 'run_after_gap') throw new ValidationError('Die Lückenregel muss "skip" oder "run_after_gap" sein.');
    return { kind: 'cron', expression: requiredText(rule.expression, 'Der Cron-Ausdruck', MAX_CRON_LENGTH), timeZone, gapPolicy };
  }
  if (rule.kind === 'interval') {
    return {
      kind: 'interval',
      everySeconds: integerInRange(rule.everySeconds, 'Das Intervall', 60, 366 * 86_400),
      anchorUtc: rule.anchorUtc === undefined ? now.toISOString() : requiredText(rule.anchorUtc, 'Der Ankerzeitpunkt', 64),
      timeZone
    };
  }
  if (rule.kind === 'once') {
    return { kind: 'once', atUtc: requiredText(rule.atUtc, 'Der Zeitpunkt', 64), timeZone };
  }
  throw new ValidationError('Die Regelart muss "cron", "interval" oder "once" sein.');
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const rest = String(absolute % 60).padStart(2, '0');
  return `${sign}${hours}:${rest}`;
}

function presentCandidate(candidate: Candidate) {
  return {
    scheduledForUtc: candidate.scheduledForUtc,
    localPlanTime: candidate.localPlanTime,
    timeZone: candidate.timeZone,
    utcOffset: candidate.utcOffsetMinutes === null ? null : formatOffset(candidate.utcOffsetMinutes),
    status: candidate.status
  };
}

function presentSchedule(schedule: ScheduleRecord) {
  return {
    id: schedule.id,
    subscriptionId: schedule.subscriptionId,
    version: schedule.version,
    rule: schedule.rule,
    jitterMaxSeconds: schedule.jitterMaxSeconds,
    enabled: schedule.enabled,
    nextDueAt: schedule.nextDueAt,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt
  };
}

function presentSubscription(subscription: SubscriptionRecord, schedules?: ScheduleRecord[]) {
  return {
    id: subscription.id,
    name: subscription.name,
    targetUrl: subscription.sourceRef,
    platformHint: subscription.platformHint,
    targetState: subscription.targetState,
    status: subscription.status,
    pausedAt: subscription.pausedAt,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
    ...(schedules ? { schedules: schedules.map(presentSchedule) } : {})
  };
}

function presentRun(run: JobRunRecord) {
  return {
    id: run.id,
    triggerKind: run.triggerKind,
    state: run.state,
    scheduledFor: run.scheduledFor,
    runAfter: run.runAfter,
    attempts: run.attempts,
    maxAttempts: run.maxAttempts,
    lastError: run.lastError,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt
  };
}

function sendKnownError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ValidationError) return reply.code(400).send(responseError('VALIDATION_ERROR', error.message));
  if (
    error instanceof InvalidScheduleRuleError ||
    error instanceof InvalidCronExpressionError ||
    error instanceof InvalidTimeZoneError
  ) {
    return reply.code(400).send(responseError('INVALID_SCHEDULE', `Der Zeitplan ist ungültig: ${error.message}`));
  }
  if (error instanceof NotFoundError) return reply.code(404).send(responseError('NOT_FOUND', 'Nicht gefunden.'));
  if (error instanceof SubscriptionBusyError) {
    return reply.code(409).send(responseError('SUBSCRIPTION_BUSY', 'Für dieses Abonnement läuft gerade ein Auftrag. Pausieren Sie es und löschen Sie es danach.'));
  }
  throw error;
}

/**
 * Subscriptions, schedules, previews and run history (plan 07). Every call uses the user id of the
 * session; the repositories filter by it, so another user's ids behave exactly like unknown ids (404).
 */
export function registerScheduleRoutes(input: {
  app: FastifyInstance;
  pool: Pool;
  clock: { now: () => Date };
  requireSession: RequireSession;
  audit: Audit;
}): void {
  const { app, pool, clock, requireSession, audit } = input;
  const subscriptions = new SubscriptionRepository(pool, clock);
  const queue = new JobQueue(pool, { clock });

  type Handler = (request: FastifyRequest, reply: FastifyReply, session: RouteSession) => Promise<unknown>;
  const authenticated = (handler: Handler) => async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await requireSession(request, reply);
    if (!session) return reply;
    try {
      return await handler(request, reply, session);
    } catch (error) {
      return sendKnownError(reply, error);
    }
  };
  // A malformed id cannot belong to anyone: answer like an unknown id instead of failing in PostgreSQL.
  const checkedId = (value: unknown): string => {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new NotFoundError('Object');
    return value.toLowerCase();
  };
  const idOf = (request: FastifyRequest) => checkedId((request.params as { id: string }).id);

  app.get('/api/v1/subscriptions', authenticated(async (_request, _reply, session) => {
    const [list, schedules] = await Promise.all([
      subscriptions.listSubscriptions(session.userId),
      subscriptions.listSchedules(session.userId)
    ]);
    return {
      subscriptions: list.map((subscription) =>
        presentSubscription(subscription, schedules.filter((schedule) => schedule.subscriptionId === subscription.id)))
    };
  }));

  app.post('/api/v1/subscriptions', authenticated(async (request, reply, session) => {
    const body = asObject(request.body);
    const created = await subscriptions.createSubscription({
      userId: session.userId,
      name: requiredText(body.name, 'Der Name', MAX_NAME_LENGTH),
      sourceRef: requiredText(body.targetUrl, 'Die Ziel-URL', MAX_TARGET_LENGTH),
      platformHint: optionalPlatformHint(body.platformHint) ?? undefined
    });
    await audit(session.userId, 'subscription.create', created.id, request);
    return reply.code(201).send({ subscription: presentSubscription(created, []) });
  }));

  app.get('/api/v1/subscriptions/:id', authenticated(async (request, _reply, session) => {
    const subscription = await subscriptions.getSubscription(session.userId, idOf(request));
    const schedules = await subscriptions.listSchedules(session.userId, subscription.id);
    return { subscription: presentSubscription(subscription, schedules) };
  }));

  app.patch('/api/v1/subscriptions/:id', authenticated(async (request, _reply, session) => {
    const body = asObject(request.body);
    const changes: Parameters<SubscriptionRepository['updateSubscription']>[2] = {};
    if (body.name !== undefined) changes.name = requiredText(body.name, 'Der Name', MAX_NAME_LENGTH);
    if (body.targetUrl !== undefined) changes.sourceRef = requiredText(body.targetUrl, 'Die Ziel-URL', MAX_TARGET_LENGTH);
    if (body.platformHint !== undefined) changes.platformHint = optionalPlatformHint(body.platformHint);
    if (Object.keys(changes).length === 0) throw new ValidationError('Keine gültige Änderung.');

    const updated = await subscriptions.updateSubscription(session.userId, idOf(request), changes);
    await audit(session.userId, 'subscription.update', updated.id, request);
    const schedules = await subscriptions.listSchedules(session.userId, updated.id);
    return { subscription: presentSubscription(updated, schedules) };
  }));

  app.delete('/api/v1/subscriptions/:id', authenticated(async (request, reply, session) => {
    await subscriptions.deleteSubscription(session.userId, idOf(request));
    await audit(session.userId, 'subscription.delete', idOf(request), request);
    return reply.code(204).send();
  }));

  app.post('/api/v1/subscriptions/:id/pause', authenticated(async (request, _reply, session) => {
    const paused = await subscriptions.pauseSubscription(session.userId, idOf(request));
    await audit(session.userId, 'subscription.pause', paused.id, request);
    return { subscription: presentSubscription(paused) };
  }));

  app.post('/api/v1/subscriptions/:id/resume', authenticated(async (request, _reply, session) => {
    const resumed = await subscriptions.resumeSubscription(session.userId, idOf(request));
    await audit(session.userId, 'subscription.resume', resumed.id, request);
    return { subscription: presentSubscription(resumed) };
  }));

  app.get('/api/v1/subscriptions/:id/runs', authenticated(async (request, _reply, session) => {
    const rawLimit = (request.query as { limit?: string }).limit;
    const limit = rawLimit === undefined ? DEFAULT_RUN_LIMIT : Number(rawLimit);
    integerInRange(limit, 'Das Limit', 1, MAX_RUN_LIMIT);
    // Existence and ownership are checked first, so a foreign id yields 404 and never an empty list.
    const subscription = await subscriptions.getSubscription(session.userId, idOf(request));
    const runs = await queue.listRecentRuns(session.userId, subscription.id, limit);
    return { runs: runs.map(presentRun) };
  }));

  app.get('/api/v1/schedules', authenticated(async (request, _reply, session) => {
    const rawSubscriptionId = (request.query as { subscriptionId?: string }).subscriptionId;
    const subscriptionId = rawSubscriptionId === undefined ? undefined : checkedId(rawSubscriptionId);
    if (subscriptionId !== undefined) await subscriptions.getSubscription(session.userId, subscriptionId);
    const schedules = await subscriptions.listSchedules(session.userId, subscriptionId);
    return { schedules: schedules.map(presentSchedule) };
  }));

  app.post('/api/v1/schedules', authenticated(async (request, reply, session) => {
    const body = asObject(request.body);
    const subscriptionId = checkedId(body.subscriptionId);
    const created = await subscriptions.createSchedule({
      userId: session.userId,
      subscriptionId,
      rule: parseRule(body.rule, clock.now()),
      jitterMaxSeconds: body.jitterMaxSeconds === undefined ? undefined : integerInRange(body.jitterMaxSeconds, 'Die Startverzögerung', 0, MAX_JITTER_SECONDS)
    });
    await audit(session.userId, 'schedule.create', created.id, request);
    return reply.code(201).send({ schedule: presentSchedule(created) });
  }));

  app.patch('/api/v1/schedules/:id', authenticated(async (request, _reply, session) => {
    const body = asObject(request.body);
    const changes: Parameters<SubscriptionRepository['updateSchedule']>[2] = {};
    if (body.rule !== undefined) changes.rule = parseRule(body.rule, clock.now());
    if (body.jitterMaxSeconds !== undefined) changes.jitterMaxSeconds = integerInRange(body.jitterMaxSeconds, 'Die Startverzögerung', 0, MAX_JITTER_SECONDS);
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw new ValidationError('"enabled" muss true oder false sein.');
      changes.enabled = body.enabled;
    }
    if (Object.keys(changes).length === 0) throw new ValidationError('Keine gültige Änderung.');

    const updated = await subscriptions.updateSchedule(session.userId, idOf(request), changes);
    await audit(session.userId, 'schedule.update', updated.id, request);
    return { schedule: presentSchedule(updated) };
  }));

  app.delete('/api/v1/schedules/:id', authenticated(async (request, reply, session) => {
    await subscriptions.deleteSchedule(session.userId, idOf(request));
    await audit(session.userId, 'schedule.delete', idOf(request), request);
    return reply.code(204).send();
  }));

  // Stateless: needs a session (so it is not an open CPU endpoint) but touches no stored data.
  app.post('/api/v1/schedules/preview', authenticated(async (request) => {
    const body = asObject(request.body);
    const now = clock.now();
    const count = body.count === undefined ? DEFAULT_PREVIEW_COUNT : integerInRange(body.count, 'Die Anzahl', 1, MAX_PREVIEW_COUNT);
    const rule = parseRule(body.rule, now);
    return { from: now, entries: previewSchedule(rule, now, count).map(presentCandidate) };
  }));
}
