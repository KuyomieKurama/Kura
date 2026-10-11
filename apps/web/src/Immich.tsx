import { FloppyDisk, Plugs, ProhibitInset, UploadSimple } from '@phosphor-icons/react';
import { type FormEvent, useEffect, useState } from 'react';
import { api, type ImmichEndpointApproval, type ImmichTransfer } from './api.js';
import { errorMessage } from './error-message.js';
import { labels } from './labels.js';
import { Banner, type BannerTone } from './ui/Banner.js';
import { Button } from './ui/Button.js';
import { DataTable, type Column } from './ui/DataTable.js';
import { Dialog } from './ui/Dialog.js';
import { EmptyState } from './ui/EmptyState.js';
import { Field } from './ui/Field.js';
import { FileField } from './ui/FileField.js';
import { PageHeader } from './ui/PageHeader.js';
import { SettingsSection } from './ui/SettingsSection.js';
import { StatusChip } from './ui/StatusChip.js';

type Notice = { tone: BannerTone; text: string };

/** Administrators approve host and port of Immich servers in private networks. */
function ImmichEndpointApprovals() {
  const [approvals, setApprovals] = useState<ImmichEndpointApproval[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [revoking, setRevoking] = useState<ImmichEndpointApproval | null>(null);

  async function reload() {
    try {
      setApprovals((await api.immichEndpointApprovals()).approvals);
    } catch (cause) {
      setNotice({ tone: 'danger', text: errorMessage(cause) });
    }
  }

  useEffect(() => { void reload(); }, []);

  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await api.approveImmichEndpoint({ host: String(data.get('host')), port: Number(data.get('port')) });
      form.reset();
      setNotice({ tone: 'ok', text: 'Endpunkt freigegeben.' });
      await reload();
    } catch (cause) {
      setNotice({ tone: 'danger', text: errorMessage(cause) });
    }
  }

  async function revoke(approval: ImmichEndpointApproval) {
    setRevoking(null);
    try {
      await api.revokeImmichEndpoint(approval);
      setNotice({ tone: 'ok', text: 'Freigabe entzogen.' });
      await reload();
    } catch (cause) {
      setNotice({ tone: 'danger', text: errorMessage(cause) });
    }
  }

  const columns: Column<ImmichEndpointApproval>[] = [
    { key: 'endpoint', header: 'Endpunkt', render: (approval) => `${approval.host}:${approval.port}`, mono: true },
    { key: 'approved', header: 'Freigegeben am', render: (approval) => new Date(approval.approvedAt).toLocaleString('de-DE'), date: true },
    {
      key: 'actions',
      header: labels.userActionsColumn,
      actions: true,
      render: (approval) => (
        <Button variant="danger-ghost" icon={ProhibitInset} aria-label={`Freigabe für ${approval.host}:${approval.port} entziehen`} onClick={() => setRevoking(approval)}>Freigabe entziehen</Button>
      )
    }
  ];

  return (
    <SettingsSection
      title="Freigaben für private Immich-Endpunkte"
      explanation="Ziele in privaten Netzen oder auf diesem Rechner werden nur nach Freigabe von Host und Port durch einen Administrator kontaktiert. Link-Local- und Metadaten-Adressen sind immer gesperrt."
    >
      {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}
      {approvals.length === 0
        ? <EmptyState title="Keine Freigaben vorhanden." hint="Gib unten Host und Port deines Immich-Servers frei." />
        : <DataTable label="Freigaben" columns={columns} rows={approvals} rowKey={(approval) => `${approval.host}:${approval.port}`} />}
      {revoking && (
        <Dialog title={`Freigabe für ${revoking.host}:${revoking.port} entziehen`} close={() => setRevoking(null)}>
          <p>Kura kontaktiert {revoking.host}:{revoking.port} danach nicht mehr. Übertragungen zu diesem Immich-Server schlagen fehl, bis du den Endpunkt erneut freigibst.</p>
          <div className="form-actions">
            <Button variant="danger-solid" icon={ProhibitInset} onClick={() => void revoke(revoking)}>Freigabe entziehen</Button>
            <Button data-autofocus onClick={() => setRevoking(null)}>{labels.cancel}</Button>
          </div>
        </Dialog>
      )}
      <form onSubmit={approve} className="form-grid form-inline-actions">
        <Field label="Host">
          {(control) => <input {...control} name="host" required autoComplete="off" className="input-mono" />}
        </Field>
        <Field label="Port">
          {(control) => <input {...control} name="port" type="number" min="1" max="65535" required />}
        </Field>
        <div className="form-actions">
          <Button type="submit">Endpunkt freigeben</Button>
        </div>
      </form>
    </SettingsSection>
  );
}

