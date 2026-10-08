import type { Pool, PoolClient } from 'pg';
import { inTransaction } from './db.js';
import type { QueueLimits } from './job-queue.js';

/**
 * Admin-determined limits (plan 04, section 10). The shape follows the proposed configuration
 * contract of the plan. null means "no additional operator limit", 0 pauses the category,
 * a positive integer is a limit.
 *
 * What is enforced today: maxConcurrentGlobal, maxConcurrentPerUser and perUser, through
 * toQueueLimits() and JobQueue.claim(), and retention, through RetentionCleaner. Every other value is
 * stored, validated and versioned so that the download worker (M5) and the transfer pool (M6) can
 * read it, but nothing enforces it yet.
 */
export interface ConcurrencyEntry {
  maxConcurrent: number | null;
}

export interface RuntimePolicy {
  downloads: {
    maxConcurrentGlobal: number | null;
    maxConcurrentPerUser: number | null;
    /** Stored only; needs source accounts (M5). */
    maxConcurrentPerSourceAccount: number | null;
    /** Stored only; needs the UTC day accounting of M5/M6. */
    maxDownloadsPerDayPerUser: number | null;
    maxBytesPerDayPerUser: number | null;
    bandwidthBytesPerSecond: number | null;
    /** Keyed by adapter id. Stored only. The entry shape is an assumption; the plan leaves it open. */
    perAdapter: Record<string, ConcurrencyEntry>;
    /** Keyed by user id (UUID). Replaces maxConcurrentPerUser for that user. */
    perUser: Record<string, ConcurrencyEntry>;
  };
  /** Worker pools. Editable starting values, not upper bounds (plan 04, section 10). Stored only. */
  workers: {
    downloadSlots: number;
    transferSlots: number;
    lifecycleReservedSlots: number;
  };
  /** Not part of the plan's contract: cleanup of finished scheduler history (risk R-D of M4-A). */
  retention: {
    finishedRunDays: number;
  };
}

export const DEFAULT_RUNTIME_POLICY: RuntimePolicy = {
  downloads: {
    maxConcurrentGlobal: null,
    maxConcurrentPerUser: null,
    maxConcurrentPerSourceAccount: null,
    maxDownloadsPerDayPerUser: null,
    maxBytesPerDayPerUser: null,
    bandwidthBytesPerSecond: null,
    perAdapter: {},
    perUser: {}
  },
  workers: { downloadSlots: 4, transferSlots: 2, lifecycleReservedSlots: 1 },
  retention: { finishedRunDays: 90 }
};

