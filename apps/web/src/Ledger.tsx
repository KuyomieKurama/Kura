import { CaretDown, CaretUp, CheckCircle, Hourglass, LockKey, SealCheck } from '@phosphor-icons/react';
import { useId, useState } from 'react';
import { api, type HistoryAsset, type HistoryPost } from './api.js';
import { errorMessage } from './error-message.js';
import {
  assetStateLabels, formatBytes, handoverLabels, isLocked, isNotYetAvailable, isWaitingOrLocked, platformLabels, postStateLabels
} from './history-labels.js';
import { formatInstant } from './schedule-format.js';
import { assetSegmentTone } from './status.js';
import { Button } from './ui/Button.js';
import { Chip } from './ui/Chip.js';
import { Collapse } from './ui/Collapse.js';
import { DataTable, type Column } from './ui/DataTable.js';
import { DisclosureSummary } from './ui/DisclosureSummary.js';
import { Glyph } from './ui/Glyph.js';
import { StatusChip } from './ui/StatusChip.js';

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

type Verification = { kind: 'verified' | 'partial' | 'none'; verified: number; stored: number };

/** A file counts as verified only with Immich evidence for exactly this original. An HTTP status is never enough. */
function verificationOf(post: HistoryPost): Verification {
  const stored = post.assets.filter((asset) => asset.state === 'stored');
  const verified = stored.filter((asset) => asset.handover.state === 'verified' && asset.handover.evidence !== null);
  const kind = stored.length > 0 && verified.length === stored.length ? 'verified' : verified.length > 0 ? 'partial' : 'none';
  return { kind, verified: verified.length, stored: stored.length };
}

/** The verification marker of a ledger entry: outlined like a stamp, check icon only when evidence exists. */
function VerificationStamp({ verification }: { verification: Verification }) {
  if (verification.kind === 'verified') {
    return (
      <span className="stamp stamp-verified" title="Für alle gespeicherten Dateien liegt ein Prüfbeleg von Immich vor.">
        <Glyph icon={SealCheck} size={14} />
        Original verifiziert
      </span>
    );
  }
  if (verification.kind === 'partial') {
    return (
      <span className="stamp stamp-partial" title={`Für ${verification.verified} von ${verification.stored} gespeicherten Dateien liegt ein Prüfbeleg von Immich vor.`}>
        <Glyph icon={CheckCircle} size={14} />
        Teilweise verifiziert
      </span>
    );
  }
  return <span className="stamp stamp-none" title="Es liegt kein Prüfbeleg von Immich vor.">Nicht verifiziert</span>;
}

/** One segment per file, coloured by state. The bar is decoration, the text next to it is the summary. */
function Segments({ assets }: { assets: HistoryAsset[] }) {
  const stored = assets.filter((asset) => asset.state === 'stored').length;
  const waiting = assets.filter(isNotYetAvailable).length;
  const locked = assets.filter(isLocked).length;
  const failed = assets.filter((asset) => asset.state === 'failed').length - waiting - locked;
  const summary = `${stored} von ${assets.length} gespeichert${failed > 0 ? `, ${failed} fehlgeschlagen` : ''}${waiting > 0 ? `, ${waiting} noch nicht verfügbar` : ''}${locked > 0 ? `, ${locked} nicht zugänglich` : ''}`;
  return (
    <div className="ledger-segments">
      <div className="segments" aria-hidden="true">
        {assets.map((asset) => (
          <span
            key={asset.id}
            className={`segment segment-${isLocked(asset) ? 'neutral' : isNotYetAvailable(asset) ? 'warn' : assetSegmentTone(asset.state)}`}
            title={`${asset.originalName}: ${isLocked(asset) ? 'Nicht zugänglich' : isNotYetAvailable(asset) ? 'Noch nicht verfügbar' : assetStateLabels[asset.state] ?? asset.state}`}
          />
        ))}
      </div>
      <p className="meta num">{summary}</p>
    </div>
  );
}

function Evidence({ asset }: { asset: HistoryAsset }) {
  const [current, setCurrent] = useState<string>('');
  const { handover } = asset;
  if (!handover.transferId) return null;

  async function refresh() {
    try {
      const result = await api.immichTransfer(handover.transferId!);
      const state = handoverLabels[result.transfer.status] ?? result.transfer.status;
      setCurrent(`Aktueller Stand: ${state}${result.transfer.localOriginalRetained ? '. Das lokale Original bleibt erhalten.' : ''}`);
    } catch (cause) {
      setCurrent(errorMessage(cause));
    }
  }

  return (
    <details className="evidence">
      <DisclosureSummary>Immich-Nachweis</DisclosureSummary>
      <div className="evidence-body">
        <p>Übertragung <code>{handover.transferId}</code></p>
        {handover.evidence
          ? (
            <ul>
              <li>Geprüft am {formatInstant(handover.evidence.verifiedAt, zone())}</li>
              <li>Immich-Version: {handover.evidence.serverVersion ?? 'unbekannt'}</li>
              <li>Zurückgelesene Bytes: {handover.evidence.byteLength ?? 'unbekannt'}</li>
              <li>Album: {handover.evidence.album === 'assigned' ? 'zugeordnet' : 'keine Zuordnung'}</li>
            </ul>
          )
          : <p>Es liegt noch kein Prüfbeleg vor; das Original wurde in Immich nicht bestätigt.</p>}
        <p>Das lokale Original bleibt in Kura erhalten.</p>
        <Button onClick={() => void refresh()}>Aktuellen Stand abrufen</Button>
        {current && <p role="status">{current}</p>}
      </div>
    </details>
  );
}

