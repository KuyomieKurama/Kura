import { ArrowSquareOut, CaretLeft, CaretRight, DownloadSimple, File as FileIcon, Info, X } from '@phosphor-icons/react';
import { useEffect, useId, useRef, useState } from 'react';
import { contentUrl, type MediaAsset, thumbnailUrl } from './api.js';
import { formatBytes, handoverLabels } from './history-labels.js';
import { labels } from './labels.js';
import { altText, kindLabels, platformLabel, postLabel, safeExternalUrl } from './media.js';
import { formatInstant } from './schedule-format.js';
import { Button } from './ui/Button.js';
import { Glyph } from './ui/Glyph.js';
import { openedByTransition } from './viewTransition.js';

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const FOCUSABLE = 'a[href], button:not([disabled]), video[controls], audio[controls], [tabindex]:not([tabindex="-1"])';

/** Native media controls use the arrow keys themselves (seeking, volume); the viewer must not take them over. */
const isMediaControl = (target: EventTarget | null) => target instanceof HTMLMediaElement;

function Stage({ asset }: { asset: MediaAsset }) {
  const url = contentUrl(asset.id);
  // key: a new element per file, so a video never keeps playing the previous one.
  if (asset.mediaKind === 'image') return <img key={asset.id} className="viewer-media" src={url} alt={altText(asset)} />;
  if (asset.mediaKind === 'video') return <video key={asset.id} className="viewer-media" src={url} controls preload="metadata" playsInline aria-label={altText(asset)} />;
  if (asset.mediaKind === 'audio') return <audio key={asset.id} className="viewer-audio" src={url} controls preload="metadata" aria-label={altText(asset)} />;
  return <p className="viewer-nopreview">Für diesen Dateityp gibt es keine Vorschau. Du kannst die Datei herunterladen.</p>;
}

function Metadata({ asset }: { asset: MediaAsset }) {
  const source = safeExternalUrl(asset.postUrl);
  const immich = asset.immich.verified
    ? handoverLabels.verified
    : handoverLabels[asset.immich.state] ?? asset.immich.state;
  return (
    <dl className="viewer-meta">
      <div><dt>Dateiname</dt><dd className="break">{asset.originalName}</dd></div>
      <div><dt>Größe</dt><dd>{formatBytes(asset.byteSize)}</dd></div>
      <div><dt>Typ</dt><dd>{`${kindLabels[asset.mediaKind]} (${asset.mimeType})`}</dd></div>
      <div><dt>Gespeichert am</dt><dd>{asset.storedAt ? formatInstant(asset.storedAt, zone()) : 'noch nicht'}</dd></div>
      <div>
        <dt>Beitrag</dt>
        <dd>
          {postLabel(asset)}
          <span className="meta">{`${platformLabel(asset.platform)}${asset.creatorName ? `, ${asset.creatorName}` : ''}`}</span>
        </dd>
      </div>
      {source && (
        <div>
          <dt>Quelle</dt>
          <dd>
            <a href={source} target="_blank" rel="noopener noreferrer" className="external-link">
              {`Beitrag auf ${platformLabel(asset.platform)} öffnen`}
              <Glyph icon={ArrowSquareOut} size={14} />
              <span className="sr-only"> (öffnet in neuem Tab)</span>
            </a>
          </dd>
        </div>
      )}
      <div>
        <dt>Immich</dt>
        <dd>
          {immich}
          {asset.immich.verified && asset.immich.verifiedAt && <span className="meta">{`Geprüft am ${formatInstant(asset.immich.verifiedAt, zone())}`}</span>}
        </dd>
      </div>
    </dl>
  );
}

/**
 * The viewer for one stored file: a full-screen modal dialog with the file, previous/next (buttons and arrow keys), the
 * strip of the post's files, an info column (key I) and the explicit download. Escape closes it. While it is open the focus stays inside; on close it
 * returns to the cell of the file that was shown last (the opener, if the user did not move on).
 */
