import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  AdapterRegistry,
  GalleryDlAdapter,
  YtDlpAdapter,
  createTargetRecognizer,
  selectSource
} from '../../packages/adapters/src/index.js';

const adapter = GalleryDlAdapter.forTargetValidationOnly();

function refusal(url: string): AdapterError {
  try {
    adapter.validateTarget(url);
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterError);
    return error as AdapterError;
  }
  throw new Error(`expected ${url} to be refused`);
}

describe('Instagram targets: profiles', () => {
  it.each([
    ['https://www.instagram.com/own_test.account/', 'https://www.instagram.com/own_test.account/', 'own_test.account'],
    ['https://www.instagram.com/owntest', 'https://www.instagram.com/owntest/', 'owntest'],
    ['https://instagram.com/owntest/', 'https://www.instagram.com/owntest/', 'owntest'],
    ['https://www.instagram.com/OwnTest/', 'https://www.instagram.com/owntest/', 'owntest'],
    ['https://www.instagram.com/owntest/?igsh=MTIzNDU2&utm_source=qr&utm_medium=copy_link', 'https://www.instagram.com/owntest/', 'owntest'],
    ['https://www.instagram.com/owntest/#top', 'https://www.instagram.com/owntest/', 'owntest'],
    ['https://www.instagram.com/' + 'a'.repeat(30) + '/', 'https://www.instagram.com/' + 'a'.repeat(30) + '/', 'a'.repeat(30)],
    ['https://www.instagram.com/_/', 'https://www.instagram.com/_/', '_'],
    ['https://www.instagram.com/9/', 'https://www.instagram.com/9/', '9']
  ])('accepts the profile %s', (input, canonicalUrl, platformId) => {
    expect(adapter.validateTarget(input)).toEqual({ adapterId: 'gallery-dl', sourceType: 'instagram', kind: 'creator_feed', canonicalUrl, platformId });
  });

  it('treats the reels tab as the same creator with its own canonical URL (scope "reels only")', () => {
    const target = adapter.validateTarget('https://www.instagram.com/OwnTest/reels/?igsh=x');
    expect(target).toEqual({
      adapterId: 'gallery-dl', sourceType: 'instagram', kind: 'creator_feed', canonicalUrl: 'https://www.instagram.com/owntest/reels/', platformId: 'owntest'
    });
    // A different canonical URL means a different subscription target and a different sync state.
    expect(target.canonicalUrl).not.toBe(adapter.validateTarget('https://www.instagram.com/owntest/').canonicalUrl);
  });

  it.each([
    ['a name that is too long', 'https://www.instagram.com/' + 'a'.repeat(31) + '/'],
    ['a forbidden character', 'https://www.instagram.com/own!test/'],
    ['a percent-encoded space', 'https://www.instagram.com/own%20test/'],
    ['a dash', 'https://www.instagram.com/own-test/'],
    ['only dots (the URL parser would drop them)', 'https://www.instagram.com/.../'],
    ['an option look-alike', 'https://www.instagram.com/--exec=touch/'],
    ['an at sign', 'https://www.instagram.com/@owntest/']
  ])('refuses %s as an invalid username with a German message', (_name, input) => {
    const error = refusal(input);
    expect(error.code).toBe('TARGET_INVALID');
    expect(error.userMessage).toMatch(/Benutzername ist ungültig/);
  });
});