export const RETENTION_DAYS_RANGE = { min: 1, max: 3650 } as const;
const MAX_CONCURRENCY = 10_000;
const MAX_SLOTS = 1_000;
const MAX_DAILY_DOWNLOADS = 1_000_000_000;
const MAX_ENTRIES = 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ADAPTER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** One message per problem; the API returns them so that the form can show all of them at once. */
export class InvalidRuntimePolicyError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid runtime policy: ${problems.join('; ')}`);
    this.name = 'InvalidRuntimePolicyError';
  }
}

/** Another admin activated a newer version first. */
export class PolicyVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super(`Runtime policy is at version ${currentVersion}`);
    this.name = 'PolicyVersionConflictError';
  }
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a complete or partial policy document and fills in defaults for missing values
 * ("fehlende Werte erben die übergeordnete Policy"). Unknown keys are rejected so that a typo
 * does not silently leave a limit unset.
 */
export function parseRuntimePolicy(input: unknown): RuntimePolicy {
  const problems: string[] = [];
  if (!isPlainObject(input)) throw new InvalidRuntimePolicyError(['the policy must be an object']);

  const allowOnly = (value: PlainObject, keys: string[], path: string): void => {
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) problems.push(`${path}${key} is not a known setting`);
    }
  };
  const section = (name: string): PlainObject => {
    const value = input[name];
    if (value === undefined) return {};
    if (isPlainObject(value)) return value;
    problems.push(`${name} must be an object`);
    return {};
  };
  const integer = (
    value: unknown, path: string, min: number, max: number, fallback: number | null, nullable: boolean
  ): number | null => {
    if (value === undefined) return fallback;
    if (value === null) {
      if (nullable) return null;
      problems.push(`${path} must not be null`);
      return fallback;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      problems.push(`${path} must be ${nullable ? 'null or ' : ''}an integer between ${min} and ${max}`);
      return fallback;
    }
    return value;
  };
  const entries = (
    value: unknown, path: string, validKey: (key: string) => boolean, keyHint: string
  ): Record<string, ConcurrencyEntry> => {
    if (value === undefined) return {};
    if (!isPlainObject(value)) {
      problems.push(`${path} must be an object`);
      return {};
    }
    const keys = Object.keys(value);
    if (keys.length > MAX_ENTRIES) problems.push(`${path} may have at most ${MAX_ENTRIES} entries`);
    const result: Record<string, ConcurrencyEntry> = {};
    for (const key of keys.slice(0, MAX_ENTRIES)) {
      const entry = value[key];
      if (!validKey(key)) problems.push(`${path}.${key}: the key must be ${keyHint}`);
      if (!isPlainObject(entry)) {
        problems.push(`${path}.${key} must be an object with maxConcurrent`);
        continue;
      }
      allowOnly(entry, ['maxConcurrent'], `${path}.${key}.`);
      result[key] = {
        maxConcurrent: integer(entry.maxConcurrent, `${path}.${key}.maxConcurrent`, 0, MAX_CONCURRENCY, null, true)
      };
    }
    return result;
  };

  allowOnly(input, ['downloads', 'workers', 'retention'], '');
  const defaults = DEFAULT_RUNTIME_POLICY;

  const downloads = section('downloads');
  allowOnly(downloads, Object.keys(defaults.downloads), 'downloads.');
  const workers = section('workers');
  allowOnly(workers, Object.keys(defaults.workers), 'workers.');
  const retention = section('retention');
  allowOnly(retention, Object.keys(defaults.retention), 'retention.');

  const nullableLimit = (key: string, max: number): number | null =>
    integer(downloads[key], `downloads.${key}`, 0, max, null, true);
  const policy: RuntimePolicy = {
    downloads: {
      maxConcurrentGlobal: nullableLimit('maxConcurrentGlobal', MAX_CONCURRENCY),
      maxConcurrentPerUser: nullableLimit('maxConcurrentPerUser', MAX_CONCURRENCY),
      maxConcurrentPerSourceAccount: nullableLimit('maxConcurrentPerSourceAccount', MAX_CONCURRENCY),
      maxDownloadsPerDayPerUser: nullableLimit('maxDownloadsPerDayPerUser', MAX_DAILY_DOWNLOADS),
      maxBytesPerDayPerUser: nullableLimit('maxBytesPerDayPerUser', Number.MAX_SAFE_INTEGER),
      bandwidthBytesPerSecond: nullableLimit('bandwidthBytesPerSecond', Number.MAX_SAFE_INTEGER),
      perAdapter: entries(downloads.perAdapter, 'downloads.perAdapter', (key) => ADAPTER_ID_PATTERN.test(key), 'a lowercase adapter id'),
      perUser: entries(downloads.perUser, 'downloads.perUser', (key) => UUID_PATTERN.test(key), 'a user id (UUID)')
    },
    workers: {
      downloadSlots: integer(workers.downloadSlots, 'workers.downloadSlots', 0, MAX_SLOTS, defaults.workers.downloadSlots, false) as number,
      transferSlots: integer(workers.transferSlots, 'workers.transferSlots', 0, MAX_SLOTS, defaults.workers.transferSlots, false) as number,
      lifecycleReservedSlots: integer(workers.lifecycleReservedSlots, 'workers.lifecycleReservedSlots', 0, MAX_SLOTS, defaults.workers.lifecycleReservedSlots, false) as number
    },
    retention: {
      finishedRunDays: integer(
        retention.finishedRunDays, 'retention.finishedRunDays',
        RETENTION_DAYS_RANGE.min, RETENTION_DAYS_RANGE.max, defaults.retention.finishedRunDays, false
      ) as number
    }
  };

  if (problems.length > 0) throw new InvalidRuntimePolicyError(problems);
  return policy;
}

/** The part of the policy that JobQueue.claim() enforces today. */
export function toQueueLimits(policy: RuntimePolicy): QueueLimits {
  return {
    maxConcurrentGlobal: policy.downloads.maxConcurrentGlobal,
    maxConcurrentPerUser: policy.downloads.maxConcurrentPerUser,
    perUser: policy.downloads.perUser
  };
}

export interface PolicyVersion {
  /** 0 = nothing was ever saved, the defaults apply. */
  version: number;
  policy: RuntimePolicy;
  createdBy: string | null;
  createdAt: Date | null;
}

/** Versioned, atomically activated runtime policy (plan 04, section 10: "validiert, versioniert und atomar aktiviert"). */
export class RuntimePolicyRepository {
  constructor(private readonly pool: Pool) {}

  async current(): Promise<PolicyVersion> {
    const result = await this.pool.query<{ version: number; config: unknown; created_by: string; created_at: Date }>(
      'SELECT version, config, created_by, created_at FROM runtime_policy_versions ORDER BY version DESC LIMIT 1'
    );
    const row = result.rows[0];
    if (!row) return { version: 0, policy: DEFAULT_RUNTIME_POLICY, createdBy: null, createdAt: null };
    return { version: row.version, policy: parseRuntimePolicy(row.config), createdBy: row.created_by, createdAt: row.created_at };
  }

  /**
   * Activates `input` as version expectedVersion + 1. Throws InvalidRuntimePolicyError for bad values
   * (including unknown user ids in perUser) and PolicyVersionConflictError when another admin was faster.
   */
  async activate(input: unknown, expectedVersion: number, adminUserId: string): Promise<PolicyVersion> {
    const policy = parseRuntimePolicy(input);
    return inTransaction(this.pool, async (client) => {
      await this.assertUsersExist(client, Object.keys(policy.downloads.perUser));

      const latest = await client.query<{ version: number }>('SELECT max(version) AS version FROM runtime_policy_versions');
      const currentVersion = latest.rows[0].version ?? 0;
      if (currentVersion !== expectedVersion) throw new PolicyVersionConflictError(currentVersion);

      const inserted = await client.query<{ version: number; created_at: Date }>(
        `INSERT INTO runtime_policy_versions (version, config, created_by)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (version) DO NOTHING
         RETURNING version, created_at`,
        [expectedVersion + 1, JSON.stringify(policy), adminUserId]
      );
      if (!inserted.rows[0]) throw new PolicyVersionConflictError(expectedVersion + 1);
      return { version: inserted.rows[0].version, policy, createdBy: adminUserId, createdAt: inserted.rows[0].created_at };
    });
  }

  private async assertUsersExist(client: PoolClient, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    const found = await client.query<{ id: string }>('SELECT id FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    const known = new Set(found.rows.map((row) => row.id));
    const unknown = userIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new InvalidRuntimePolicyError(unknown.map((id) => `downloads.perUser.${id}: the user does not exist`));
    }
  }
}