export function ImmichPage({ isAdmin }: { isAdmin: boolean }) {
  const [connectionUrl, setConnectionUrl] = useState('');
  const [result, setResult] = useState<Notice | null>(null);
  const [transfer, setTransfer] = useState<ImmichTransfer | null>(null);

  useEffect(() => {
    api.immichConnection()
      .then(({ connection }) => setConnectionUrl(connection?.serverUrl ?? ''))
      .catch((cause) => setResult({ tone: 'danger', text: errorMessage(cause) }));
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await api.saveImmichConnection({ serverUrl: String(data.get('serverUrl')), apiKey: String(data.get('apiKey')) });
      setConnectionUrl(String(data.get('serverUrl')));
      setResult({ tone: 'ok', text: 'Verbindung gespeichert. Der API-Schlüssel wird nicht angezeigt.' });
      form.reset();
    } catch (cause) {
      setResult({ tone: 'danger', text: errorMessage(cause) });
    }
  }

  async function test() {
    try {
      const response = await api.testImmichConnection();
      if (response.error) {
        const target = `${response.target?.host ?? 'unbekannt'}:${response.target?.port ?? 'unbekannt'}`;
        setResult({ tone: 'danger', text: `${response.error.message} (${target})` });
        return;
      }
      setResult({ tone: 'info', text: `Serverversion: ${response.version}; unterstützt: ${response.supported ? 'ja' : 'nein'}.` });
    } catch (cause) {
      setResult({ tone: 'danger', text: errorMessage(cause) });
    }
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get('testFile');
    if (!(file instanceof File) || file.size === 0) {
      setResult({ tone: 'danger', text: 'Wähle eine Testdatei aus.' });
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setResult({ tone: 'danger', text: 'Die Testdatei darf höchstens 4 MiB groß sein.' });
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    try {
      const response = await api.testImmichTransfer({ fileName: file.name, contentBase64: btoa(binary) });
      const status = await api.immichTransfer(response.transfer.id);
      setTransfer(status.transfer);
      if (status.transfer.status === 'verified') {
        setResult({ tone: 'ok', text: 'Testübertragung verifiziert. Das lokale Original bleibt erhalten.' });
      } else if (status.transfer.status === 'reconciling') {
        setResult({ tone: 'warn', text: 'Testübertragung ist unklar und wird abgeglichen. Das lokale Original bleibt erhalten.' });
      } else {
        setResult({ tone: 'info', text: `Testübertragung: ${status.transfer.status}. Das lokale Original bleibt erhalten.` });
      }
    } catch (cause) {
      setResult({ tone: 'danger', text: errorMessage(cause) });
    }
  }

  return (
    <>
      <PageHeader title="Immich" lead="Lokale Originale werden bei diesem Test niemals gelöscht." />
      {result && <Banner tone={result.tone}>{result.text}</Banner>}

      <SettingsSection title="Verbindung" explanation="Adresse und API-Schlüssel deines Immich-Servers. Der Schlüssel wird verschlüsselt gespeichert und nicht wieder angezeigt.">
        <form onSubmit={save} className="form-grid">
          <Field label="Server-URL">
            {(control) => (
              <input {...control} name="serverUrl" type="url" value={connectionUrl} onChange={(event) => setConnectionUrl(event.target.value)} required />
            )}
          </Field>
          <Field label="API-Schlüssel">
            {(control) => <input {...control} name="apiKey" type="password" required autoComplete="off" />}
          </Field>
          <div className="form-actions form-wide">
            <Button variant="primary" type="submit" icon={FloppyDisk}>Verbindung speichern</Button>
            <Button icon={Plugs} onClick={() => void test()}>Verbindung testen</Button>
          </div>
        </form>
      </SettingsSection>

      <SettingsSection title="Testdatei übertragen" explanation="Prüft den ganzen Weg zu Immich mit einer kleinen Datei. Das lokale Original bleibt immer erhalten.">
        <form onSubmit={upload} className="form-grid">
          <FileField label="Testdatei" hint="Höchstens 4 MiB. Das Original bleibt in Kura erhalten." name="testFile" required />
          <div className="form-actions form-wide">
            <Button type="submit" icon={UploadSimple}>Testdatei übertragen</Button>
          </div>
        </form>
      </SettingsSection>

      {transfer && (
        <SettingsSection title="Status der letzten Übertragung">
          <div className="kv-panel" role="group" aria-label="Status der letzten Testübertragung">
            <p>Status: <StatusChip domain="transfer" status={transfer.status} /></p>
            <p>Lokales Original: {transfer.localOriginalRetained ? 'bleibt erhalten' : 'unbekannt'}</p>
            <p>
              Originalnachweis: {transfer.evidence
                ? `Server ${transfer.evidence.serverVersion ?? 'unbekannt'}, ${transfer.evidence.byteLength ?? 'unbekannt'} Bytes, Album ${transfer.evidence.album ?? 'unbekannt'}.`
                : 'noch nicht vorhanden.'}
            </p>
          </div>
        </SettingsSection>
      )}

      {isAdmin && <ImmichEndpointApprovals />}
    </>
  );
}
