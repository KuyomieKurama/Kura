import { useEffect, useState } from 'react';
import { api, type RunAssets } from './api.js';
import { errorMessage } from './error-message.js';

export const RUN_POLL_MS = 3000;

/**
 * Polls the assets of a run while it is active. Polling stops with the first answer that says the run is over
 * and pauses while the tab is hidden; coming back to the tab fetches at once. No timer is left behind on unmount.
 */
export function useRunAssets(runId: string | null, intervalMs = RUN_POLL_MS): { data: RunAssets | null; error: string } {
  const [data, setData] = useState<RunAssets | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!runId) return undefined;
    let cancelled = false;
    let finished = false;
    let requesting = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      clearTimeout(timer);
      if (cancelled || finished || document.visibilityState === 'hidden') return;
      timer = setTimeout(() => void poll(), intervalMs);
    };
    const poll = async () => {
      if (cancelled || requesting) return;
      requesting = true;
      try {
        const result = await api.runAssets(runId);
        if (cancelled) return;
        setData(result);
        setError('');
        if (!result.active) finished = true;
      } catch (cause) {
        if (cancelled) return;
        setError(errorMessage(cause));
        // The run does not exist (for this user): asking again will not change that.
        if ((cause as { status?: number }).status === 404) finished = true;
      } finally {
        requesting = false;
        schedule();
      }
    };
    const onVisibilityChange = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'visible' && !finished) void poll();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [runId, intervalMs]);

  return { data, error };
}
