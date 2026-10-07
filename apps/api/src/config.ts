export interface ApiConfig {
  databaseUrl: string;
  host: string;
  port: number;
  trustProxy: boolean | string[];
  cookieSecure?: boolean;
  setupToken?: string;
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
    oidc: oidcConfig(environment)
  };
}
