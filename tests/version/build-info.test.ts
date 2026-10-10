import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveBuildInfo } from '../../apps/api/src/build-info.js';
import { loadConfig } from '../../apps/api/src/config.js';

const none = () => undefined;

describe('resolveBuildInfo', () => {
  it('takes version and commit from the build environment', () => {
    expect(resolveBuildInfo({ KURA_VERSION: '0.3.1', KURA_COMMIT: 'ABCDEF1' }, none)).toEqual({ version: '0.3.1', commit: 'abcdef1' });
  });

  it('accepts a v prefix and normalises it away', () => {
    expect(resolveBuildInfo({ KURA_VERSION: 'v0.3.1-rc.2' }, none).version).toBe('0.3.1-rc.2');
  });

  it('falls back to the root package.json when the build did not set a version', () => {
    expect(resolveBuildInfo({}, () => '0.4.0')).toEqual({ version: '0.4.0', commit: 'unbekannt' });
    expect(resolveBuildInfo({ KURA_VERSION: '', KURA_COMMIT: '' }, () => '0.4.0')).toEqual({ version: '0.4.0', commit: 'unbekannt' });
  });

  it('does not trust a value that is not a version or a commit', () => {
    expect(resolveBuildInfo({ KURA_VERSION: '<script>', KURA_COMMIT: 'not a hash' }, () => '0.4.0')).toEqual({ version: '0.4.0', commit: 'unbekannt' });
    expect(resolveBuildInfo({ KURA_VERSION: 'latest', KURA_COMMIT: 'xyz' }, none)).toEqual({ version: 'unbekannt', commit: 'unbekannt' });
  });

  it('finds the root package.json of this checkout when nothing is injected', () => {
    const root = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    expect(resolveBuildInfo({}).version).toBe(root.version);
  });
});

describe('loadConfig: version and update check', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost/db' };

  it('enables the check against the public repository by default', () => {
    const config = loadConfig({ ...base, KURA_VERSION: '0.2.0', KURA_COMMIT: '1234567' });
    expect(config.build).toEqual({ version: '0.2.0', commit: '1234567' });
    expect(config.update).toEqual({ enabled: true, repository: 'KuyomieKurama/Kura', apiBase: 'https://api.github.com', channel: 'stable' });
  });

  it('reads the switches', () => {
    const config = loadConfig({ ...base, KURA_UPDATE_CHECK: 'false', KURA_UPDATE_REPO: 'me/fork', KURA_UPDATE_CHANNEL: 'prerelease', KURA_UPDATE_API_BASE: 'http://127.0.0.1:9/' });
    expect(config.update).toEqual({ enabled: false, repository: 'me/fork', apiBase: 'http://127.0.0.1:9', channel: 'prerelease' });
  });

  it.each([
    { KURA_UPDATE_CHECK: 'maybe' },
    { KURA_UPDATE_REPO: 'no-slash' },
    { KURA_UPDATE_REPO: 'a/b/c' },
    { KURA_UPDATE_REPO: '../x/y' },
    { KURA_UPDATE_REPO: '../x' },
    { KURA_UPDATE_REPO: 'x/..' },
    { KURA_UPDATE_CHANNEL: 'nightly' },
    { KURA_UPDATE_API_BASE: 'ftp://example.com' },
    { KURA_UPDATE_API_BASE: 'not a url' }
  ])('rejects %j', (extra) => {
    expect(() => loadConfig({ ...base, ...extra })).toThrow();
  });
});
