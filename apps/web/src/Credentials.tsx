import { PencilSimple, Plus, Trash, UploadSimple } from '@phosphor-icons/react';
import { type FormEvent, useEffect, useState } from 'react';
import { api, type CredentialOverview, type CredentialPlatform, type CredentialStatus } from './api.js';
import { errorMessage } from './error-message.js';
import { labels } from './labels.js';
import { Banner, type BannerTone } from './ui/Banner.js';
import { Button } from './ui/Button.js';
import { DisclosureSummary } from './ui/DisclosureSummary.js';
import { Dialog } from './ui/Dialog.js';
import { Field } from './ui/Field.js';
import { FileField } from './ui/FileField.js';
import { SettingsSection } from './ui/SettingsSection.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { StatusChip } from './ui/StatusChip.js';
import { useToast } from './ui/Toast.js';

const MAX_COOKIE_FILE_BYTES = 256 * 1024;
const MAX_TOKEN_BYTES = 1024;

/** What the account page says about one platform. Plain German, du-form, no dashes. */
interface PlatformTexts {
  platform: CredentialPlatform;
  /** Name of the platform as the heading and in the sentences. */
  label: string;
  kind: 'cookies' | 'token';
  /** The account-risk notice. */
  risk: string;
  /** Short how-to for the person who has the login at hand. */
  howTo: string;
  /** Longer steps, shown in a disclosure. */
  steps?: readonly string[];
  /** Where the stored cookies come from, for the message after the upload. */
  domains?: string;
  /** The hint says that the login is optional. */
  optional?: boolean;
}

export const credentialTexts: Readonly<Record<CredentialPlatform, PlatformTexts>> = {
  instagram: {
    platform: 'instagram',
    label: 'Instagram',
    kind: 'cookies',
    domains: 'instagram.com',
    risk: 'Kura nutzt deine Instagram-Sitzung. Viele oder schnelle Abrufe können zu Sperren deines Kontos führen. Nutze ein eigenes Konto und lade nur Inhalte, die du laden darfst.',
    howTo: 'Exportiere die Cookies deines angemeldeten Browsers im Netscape-Format (cookies.txt), z. B. mit einer Browser-Erweiterung deiner Wahl.'
  },
  patreon: {
    platform: 'patreon',
    label: 'Patreon',
    kind: 'cookies',
    domains: 'patreon.com',
    risk: 'Kura nutzt deine Patreon-Sitzung. Viele oder schnelle Abrufe können zu Sperren deines Kontos führen. Nutze dein eigenes Konto und lade nur Beiträge, die du sehen und laden darfst.',
    howTo: 'Melde dich im Browser bei Patreon an und exportiere die Cookies im Netscape-Format (cookies.txt), z. B. mit einer Browser-Erweiterung deiner Wahl. Wichtig ist das Cookie "session_id" von patreon.com. Geladen wird nur, was dein Konto sehen darf.'
  },
  pixiv: {
    platform: 'pixiv',
    label: 'Pixiv',
    kind: 'token',
    risk: 'Das Token gibt Zugriff auf dein Pixiv-Konto. Gib es nur hier ein, teile es mit niemandem und lösche es hier, wenn du Kura nicht mehr nutzt. Viele oder schnelle Abrufe können zu Sperren führen.',
    howTo: 'Pixiv meldet Kura nicht mit Cookies an, sondern mit einem Token (dem "refresh-token"). Du erzeugst es einmal auf deinem eigenen Rechner mit dem Programm gallery-dl.',
    steps: [
      'Lade gallery-dl auf deinem eigenen Rechner herunter (nicht auf dem Server) und öffne ein Terminal.',
      'Gib ein: gallery-dl oauth:pixiv',
      'Es öffnet sich die Pixiv-Anmeldeseite im Browser. Öffne dort die Entwicklerwerkzeuge (Taste F12) und wechsle zum Reiter "Netzwerk". Melde dich dann bei Pixiv an.',
      'Wähle den letzten Eintrag, der mit "callback?state=" beginnt, und kopiere den Wert von "code". Der Code gilt nur 30 Sekunden.',
      'Füge den Code im Terminal ein. gallery-dl schreibt dann "Your \'refresh-token\' is" und darunter eine lange Zeichenfolge. Kopiere nur diese Zeichenfolge und füge sie unten ein.'
    ]
  },
  youtube: {
    platform: 'youtube',
    label: 'YouTube',
    kind: 'cookies',
    domains: 'youtube.com und google.com',
    optional: true,
    risk: 'Kura nutzt deine YouTube-Sitzung. Viele oder schnelle Abrufe können zu Sperren deines Google-Kontos führen. Nutze ein eigenes Konto.',
    howTo: 'Optional: Öffentliche Videos laden auch ohne Anmeldung. Die Cookies helfen bei Videos mit Altersbeschränkung oder nur für Mitglieder. Exportiere sie im Netscape-Format (cookies.txt), am besten aus einem privaten Browserfenster, das du danach schließt, sonst ändert YouTube die Cookies und sie werden ungültig.'
  }
};

const PLATFORM_ORDER: readonly CredentialPlatform[] = ['instagram', 'patreon', 'pixiv', 'youtube'];

