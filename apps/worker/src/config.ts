import { resolve } from 'node:path';
import { INSTAGRAM_DEFAULT_MAX_POSTS_PER_RUN, INSTAGRAM_MAX_POSTS_PER_RUN_LIMIT } from '@kura/adapters';

/** An administrator-installed external tool: absolute path plus the SHA-256 the file must have. */
export interface ToolBinaryConfig {
  path: string;
  sha256: string;
}

export interface DownloadConfig {
  /** Parallel jobs in this process. */
  concurrency: number;
  /** Pause between two claim attempts while the queue is empty. */
  pollIntervalMs: number;
  /** Lease length; the heartbeat runs at a third of it. */
  leaseSeconds: number;
  /** Staging area for adapter workspaces (private, same volume as the temp space the tools may use). */
  workDir: string;
  /** Per-user quota of the blob store in bytes. */
  quotaBytes: number;
  /** Hard cap for one asset in bytes. */
  maxAssetBytes: number;
  /** Key for the stored Immich API keys. Without it no Immich handover is attempted. */
  secretKey?: Buffer;
  /**
   * The operator confirmed (KURA_EXTERNAL_TOOLS_EGRESS_CONFIRMED=true) that the network of the worker container is
   * restricted outside of Kura. yt-dlp and gallery-dl have no allowlist of their own (D-008), so without this
   * confirmation they are never started (R-09). Not needed for the direct URL adapter.
   */
  externalToolsEgressConfirmed: boolean;
  tools: {
    ytDlp?: ToolBinaryConfig;
    galleryDl?: ToolBinaryConfig;
    /** Optional PATH for the tools, for example a directory with a pinned ffmpeg. */
    toolPath?: string;
  };
  /** How often the worker checks again whether the tools are usable. */
  adapterRecheckMs: number;
  /**
   * Posts read from an Instagram profile per run (KURA_INSTAGRAM_MAX_POSTS_PER_RUN, 1-500, default 50). The
   * newest posts come first, so this also bounds the first run of a new subscription. There is no
   * administrator limit for items per run elsewhere (checked in M4-B), hence this adapter-level bound.
   */
  instagramMaxPostsPerRun: number;
}

export interface WorkerConfig {
  databaseUrl: string;
  /** Pause between two scheduler ticks. */
  tickIntervalMs: number;
  /** Minimum pause between two retention cleanups. */
  retentionIntervalMs: number;
  /** Absent = this process only runs the scheduler (WORKER_DOWNLOADS=false). */
  downloads?: DownloadConfig;
}

function integerInRange(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function toggle(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function secretKey(value: string | undefined): Buffer | undefined {
  if (!value) return undefined;
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('KURA_SECRET_KEY must be a base64-encoded 32-byte key');
  return key;
}

/** Path and hash belong together; one without the other is a configuration error, not "not installed". */
function tool(label: string, pathName: string, hashName: string, environment: NodeJS.ProcessEnv): ToolBinaryConfig | undefined {
  const path = environment[pathName];
  const sha256 = environment[hashName];
  if (!path && !sha256) return undefined;
  if (!path || !sha256) throw new Error(`${pathName} and ${hashName} must be set together (${label})`);
  if (!path.startsWith('/')) throw new Error(`${pathName} must be an absolute path`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`${hashName} must be 64 lowercase hex characters`);
  return { path, sha256 };
}

/** The scheduler part of the configuration (M4-B). Download execution is configured by loadDownloadConfig. */
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
    tickIntervalMs: integerInRange('WORKER_TICK_SECONDS', environment.WORKER_TICK_SECONDS, 15, 1, 3600) * 1000,
    retentionIntervalMs: integerInRange('WORKER_RETENTION_INTERVAL_SECONDS', environment.WORKER_RETENTION_INTERVAL_SECONDS, 3600, 60, 7 * 86_400) * 1000
  };
}

/** Download execution (M5-B). Returns undefined when WORKER_DOWNLOADS=false: the process then only schedules. */
export function loadDownloadConfig(environment: NodeJS.ProcessEnv = process.env): DownloadConfig | undefined {
  if (!toggle('WORKER_DOWNLOADS', environment.WORKER_DOWNLOADS, true)) return undefined;
  return {
    concurrency: integerInRange('WORKER_DOWNLOAD_CONCURRENCY', environment.WORKER_DOWNLOAD_CONCURRENCY, 2, 1, 32),
    pollIntervalMs: integerInRange('WORKER_POLL_SECONDS', environment.WORKER_POLL_SECONDS, 5, 1, 300) * 1000,
    leaseSeconds: integerInRange('WORKER_LEASE_SECONDS', environment.WORKER_LEASE_SECONDS, 120, 30, 3600),
    workDir: resolve(environment.KURA_WORK_DIR ?? './data/staging'),
    quotaBytes: integerInRange('KURA_STORAGE_QUOTA_BYTES', environment.KURA_STORAGE_QUOTA_BYTES, 10 * 1024 ** 3, 1, Number.MAX_SAFE_INTEGER),
    maxAssetBytes: integerInRange('WORKER_MAX_ASSET_BYTES', environment.WORKER_MAX_ASSET_BYTES, 2 * 1024 ** 3, 1, Number.MAX_SAFE_INTEGER),
    secretKey: secretKey(environment.KURA_SECRET_KEY),
    externalToolsEgressConfirmed: toggle('KURA_EXTERNAL_TOOLS_EGRESS_CONFIRMED', environment.KURA_EXTERNAL_TOOLS_EGRESS_CONFIRMED, false),
    tools: {
      ytDlp: tool('yt-dlp', 'KURA_YTDLP_PATH', 'KURA_YTDLP_SHA256', environment),
      galleryDl: tool('gallery-dl', 'KURA_GALLERYDL_PATH', 'KURA_GALLERYDL_SHA256', environment),
      toolPath: environment.KURA_TOOL_PATH || undefined
    },
    adapterRecheckMs: integerInRange('WORKER_ADAPTER_RECHECK_SECONDS', environment.WORKER_ADAPTER_RECHECK_SECONDS, 600, 30, 86_400) * 1000,
    instagramMaxPostsPerRun: integerInRange('KURA_INSTAGRAM_MAX_POSTS_PER_RUN', environment.KURA_INSTAGRAM_MAX_POSTS_PER_RUN, INSTAGRAM_DEFAULT_MAX_POSTS_PER_RUN, 1, INSTAGRAM_MAX_POSTS_PER_RUN_LIMIT)
  };
}
