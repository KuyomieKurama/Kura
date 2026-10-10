import { resolveBuildInfo, type BuildInfo } from './build-info.js';

export type UpdateChannel = 'stable' | 'prerelease';

/** Settings of the update check (REQ-DL-007). The check is a server-side request to the GitHub REST API. */
export interface UpdateCheckConfig {
  enabled: boolean;
  /** "owner/name" on GitHub. */
  repository: string;
  /** Base URL of the GitHub REST API, without trailing slash. Only tests and GitHub Enterprise change it. */
  apiBase: string;
  channel: UpdateChannel;
}

export const DEFAULT_UPDATE_REPOSITORY = 'KuyomieKurama/Kura';
export const DEFAULT_UPDATE_API_BASE = 'https://api.github.com';

export interface ApiConfig {
  databaseUrl: string;
  host: string;
  port: number;
  trustProxy: boolean | string[];
  cookieSecure?: boolean;
  setupToken?: string;
  storage?: { backend: 'filesystem' | 'database'; root: string; quotaBytes: number; layout: 'cas' | 'template' };
  secretKey?: Buffer;
  /** Version and commit of this build. Without it the API resolves them itself. */
  build?: BuildInfo;
  /** Without it the update check is off: an app built in a test makes no request to GitHub. */
  update?: UpdateCheckConfig;
  oidc?: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    groupClaim: string;
    userGroups: string[];
    adminGroups: string[];
  };
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be an integer between 1 and 65535');
  return port;
}

function parseBoolean(name: string, value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function parseTrustProxy(value: string | undefined): boolean | string[] {
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) throw new Error('TRUST_PROXY must not be numeric');
  const addresses = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (addresses.length === 0) throw new Error('TRUST_PROXY must be false, true, or proxy addresses');
  return addresses;
}

function parseGroups(value: string | undefined, defaultValue: string[]): string[] {
  const groups = (value ?? defaultValue.join(',')).split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!groups.length) throw new Error('OIDC group configuration must not be empty');
  return groups;
}

function parseSecretKey(value: string | undefined): Buffer | undefined {
  if (!value) return undefined;
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('KURA_SECRET_KEY must be a base64-encoded 32-byte key');
  return key;
}

function updateCheckConfig(environment: NodeJS.ProcessEnv): UpdateCheckConfig {
  const repository = (environment.KURA_UPDATE_REPO ?? '').trim() || DEFAULT_UPDATE_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split('/').some((part) => /^\.+$/.test(part))) throw new Error('KURA_UPDATE_REPO must look like owner/name');
  const apiBase = ((environment.KURA_UPDATE_API_BASE ?? '').trim() || DEFAULT_UPDATE_API_BASE).replace(/\/+$/, '');
  let parsedBase: URL;
  try { parsedBase = new URL(apiBase); } catch { throw new Error('KURA_UPDATE_API_BASE must be a URL'); }
  if (parsedBase.protocol !== 'https:' && parsedBase.protocol !== 'http:') throw new Error('KURA_UPDATE_API_BASE must be an http(s) URL');
  const channel = (environment.KURA_UPDATE_CHANNEL ?? '').trim() || 'stable';
  if (channel !== 'stable' && channel !== 'prerelease') throw new Error('KURA_UPDATE_CHANNEL must be stable or prerelease');
  return { enabled: parseBoolean('KURA_UPDATE_CHECK', environment.KURA_UPDATE_CHECK, true), repository, apiBase, channel };
}

function oidcConfig(environment: NodeJS.ProcessEnv): ApiConfig['oidc'] {
  const values = [environment.OIDC_ISSUER_URL, environment.OIDC_CLIENT_ID, environment.OIDC_CLIENT_SECRET, environment.OIDC_REDIRECT_URL];
  if (values.every((value) => value === undefined || value === '')) return undefined;
  if (values.some((value) => value === undefined || value === '')) throw new Error('OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, and OIDC_REDIRECT_URL must be configured together');
  return {
    issuer: environment.OIDC_ISSUER_URL!, clientId: environment.OIDC_CLIENT_ID!, clientSecret: environment.OIDC_CLIENT_SECRET!, redirectUri: environment.OIDC_REDIRECT_URL!,
    groupClaim: environment.OIDC_GROUP_CLAIM ?? 'downloader_groups', userGroups: parseGroups(environment.OIDC_USER_GROUPS, ['downloader-users']), adminGroups: parseGroups(environment.OIDC_ADMIN_GROUPS, ['downloader-admins'])
  };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const databaseUrl = required('DATABASE_URL', environment.DATABASE_URL);
  try { new URL(databaseUrl); } catch { throw new Error('DATABASE_URL must be a URL'); }
  return {
    databaseUrl,
    host: environment.HOST ?? '127.0.0.1',
    port: parsePort(environment.PORT),
    trustProxy: parseTrustProxy(environment.TRUST_PROXY),
    cookieSecure: parseBoolean('COOKIE_SECURE', environment.COOKIE_SECURE, true),
    setupToken: environment.KURA_SETUP_TOKEN,
    storage: {
      backend: environment.KURA_STORAGE_BACKEND === 'database' ? 'database' : 'filesystem',
      root: environment.KURA_STORAGE_ROOT ?? './data/blobstore',
      quotaBytes: Number(environment.KURA_STORAGE_QUOTA_BYTES ?? String(10 * 1024 * 1024 * 1024)),
      layout: environment.KURA_STORAGE_LAYOUT === 'template' ? 'template' : 'cas'
    },
    secretKey: parseSecretKey(environment.KURA_SECRET_KEY),
    build: resolveBuildInfo(environment),
    update: updateCheckConfig(environment),
    oidc: oidcConfig(environment)
  };
}
