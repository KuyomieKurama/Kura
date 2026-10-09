import { Prohibit, ProhibitInset } from '@phosphor-icons/react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, type AdapterInfo, type KillSwitch } from './api.js';
import { errorMessage } from './error-message.js';
import { labels } from './labels.js';
import { CapabilityTags } from './SourceCheck.js';
import { Banner } from './ui/Banner.js';
import { Button } from './ui/Button.js';
import { Chip } from './ui/Chip.js';
import { DataTable, type Column } from './ui/DataTable.js';
import { Field } from './ui/Field.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { StatusChip } from './ui/StatusChip.js';

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

  const columns: Column<KillSwitch>[] = [
    { key: 'adapter', header: 'Adapter', render: (entry) => entry.adapterId, mono: true },
    {
      key: 'scope',
      header: 'Gilt für',
      render: (entry) => `${entry.adapterVersion ? `Version ${entry.adapterVersion}` : 'alle Versionen'}${entry.sourceType ? `, Quelltyp ${entry.sourceType}` : ''}`
    },
    { key: 'reason', header: 'Grund', render: (entry) => entry.reason },
    {
      key: 'actions',
      header: labels.userActionsColumn,
      actions: true,
      render: (entry) => <Button variant="ghost" onClick={() => void lift(entry.id)}>Aufheben</Button>
    }
  ];

  return (
    <section className="section adapters-admin" aria-label="Abschaltungen">
      <h3>Adapter abschalten (Administrator)</h3>
      <p className="muted">Ein abgeschalteter Adapter nimmt keine neuen Aufträge an. Andere Quellen laufen weiter.</p>
      {switches.length === 0
        ? <p>Es ist nichts abgeschaltet.</p>
        : <DataTable label="Abgeschaltete Adapter" columns={columns} rows={switches} rowKey={(entry) => entry.id} />}
      <form onSubmit={add} aria-label="Adapter abschalten" className="form-grid">
        <Field label="Adapter">
          {(control) => (
            <select {...control} name="adapterId">
              {adapters.map((adapter) => <option key={adapter.id} value={adapter.id}>{adapter.label}</option>)}
            </select>
          )}
        </Field>
        <Field label="Version (leer = alle)">
          {(control) => <input {...control} name="adapterVersion" maxLength={64} className="input-mono" />}
        </Field>
        <Field label="Grund" wide>
          {(control) => <input {...control} name="reason" maxLength={500} required />}
        </Field>
        <div className="form-actions form-wide">
          <Button variant="danger" type="submit" icon={Prohibit}>Abschalten</Button>
        </div>
      </form>
      {message && <Banner tone="danger">{message}</Banner>}
    </section>
  );
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

  const columns: Column<AdapterInfo>[] = [
    {
      key: 'adapter',
      header: 'Adapter',
      render: (adapter) => (
        <>
          <strong>{adapter.label}</strong>
          {adapter.message && <span className="cell-note">{adapter.message}</span>}
        </>
      )
    },
    { key: 'version', header: 'Version', render: (adapter) => adapter.version ?? labels.unknown, mono: true },
    { key: 'sources', header: 'Quellen', render: (adapter) => adapter.sourceTypes.map((type) => type.label).join(', ') },
    {
      key: 'availability',
      header: 'Werkzeug',
      render: (adapter) => (
        <span className="chip-group">
          <StatusChip domain="availability" status={adapter.availability} />
          {adapter.disabledByAdministrator && <Chip tone="danger" icon={ProhibitInset}>Vom Administrator abgeschaltet</Chip>}
        </span>
      )
    },
    { key: 'capabilities', header: 'Fähigkeiten', render: (adapter) => <CapabilityTags capabilities={adapter.capabilities} /> }
  ];

  return (
    <details className="disclosure" onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
      <summary>Unterstützte Quellen und Adapter</summary>
      <div className="disclosure-body">
        {message && <Banner tone="danger">{message}</Banner>}
        {open && adapters === null && !message && <SkeletonRows count={2} />}
        {adapters && <DataTable label="Adapter" columns={columns} rows={adapters} rowKey={(adapter) => adapter.id} />}
        {adapters && isAdmin && <KillSwitches adapters={adapters} />}
      </div>
    </details>
  );
}
