export interface WorkerConfig {
  databaseUrl: string;
  /** Pause between two scheduler ticks. */
  tickIntervalMs: number;
  /** Minimum pause between two retention cleanups. */
  retentionIntervalMs: number;
}

function seconds(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function loadWorkerConfig(environment: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  try {
    new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a URL');
  }
  return {
    databaseUrl,
    tickIntervalMs: seconds('WORKER_TICK_SECONDS', environment.WORKER_TICK_SECONDS, 15, 1, 3600) * 1000,
    retentionIntervalMs: seconds('WORKER_RETENTION_INTERVAL_SECONDS', environment.WORKER_RETENTION_INTERVAL_SECONDS, 3600, 60, 7 * 86_400) * 1000
  };
}
