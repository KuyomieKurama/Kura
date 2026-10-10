import { File, FileImage, FilmStrip, MusicNotes, Play } from '@phosphor-icons/react';
import { useState } from 'react';
import { contentUrl, type MediaAsset, type MediaKind } from './api.js';
import { altText } from './media.js';
import { Glyph } from './ui/Glyph.js';

const kindIcons = { image: FileImage, video: FilmStrip, audio: MusicNotes, other: File } as const satisfies Record<MediaKind, unknown>;

/**
 * The picture of a stored file in a grid cell. Images are the original, scaled by CSS and loaded lazily; a video
 * shows its first frame (the browser reads only the metadata until it is played). Without a preview (audio, other
 * files, or a file the browser cannot show) the cell shows an icon of the kind.
 */
export function MediaThumb({ asset }: { asset: Pick<MediaAsset, 'id' | 'mediaKind' | 'originalName'> }) {
  const [broken, setBroken] = useState(false);
  const url = contentUrl(asset.id);

  if (asset.mediaKind === 'image' && !broken) {
    return <img className="media-thumb" src={url} alt={altText(asset)} loading="lazy" decoding="async" onError={() => setBroken(true)} />;
  }
  if (asset.mediaKind === 'video' && !broken) {
    return (
      <>
        {/* #t shows a frame in browsers that would otherwise stay black until the first play. */}
        <video
          className="media-thumb"
          src={`${url}#t=0.1`}
          preload="metadata"
          muted
          playsInline
          disablePictureInPicture
          tabIndex={-1}
          aria-label={altText(asset)}
          onError={() => setBroken(true)}
        />
        <span className="media-badge" aria-hidden="true"><Glyph icon={Play} size={16} /></span>
      </>
    );
  }
  return (
    <span className="media-thumb media-thumb-icon" role="img" aria-label={altText(asset)}>
      <Glyph icon={kindIcons[asset.mediaKind]} size={32} />
    </span>
  );
}
