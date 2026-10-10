import { ArrowsClockwise, ArrowSquareOut, CheckCircle, CircleDashed, Prohibit, WarningCircle } from '@phosphor-icons/react';
import { useState } from 'react';
import { api, type UpdateStatus, type VersionInfo } from './api.js';
import { errorMessage } from './error-message.js';
import { Banner } from './ui/Banner.js';
import { Button } from './ui/Button.js';
import { Chip } from './ui/Chip.js';
import { PageHeader } from './ui/PageHeader.js';

/** A git tag as the update check delivers it. Anything else is never put into a command. */
const SAFE_TAG = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export const versionTexts = {
  title: 'Über Kura',
  linkTitle: 'Version und Update',
  checkNow: 'Jetzt prüfen',
  checking: 'Wird geprüft',
  details: 'Details',
  dismiss: 'Ausblenden',
  newVersion: 'Neue Version',
  unknownVersion: 'unbekannt',
  never: 'noch nie',
  adminSentence: 'Die Administration aktualisiert Kura.',
  statusLabels: { current: 'Aktuell', outdated: 'Veraltet', unknown: 'Unbekannt', disabled: 'Deaktiviert' } satisfies Record<UpdateStatus, string>
} as const;

function formatDate(iso: string | null): string {
  if (!iso) return versionTexts.never;
  return new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

/** "Kura 0.2.0" for the sidebar. Without a known version just the name. */
export function versionLabel(info: VersionInfo): string {
  return info.version === versionTexts.unknownVersion ? 'Kura' : `Kura ${info.version}`;
}

export function hasNewVersion(info: VersionInfo): boolean {
  return info.status === 'outdated' && info.latestVersion !== null;
}

/** The strip above the main area. Only administrators get it, and only for a version they have not hidden. */
export function VersionNotice({ info, onDetails, onDismiss }: { info: VersionInfo; onDetails: () => void; onDismiss: () => void }) {
  return (
    <div className="version-notice" role="status">
      <p>{`Kura ${info.latestVersion} ist verfügbar. Du nutzt ${info.version}.`}</p>
      <div className="version-notice-actions">
        <Button variant="secondary" onClick={onDetails}>{versionTexts.details}</Button>
        <Button variant="ghost" onClick={onDismiss}>{versionTexts.dismiss}</Button>
      </div>
    </div>
  );
}

function statusChip(status: UpdateStatus) {
  const label = versionTexts.statusLabels[status];
  if (status === 'current') return <Chip tone="ok" icon={CheckCircle}>{label}</Chip>;
  if (status === 'outdated') return <Chip tone="warn" icon={WarningCircle}>{label}</Chip>;
  if (status === 'disabled') return <Chip tone="neutral" icon={Prohibit}>{label}</Chip>;
  return <Chip tone="neutral" icon={CircleDashed}>{label}</Chip>;
}

function UpgradeInstructions({ info }: { info: VersionInfo }) {
  const tag = info.latestTag && SAFE_TAG.test(info.latestTag) ? info.latestTag : null;
  return (
    <section className="section" aria-labelledby="upgrade-heading">
      <h2 id="upgrade-heading">So aktualisierst du</h2>
      <p className="muted">
        Die Anleitung gilt für die Einrichtung auf der VM mit Podman (docs/vm-setup.md, Abschnitt "Version und Update").
        Bei einem anderen Betrieb baust und startest du die neue Version so, wie du Kura installiert hast.
      </p>
      <ol className="steps">
        <li>
          <strong>Sichern.</strong> Sichere vor dem Update die Datenbank (Podman-Volume kura-pgdata) und die
          Datei ~/.config/kura/kura.env mit dem Schlüssel KURA_SECRET_KEY. Ohne diesen Schlüssel sind gespeicherte
          Zugangsdaten nach einer Wiederherstellung unbrauchbar.
        </li>
        {tag ? (
          <>
            <li>
              <strong>Nur wenn sich das Deploy-Skript geändert hat</strong> (steht in den Release-Hinweisen): erst das neue Skript holen.
              <code className="command">{`git -C ~/work/Kura fetch --tags\ngit -C ~/work/Kura checkout ${tag}\ncp ~/work/Kura/deploy/kura-deploy.sh ~/bin/`}</code>
            </li>
            <li>
              <strong>Aktualisieren.</strong> Auf dem Server als Benutzer kura:
              <code className="command">{`~/bin/kura-deploy.sh ${tag}`}</code>
            </li>
          </>
        ) : (
          <li><strong>Aktualisieren.</strong> Die angebotene Version hat keine gültige Versionsnummer, daher zeigt Kura hier keinen Befehl an.</li>
        )}
        <li><strong>Prüfen.</strong> Danach zeigt diese Seite {info.latestVersion ? `Kura ${info.latestVersion}` : 'die neue Version'} an.</li>
      </ol>
      <p className="muted">
        Zurück zur alten Version geht es mit demselben Befehl und dem alten Tag. Hat die neue Version die Datenbank verändert,
        spielst du dazu die Sicherung zurück.
      </p>
    </section>
  );
}

/** Version, commit, status of the update check, release notes and the upgrade instructions. */
export function VersionPage({ info, isAdmin, onChanged }: { info: VersionInfo | null; isAdmin: boolean; onChanged: (next: VersionInfo) => void }) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  if (!info) {
    return (
      <>
        <PageHeader title={versionTexts.title} />
        <Banner tone="warn">Die Versionsangaben konnten nicht geladen werden. Lade die Seite neu.</Banner>
      </>
    );
  }

  async function checkNow() {
    setChecking(true);
    setError('');
    try {
      onChanged(await api.checkVersion());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setChecking(false);
    }
  }

  const outdated = hasNewVersion(info);
  const releaseLink = info.releaseUrl && info.releaseUrl.startsWith('https://github.com/') ? info.releaseUrl : null;
  return (
    <>
      <PageHeader
        title={versionTexts.title}
        lead="Welche Version von Kura hier läuft und ob es eine neuere gibt."
        actions={isAdmin && info.checkEnabled ? (
          <Button variant="secondary" icon={ArrowsClockwise} disabled={checking} onClick={() => void checkNow()}>
            {checking ? versionTexts.checking : versionTexts.checkNow}
          </Button>
        ) : undefined}
      />
      {error && <Banner tone="danger">{error}</Banner>}
      <section className="section" aria-labelledby="version-heading">
        <h2 id="version-heading">{versionTexts.linkTitle}</h2>
        <dl className="status-list">
          <div className="status-item">
            <dt>Version</dt>
            <dd className="mono">{info.version}</dd>
          </div>
          <div className="status-item">
            <dt>Commit</dt>
            <dd className="mono">{info.commit}</dd>
          </div>
          <div className="status-item">
            <dt>Status</dt>
            <dd>{statusChip(info.status)}</dd>
          </div>
          <div className="status-item">
            <dt>Neueste Version</dt>
            <dd className="mono">{info.latestVersion ?? versionTexts.unknownVersion}</dd>
          </div>
          <div className="status-item">
            <dt>Letzte Prüfung</dt>
            <dd className="num">{formatDate(info.checkedAt)}</dd>
          </div>
          <div className="status-item">
            <dt>Quelle</dt>
            <dd className="mono">{info.repository}</dd>
          </div>
        </dl>
        {info.reason && <Banner tone={info.status === 'unknown' ? 'warn' : 'info'}>{info.reason}</Banner>}
        {outdated && !isAdmin && (
          <Banner tone="info">{`Es gibt eine neuere Version (${info.latestVersion}).`}</Banner>
        )}
        {outdated && isAdmin && (
          <Banner tone="info">{`Kura ${info.latestVersion} ist verfügbar. Du nutzt ${info.version}.`}</Banner>
        )}
        {info.status === 'current' && <p className="muted">Du nutzt die neueste Version.</p>}
      </section>
      {outdated && info.releaseNotes && (
        <section className="section" aria-labelledby="notes-heading">
          <h2 id="notes-heading">Neu in {info.latestVersion}</h2>
          <pre className="release-notes">{info.releaseNotes}</pre>
        </section>
      )}
      {releaseLink && outdated && (
        <p>
          <a href={releaseLink} target="_blank" rel="noopener noreferrer">
            {info.hasRelease ? 'Release auf GitHub ansehen' : 'Version auf GitHub ansehen'} <ArrowSquareOut size={14} aria-hidden="true" />
          </a>
        </p>
      )}
      {outdated && isAdmin && <UpgradeInstructions info={info} />}
      {isAdmin ? (
        <section className="section" aria-labelledby="rules-heading">
          <h2 id="rules-heading">Wie Kura mit Updates umgeht</h2>
          <ul>
            <li>
              Kura aktualisiert sich nicht selbst und hat keinen Knopf, der ein Update startet. Die Anwendung darf ihren
              eigenen Server nicht neu bauen oder neu starten. Ein Update führst du auf dem Server aus.
            </li>
            <li>
              Die Prüfung fragt alle 12 Stunden bei GitHub nach der neuesten Version. GitHub sieht dabei die IP-Adresse
              dieses Servers, sonst wird nichts gesendet. Abschalten: KURA_UPDATE_CHECK=false in der Datei kura.env.
            </li>
          </ul>
        </section>
      ) : (
        <p className="muted">Kura aktualisiert sich nicht selbst. {versionTexts.adminSentence}</p>
      )}
    </>
  );
}
