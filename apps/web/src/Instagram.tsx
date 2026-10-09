import { Trash, UploadSimple } from '@phosphor-icons/react';
import { type FormEvent, useEffect, useState } from 'react';
import { api, type InstagramCookieStatus } from './api.js';
import { errorMessage } from './error-message.js';
import { labels } from './labels.js';
import { Banner, type BannerTone } from './ui/Banner.js';
import { Button } from './ui/Button.js';
import { Dialog } from './ui/Dialog.js';
import { Field } from './ui/Field.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { StatusChip } from './ui/StatusChip.js';

const MAX_FILE_BYTES = 256 * 1024;

export const instagramTexts = {
  risk: 'Kura nutzt deine Instagram-Sitzung. Viele oder schnelle Abrufe können zu Sperren deines Kontos führen. Nutze ein eigenes Konto und lade nur Inhalte, die du laden darfst.',
  howTo: 'Exportiere die Cookies deines angemeldeten Browsers im Netscape-Format (cookies.txt), z. B. mit einer Browser-Erweiterung deiner Wahl.',
  expired: 'Instagram-Anmeldung abgelaufen: bitte Cookies neu hochladen'
} as const;

type Notice = { tone: BannerTone; text: string };

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Die Datei konnte nicht gelesen werden.'));
    reader.readAsText(file);
  });
}

const formatDate = (value: string) => new Date(value).toLocaleString('de-DE');

function lastResultText(status: Extract<InstagramCookieStatus, { present: true }>): string {
  if (status.lastResult === 'ok') return 'Letzter Abruf erfolgreich';
  if (status.lastResult === 'auth_required') return instagramTexts.expired;
  return 'Noch kein Abruf mit diesen Cookies';
}

/** The state of the stored cookies as a chip: text first, colour only supports it. */
function StoredStatus({ status }: { status: Extract<InstagramCookieStatus, { present: true }> }) {
  if (status.lastResult === 'auth_required') return <StatusChip domain="credential" status="auth_required" />;
  if (status.expired) return <StatusChip domain="credential" status="expired" />;
  return <StatusChip domain="credential" status="stored" />;
}

/** Instagram session cookies of the signed-in user: status, upload, delete. The cookie content is never shown. */
export function InstagramSection() {
  const [status, setStatus] = useState<InstagramCookieStatus | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function reload() {
    try {
      setStatus(await api.instagramCookies());
    } catch (cause) {
      setNotice({ tone: 'danger', text: errorMessage(cause) });
    }
  }

  useEffect(() => { void reload(); }, []);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = (form.elements.namedItem('cookiesFile') as HTMLInputElement | null)?.files?.[0];
    if (!file || file.size === 0) {
      setNotice({ tone: 'danger', text: 'Bitte wähle eine cookies.txt aus.' });
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setNotice({ tone: 'danger', text: 'Die Datei darf höchstens 256 KiB groß sein.' });
      return;
    }
    setUploading(true);
    try {
      const result = await api.saveInstagramCookies(await readText(file));
      form.reset();
      setNotice({
        tone: 'ok',
        text: `Gespeichert: ${result.cookieCount} Cookies von instagram.com.${result.droppedCount > 0 ? ` ${result.droppedCount} Cookies anderer Seiten wurden verworfen.` : ''} Die Cookies werden verschlüsselt abgelegt und nicht wieder angezeigt.`
      });
      await reload();
    } catch (cause) {
      setNotice({ tone: 'danger', text: errorMessage(cause) });
    } finally {
      setUploading(false);
    }
  }

  async function remove() {
    setConfirmDelete(false);
    try {
      await api.deleteInstagramCookies();
      setNotice({ tone: 'ok', text: 'Die gespeicherten Instagram-Cookies wurden gelöscht.' });
      await reload();
    } catch (cause) {
      setNotice({ tone: 'danger', text: errorMessage(cause) });
    }
  }

  return (
    <section className="section narrow" aria-labelledby="instagram-heading">
      <h2 id="instagram-heading">Instagram</h2>
      <Banner tone="warn" role="status">{instagramTexts.risk}</Banner>
      <p>{instagramTexts.howTo}</p>
      {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}

      {!status && !notice && <SkeletonRows count={2} />}
      {status && !status.secretKeyConfigured && (
        <Banner tone="warn">Cookies können erst gespeichert werden, wenn der Administrator den Schlüssel KURA_SECRET_KEY eingerichtet hat.</Banner>
      )}

      {status?.present && (
        <div className="panel kv-panel" aria-label="Status der Instagram-Cookies">
          <p><StoredStatus status={status} /></p>
          <p>Cookies: {status.cookieCount}</p>
          <p>Früheste Ablaufzeit: {status.earliestExpiry ? formatDate(status.earliestExpiry) : 'keine (nur Sitzungs-Cookies)'}</p>
          <p>Zuletzt benutzt: {status.lastUsedAt ? formatDate(status.lastUsedAt) : 'noch nie'}</p>
          <p>Ergebnis: {lastResultText(status)}</p>
          <div className="form-actions">
            <Button variant="danger-ghost" icon={Trash} onClick={() => setConfirmDelete(true)}>Cookies löschen</Button>
          </div>
        </div>
      )}
      {status && !status.present && <p className="muted">Es sind keine Instagram-Cookies hinterlegt.</p>}

      <form onSubmit={upload} className="form-stack">
        <Field label={status?.present ? 'Neue cookies.txt hochladen' : 'cookies.txt hochladen'} hint="Höchstens 256 KiB. Gespeichert werden nur Cookies von instagram.com, verschlüsselt.">
          {(control) => <input {...control} name="cookiesFile" type="file" accept=".txt,text/plain" />}
        </Field>
        <div className="form-actions">
          <Button variant="primary" type="submit" icon={UploadSimple} disabled={uploading || (status !== null && !status.secretKeyConfigured)}>
            {uploading ? 'Wird hochgeladen …' : 'Hochladen'}
          </Button>
        </div>
      </form>

      {confirmDelete && (
        <Dialog title="Instagram-Cookies löschen" close={() => setConfirmDelete(false)}>
          <p>Die gespeicherten Instagram-Cookies löschen? Abonnements für Instagram-Profile brauchen danach neue Cookies.</p>
          <div className="form-actions">
            <Button variant="danger-solid" icon={Trash} onClick={() => void remove()}>Endgültig löschen</Button>
            <Button onClick={() => setConfirmDelete(false)}>{labels.cancel}</Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
