import type { EndpointApprovals } from '@kura/immich-client';
import {
  AdapterError,
  AdapterRegistry,
  DirectUrlAdapter,
  GalleryDlAdapter,
  YtDlpAdapter,
  createTargetRecognizer,
  type KillSwitch,
  type SourceAdapter,
  type SourceType
} from '@kura/adapters';
import type { Pool } from 'pg';
import type { DownloadConfig, ToolBinaryConfig } from './config.js';
import type { Logger } from './scheduler-loop.js';

export interface AdapterAvailability {
  adapterId: string;
  adapterVersion: string | null;
  available: boolean;
  /** AdapterError code of the failed check, for example BINARY_NOT_CONFIGURED or BINARY_HASH_MISMATCH. */
  reasonCode: string | null;
}

/** How the direct URL adapter may reach the network. Production passes only `approvals`. */
export interface DirectUrlSettings {
  /**
   * Loopback and private destinations of direct downloads. Production uses "approve nothing": the
   * administrator approvals in the database exist for the Immich transfer only (docs/planning/05,
   * section 2: "nicht für Download-URLs"). Tests inject a policy for their local server.
   */
  approvals: EndpointApprovals;
  fetcher?: typeof fetch;
  resolveHost?: (host: string) => Promise<string[]>;
}

export const approveNothing: EndpointApprovals = { isApproved: async () => false };

/** AdapterError code and availability reason of a CLI tool that is blocked because no egress barrier was confirmed. */
export const EGRESS_NOT_CONFIRMED = 'EGRESS_NOT_CONFIRMED';

interface CatalogOptions {
  tools: DownloadConfig['tools'];
  /**
   * yt-dlp and gallery-dl bring no network allowlist (D-008), so the guard of the in-process fetches does not cover
   * them. They are only built, checked and started when the operator confirmed an external egress barrier
   * (docs/planning/04, "Externe Prozessausführung"; risk R-09). Absent = false = closed.
   */
  externalToolsEgressConfirmed?: boolean;
  workDir: string;
  maxAssetBytes: number;
  directUrl: DirectUrlSettings;
  logger: Logger;
  /** Additional environment variables per tool. Tests only (the fake tools log through them). */
  toolEnvironment?: { ytDlp?: Record<string, string>; galleryDl?: Record<string, string> };
}

interface KillSwitchRow {
  adapter_id: string;
  adapter_version: string | null;
  source_type: SourceType | null;
  reason: string;
}

export async function loadKillSwitches(pool: Pool): Promise<KillSwitch[]> {
  const result = await pool.query<KillSwitchRow>('SELECT adapter_id, adapter_version, source_type, reason FROM adapter_kill_switches');
  return result.rows.map((row) => ({
    adapterId: row.adapter_id,
    ...(row.adapter_version === null ? {} : { adapterVersion: row.adapter_version }),
    ...(row.source_type === null ? {} : { sourceType: row.source_type }),
    reason: row.reason
  }));
}

/**
 * The adapters this worker can actually run, plus a recognizer that knows every adapter's target rules.
 * An adapter whose tool is missing, has the wrong hash or is too old is simply not registered; the
 * recognizer still knows its platform, so a job can say "tool not installed" instead of "unsupported".
 */
export class AdapterCatalog {
  /** Knows every target rule and can run nothing. */
  readonly recognizer: AdapterRegistry = createTargetRecognizer();
  private registryInUse = new AdapterRegistry();
  private availabilityInUse: AdapterAvailability[] = [];
  private killSwitches: readonly KillSwitch[] = [];
  private egressBlockLogged = false;

  constructor(private readonly options: CatalogOptions) {}

  get registry(): AdapterRegistry {
    return this.registryInUse;
  }

  get availability(): readonly AdapterAvailability[] {
    return this.availabilityInUse;
  }

