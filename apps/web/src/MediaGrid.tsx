import { Stack } from '@phosphor-icons/react';
import { type CSSProperties, type KeyboardEvent, useRef } from 'react';
import type { MediaAsset } from './api.js';
import type { PostGroup } from './media.js';
import { MediaTile } from './MediaTile.js';
import { Chip } from './ui/Chip.js';

/**
 * Moves the focus between the cells with the arrow keys (left/right: neighbour, up/down: the cell above or below
 * in the same column of the wrapped layout, Home/End: first/last). Tab still reaches every cell.
 */
function moveFocus(event: KeyboardEvent<HTMLElement>, container: HTMLElement) {
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const cells = [...container.querySelectorAll<HTMLElement>('[data-media-cell]')];
  const current = cells.indexOf(event.target as HTMLElement);
  if (current < 0) return;

  let next = current;
  if (event.key === 'ArrowLeft') next = current - 1;
  else if (event.key === 'ArrowRight') next = current + 1;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = cells.length - 1;
  else {
    const here = cells[current]!.getBoundingClientRect();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    // The closest cell in the next row (a different top edge) whose centre is nearest to this cell's centre.
    const candidates = cells.filter((cell) => direction * (cell.getBoundingClientRect().top - here.top) > 1);
    if (candidates.length > 0) {
      const rowTop = direction === 1
        ? Math.min(...candidates.map((cell) => cell.getBoundingClientRect().top))
        : Math.max(...candidates.map((cell) => cell.getBoundingClientRect().top));
      const row = candidates.filter((cell) => Math.abs(cell.getBoundingClientRect().top - rowTop) <= 1);
      const centre = here.left + here.width / 2;
      const nearest = row.reduce((best, cell) => {
        const box = cell.getBoundingClientRect();
        const distance = Math.abs(box.left + box.width / 2 - centre);
        return distance < best.distance ? { cell, distance } : best;
      }, { cell: row[0]!, distance: Infinity });
      next = cells.indexOf(nearest.cell);
    }
  }
  if (next >= 0 && next < cells.length && next !== current) {
    event.preventDefault();
    cells[next]!.focus();
  }
}

/** The aspect ratio of a file for the justified rows: width / height, clamped to 0.6 to 2.4; 1 when the size is unknown. */
export function aspectRatio(asset: Pick<MediaAsset, 'width' | 'height'>): number {
  if (!asset.width || !asset.height) return 1;
  return Math.min(2.4, Math.max(0.6, asset.width / asset.height));
}

export function MediaCell({ asset, onOpen, label }: { asset: MediaAsset; onOpen: (asset: MediaAsset, opener: HTMLElement) => void; label?: string }) {
  return <MediaTile asset={asset} onOpen={onOpen} {...(label ? { label } : {})} />;
}

/** Justified rows without script: every tile grows in proportion to its aspect ratio, the last row is not stretched. */
export function Gallery({ assets, onOpen }: { assets: MediaAsset[]; onOpen: (asset: MediaAsset, opener: HTMLElement) => void }) {
  return (
    <ul className="gallery">
      {assets.map((asset) => (
        <li key={asset.id} className="gallery-item" style={{ '--ar': aspectRatio(asset) } as CSSProperties}>
          <MediaCell asset={asset} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

export function MediaSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Medien werden geladen …</span>
      <ul className="gallery" aria-hidden="true">
        {Array.from({ length: count }, (_, index) => <li key={index} className="gallery-item" style={{ '--ar': 1 } as CSSProperties}><div className="skeleton-tile" /></li>)}
      </ul>
    </div>
  );
}

/** Stored files grouped by post: a carousel post shows its files together, with their count. */
export function MediaGrid({ groups, onOpen }: { groups: PostGroup[]; onOpen: (asset: MediaAsset, opener: HTMLElement) => void }) {
  const container = useRef<HTMLDivElement>(null);
  return (
    <div className="media-groups" ref={container} onKeyDown={(event) => container.current && moveFocus(event, container.current)}>
      {groups.map((group) => (
        <section key={group.postId} className="media-group" aria-label={`Beitrag ${group.title}`}>
          <header className="media-group-head">
            <h5 className="truncate" title={group.title}>{group.title}</h5>
            {group.assets.length > 1 && <Chip tone="neutral" icon={Stack}>{`${group.assets.length} Dateien`}</Chip>}
          </header>
          <Gallery assets={group.assets} onOpen={onOpen} />
        </section>
      ))}
    </div>
  );
}
