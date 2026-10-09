import { AdapterError } from './errors.js';
import type { AdapterCapabilities, CanonicalTarget, SourceAdapter, SourceType } from './types.js';

/**
 * Disables adapters. Omitted `adapterVersion` or `sourceType` mean "all", so
 * one entry can switch off a whole adapter, one version of it, or just one
 * source type of one version (docs/planning/04, section 3).
 */
export interface KillSwitch {
  readonly adapterId: string;
  readonly adapterVersion?: string;
  readonly sourceType?: SourceType;
  readonly reason: string;
}

export interface AdapterCandidate {
  readonly adapter: SourceAdapter;
  readonly target: CanonicalTarget;
}

export interface AdapterLookupFailure {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly error: unknown;
}

export interface AdapterLookup {
  /** Enabled adapters that accept the URL, in registration order. */
  readonly candidates: readonly AdapterCandidate[];
  /** Adapters that threw while looking at the URL. They are skipped, never fatal. */
  readonly failures: readonly AdapterLookupFailure[];
  /** TARGET_* answers of adapters that recognised the URL but refuse it (for example a broken extractor). */
  readonly rejections: readonly AdapterError[];
  /** Adapters that would accept the URL but are switched off. */
  readonly disabled: readonly { adapterId: string; adapterVersion: string; reason: string }[];
}

export class AdapterRegistry {
  private readonly adapters: SourceAdapter[] = [];
  private killSwitches: readonly KillSwitch[];

  constructor(initialKillSwitches: readonly KillSwitch[] = []) {
    this.killSwitches = [...initialKillSwitches];
  }

  register(adapter: SourceAdapter): void {
    const { adapterId, adapterVersion } = adapter.capabilities();
    if (this.adapters.some((existing) => matchesVersion(existing.capabilities(), adapterId, adapterVersion))) {
      throw new Error(`Adapter ${adapterId} ${adapterVersion} is already registered`);
    }
    this.adapters.push(adapter);
  }

  /** Declared capabilities of all registered adapters for the UI and admin views. */
  listCapabilities(): readonly AdapterCapabilities[] {
    return this.adapters.map((adapter) => adapter.capabilities());
  }

  get(adapterId: string, adapterVersion: string): SourceAdapter {
    const found = this.adapters.find((adapter) => matchesVersion(adapter.capabilities(), adapterId, adapterVersion));
    if (!found) throw new AdapterError('ADAPTER_UNKNOWN', `Adapter ${adapterId} ${adapterVersion} is not registered`);
    return found;
  }

  setKillSwitches(switches: readonly KillSwitch[]): void {
    this.killSwitches = [...switches];
  }

  getKillSwitches(): readonly KillSwitch[] {
    return this.killSwitches;
  }

  disable(killSwitch: KillSwitch): void {
    this.killSwitches = [...this.killSwitches, killSwitch];
  }

  /** Removes exactly the matching entry; entries with other scopes stay. */
  enable(scope: Pick<KillSwitch, 'adapterId' | 'adapterVersion' | 'sourceType'>): void {
    this.killSwitches = this.killSwitches.filter((entry) => !(
      entry.adapterId === scope.adapterId
      && entry.adapterVersion === scope.adapterVersion
      && entry.sourceType === scope.sourceType
    ));
  }

  /** The first matching kill switch, or undefined if the combination may run. */
  activeKillSwitch(adapterId: string, adapterVersion: string, sourceType: SourceType): KillSwitch | undefined {
    return this.killSwitches.find((entry) => entry.adapterId === adapterId
      && (entry.adapterVersion === undefined || entry.adapterVersion === adapterVersion)
      && (entry.sourceType === undefined || entry.sourceType === sourceType));
  }

  /** Throws ADAPTER_DISABLED if a kill switch covers this adapter version and source type. */
  assertEnabled(adapter: SourceAdapter, sourceType: SourceType): void {
    const { adapterId, adapterVersion } = adapter.capabilities();
    const active = this.activeKillSwitch(adapterId, adapterVersion, sourceType);
    if (active) {
      throw new AdapterError('ADAPTER_DISABLED', `Adapter ${adapterId} ${adapterVersion} is disabled for ${sourceType}: ${active.reason}`);
    }
  }

  /**
   * Asks every adapter whether it accepts the URL. One adapter that throws or
   * is switched off never hides the others.
   */
  lookup(url: string): AdapterLookup {
    const candidates: AdapterCandidate[] = [];
    const failures: AdapterLookupFailure[] = [];
    const rejections: AdapterError[] = [];
    const disabled: { adapterId: string; adapterVersion: string; reason: string }[] = [];
    for (const adapter of this.adapters) {
      let capabilities: AdapterCapabilities;
      try {
        capabilities = adapter.capabilities();
      } catch (error) {
        failures.push({ adapterId: 'unknown', adapterVersion: 'unknown', error });
        continue;
      }
      try {
        const target = adapter.validateTarget(url);
        const active = this.activeKillSwitch(capabilities.adapterId, capabilities.adapterVersion, target.sourceType);
        if (active) {
          disabled.push({ adapterId: capabilities.adapterId, adapterVersion: capabilities.adapterVersion, reason: active.reason });
        } else {
          candidates.push({ adapter, target });
        }
      } catch (error) {
        // TARGET_* errors are the normal "not mine" answer; anything else is a defective adapter.
        if (error instanceof AdapterError) {
          rejections.push(error);
        } else {
          failures.push({ adapterId: capabilities.adapterId, adapterVersion: capabilities.adapterVersion, error });
        }
      }
    }
    return { candidates, failures, rejections, disabled };
  }

  /** First enabled adapter that accepts the URL. */
  select(url: string): AdapterCandidate {
    const { candidates, disabled, rejections } = this.lookup(url);
    const first = candidates[0];
    if (first) return first;
    if (disabled.length > 0) {
      throw new AdapterError('ADAPTER_DISABLED', `All adapters for this URL are disabled (${disabled.map((entry) => `${entry.adapterId} ${entry.adapterVersion}`).join(', ')})`);
    }
    const broken = rejections.find((error) => error.code === 'TARGET_BROKEN');
    if (broken) throw broken;
    throw new AdapterError('TARGET_UNSUPPORTED', 'No registered adapter accepts this URL');
  }
}

function matchesVersion(capabilities: AdapterCapabilities, adapterId: string, adapterVersion: string): boolean {
  return capabilities.adapterId === adapterId && capabilities.adapterVersion === adapterVersion;
}
