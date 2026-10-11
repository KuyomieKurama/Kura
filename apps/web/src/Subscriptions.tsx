import { ArrowsClockwise, DotsThree, Plus } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { AdaptersPanel } from './Adapters.js';
import { api, type Subscription } from './api.js';
import { runResult } from './Dashboard.js';
import { errorMessage } from './error-message.js';
import { labels } from './labels.js';
import { SubscriptionDetail } from './SubscriptionDetail.js';
import { SubscriptionForm } from './SubscriptionForm.js';
import { Cover, platformOf, type QueuedRuns, RunProgress, shortAddress, subscriptionRoute, useSubscriptionActions } from './SubscriptionParts.js';
import { Banner } from './ui/Banner.js';
import { Button } from './ui/Button.js';
import { Chip } from './ui/Chip.js';
import { Dialog } from './ui/Dialog.js';
import { EmptyState } from './ui/EmptyState.js';
import { Menu } from './ui/Menu.js';
import { PageHeader } from './ui/PageHeader.js';
import { platformName } from './ui/PlatformSeal.js';
import { RelativeTime } from './ui/RelativeTime.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { StatusChip } from './ui/StatusChip.js';
import { Warning, PauseCircle } from '@phosphor-icons/react';

const LIST_ROUTE = '#/abonnements';
const ACTIVE_REFRESH_MS = 5000;

