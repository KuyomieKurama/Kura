/**
 * Semantic versioning 2.0.0, only what the update check needs: parse, compare, pick the highest tag.
 * Build metadata ("+abc") is accepted and ignored for precedence, as the specification says.
 */

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** Dot separated pre-release identifiers, empty for a release. */
  prerelease: string[];
}

const IDENTIFIER = '[0-9A-Za-z-]+';
const NUMERIC = '(0|[1-9][0-9]*)';
const SEMVER_PATTERN = new RegExp(
  `^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(?:\\+${IDENTIFIER}(?:\\.${IDENTIFIER})*)?$`
);
const NUMERIC_IDENTIFIER = /^(0|[1-9][0-9]*)$/;

/** Parses "1.2.3" or "1.2.3-rc.1" (an optional leading "v" is accepted). Returns null for anything else. */
export function parseSemver(text: string): Semver | null {
  const match = SEMVER_PATTERN.exec(text.startsWith('v') ? text.slice(1) : text);
  if (!match) return null;
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number) as [number, number, number];
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  // A numeric pre-release identifier must not have leading zeros (rc.01 is invalid).
  if (prerelease.some((part) => /^[0-9]+$/.test(part) && !NUMERIC_IDENTIFIER.test(part))) return null;
  return { major, minor, patch, prerelease };
}

/** Parses a git tag in the form vMAJOR.MINOR.PATCH[-prerelease]. The "v" is required: other tags are not versions. */
export function parseVersionTag(tag: string): Semver | null {
  return tag.startsWith('v') ? parseSemver(tag) : null;
}

export function formatSemver(version: Semver): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease.length ? `${core}-${version.prerelease.join('.')}` : core;
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = NUMERIC_IDENTIFIER.test(a);
  const bNumeric = NUMERIC_IDENTIFIER.test(b);
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
  // Numeric identifiers have lower precedence than alphanumeric ones.
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Negative if a is older than b, positive if newer, 0 if they have the same precedence. */
export function compareSemver(a: Semver, b: Semver): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return Math.sign(a[key] - b[key]);
  }
  // A release is newer than any pre-release of the same version.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return Math.sign(b.prerelease.length - a.prerelease.length);
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    // The shorter list is older when all shared identifiers are equal.
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const result = compareIdentifiers(left, right);
    if (result !== 0) return result;
  }
  return 0;
}

export interface VersionTag {
  tag: string;
  version: Semver;
}

/**
 * The highest version among the git tags. Tags that are not vX.Y.Z are ignored; pre-releases only count when
 * the channel is "prerelease".
 */
export function highestVersionTag(tags: readonly string[], channel: 'stable' | 'prerelease'): VersionTag | null {
  let best: VersionTag | null = null;
  for (const tag of tags) {
    const version = parseVersionTag(tag);
    if (!version) continue;
    if (channel === 'stable' && version.prerelease.length > 0) continue;
    if (!best || compareSemver(version, best.version) > 0) best = { tag, version };
  }
  return best;
}
