import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSemver, parseSemver } from './semver.js';

export const UNKNOWN = 'unbekannt';

/** The version and git commit this process was built from. Both are plain strings, "unbekannt" when not known. */
export interface BuildInfo {
  version: string;
  commit: string;
}

/** Looks for the workspace root package.json (name "kura") above this file. Only exists in a source checkout. */
function readRootPackageVersion(): string | undefined {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const file = join(directory, 'package.json');
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown; version?: unknown };
        if (parsed.name === 'kura' && typeof parsed.version === 'string') return parsed.version;
      } catch {
        // An unreadable package.json is not fatal: the version stays unknown.
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/**
 * KURA_VERSION and KURA_COMMIT are set at image build time (deploy/Containerfile build arguments, filled by
 * deploy/kura-deploy.sh from the root package.json and git). Without them (development) the version comes from
 * the root package.json of the checkout and the commit is unknown. A value that is not a version or a hex commit
 * is not trusted: it would end up in the UI.
 */
export function resolveBuildInfo(
  environment: NodeJS.ProcessEnv = process.env,
  readRootVersion: () => string | undefined = readRootPackageVersion
): BuildInfo {
  const fromEnvironment = parseSemver((environment.KURA_VERSION ?? '').trim());
  const fromPackage = fromEnvironment ? null : parseSemver((readRootVersion() ?? '').trim());
  const version = fromEnvironment ?? fromPackage;
  const commit = (environment.KURA_COMMIT ?? '').trim().toLowerCase();
  return {
    version: version ? formatSemver(version) : UNKNOWN,
    commit: /^[0-9a-f]{7,40}$/.test(commit) ? commit : UNKNOWN
  };
}
