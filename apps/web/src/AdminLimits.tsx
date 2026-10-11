import { ArrowsClockwise, FloppyDisk } from '@phosphor-icons/react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { api, type ApiError, type RuntimePolicyResponse, type User } from './api.js';
import { labels } from './labels.js';
import { Banner, type BannerTone } from './ui/Banner.js';
import { Button } from './ui/Button.js';
import { DataTable, type Column } from './ui/DataTable.js';
import { Field } from './ui/Field.js';
import { PageHeader } from './ui/PageHeader.js';
import { SettingsSection } from './ui/SettingsSection.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { absoluteMinute } from './time-format.js';

/** `unit` is shown behind the number. `scale` is how many stored units one displayed unit is (bytes per MiB); without it the stored value is shown as it is. */
type Field = { key: string; label: string; unit: string; hint?: string; min?: number; scale?: number };

const MIB = 1024 * 1024;
const DOWNLOAD_FIELDS: Field[] = [
  { key: 'maxConcurrentGlobal', label: 'Läufe gleichzeitig, insgesamt', unit: 'Läufe' },
  { key: 'maxConcurrentPerUser', label: 'Läufe gleichzeitig je Benutzer', unit: 'Läufe' },
  { key: 'maxConcurrentPerSourceAccount', label: 'Läufe gleichzeitig je Quellkonto', unit: 'Läufe' },
  { key: 'maxDownloadsPerDayPerUser', label: 'Downloads pro Tag und Benutzer', unit: 'Downloads', hint: 'Ein Tag zählt von 00:00 bis 24:00 Uhr UTC.' },
  { key: 'maxBytesPerDayPerUser', label: 'Datenmenge pro Tag und Benutzer', unit: 'MiB', scale: MIB },
  { key: 'bandwidthBytesPerSecond', label: 'Bandbreite', unit: 'MiB pro Sekunde', scale: MIB }
];
const WORKER_FIELDS: Field[] = [
  { key: 'downloadSlots', label: 'Downloads gleichzeitig', unit: 'Plätze' },
  { key: 'transferSlots', label: 'Übergaben an Immich gleichzeitig', unit: 'Plätze' },
  { key: 'lifecycleReservedSlots', label: 'Für Aufräumen und Freigaben reserviert', unit: 'Plätze' }
];

type Values = Record<string, string>;
type Overrides = Array<{ userId: string; maxConcurrent: string }>;

const text = (value: number | null, scale = 1) => (value === null ? '' : String(scale === 1 ? value : Math.round((value / scale) * 1000) / 1000));
/** Empty means "no limit" (null) for optional limits. A scaled field (MiB) is converted back to the stored unit (bytes). */
const toNullable = (value: string, scale = 1): number | null => (value.trim() === '' ? null : Math.round(Number(value) * scale));
const scaleOf = (key: string) => DOWNLOAD_FIELDS.find((field) => field.key === key)?.scale ?? 1;

