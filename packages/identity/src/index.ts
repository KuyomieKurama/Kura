import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Pool } from 'pg';
export { exportJWK, generateKeyPair, SignJWT } from 'jose';

export type Role = 'admin' | 'user';
export type Clock = { now: () => Date };
export type HttpClient = { getJson: (url: URL) => Promise<unknown>; postForm: (url: URL, form: Record<string, string>) => Promise<unknown> };
export type SecretResolver = { resolve: (reference: string) => Promise<string> };
export type OidcProfileKind = 'authentik' | 'keycloak' | 'generic';

export interface OidcProviderConfig {
  id: string;
  kind: OidcProfileKind;
  issuer: string;
  clientId: string;
  clientSecretRef?: string;
  redirectUri: string;
  groupClaim: string;
  userGroups: readonly string[];
  adminGroups: readonly string[];
  provisionOnFirstLogin: boolean;
  authorizationParams?: Readonly<Record<string, string>>;
  allowedAlgorithms?: readonly string[];
}

export interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  id_token_signing_alg_values_supported?: string[];
}

export interface LoginTransaction {
  providerId: string;
  state: string;
  nonce: string;
  verifier: string;
  createdAt: Date;
}

export interface IdentityRecord { userId: string; issuer: string; subject: string; email?: string; }
export interface UserRecord { id: string; status: 'active' | 'blocked' | 'pending'; role: Role; roleSource: 'local' | 'idp'; }
export interface IdentityRepository {
  findIdentity(issuer: string, subject: string): Promise<IdentityRecord | undefined>;
  findUser(userId: string): Promise<UserRecord | undefined>;
  createUserWithIdentity(input: { id: string; displayName: string; status: 'active' | 'pending'; role: Role; roleSource: 'idp'; issuer: string; subject: string; email?: string }): Promise<UserRecord>;
  updateIdpRole(userId: string, role: Role): Promise<UserRecord>;
  markLogin(issuer: string, subject: string): Promise<void>;
}

export interface LoginResult { userId: string; isNewUser: boolean; roles: Role[]; idTokenHint: string; }

export class PostgresIdentityRepository implements IdentityRepository {
  constructor(private readonly pool: Pool) {}
  async findIdentity(issuer: string, subject: string): Promise<IdentityRecord | undefined> {
    const result = await this.pool.query<IdentityRecord>('SELECT user_id AS "userId", issuer, subject, email FROM identities WHERE issuer=$1 AND subject=$2', [issuer, subject]); return result.rows[0];
  }
  async findUser(userId: string): Promise<UserRecord | undefined> {
    const result = await this.pool.query<UserRecord>('SELECT id,status,role,role_source AS "roleSource" FROM users WHERE id=$1', [userId]); return result.rows[0];
  }
  async createUserWithIdentity(input: { id: string; displayName: string; status: 'active' | 'pending'; role: Role; roleSource: 'idp'; issuer: string; subject: string; email?: string }): Promise<UserRecord> {
    const client = await this.pool.connect(); try { await client.query('BEGIN'); await client.query('INSERT INTO users (id,display_name,status,role,role_source) VALUES ($1,$2,$3,$4,$5)', [input.id, input.displayName, input.status, input.role, input.roleSource]); await client.query('INSERT INTO identities (id,user_id,issuer,subject,email,last_login_at) VALUES ($1,$2,$3,$4,$5,now())', [randomUUID(), input.id, input.issuer, input.subject, input.email ?? null]); await client.query('COMMIT'); return { id: input.id, status: input.status, role: input.role, roleSource: input.roleSource }; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async updateIdpRole(userId: string, role: Role): Promise<UserRecord> {
    const result = await this.pool.query<UserRecord>("UPDATE users SET role=$2, updated_at=now() WHERE id=$1 AND role_source='idp' RETURNING id,status,role,role_source AS \"roleSource\"", [userId, role]); const user = result.rows[0]; if (!user) throw new OidcError('OIDC_IDENTITY_ORPHANED'); return user;
  }
  async markLogin(issuer: string, subject: string): Promise<void> { await this.pool.query('UPDATE identities SET last_login_at=now() WHERE issuer=$1 AND subject=$2', [issuer, subject]); }
}

export class OidcError extends Error { constructor(public readonly code: string) { super(code); this.name = 'OidcError'; } }

const DEFAULT_ALGORITHMS: string[] = ['RS256', 'ES256', 'PS256'];
const DISCOVERY_TTL_MS = 5 * 60_000;
const TRANSACTION_MAX_AGE_MS = 10 * 60_000;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OidcError('OIDC_RESPONSE_INVALID');
  return value as Record<string, unknown>;
}
function requiredString(record: Record<string, unknown>, key: string): string {
  if (typeof record[key] !== 'string' || record[key] === '') throw new OidcError('OIDC_DISCOVERY_INVALID');
  return record[key] as string;
}
function randomUrlValue(): string { return randomBytes(32).toString('base64url'); }
function sha256Base64Url(value: string): string { return createHash('sha256').update(value).digest('base64url'); }
function exactGroups(value: unknown): string[] {
  return Array.isArray(value) && value.length <= 100 && value.every((v) => typeof v === 'string' && v.length <= 256) ? value : [];
}
function validateProvider(config: OidcProviderConfig): URL {
  const issuer = new URL(config.issuer);
  const redirect = new URL(config.redirectUri);
  if (issuer.protocol !== 'https:' || redirect.protocol !== 'https:' || !config.id || !config.clientId || !config.groupClaim) throw new OidcError('OIDC_CONFIG_INVALID');
  if (config.clientSecretRef && !config.clientSecretRef.startsWith('secret://')) throw new OidcError('OIDC_SECRET_REFERENCE_INVALID');
  return issuer;
}

export class OidcClient {
  private readonly clock: Clock;
  private readonly discoveryCache = new Map<string, { value: DiscoveryDocument; expiresAt: number }>();
  private readonly jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
  constructor(private readonly http: HttpClient, private readonly secrets: SecretResolver, clock: Clock = { now: () => new Date() }) { this.clock = clock; }

