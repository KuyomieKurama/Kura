import { MagnifyingGlass, PencilSimple, Pause, Play, Trash } from '@phosphor-icons/react';
import { useState } from 'react';
import { api, thumbnailUrl, type Subscription } from './api.js';
import { errorMessage } from './error-message.js';
import { labels } from './labels.js';
import { SubscriptionForm } from './SubscriptionForm.js';
import { SourceValidationView } from './SourceCheck.js';
import { useRunAssets } from './useRunAssets.js';
import { Banner } from './ui/Banner.js';
import { Button } from './ui/Button.js';
import { Dialog } from './ui/Dialog.js';
import type { MenuItem } from './ui/Menu.js';
import { PlatformSeal } from './ui/PlatformSeal.js';
import { ProgressBar } from './ui/ProgressBar.js';
import { useToast } from './ui/Toast.js';
import type { SourceValidation } from './api.js';

export const subscriptionRoute = (id: string) => `#/abonnements/${id}`;

/** The platform of a subscription as the plain word: the detected one, else the hint the user gave. */
export function platformOf(subscription: Pick<Subscription, 'platform' | 'platformHint'>): string | null {
  return subscription.platform ?? subscription.platformHint ?? null;
}

/** The address without scheme and "www.", for reading in a row. */
export function shortAddress(url: string | null): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname === '/' ? '' : parsed.pathname}`.replace(/\/$/, '');
  } catch {
    return url;
  }
}

/** The cover of a subscription: the preview of its newest file, else a quiet tinted area with the seal. */
export function Cover({ subscription, size }: { subscription: Subscription; size: number }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size };
  if (subscription.coverAssetId && !broken) {
    return <img className="cover" style={style} src={thumbnailUrl(subscription.coverAssetId, 480)} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />;
  }
  return <span className="cover cover-empty" style={style} aria-hidden="true"><PlatformSeal platform={platformOf(subscription)} /></span>;
}

/** "3 von 5 geladen" and a 4px bar for a running run, one line. The numbers and the bar come from the same counts. */
export function RunProgress({ runId, width = 120 }: { runId: string; width?: number }) {
  const { data } = useRunAssets(runId);
  if (!data || !data.active) return null;
  const total = data.counts.stored + data.counts.failed + data.counts.pending + data.counts.downloading + data.counts.verifying;
  if (total === 0) return <span className="accent-text">Wird vorbereitet</span>;
  const done = data.counts.stored + data.counts.failed;
  return (
    <span className="run-progress">
      <span className="accent-text num">{`${done} von ${total} geladen`}</span>
      <ProgressBar value={done} max={total} label="Fortschritt des Laufs" width={width} />
    </span>
  );
}

/**
 * Everything one can do with a subscription, shared by the row and the detail page: the actions, their dialogs
 * (edit, delete with the name of the object) and their messages. `onChanged` reloads the data, `onDeleted` leaves the page.
 */
export type QueuedRuns = { runs: Record<string, string>; remember: (subscriptionId: string, runId: string) => void };

export function useSubscriptionActions(subscription: Subscription, onChanged: () => Promise<void> | void, onDeleted: () => void, queued: QueuedRuns) {
  const toast = useToast();
  const [dialog, setDialog] = useState<'edit' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const [validation, setValidation] = useState<SourceValidation | null>(null);
  const [busy, setBusy] = useState(false);
  const paused = subscription.status === 'paused';

  async function attempt(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
      setError('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const runNow = () => attempt(async () => {
    const result = await api.runSubscriptionNow(subscription.id);
    queued.remember(subscription.id, result.run.id);
    toast({
      message: result.coalesced
        ? `Für „${subscription.name}“ gibt es schon einen offenen Lauf. Es wird kein zweiter angelegt.`
        : `Lauf für „${subscription.name}“ eingereiht.`
    });
    await onChanged();
  });
  const togglePause = () => attempt(async () => {
    if (paused) await api.resumeSubscription(subscription.id);
    else await api.pauseSubscription(subscription.id);
    toast({ message: paused ? `„${subscription.name}“ läuft wieder.` : `„${subscription.name}“ ist pausiert.` });
    await onChanged();
  });
  const check = () => attempt(async () => {
    const result = await api.validateSubscription(subscription.id);
    setValidation(result.validation);
    await onChanged();
  });
  const remove = () => attempt(async () => {
    await api.deleteSubscription(subscription.id);
    setDialog(null);
    toast({ message: `„${subscription.name}“ wurde gelöscht. Heruntergeladene Medien bleiben erhalten.` });
    onDeleted();
  });

  const menuItems: MenuItem[] = [
    { label: 'Adresse prüfen', icon: MagnifyingGlass, onSelect: () => void check() },
    { label: 'Bearbeiten', icon: PencilSimple, onSelect: () => setDialog('edit') },
    paused
      ? { label: 'Fortsetzen', icon: Play, onSelect: () => void togglePause() }
      : { label: 'Pausieren', icon: Pause, onSelect: () => void togglePause() },
    { label: 'Abonnement löschen', icon: Trash, tone: 'danger', separatorBefore: true, onSelect: () => setDialog('delete') }
  ];

  // A run that is already active cannot be started a second time: the button says why instead of vanishing.
  const running = Boolean(subscription.activeRunId);
  const primary: { label: string; icon: typeof Play; run: () => Promise<void>; disabled: boolean; hint?: string } = paused
    ? { label: 'Fortsetzen', icon: Play, run: togglePause, disabled: busy }
    : { label: 'Jetzt ausführen', icon: Play, run: runNow, disabled: busy || running, ...(running ? { hint: 'Es läuft bereits ein Lauf' } : {}) };

  const dialogs = (
    <>
      {dialog === 'edit' && (
        <Dialog title="Abonnement bearbeiten" close={() => setDialog(null)}>
          <SubscriptionForm subscription={subscription} onSaved={() => { setDialog(null); void onChanged(); }} onCancel={() => setDialog(null)} />
        </Dialog>
      )}
      {dialog === 'delete' && (
        <Dialog title={`„${subscription.name}“ löschen?`} close={() => setDialog(null)}>
          <p>Die Zeitpläne und der Laufverlauf werden mitgelöscht. Heruntergeladene Medien bleiben unberührt.</p>
          {error && <Banner tone="danger">{error}</Banner>}
          <div className="form-actions">
            <Button variant="danger-solid" icon={Trash} disabled={busy} onClick={() => void remove()}>Abonnement löschen</Button>
            <Button data-autofocus onClick={() => setDialog(null)}>{labels.cancel}</Button>
          </div>
        </Dialog>
      )}
    </>
  );
  const messages = (
    <>
      {error && dialog !== 'delete' && <Banner tone="danger">{error}</Banner>}
      {validation && <SourceValidationView result={validation} />}
    </>
  );
  const hasMessages = Boolean((error && dialog !== 'delete') || validation);
  const liveRunId = subscription.activeRunId ?? queued.runs[subscription.id] ?? null;
  return { menuItems, primary, dialogs, messages, hasMessages, liveRunId, paused, busy };
}