export function MediaViewer({ items, index, onNavigate, onClose, hasMore = false, loadingMore = false, onLoadMore }: {
  items: MediaAsset[];
  index: number;
  onNavigate: (index: number) => void;
  onClose: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}) {
  const asset = items[index];
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const current = useRef(asset?.id);
  current.current = asset?.id;
  const opener = useRef<Element | null>(document.activeElement);
  // Read once: opened by the view transition (the tile morphs) or, without it, by a short fade.
  const [enter] = useState(() => (openedByTransition() ? 'morph' : 'fade'));

  useEffect(() => {
    const previouslyFocused = opener.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus();

    // Focus must not leave the dialog, not even through a click on the page behind it.
    const keepFocusInside = (event: FocusEvent) => {
      if (dialog.current && event.target instanceof Node && !dialog.current.contains(event.target)) dialog.current.focus();
    };
    document.addEventListener('focusin', keepFocusInside);

    return () => {
      document.removeEventListener('focusin', keepFocusInside);
      document.body.style.overflow = previousOverflow;
      const cell = document.querySelector<HTMLElement>(`[data-media-cell="${current.current}"]`);
      const target = cell ?? (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected ? previouslyFocused : null);
      target?.focus();
    };
  }, []);

  // Reaching the end of what is loaded loads the next page, so "next" keeps working.
  useEffect(() => {
    if (hasMore && !loadingMore && index >= items.length - 2) onLoadMore?.();
  }, [hasMore, loadingMore, index, items.length, onLoadMore]);

  const hasPrevious = index > 0;
  const hasNext = index < items.length - 1;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowLeft' && hasPrevious && !isMediaControl(event.target)) {
      event.preventDefault();
      onNavigate(index - 1);
    } else if (event.key === 'ArrowRight' && hasNext && !isMediaControl(event.target)) {
      event.preventDefault();
      onNavigate(index + 1);
    } else if (event.key === 'Tab' && dialog.current) {
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      const active = document.activeElement;
      const outside = !dialog.current.contains(active);
      // A button that was just disabled (the last "Nächste") drops the focus; Tab then starts again inside.
      if (outside || (event.shiftKey && (active === first || active === dialog.current))) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  // One listener on the document for the whole lifetime: it also sees keys while the focus is on <body>.
  const latestKeyHandler = useRef(onKeyDown);
  latestKeyHandler.current = onKeyDown;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => latestKeyHandler.current(event);
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, []);

  const [info, setInfo] = useState(() => typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 1280px)').matches);
  const infoRef = useRef(setInfo);
  infoRef.current = setInfo;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.key === 'i' || event.key === 'I') && !event.ctrlKey && !event.metaKey && !event.altKey && !isMediaControl(event.target)) infoRef.current((open) => !open);
    };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, []);

  if (!asset) return null;
  // The strip shows the other files of the same post, so a carousel can be walked through without leaving the file.
  const siblings = items.map((item, position) => ({ item, position })).filter(({ item }) => item.postId === asset.postId);
  return (
    <div className="viewer-screen" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialog} data-info={info} data-enter={enter}>
      <header className="viewer-bar">
        <Button variant="ghost" icon={X} className="viewer-close" aria-label={labels.close} onClick={onClose}><span className="viewer-btn-label">{labels.close}</span></Button>
        <h2 id={titleId} className="viewer-title" title={asset.originalName}>{postLabel(asset)}</h2>
        <p className="meta viewer-position num" aria-live="polite">{`${index + 1} von ${items.length}${hasMore ? '+' : ''}`}</p>
        <Button variant="ghost" icon={Info} className="viewer-info-toggle" aria-label="Info" aria-pressed={info} onClick={() => setInfo(!info)}><span className="viewer-btn-label">Info</span></Button>
      </header>
      <div className="viewer-stage">
        <div className="viewer-frame"><Stage asset={asset} /></div>
        <button type="button" className="viewer-arrow viewer-arrow-prev" aria-label="Vorherige" disabled={!hasPrevious} onClick={() => onNavigate(index - 1)}>
          <Glyph icon={CaretLeft} size={24} />
        </button>
        <button type="button" className="viewer-arrow viewer-arrow-next" aria-label="Nächste" disabled={!hasNext} onClick={() => onNavigate(index + 1)}>
          <Glyph icon={CaretRight} size={24} />
        </button>
      </div>
      {siblings.length > 1 && (
        <ul className="viewer-strip" aria-label="Dateien dieses Beitrags">
          {siblings.map(({ item, position }) => (
            <li key={item.id}>
              <button
                type="button"
                className="viewer-strip-item"
                aria-label={`${kindLabels[item.mediaKind]} ${item.originalName}`}
                aria-current={item.id === asset.id ? 'true' : undefined}
                onClick={() => onNavigate(position)}
              >
                {item.mediaKind === 'image' || item.hasThumbnail
                  ? <img src={item.hasThumbnail ? thumbnailUrl(item.id, 480) : contentUrl(item.id)} alt="" loading="lazy" />
                  : <Glyph icon={FileIcon} size={20} />}
              </button>
            </li>
          ))}
        </ul>
      )}
      <aside className="viewer-info" aria-label="Informationen zur Datei" hidden={!info}>
        <Metadata asset={asset} />
        <div className="form-actions">
          <a className="btn btn-primary" href={contentUrl(asset.id, true)} download={asset.originalName}>
            <Glyph icon={DownloadSimple} />
            Herunterladen
          </a>
        </div>
      </aside>
    </div>
  );
}
