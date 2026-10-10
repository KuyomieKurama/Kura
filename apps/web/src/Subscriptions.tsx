import { ArrowsClockwise, CaretDown, CaretUp, FloppyDisk, Images, MagnifyingGlass, Pause, PauseCircle, PencilSimple, Play, Plus, Trash } from '@phosphor-icons/react';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { AdaptersPanel } from './Adapters.js';
import { api, type Schedule, type SourceValidation, type Subscription, type SubscriptionRun, type SyncState } from './api.js';
import { errorMessage } from './error-message.js';
import { labels } from './labels.js';
import { ScheduleForm } from './ScheduleForm.js';
import { describeRule, formatInstant, runStateLabels } from './schedule-format.js';
import { RunLive } from './RunLive.js';
import { SourceValidationView } from './SourceCheck.js';
import { SubscriptionMedia } from './SubscriptionMedia.js';
import { Banner } from './ui/Banner.js';
import { Button } from './ui/Button.js';
import { Chip } from './ui/Chip.js';
import { DataTable, type Column } from './ui/DataTable.js';
import { Dialog } from './ui/Dialog.js';
import { EmptyState } from './ui/EmptyState.js';
import { Field } from './ui/Field.js';
import { PageHeader } from './ui/PageHeader.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { StatusChip } from './ui/StatusChip.js';

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

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

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

  return (
    <form
      onSubmit={submit}
      aria-label={subscription ? 'Abonnement bearbeiten' : 'Abonnement anlegen'}
      className="panel form-panel form-grid"
    >
      <Field label="Name">
        {(control) => <input {...control} name="name" defaultValue={subscription?.name ?? ''} maxLength={200} required />}
      </Field>
      <Field label="Plattform (Hinweis)">
        {(control) => (
          <select {...control} name="platformHint" defaultValue={subscription?.platformHint ?? ''}>
            {PLATFORM_HINTS.map((hint) => <option key={hint.value} value={hint.value}>{hint.label}</option>)}
          </select>
        )}
      </Field>
      <Field
        label="Ziel-URL"
        wide
        hint="Die URL wird unverändert gespeichert. Mit „Adresse prüfen“ sehen Sie, welche Plattform erkannt wird und was der Adapter kann; es wird dabei nichts heruntergeladen."
      >
        {(control) => (
          <input {...control} name="targetUrl" ref={urlInput} defaultValue={subscription?.targetUrl ?? ''} maxLength={2048} required autoComplete="off" />
        )}
      </Field>
      <div className="form-wide">
        <Button icon={MagnifyingGlass} onClick={() => void check()}>Adresse prüfen</Button>
      </div>
      {validation && <div className="form-wide"><SourceValidationView result={validation} /></div>}
      {error && <div className="form-wide"><Banner tone="danger">{error}</Banner></div>}
      <div className="form-actions form-wide">
        <Button variant="primary" type="submit" icon={FloppyDisk}>{labels.save}</Button>
        <Button variant="ghost" onClick={onCancel}>{labels.cancel}</Button>
      </div>
    </form>
  );
}