type Notice = { tone: BannerTone; text: string };
type StoredStatus = Extract<CredentialStatus, { present: true }>;

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Die Datei konnte nicht gelesen werden.'));
    reader.readAsText(file);
  });
}

const formatDate = (value: string) => new Date(value).toLocaleString('de-DE');

/** "Instagram-Cookies" or "Pixiv-Token". */
const secretName = (texts: PlatformTexts) => `${texts.label}-${texts.kind === 'token' ? 'Token' : 'Cookies'}`;

function lastResultText(texts: PlatformTexts, status: StoredStatus): string {
  if (status.lastResult === 'ok') return 'Letzter Abruf erfolgreich';
  if (status.lastResult === 'auth_required') {
    return `${texts.label}-Anmeldung abgelaufen: bitte ${texts.kind === 'token' ? 'Token neu hinterlegen' : 'Cookies neu hochladen'}`;
  }
  return `Noch kein Abruf mit ${texts.kind === 'token' ? 'diesem Token' : 'diesen Cookies'}`;
}

/** The state of the stored login as a chip: text first, colour only supports it. */
function StoredChip({ texts, status }: { texts: PlatformTexts; status: StoredStatus }) {
  if (status.lastResult === 'auth_required') return <StatusChip domain="credential" status="auth_required" />;
  if (status.expired) return <StatusChip domain="credential" status="expired" />;
  return <StatusChip domain="credential" status={texts.kind === 'token' ? 'token_stored' : 'stored'} />;
}

/**
 * The logins of the signed-in user as one list with a row per platform: name, state, the facts that matter and the
 * action. Uploading or replacing happens in a dialog that carries the account-risk notice exactly once. The content of
 * a login is never shown, not even after the upload.
 */
