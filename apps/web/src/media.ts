import type { MediaAsset, MediaKind } from './api.js';
import { platformLabels } from './history-labels.js';

export const kindLabels: Record<MediaKind, string> = {
  image: 'Bild',
  video: 'Video',
  audio: 'Audio',
  other: 'Datei'
};

/** Alt text of a picture: what it is and what the file is called. The picture itself is not described. */
export function altText(asset: Pick<MediaAsset, 'mediaKind' | 'originalName'>): string {
  return `${kindLabels[asset.mediaKind]}: ${asset.originalName}`;
}

export interface PostGroup {
  postId: string;
  title: string;
  creatorName: string | null;
  platform: string;
  /** True when the source gave the post a title; false when `title` is the fallback. */
  titled: boolean;
  postUrl: string | null;
  /** When the newest file of the post was stored. */
  storedAt: string | null;
  assets: MediaAsset[];
}

/** Title of a post as shown to the user: the title the source gave, else "Ohne Titel". A raw platform id is never shown. */
export function postLabel(asset: Pick<MediaAsset, 'postTitle'>): string {
  return asset.postTitle?.trim() || 'Ohne Titel';
}

/**
 * Groups files by post. The groups keep the order in which their first file appears, the files inside a group
 * follow the order of the post. A post that continues on the next page is merged into its existing group.
 */
export function groupByPost(assets: readonly MediaAsset[]): PostGroup[] {
  const groups = new Map<string, PostGroup>();
  for (const asset of assets) {
    const group = groups.get(asset.postId) ?? {
      postId: asset.postId,
      title: postLabel(asset),
      creatorName: asset.creatorName,
      platform: asset.platform,
      titled: Boolean(asset.postTitle?.trim()),
      postUrl: asset.postUrl,
      storedAt: asset.storedAt,
      assets: []
    };
    group.assets.push(asset);
    groups.set(asset.postId, group);
  }
  for (const group of groups.values()) {
    group.assets.sort((first, second) => first.assetIndex - second.assetIndex);
    // The newest file stored decides the time of the post.
    group.storedAt = group.assets.reduce<string | null>((newest, asset) => (asset.storedAt && (!newest || asset.storedAt > newest) ? asset.storedAt : newest), null);
  }
  return [...groups.values()];
}

export function platformLabel(platform: string): string {
  return platformLabels[platform] ?? platform;
}

/** Only web links open from the viewer; anything else in a stored address is not offered as a link. */
export function safeExternalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}
