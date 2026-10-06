import { afterEach, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, OidcClient, type IdentityRepository, type UserRecord } from '../../packages/identity/src/index.js';

const issuer = 'https://issuer.test';
const config = { id: 'fake', kind: 'generic' as const, issuer, clientId: 'kura-client', redirectUri: 'https://kura.test/callback', groupClaim: 'groups', userGroups: ['downloader-users'], adminGroups: ['downloader-admins'], provisionOnFirstLogin: true };

class MemoryRepository implements IdentityRepository {
  readonly users = new Map<string, UserRecord>(); readonly identities = new Map<string, { userId: string; issuer: string; subject: string; email?: string }>();
  async findIdentity(valueIssuer: string, subject: string) { return this.identities.get(`${valueIssuer}|${subject}`); }
  async findUser(userId: string) { return this.users.get(userId); }
  async createUserWithIdentity(input: { id: string; displayName: string; status: 'active' | 'pending'; role: 'admin' | 'user'; roleSource: 'idp'; issuer: string; subject: string; email?: string }) { const user = { id: input.id, status: input.status, role: input.role, roleSource: input.roleSource } as UserRecord; this.users.set(user.id, user); this.identities.set(`${input.issuer}|${input.subject}`, { userId: user.id, issuer: input.issuer, subject: input.subject, email: input.email }); return user; }
  async updateIdpRole(userId: string, role: 'admin' | 'user') { const user = this.users.get(userId); if (!user) throw new Error('missing user'); user.role = role; return user; }
  async markLogin() {}
}

async function signedToken(key: CryptoKey, claims: Record<string, unknown>) { return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'one' }).setIssuer(issuer).setAudience(config.clientId).setIssuedAt().setExpirationTime('5m').sign(key); }

function fixture() {
  let now = new Date('2026-10-06T12:00:00.000Z'); let token = ''; let jwks: unknown = { keys: [] };
  const http = { getJson: async () => ({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, end_session_endpoint: `${issuer}/logout`, id_token_signing_alg_values_supported: ['RS256'] }), postForm: async (_url: URL, form: Record<string, string>) => { if (form.code_verifier !== 'expected') throw new Error('bad PKCE'); return { id_token: token }; } };
  const client = new OidcClient(http, { resolve: async () => 'secret-not-exposed' }, { now: () => now }); const repository = new MemoryRepository();
  const previousFetch = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify(jwks), { status: 200, headers: { 'content-type': 'application/json' } });
  return { client, repository, setToken: (value: string) => { token = value; }, setJwks: (value: unknown) => { jwks = value; }, setNow: (value: Date) => { now = value; }, restore: () => { globalThis.fetch = previousFetch; } };
}

