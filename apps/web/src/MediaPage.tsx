import { ArrowsClockwise } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type MediaAsset, type MediaFilter, type Subscription } from './api.js';
import { errorMessage } from './error-message.js';
import { labels } from './labels.js';
import { Gallery, MediaSkeleton } from './MediaGrid.js';
import { MediaViewer } from './MediaViewer.js';
import { dayLabel } from './time-format.js';
import { Banner } from './ui/Banner.js';
import { Button } from './ui/Button.js';
import { EmptyState } from './ui/EmptyState.js';
import { PageHeader } from './ui/PageHeader.js';
import { Segmented } from './ui/Segmented.js';

const PAGE_SIZE = 40;
const FILTERS: { value: MediaFilter; label: string }[] = [
  { value: 'all', label: 'Alle' },
  { value: 'image', label: 'Bilder' },
  { value: 'video', label: 'Videos' }
];

type Day = { key: string; label: string; assets: MediaAsset[] };

/** Groups by the day of storing, newest first (the server already sends them in that order). */
export function groupByDay(assets: readonly MediaAsset[], now: Date = new Date()): Day[] {
  const days: Day[] = [];
  for (const asset of assets) {
    const date = asset.storedAt ? new Date(asset.storedAt) : null;
    const key = date ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` : 'unknown';
    let day = days[days.length - 1];
    if (!day || day.key !== key) {
      day = { key, label: date ? dayLabel(date, now) : 'Ohne Datum', assets: [] };
      days.push(day);
    }
    day.assets.push(asset);
  }
  return days;
}

/** All stored files over all subscriptions: by day, newest first, with a filter and paged loading. */
export function MediaPage() {
  const [filter, setFilter] = useState<MediaFilter>('all');
  const [subscriptionId, setSubscriptionId] = useState('');
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [items, setItems] = useState<MediaAsset[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    api.subscriptions().then((result) => setSubscriptions(result.subscriptions), () => undefined);
  }, []);

  const options = useMemo(() => ({ kind: filter, ...(subscriptionId ? { subscriptionId } : {}), limit: PAGE_SIZE }), [filter, subscriptionId]);

  const loadFirst = useCallback(async () => {
    const mine = ++generation.current;
    setStatus('loading');
    try {
      const page = await api.media(options);
      if (mine !== generation.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setTotal(page.counts ? (filter === 'all' ? page.counts.all : page.counts[filter]) : null);
      setError('');
      setStatus('ready');
    } catch (cause) {
      if (mine !== generation.current) return;
      setError(errorMessage(cause));
      setStatus('error');
    }
  }, [options, filter]);
  useEffect(() => { void loadFirst(); }, [loadFirst]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    try {
      const page = await api.media({ ...options, cursor: nextCursor });
      if (mine !== generation.current) return;
      setItems((current) => [...current, ...page.items.filter((item) => !current.some((known) => known.id === item.id))]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (mine === generation.current) setError(errorMessage(cause));
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, options]);

  const days = useMemo(() => groupByDay(items), [items]);
  const viewingIndex = viewing === null ? -1 : items.findIndex((asset) => asset.id === viewing);
  const empty = status === 'ready' && items.length === 0;
  const filtered = filter !== 'all' || subscriptionId !== '';

  return (
    <>
      <PageHeader title={labels.media} />
      <div className="media-toolbar">
        {subscriptions.length > 1 && (
          <label className="select-inline">
            <span className="sr-only">Abonnement</span>
            <select value={subscriptionId} onChange={(event) => setSubscriptionId(event.target.value)} aria-label="Abonnement">
              <option value="">{labels.allSubscriptions}</option>
              {subscriptions.map((subscription) => <option key={subscription.id} value={subscription.id}>{subscription.name}</option>)}
            </select>
          </label>
        )}
        <Segmented label="Medientyp" value={filter} onChange={setFilter} options={FILTERS} />
      </div>
      {status === 'error' && (
        <Banner tone="danger" action={<Button icon={ArrowsClockwise} onClick={() => void loadFirst()}>{labels.reload}</Button>}>
          <strong>Die Medien konnten nicht geladen werden.</strong> {error}
        </Banner>
      )}
      {status === 'loading' && items.length === 0 && <MediaSkeleton count={12} />}
      {empty && (filtered
        ? <EmptyState title="Dafür gibt es keine Dateien." hint="Wähle einen anderen Filter, um mehr zu sehen." />
        : <EmptyState title={labels.mediaEmpty} hint={labels.mediaEmptyHint} />)}
      {days.map((day) => (
        <section key={day.key} className="day-group" aria-label={day.label}>
          <h2 className="day-heading">
            <span>{day.label}</span>
            <span className="meta num">{day.assets.length === 1 ? '1 Datei' : `${day.assets.length} Dateien`}</span>
          </h2>
          <Gallery assets={day.assets} onOpen={(asset) => setViewing(asset.id)} />
        </section>
      ))}
      {status === 'ready' && error && items.length > 0 && <Banner tone="danger">{error}</Banner>}
      {nextCursor && (
        <div className="media-more">
          <Button onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? labels.loading : labels.loadMore}
          </Button>
          {total !== null && <span className="meta num">{`${items.length} von ${total}`}</span>}
        </div>
      )}
      {viewingIndex >= 0 && (
        <MediaViewer
          items={items}
          index={viewingIndex}
          onNavigate={(next) => setViewing(items[next]?.id ?? null)}
          onClose={() => setViewing(null)}
          hasMore={nextCursor !== null}
          loadingMore={loadingMore}
          onLoadMore={() => void loadMore()}
        />
      )}
    </>
  );
}