function routeSubscriptionId(): string | null {
  const match = /^#\/abonnements\/([^/?#]+)/.exec(window.location.hash);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/** The subscription shown in the detail view, kept in the address (#/abonnements/<id>) so that "back" works. */
function useDetailRoute(): [string | null, (id: string | null) => void] {
  const [id, setId] = useState<string | null>(routeSubscriptionId);
  useEffect(() => {
    const sync = () => setId(routeSubscriptionId());
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);
  const go = useCallback((next: string | null) => {
    window.location.hash = next ? subscriptionRoute(next) : LIST_ROUTE;
    setId(next);
    window.scrollTo?.({ top: 0 });
  }, []);
  return [id, go];
}

function lastRunCell(subscription: Subscription) {
  const run = subscription.lastRun;
  if (!run) return <span className="muted">Noch nicht gelaufen</span>;
  const result = runResult({ state: run.state, assetsStored: run.assetsStored, assetsFailed: run.assetsFailed });
  return (
    <>
      <span><RelativeTime value={run.finishedAt} capitalize /></span>
      {result.tone === 'plain'
        ? <span className="muted">{result.text}</span>
        : <span className={`tone-${result.tone}`}><Warning size={14} aria-hidden="true" className="inline-glyph" />{result.text}</span>}
    </>
  );
}

function SubscriptionRow({ subscription, reload, onOpen, queued }: { subscription: Subscription; reload: () => Promise<void>; onOpen: () => void; queued: QueuedRuns }) {
  const actions = useSubscriptionActions(subscription, reload, () => void reload(), queued);
  const platform = platformOf(subscription);
  const paused = actions.paused;
  return (
    <article className="sub-row" aria-label={`Abonnement ${subscription.name}`}>
      <button type="button" className="sub-open" onClick={onOpen} aria-label={`${subscription.name} öffnen`}>
        <Cover subscription={subscription} size={64} />
        <span className="sub-name">
          <span className="sub-title truncate" title={subscription.name}>{subscription.name}</span>
          <span className="meta truncate" title={subscription.targetUrl ?? undefined}>
            {platformName(platform)}{subscription.targetUrl ? `, ${shortAddress(subscription.targetUrl)}` : ''}
          </span>
          {paused && <Chip tone="neutral" icon={PauseCircle}>Pausiert</Chip>}
          {subscription.targetState === 'invalid' && <StatusChip domain="target" status="invalid" />}
        </span>
      </button>
      <div className="sub-cell sub-last">
        {lastRunCell(subscription)}
        {actions.liveRunId && <RunProgress runId={actions.liveRunId} />}
      </div>
      <div className="sub-cell sub-next">
        {paused ? <span className="muted">Kein Lauf geplant</span> : subscription.nextRunAt ? <RelativeTime value={subscription.nextRunAt} capitalize /> : <span className="muted">Kein Zeitplan</span>}
      </div>
      <div className="sub-cell sub-count num">{subscription.mediaCount?.all ?? 0}</div>
      <div className="sub-actions">
        <Button variant="secondary" icon={actions.primary.icon} disabled={actions.primary.disabled} title={actions.primary.hint} onClick={() => void actions.primary.run()}>
          {actions.primary.label}
        </Button>
        <Menu label={`Weitere Aktionen für ${subscription.name}`} trigger={<DotsThree size={20} weight="bold" aria-hidden="true" />} items={actions.menuItems} />
      </div>
      {actions.hasMessages && <div className="sub-messages">{actions.messages}</div>}
      {actions.dialogs}
    </article>
  );
}

export function SubscriptionsPage({ isAdmin = false, onOpenHistory }: { isAdmin?: boolean; onOpenHistory?: () => void }) {
  const [subscriptions, setSubscriptions] = useState<Subscription[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [detailId, go] = useDetailRoute();
  const [queuedRuns, setQueuedRuns] = useState<Record<string, string>>({});
  const queued: QueuedRuns = {
    runs: queuedRuns,
    remember: (subscriptionId, runId) => setQueuedRuns((current) => ({ ...current, [subscriptionId]: runId }))
  };

  const reload = useCallback(async () => {
    try {
      setSubscriptions((await api.subscriptions()).subscriptions);
      setError('');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  // While a run is active the list is read again, so the progress and the result appear without a click.
  const anyActive = subscriptions?.some((subscription) => subscription.activeRunId) ?? false;
  useEffect(() => {
    if (!anyActive) return undefined;
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void reload(); }, ACTIVE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [anyActive, reload]);

  const detail = detailId ? subscriptions?.find((subscription) => subscription.id === detailId) : undefined;
  if (detailId && subscriptions !== null && !detail) {
    return (
      <>
        <PageHeader title={labels.subscriptions} />
        <EmptyState
          title="Dieses Abonnement gibt es nicht mehr."
          hint="Es wurde gelöscht oder der Link ist nicht richtig."
          action={<Button onClick={() => go(null)}>Zu allen Abonnements</Button>}
        />
      </>
    );
  }
  if (detailId && detail) {
    return <SubscriptionDetail subscription={detail} queued={queued} reload={reload} onBack={() => { go(null); void reload(); }} onOpenHistory={() => onOpenHistory?.()} />;
  }

  const createButton = <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Abonnement anlegen</Button>;
  const count = subscriptions?.length ?? 0;

  return (
    <>
      <PageHeader
        title={labels.subscriptions}
        lead="Kura beobachtet diese Quellen und lädt neue Beiträge automatisch."
        actions={count > 0 ? createButton : undefined}
      />
      {error && (
        <Banner tone="danger" action={<Button icon={ArrowsClockwise} onClick={() => void reload()}>Erneut laden</Button>}>
          <strong>Die Abonnements konnten nicht geladen werden.</strong> Prüfe die Verbindung und versuche es erneut. {error}
        </Banner>
      )}
      {creating && (
        <Dialog title="Abonnement anlegen" close={() => setCreating(false)}>
          <SubscriptionForm onSaved={() => { setCreating(false); void reload(); }} onCancel={() => setCreating(false)} />
        </Dialog>
      )}
      {subscriptions === null
        ? (!error && <SkeletonRows count={3} tall />)
        : count === 0
          ? <EmptyState title="Noch keine Abonnements." hint="Lege dein erstes Abonnement an. Kura holt neue Beiträge dann automatisch." action={createButton} />
          : (
            <div className="sub-list">
              <div className="sub-head" aria-hidden="true">
                <span>Abonnement</span><span>Letzter Lauf</span><span>Nächster Lauf</span><span className="sub-count">Medien</span><span />
              </div>
              {subscriptions.map((subscription) => (
                <SubscriptionRow key={subscription.id} subscription={subscription} reload={reload} onOpen={() => go(subscription.id)} queued={queued} />
              ))}
            </div>
          )}
      <AdaptersPanel isAdmin={isAdmin} />
    </>
  );
}