function initialValues(response: RuntimePolicyResponse): { values: Values; overrides: Overrides } {
  const { downloads, workers, retention } = response.policy;
  const values: Values = { finishedRunDays: String(retention.finishedRunDays) };
  for (const field of DOWNLOAD_FIELDS) values[field.key] = text(downloads[field.key as keyof typeof downloads] as number | null, field.scale);
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
        maxBytesPerDayPerUser: toNullable(values.maxBytesPerDayPerUser, scaleOf('maxBytesPerDayPerUser')),
        bandwidthBytesPerSecond: toNullable(values.bandwidthBytesPerSecond, scaleOf('bandwidthBytesPerSecond')),
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

  // Dirty: the form differs from what was loaded or saved last.
  const dirty = useMemo(() => {
    if (!current) return false;
    const initial = initialValues(current);
    return JSON.stringify([initial.values, initial.overrides]) !== JSON.stringify([values, overrides]);
  }, [current, values, overrides]);

  if (!current) {
    return (
      <>
        <PageHeader title={labels.limits} />
        {notice ? <Banner tone="danger">{notice}</Banner> : <SkeletonRows count={4} />}
      </>
    );
  }

  const enforced = new Set(current.enforced);
  const input = (field: Field, group: 'downloads' | 'workers' | 'retention') => (
    <Field key={field.key} label={field.label} hint={field.hint}>
      {(control) => (
        <span className="input-unit">
          <input
            {...control}
            name={field.key}
            type="number"
            min={field.min ?? 0}
            step={field.scale === undefined ? undefined : 'any'}
            placeholder={group === 'downloads' ? 'Kein Limit' : undefined}
            value={values[field.key] ?? ''}
            onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
            required={group !== 'downloads'}
          />
          <span className="input-unit-text">{field.unit}</span>
        </span>
      )}
    </Field>
  );
  /** One sentence over the group instead of one note under every field: which of these values do not act yet. */
  const notEnforced = (group: 'downloads' | 'workers' | 'retention', fields: Field[]) => {
    const names = fields.filter((field) => !enforced.has(`${group}.${field.key}`)).map((field) => field.label);
    return names.length === 0
      ? null
      : <p className="settings-note">{`Wird gespeichert, wirkt aber noch nicht: ${names.join(', ')}.`}</p>;
  };
  const availableUsers = users.filter((user) => !overrides.some((entry) => entry.userId === user.id));
  const userName = (userId: string) => users.find((user) => user.id === userId)?.display_name ?? userId;

  const overrideColumns: Column<Overrides[number]>[] = [
    { key: 'user', header: labels.userNameColumn, render: (entry) => userName(entry.userId) },
    {
      key: 'limit',
      header: 'Läufe gleichzeitig',
      render: (entry) => (
        <span className="input-unit">
          <input
            aria-label={`Limit für ${userName(entry.userId)}`}
            type="number"
            min="0"
            placeholder="Kein Limit"
            value={entry.maxConcurrent}
            onChange={(event) => setOverrides(overrides.map((item) => item.userId === entry.userId ? { ...item, maxConcurrent: event.target.value } : item))}
          />
          <span className="input-unit-text">Läufe</span>
        </span>
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
        lead={`${current.updatedAt ? `Zuletzt geändert am ${absoluteMinute(current.updatedAt)} (Version ${current.version}).` : 'Du hast noch keine Limits gespeichert, es gelten die Standardwerte.'} Gelten mehrere Limits, gewinnt das niedrigste. Eine gesenkte Grenze verhindert nur neue Starts.`}
      />
      <form onSubmit={submit} aria-label="Limits bearbeiten" className="limits-form">
        <SettingsSection title="Ausführung" explanation="Wie viele Läufe und Downloads gleichzeitig arbeiten dürfen und wie viel Datenmenge dabei fließt. Leer heißt: kein Limit. 0 heißt: nichts startet.">
          {notEnforced('downloads', DOWNLOAD_FIELDS)}
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

        <SettingsSection title="Gleichzeitige Arbeit" explanation="Wie viel Arbeit Kura auf einmal erledigt.">
          {notEnforced('workers', WORKER_FIELDS)}
          <div className="form-grid">{WORKER_FIELDS.map((field) => input(field, 'workers'))}</div>
        </SettingsSection>

        <SettingsSection title="Aufbewahrung" explanation="Wie lange beendete Läufe im Verlauf bleiben. Heruntergeladene Dateien sind davon nicht betroffen.">
          <div className="form-grid">
            {input({ key: 'finishedRunDays', label: 'Beendete Läufe aufbewahren', unit: 'Tage', hint: 'Von 1 bis 3650 Tagen.', min: 1 }, 'retention')}
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
        {/* Sticky at the bottom, only while there is something to save (or the saved version is out of date). */}
        {(dirty || stale) && (
          <div className="dirty-bar" role="region" aria-label="Änderungen">
            <span className="dirty-bar-text">{stale ? 'Die gespeicherte Version hat sich geändert.' : 'Nicht gespeicherte Änderungen'}</span>
            <div className="form-actions">
              {stale && <Button icon={ArrowsClockwise} onClick={() => void load()}>Aktuelle Version laden</Button>}
              <Button variant="primary" type="submit" icon={FloppyDisk}>Limits speichern</Button>
              {dirty && !stale && <Button onClick={() => void load()}>Verwerfen</Button>}
            </div>
          </div>
        )}
      </form>
    </>
  );
}
