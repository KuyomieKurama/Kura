import { ArrowsClockwise, ListChecks } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { api, type HistoryPost, type HistoryRun } from './api.js';
import { errorMessage } from './error-message.js';
import { formatBytes } from './history-labels.js';
import { dayLabel } from './time-format.js';
import { LedgerEntry } from './Ledger.js';
import { RunLive } from './RunLive.js';
import { labels } from './labels.js';
import { formatInstant } from './schedule-format.js';
import { Banner } from './ui/Banner.js';
import { Button } from './ui/Button.js';
import { EmptyState } from './ui/EmptyState.js';
import { PageHeader } from './ui/PageHeader.js';
import { platformName, PlatformSeal } from './ui/PlatformSeal.js';
import { RelativeTime } from './ui/RelativeTime.js';
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

/** Only a run that did not end as planned gets a chip; a finished run says nothing but its result. */
const NORMAL_RUN_STATES = new Set(['stored', 'succeeded']);

/**
 * One run: when (relative, the full time as title), the source with its seal, what started it, the result in one
 * sentence, a chip only for a deviation and the note under the result in the same cell. Narrow: two lines.
 */
function RunRow({ run }: { run: HistoryRun }) {
  const platform = platformName(run.platform);
  return (
    <li className="run-row">
      <span className="run-time"><RelativeTime value={run.startedAt} capitalize timeZone={zone()} /></span>
      <span className="run-source">
        <PlatformSeal platform={run.platform} />
        <span className="run-source-text">
          <span className="row-name" title={run.subscriptionName}>{run.subscriptionName}</span>
          <span className="meta">{platform}</span>
        </span>
      </span>
      <span className="run-trigger meta">{run.triggerKind === 'manual' ? 'Manuell' : 'Zeitplan'}</span>
      <span className="run-result">
        <span className="run-result-line">
          <span>{summarize(run)}</span>
          {!NORMAL_RUN_STATES.has(run.state) && <StatusChip domain="download" status={run.state} />}
        </span>
        {run.errorMessage && <span className="meta run-note">{run.errorMessage}</span>}
      </span>
    </li>
  );
}

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
        lead="Was Kura wann von welcher Quelle geholt hat, Datei für Datei."
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
                    <div className="ledger">{group.posts.map((post) => <LedgerEntry key={post.id} post={post} />)}</div>
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
                : <ul className="run-list" aria-label="Läufe">{data.runs.map((run) => <RunRow key={run.id} run={run} />)}</ul>}
            </section>
          </>
        )}
    </>
  );
}
