import { Images } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import type { MediaAsset, RunAssets } from './api.js';
import { formatBytes, platformLabels } from './history-labels.js';
import { groupByPost, kindLabels } from './media.js';
import { MediaCell, MediaSkeleton } from './MediaGrid.js';
import { MediaViewer } from './MediaViewer.js';
import { useRunAssets } from './useRunAssets.js';
import { Banner } from './ui/Banner.js';
import { Button } from './ui/Button.js';
import { StatusChip } from './ui/StatusChip.js';

function describeCounts(counts: RunAssets['counts']): string {
  const parts = [`${counts.stored} gespeichert`];
  const loading = counts.downloading + counts.verifying;
  if (loading > 0) parts.push(`${loading} ${loading === 1 ? 'wird' : 'werden'} geladen`);
  if (counts.pending > 0) parts.push(`${counts.pending} ${counts.pending === 1 ? 'wartet' : 'warten'}`);
  if (counts.failed > 0) parts.push(`${counts.failed} fehlgeschlagen`);
  return parts.join(', ');
}

/** A file that is not stored yet: its name, kind and state, without a picture. */
function PendingTile({ asset }: { asset: MediaAsset }) {
  return (
    <div className="media-pending" title={asset.errorMessage ?? undefined}>
      <span className="media-pending-name truncate">{asset.originalName}</span>
      <span className="meta">{kindLabels[asset.mediaKind]}{asset.byteSize !== null ? `, ${formatBytes(asset.byteSize)}` : ''}</span>
      <StatusChip domain="asset" status={asset.state} suffix={asset.attempts > 1 ? ` (Versuch ${asset.attempts})` : ''} />
      {asset.errorMessage && <span className="sr-only">{asset.errorMessage}</span>}
    </div>
  );
}

/**
 * Live view of one run: the state of every file, and the stored files as pictures as soon as they are stored.
 * `runId` is the id from "Jetzt ausführen" or the id of a history run. While the run is active the section polls.
 */
export function RunLive({ runId, onShowMedia, onDismiss, onFinished }: {
  runId: string;
  /** Called when the answer says the run is over, for example to reload a list of stored files. */
  onFinished?: () => void;
  /** Offered when the run is over: opens the subscription's media section. */
  onShowMedia?: () => void;
  onDismiss?: () => void;
}) {
  const { data, error } = useRunAssets(runId);
  const [viewing, setViewing] = useState<string | null>(null);
  const finished = data !== null && !data.active;
  useEffect(() => {
    if (finished) onFinished?.();
    // onFinished is deliberately not a dependency: it must fire once per run, not once per parent render.
  }, [finished]);

  const groups = useMemo(() => groupByPost(data?.assets ?? []), [data]);
  const ordered = useMemo(() => groups.flatMap((group) => group.assets).filter((asset) => asset.state === 'stored'), [groups]);
  const viewingIndex = viewing === null ? -1 : ordered.findIndex((asset) => asset.id === viewing);

  const run = data?.run ?? null;
  const waiting = data !== null && run === null;
  const statusText = !data
    ? 'Verbindung zum Lauf wird aufgebaut …'
    : waiting
      ? 'Der Lauf ist eingereiht und wartet auf einen freien Worker.'
      : describeCounts(data.counts);

  return (
    <section className="run-live panel" aria-label="Lauf live">
      <header className="run-live-head">
        <h4>Lauf live</h4>
        {run && <StatusChip domain="download" status={run.state} />}
        {data && !data.active && <span className="meta">Beendet</span>}
        <div className="run-live-actions">
          {data && !data.active && onShowMedia && <Button icon={Images} onClick={onShowMedia}>Medien ansehen</Button>}
          {data && !data.active && onDismiss && <Button variant="ghost" onClick={onDismiss}>Ausblenden</Button>}
        </div>
      </header>
      <p className="meta" role="status" aria-live="polite">{statusText}</p>
      {run?.errorMessage && <Banner tone={run.state === 'failed' ? 'danger' : 'warn'}>{run.errorMessage}</Banner>}
      {error && <Banner tone="danger">{error}</Banner>}
      {!data && !error && <MediaSkeleton count={4} />}
      {data && data.assets.length === 0 && !waiting && <p className="meta">Bisher wurden keine Dateien gefunden.</p>}
      {groups.length > 0 && (
        <div className="media-groups">
          {groups.map((group) => (
            <section key={group.postId} className="media-group" aria-label={`Beitrag ${group.title}`}>
              <header className="media-group-head">
                <h5 className="truncate" title={group.title}>{group.title}</h5>
                <span className="meta">{platformLabels[group.platform] ?? group.platform}</span>
              </header>
              <ul className="media-grid">
                {group.assets.map((asset) => (
                  <li key={asset.id}>
                    {asset.state === 'stored'
                      ? <MediaCell asset={asset} onOpen={(opened) => setViewing(opened.id)} />
                      : <PendingTile asset={asset} />}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {data?.truncated && <p className="meta">Es werden die zuletzt bearbeiteten Dateien gezeigt; der Lauf hat mehr.</p>}
      {viewingIndex >= 0 && (
        <MediaViewer items={ordered} index={viewingIndex} onNavigate={(next) => setViewing(ordered[next]?.id ?? null)} onClose={() => setViewing(null)} />
      )}
    </section>
  );
}
