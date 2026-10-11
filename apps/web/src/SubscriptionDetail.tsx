import { CaretLeft, DotsThree, PencilSimple, Plus, Trash } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { api, type Schedule, type Subscription, type SubscriptionRun, type SyncState } from './api.js';
import { errorMessage } from './error-message.js';
import { labels } from './labels.js';
import { RunLive } from './RunLive.js';
import { ScheduleForm } from './ScheduleForm.js';
import { describeRule, formatInstant } from './schedule-format.js';
import { platformOf, shortAddress, useSubscriptionActions } from './SubscriptionParts.js';
import { SubscriptionMedia } from './SubscriptionMedia.js';
import { Banner } from './ui/Banner.js';
import { Button } from './ui/Button.js';
import { Dialog } from './ui/Dialog.js';
import { Menu } from './ui/Menu.js';
import { PlatformSeal, platformName } from './ui/PlatformSeal.js';
import { RelativeTime } from './ui/RelativeTime.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { StatusChip } from './ui/StatusChip.js';
import { Switch } from './ui/Switch.js';
import { Tabs } from './ui/Tabs.js';
import { useToast } from './ui/Toast.js';

type Tab = 'media' | 'schedules' | 'runs';

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One sentence instead of tiles: how much there is, when it last ran, when it runs next. */
function Summary({ subscription }: { subscription: Subscription }) {
  const count = subscription.mediaCount;
  const kinds = count
    ? [count.image > 0 ? plural(count.image, 'Bild', 'Bilder') : '', count.video > 0 ? plural(count.video, 'Video', 'Videos') : ''].filter(Boolean)
    : [];
  const amount = !count ? '' : count.all === 0 ? 'Noch keine Medien' : `${plural(count.all, 'Medium', 'Medien')}${kinds.length > 0 ? `, ${kinds.join(' und ')}` : ''}`;
  const last = subscription.lastRun?.finishedAt;
  return (
    <p className="page-lead">
      {amount}
      {last && <>{amount ? '. ' : ''}Letzter Lauf <RelativeTime value={last} /></>}
      {subscription.status === 'paused'
        ? `${amount || last ? '. ' : ''}Pausiert, es werden keine neuen Läufe angelegt.`
        : subscription.nextRunAt
          ? <>{amount || last ? ', ' : ''}nächster <RelativeTime value={subscription.nextRunAt} />.</>
          : `${amount || last ? '. ' : ''}Kein Zeitplan, das Abonnement läuft nicht von selbst.`}
    </p>
  );
}