describe('Instagram targets: single posts and reels', () => {
  it.each([
    ['https://www.instagram.com/p/DPhoto00001/', 'https://www.instagram.com/p/DPhoto00001/', 'DPhoto00001'],
    ['https://www.instagram.com/p/DPhoto00001', 'https://www.instagram.com/p/DPhoto00001/', 'DPhoto00001'],
    ['https://instagram.com/p/DPhoto00001/?img_index=2&igsh=abc', 'https://www.instagram.com/p/DPhoto00001/', 'DPhoto00001'],
    ['https://www.instagram.com/p/D-Ph_oto001/', 'https://www.instagram.com/p/D-Ph_oto001/', 'D-Ph_oto001'],
    ['https://www.instagram.com/reel/DNewReel001/', 'https://www.instagram.com/reel/DNewReel001/', 'DNewReel001'],
    ['https://www.instagram.com/reels/DNewReel001/', 'https://www.instagram.com/reel/DNewReel001/', 'DNewReel001'],
    ['https://www.instagram.com/owntest/p/DPhoto00001/', 'https://www.instagram.com/p/DPhoto00001/', 'DPhoto00001'],
    ['https://www.instagram.com/owntest/reel/DNewReel001/?utm_source=ig_web_copy_link', 'https://www.instagram.com/reel/DNewReel001/', 'DNewReel001']
  ])('accepts %s', (input, canonicalUrl, platformId) => {
    expect(adapter.validateTarget(input)).toEqual({ adapterId: 'gallery-dl', sourceType: 'instagram', kind: 'post', canonicalUrl, platformId });
  });

  it.each([
    ['too short', 'https://www.instagram.com/p/abc/'],
    ['too long (gallery-dl would cut it)', 'https://www.instagram.com/p/' + 'a'.repeat(29) + '/'],
    ['an option look-alike', 'https://www.instagram.com/p/--exec=id/'],
    ['with a dot', 'https://www.instagram.com/reel/abc.defgh/'],
    ['percent-encoded', 'https://www.instagram.com/p/abc%2Fdefgh/']
  ])('refuses a shortcode that is %s', (_name, input) => {
    const error = refusal(input);
    expect(error.code).toBe('TARGET_INVALID');
    expect(error.userMessage).toMatch(/Kennung des Instagram-Beitrags ist ungültig/);
  });

  it('refuses extra path parts after the shortcode', () => {
    for (const input of ['https://www.instagram.com/p/DPhoto00001/comments/', 'https://www.instagram.com/owntest/p/DPhoto00001/embed/']) {
      expect(refusal(input)).toMatchObject({ code: 'TARGET_UNSUPPORTED', userMessage: expect.stringContaining('zusätzliche Pfadteile') });
    }
  });
});