  async discovery(config: OidcProviderConfig): Promise<DiscoveryDocument> {
    const issuer = validateProvider(config); const key = issuer.href;
    const cached = this.discoveryCache.get(key);
    if (cached && cached.expiresAt > this.clock.now().getTime()) return cached.value;
    const raw = asRecord(await this.http.getJson(new URL('.well-known/openid-configuration', issuer)));
    const value: DiscoveryDocument = {
      issuer: requiredString(raw, 'issuer'), authorization_endpoint: requiredString(raw, 'authorization_endpoint'), token_endpoint: requiredString(raw, 'token_endpoint'), jwks_uri: requiredString(raw, 'jwks_uri'),
      ...(typeof raw.end_session_endpoint === 'string' ? { end_session_endpoint: raw.end_session_endpoint } : {}),
      ...(Array.isArray(raw.id_token_signing_alg_values_supported) ? { id_token_signing_alg_values_supported: raw.id_token_signing_alg_values_supported.filter((v): v is string => typeof v === 'string') } : {})
    };
    if (value.issuer !== issuer.href.replace(/\/$/, '') && value.issuer !== issuer.href) throw new OidcError('OIDC_ISSUER_MISMATCH');
    for (const endpoint of [value.authorization_endpoint, value.token_endpoint, value.jwks_uri]) { const url = new URL(endpoint); if (url.protocol !== 'https:' || url.origin !== issuer.origin) throw new OidcError('OIDC_ENDPOINT_UNTRUSTED'); }
    this.discoveryCache.set(key, { value, expiresAt: this.clock.now().getTime() + DISCOVERY_TTL_MS }); return value;
  }

