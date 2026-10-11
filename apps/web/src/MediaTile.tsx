import { File, FileAudio, ImageBroken, Play } from '@phosphor-icons/react';
import { type CSSProperties, useState } from 'react';
import { contentUrl, type MediaAsset, thumbnailUrl } from './api.js';
import { altText, kindLabels, postLabel } from './media.js';
import { formatDuration } from './time-format.js';
import { Glyph } from './ui/Glyph.js';

/** The file extension of a name in capitals, "JPG", or an empty string. */
function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1, dot + 6).toUpperCase() : '';
}

/**
 * The tile of one stored file (overview mosaic, galleries). The picture is the derived preview when the server has one
 * and the original otherwise; the placeholder colour is the average colour of the picture (else surface-sunken).
 * A video shows its poster and a badge with the duration; audio and other files show a glyph and the extension; a
 * picture that cannot be loaded shows the file name and "Vorschau nicht verfügbar". Never an empty box.
 * The caption (post title and file number) appears on hover and keyboard focus.
 */
export function MediaTile({ asset, onOpen, label, width = 480, eager = false }: {
  asset: MediaAsset;
  onOpen: (asset: MediaAsset, opener: HTMLElement) => void;
  label?: string;
  width?: 480 | 960;
  eager?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const kind = asset.mediaKind;
  const preview = asset.hasThumbnail ? thumbnailUrl(asset.id, width) : kind === 'image' ? contentUrl(asset.id) : null;
  const showsPicture = (kind === 'image' || kind === 'video') && preview !== null && !broken;
  const style = asset.averageColor ? ({ '--tile-color': asset.averageColor } as CSSProperties) : undefined;

  let body;
  if (showsPicture) {
    body = (
      <img
        className="tile-image"
        data-loaded={loaded}
        src={preview}
        alt={altText(asset)}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        {...(asset.width && asset.height ? { width: asset.width, height: asset.height } : {})}
        onLoad={() => setLoaded(true)}
        onError={() => setBroken(true)}
      />
    );
  } else if (broken || (kind === 'image' && preview === null)) {
    body = (
      <span className="tile-state">
        <Glyph icon={ImageBroken} size={28} />
        <span className="tile-name">{asset.originalName}</span>
        <span className="tile-micro">Vorschau nicht verfügbar</span>
      </span>
    );
  } else if (kind === 'video') {
    body = (
      <span className="tile-state" role="img" aria-label={altText(asset)}>
        <Glyph icon={Play} size={28} />
      </span>
    );
  } else {
    body = (
      <span className="tile-state" role="img" aria-label={altText(asset)}>
        <Glyph icon={kind === 'audio' ? FileAudio : File} size={28} />
        <span className="tile-micro">{extension(asset.originalName)}</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      className="tile"
      data-media-cell={asset.id}
      style={style}
      aria-label={label ?? `${kindLabels[kind]} ${asset.originalName} ansehen`}
      onClick={(event) => onOpen(asset, event.currentTarget)}
    >
      {body}
      {kind === 'video' && (
        <span className="tile-badge" aria-hidden="true">
          <Glyph icon={Play} size={12} />
          {asset.durationSeconds ? <span>{formatDuration(asset.durationSeconds)}</span> : null}
        </span>
      )}
      <span className="tile-caption" aria-hidden="true">
        <span className="tile-caption-title">{postLabel(asset)}</span>
        <span className="tile-caption-meta">{`Datei ${asset.assetIndex + 1}`}</span>
      </span>
    </button>
  );
}
