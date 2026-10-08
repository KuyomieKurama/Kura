import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, type Schedule, type Subscription, type SubscriptionRun } from './api.js';
import { ScheduleForm } from './ScheduleForm.js';
import { describeRule, formatInstant, runStateLabels } from './schedule-format.js';

const PLATFORM_HINTS = [
  { value: '', label: 'Keine Angabe' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'patreon', label: 'Patreon' },
  { value: 'pixiv', label: 'Pixiv' },
  { value: 'pornhub', label: 'Pornhub' },
  { value: 'direct', label: 'Direkte Medien-URL' },
  { value: 'web', label: 'Allgemeine Webseite' }
];

const targetStateLabels = {
  unvalidated: 'Noch nicht geprüft (die Prüfung durch einen Adapter folgt)',
  valid: 'Geprüft',
  invalid: 'Ungültig'
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Die Anfrage konnte nicht verarbeitet werden.';
}

function SubscriptionForm({ subscription, onSaved, onCancel }: {
  subscription?: Subscription;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input = {
      name: String(data.get('name') ?? ''),
      targetUrl: String(data.get('targetUrl') ?? ''),
      platformHint: String(data.get('platformHint') ?? '') || null
    };
    try {
      if (subscription) await api.updateSubscription(subscription.id, input);
      else await api.createSubscription(input);
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return <form onSubmit={submit} aria-label={subscription ? 'Abonnement bearbeiten' : 'Abonnement anlegen'}>
    <label>Name<input name="name" defaultValue={subscription?.name ?? ''} maxLength={200} required /></label>
    <label>Ziel-URL<input name="targetUrl" defaultValue={subscription?.targetUrl ?? ''} maxLength={2048} required autoComplete="off" /></label>
    <p>Die URL wird unverändert gespeichert. Ob eine Plattform sie unterstützt, wird erst später geprüft.</p>
    <label>Plattform (Hinweis)
      <select name="platformHint" defaultValue={subscription?.platformHint ?? ''}>
        {PLATFORM_HINTS.map((hint) => <option key={hint.value} value={hint.value}>{hint.label}</option>)}
      </select>
    </label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button>Speichern</button>
    <button type="button" className="secondary" onClick={onCancel}>Abbrechen</button>
  </form>;
}

function RunsTable({ runs }: { runs: SubscriptionRun[] }) {
  if (runs.length === 0) return <p>Noch keine Läufe.</p>;
  return <div className="table-wrap"><table>
    <thead><tr><th>Geplant für</th><th>Auslöser</th><th>Status</th><th>Versuche</th><th>Hinweis</th></tr></thead>
    <tbody>{runs.map((run) => <tr key={run.id}>
      <td>{formatInstant(run.scheduledFor, 'UTC')} UTC</td>
      <td>{run.triggerKind === 'manual' ? 'Manuell' : 'Zeitplan'}</td>
      <td>{runStateLabels[run.state] ?? run.state}</td>
      <td>{run.attempts} von {run.maxAttempts}</td>
      <td>{run.lastError ?? ''}</td>
    </tr>)}</tbody>
  </table></div>;
}

function ScheduleList({ subscription, reload }: { subscription: Subscription; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [notice, setNotice] = useState('');
  const schedules = subscription.schedules ?? [];

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      setNotice('');
      await reload();
    } catch (cause) {
      setNotice(errorMessage(cause));
    }
  }
  const finishEditing = async () => { setEditing(null); await reload(); };

  return <section aria-label="Zeitpläne">
    <h4>Zeitpläne</h4>
    {schedules.length === 0 && <p>Kein Zeitplan: Dieses Abonnement läuft nie von selbst.</p>}
    <ul>{schedules.map((schedule: Schedule) => <li key={schedule.id}>
      {editing === schedule.id
        ? <ScheduleForm subscriptionId={subscription.id} schedule={schedule} onSaved={() => void finishEditing()} onCancel={() => setEditing(null)} />
        : <>
          <strong>{describeRule(schedule.rule)}</strong>{!schedule.enabled && ' – ausgeschaltet'}
          <br />
          {schedule.enabled && schedule.nextDueAt && `Nächster Lauf: ${formatInstant(schedule.nextDueAt, schedule.rule.timeZone)} (${schedule.rule.timeZone})`}
          {schedule.jitterMaxSeconds > 0 && ` · Startverzögerung bis ${schedule.jitterMaxSeconds} s`}
          <br />
          <button type="button" className="secondary" onClick={() => setEditing(schedule.id)}>Bearbeiten</button>
          <button type="button" className="secondary" onClick={() => void run(() => api.updateSchedule(schedule.id, { enabled: !schedule.enabled }))}>
            {schedule.enabled ? 'Ausschalten' : 'Einschalten'}
          </button>
          <button type="button" className="secondary" onClick={() => void run(() => api.deleteSchedule(schedule.id))}>Zeitplan löschen</button>
        </>}
    </li>)}</ul>
    {editing === 'new'
      ? <ScheduleForm subscriptionId={subscription.id} onSaved={() => void finishEditing()} onCancel={() => setEditing(null)} />
      : <button type="button" onClick={() => setEditing('new')}>Zeitplan hinzufügen</button>}
    {notice && <p className="form-error" role="alert">{notice}</p>}
  </section>;
}

function SubscriptionDetails({ subscription, reload }: { subscription: Subscription; reload: () => Promise<void> }) {
  const [runs, setRuns] = useState<SubscriptionRun[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    api.subscriptionRuns(subscription.id)
      .then((result) => { if (active) setRuns(result.runs); })
      .catch((cause) => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [subscription.id]);

  return <>
    <ScheduleList subscription={subscription} reload={reload} />
    <section aria-label="Letzte Läufe">
      <h4>Letzte Läufe</h4>
      {error ? <p className="form-error" role="alert">{error}</p> : runs ? <RunsTable runs={runs} /> : <p>Wird abgerufen …</p>}
    </section>
  </>;
}

function SubscriptionCard({ subscription, reload }: { subscription: Subscription; reload: () => Promise<void> }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm-delete'>('view');
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState('');

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      setNotice('');
      await reload();
    } catch (cause) {
      setNotice(errorMessage(cause));
    }
  }
  const paused = subscription.status === 'paused';

  return <article aria-label={`Abonnement ${subscription.name}`}>
    <h3>{subscription.name}{paused && ' (pausiert)'}</h3>
    {mode === 'edit'
      ? <SubscriptionForm subscription={subscription} onSaved={() => { setMode('view'); void reload(); }} onCancel={() => setMode('view')} />
      : <>
        <p>Ziel: {subscription.targetUrl}</p>
        <p>Plattform: {PLATFORM_HINTS.find((hint) => hint.value === (subscription.platformHint ?? ''))?.label ?? subscription.platformHint} · Prüfung: {targetStateLabels[subscription.targetState]}</p>
        <p>Status: {paused ? 'Pausiert: Es werden keine neuen Läufe angelegt.' : 'Aktiv'}</p>
        <button type="button" className="secondary" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Details ausblenden' : 'Zeitpläne und Läufe'}</button>
        <button type="button" className="secondary" onClick={() => setMode('edit')}>Bearbeiten</button>
        <button type="button" className="secondary" onClick={() => void run(() => paused ? api.resumeSubscription(subscription.id) : api.pauseSubscription(subscription.id))}>
          {paused ? 'Fortsetzen' : 'Pausieren'}
        </button>
        <button type="button" className="secondary" onClick={() => setMode('confirm-delete')}>Löschen</button>
        {paused && <p>Beim Fortsetzen werden verpasste Termine aus der Pause nicht nachgeholt.</p>}
      </>}
    {mode === 'confirm-delete' && <div role="alertdialog" aria-label="Abonnement löschen">
      <p>Abonnement „{subscription.name}“ mit allen Zeitplänen und dem Laufverlauf löschen? Heruntergeladene Medien bleiben unberührt.</p>
      <button type="button" onClick={() => void run(() => api.deleteSubscription(subscription.id))}>Endgültig löschen</button>
      <button type="button" className="secondary" onClick={() => setMode('view')}>Abbrechen</button>
    </div>}
    {notice && <p className="form-error" role="alert">{notice}</p>}
    {open && <SubscriptionDetails subscription={subscription} reload={reload} />}
  </article>;
}

export function SubscriptionsPage() {
  const [subscriptions, setSubscriptions] = useState<Subscription[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      setSubscriptions((await api.subscriptions()).subscriptions);
      setError('');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  return <section>
    <div className="section-header">
      <h2>Abonnements</h2>
      <button type="button" onClick={() => setCreating(true)}>Abonnement anlegen</button>
    </div>
    <p>Ein Abonnement beobachtet ein Ziel wiederkehrend. Zeitpläne legen nur Läufe an; das Herunterladen selbst folgt in einem späteren Schritt.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {creating && <SubscriptionForm onSaved={() => { setCreating(false); void reload(); }} onCancel={() => setCreating(false)} />}
    {subscriptions === null ? <p>Wird abgerufen …</p>
      : subscriptions.length === 0 ? <p>Noch keine Abonnements.</p>
        : subscriptions.map((subscription) => <SubscriptionCard key={subscription.id} subscription={subscription} reload={reload} />)}
  </section>;
}