export function CredentialsSection() {
  const [overview, setOverview] = useState<CredentialOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function reload() {
    try {
      setOverview(await api.credentials());
      setLoadError(null);
    } catch (cause) {
      setLoadError(errorMessage(cause));
    }
  }

  useEffect(() => { void reload(); }, []);

  return (
    <SettingsSection
      title="Zugänge"
      explanation="Hier hinterlegst du die Anmeldungen deiner eigenen Konten, damit Kura Inhalte laden kann, die du sehen darfst. Alles wird verschlüsselt gespeichert und nicht wieder angezeigt."
    >
      {loadError && <Banner tone="danger">{loadError}</Banner>}
      {!overview && !loadError && <SkeletonRows count={4} />}
      {overview && !overview.secretKeyConfigured && (
        <Banner tone="warn">Zugänge können erst gespeichert werden, wenn der Administrator den Schlüssel KURA_SECRET_KEY eingerichtet hat.</Banner>
      )}
      {overview && (
        <ul className="credential-list">
          {PLATFORM_ORDER.map((platform) => (
            <CredentialRow
              key={platform}
              texts={credentialTexts[platform]}
              status={overview.credentials.find((entry) => entry.platform === platform) ?? { platform, kind: credentialTexts[platform].kind, present: false }}
              secretKeyConfigured={overview.secretKeyConfigured}
              reload={reload}
            />
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

function CredentialRow({ texts, status, secretKeyConfigured, reload }: {
  texts: PlatformTexts;
  status: CredentialStatus;
  secretKeyConfigured: boolean;
  reload: () => Promise<void>;
}) {
  const toast = useToast();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const headingId = `credential-${texts.platform}-heading`;
  const isToken = texts.kind === 'token';
  const name = secretName(texts);

  async function save(text: string, form: HTMLFormElement) {
    setBusy(true);
    try {
      const result = await api.saveCredential(texts.platform, text);
      form.reset();
      setNotice(null);
      setEditing(false);
      toast({
        message: isToken
          ? 'Gespeichert: Das Token wird verschlüsselt abgelegt und nicht wieder angezeigt.'
          : `Gespeichert: ${result.cookieCount} Cookies von ${texts.domains}.${result.droppedCount > 0 ? ` ${result.droppedCount} Cookies anderer Seiten wurden verworfen.` : ''} Die Cookies werden verschlüsselt abgelegt und nicht wieder angezeigt.`
      });
      await reload();
    } catch (cause) {
      setNotice({ tone: 'danger', text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (isToken) {
      const token = (form.elements.namedItem('token') as HTMLInputElement | null)?.value.trim() ?? '';
      if (token === '') return setNotice({ tone: 'danger', text: 'Bitte füge das Token ein.' });
      if (token.length > MAX_TOKEN_BYTES) return setNotice({ tone: 'danger', text: 'Das Token ist zu lang.' });
      return save(token, form);
    }
    const file = (form.elements.namedItem('cookiesFile') as HTMLInputElement | null)?.files?.[0];
    if (!file || file.size === 0) return setNotice({ tone: 'danger', text: 'Bitte wähle eine cookies.txt aus.' });
    if (file.size > MAX_COOKIE_FILE_BYTES) return setNotice({ tone: 'danger', text: 'Die Datei darf höchstens 256 KiB groß sein.' });
    try {
      return await save(await readText(file), form);
    } catch (cause) {
      return setNotice({ tone: 'danger', text: errorMessage(cause) });
    }
  }

  async function remove() {
    setConfirmDelete(false);
    try {
      await api.deleteCredential(texts.platform);
      toast({ message: `${isToken ? 'Das gespeicherte Pixiv-Token wurde' : `Die gespeicherten ${name} wurden`} gelöscht.` });
      await reload();
    } catch (cause) {
      setNotice({ tone: 'danger', text: errorMessage(cause) });
    }
  }

  const closeEditor = () => { setEditing(false); setNotice(null); };

  return (
    <li className="credential-item" aria-labelledby={headingId}>
      <div className="credential-name">
        <h3 id={headingId}>{texts.label}</h3>
        {status.present && <StoredChip texts={texts} status={status} />}
      </div>
      {status.present ? (
        <div className="credential-facts" role="group" aria-label={isToken ? 'Status des Pixiv-Tokens' : `Status der ${name}`}>
          {!isToken && <p>Cookies: {status.cookieCount}</p>}
          {!isToken && <p>Früheste Ablaufzeit: {status.earliestExpiry ? formatDate(status.earliestExpiry) : 'keine (nur Sitzungs-Cookies)'}</p>}
          <p>Zuletzt benutzt: {status.lastUsedAt ? formatDate(status.lastUsedAt) : 'noch nie'}</p>
          <p>Ergebnis: {lastResultText(texts, status)}</p>
        </div>
      ) : (
        <p className="credential-facts">{isToken ? `Es ist kein ${name} hinterlegt.` : `Es sind keine ${name} hinterlegt.`}{texts.optional ? ' Das ist in Ordnung, die Anmeldung ist optional.' : ''}</p>
      )}
      {notice && !editing && <Banner tone={notice.tone}>{notice.text}</Banner>}
      <div className="credential-actions">
        <Button
          variant="secondary"
          icon={status.present ? PencilSimple : Plus}
          disabled={!secretKeyConfigured}
          aria-label={`${name} ${status.present ? 'ersetzen' : 'hinterlegen'}`}
          onClick={() => setEditing(true)}
        >
          {status.present ? 'Ersetzen' : 'Hinterlegen'}
        </Button>
        {status.present && (
          <Button variant="danger-ghost" icon={Trash} aria-label={isToken ? 'Token löschen' : 'Cookies löschen'} onClick={() => setConfirmDelete(true)}>Löschen</Button>
        )}
      </div>

      {editing && (
        <Dialog title={`${name} ${status.present ? 'ersetzen' : 'hinterlegen'}`} close={closeEditor}>
          <div className="form-stack" role="region" aria-label={texts.label}>
            <Banner tone="warn" role="status">{texts.risk}</Banner>
            <p>{texts.howTo}</p>
            {texts.steps && (
              <details>
                <DisclosureSummary>So erzeugst du das Token</DisclosureSummary>
                <ol className="credential-steps">{texts.steps.map((step) => <li key={step}>{step}</li>)}</ol>
              </details>
            )}
            {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}
            <form onSubmit={(event) => void submit(event)} className="form-stack">
              {isToken ? (
                <Field label={status.present ? 'Neues Pixiv-Token' : 'Pixiv-Token'} hint="Nur die Zeichenfolge nach refresh-token. Das Token wird verschlüsselt gespeichert und nicht wieder angezeigt.">
                  {(control) => <input {...control} name="token" type="password" autoComplete="off" spellCheck={false} />}
                </Field>
              ) : (
                <FileField
                  label={status.present ? 'Neue cookies.txt hochladen' : 'cookies.txt hochladen'}
                  hint={`Höchstens 256 KiB. Gespeichert werden nur Cookies von ${texts.domains}, verschlüsselt.`}
                  name="cookiesFile"
                  accept=".txt,text/plain"
                />
              )}
              <div className="form-actions">
                <Button variant="primary" type="submit" icon={UploadSimple} disabled={busy || !secretKeyConfigured}>
                  {busy ? (isToken ? 'Wird gespeichert …' : 'Wird hochgeladen …') : (isToken ? 'Speichern' : 'Hochladen')}
                </Button>
                <Button onClick={closeEditor}>{labels.cancel}</Button>
              </div>
            </form>
          </div>
        </Dialog>
      )}

      {confirmDelete && (
        <Dialog title={`${name} löschen`} close={() => setConfirmDelete(false)}>
          <p>
            {isToken
              ? 'Das gespeicherte Pixiv-Token löschen? Abonnements für Pixiv brauchen danach ein neues Token.'
              : `Die gespeicherten ${name} löschen? Abonnements für ${texts.label} brauchen danach neue Cookies${texts.optional ? ' (nur für Inhalte, die eine Anmeldung brauchen)' : ''}.`}
          </p>
          <div className="form-actions">
            <Button variant="danger-solid" icon={Trash} onClick={() => void remove()}>Endgültig löschen</Button>
            <Button data-autofocus onClick={() => setConfirmDelete(false)}>{labels.cancel}</Button>
          </div>
        </Dialog>
      )}
    </li>
  );
}
