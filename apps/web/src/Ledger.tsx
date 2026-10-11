import { CaretDown, CaretUp, CheckCircle, FileImage, FilmStrip, Hourglass, LockKey, MusicNotes, File as FileGlyph } from '@phosphor-icons/react';
import { useId, useState } from 'react';
import { api, contentUrl, thumbnailUrl, type HistoryAsset, type HistoryPost } from './api.js';
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

/**
 * Verification is the normal case and says nothing in the row: only a deviation (some files without Immich evidence) is
 * a chip. The full statement stands in the technical details.
 */
function verificationText(verification: Verification): string {
  if (verification.kind === 'verified') return 'Für alle gespeicherten Dateien liegt ein Prüfbeleg von Immich vor.';
  if (verification.kind === 'partial') return `Für ${verification.verified} von ${verification.stored} gespeicherten Dateien liegt ein Prüfbeleg von Immich vor.`;
  return 'Es liegt kein Prüfbeleg von Immich vor.';
}

type PreviewKind = 'image' | 'video' | 'audio' | 'other';
const previewKind = (asset: HistoryAsset): PreviewKind => asset.mediaType.startsWith('image/') ? 'image' : asset.mediaType.startsWith('video/') ? 'video' : asset.mediaType.startsWith('audio/') ? 'audio' : 'other';
const previewIcons = { image: FileImage, video: FilmStrip, audio: MusicNotes, other: FileGlyph } as const;

/**
 * The 56px picture of a post row: the preview of its first stored file. If there is none (yet, or at all) the square
 * shows the glyph of the file kind, never an empty box.
 */
function PostThumb({ post }: { post: HistoryPost }) {
  const first = post.assets.find((asset) => asset.state === 'stored' && previewKind(asset) !== 'audio' && previewKind(asset) !== 'other')
    ?? post.assets.find((asset) => asset.state === 'stored');
  const [stage, setStage] = useState<'preview' | 'original' | 'broken'>('preview');
  const [loaded, setLoaded] = useState(false);
  const kind = first ? previewKind(first) : 'other';
  const src = !first || kind === 'audio' || kind === 'other' || stage === 'broken' ? null : stage === 'preview' ? thumbnailUrl(first.id, 480) : kind === 'image' ? contentUrl(first.id) : null;
  // The glyph is always underneath; the picture covers it as soon as it has loaded. So there is no moment with an empty box.
  return (
    <div className="ledger-thumb" aria-hidden="true">
      <Glyph icon={previewIcons[kind]} size={24} />
      {src && (
        <img
          key={src}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          data-loaded={loaded}
          onLoad={() => setLoaded(true)}
          onError={() => setStage(stage === 'preview' && kind === 'image' ? 'original' : 'broken')}
        />
      )}
    </div>
  );
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

/** The part for people who check: checksum per file and the verification statement. Closed by default. */
function TechnicalDetails({ post, verification }: { post: HistoryPost; verification: Verification }) {
  return (
    <details className="technical">
      <DisclosureSummary>Technische Details</DisclosureSummary>
      <div className="technical-body">
        <p className="meta">{verificationText(verification)}</p>
        <dl className="technical-list">
          {post.assets.map((asset) => (
            <div key={asset.id}>
              <dt className="truncate" title={asset.originalName}>{asset.originalName}</dt>
              <dd>{asset.sha256 ? <><span className="meta">Prüfsumme (SHA-256)</span> <code className="hash" title={asset.sha256}>{asset.sha256}</code></> : <span className="meta">Prüfsumme (SHA-256): noch keine</span>}</dd>
            </div>
          ))}
        </dl>
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
              : asset.state === 'stored' && asset.attempts <= 1
                // The normal case is plain text; only a deviation is a chip.
                ? <span>{assetStateLabels.stored ?? 'Gespeichert'}</span>
                : <StatusChip domain="asset" status={asset.state} suffix={asset.attempts > 1 ? ` (Versuch ${asset.attempts})` : ''} />}
          {asset.errorMessage && <span className={isWaitingOrLocked(asset) ? 'cell-note' : 'cell-note cell-note-danger'}>{asset.errorMessage}</span>}
        </>
      )
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


/** One history entry as a ledger row: source and time left, the files as a segmented bar, only deviations as chips. */
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

  const verification = verificationOf(post);
  const sourceLine = `${platformLabels[post.platform] ?? post.platform}, ${post.creatorName ?? post.creatorId}, aus „${post.subscriptionName}“`;
  const timeOfDay = new Date(post.discoveredAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: zone() });
  // Only a deviation is a chip: a fully stored post says nothing, the bar and the sentence under the title are enough.
  const deviation = lockedOnly
    ? <Chip tone="neutral" icon={LockKey}>Nicht zugänglich</Chip>
    : waitingOnly
      ? <Chip tone="warn" icon={Hourglass}>Noch nicht verfügbar</Chip>
      : post.state === 'stored' ? null : <StatusChip domain="post" status={post.state} />;

  return (
    <article className="ledger-entry" aria-label={`Beitrag ${label}`}>
      <div className="ledger-head">
        <PostThumb post={post} />
        <div className="ledger-source">
          <h3 className="truncate" title={label}>{label}</h3>
          {hasAssets ? <Segments assets={post.assets} /> : <p className="meta">Noch keine Dateien erfasst.</p>}
          <p className="meta truncate" title={sourceLine}>
            <time dateTime={post.discoveredAt} title={formatInstant(post.discoveredAt, zone())}>{timeOfDay}</time>
            {`, ${sourceLine}`}
          </p>
        </div>
        <div className="ledger-mark">
          {deviation}
          {/* One state per row: a post that already shows a chip keeps the verification detail in the technical details. */}
          {verification.kind === 'partial' && deviation === null && <Chip tone="warn" icon={CheckCircle}>Teilweise verifiziert</Chip>}
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
            <TechnicalDetails post={post} verification={verification} />
          </Collapse>
        )
        : deviation === null && <p className="meta ledger-status">{statusLine}</p>}
    </article>
  );
}
