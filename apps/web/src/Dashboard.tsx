import { Warning } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type HistoryRun, type MediaAsset, type Overview } from './api.js';
import { formatBytes } from './history-labels.js';
import { labels } from './labels.js';
import { errorMessage } from './error-message.js';
import { MediaTile } from './MediaTile.js';
import { MediaViewer } from './MediaViewer.js';
import { absoluteShort, upperFirst } from './time-format.js';
import { Banner } from './ui/Banner.js';
import { Button } from './ui/Button.js';
import { PageHeader } from './ui/PageHeader.js';
import { PlatformSeal, platformName } from './ui/PlatformSeal.js';
import { ProgressBar } from './ui/ProgressBar.js';
import { RelativeTime } from './ui/RelativeTime.js';
import { StatusChip } from './ui/StatusChip.js';

export type ServiceStatus = { version: string; migrations: { appliedCount: number; latestVersion: string | null } };
export type HealthState = 'loading' | 'ok' | 'error';

const REFRESH_MS = 10_000;
const MOSAIC_TILES = 9;

/** The result of a finished run in one short sentence. Only a deviation carries a tone. */
export function runResult(run: Pick<HistoryRun, 'state' | 'assetsStored' | 'assetsFailed'>): { text: string; tone: 'plain' | 'warn' | 'danger' } {
  const files = (count: number) => `${count} ${count === 1 ? 'Datei' : 'Dateien'}`;
  if (run.state === 'failed') return { text: 'Fehlgeschlagen', tone: 'danger' };
  if (run.state === 'waiting_auth') return { text: 'Anmeldung abgelaufen', tone: 'warn' };
  if (run.state === 'partially_completed') return { text: `Teilweise: ${files(run.assetsFailed)} fehlgeschlagen`, tone: 'warn' };
  if (run.assetsStored > 0) return { text: `${files(run.assetsStored)} gespeichert`, tone: 'plain' };
  return { text: 'Nichts Neues', tone: 'plain' };
}

function attentionText(kind: Overview['attention'][number]['kind']): string {
  if (kind === 'auth_required') return 'Anmeldung abgelaufen';
  if (kind === 'failed') return 'Letzter Lauf fehlgeschlagen';
  return 'Letzter Lauf nur teilweise gespeichert';
}

/** One sentence: what Kura did last, and when the next run is. */
function Lede({ overview }: { overview: Overview }) {
  const next = overview.upcoming[0];
  const last = overview.lastRuns.find((run) => run.finishedAt && run.assetsStored > 0);
  const nextPart = next ? <> Nächster Lauf <RelativeTime value={next.dueAt} detail endSentence /></> : null;
  if (overview.recentAssets.length === 0 && !last) return <p className="page-lead">{labels.emptyArchive}</p>;
  if (!last || !last.finishedAt) {
    return <p className="page-lead">Heute war noch kein Lauf.{nextPart}</p>;
  }
  const finished = new Date(last.finishedAt);
  const today = new Date();
  const sameDay = finished.toDateString() === today.toDateString();
  const files = last.assetsStored === 1 ? '1 neue Datei' : `${last.assetsStored} neue Dateien`;
  return (
    <p className="page-lead">
      {sameDay || today.getTime() - finished.getTime() < 24 * 3600 * 1000
        ? <><RelativeTime value={finished} capitalize /> hat Kura {files} von {last.subscriptionName} gespeichert.</>
        : <>Zuletzt hat Kura am {absoluteShort(finished)} {files} von {last.subscriptionName} gespeichert.</>}
      {nextPart}
    </p>
  );
}

function Mosaic({ assets, onOpen }: { assets: MediaAsset[]; onOpen: (asset: MediaAsset, opener: HTMLElement) => void }) {
  return (
    <ul className="mosaic">
      {assets.slice(0, MOSAIC_TILES).map((asset, index) => (
        <li key={asset.id} className={index === 0 ? 'mosaic-item mosaic-lead' : 'mosaic-item'}>
          <MediaTile asset={asset} onOpen={onOpen} width={index === 0 ? 960 : 480} eager={index < 3} />
        </li>
      ))}
    </ul>
  );
}

