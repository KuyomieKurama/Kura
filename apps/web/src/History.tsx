import { useCallback, useEffect, useState } from 'react';
import { api, type HistoryAsset, type HistoryPost, type HistoryRun } from './api.js';
import { assetStateLabels, downloadStateLabels, formatBytes, handoverLabels, platformLabels, postStateLabels } from './history-labels.js';
import { formatInstant } from './schedule-format.js';

const REFRESH_MS = 10_000;
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Die Anfrage konnte nicht verarbeitet werden.';
}

function summarize(run: HistoryRun): string {
  const parts = [`${run.postsFound} ${run.postsFound === 1 ? 'Beitrag' : 'Beiträge'}`];
  if (run.postsSkipped > 0) parts.push(`${run.postsSkipped} bereits archiviert`);
  parts.push(`${run.assetsStored} ${run.assetsStored === 1 ? 'Datei' : 'Dateien'} gespeichert (${formatBytes(run.bytesStored)})`);
  if (run.assetsFailed > 0) parts.push(`${run.assetsFailed} fehlgeschlagen`);
  return parts.join(', ');
}

function RunsTable({ runs }: { runs: HistoryRun[] }) {
  if (runs.length === 0) return <p>Noch keine Läufe. Legen Sie ein Abonnement an und wählen Sie „Jetzt ausführen“.</p>;
  return <div className="table-wrap"><table aria-label="Läufe">
    <thead><tr><th>Beginn</th><th>Quelle</th><th>Auslöser</th><th>Status</th><th>Ergebnis</th><th>Hinweis</th></tr></thead>
    <tbody>{runs.map((run) => <tr key={run.id}>
      <td>{formatInstant(run.startedAt, zone())}</td>
      <td>{run.subscriptionName}{run.platform ? ` (${platformLabels[run.platform] ?? run.platform})` : ''}</td>
      <td>{run.triggerKind === 'manual' ? 'Manuell' : 'Zeitplan'}</td>
      <td>{downloadStateLabels[run.state] ?? run.state}</td>
      <td>{summarize(run)}</td>
      <td>{run.errorMessage ?? ''}</td>
    </tr>)}</tbody>
  </table></div>;
}

function Evidence({ asset }: { asset: HistoryAsset }) {
  const [current, setCurrent] = useState<string>('');
  const { handover } = asset;
  if (!handover.transferId) return null;

  async function refresh() {
    try {
      const result = await api.immichTransfer(handover.transferId!);
      setCurrent(`Aktueller Stand: ${handoverLabels[result.transfer.status] ?? result.transfer.status}${result.transfer.localOriginalRetained ? ' · Das lokale Original bleibt erhalten.' : ''}`);
    } catch (cause) {
      setCurrent(errorMessage(cause));
    }
  }

  return <details>
    <summary>Immich-Nachweis</summary>
    <p>Übertragung {handover.transferId}</p>
    {handover.evidence
      ? <ul>
        <li>Geprüft am {formatInstant(handover.evidence.verifiedAt, zone())}</li>
        <li>Immich-Version: {handover.evidence.serverVersion ?? 'unbekannt'}</li>
        <li>Zurückgelesene Bytes: {handover.evidence.byteLength ?? 'unbekannt'}</li>
        <li>Album: {handover.evidence.album === 'assigned' ? 'zugeordnet' : 'keine Zuordnung'}</li>
      </ul>
      : <p>Es liegt noch kein Prüfbeleg vor; das Original wurde in Immich nicht bestätigt.</p>}
    <p>Das lokale Original bleibt in Kura erhalten.</p>
    <button type="button" className="secondary" onClick={() => void refresh()}>Aktuellen Stand abrufen</button>
    {current && <p>{current}</p>}
  </details>;
}

function AssetsTable({ post }: { post: HistoryPost }) {
  return <div className="table-wrap"><table aria-label={`Dateien von ${post.title ?? post.platformPostId}`}>
    <thead><tr><th>Nr.</th><th>Datei</th><th>Größe</th><th>Status</th><th>Prüfsumme (SHA-256)</th><th>Immich</th></tr></thead>
    <tbody>{post.assets.map((asset) => <tr key={asset.id}>
      <td>{asset.index + 1}</td>
      <td>{asset.originalName}<br />{asset.mediaType}</td>
      <td>{formatBytes(asset.byteSize)}</td>
      <td>
        {assetStateLabels[asset.state] ?? asset.state}
        {asset.attempts > 1 ? ` (Versuch ${asset.attempts})` : ''}
        {asset.errorMessage && <><br /><span className="error">{asset.errorMessage}</span></>}
      </td>
      <td>{asset.sha256 ? <code title={asset.sha256}>{asset.sha256.slice(0, 16)}…</code> : '–'}</td>
      <td>
        {asset.state === 'stored' ? (handoverLabels[asset.handover.state] ?? asset.handover.state) : '–'}
        <Evidence asset={asset} />
      </td>
    </tr>)}</tbody>
  </table></div>;
}

function PostCard({ post }: { post: HistoryPost }) {
  const label = post.title ?? post.platformPostId;
  return <article aria-label={`Beitrag ${label}`}>
    <h3>{label}</h3>
    <p>
      {platformLabels[post.platform] ?? post.platform} · {post.creatorName ?? post.creatorId} · aus „{post.subscriptionName}“ · gefunden {formatInstant(post.discoveredAt, zone())}
    </p>
    <p>Status: {postStateLabels[post.state] ?? post.state}{!post.discoveryComplete && post.state !== 'discovered' ? ' (Dateiliste nicht als vollständig gemeldet)' : ''}</p>
    {post.assets.length === 0 ? <p>Noch keine Dateien erfasst.</p> : <AssetsTable post={post} />}
  </article>;
}

/** The download history of the signed-in user: runs with their state, and posts with the state of every file. */
export function HistoryPage() {
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

  return <section>
    <div className="section-header">
      <h2>Verlauf</h2>
      <button type="button" className="secondary" onClick={() => void load()}>Aktualisieren</button>
    </div>
    <p>Hier steht, was Kura wann von welcher Quelle geholt hat, mit dem Zustand jeder einzelnen Datei. Der Verlauf bleibt erhalten, auch wenn ein Abonnement gelöscht wird. Lokale Originale werden von Kura nicht entfernt.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {data === null ? <p>Wird abgerufen …</p> : <>
      <h3>Läufe</h3>
      <RunsTable runs={data.runs} />
      <h3>Beiträge und Dateien</h3>
      {data.posts.length === 0 ? <p>Noch nichts heruntergeladen.</p> : data.posts.map((post) => <PostCard key={post.id} post={post} />)}
    </>}
  </section>;
}
