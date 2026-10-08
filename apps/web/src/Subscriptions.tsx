import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { AdaptersPanel } from './Adapters.js';
import { api, type Schedule, type SourceValidation, type Subscription, type SubscriptionRun, type SyncState } from './api.js';
import { ScheduleForm } from './ScheduleForm.js';
import { describeRule, formatInstant, runStateLabels } from './schedule-format.js';
import { SourceValidationView } from './SourceCheck.js';

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
  unvalidated: 'Noch nicht geprüft (mit „Adresse prüfen“ prüfen)',
  valid: 'Adresse erkannt und unterstützt',
  invalid: 'Adresse wird nicht unterstützt'
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
  const [validation, setValidation] = useState<SourceValidation | null>(null);
  const urlInput = useRef<HTMLInputElement>(null);

  async function check() {
    try {
      setValidation(await api.validateSource(urlInput.current?.value ?? ''));
      setError('');
    } catch (cause) {
      setValidation(null);
      setError(errorMessage(cause));
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input = {
      name: String(data.get('name') ?? ''),
      targetUrl: String(data.get('targetUrl') ?? ''),
      platformHint: String(data.get('platformHint') ?? '') || null
    };
    try {
      const saved = subscription ? await api.updateSubscription(subscription.id, input) : await api.createSubscription(input);
      // Records whether an adapter accepts the address; saving does not depend on it.
      await api.validateSubscription(saved.subscription.id).catch(() => undefined);
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return <form onSubmit={submit} aria-label={subscription ? 'Abonnement bearbeiten' : 'Abonnement anlegen'}>
    <label>Name<input name="name" defaultValue={subscription?.name ?? ''} maxLength={200} required /></label>
    <label>Ziel-URL<input name="targetUrl" ref={urlInput} defaultValue={subscription?.targetUrl ?? ''} maxLength={2048} required autoComplete="off" /></label>
    <p>Die URL wird unverändert gespeichert. Mit „Adresse prüfen“ sehen Sie, welche Plattform erkannt wird und was der Adapter kann; es wird dabei nichts heruntergeladen.</p>
    <button type="button" className="secondary" onClick={() => void check()}>Adresse prüfen</button>
    {validation && <SourceValidationView result={validation} />}
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
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    api.subscriptionRuns(subscription.id)
      .then((result) => { if (active) setRuns(result.runs); })
      .catch((cause) => { if (active) setError(errorMessage(cause)); });
    api.syncState(subscription.id)
      .then((result) => { if (active) setSyncState(result.syncState); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [subscription.id]);

  return <>
    <p>{syncState?.checkedThrough
      ? `Bis ${formatInstant(syncState.checkedThrough, Intl.DateTimeFormat().resolvedOptions().timeZone)} erfolgreich geprüft.`
      : 'Noch nicht erfolgreich geprüft.'} Das ist kein Beleg für ein vollständiges Archiv.</p>
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
  const [info, setInfo] = useState('');
  const [validation, setValidation] = useState<SourceValidation | null>(null);

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

  async function runNow() {
    try {
      const result = await api.runSubscriptionNow(subscription.id);
      setNotice('');
      setInfo(result.coalesced
        ? `Es gibt bereits einen offenen Lauf (Status: ${runStateLabels[result.run.state] ?? result.run.state}); er startet frühestens ${formatInstant(result.run.runAfter, Intl.DateTimeFormat().resolvedOptions().timeZone)}. Es wird kein zweiter angelegt.`
        : 'Der Lauf wurde eingereiht. Den Fortschritt sehen Sie unter „Verlauf“.');
      await reload();
    } catch (cause) {
      setInfo('');
      setNotice(errorMessage(cause));
    }
  }

  async function check() {
    try {
      const result = await api.validateSubscription(subscription.id);
      setValidation(result.validation);
      setNotice('');
      await reload();
    } catch (cause) {
      setNotice(errorMessage(cause));
    }
  }

  return <article aria-label={`Abonnement ${subscription.name}`}>
    <h3>{subscription.name}{paused && ' (pausiert)'}</h3>
    {mode === 'edit'
      ? <SubscriptionForm subscription={subscription} onSaved={() => { setMode('view'); void reload(); }} onCancel={() => setMode('view')} />
      : <>
        <p>Ziel: {subscription.targetUrl}</p>
        <p>Plattform: {PLATFORM_HINTS.find((hint) => hint.value === (subscription.platformHint ?? ''))?.label ?? subscription.platformHint} · Prüfung: {targetStateLabels[subscription.targetState]}</p>
        <p>Status: {paused ? 'Pausiert: Es werden keine neuen Läufe angelegt.' : 'Aktiv'}</p>
        <button type="button" onClick={() => void runNow()} disabled={paused}>Jetzt ausführen</button>
        <button type="button" className="secondary" onClick={() => void check()}>Adresse prüfen</button>
        <button type="button" className="secondary" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Details ausblenden' : 'Zeitpläne und Läufe'}</button>
        <button type="button" className="secondary" onClick={() => setMode('edit')}>Bearbeiten</button>
        <button type="button" className="secondary" onClick={() => void run(() => paused ? api.resumeSubscription(subscription.id) : api.pauseSubscription(subscription.id))}>
          {paused ? 'Fortsetzen' : 'Pausieren'}
        </button>
        <button type="button" className="secondary" onClick={() => setMode('confirm-delete')}>Löschen</button>
        {paused && <p>Beim Fortsetzen werden verpasste Termine aus der Pause nicht nachgeholt. Ein pausiertes Abonnement kann nicht ausgeführt werden.</p>}
        {validation && <SourceValidationView result={validation} />}
        {info && <p role="status">{info}</p>}
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

export function SubscriptionsPage({ isAdmin = false }: { isAdmin?: boolean }) {
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
    <p>Ein Abonnement beobachtet ein Ziel wiederkehrend. Zeitpläne und „Jetzt ausführen“ legen Läufe an; ein Worker lädt den Beitrag herunter, speichert ihn und übergibt ihn an Immich, wenn Sie eine Verbindung eingerichtet haben. Das Ergebnis steht unter „Verlauf“.</p>
    <AdaptersPanel isAdmin={isAdmin} />
    {error && <p className="form-error" role="alert">{error}</p>}
    {creating && <SubscriptionForm onSaved={() => { setCreating(false); void reload(); }} onCancel={() => setCreating(false)} />}
    {subscriptions === null ? <p>Wird abgerufen …</p>
      : subscriptions.length === 0 ? <p>Noch keine Abonnements.</p>
        : subscriptions.map((subscription) => <SubscriptionCard key={subscription.id} subscription={subscription} reload={reload} />)}
  </section>;
}