function GhostMosaic() {
  return (
    <div className="mosaic mosaic-ghost" aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map((index) => <span key={index} className={index === 0 ? 'mosaic-item mosaic-lead ghost-frame' : 'mosaic-item ghost-frame'} />)}
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div role="status" aria-busy="true" className="overview-skeleton">
      <span className="sr-only">{labels.loading}</span>
      <div className="skeleton-lines" aria-hidden="true">
        <span className="skeleton-block skeleton-bar" />
        <span className="skeleton-block skeleton-bar skeleton-bar-short" />
      </div>
      <ul className="mosaic" aria-hidden="true">
        {Array.from({ length: MOSAIC_TILES }, (_, index) => (
          <li key={index} className={index === 0 ? 'mosaic-item mosaic-lead' : 'mosaic-item'}><span className="skeleton-block skeleton-fill" /></li>
        ))}
      </ul>
      <div className="skeleton-list" aria-hidden="true">
        {[0, 1, 2].map((index) => <div key={index} className="skeleton-row" />)}
      </div>
    </div>
  );
}

/**
 * The start page: what Kura did, whether something needs the user, the newest files, what runs now, what runs next.
 * The technical state of the service is folded away at the bottom.
 */
export function Dashboard({ health, status, checkedAt, onNavigate, onOpenSubscription }: {
  health: HealthState;
  status: ServiceStatus | null;
  checkedAt: Date | null;
  onNavigate: (view: string) => void;
  onOpenSubscription?: (subscriptionId: string) => void;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [viewing, setViewing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOverview(await api.overview());
      setError('');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const assets = overview?.recentAssets ?? [];
  const viewingIndex = viewing === null ? -1 : assets.findIndex((asset) => asset.id === viewing);
  const empty = overview !== null && assets.length === 0 && overview.lastRuns.length === 0 && overview.activeRuns.length === 0;
  const unknown = health === 'loading';
  const nextRun = useMemo(() => overview?.upcoming[0], [overview]);

  return (
    <>
      <PageHeader title={labels.overview} lead={overview && !empty ? <Lede overview={overview} /> : undefined} />
      {health === 'error' && (
        <Banner tone="danger">
          <strong>{labels.statusError}</strong> {labels.statusErrorAction}
        </Banner>
      )}
      {error && !overview && (
        <Banner tone="danger" action={<Button onClick={() => void load()}>{labels.reload}</Button>}>
          <strong>{labels.overviewLoadFailed}</strong> {labels.overviewLoadFailedAction}
        </Banner>
      )}
      {!overview && !error && <OverviewSkeleton />}
      {empty && (
        <section className="section" aria-label={labels.emptyArchive}>
          <GhostMosaic />
          <div className="empty-state">
            <p className="empty-title">{labels.emptyArchive}</p>
            <p className="empty-hint">{labels.emptyArchiveHint}</p>
            <div><Button variant="primary" onClick={() => onNavigate('subscriptions')}>{labels.createSubscription}</Button></div>
          </div>
        </section>
      )}
      {overview && overview.attention.length > 0 && (
        <section className="section" aria-labelledby="attention-heading">
          <h2 id="attention-heading" className="sr-only">{labels.needsYou}</h2>
          {overview.attention.map((item) => (
            <Banner
              key={`${item.subscriptionId}-${item.runId}`}
              tone={item.kind === 'failed' ? 'danger' : 'warn'}
              action={item.kind === 'auth_required'
                ? <Button onClick={() => onNavigate('account')}>{labels.renewAccess}</Button>
                : <Button onClick={() => onOpenSubscription?.(item.subscriptionId) ?? onNavigate('subscriptions')}>Ansehen</Button>}
            >
              <strong>{labels.needsYou}:</strong> {item.subscriptionName}: {attentionText(item.kind)}.
              {item.errorMessage && item.kind !== 'auth_required' ? ` ${item.errorMessage}` : ''}
            </Banner>
          ))}
        </section>
      )}
      {assets.length > 0 && (
        <section className="section" aria-labelledby="recent-heading">
          <div className="section-head">
            <h2 id="recent-heading">{labels.recentlyLoaded}</h2>
            <button type="button" className="text-link" onClick={() => onNavigate('media')}>{labels.allMedia}</button>
          </div>
          <Mosaic assets={assets} onOpen={(asset) => setViewing(asset.id)} />
        </section>
      )}
      {overview && !empty && (
        <div className="overview-columns">
          <section className="section" aria-labelledby="running-heading">
            <h2 id="running-heading">{labels.runningNow}</h2>
            {overview.activeRuns.length === 0
              ? (
                <p className="muted">
                  {labels.nothingRunning}{nextRun && <> Der nächste Lauf startet <RelativeTime value={nextRun.dueAt} detail endSentence /></>}
                </p>
              )
              : (
                <ul className="plain-list">
                  {overview.activeRuns.map((run) => {
                    const total = run.counts.stored + run.counts.failed + run.counts.pending + run.counts.downloading + run.counts.verifying;
                    const done = run.counts.stored + run.counts.failed;
                    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
                    return (
                      <li key={run.runId} className="running-row">
                        <div className="row-line">
                          <PlatformSeal platform={run.platform} />
                          <span className="row-name">{run.subscriptionName}</span>
                        </div>
                        <div className="row-line row-between">
                          <span className="accent-text">{total > 0 ? `Lädt Datei ${Math.min(done + 1, total)} von ${total}` : 'Wird vorbereitet'}</span>
                          {total > 0 && <span className="num">{percent} %</span>}
                        </div>
                        {total > 0 && <ProgressBar value={done} max={total} label={`Fortschritt ${run.subscriptionName}`} />}
                        {run.bytesStored > 0 && <span className="meta">{`${formatBytes(run.bytesStored)} gespeichert`}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
          </section>
          <section className="section" aria-labelledby="next-heading">
            <h2 id="next-heading">{labels.nextUp}</h2>
            {overview.upcoming.length === 0
              ? <p className="muted">Kein Lauf geplant. Lege bei einem Abonnement einen Zeitplan an.</p>
              : (
                <ul className="plain-list">
                  {overview.upcoming.map((entry) => (
                    <li key={`${entry.subscriptionId}-${entry.dueAt}`} className="list-row">
                      <span className="row-name">{entry.subscriptionName}</span>
                      <span className="muted"><RelativeTime value={entry.dueAt} capitalize /></span>
                    </li>
                  ))}
                </ul>
              )}
          </section>
        </div>
      )}
      {overview && overview.lastRuns.length > 0 && (
        <section className="section" aria-labelledby="last-heading">
          <div className="section-head">
            <h2 id="last-heading">{labels.lastRan}</h2>
            <button type="button" className="text-link" onClick={() => onNavigate('history')}>{labels.openHistory}</button>
          </div>
          <ul className="plain-list">
            {overview.lastRuns.map((run) => {
              const result = runResult(run);
              return (
                <li key={run.id} className="list-row last-run">
                  <span className="muted last-run-time">{run.finishedAt ? <RelativeTime value={run.finishedAt} capitalize /> : <StatusChip domain="run" status={run.state} />}</span>
                  <span className="row-name">{run.subscriptionName}</span>
                  <span className={result.tone === 'plain' ? 'muted' : `tone-${result.tone}`}>
                    {result.tone !== 'plain' && <Warning size={14} aria-hidden="true" className="inline-glyph" />}
                    {result.text}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <details className="technik">
        <summary>{labels.technical}</summary>
        <dl className="status-list">
          <div className="status-item">
            <dt>{labels.service}</dt>
            <dd>{unknown ? labels.unknown : health === 'ok' ? labels.available : <StatusChip domain="availability" status="unavailable" />}</dd>
          </div>
          <div className="status-item">
            <dt>Datenbank</dt>
            <dd>{unknown ? labels.unknown : health === 'ok' ? 'Verbunden' : labels.no}</dd>
          </div>
          <div className="status-item">
            <dt>{labels.version}</dt>
            <dd className="mono" title={status?.version}>{status?.version ?? labels.unknown}</dd>
          </div>
          <div className="status-item">
            <dt>{labels.migrations}</dt>
            <dd>{status ? status.migrations.appliedCount : labels.unknown}</dd>
          </div>
          <div className="status-item">
            <dt>Letzter Abruf</dt>
            <dd>{checkedAt ? <RelativeTime value={checkedAt} /> : labels.unknown}</dd>
          </div>
        </dl>
      </details>
      {viewingIndex >= 0 && (
        <MediaViewer items={assets} index={viewingIndex} onNavigate={(next) => setViewing(assets[next]?.id ?? null)} onClose={() => setViewing(null)} />
      )}
    </>
  );
}
