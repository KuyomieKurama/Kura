import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair, OidcClient, SignJWT } from '../../packages/identity/src/index.js';
import { buildApp } from '../../apps/api/src/app.js';
import { runMigrations } from '../../packages/storage/src/migrator.js';
import { createMigrationsCopy, createTestDatabase } from '../helpers/database.js';
import { startFakeOidcProvider } from '../identity/fake-oidc-provider.js';

const issuer = 'https://issuer.test';
const config = {
  databaseUrl: 'not-logged', host: '127.0.0.1', port: 8080, trustProxy: false, cookieSecure: false,
  oidc: { issuer, clientId: 'kura-client', clientSecret: 'test-secret', redirectUri: 'https://kura.test/api/v1/auth/oidc/callback', groupClaim: 'groups', userGroups: ['downloader-users'], adminGroups: ['downloader-admins'] }
};

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(subject = 'person-a', tokenNonce?: string) {
  const keys = await generateKeyPair('RS256'); const publicJwk = await exportJWK(keys.publicKey);
  let nonce = ''; let idToken = '';
  const fake = await startFakeOidcProvider({ issuer, jwks: { keys: [{ ...publicJwk, kid: 'one', alg: 'RS256', use: 'sig' }] }, idToken: 'unused-by-api-token-stub' });
  const database = await createTestDatabase(); const migrations = await createMigrationsCopy(); await runMigrations(database.pool, migrations.directory);
  const map = (url: URL) => new URL(`${url.pathname}${url.search}`, fake.endpoint);
  const client = new OidcClient({
    getJson: async (url) => { const response = await fetch(map(url)); return response.json(); },
    postForm: async () => ({ id_token: idToken })
  }, { resolve: async () => 'test-secret' });
  const oldFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return oldFetch(url.origin === issuer ? map(url) : url, init);
  }) as typeof fetch;
  const originalBegin = client.begin.bind(client);
  client.begin = async (provider) => { const started = await originalBegin(provider); nonce = started.transaction.nonce; idToken = await new SignJWT({ sub: subject, nonce: tokenNonce ?? nonce, groups: ['downloader-users'], email: 'same@example.test' }).setProtectedHeader({ alg: 'RS256', kid: 'one' }).setIssuer(issuer).setAudience(config.oidc.clientId).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey); return started; };
  const app = buildApp(config, new Pool({ connectionString: database.databaseUrl }), undefined, undefined, { oidcClient: client });
  return { app, database, migrations, fake, oldFetch, cleanup: async () => { globalThis.fetch = oldFetch; await app.close(); await fake.close(); await migrations.cleanup(); await database.cleanup(); } };
}

describe('OIDC API login', () => {
  const fixtures: Fixture[] = [];
  afterEach(async () => { await Promise.all(fixtures.splice(0).map((item) => item.cleanup())); });
  it('creates a stable issuer-subject user session through the local fake provider and keeps local login available', async () => {
    const subject = await fixture(); fixtures.push(subject);
    expect((await subject.app.inject({ url: '/api/v1/auth/config' })).json()).toEqual({ oidcEnabled: true });
    const start = await subject.app.inject({ url: '/api/v1/auth/oidc/start' });
    expect(start.statusCode).toBe(302); expect(start.headers.location).toContain('code_challenge_method=S256');
    const authorization = await fetch(new URL(start.headers.location!), { redirect: 'manual' });
    const callback = new URL(authorization.headers.get('location')!);
    const callbackResponse = await subject.app.inject({ url: `${callback.pathname}${callback.search}`, headers: { cookie: start.headers['set-cookie'] as string } });
    expect(callbackResponse.statusCode).toBe(302); expect(callbackResponse.headers.location).toBe('/?oidc=success');
    const callbackCookies = callbackResponse.headers['set-cookie']; const sessionCookie = (Array.isArray(callbackCookies) ? callbackCookies : [callbackCookies]).find((cookie) => cookie?.startsWith('kura_session='))!;
    expect((await subject.app.inject({ url: '/api/v1/auth/state', headers: { cookie: sessionCookie } })).json().authenticated).toBe(true);
    const identity = await subject.database.pool.query('SELECT issuer,subject,user_id FROM identities'); expect(identity.rows).toHaveLength(1); expect(identity.rows[0]).toMatchObject({ issuer, subject: 'person-a' });
    const second = await subject.app.inject({ url: '/api/v1/auth/oidc/start' }); const secondAuthorization = await fetch(new URL(second.headers.location!), { redirect: 'manual' }); const secondCallback = new URL(secondAuthorization.headers.get('location')!);
    await subject.app.inject({ url: `${secondCallback.pathname}${secondCallback.search}`, headers: { cookie: second.headers['set-cookie'] as string } });
    expect((await subject.database.pool.query('SELECT * FROM identities')).rowCount).toBe(1);
  });
  it('rejects a callback with a wrong state and audits failure without code or token', async () => {
    const subject = await fixture(); fixtures.push(subject);
    const start = await subject.app.inject({ url: '/api/v1/auth/oidc/start' });
    const rejected = await subject.app.inject({ url: '/api/v1/auth/oidc/callback?code=untrusted-code&state=wrong', headers: { cookie: start.headers['set-cookie'] as string } });
    expect(rejected.statusCode).toBe(302); expect(rejected.headers.location).toBe('/?oidc=error');
    const audit = await subject.database.pool.query("SELECT action,outcome,details FROM audit_events WHERE action='auth.oidc_login'");
    expect(audit.rows).toHaveLength(1); expect(JSON.stringify(audit.rows)).not.toContain('untrusted-code');
  });
  it('rejects an ID token with a wrong nonce', async () => {
    const subject = await fixture('person-b', 'wrong-nonce'); fixtures.push(subject);
    const start = await subject.app.inject({ url: '/api/v1/auth/oidc/start' });
    const authorization = await fetch(new URL(start.headers.location!), { redirect: 'manual' });
    const callback = new URL(authorization.headers.get('location')!);
    const rejected = await subject.app.inject({ url: `${callback.pathname}${callback.search}`, headers: { cookie: start.headers['set-cookie'] as string } });
    expect(rejected.statusCode).toBe(302); expect(rejected.headers.location).toBe('/?oidc=error');
    expect((await subject.database.pool.query('SELECT * FROM identities')).rowCount).toBe(0);
  });
  it('leaves the local login flow available when OIDC is disabled', async () => {
    const database = await createTestDatabase(); const migrations = await createMigrationsCopy(); await runMigrations(database.pool, migrations.directory);
    const app = buildApp({ databaseUrl: 'not-logged', host: '127.0.0.1', port: 8080, trustProxy: false, cookieSecure: false }, new Pool({ connectionString: database.databaseUrl }));
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'admin', displayName: 'Admin', password: 'correct horse battery staple' } });
    expect(setup.statusCode).toBe(201); expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'correct horse battery staple' } })).statusCode).toBe(200); expect((await app.inject({ url: '/api/v1/auth/config' })).json()).toEqual({ oidcEnabled: false });
    await app.close(); await migrations.cleanup(); await database.cleanup();
  });
});