function ScheduleRow({ schedule, subscriptionId, reload }: { schedule: Schedule; subscriptionId: string; reload: () => Promise<void> }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function change(action: () => Promise<unknown>) {
    setPending(true);
    try {
      await action();
      setError('');
      await reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  if (editing) {
    return <ScheduleForm subscriptionId={subscriptionId} schedule={schedule} onSaved={() => { setEditing(false); void reload(); }} onCancel={() => setEditing(false)} />;
  }
  return (
    <div className="schedule-row">
      <div className="schedule-text">
        <strong>{describeRule(schedule.rule)}</strong>
        {schedule.enabled && schedule.nextDueAt && (
          <span className="meta">
            {`Nächster Lauf ${formatInstant(schedule.nextDueAt, schedule.rule.timeZone)} (${schedule.rule.timeZone})`}
            {schedule.jitterMaxSeconds > 0 ? `, Startverzögerung bis ${schedule.jitterMaxSeconds} s` : ''}
          </span>
        )}
        {!schedule.enabled && <span className="meta">Ausgeschaltet, es startet kein Lauf.</span>}
        {error && <Banner tone="danger">{error}</Banner>}
      </div>
      <div className="row-actions">
        <Switch label="Aktiv" checked={schedule.enabled} pending={pending} onChange={(next) => void change(() => api.updateSchedule(schedule.id, { enabled: next }))} />
        <Menu
          label={`Weitere Aktionen für den Zeitplan ${describeRule(schedule.rule)}`}
          trigger={<DotsThree size={20} weight="bold" aria-hidden="true" />}
          items={[
            { label: 'Bearbeiten', icon: PencilSimple, onSelect: () => setEditing(true) },
            { label: 'Zeitplan löschen', icon: Trash, tone: 'danger', separatorBefore: true, onSelect: () => setConfirming(true) }
          ]}
        />
      </div>
      {confirming && (
        <Dialog title={`${describeRule(schedule.rule)} löschen?`} close={() => setConfirming(false)}>
          <p>Der Zeitplan wird entfernt. Das Abonnement und seine Medien bleiben bestehen.</p>
          <div className="form-actions">
            <Button
              variant="danger-solid"
              icon={Trash}
              onClick={() => void change(async () => { await api.deleteSchedule(schedule.id); setConfirming(false); toast({ message: 'Zeitplan gelöscht.' }); })}
            >
              Zeitplan löschen
            </Button>
            <Button data-autofocus onClick={() => setConfirming(false)}>{labels.cancel}</Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function SchedulesTab({ subscription, reload }: { subscription: Subscription; reload: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const schedules = subscription.schedules ?? [];
  return (
    <section aria-label="Zeitpläne" className="tab-section">
      {schedules.length === 0 && !adding && <p className="muted">Kein Zeitplan: Dieses Abonnement läuft nie von selbst.</p>}
      {schedules.length > 0 && (
        <ul className="plain-list">
          {schedules.map((schedule) => (
            <li key={schedule.id}><ScheduleRow schedule={schedule} subscriptionId={subscription.id} reload={reload} /></li>
          ))}
        </ul>
      )}
      {adding
        ? <ScheduleForm subscriptionId={subscription.id} onSaved={() => { setAdding(false); void reload(); }} onCancel={() => setAdding(false)} />
        : <div><Button icon={Plus} onClick={() => setAdding(true)}>Zeitplan hinzufügen</Button></div>}
    </section>
  );
}

function RunsTab({ subscription, onOpenHistory }: { subscription: Subscription; onOpenHistory: () => void }) {
  const [runs, setRuns] = useState<SubscriptionRun[] | null>(null);
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api.subscriptionRuns(subscription.id)
      .then((result) => { if (active) setRuns(result.runs.slice(0, 10)); })
      .catch((cause) => { if (active) setError(errorMessage(cause)); });
    api.syncState(subscription.id).then((result) => { if (active) setSyncState(result.syncState); }).catch(() => undefined);
    return () => { active = false; };
  }, [subscription.id, subscription.lastRun?.id]);

  return (
    <section aria-label="Letzte Läufe" className="tab-section">
      <p className="muted">
        {syncState?.checkedThrough
          ? `Bis ${formatInstant(syncState.checkedThrough, Intl.DateTimeFormat().resolvedOptions().timeZone)} erfolgreich geprüft.`
          : 'Noch nicht erfolgreich geprüft.'} Das ist kein Beleg für ein vollständiges Archiv.
      </p>
      {error ? <Banner tone="danger">{error}</Banner> : runs === null ? <SkeletonRows count={2} /> : runs.length === 0 ? <p className="muted">Noch keine Läufe.</p> : (
        <ul className="plain-list">
          {runs.map((run) => (
            <li key={run.id} className="list-row run-row">
              <span className="muted run-time"><RelativeTime value={run.finishedAt ?? run.scheduledFor} capitalize /></span>
              <span>{run.triggerKind === 'manual' ? 'Manuell' : 'Zeitplan'}</span>
              <span className="run-outcome">
                <StatusChip domain="run" status={run.state} />
                {run.lastError && <span className="meta">{run.lastError}</span>}
              </span>
              {run.attempts > 1 && <span className="meta">{`${run.attempts} von ${run.maxAttempts} Versuchen`}</span>}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="text-link" onClick={onOpenHistory}>Alles im Verlauf</button>
    </section>
  );
}

/** The own view of one subscription: header with the one action, a sentence, the live run, and three tabs. */
export function SubscriptionDetail({ subscription, reload, onBack, onOpenHistory }: {
  subscription: Subscription;
  reload: () => Promise<void>;
  onBack: () => void;
  onOpenHistory: () => void;
}) {
  const [tab, setTab] = useState<Tab>('media');
  const [mediaReload, setMediaReload] = useState(0);
  const actions = useSubscriptionActions(subscription, reload, onBack);
  const platform = platformOf(subscription);
  const finished = useCallback(() => { setMediaReload((count) => count + 1); void reload(); }, [reload]);

  return (
    <>
      <a
        className="back-link"
        href="#/abonnements"
        onClick={(event) => { event.preventDefault(); onBack(); }}
      >
        <CaretLeft size={16} aria-hidden="true" />
        {labels.subscriptions}
      </a>
      <header className="detail-head">
        <div className="detail-title">
          <PlatformSeal platform={platform} size="lg" />
          <div className="detail-name">
            <h1 className="truncate" title={subscription.name}>{subscription.name}{actions.paused ? ' (pausiert)' : ''}</h1>
            {subscription.targetUrl && (
              <a className="mono address" href={subscription.targetUrl} target="_blank" rel="noreferrer noopener" title={`${platformName(platform)}: ${subscription.targetUrl}`}>
                {shortAddress(subscription.targetUrl)}
              </a>
            )}
          </div>
        </div>
        <div className="detail-actions">
          <Button variant="primary" icon={actions.primary.icon} disabled={actions.primary.disabled} onClick={() => void actions.primary.run()}>
            {actions.primary.label}
          </Button>
          <Menu label={`Weitere Aktionen für ${subscription.name}`} trigger={<DotsThree size={20} weight="bold" aria-hidden="true" />} items={actions.menuItems} />
        </div>
      </header>
      <Summary subscription={subscription} />
      {actions.messages}
      {subscription.activeRunId && (
        <RunLive key={subscription.activeRunId} runId={subscription.activeRunId} onFinished={finished} onShowMedia={() => setTab('media')} />
      )}
      <Tabs
        label="Bereiche des Abonnements"
        selected={tab}
        onSelect={(id) => setTab(id as Tab)}
        tabs={[
          { id: 'media', label: 'Medien', ...(subscription.mediaCount ? { count: subscription.mediaCount.all } : {}) },
          { id: 'schedules', label: 'Zeitpläne', count: (subscription.schedules ?? []).length },
          { id: 'runs', label: 'Läufe' }
        ]}
      >
        {tab === 'media' && <SubscriptionMedia subscriptionId={subscription.id} reloadKey={mediaReload} />}
        {tab === 'schedules' && <SchedulesTab subscription={subscription} reload={reload} />}
        {tab === 'runs' && <RunsTab subscription={subscription} onOpenHistory={onOpenHistory} />}
      </Tabs>
      {actions.dialogs}
    </>
  );
}