function RunsTable({ runs }: { runs: SubscriptionRun[] }) {
  if (runs.length === 0) return <p>Noch keine Läufe.</p>;
  const columns: Column<SubscriptionRun>[] = [
    { key: 'scheduled', header: 'Geplant für', render: (run) => `${formatInstant(run.scheduledFor, 'UTC')} UTC`, date: true },
    { key: 'trigger', header: 'Auslöser', render: (run) => (run.triggerKind === 'manual' ? 'Manuell' : 'Zeitplan') },
    { key: 'state', header: 'Status', render: (run) => <StatusChip domain="run" status={run.state} /> },
    { key: 'attempts', header: 'Versuche', render: (run) => `${run.attempts} von ${run.maxAttempts}`, numeric: true },
    { key: 'note', header: 'Hinweis', render: (run) => run.lastError ?? '' }
  ];
  return <DataTable label="Läufe dieses Abonnements" columns={columns} rows={runs} rowKey={(run) => run.id} />;
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
  const finishEditing = async () => {
    setEditing(null);
    await reload();
  };

  return (
    <section className="detail-block" aria-label="Zeitpläne">
      <h4>Zeitpläne</h4>
      {schedules.length === 0 && <p>Kein Zeitplan: Dieses Abonnement läuft nie von selbst.</p>}
      {schedules.length > 0 && (
        <ul className="schedule-list">
          {schedules.map((schedule: Schedule) => (
            <li key={schedule.id}>
              {editing === schedule.id
                ? <ScheduleForm subscriptionId={subscription.id} schedule={schedule} onSaved={() => void finishEditing()} onCancel={() => setEditing(null)} />
                : (
                  <div className="schedule-row">
                    <div className="schedule-text">
                      <strong>{describeRule(schedule.rule)}</strong>
                      {!schedule.enabled && <Chip tone="neutral" icon={PauseCircle}>Ausgeschaltet</Chip>}
                      {schedule.enabled && schedule.nextDueAt && (
                        <span className="meta">{`Nächster Lauf: ${formatInstant(schedule.nextDueAt, schedule.rule.timeZone)} (${schedule.rule.timeZone})`}</span>
                      )}
                      {schedule.jitterMaxSeconds > 0 && <span className="meta">{`Startverzögerung bis ${schedule.jitterMaxSeconds} s`}</span>}
                    </div>
                    <div className="row-actions">
                      <Button variant="ghost" onClick={() => setEditing(schedule.id)}>Bearbeiten</Button>
                      <Button variant="ghost" onClick={() => void run(() => api.updateSchedule(schedule.id, { enabled: !schedule.enabled }))}>
                        {schedule.enabled ? 'Ausschalten' : 'Einschalten'}
                      </Button>
                      <Button variant="danger-ghost" onClick={() => void run(() => api.deleteSchedule(schedule.id))}>Zeitplan löschen</Button>
                    </div>
                  </div>
                )}
            </li>
          ))}
        </ul>
      )}
      {editing === 'new'
        ? <ScheduleForm subscriptionId={subscription.id} onSaved={() => void finishEditing()} onCancel={() => setEditing(null)} />
        : <div><Button icon={Plus} onClick={() => setEditing('new')}>Zeitplan hinzufügen</Button></div>}
      {notice && <Banner tone="danger">{notice}</Banner>}
    </section>
  );
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

  return (
    <div className="details">
      <p className="muted">
        {syncState?.checkedThrough
          ? `Bis ${formatInstant(syncState.checkedThrough, localZone())} erfolgreich geprüft.`
          : 'Noch nicht erfolgreich geprüft.'} Das ist kein Beleg für ein vollständiges Archiv.
      </p>
      <ScheduleList subscription={subscription} reload={reload} />
      <section className="detail-block" aria-label="Letzte Läufe">
        <h4>Letzte Läufe</h4>
        {error ? <Banner tone="danger">{error}</Banner> : runs ? <RunsTable runs={runs} /> : <SkeletonRows count={2} />}
      </section>
    </div>
  );
}