function AssetsTable({ post }: { post: HistoryPost }) {
  const columns: Column<HistoryAsset>[] = [
    { key: 'index', header: 'Nr.', render: (asset) => asset.index + 1, numeric: true },
    {
      key: 'file',
      header: 'Datei',
      render: (asset) => (
        <>
          <span className="cell-title">{asset.originalName}</span>
          <span className="cell-note">{asset.mediaType}</span>
        </>
      )
    },
    { key: 'size', header: 'Größe', render: (asset) => formatBytes(asset.byteSize), numeric: true },
    {
      key: 'state',
      header: 'Status',
      render: (asset) => (
        <>
          {isLocked(asset)
            ? <Chip tone="neutral" icon={LockKey}>Nicht zugänglich</Chip>
            : isNotYetAvailable(asset)
              ? <Chip tone="warn" icon={Hourglass}>Noch nicht verfügbar</Chip>
              : <StatusChip domain="asset" status={asset.state} suffix={asset.attempts > 1 ? ` (Versuch ${asset.attempts})` : ''} />}
          {asset.errorMessage && <span className={isWaitingOrLocked(asset) ? 'cell-note' : 'cell-note cell-note-danger'}>{asset.errorMessage}</span>}
        </>
      )
    },
    {
      key: 'sha',
      header: 'Prüfsumme (SHA-256)',
      render: (asset) => asset.sha256 ? <code className="hash" title={asset.sha256}>{asset.sha256.slice(0, 16)}…</code> : 'noch keine'
    },
    {
      key: 'immich',
      header: 'Immich',
      render: (asset) => (
        <>
          {handoverLabels[asset.state === 'stored' ? asset.handover.state : 'not_attempted'] ?? asset.handover.state}
          <Evidence asset={asset} />
        </>
      )
    }
  ];
  return <DataTable label={`Dateien von ${post.title ?? post.platformPostId}`} columns={columns} rows={post.assets} rowKey={(asset) => asset.id} />;
}


/** One history entry as a ledger row: source and time left, the files as a segmented bar, the verification stamp right. */
export function LedgerEntry({ post }: { post: HistoryPost }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const label = post.title ?? post.platformPostId;
  const hasAssets = post.assets.length > 0;
  // A post whose only files are expected to appear later (a running livestream) is waiting, it has not failed.
  const waitingOnly = hasAssets && post.state === 'failed' && post.assets.every(isNotYetAvailable);
  // A post that the account may not view has not failed either.
  const lockedOnly = hasAssets && post.state === 'failed' && post.assets.every(isLocked);
  const statusLine = `Status: ${lockedOnly ? 'Nicht zugänglich' : waitingOnly ? 'Noch nicht verfügbar' : postStateLabels[post.state] ?? post.state}${!post.discoveryComplete && post.state !== 'discovered' ? ' (Dateiliste nicht als vollständig gemeldet)' : ''}`;

  return (
    <article className="ledger-entry" aria-label={`Beitrag ${label}`}>
      <div className="ledger-head">
        <div className="ledger-source">
          <h3 className="truncate" title={label}>{label}</h3>
          <p className="meta truncate">{`${platformLabels[post.platform] ?? post.platform}, ${post.creatorName ?? post.creatorId}, aus „${post.subscriptionName}“`}</p>
          <p className="meta">
            <time dateTime={post.discoveredAt}>{`Gefunden ${formatInstant(post.discoveredAt, zone())}`}</time>
          </p>
        </div>
        <div className="ledger-state">
          {hasAssets ? <Segments assets={post.assets} /> : <p className="meta">Noch keine Dateien erfasst.</p>}
        </div>
        <div className="ledger-mark">
          {lockedOnly
            ? <Chip tone="neutral" icon={LockKey}>Nicht zugänglich</Chip>
            : waitingOnly
              ? <Chip tone="warn" icon={Hourglass}>Noch nicht verfügbar</Chip>
              : <StatusChip domain="post" status={post.state} />}
          {hasAssets && <VerificationStamp verification={verificationOf(post)} />}
        </div>
        {hasAssets && (
          <Button variant="ghost" icon={open ? CaretUp : CaretDown} onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={bodyId}>
            {open ? 'Dateien ausblenden' : 'Dateien anzeigen'}
          </Button>
        )}
      </div>
      {hasAssets
        ? (
          <Collapse open={open} id={bodyId}>
            <p className="meta ledger-status">{statusLine}</p>
            <AssetsTable post={post} />
          </Collapse>
        )
        : <p className="meta ledger-status">{statusLine}</p>}
    </article>
  );
}
