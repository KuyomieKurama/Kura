import { ArrowsClockwise } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type MediaAsset, type MediaFilter } from './api.js';
import { errorMessage } from './error-message.js';
import { groupByPost } from './media.js';
import { MediaGrid, MediaSkeleton } from './MediaGrid.js';
import { MediaViewer } from './MediaViewer.js';
import { Banner } from './ui/Banner.js';
import { Button } from './ui/Button.js';
import { EmptyState } from './ui/EmptyState.js';

const FILTERS: { value: MediaFilter; label: string; count: (counts: Counts) => number }[] = [
  { value: 'all', label: 'Alle', count: (counts) => counts.all },
  { value: 'image', label: 'Bilder', count: (counts) => counts.image },
  { value: 'video', label: 'Videos', count: (counts) => counts.video }
];
type Counts = { all: number; image: number; video: number };

/**
 * The "Medien" section of a subscription: what Kura stored for it, newest first, grouped by post, with a filter,
 * paged loading and the viewer. `reloadKey` changes when a new run finished, so the section picks up its files.
 */
export function SubscriptionMedia({ subscriptionId, reloadKey = 0 }: { subscriptionId: string; reloadKey?: number }) {
  const [filter, setFilter] = useState<MediaFilter>('all');
  const [items, setItems] = useState<MediaAsset[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  // Answers of an older request (another filter, another subscription) must not overwrite newer ones.
  const generation = useRef(0);

  const loadFirstPage = useCallback(async () => {
    const mine = ++generation.current;
    setStatus('loading');
    try {
      const page = await api.subscriptionMedia(subscriptionId, { type: filter });
      if (mine !== generation.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
      if (page.counts) setCounts(page.counts);
      setError('');
      setStatus('ready');
    } catch (cause) {
      if (mine !== generation.current) return;
      setError(errorMessage(cause));
      setStatus('error');
    }
  }, [subscriptionId, filter]);

  useEffect(() => { void loadFirstPage(); }, [loadFirstPage, reloadKey]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    try {
      const page = await api.subscriptionMedia(subscriptionId, { type: filter, cursor: nextCursor });
      if (mine !== generation.current) return;
      setItems((current) => [...current, ...page.items.filter((item) => !current.some((known) => known.id === item.id))]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (mine === generation.current) setError(errorMessage(cause));
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, subscriptionId, filter]);

  const groups = useMemo(() => groupByPost(items), [items]);
  // The viewer walks through the files in the order the grid shows them.
  const ordered = useMemo(() => groups.flatMap((group) => group.assets), [groups]);
  const viewingIndex = viewing === null ? -1 : ordered.findIndex((asset) => asset.id === viewing);

  const empty = status === 'ready' && items.length === 0;
  const nothingAtAll = empty && (counts === null || counts.all === 0);

  return (
    <section className="detail-block media-section" aria-label="Medien">
      <h4>Medien</h4>
      {counts && counts.all > 0 && (
        <div className="media-filter" role="group" aria-label="Medientyp">
          {FILTERS.map((entry) => (
            <Button
              key={entry.value}
              variant={filter === entry.value ? 'primary' : 'secondary'}
              aria-pressed={filter === entry.value}
              onClick={() => setFilter(entry.value)}
            >
              {`${entry.label} (${entry.count(counts)})`}
            </Button>
          ))}
        </div>
      )}
      {status === 'error' && (
        <Banner tone="danger">
          <p>{error}</p>
          <Button icon={ArrowsClockwise} onClick={() => void loadFirstPage()}>Erneut laden</Button>
        </Banner>
      )}
      {status === 'loading' && items.length === 0 && <MediaSkeleton />}
      {nothingAtAll && <EmptyState title="Noch nichts geladen. Starte einen Lauf mit Jetzt ausführen." />}
      {empty && !nothingAtAll && <EmptyState title="Für diesen Filter gibt es keine Dateien." hint="Wählen Sie „Alle“, um alles zu sehen." />}
      {items.length > 0 && <MediaGrid groups={groups} onOpen={(asset) => setViewing(asset.id)} />}
      {status === 'ready' && error && items.length > 0 && <Banner tone="danger">{error}</Banner>}
      {nextCursor && (
        <div className="media-more">
          <Button onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? 'Wird geladen …' : 'Weitere laden'}</Button>
        </div>
      )}
      {viewingIndex >= 0 && (
        <MediaViewer
          items={ordered}
          index={viewingIndex}
          onNavigate={(next) => setViewing(ordered[next]?.id ?? null)}
          onClose={() => setViewing(null)}
          hasMore={nextCursor !== null}
          loadingMore={loadingMore}
          onLoadMore={() => void loadMore()}
        />
      )}
    </section>
  );
}
