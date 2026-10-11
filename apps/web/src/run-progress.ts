/** The counts of a run as the server sends them (RunAssets.counts and Overview.activeRuns[].counts). */
export interface RunCounts { stored: number; failed: number; pending: number; downloading: number; verifying: number }

/**
 * The one source of progress for a running run: how many of its files are stored. The sentence, the percentage and the
 * bar all read these two numbers, so they never disagree. A failed file is not progress; it is said in its own count.
 */
export function runProgress(counts: RunCounts): { stored: number; total: number; percent: number } {
  const total = counts.stored + counts.failed + counts.pending + counts.downloading + counts.verifying;
  return { stored: counts.stored, total, percent: total > 0 ? Math.round((counts.stored / total) * 100) : 0 };
}
