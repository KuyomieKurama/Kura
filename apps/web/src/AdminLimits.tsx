import { type FormEvent, useEffect, useState } from 'react';
import { api, type ApiError, type RuntimePolicyResponse, type User } from './api.js';

type Field = { key: string; label: string; hint?: string; min?: number };

const DOWNLOAD_FIELDS: Field[] = [
  { key: 'maxConcurrentGlobal', label: 'Gleichzeitige Läufe gesamt', hint: 'Leer = kein Limit, 0 = nichts startet.' },
  { key: 'maxConcurrentPerUser', label: 'Gleichzeitige Läufe je Benutzer', hint: 'Leer = kein Limit, 0 = nichts startet.' },
  { key: 'maxConcurrentPerSourceAccount', label: 'Gleichzeitige Läufe je Quellkonto' },
  { key: 'maxDownloadsPerDayPerUser', label: 'Downloads pro Tag und Benutzer (UTC-Tag)' },
  { key: 'maxBytesPerDayPerUser', label: 'Bytes pro Tag und Benutzer (UTC-Tag)' },
  { key: 'bandwidthBytesPerSecond', label: 'Bandbreite in Bytes pro Sekunde' }
];
const WORKER_FIELDS: Field[] = [
  { key: 'downloadSlots', label: 'Download-Slots' },
  { key: 'transferSlots', label: 'Transfer-Slots' },
  { key: 'lifecycleReservedSlots', label: 'Reservierte Slots für Aufräum- und Freigabeaufgaben' }
];

type Values = Record<string, string>;
type Overrides = Array<{ userId: string; maxConcurrent: string }>;

const text = (value: number | null) => (value === null ? '' : String(value));
/** Empty means "no limit" (null) for optional limits. */
const toNullable = (value: string): number | null => (value.trim() === '' ? null : Number(value));

function initialValues(response: RuntimePolicyResponse): { values: Values; overrides: Overrides } {
  const { downloads, workers, retention } = response.policy;
  const values: Values = { finishedRunDays: String(retention.finishedRunDays) };
  for (const field of DOWNLOAD_FIELDS) values[field.key] = text(downloads[field.key as keyof typeof downloads] as number | null);
  for (const field of WORKER_FIELDS) values[field.key] = String(workers[field.key as keyof typeof workers]);
  const overrides = Object.entries(downloads.perUser).map(([userId, entry]) => ({ userId, maxConcurrent: text(entry.maxConcurrent) }));
  return { values, overrides };
}

