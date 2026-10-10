import { describe, expect, it } from 'vitest';
import { AdapterError, GalleryDlAdapter } from '../../packages/adapters/src/index.js';
import { classifyFailure } from '../../apps/worker/src/failure.js';

/*
 * F2: every form of a creator address that Patreon shows becomes the same target, which gallery-dl 1.32.16 accepts, and
 * the failures that used to end a run without a word now say what happened.
 */

// The creator and the post pattern of gallery-dl 1.32.16, gallery_dl/extractor/patreon.py (BASE_PATTERN,
// PatreonCreatorExtractor.pattern, PatreonPostExtractor.pattern), written for JavaScript. gallery-dl matches them from the
// start of the address (re.match).
const BASE = String.raw`(?:https?://)?(?:www\.)?patreon\.com`;
const CREATOR_PATTERN = new RegExp(`^${BASE}/(?!(?:home|create|login|signup|search|posts|messages)(?:$|[/?#]))(?:profile/creators|(?:cw?/)?([^/?#]+)(?:/posts)?)/?(?:\\?([^#]+))?`);
const POST_PATTERN = new RegExp(`^${BASE}/(?:[^/?#]+/)?posts/(?:[^/?#]*-)?(\\d+)`);

const CANONICAL = 'https://www.patreon.com/c/AIusagichan/posts';
const adapter = GalleryDlAdapter.forTargetValidationOnly();

describe('the address forms of a Patreon creator', () => {
  it.each([
    'https://www.patreon.com/cw/AIusagichan',
    'https://www.patreon.com/cw/AIusagichan/posts',
    'https://www.patreon.com/c/AIusagichan',
    'https://www.patreon.com/c/AIusagichan/posts',
    'https://www.patreon.com/AIusagichan',
    'https://www.patreon.com/AIusagichan/posts',
    'https://patreon.com/AIusagichan/',
    'https://www.patreon.com/cw/AIusagichan/posts?filters%5Btag%5D=x&sort=-published_at#top',
    'https://www.patreon.com/AIusagichan?utm_source=share'
  ])('%s is one creator with one canonical address', (url) => {
    expect(adapter.validateTarget(url)).toEqual({
      adapterId: 'gallery-dl', sourceType: 'patreon', kind: 'creator_feed', canonicalUrl: CANONICAL, platformId: 'AIusagichan'
    });
  });

  it('gives gallery-dl an address that its creator extractor takes for the same creator, and not for a post', () => {
    const match = CREATOR_PATTERN.exec(CANONICAL);
    expect(match?.[1]).toBe('AIusagichan');
    expect(match?.[2]).toBeUndefined();
    expect(POST_PATTERN.test(CANONICAL)).toBe(false);
  });

  it.each([
    'https://www.patreon.com/cw/AIusagichan',
    'https://www.patreon.com/cw/AIusagichan/posts',
    'https://www.patreon.com/c/AIusagichan',
    'https://www.patreon.com/c/AIusagichan/posts',
    'https://www.patreon.com/AIusagichan',
    'https://www.patreon.com/AIusagichan/posts'
  ])('%s is read by gallery-dl as the same creator', (url) => {
    expect(CREATOR_PATTERN.exec(url)?.[1]).toBe('AIusagichan');
  });

  it('keeps the spelling of the name as it was typed (two spellings are two targets; not decided here)', () => {
    expect(adapter.validateTarget('https://www.patreon.com/aiusagichan').canonicalUrl).toBe('https://www.patreon.com/c/aiusagichan/posts');
  });
});

describe('what a person is told when a feed listing fails', () => {
  const timeout = new AdapterError('PROCESS_TIMEOUT', 'External process printed nothing for 900000 ms and was terminated', undefined,
    'Patreon hat nicht rechtzeitig geantwortet; die Abfrage hat zu lange gedauert. Bereits gefundene Beiträge bleiben erhalten; Kura versucht es später automatisch erneut.');
  const tooLarge = new AdapterError('PROCESS_OUTPUT_LIMIT', 'A message of the feed listing was over the size limit and was dropped', undefined,
    'Ein Beitrag von Patreon ist zu groß, um gelesen zu werden. Die übrigen Beiträge wurden verarbeitet.');
  const cutOff = new AdapterError('NETWORK_FAILED', 'The listing ended before the feed did', undefined,
    'Die Liste der Beiträge von Patreon brach unvollständig ab. Bereits gefundene Beiträge bleiben erhalten; Kura versucht es später automatisch erneut.');

  it.each([
    ['a timeout', timeout, 'PROCESS_TIMEOUT'],
    ['a message over the limit', tooLarge, 'PROCESS_OUTPUT_LIMIT'],
    ['a listing that stopped short', cutOff, 'NETWORK_FAILED']
  ])('%s is retried with the queue\'s backoff and shows the sentence naming the platform', (_name, error, code) => {
    expect(classifyFailure(error)).toEqual({ runState: 'retry_wait', code, message: error.userMessage, retryable: true });
  });

  it('falls back to the general sentence when a tool error has no sentence of its own', () => {
    expect(classifyFailure(new AdapterError('PROCESS_OUTPUT_LIMIT', 'too much'))).toMatchObject({ retryable: true, message: expect.stringContaining('Ausgabegrenze') });
    expect(classifyFailure(new AdapterError('PROCESS_TIMEOUT', 'too slow'))).toMatchObject({ retryable: true, message: expect.stringContaining('zu lange') });
  });
});
