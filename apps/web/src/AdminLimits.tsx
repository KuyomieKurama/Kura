import { ArrowsClockwise, FloppyDisk, Info } from '@phosphor-icons/react';
import { type FormEvent, useEffect, useState } from 'react';
import { api, type ApiError, type RuntimePolicyResponse, type User } from './api.js';
import { labels } from './labels.js';
import { Banner, type BannerTone } from './ui/Banner.js';
import { Button } from './ui/Button.js';
import { DataTable, type Column } from './ui/DataTable.js';
import { Field } from './ui/Field.js';
import { Glyph } from './ui/Glyph.js';
import { PageHeader } from './ui/PageHeader.js';
import { SettingsSection } from './ui/SettingsSection.js';
import { SkeletonRows } from './ui/Skeleton.js';

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
  const [noticeTone, setNoticeTone] = useState<BannerTone>('danger');
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
      setNoticeTone('danger');
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
      setNoticeTone('ok');
      setNotice(`Limits gespeichert (Version ${saved.version}). Neue Einstellungen gelten für neue Starts; laufende Läufe werden nicht angetastet.`);
    } catch (cause) {
      const failure = cause as ApiError;
      setProblems(failure.problems ?? []);
      setStale(failure.status === 409);
      setNoticeTone(failure.status === 409 ? 'warn' : 'danger');
      setNotice(failure.message);
    }
  }

  if (!current) {
    return (
      <>
        <PageHeader title={labels.limits} />
        {notice ? <Banner tone="danger">{notice}</Banner> : <SkeletonRows count={4} />}
      </>
    );
  }

  const enforced = new Set(current.enforced);
  const input = (field: Field, group: 'downloads' | 'workers' | 'retention') => {
    const isEnforced = enforced.has(`${group}.${field.key}`);
    const hint = field.hint || !isEnforced
      ? (
        <>
          {field.hint && <span className="hint-line">{field.hint}</span>}
          {!isEnforced && (
            <span className="hint-line hint-notice">
              <Glyph icon={Info} size={14} />
              Wird gespeichert, aber noch nicht durchgesetzt.
            </span>
          )}
        </>
      )
      : undefined;
    return (
      <Field key={field.key} label={field.label} hint={hint}>
        {(control) => (
          <input
            {...control}
            name={field.key}
            type="number"
            min={field.min ?? 0}
            value={values[field.key] ?? ''}
            onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
            required={group !== 'downloads'}
          />
        )}
      </Field>
    );
  };
  const availableUsers = users.filter((user) => !overrides.some((entry) => entry.userId === user.id));
  const userName = (userId: string) => users.find((user) => user.id === userId)?.display_name ?? userId;

  const overrideColumns: Column<Overrides[number]>[] = [
    { key: 'user', header: labels.userNameColumn, render: (entry) => userName(entry.userId) },
    {
      key: 'limit',
      header: 'Gleichzeitige Läufe',
      render: (entry) => (
        <input
          aria-label={`Limit für ${userName(entry.userId)}`}
          type="number"
          min="0"
          value={entry.maxConcurrent}
          onChange={(event) => setOverrides(overrides.map((item) => item.userId === entry.userId ? { ...item, maxConcurrent: event.target.value } : item))}
        />
      )
    },
    {
      key: 'actions',
      header: labels.userActionsColumn,
      actions: true,
      render: (entry) => (
        <Button variant="ghost" onClick={() => setOverrides(overrides.filter((item) => item.userId !== entry.userId))}>Ausnahme entfernen</Button>
      )
    }
  ];

  return (
    <>
      <PageHeader
        title={labels.limits}
        lead={`Version ${current.version}${current.updatedAt ? `, zuletzt geändert am ${new Date(current.updatedAt).toLocaleString('de-DE')}` : ' (Standardwerte, noch nie gespeichert)'}. Das niedrigste anwendbare Limit gewinnt. Eine abgesenkte Grenze verhindert nur neue Starts.`}
      />
      <form onSubmit={submit} aria-label="Limits bearbeiten" className="limits-form">
        <SettingsSection title="Ausführung" explanation="Wie viele Läufe und Downloads gleichzeitig arbeiten dürfen. Leere Felder bedeuten: keine Grenze.">
          <div className="form-grid">{DOWNLOAD_FIELDS.map((field) => input(field, 'downloads'))}</div>
        </SettingsSection>

        <SettingsSection title="Begrenzung je Benutzer" explanation="Ausnahmen gelten für einzelne Benutzer und ersetzen dort das Limit je Benutzer von oben.">
          {overrides.length === 0
            ? <p className="muted">Keine Ausnahmen: Es gilt das Limit je Benutzer von oben.</p>
            : <DataTable label="Ausnahmen je Benutzer" columns={overrideColumns} rows={overrides} rowKey={(entry) => entry.userId} />}
          {availableUsers.length > 0 && (
            <div className="form-grid">
              <Field label="Ausnahme hinzufügen">
                {(control) => (
                  <select
                    {...control}
                    value=""
                    onChange={(event) => event.target.value && setOverrides([...overrides, { userId: event.target.value, maxConcurrent: '' }])}
                  >
                    <option value="">Benutzer wählen …</option>
                    {availableUsers.map((user) => <option key={user.id} value={user.id}>{user.display_name}</option>)}
                  </select>
                )}
              </Field>
            </div>
          )}
        </SettingsSection>

        <SettingsSection title="Worker-Kapazität" explanation="Was ein einzelner Worker gleichzeitig bearbeitet.">
          <div className="form-grid">{WORKER_FIELDS.map((field) => input(field, 'workers'))}</div>
        </SettingsSection>

        <SettingsSection title="Aufbewahrung" explanation="Wie lange beendete Läufe im Verlauf bleiben. Heruntergeladene Dateien sind davon nicht betroffen.">
          <div className="form-grid">
            {input({ key: 'finishedRunDays', label: 'Beendete Läufe aufbewahren (Tage, 1 bis 3650)', min: 1 }, 'retention')}
          </div>
        </SettingsSection>

        {problems.length > 0
          ? (
            <Banner tone="danger">
              <p>{notice}</p>
              <ul>{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
            </Banner>
          )
          : notice && <Banner tone={noticeTone}>{notice}</Banner>}
        <div className="form-actions settings-actions">
          <Button variant="primary" type="submit" icon={FloppyDisk}>Limits speichern</Button>
          {stale && <Button icon={ArrowsClockwise} onClick={() => void load()}>Aktuelle Version laden</Button>}
        </div>
      </form>
    </>
  );
}
