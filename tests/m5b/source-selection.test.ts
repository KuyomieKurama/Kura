import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  GalleryDlAdapter,
  YtDlpAdapter,
  createTargetRecognizer,
  selectSource
} from '../../packages/adapters/src/index.js';

const recognizer = createTargetRecognizer();

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterError);
    return (error as AdapterError).code;
  }
  throw new Error('expected an AdapterError');
}

describe('selectSource', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'yt-dlp', 'youtube'],
    ['https://youtu.be/dQw4w9WgXcQ', 'yt-dlp', 'youtube'],
    ['https://www.pixiv.net/artworks/98765', 'gallery-dl', 'pixiv'],
    ['https://www.instagram.com/p/Cabc12345/', 'gallery-dl', 'instagram'],
    ['https://media.example.test/files/pic.jpg', 'direct-url', 'direct_media']
  ])('recognises %s as %s', (url, adapterId, sourceType) => {
    const { adapter, target } = selectSource(recognizer, url);
    expect(adapter.capabilities().adapterId).toBe(adapterId);
    expect(target.sourceType).toBe(sourceType);
  });

  it('never hands a URL on a known platform to the direct URL adapter', () => {
    expect(codeOf(() => selectSource(recognizer, 'https://www.youtube.com/playlist?list=PL12345'))).toBe('TARGET_UNSUPPORTED');
    expect(codeOf(() => selectSource(recognizer, 'https://www.pornhub.com/view_video.php?viewkey=abc'))).toBe('TARGET_UNSUPPORTED');
    expect(codeOf(() => selectSource(recognizer, 'https://www.patreon.com/someone'))).toBe('TARGET_UNSUPPORTED');
  });

  it('reports a known broken target instead of falling back to a direct download', () => {
    expect(codeOf(() => selectSource(recognizer, 'https://www.instagram.com/someprofile/'))).toBe('TARGET_BROKEN');
  });

  it('reports invalid URLs as invalid', () => {
    expect(codeOf(() => selectSource(recognizer, 'http://media.example.test/pic.jpg'))).toBe('TARGET_INVALID');
    expect(codeOf(() => selectSource(recognizer, 'ftp://media.example.test/pic.jpg'))).toBe('TARGET_INVALID');
    expect(codeOf(() => selectSource(recognizer, 'https://user:secret@media.example.test/pic.jpg'))).toBe('TARGET_INVALID');
    expect(codeOf(() => selectSource(recognizer, 'not a url'))).toBe('TARGET_INVALID');
  });

  it('respects kill switches and says so', () => {
    const switched = createTargetRecognizer();
    switched.disable({ adapterId: 'yt-dlp', reason: 'broken extractor' });
    expect(codeOf(() => selectSource(switched, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'))).toBe('ADAPTER_DISABLED');
    // A kill switch on one adapter does not affect the others.
    expect(selectSource(switched, 'https://www.pixiv.net/artworks/98765').adapter.capabilities().adapterId).toBe('gallery-dl');
  });
});

describe('validation-only adapters', () => {
  it('recognise targets but can never start a tool or create a directory', async () => {
    const ytDlp = YtDlpAdapter.forTargetValidationOnly();
    const galleryDl = GalleryDlAdapter.forTargetValidationOnly();
    expect(ytDlp.capabilities().adapterVersion).toBe('not-installed');
    const target = ytDlp.validateTarget('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await expect(ytDlp.probe({ jobId: 'j', leaseGeneration: 1, target })).rejects.toMatchObject({ code: 'BINARY_NOT_CONFIGURED' });
    const pixiv = galleryDl.validateTarget('https://www.pixiv.net/artworks/98765');
    await expect(galleryDl.probe({ jobId: 'j', leaseGeneration: 1, target: pixiv })).rejects.toMatchObject({ code: 'BINARY_NOT_CONFIGURED' });
    await expect(galleryDl.resolveAssets({
      adapterId: 'gallery-dl', sourceType: 'pixiv', platformPostId: '98765', creator: { platformId: '1', displayName: null },
      title: null, publishedAt: null, revisionKey: 'r', canonicalUrl: pixiv.canonicalUrl
    }, { preset: 'BEST_AVAILABLE' })).rejects.toMatchObject({ code: 'BINARY_NOT_CONFIGURED' });
  });
});