export function AdminLimitsPage() {
  const [current, setCurrent] = useState<RuntimePolicyResponse | null>(null);
  const [values, setValues] = useState<Values>({});
  const [overrides, setOverrides] = useState<Overrides>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [notice, setNotice] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [stale, setStale] = useState(false);

  async function load() {
    try {
      const response = await api.runtimePolicy();
      const initial = initialValues(response);
      setCurrent(response);
      setValues(initial.values);
      setOverrides(initial.overrides);
      setStale(false);
      setProblems([]);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'Die Limits konnten nicht geladen werden.');
    }
  }
  useEffect(() => {
    void load();
    api.users().then((result) => setUsers(result.users)).catch(() => undefined);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current) return;
    const perUser: Record<string, { maxConcurrent: number | null }> = {};
    for (const entry of overrides) perUser[entry.userId] = { maxConcurrent: toNullable(entry.maxConcurrent) };
    const number = (key: string) => Number(values[key]);
    const policy = {
      downloads: {
        maxConcurrentGlobal: toNullable(values.maxConcurrentGlobal),
        maxConcurrentPerUser: toNullable(values.maxConcurrentPerUser),
        maxConcurrentPerSourceAccount: toNullable(values.maxConcurrentPerSourceAccount),
        maxDownloadsPerDayPerUser: toNullable(values.maxDownloadsPerDayPerUser),
        maxBytesPerDayPerUser: toNullable(values.maxBytesPerDayPerUser),
        bandwidthBytesPerSecond: toNullable(values.bandwidthBytesPerSecond),
        perAdapter: current.policy.downloads.perAdapter,
        perUser
      },
      workers: { downloadSlots: number('downloadSlots'), transferSlots: number('transferSlots'), lifecycleReservedSlots: number('lifecycleReservedSlots') },
      retention: { finishedRunDays: number('finishedRunDays') }
    };
    try {
      const saved = await api.saveRuntimePolicy(current.version, policy);
      const next = initialValues(saved);
      setCurrent(saved);
      setValues(next.values);
      setOverrides(next.overrides);
      setProblems([]);
      setStale(false);
      setNotice(`Limits gespeichert (Version ${saved.version}). Neue Einstellungen gelten für neue Starts; laufende Läufe werden nicht angetastet.`);
    } catch (cause) {
      const failure = cause as ApiError;
      setProblems(failure.problems ?? []);
      setStale(failure.status === 409);
      setNotice(failure.message);
    }
  }

  if (!current) return <section><h2>Limits</h2>{notice ? <p className="form-error" role="alert">{notice}</p> : <p>Wird abgerufen …</p>}</section>;

  const enforced = new Set(current.enforced);
  const input = (field: Field, group: 'downloads' | 'workers' | 'retention') => {
    const isEnforced = enforced.has(`${group}.${field.key}`);
    return <label key={field.key}>{field.label}
      <input
        name={field.key}
        type="number"
        min={field.min ?? 0}
        value={values[field.key] ?? ''}
        onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
        required={group !== 'downloads'}
      />
      {field.hint && <small>{field.hint}</small>}
      {!isEnforced && <small> Wird gespeichert, aber noch nicht durchgesetzt.</small>}
    </label>;
  };
  const availableUsers = users.filter((user) => !overrides.some((entry) => entry.userId === user.id));

  return <section>
    <h2>Limits</h2>
    <p>Version {current.version}{current.updatedAt ? `, zuletzt geändert am ${new Date(current.updatedAt).toLocaleString('de-DE')}` : ' (Standardwerte, noch nie gespeichert)'}. Das niedrigste anwendbare Limit gewinnt. Eine abgesenkte Grenze verhindert nur neue Starts.</p>
    <form onSubmit={submit} aria-label="Limits bearbeiten">
      <h3>Ausführung</h3>
      {DOWNLOAD_FIELDS.map((field) => input(field, 'downloads'))}
      <h3>Begrenzung je Benutzer</h3>
      {overrides.length === 0 && <p>Keine Ausnahmen: Es gilt das Limit je Benutzer von oben.</p>}
      {overrides.map((entry) => <p key={entry.userId}>
        {users.find((user) => user.id === entry.userId)?.display_name ?? entry.userId}:{' '}
        <input
          aria-label={`Limit für ${users.find((user) => user.id === entry.userId)?.display_name ?? entry.userId}`}
          type="number"
          min="0"
          value={entry.maxConcurrent}
          onChange={(event) => setOverrides(overrides.map((item) => item.userId === entry.userId ? { ...item, maxConcurrent: event.target.value } : item))}
        />
        <button type="button" className="secondary" onClick={() => setOverrides(overrides.filter((item) => item.userId !== entry.userId))}>Ausnahme entfernen</button>
      </p>)}
      {availableUsers.length > 0 && <label>Ausnahme hinzufügen
        <select value="" onChange={(event) => event.target.value && setOverrides([...overrides, { userId: event.target.value, maxConcurrent: '' }])}>
          <option value="">Benutzer wählen …</option>
          {availableUsers.map((user) => <option key={user.id} value={user.id}>{user.display_name}</option>)}
        </select>
      </label>}
      <h3>Worker-Kapazität</h3>
      {WORKER_FIELDS.map((field) => input(field, 'workers'))}
      <h3>Aufbewahrung</h3>
      {input({ key: 'finishedRunDays', label: 'Beendete Läufe aufbewahren (Tage, 1 bis 3650)', min: 1 }, 'retention')}
      {problems.length > 0 && <ul role="alert" className="form-error">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
      {notice && <p role={stale ? 'alert' : 'status'}>{notice}</p>}
      {stale && <button type="button" onClick={() => void load()}>Aktuelle Version laden</button>}
      <button>Limits speichern</button>
    </form>
  </section>;
}
