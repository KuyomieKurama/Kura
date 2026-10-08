import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  AdapterRegistry,
  type AdapterCapabilities,
  type CanonicalTarget,
  type SourceAdapter,
  type SourceType
} from '../../packages/adapters/src/index.js';

function fakeAdapter(adapterId: string, adapterVersion: string, sourceType: SourceType, accepts: (url: string) => boolean | 'throw' | 'broken'): SourceAdapter {
  const capabilities: AdapterCapabilities = {
    adapterId, adapterVersion, sourceTypes: [sourceType], single_post: true, creator_feed: false, pagination: false, resume: false,
    images: true, videos: false, page_snapshot: false, quality_variants: false, auth_kind: 'none', presets: ['BEST_AVAILABLE']
  };
  return {
    capabilities: () => capabilities,
    validateTarget(url: string): CanonicalTarget {
      const verdict = accepts(url);
      if (verdict === 'throw') throw new TypeError('adapter bug');
      if (verdict === 'broken') throw new AdapterError('TARGET_BROKEN', 'extractor is broken');
      if (!verdict) throw new AdapterError('TARGET_UNSUPPORTED', 'not mine');
      return { adapterId, sourceType, kind: 'post', canonicalUrl: url, platformId: 'x' };
    },
    probe: () => { throw new Error('unused'); },
    discover: () => { throw new Error('unused'); },
    resolveAssets: () => { throw new Error('unused'); },
    download: () => { throw new Error('unused'); }
  };
}

describe('AdapterRegistry', () => {
  it('lists declared capabilities of every registered adapter', () => {
    const registry = new AdapterRegistry();
    registry.register(fakeAdapter('a', '1', 'youtube', () => true));
    registry.register(fakeAdapter('b', '2', 'pixiv', () => true));
    expect(registry.listCapabilities().map((entry) => `${entry.adapterId}@${entry.adapterVersion}`)).toEqual(['a@1', 'b@2']);
  });

  it('rejects a second registration of the same adapter version but allows another version', () => {
    const registry = new AdapterRegistry();
    registry.register(fakeAdapter('a', '1', 'youtube', () => true));
    expect(() => registry.register(fakeAdapter('a', '1', 'youtube', () => true))).toThrow(/already registered/);
    expect(() => registry.register(fakeAdapter('a', '2', 'youtube', () => true))).not.toThrow();
  });

  it('selects adapters in registration order', () => {
    const registry = new AdapterRegistry();
    registry.register(fakeAdapter('first', '1', 'youtube', () => true));
    registry.register(fakeAdapter('second', '1', 'youtube', () => true));
    expect(registry.select('https://example.test/x').target.adapterId).toBe('first');
    expect(registry.lookup('https://example.test/x').candidates).toHaveLength(2);
  });

  it('a throwing adapter does not block the others', () => {
    const registry = new AdapterRegistry();
    registry.register(fakeAdapter('buggy', '1', 'youtube', () => 'throw'));
    registry.register(fakeAdapter('healthy', '1', 'youtube', () => true));
    const lookup = registry.lookup('https://example.test/x');
    expect(lookup.candidates.map((entry) => entry.target.adapterId)).toEqual(['healthy']);
    expect(lookup.failures).toHaveLength(1);
    expect(lookup.failures[0]).toMatchObject({ adapterId: 'buggy', adapterVersion: '1' });
    expect(registry.select('https://example.test/x').target.adapterId).toBe('healthy');
  });

  it('a kill switch for one adapter version leaves other versions and adapters running', () => {
    const registry = new AdapterRegistry();
    registry.register(fakeAdapter('tool', '1', 'youtube', () => true));
    registry.register(fakeAdapter('tool', '2', 'youtube', () => true));
    registry.register(fakeAdapter('other', '1', 'youtube', () => true));
    registry.disable({ adapterId: 'tool', adapterVersion: '1', reason: 'advisory' });
    const lookup = registry.lookup('https://example.test/x');
    expect(lookup.candidates.map((entry) => `${entry.target.adapterId}@${entry.adapter.capabilities().adapterVersion}`)).toEqual(['tool@2', 'other@1']);
    expect(lookup.disabled).toEqual([{ adapterId: 'tool', adapterVersion: '1', reason: 'advisory' }]);
  });

  it('a kill switch for one source type does not disable the adapter for its other source types', () => {
    const registry = new AdapterRegistry();
    const multi: SourceAdapter = {
      ...fakeAdapter('multi', '1', 'youtube', () => true),
      validateTarget: (url) => ({
        adapterId: 'multi', sourceType: url.includes('pixiv') ? 'pixiv' : 'youtube', kind: 'post', canonicalUrl: url, platformId: '1'
      })
    };
    registry.register(multi);
    registry.disable({ adapterId: 'multi', sourceType: 'pixiv', reason: 'extractor broken' });
    expect(registry.lookup('https://pixiv.test/1').candidates).toHaveLength(0);
    expect(registry.lookup('https://youtube.test/1').candidates).toHaveLength(1);
  });

  it('select reports a disabled adapter instead of "unsupported"', () => {
    const registry = new AdapterRegistry([{ adapterId: 'only', reason: 'maintenance' }]);
    registry.register(fakeAdapter('only', '1', 'youtube', () => true));
    expect(() => registry.select('https://example.test/x')).toThrowError(expect.objectContaining({ code: 'ADAPTER_DISABLED' }));
  });

  it('select reports TARGET_UNSUPPORTED when nobody accepts the URL', () => {
    const registry = new AdapterRegistry();
    registry.register(fakeAdapter('a', '1', 'youtube', () => false));
    expect(() => registry.select('https://example.test/x')).toThrowError(expect.objectContaining({ code: 'TARGET_UNSUPPORTED' }));
  });

  it('select surfaces TARGET_BROKEN so a broken extractor is not reported as "unsupported"', () => {
    const registry = new AdapterRegistry();
    registry.register(fakeAdapter('a', '1', 'instagram', () => 'broken'));
    expect(() => registry.select('https://example.test/x')).toThrowError(expect.objectContaining({ code: 'TARGET_BROKEN' }));
  });

  it('enable removes exactly the matching kill switch', () => {
    const registry = new AdapterRegistry();
    registry.register(fakeAdapter('a', '1', 'youtube', () => true));
    registry.disable({ adapterId: 'a', reason: 'whole adapter' });
    registry.disable({ adapterId: 'a', adapterVersion: '1', reason: 'one version' });
    registry.enable({ adapterId: 'a', adapterVersion: '1' });
    expect(registry.getKillSwitches().map((entry) => entry.reason)).toEqual(['whole adapter']);
    expect(() => registry.assertEnabled(registry.get('a', '1'), 'youtube')).toThrowError(expect.objectContaining({ code: 'ADAPTER_DISABLED' }));
    registry.enable({ adapterId: 'a' });
    expect(() => registry.assertEnabled(registry.get('a', '1'), 'youtube')).not.toThrow();
  });

  it('get throws ADAPTER_UNKNOWN for an unregistered version', () => {
    const registry = new AdapterRegistry();
    expect(() => registry.get('missing', '1')).toThrowError(expect.objectContaining({ code: 'ADAPTER_UNKNOWN' }));
  });
});