describe('Instagram targets: what is refused, and how', () => {
  it.each([
    ['https://www.instagram.com/stories/owntest/', /Stories sind zurzeit nicht unterstützt/],
    ['https://www.instagram.com/stories/owntest/3000000000000000001/', /Stories sind zurzeit nicht unterstützt/],
    ['https://www.instagram.com/owntest/stories/', /Stories sind zurzeit nicht unterstützt/],
    ['https://www.instagram.com/stories/highlights/17900000000000000/', /Highlights sind zurzeit nicht unterstützt/],
    ['https://www.instagram.com/owntest/highlights/', /Highlights sind zurzeit nicht unterstützt/],
    ['https://www.instagram.com/owntest/tagged/', /Markierte Beiträge .* zurzeit nicht unterstützt/],
    ['https://www.instagram.com/tv/DPhoto00001/', /IGTV.* zurzeit nicht unterstützt/],
    ['https://www.instagram.com/reels/', /Reels-Feed ist zurzeit nicht unterstützt/],
    ['https://www.instagram.com/owntest/followers/', /Unterseite eines Instagram-Profils ist zurzeit nicht unterstützt/],
    ['https://www.instagram.com/owntest/saved/', /Unterseite eines Instagram-Profils ist zurzeit nicht unterstützt/],
    ['https://www.instagram.com/', /Startseite von Instagram/]
  ])('refuses %s as TARGET_UNSUPPORTED', (input, message) => {
    const error = refusal(input);
    expect(error.code).toBe('TARGET_UNSUPPORTED');
    expect(error.userMessage).toMatch(message);
  });

  it.each([
    'explore', 'accounts', 'direct', 'about', 'legal', 'developer', 'p', 'reel', 'api', 'graphql', 'challenge', 'privacy', 'web', 'oauth'
  ])('does not take the Instagram page "%s" for a profile', (name) => {
    const error = refusal(`https://www.instagram.com/${name}/`);
    expect(error.code).toBe('TARGET_UNSUPPORTED');
    expect(error.userMessage).toMatch(/kein Profil, kein Beitrag und kein Reel/);
  });

  it('refuses paths below reserved pages without looking at the rest', () => {
    for (const path of ['explore/tags/owntest/', 'accounts/login/', 'direct/inbox/', 'legal/privacy/', 'explore/locations/123/x/']) {
      expect(refusal(`https://www.instagram.com/${path}`).code).toBe('TARGET_UNSUPPORTED');
    }
  });

  it('keeps the general rules: https only, no credentials, no look-alike hosts, no control characters', () => {
    expect(refusal('http://www.instagram.com/owntest/').code).toBe('TARGET_INVALID');
    expect(refusal('https://user:pw@www.instagram.com/owntest/').code).toBe('TARGET_INVALID');
    expect(refusal('https://www.instagram.com/owntest/\n--exec=id').code).toBe('TARGET_INVALID');
    expect(refusal('--exec=touch /tmp/pwned').code).toBe('TARGET_INVALID');
    expect(refusal('https://www.instagram.com.evil.example.test/owntest/').code).toBe('TARGET_UNSUPPORTED');
    expect(refusal('https://instagram.evil.example.test/p/DPhoto00001/').code).toBe('TARGET_UNSUPPORTED');
  });

  it('never puts the input into a user message', () => {
    const error = refusal('https://www.instagram.com/own!test<script>/');
    expect(error.userMessage).not.toContain('script');
    expect(error.message).not.toContain('script');
  });
});

describe('source selection for Instagram', () => {
  const recognizer = createTargetRecognizer();

  it.each([
    ['https://www.instagram.com/owntest/', 'creator_feed'],
    ['https://www.instagram.com/owntest/reels/', 'creator_feed'],
    ['https://www.instagram.com/p/DPhoto00001/', 'post'],
    ['https://www.instagram.com/reel/DNewReel001/', 'post']
  ])('sends %s to gallery-dl as %s', (url, kind) => {
    const { adapter: chosen, target } = selectSource(recognizer, url);
    expect(chosen.capabilities().adapterId).toBe('gallery-dl');
    expect(target.kind).toBe(kind);
  });

  it('refuses stories with the precise German sentence instead of a general one', () => {
    let caught: unknown;
    try {
      selectSource(recognizer, 'https://www.instagram.com/stories/owntest/');
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'TARGET_UNSUPPORTED', userMessage: expect.stringContaining('zurzeit nicht unterstützt') });
  });

  it('keeps yt-dlp as the fallback for single posts and reels, but never for profiles', () => {
    const onlyYtDlp = new AdapterRegistry();
    onlyYtDlp.register(YtDlpAdapter.forTargetValidationOnly());
    expect(selectSource(onlyYtDlp, 'https://www.instagram.com/reel/DNewReel001/').adapter.capabilities().adapterId).toBe('yt-dlp');
    expect(() => selectSource(onlyYtDlp, 'https://www.instagram.com/owntest/')).toThrowError(expect.objectContaining({ code: 'TARGET_BROKEN' }));
    // Not a profile at all: yt-dlp does not call a reserved page "broken".
    expect(() => selectSource(onlyYtDlp, 'https://www.instagram.com/explore/')).toThrowError(expect.objectContaining({ code: 'TARGET_UNSUPPORTED' }));
  });

  it('the recognizer lists gallery-dl first, so it wins for single posts as well', () => {
    expect(selectSource(recognizer, 'https://www.instagram.com/p/DPhoto00001/').adapter.capabilities().adapterId).toBe('gallery-dl');
  });
});