function SubscriptionRow({ subscription, reload }: { subscription: Subscription; reload: () => Promise<void> }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm-delete'>('view');
  const [open, setOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  // The run whose progress is shown live below the row, and a counter that makes the media section reload.
  const [liveRunId, setLiveRunId] = useState<string | null>(null);
  const [mediaReload, setMediaReload] = useState(0);
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
        ? `Es gibt bereits einen offenen Lauf (Status: ${runStateLabels[result.run.state] ?? result.run.state}); er startet frühestens ${formatInstant(result.run.runAfter, localZone())}. Es wird kein zweiter angelegt.`
        : 'Der Lauf wurde eingereiht. Den Fortschritt sehen Sie unten live; das Ergebnis bleibt unter „Verlauf“.');
      setLiveRunId(result.run.id);
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

  const platform = PLATFORM_HINTS.find((hint) => hint.value === (subscription.platformHint ?? ''))?.label ?? subscription.platformHint;

  return (
    <article aria-label={`Abonnement ${subscription.name}`} className="sub-row">
      {mode === 'edit'
        ? (
          <>
            <h3>{subscription.name}{paused && ' (pausiert)'}</h3>
            <SubscriptionForm subscription={subscription} onSaved={() => { setMode('view'); void reload(); }} onCancel={() => setMode('view')} />
          </>
        )
        : (
          <>
            <div className="sub-head">
              <div className="sub-main">
                <h3 className="truncate" title={subscription.name}>{subscription.name}{paused && ' (pausiert)'}</h3>
                <p className="meta truncate" title={subscription.targetUrl ?? undefined}>Ziel: {subscription.targetUrl}</p>
                <div className="sub-facts">
                  <p className="meta">Plattform: {platform}</p>
                  <p className="meta">
                    Prüfung: <span title={subscription.targetState === 'unvalidated' ? 'Mit „Adresse prüfen“ prüfen' : undefined}>
                      <StatusChip domain="target" status={subscription.targetState} />
                    </span>
                  </p>
                  <p className="meta">Status: {paused ? 'Pausiert: Es werden keine neuen Läufe angelegt.' : 'Aktiv'}</p>
                </div>
              </div>
              <div className="row-actions">
                <Button icon={Play} onClick={() => void runNow()} disabled={paused}>Jetzt ausführen</Button>
                <Button variant="ghost" icon={MagnifyingGlass} onClick={() => void check()}>Adresse prüfen</Button>
                <Button variant="ghost" icon={Images} onClick={() => setMediaOpen(!mediaOpen)} aria-expanded={mediaOpen}>Medien</Button>
                <Button variant="ghost" icon={open ? CaretUp : CaretDown} onClick={() => setOpen(!open)} aria-expanded={open}>
                  {open ? 'Details ausblenden' : 'Zeitpläne und Läufe'}
                </Button>
                <Button variant="ghost" icon={PencilSimple} onClick={() => setMode('edit')}>Bearbeiten</Button>
                <Button
                  variant="ghost"
                  icon={paused ? Play : Pause}
                  onClick={() => void run(() => paused ? api.resumeSubscription(subscription.id) : api.pauseSubscription(subscription.id))}
                >
                  {paused ? 'Fortsetzen' : 'Pausieren'}
                </Button>
                <Button variant="danger-ghost" icon={Trash} onClick={() => setMode('confirm-delete')}>Löschen</Button>
              </div>
            </div>
            {paused && <p className="meta">Beim Fortsetzen werden verpasste Termine aus der Pause nicht nachgeholt. Ein pausiertes Abonnement kann nicht ausgeführt werden.</p>}
            {validation && <SourceValidationView result={validation} />}
            {info && <Banner tone="info">{info}</Banner>}
            {liveRunId && (
              <RunLive
                key={liveRunId}
                runId={liveRunId}
                onFinished={() => setMediaReload((count) => count + 1)}
                onShowMedia={() => setMediaOpen(true)}
                onDismiss={() => setLiveRunId(null)}
              />
            )}
            {mediaOpen && <SubscriptionMedia subscriptionId={subscription.id} reloadKey={mediaReload} />}
          </>
        )}
      {mode === 'confirm-delete' && (
        <Dialog title="Abonnement löschen" close={() => setMode('view')}>
          <p>Abonnement „{subscription.name}“ mit allen Zeitplänen und dem Laufverlauf löschen? Heruntergeladene Medien bleiben unberührt.</p>
          <div className="form-actions">
            <Button variant="danger-solid" icon={Trash} onClick={() => void run(() => api.deleteSubscription(subscription.id))}>Endgültig löschen</Button>
            <Button onClick={() => setMode('view')}>{labels.cancel}</Button>
          </div>
        </Dialog>
      )}
      {notice && <Banner tone="danger">{notice}</Banner>}
      {open && mode !== 'edit' && <SubscriptionDetails subscription={subscription} reload={reload} />}
    </article>
  );
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

  const createButton = <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Abonnement anlegen</Button>;
  const hasSubscriptions = subscriptions !== null && subscriptions.length > 0;

  return (
    <>
      <PageHeader
        title={labels.subscriptions}
        lead="Ein Abonnement beobachtet ein Ziel wiederkehrend. Zeitpläne und „Jetzt ausführen“ legen Läufe an; ein Worker lädt den Beitrag herunter, speichert ihn und übergibt ihn an Immich, wenn Sie eine Verbindung eingerichtet haben. Das Ergebnis steht unter „Verlauf“."
        actions={hasSubscriptions && !creating ? createButton : undefined}
      />
      {error && (
        <Banner tone="danger">
          <p>{error}</p>
          <p>Prüfen Sie die Verbindung und laden Sie die Abonnements neu.</p>
          <Button icon={ArrowsClockwise} onClick={() => void reload()}>Erneut laden</Button>
        </Banner>
      )}
      {creating && <SubscriptionForm onSaved={() => { setCreating(false); void reload(); }} onCancel={() => setCreating(false)} />}
      {subscriptions === null
        ? (!error && <SkeletonRows count={3} tall />)
        : subscriptions.length === 0
          ? (!creating && <EmptyState title="Noch keine Abonnements." hint="Legen Sie Ihr erstes Abonnement an." action={createButton} />)
          : <div className="panel sub-list">{subscriptions.map((subscription) => <SubscriptionRow key={subscription.id} subscription={subscription} reload={reload} />)}</div>}
      <AdaptersPanel isAdmin={isAdmin} />
    </>
  );
}
