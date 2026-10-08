import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, type AdapterInfo, type KillSwitch } from './api.js';
import { describeCapabilities } from './SourceCheck.js';
import { availabilityLabels } from './history-labels.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Die Anfrage konnte nicht verarbeitet werden.';
}

function KillSwitches({ adapters }: { adapters: AdapterInfo[] }) {
  const [switches, setSwitches] = useState<KillSwitch[]>([]);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try {
      setSwitches((await api.killSwitches()).killSwitches);
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await api.setKillSwitch({
        adapterId: String(data.get('adapterId') ?? ''),
        adapterVersion: String(data.get('adapterVersion') ?? '').trim() || undefined,
        reason: String(data.get('reason') ?? '')
      });
      form.reset();
      setMessage('');
      await load();
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }

  async function lift(id: string) {
    try {
      await api.liftKillSwitch(id);
      setMessage('');
      await load();
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }

  return <section aria-label="Abschaltungen">
    <h4>Adapter abschalten (Administrator)</h4>
    <p>Ein abgeschalteter Adapter nimmt keine neuen Aufträge an. Andere Quellen laufen weiter.</p>
    {switches.length === 0 ? <p>Es ist nichts abgeschaltet.</p> : <ul>{switches.map((entry) => <li key={entry.id}>
      <strong>{entry.adapterId}</strong>{entry.adapterVersion ? ` Version ${entry.adapterVersion}` : ' alle Versionen'}{entry.sourceType ? `, Quelltyp ${entry.sourceType}` : ''}: {entry.reason}
      <button type="button" className="secondary" onClick={() => void lift(entry.id)}>Aufheben</button>
    </li>)}</ul>}
    <form onSubmit={add} aria-label="Adapter abschalten">
      <label>Adapter
        <select name="adapterId">{adapters.map((adapter) => <option key={adapter.id} value={adapter.id}>{adapter.label}</option>)}</select>
      </label>
      <label>Version (leer = alle)<input name="adapterVersion" maxLength={64} /></label>
      <label>Grund<input name="reason" maxLength={500} required /></label>
      <button>Abschalten</button>
    </form>
    {message && <p>{message}</p>}
  </section>;
}

/** Which adapters exist, what they can do and whether the worker can run them. Loaded when opened. */
export function AdaptersPanel({ isAdmin }: { isAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const [adapters, setAdapters] = useState<AdapterInfo[] | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!open) return;
    let active = true;
    api.adapters()
      .then((result) => { if (active) setAdapters(result.adapters); })
      .catch((cause) => { if (active) setMessage(errorMessage(cause)); });
    return () => { active = false; };
  }, [open]);

  return <details onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
    <summary>Unterstützte Quellen und Adapter</summary>
    {message && <p>{message}</p>}
    {open && adapters === null && !message && <p>Wird abgerufen …</p>}
    {adapters && <ul>{adapters.map((adapter) => <li key={adapter.id}>
      <strong>{adapter.label}</strong>: {availabilityLabels[adapter.availability]}{adapter.version ? ` (Version ${adapter.version})` : ''}
      {adapter.disabledByAdministrator ? ' · vom Administrator abgeschaltet' : ''}
      <br />Quellen: {adapter.sourceTypes.map((type) => type.label).join(', ')}
      <br />Fähigkeiten: {describeCapabilities(adapter.capabilities).join(' · ')}
      {adapter.message && <><br /><span className="error">{adapter.message}</span></>}
    </li>)}</ul>}
    {adapters && isAdmin && <KillSwitches adapters={adapters} />}
  </details>;
}