  /** Replaces the kill switches in both registries. Called before every job so a switch acts at once. */
  setKillSwitches(switches: readonly KillSwitch[]): void {
    this.killSwitches = switches;
    this.registryInUse.setKillSwitches(switches);
    this.recognizer.setKillSwitches(switches);
  }

  /** Builds the registry again. Each tool is checked on its own; one broken tool never hides the others. */
  async refresh(): Promise<void> {
    const registry = new AdapterRegistry(this.killSwitches);
    const availability: AdapterAvailability[] = [];
    const { tools, workDir } = this.options;
    const environmentFor = (extra: Record<string, string> | undefined) => {
      const merged = { ...(tools.toolPath ? { PATH: tools.toolPath } : {}), ...extra };
      return Object.keys(merged).length > 0 ? merged : undefined;
    };

    availability.push(await this.registerCli(registry, 'gallery-dl', tools.galleryDl, (binary) =>
      GalleryDlAdapter.create({ binary, workRoot: workDir, extraEnv: environmentFor(this.options.toolEnvironment?.galleryDl) })));
    availability.push(await this.registerCli(registry, 'yt-dlp', tools.ytDlp, (binary) =>
      YtDlpAdapter.create({ binary, workRoot: workDir, extraEnv: environmentFor(this.options.toolEnvironment?.ytDlp) })));

    // Last, so that platform adapters are asked first (selectSource also relies on this).
    const direct = new DirectUrlAdapter({
      approvals: this.options.directUrl.approvals,
      fetcher: this.options.directUrl.fetcher,
      resolveHost: this.options.directUrl.resolveHost,
      maxAssetBytes: this.options.maxAssetBytes
    });
    registry.register(direct);
    availability.push({ adapterId: direct.capabilities().adapterId, adapterVersion: direct.capabilities().adapterVersion, available: true, reasonCode: null });

    this.registryInUse = registry;
    this.availabilityInUse = availability;
  }

  /** Publishes the availability so that the API can tell users why a platform does not work. */
  async publish(pool: Pool): Promise<void> {
    for (const entry of this.availabilityInUse) {
      await pool.query(
        `INSERT INTO adapter_status (adapter_id, adapter_version, availability, reason_code, checked_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (adapter_id) DO UPDATE
           SET adapter_version = EXCLUDED.adapter_version, availability = EXCLUDED.availability,
               reason_code = EXCLUDED.reason_code, checked_at = EXCLUDED.checked_at`,
        [entry.adapterId, entry.adapterVersion, entry.available ? 'available' : 'unavailable', entry.reasonCode]
      );
    }
  }

  private async registerCli(
    registry: AdapterRegistry,
    adapterId: string,
    binary: ToolBinaryConfig | undefined,
    create: (binary: ToolBinaryConfig) => Promise<SourceAdapter>
  ): Promise<AdapterAvailability> {
    if (!binary) return { adapterId, adapterVersion: null, available: false, reasonCode: 'BINARY_NOT_CONFIGURED' };
    // Fail closed, before anything touches the binary: no hash check, no `--version`, no process of any kind.
    if (this.options.externalToolsEgressConfirmed !== true) {
      if (!this.egressBlockLogged) {
        this.egressBlockLogged = true;
        this.options.logger.info('external tools blocked: egress protection not confirmed (KURA_EXTERNAL_TOOLS_EGRESS_CONFIRMED)');
      }
      return { adapterId, adapterVersion: null, available: false, reasonCode: EGRESS_NOT_CONFIRMED };
    }
    try {
      const adapter = await create(binary);
      registry.register(adapter);
      return { adapterId, adapterVersion: adapter.capabilities().adapterVersion, available: true, reasonCode: null };
    } catch (error) {
      const reasonCode = error instanceof AdapterError ? error.code : 'UNEXPECTED';
      // The message of an AdapterError is written by Kura; tool output stays out of the log.
      this.options.logger.error('adapter unavailable', { adapterId, reasonCode });
      return { adapterId, adapterVersion: null, available: false, reasonCode };
    }
  }
}
