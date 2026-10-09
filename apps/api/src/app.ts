import { existsSync } from 'node:fs';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { DatabaseBlobStore, FilesystemBlobStore, type StorageBackend } from '@kura/blobstore';
import type { Writable } from 'node:stream';
import { promisify } from 'node:util';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { OidcClient, OidcError, PostgresIdentityRepository, type LoginTransaction, type OidcProviderConfig } from '@kura/identity';
import type { ApiConfig } from './config.js';
import { registerImmichRoutes } from './immich-routes.js';
import { registerInstagramCredentialRoutes } from './instagram-routes.js';
import { loggerOptions } from './logging.js';
import { registerRuntimePolicyRoutes } from './runtime-policy-routes.js';
import { registerScheduleRoutes } from './schedule-routes.js';
import { registerSourceRoutes } from './source-routes.js';

const scrypt = promisify(scryptCallback) as (password: string | Buffer, salt: string | Buffer, length: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const PASSWORD_MINIMUM = 12;
const PASSWORD_MAXIMUM = 256;
const COMMON_PASSWORDS = new Set(['passwordpassword', 'password123456', '123456789012', 'qwertyuiop12', 'letmeinletmein']);
const DUMMY_HASH = 'scrypt$32768$8$1$MDEyMzQ1Njc4OWFiY2RlZg==$Yb6xNbf1ytwKJC6e7M3Ou6Ii7u8bB3bq0C1t5jRWrqYn95hBD8W+m5wXaOZ6wgFn1wEDsS8yOWlyc4dsTcTHxA==';

type Role = 'admin' | 'user';
type Session = { userId: string; role: Role; csrf: string; mustChangePassword: boolean };
type AuthRequest = FastifyRequest & { session?: Session };
export type AuthClock = { now: () => Date };

function error(code: string, message: string) { return { error: { code, message } }; }
function normalized(value: unknown): string { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }
function string(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function clientAddress(request: FastifyRequest) { return request.ip; }
function cookieOptions(config: ApiConfig) { return { httpOnly: true, sameSite: 'strict' as const, secure: config.cookieSecure ?? true, path: '/' }; }

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }) as Buffer;
  return `scrypt$32768$8$1$${salt.toString('base64')}$${derived.toString('base64')}`;
}
async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, n, r, p, salt, expected] = encoded.split('$');
  if (algorithm !== 'scrypt' || !salt || !expected) return false;
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), Buffer.from(expected, 'base64').length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 }) as Buffer;
  const expectedBuffer = Buffer.from(expected, 'base64');
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}
async function sessionHash(token: string): Promise<string> {
  return ((await scrypt(token, 'kura-session-hash', 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })) as Buffer).toString('base64');
}
function passwordError(password: string): string | undefined {
  if (password.length < PASSWORD_MINIMUM || password.length > PASSWORD_MAXIMUM) return 'Das Passwort muss 12 bis 256 Zeichen lang sein.';
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'Dieses Passwort ist zu häufig.';
  return undefined;
}
function originIsValid(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === request.headers.host; } catch { return false; }
}
async function audit(client: Pool | PoolClient, actor: string | null, action: string, target: string | null, source: string, outcome = 'success') {
  await client.query('INSERT INTO audit_events (id, actor_user_id, action, target_id, outcome, details) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), actor, action, target, outcome, JSON.stringify({ sourceAddress: source })]);
}


export function buildApp(config: ApiConfig, pool: Pool, webDirectory?: string, clock: AuthClock = { now: () => new Date() }, dependencies: { oidcClient?: OidcClient; logStream?: Writable; resolveImmichHost?: (host: string) => Promise<string[]> } = {}): FastifyInstance {
  const app = Fastify({ logger: loggerOptions(dependencies.logStream), trustProxy: config.trustProxy });
  // An idle connection that the database closes (restart, failover) is reported on the pool.
  // Without a listener Node would treat the event as an unhandled error and end the process.
  pool.on('error', (poolError) => app.log.error({ message: poolError.message }, 'database pool error'));
  const storageConfig = config.storage ?? { backend: 'filesystem' as const, root: './data/blobstore', quotaBytes: 10 * 1024 * 1024 * 1024, layout: 'cas' as const };
  const blobstore: StorageBackend = storageConfig.backend === 'database' ? new DatabaseBlobStore(pool, { quotaBytes: storageConfig.quotaBytes }) : new FilesystemBlobStore(storageConfig.root, storageConfig.layout, { quotaBytes: storageConfig.quotaBytes });
  void app.register(fastifyCookie);
  const oidcProvider: OidcProviderConfig | undefined = config.oidc ? {
    id: 'configured', kind: 'generic', issuer: config.oidc.issuer, clientId: config.oidc.clientId, clientSecretRef: 'secret://oidc/configured', redirectUri: config.oidc.redirectUri,
    groupClaim: config.oidc.groupClaim, userGroups: config.oidc.userGroups, adminGroups: config.oidc.adminGroups, provisionOnFirstLogin: true
  } : undefined;
  const oidcClient = dependencies.oidcClient ?? (oidcProvider ? new OidcClient({
    getJson: async (url) => {
      const response = await fetch(url); if (!response.ok) throw new OidcError('OIDC_HTTP_ERROR'); return response.json();
    },
    postForm: async (url, form) => {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) }); if (!response.ok) throw new OidcError('OIDC_HTTP_ERROR'); return response.json();
    }
  }, { resolve: async () => config.oidc!.clientSecret }, clock) : undefined);
  const oidcTransactions = new Map<string, LoginTransaction>();
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Content-Security-Policy', "default-src 'self'"); reply.header('X-Content-Type-Options', 'nosniff'); reply.header('Referrer-Policy', 'no-referrer'); return payload;
  });
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/v1/') || request.method === 'GET' || request.url.startsWith('/api/v1/auth/login') || request.url.startsWith('/api/v1/auth/setup')) return;
    if (!originIsValid(request)) return reply.code(403).send(error('CSRF_REJECTED', 'Die Herkunft der Anfrage ist ungültig.'));
    const session = await getSession(request);
    if (!session || request.headers['x-kura-csrf'] !== session.csrf) return reply.code(403).send(error('CSRF_REJECTED', 'CSRF-Token fehlt oder ist ungültig.'));
    (request as AuthRequest).session = session;
  });
  app.addHook('onResponse', async (request, reply) => {
    if (request.method === 'GET' || !request.url.startsWith('/api/v1/') || request.url.startsWith('/api/v1/auth/login') || reply.statusCode < 400) return;
    const session = (request as AuthRequest).session;
    await audit(pool, session?.userId ?? null, `${request.method.toLowerCase()}.rejected`, request.routeOptions.url ?? request.url.split('?')[0], clientAddress(request), 'failure');
  });
  async function getSession(request: FastifyRequest): Promise<Session | undefined> {
    const token = request.cookies.kura_session; if (!token) return undefined;
    const hash = await sessionHash(token);
    const now = clock.now();
    const result = await pool.query<{ user_id: string; role: Role; csrf_token: string; must_change_password: boolean }>("SELECT s.user_id, u.role, s.csrf_token, COALESCE(c.must_change_password,false) AS must_change_password FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN local_credentials c ON c.user_id=u.id WHERE s.id_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND s.last_seen_at > $2 - interval '2 hours' AND u.status='active'", [hash, now]);
    const row = result.rows[0]; if (!row) return undefined;
    await pool.query("UPDATE sessions SET last_seen_at=$2 WHERE id_hash=$1 AND expires_at > $2", [hash, now]);
    return { userId: row.user_id, role: row.role, csrf: row.csrf_token, mustChangePassword: row.must_change_password };
  }
  async function requireSession(request: FastifyRequest, reply: { code: (n: number) => { send: (v: unknown) => unknown } }): Promise<Session | undefined> {
    const session = (request as AuthRequest).session ?? await getSession(request);
    if (!session) { reply.code(401).send(error('UNAUTHENTICATED', 'Anmeldung erforderlich.')); return undefined; }
    if (session.mustChangePassword && !['/api/v1/auth/change-password', '/api/v1/auth/logout'].includes(request.url)) {
      reply.code(403).send(error('PASSWORD_CHANGE_REQUIRED', 'Das Passwort muss vor weiteren Aktionen geändert werden.'));
      return undefined;
    }
    return session;
  }
  async function createSession(userId: string, reply: { setCookie: (n: string, v: string, o: object) => unknown }) {
    const token = randomBytes(32).toString('base64url'); const tokenHash = await sessionHash(token); const csrf = randomBytes(32).toString('base64url');
    const now = clock.now();
    await pool.query("INSERT INTO sessions (id_hash,user_id,expires_at,last_seen_at,csrf_token) VALUES ($1,$2,$3,$4,$5)", [tokenHash, userId, new Date(now.getTime() + SESSION_ABSOLUTE_MS), now, csrf]);
    reply.setCookie('kura_session', token, { ...cookieOptions(config), maxAge: SESSION_ABSOLUTE_MS / 1000 }); return csrf;
  }
  async function failedLogin(subject: string, source: string, action = 'auth.login_failed') {
    const recordFailure = (attemptSubject: string, attemptSource: string) => pool.query("INSERT INTO login_attempts (subject,source_address,failed_count,locked_until) VALUES ($1,$2,1,NULL) ON CONFLICT (subject,source_address) DO UPDATE SET failed_count=login_attempts.failed_count+1, locked_until=CASE WHEN login_attempts.failed_count+1 >= 5 THEN $3::timestamptz + make_interval(secs => LEAST(900, 30 * power(2, login_attempts.failed_count - 4)::int)) ELSE NULL END, updated_at=$3::timestamptz", [attemptSubject, attemptSource, clock.now()]);
    await Promise.all([recordFailure(subject, '*'), recordFailure('*', source)]);
    await audit(pool, null, action, `login:${subject || 'invalid'}`, source, 'failure');
  }
  app.get('/healthz', async () => { await pool.query('SELECT 1'); return { status: 'ok' }; });
  app.get('/api/v1/status', async () => { const migrations = await pool.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version'); return { version: '0.1.0', database: 'ok', migrations: { appliedCount: migrations.rowCount, latestVersion: migrations.rows.at(-1)?.version ?? null } }; });
  app.get('/api/v1/auth/config', async () => ({ oidcEnabled: Boolean(oidcProvider) }));
  app.get('/api/v1/auth/state', async (request) => { const count = await pool.query('SELECT 1 FROM users LIMIT 1'); const session = await getSession(request); return { configured: count.rowCount !== 0, authenticated: Boolean(session), role: session?.role ?? null, csrfToken: session?.csrf ?? null, passwordChangeRequired: session?.mustChangePassword ?? false, cookieSecure: config.cookieSecure ?? true, oidcEnabled: Boolean(oidcProvider) }; });
  app.get('/api/v1/auth/oidc/start', async (_request, reply) => {
    if (!oidcProvider || !oidcClient) return reply.code(404).send(error('OIDC_DISABLED', 'SSO-Anmeldung ist nicht eingerichtet.'));
    try {
      const started = await oidcClient.begin(oidcProvider); const transactionId = randomBytes(32).toString('base64url'); oidcTransactions.set(transactionId, started.transaction);
      reply.setCookie('kura_oidc_transaction', transactionId, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure ?? true, path: '/api/v1/auth/oidc/', maxAge: 600 });
      return reply.redirect(started.authorizationUrl);
    } catch (cause) { await audit(pool, null, 'auth.oidc_login', 'oidc:start', clientAddress(_request), 'failure'); throw cause; }
  });
  app.get('/api/v1/auth/oidc/callback', async (request, reply) => {
    if (!oidcProvider || !oidcClient) return reply.code(404).send(error('OIDC_DISABLED', 'SSO-Anmeldung ist nicht eingerichtet.'));
    const transactionId = request.cookies.kura_oidc_transaction; const transaction = transactionId ? oidcTransactions.get(transactionId) : undefined;
    if (transactionId) oidcTransactions.delete(transactionId); reply.clearCookie('kura_oidc_transaction', { path: '/api/v1/auth/oidc/' });
    try {
      if (!transaction) throw new OidcError('OIDC_STATE_INVALID');
      const result = await oidcClient.finish(oidcProvider, transaction, request.query as { code?: string; state?: string }, new PostgresIdentityRepository(pool));
      await createSession(result.userId, reply); await audit(pool, result.userId, 'auth.oidc_login', result.userId, clientAddress(request));
      return reply.redirect('/?oidc=success');
    } catch { await audit(pool, null, 'auth.oidc_login', 'oidc:callback', clientAddress(request), 'failure'); return reply.redirect('/?oidc=error'); }
  });
  app.post('/api/v1/auth/setup', async (request, reply) => {
    if (!originIsValid(request)) return reply.code(403).send(error('ORIGIN_REJECTED', 'Die Herkunft der Anfrage ist ungültig.'));
    const body = request.body as Record<string, unknown>; const username = normalized(body.username); const displayName = string(body.displayName); const password = String(body.password ?? '');
    if (config.setupToken && body.setupToken !== config.setupToken) return reply.code(403).send(error('SETUP_TOKEN_INVALID', 'Einrichtung nicht erlaubt.'));
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username) || !displayName || passwordError(password)) return reply.code(400).send(error('VALIDATION_ERROR', passwordError(password) ?? 'Ungültige Kontodaten.'));
    const client = await pool.connect(); try { await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(71821)'); const exists = await client.query('SELECT 1 FROM users LIMIT 1'); if (exists.rowCount) { await client.query('ROLLBACK'); return reply.code(409).send(error('SETUP_ALREADY_COMPLETED', 'Die Einrichtung wurde bereits abgeschlossen.')); }
      const userId = randomUUID(); await client.query("INSERT INTO users (id,display_name,role,status) VALUES ($1,$2,'admin','active')", [userId, displayName]); await client.query('INSERT INTO local_credentials (user_id,login_email_normalized,password_hash) VALUES ($1,$2,$3)', [userId, username, await hashPassword(password)]); await audit(client, userId, 'auth.setup', userId, clientAddress(request)); await client.query('COMMIT'); const csrf = await createSession(userId, reply); return reply.code(201).send({ user: { id: userId, displayName, username, role: 'admin', status: 'active' }, csrfToken: csrf });
    } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
  });
  app.post('/api/v1/auth/login', async (request, reply) => {
    if (!originIsValid(request)) return reply.code(403).send(error('ORIGIN_REJECTED', 'Die Herkunft der Anfrage ist ungültig.'));
    const body = request.body as Record<string, unknown>; const username = normalized(body.username); const password = String(body.password ?? ''); const source = clientAddress(request);
    const limit = await pool.query('SELECT locked_until FROM login_attempts WHERE (subject=$1 AND source_address=$3) OR (subject=$3 AND source_address=$2)', [username, source, '*']); if (limit.rows.some((row) => row.locked_until && new Date(row.locked_until) > clock.now())) { await audit(pool, null, 'auth.login_locked', `login:${username || 'invalid'}`, source, 'failure'); return reply.code(401).send(error('LOGIN_FAILED', 'Anmeldung fehlgeschlagen.')); }
    const found = await pool.query<{ user_id: string; password_hash: string; status: string; must_change_password: boolean }>('SELECT c.user_id,c.password_hash,c.must_change_password,u.status FROM local_credentials c JOIN users u ON u.id=c.user_id WHERE c.login_email_normalized=$1', [username]); const account = found.rows[0]; const valid = await verifyPassword(password, account?.password_hash ?? DUMMY_HASH);
    if (!account || !valid || account.status !== 'active') { await failedLogin(username, source); return reply.code(401).send(error('LOGIN_FAILED', 'Anmeldung fehlgeschlagen.')); }
    await pool.query("DELETE FROM login_attempts WHERE subject=$1 AND source_address='*'", [username]); const csrf = await createSession(account.user_id, reply); await audit(pool, account.user_id, 'auth.login', account.user_id, source); return { csrfToken: csrf, passwordChangeRequired: account.must_change_password };
  });
  app.post('/api/v1/auth/logout', async (request, reply) => { const session = await requireSession(request, reply); if (!session) return; await pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND csrf_token=$2 AND revoked_at IS NULL', [session.userId, session.csrf]); reply.clearCookie('kura_session', cookieOptions(config)); await audit(pool, session.userId, 'auth.logout', session.userId, clientAddress(request)); return reply.code(204).send(); });
  app.get('/api/v1/users', async (request, reply) => { const session = await requireSession(request, reply); if (!session) return; const query = session.role === 'admin' ? 'SELECT u.id,u.display_name,u.role,u.status,u.created_at,COALESCE(c.login_email_normalized, i.subject) AS username FROM users u LEFT JOIN local_credentials c ON c.user_id=u.id LEFT JOIN identities i ON i.user_id=u.id ORDER BY u.created_at' : 'SELECT u.id,u.display_name,u.role,u.status,u.created_at,COALESCE(c.login_email_normalized, i.subject) AS username FROM users u LEFT JOIN local_credentials c ON c.user_id=u.id LEFT JOIN identities i ON i.user_id=u.id WHERE u.id=$1'; const result = await pool.query(query, session.role === 'admin' ? [] : [session.userId]); return { users: result.rows }; });
  app.get('/api/v1/users/:id', async (request, reply) => { const session = await requireSession(request, reply); if (!session) return; const targetId = (request.params as { id: string }).id; if (session.role !== 'admin' && targetId !== session.userId) return reply.code(403).send(error('FORBIDDEN', 'Zugriff verweigert.')); const result = await pool.query('SELECT u.id,u.display_name,u.role,u.status,u.created_at,c.login_email_normalized AS username FROM users u JOIN local_credentials c ON c.user_id=u.id WHERE u.id=$1', [targetId]); if (!result.rowCount) return reply.code(404).send(error('NOT_FOUND', 'Benutzer nicht gefunden.')); return { user: result.rows[0] }; });
  app.post('/api/v1/users', async (request, reply) => { const session = await requireSession(request, reply); if (!session) return; if (session.role !== 'admin') return reply.code(403).send(error('FORBIDDEN', 'Administratorrechte erforderlich.')); const body = request.body as Record<string, unknown>; const username = normalized(body.username); const displayName = string(body.displayName); const role = body.role === 'admin' ? 'admin' : 'user'; const password = String(body.initialPassword ?? ''); if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username) || !displayName || passwordError(password)) return reply.code(400).send(error('VALIDATION_ERROR', passwordError(password) ?? 'Ungültige Benutzerdaten.')); const id = randomUUID(); const client = await pool.connect(); try { await client.query('BEGIN'); await client.query("INSERT INTO users (id,display_name,role,status) VALUES ($1,$2,$3,'active')", [id, displayName, role]); await client.query('INSERT INTO local_credentials (user_id,login_email_normalized,password_hash,must_change_password) VALUES ($1,$2,$3,true)', [id, username, await hashPassword(password)]); await audit(client, session.userId, 'user.create', id, clientAddress(request)); await client.query('COMMIT'); return reply.code(201).send({ user: { id, username, displayName, role, status: 'active' } }); } catch (cause) { await client.query('ROLLBACK'); if ((cause as { code?: string }).code === '23505') return reply.code(409).send(error('USERNAME_TAKEN', 'Benutzername bereits vergeben.')); throw cause; } finally { client.release(); } });
  app.patch('/api/v1/users/:id', async (request, reply) => { const session = await requireSession(request, reply); if (!session) return; if (session.role !== 'admin') return reply.code(403).send(error('FORBIDDEN', 'Administratorrechte erforderlich.')); const targetId = (request.params as { id: string }).id; const body = request.body as Record<string, unknown>; const requestedStatus = body.status === 'blocked' || body.status === 'active' ? body.status : undefined; const requestedRole = body.role === 'admin' || body.role === 'user' ? body.role : undefined; if (!requestedStatus && !requestedRole) return reply.code(400).send(error('VALIDATION_ERROR', 'Keine gültige Änderung.')); const target = await pool.query<{ role: Role; status: string }>('SELECT role,status FROM users WHERE id=$1', [targetId]); if (!target.rowCount) return reply.code(404).send(error('NOT_FOUND', 'Benutzer nicht gefunden.')); if (targetId === session.userId && (requestedStatus === 'blocked' || requestedRole === 'user') && target.rows[0].role === 'admin') { const admins = await pool.query("SELECT count(*)::int AS count FROM users WHERE role='admin' AND status='active'"); if (admins.rows[0].count <= 1) return reply.code(409).send(error('LAST_ADMIN_PROTECTED', 'Der letzte aktive Administrator kann nicht gesperrt oder herabgestuft werden.')); }
    await pool.query('UPDATE users SET status=COALESCE($2,status),role=COALESCE($3,role),updated_at=now() WHERE id=$1', [targetId, requestedStatus ?? null, requestedRole ?? null]); if (requestedStatus === 'blocked') await pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [targetId]); await audit(pool, session.userId, 'user.update', targetId, clientAddress(request)); return reply.code(204).send(); });
  app.post('/api/v1/auth/change-password', async (request, reply) => { const session = await requireSession(request, reply); if (!session) return; const body = request.body as Record<string, unknown>; const current = String(body.currentPassword ?? ''); const next = String(body.newPassword ?? ''); const violation = passwordError(next); if (violation) return reply.code(400).send(error('VALIDATION_ERROR', violation)); const credential = await pool.query<{ password_hash: string }>('SELECT password_hash FROM local_credentials WHERE user_id=$1', [session.userId]); if (!credential.rowCount || !await verifyPassword(current, credential.rows[0].password_hash)) return reply.code(401).send(error('PASSWORD_INVALID', 'Aktuelles Passwort ist ungültig.')); await pool.query('UPDATE local_credentials SET password_hash=$2,must_change_password=false WHERE user_id=$1', [session.userId, await hashPassword(next)]); await pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND csrf_token<>$2 AND revoked_at IS NULL', [session.userId, session.csrf]); await audit(pool, session.userId, 'auth.change_password', session.userId, clientAddress(request)); return reply.code(204).send(); });
  registerImmichRoutes({
    app,
    pool,
    config,
    blobstore,
    clock,
    requireSession,
    resolveHost: dependencies.resolveImmichHost,
    audit: (actor, action, target, request, outcome) => audit(pool, actor, action, target, clientAddress(request), outcome)
  });
  const auditRoute = (actor: string | null, action: string, target: string | null, request: FastifyRequest, outcome?: string) =>
    audit(pool, actor, action, target, clientAddress(request), outcome);
  registerScheduleRoutes({ app, pool, clock, requireSession, audit: auditRoute });
  registerInstagramCredentialRoutes({ app, pool, config, clock, requireSession, audit: auditRoute });
  registerRuntimePolicyRoutes({ app, pool, requireSession, audit: auditRoute });
  registerSourceRoutes({ app, pool, clock, requireSession, audit: auditRoute });
  if (webDirectory && existsSync(webDirectory)) { void app.register(fastifyStatic, { root: webDirectory, index: ['index.html'], cacheControl: false, setHeaders: (reply, filePath) => reply.header('Cache-Control', filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable') }); app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') || request.url === '/healthz' ? reply.code(404).send({ statusCode: 404, ...error('NOT_FOUND', 'Nicht gefunden.') }) : reply.type('text/html').sendFile('index.html')); }
  app.addHook('onClose', async () => { await pool.end(); }); return app;
}
