import { AdapterError } from './errors.js';
import { AdapterRegistry, type AdapterCandidate } from './registry.js';
import { DirectUrlAdapter } from './direct-url-adapter.js';
import { GalleryDlAdapter } from './gallery-dl-adapter.js';
import { YtDlpAdapter } from './yt-dlp-adapter.js';

/**
 * Hosts of platforms that have (or are planned to have) a dedicated adapter. A URL on such a host is
 * never treated as a plain media file: the direct URL adapter accepts every https URL, and without
 * this rule a YouTube playlist would silently become "download an HTML page" instead of a clear
 * "not supported" answer.
 */
export const PLATFORM_HOST_SUFFIXES = ['youtube.com', 'youtu.be', 'instagram.com', 'pixiv.net', 'patreon.com', 'pornhub.com'] as const;

function isKnownPlatformHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return PLATFORM_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * Chooses the adapter for a URL. Platform adapters win over the direct URL adapter; a known broken
 * target (for example an Instagram profile) and an invalid URL are reported as such instead of being
 * handed to the fallback. Throws AdapterError (TARGET_INVALID, TARGET_UNSUPPORTED, TARGET_BROKEN or
 * ADAPTER_DISABLED).
 */
export function selectSource(registry: AdapterRegistry, url: string): AdapterCandidate {
  const lookup = registry.lookup(url);
  const platform = lookup.candidates.find((candidate) => candidate.target.sourceType !== 'direct_media');
  if (platform) return platform;

  const broken = lookup.rejections.find((error) => error.code === 'TARGET_BROKEN');
  if (broken) throw broken;
  const invalid = lookup.rejections.find((error) => error.code === 'TARGET_INVALID');
  if (invalid) throw invalid;

  const knownPlatform = isKnownPlatformHost(url);
  const direct = lookup.candidates[0];
  if (direct && !knownPlatform) return direct;

  if (lookup.disabled.length > 0) {
    const names = lookup.disabled.map((entry) => `${entry.adapterId} ${entry.adapterVersion}`).join(', ');
    throw new AdapterError('ADAPTER_DISABLED', `All adapters for this URL are disabled (${names})`);
  }
  if (knownPlatform) {
    throw new AdapterError('TARGET_UNSUPPORTED', 'This kind of address on a known platform is not supported (for example a profile, channel or playlist)');
  }
  throw new AdapterError('TARGET_UNSUPPORTED', 'No registered adapter accepts this URL');
}

/**
 * A registry that knows every adapter's target rules but can run none of them: the CLI adapters have no
 * tool behind them and the direct adapter has no network. Used to recognise platforms in processes that
 * must not execute anything (the API) and to tell "unsupported" from "tool not installed" (the worker).
 */
export function createTargetRecognizer(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(GalleryDlAdapter.forTargetValidationOnly());
  registry.register(YtDlpAdapter.forTargetValidationOnly());
  registry.register(new DirectUrlAdapter({
    approvals: { isApproved: async () => false },
    fetcher: async () => {
      throw new AdapterError('NETWORK_FAILED', 'The target recognizer never makes requests');
    }
  }));
  return registry;
}
