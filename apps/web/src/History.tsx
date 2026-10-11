import { ArrowsClockwise, ListChecks } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { api, type HistoryPost, type HistoryRun } from './api.js';
import { errorMessage } from './error-message.js';
import { formatBytes, platformLabels } from './history-labels.js';
import { dayLabel } from './time-format.js';
import { LedgerEntry } from './Ledger.js';
import { RunLive } from './RunLive.js';
import { labels } from './labels.js';
import { formatInstant } from './schedule-format.js';
import { Banner } from './ui/Banner.js';
import { Button } from './ui/Button.js';
import { DataTable, type Column } from './ui/DataTable.js';
import { EmptyState } from './ui/EmptyState.js';
import { PageHeader } from './ui/PageHeader.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { StatusChip } from './ui/StatusChip.js';

const REFRESH_MS = 10_000;
const MAX_LIVE_RUNS = 3;
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function summarize(run: HistoryRun): string {
  const parts = [`${run.postsFound} ${run.postsFound === 1 ? 'Beitrag' : 'Beiträge'}`];
  if (run.postsSkipped > 0) parts.push(`${run.postsSkipped} bereits archiviert`);
  parts.push(`${run.assetsStored} ${run.assetsStored === 1 ? 'Datei' : 'Dateien'} gespeichert (${formatBytes(run.bytesStored)})`);
  if (run.assetsFailed > 0) parts.push(`${run.assetsFailed} fehlgeschlagen`);
  return parts.join(', ');
}

/** Posts grouped by the day they were found (local time), newest day first; the order inside a day is the server's. */
function groupByDay(posts: HistoryPost[]): { key: string; label: string; posts: HistoryPost[] }[] {
  const groups = new Map<string, { key: string; label: string; posts: HistoryPost[] }>();
  for (const post of posts) {
    const date = new Date(post.discoveredAt);
    const key = date.toLocaleDateString('sv-SE', { timeZone: zone() });
    const group = groups.get(key) ?? { key, label: dayLabel(date), posts: [] };
    group.posts.push(post);
    groups.set(key, group);
  }
  return [...groups.values()];
}

const runColumns: Column<HistoryRun>[] = [
  { key: 'start', header: 'Beginn', render: (run) => formatInstant(run.startedAt, zone()), date: true },
  {
    key: 'source',
    header: 'Quelle',
    render: (run) => `${run.subscriptionName}${run.platform ? ` (${platformLabels[run.platform] ?? run.platform})` : ''}`
  },
  { key: 'trigger', header: 'Auslöser', render: (run) => (run.triggerKind === 'manual' ? 'Manuell' : 'Zeitplan') },
  { key: 'state', header: 'Status', render: (run) => <StatusChip domain="download" status={run.state} /> },
  { key: 'result', header: 'Ergebnis', render: summarize },
  { key: 'note', header: 'Hinweis', render: (run) => run.errorMessage ?? '' }
];

/**
 * The download history of the signed-in user, as a ledger: every post is a row group with the state of its files
 * and the Immich verification marker, followed by the runs.
 */
export function HistoryPage({ onOpenSubscriptions }: { onOpenSubscriptions?: () => void }) {
  const [data, setData] = useState<{ runs: HistoryRun[]; posts: HistoryPost[] } | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api.history());
      setError('');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <>
      <PageHeader
        title={labels.history}
        lead="Hier steht, was Kura wann von welcher Quelle geholt hat, mit dem Zustand jeder einzelnen Datei. Der Verlauf bleibt erhalten, auch wenn ein Abonnement gelöscht wird. Lokale Originale werden von Kura nicht entfernt."
        actions={<Button icon={ArrowsClockwise} onClick={() => void load()}>Aktualisieren</Button>}
      />
      {error && <Banner tone="danger">{error} Prüfe die Verbindung und wähle „Aktualisieren“.</Banner>}
      {data === null
        ? (!error && <SkeletonRows count={4} tall />)
        : (
          <>
            {data.runs.some((run) => run.finishedAt === null) && (
              <section className="section" aria-labelledby="live-heading">
                <h2 id="live-heading">Läuft gerade</h2>
                {data.runs.filter((run) => run.finishedAt === null).slice(0, MAX_LIVE_RUNS).map((run) => (
                  <div key={run.id} className="live-run">
                    <p className="meta">{`${run.subscriptionName}, gestartet ${formatInstant(run.startedAt, zone())}`}</p>
                    <RunLive runId={run.id} />
                  </div>
                ))}
              </section>
            )}
            <section className="section" aria-labelledby="posts-heading">
              <h2 id="posts-heading">Beiträge und Dateien</h2>
              {data.posts.length === 0
                ? <EmptyState title="Noch nichts heruntergeladen." hint="Sobald ein Lauf Dateien speichert, erscheinen sie hier." />
                : groupByDay(data.posts).map((group) => (
                  <section key={group.key} className="ledger-day" aria-labelledby={`day-${group.key}`}>
                    <h3 id={`day-${group.key}`} className="ledger-day-heading">{group.label}</h3>
                    <div className="panel ledger">{group.posts.map((post) => <LedgerEntry key={post.id} post={post} />)}</div>
                  </section>
                ))}
            </section>
            <section className="section" aria-labelledby="runs-heading">
              <h2 id="runs-heading">Läufe</h2>
              {data.runs.length === 0
                ? (
                  <EmptyState
                    title="Noch keine Läufe."
                    hint="Lege ein Abonnement an und wähle „Jetzt ausführen“."
                    action={onOpenSubscriptions && <Button variant="primary" icon={ListChecks} onClick={onOpenSubscriptions}>Zu den Abonnements</Button>}
                  />
                )
                : <DataTable label="Läufe" columns={runColumns} rows={data.runs} rowKey={(run) => run.id} />}
            </section>
          </>
        )}
    </>
  );
}