  async begin(config: OidcProviderConfig): Promise<{ authorizationUrl: string; transaction: LoginTransaction }> {
    const document = await this.discovery(config); const transaction: LoginTransaction = { providerId: config.id, state: randomUrlValue(), nonce: randomUrlValue(), verifier: randomUrlValue(), createdAt: this.clock.now() };
    const url = new URL(document.authorization_endpoint); url.search = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri, scope: 'openid profile email', state: transaction.state, nonce: transaction.nonce, code_challenge: sha256Base64Url(transaction.verifier), code_challenge_method: 'S256', ...config.authorizationParams }).toString();
    return { authorizationUrl: url.href, transaction };
  }

  async finish(config: OidcProviderConfig, transaction: LoginTransaction, callback: { code?: string; state?: string }, repository: IdentityRepository): Promise<LoginResult> {
    if (!callback.code || !callback.state || callback.state !== transaction.state || transaction.providerId !== config.id || this.clock.now().getTime() - transaction.createdAt.getTime() > TRANSACTION_MAX_AGE_MS) throw new OidcError('OIDC_STATE_INVALID');
    const document = await this.discovery(config); const form: Record<string, string> = { grant_type: 'authorization_code', code: callback.code, redirect_uri: config.redirectUri, client_id: config.clientId, code_verifier: transaction.verifier };
    if (config.clientSecretRef) form.client_secret = await this.secrets.resolve(config.clientSecretRef);
    const response = asRecord(await this.http.postForm(new URL(document.token_endpoint), form));
    if (typeof response.id_token !== 'string') throw new OidcError('OIDC_TOKEN_RESPONSE_INVALID');
    const idToken = response.id_token;
    const algorithms = (config.allowedAlgorithms ?? document.id_token_signing_alg_values_supported ?? DEFAULT_ALGORITHMS).filter((algorithm) => DEFAULT_ALGORITHMS.includes(algorithm));
    if (algorithms.length === 0) throw new OidcError('OIDC_ALGORITHM_INVALID');
    const jwks = this.jwks.get(document.jwks_uri) ?? createRemoteJWKSet(new URL(document.jwks_uri)); this.jwks.set(document.jwks_uri, jwks);
    let payload: JWTPayload;
    try { ({ payload } = await jwtVerify(idToken, jwks, { issuer: document.issuer, audience: config.clientId, algorithms, currentDate: this.clock.now() })); } catch { throw new OidcError('OIDC_TOKEN_INVALID'); }
    if (typeof payload.sub !== 'string' || payload.sub === '' || payload.nonce !== transaction.nonce) throw new OidcError('OIDC_CLAIMS_INVALID');
    if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId) throw new OidcError('OIDC_AZP_INVALID');
    const groups = exactGroups(payload[config.groupClaim]); const role: Role | undefined = groups.some((group) => config.adminGroups.includes(group)) ? 'admin' : groups.some((group) => config.userGroups.includes(group)) ? 'user' : undefined;
    if (!role) throw new OidcError('OIDC_GROUP_UNAUTHORIZED');
    const existing = await repository.findIdentity(document.issuer, payload.sub);
    let user: UserRecord; let isNewUser = false;
    if (existing) { user = await repository.findUser(existing.userId) ?? (() => { throw new OidcError('OIDC_IDENTITY_ORPHANED'); })(); if (user.status === 'blocked') throw new OidcError('OIDC_USER_BLOCKED'); if (user.roleSource === 'idp') user = await repository.updateIdpRole(user.id, role); await repository.markLogin(document.issuer, payload.sub); }
    else { if (!config.provisionOnFirstLogin) throw new OidcError('OIDC_INVITATION_REQUIRED'); user = await repository.createUserWithIdentity({ id: randomUUID(), displayName: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 256) : payload.sub, status: 'active', role, roleSource: 'idp', issuer: document.issuer, subject: payload.sub, ...(typeof payload.email === 'string' ? { email: payload.email } : {}) }); isNewUser = true; }
    return { userId: user.id, isNewUser, roles: [user.role], idTokenHint: idToken };
  }

  async logoutUrl(config: OidcProviderConfig, idTokenHint: string, postLogoutRedirectUri?: string): Promise<string | undefined> {
    const endpoint = (await this.discovery(config)).end_session_endpoint; if (!endpoint) return undefined;
    const url = new URL(endpoint); url.searchParams.set('id_token_hint', idTokenHint); if (postLogoutRedirectUri) url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri); return url.href;
  }

  async validateBackchannelLogout(config: OidcProviderConfig, token: string): Promise<{ issuer: string; subject?: string; sid?: string }> {
    const document = await this.discovery(config); const jwks = this.jwks.get(document.jwks_uri) ?? createRemoteJWKSet(new URL(document.jwks_uri)); this.jwks.set(document.jwks_uri, jwks);
    let payload: JWTPayload; try { ({ payload } = await jwtVerify(token, jwks, { issuer: document.issuer, audience: config.clientId, algorithms: DEFAULT_ALGORITHMS, currentDate: this.clock.now() })); } catch { throw new OidcError('OIDC_LOGOUT_TOKEN_INVALID'); }
    if (!payload.events || typeof payload.events !== 'object' || !('http://schemas.openid.net/event/backchannel-logout' in payload.events) || (typeof payload.sub !== 'string' && typeof payload.sid !== 'string')) throw new OidcError('OIDC_LOGOUT_CLAIMS_INVALID');
    return { issuer: document.issuer, ...(typeof payload.sub === 'string' ? { subject: payload.sub } : {}), ...(typeof payload.sid === 'string' ? { sid: payload.sid } : {}) };
  }
}

export const providerProfiles = {
  authentik: { kind: 'authentik' as const, authorizationParams: {} },
  keycloak: { kind: 'keycloak' as const, authorizationParams: {} }
};