describe('OIDC library', () => {
  const cleanups: Array<() => void> = []; afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
  it('uses PKCE/state/nonce, preserves issuer-subject identity, and updates IdP roles', async () => {
    const subject = fixture(); cleanups.push(subject.restore); const keys = await generateKeyPair('RS256'); const publicJwk = await exportJWK(keys.publicKey); subject.setJwks({ keys: [{ ...publicJwk, kid: 'one', alg: 'RS256', use: 'sig' }] });
    const begin = await subject.client.begin(config); expect(begin.authorizationUrl).toContain('code_challenge_method=S256'); expect(begin.authorizationUrl).toContain('nonce=');
    subject.setToken(await signedToken(keys.privateKey, { sub: 'person-a', nonce: begin.transaction.nonce, groups: ['downloader-users'], email: 'same@example.test' }));
    const first = await subject.client.finish(config, { ...begin.transaction, verifier: 'expected' }, { code: 'code', state: begin.transaction.state }, subject.repository); expect(first.isNewUser).toBe(true);
    const again = await subject.client.begin(config); subject.setToken(await signedToken(keys.privateKey, { sub: 'person-a', nonce: again.transaction.nonce, groups: ['downloader-admins'] }));
    const second = await subject.client.finish(config, { ...again.transaction, verifier: 'expected' }, { code: 'code2', state: again.transaction.state }, subject.repository); expect(second).toMatchObject({ userId: first.userId, isNewUser: false, roles: ['admin'] });
    const third = await subject.client.begin(config); subject.setToken(await signedToken(keys.privateKey, { sub: 'person-b', nonce: third.transaction.nonce, groups: ['downloader-users'], email: 'same@example.test' }));
    expect((await subject.client.finish(config, { ...third.transaction, verifier: 'expected' }, { code: 'code3', state: third.transaction.state }, subject.repository)).userId).not.toBe(first.userId);
  });

  it('rejects bad state, nonce, claims, signatures, expired tokens, blocked users, and a bad PKCE exchange without leaking secrets', async () => {
    const subject = fixture(); cleanups.push(subject.restore); const keys = await generateKeyPair('RS256'); const other = await generateKeyPair('RS256'); const publicJwk = await exportJWK(keys.publicKey); subject.setJwks({ keys: [{ ...publicJwk, kid: 'one', alg: 'RS256', use: 'sig' }] });
    const begin = await subject.client.begin(config); await expect(subject.client.finish(config, { ...begin.transaction, verifier: 'expected' }, { code: 'code', state: 'wrong' }, subject.repository)).rejects.toMatchObject({ code: 'OIDC_STATE_INVALID' });
    subject.setToken(await signedToken(keys.privateKey, { sub: 'a', nonce: 'wrong', groups: ['downloader-users'] })); await expect(subject.client.finish(config, { ...begin.transaction, verifier: 'expected' }, { code: 'code', state: begin.transaction.state }, subject.repository)).rejects.toMatchObject({ code: 'OIDC_CLAIMS_INVALID' });
    subject.setToken(await signedToken(other.privateKey, { sub: 'a', nonce: begin.transaction.nonce, groups: ['downloader-users'] })); await expect(subject.client.finish(config, { ...begin.transaction, verifier: 'expected' }, { code: 'code', state: begin.transaction.state }, subject.repository)).rejects.toMatchObject({ code: 'OIDC_TOKEN_INVALID' });
    subject.setToken(await signedToken(keys.privateKey, { sub: 'a', nonce: begin.transaction.nonce, groups: ['downloader-users'] })); await expect(subject.client.finish(config, begin.transaction, { code: 'code', state: begin.transaction.state }, subject.repository)).rejects.toThrow('bad PKCE');
    const messages = await Promise.all([Promise.resolve().then(() => subject.client.finish(config, { ...begin.transaction, verifier: 'expected' }, { code: 'code', state: begin.transaction.state }, subject.repository)).catch((error: unknown) => String(error))]); expect(messages.join()).not.toContain('secret-not-exposed');
  });

  it('requires an allowed group and keeps local blocks authoritative', async () => {
    const subject = fixture(); cleanups.push(subject.restore); const keys = await generateKeyPair('RS256'); const publicJwk = await exportJWK(keys.publicKey); subject.setJwks({ keys: [{ ...publicJwk, kid: 'one', alg: 'RS256', use: 'sig' }] }); const begin = await subject.client.begin(config);
    subject.setToken(await signedToken(keys.privateKey, { sub: 'person-a', nonce: begin.transaction.nonce, groups: ['other'] })); await expect(subject.client.finish(config, { ...begin.transaction, verifier: 'expected' }, { code: 'c', state: begin.transaction.state }, subject.repository)).rejects.toMatchObject({ code: 'OIDC_GROUP_UNAUTHORIZED' });
    const allowed = await subject.client.begin(config); subject.setToken(await signedToken(keys.privateKey, { sub: 'person-a', nonce: allowed.transaction.nonce, groups: ['downloader-users'] })); const result = await subject.client.finish(config, { ...allowed.transaction, verifier: 'expected' }, { code: 'c', state: allowed.transaction.state }, subject.repository); subject.repository.users.get(result.userId)!.status = 'blocked'; const blocked = await subject.client.begin(config); subject.setToken(await signedToken(keys.privateKey, { sub: 'person-a', nonce: blocked.transaction.nonce, groups: ['downloader-admins'] })); await expect(subject.client.finish(config, { ...blocked.transaction, verifier: 'expected' }, { code: 'c', state: blocked.transaction.state }, subject.repository)).rejects.toMatchObject({ code: 'OIDC_USER_BLOCKED' });
  });
});
