export interface ApiConfig {
  databaseUrl: string;
  host: string;
  port: number;
  trustProxy: boolean | string[];
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

function parseTrustProxy(value: string | undefined): boolean | string[] {
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) throw new Error('TRUST_PROXY must not be numeric');
  const addresses = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (addresses.length === 0) throw new Error('TRUST_PROXY must be false, true, or proxy addresses');
  return addresses;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const databaseUrl = required('DATABASE_URL', environment.DATABASE_URL);
  try {
    new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a URL');
  }

  return {
    databaseUrl,
    host: environment.HOST ?? '127.0.0.1',
    port: parsePort(environment.PORT),
    trustProxy: parseTrustProxy(environment.TRUST_PROXY)
  };
}
