import { createHash } from 'node:crypto';
import type { SourceType } from './types.js';

/**
 * Revision keys (docs/planning/04, "Inkrementelle Synchronisierung", point 4: a new revision is a new asset
 * version). A key must change when the post really changed and never otherwise, so it is derived only from what the
 * platform identifies stably: the id of the post and the ids of its files. Never from dates of a listing, file
 * extensions, (signed) URLs, titles or counters; these differ between two requests for the same, unchanged post.
 * Neither gallery-dl (Instagram, Patreon, Pixiv, Pornhub albums) nor yt-dlp reports a real edit field: gallery-dl
 * 1.32.16 does not even request Patreon's `edited_at` (extractor/patreon.py, `fields[post]`), and the Pixiv API
 * object has no `update_date`.
 */

const KEY_DIGEST_LENGTH = 24;

/** gallery-dl posts: the post id plus the sorted set of the ids of its files. */
export function galleryDlRevisionKey(platformPostId: string, fileIds: readonly string[]): string {
  const sorted = [...new Set(fileIds)].sort();
  return `g-${digest(`${platformPostId}|${sorted.join(',')}`)}`;
}

/** yt-dlp videos: the video id alone. A re-upload has another id; an edited title or a view count is no new revision. */
export function videoRevisionKey(videoId: string): string {
  return `v-${digest(videoId)}`;
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, KEY_DIGEST_LENGTH);
}

/**
 * Keys of the formats before D3: gallery-dl `l-` (post id, listing date, file extensions), yt-dlp `d-` (id, upload
 * date, duration) and `f-` (id). The first two contained values that change between requests, so a post archived
 * under such a key can come back under a different one although nothing changed. The worker therefore treats a
 * completely archived post with an old-format key as unchanged and does not compare keys across the two formats.
 */
export function isLegacyRevisionKey(revisionKey: string): boolean {
  return /^(?:l|d|f)-[0-9a-f]{24}$/.test(revisionKey);
}

/**
 * True if the same id in another revision of the same post means the same bytes, so a stored file can be reused
 * for it. Positional ids ("file-N"), the ugoira ids and everything of a direct URL (whose new revision means a
 * changed file) do not qualify.
 */
export function isContentStableAssetId(sourceType: SourceType, sourceAssetId: string): boolean {
  if (sourceType === 'direct_media') return false;
  if (sourceType === 'youtube' || sourceType === 'pornhub') {
    return sourceAssetId === 'video' || /^photo-/.test(sourceAssetId);
  }
  return /^(?:media|hash|page)-/.test(sourceAssetId);
}
