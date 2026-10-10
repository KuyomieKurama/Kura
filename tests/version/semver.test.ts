import { describe, expect, it } from 'vitest';
import { compareSemver, formatSemver, highestVersionTag, parseSemver, parseVersionTag } from '../../apps/api/src/semver.js';

const cmp = (a: string, b: string) => compareSemver(parseSemver(a)!, parseSemver(b)!);

describe('parseSemver', () => {
  it('parses a plain version, with and without the v prefix', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver('v10.20.30')).toEqual({ major: 10, minor: 20, patch: 30, prerelease: [] });
  });

  it('parses pre-release identifiers and ignores build metadata', () => {
    expect(parseSemver('1.0.0-rc.1')?.prerelease).toEqual(['rc', '1']);
    expect(parseSemver('v1.0.0-alpha.beta+build.5')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: ['alpha', 'beta'] });
    expect(parseSemver('1.0.0+build')?.prerelease).toEqual([]);
  });

  it.each([
    '', 'v', '1', '1.2', '1.2.3.4', '01.2.3', '1.02.3', '1.2.03', '1.2.3-', '1.2.3-rc..1', '1.2.3-rc.01', 'm3', 'platforms-1',
    'latest', '1.2.x', ' 1.2.3', '1.2.3 ', 'vv1.2.3', 'V1.2.3', '1.2.3-ü', '99999999999999999999.0.0'
  ])('rejects %j', (text) => {
    expect(parseSemver(text)).toBeNull();
  });
});

describe('parseVersionTag', () => {
  it('requires the v prefix', () => {
    expect(parseVersionTag('v0.2.0')).not.toBeNull();
    expect(parseVersionTag('0.2.0')).toBeNull();
    expect(parseVersionTag('m3')).toBeNull();
  });
});

describe('compareSemver', () => {
  it('compares numerically, not as text', () => {
    expect(cmp('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(cmp('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(cmp('0.2.1', '0.2.10')).toBeLessThan(0);
    expect(cmp('v1.2.3', '1.2.3')).toBe(0);
  });

  it('ranks a pre-release below its release and orders pre-releases by the specification', () => {
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
    for (let index = 0; index < ordered.length - 1; index += 1) {
      expect(cmp(ordered[index]!, ordered[index + 1]!), `${ordered[index]} < ${ordered[index + 1]}`).toBeLessThan(0);
      expect(cmp(ordered[index + 1]!, ordered[index]!)).toBeGreaterThan(0);
    }
  });

  it('ignores build metadata', () => {
    expect(cmp('1.0.0+a', '1.0.0+b')).toBe(0);
  });
});

describe('formatSemver', () => {
  it('writes the version without prefix and metadata', () => {
    expect(formatSemver(parseSemver('v1.2.3-rc.1+x')!)).toBe('1.2.3-rc.1');
  });
});

describe('highestVersionTag', () => {
  const tags = ['m3', 'm5', 'platforms-1', 'v0.9.0', 'v0.10.0', 'v0.2.0', 'v1.0.0-rc.1', '0.99.0', 'v1.x', 'latest'];

  it('picks the highest stable tag and ignores milestones and invalid tags', () => {
    expect(highestVersionTag(tags, 'stable')?.tag).toBe('v0.10.0');
  });

  it('considers pre-releases only on the prerelease channel', () => {
    expect(highestVersionTag(tags, 'prerelease')?.tag).toBe('v1.0.0-rc.1');
    expect(highestVersionTag([...tags, 'v1.0.0'], 'prerelease')?.tag).toBe('v1.0.0');
  });

  it('returns null when no tag is a version', () => {
    expect(highestVersionTag(['m3', 'm5', '0.1.0'], 'stable')).toBeNull();
    expect(highestVersionTag([], 'prerelease')).toBeNull();
    expect(highestVersionTag(['v1.0.0-rc.1'], 'stable')).toBeNull();
  });
});
