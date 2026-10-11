import type { PreviewEntry, ScheduleRule } from './api.js';
import { WEEKDAYS } from './cron-presets.js';

export const runStateLabels: Record<string, string> = {
  queued: 'Wartet auf Ausführung',
  leased: 'Läuft',
  retry_wait: 'Wiederholung geplant',
  succeeded: 'Erfolgreich',
  failed: 'Fehlgeschlagen',
  cancelled: 'Abgebrochen'
};

export const previewStatusLabels: Record<PreviewEntry['status'], string> = {
  regular: '',
  overlap_first: 'Uhrzeit kommt wegen der Zeitumstellung doppelt vor; es läuft nur das erste Auftreten',
  gap_shifted: 'Uhrzeit fehlt wegen der Zeitumstellung; Lauf direkt nach der Lücke',
  gap_skipped: 'entfällt: Die Uhrzeit existiert wegen der Zeitumstellung nicht',
  coalesced: 'entfällt: fällt mit einem anderen Termin zusammen'
};

export function formatInstant(iso: string, timeZone: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const year = (value: Date) => value.toLocaleString('de-DE', { year: 'numeric', timeZone });
  // "Mo., 12.10., 02:30": the year only when it is not the current one.
  return date.toLocaleString('de-DE', {
    weekday: 'short', day: '2-digit', month: '2-digit', ...(year(date) === year(now) ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit', timeZone
  });
}

/** "2026-03-29T02:30" -> "29.03.2026 02:30" (a wall-clock time without an instant). */
export function formatPlanTime(localPlanTime: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})$/.exec(localPlanTime);
  return match ? `${match[3]}.${match[2]}.${match[1]} ${match[4]}` : localPlanTime;
}

export function describePreviewEntry(entry: PreviewEntry): string {
  const note = previewStatusLabels[entry.status];
  const zone = `${entry.timeZone}, UTC${entry.utcOffset ?? ''}`;
  if (entry.scheduledForUtc) {
    const base = `${formatInstant(entry.scheduledForUtc, entry.timeZone)} (${zone})`;
    return note ? `${base}, ${note}` : base;
  }
  const planned = entry.localPlanTime ? formatPlanTime(entry.localPlanTime) : 'unbekannter Termin';
  return `${planned} (${entry.timeZone}), ${note}`;
}

function describeInterval(seconds: number): string {
  if (seconds % 86_400 === 0) return seconds === 86_400 ? 'Jeden Tag' : `Alle ${seconds / 86_400} Tage`;
  if (seconds % 3600 === 0) return seconds === 3600 ? 'Jede Stunde' : `Alle ${seconds / 3600} Stunden`;
  return seconds === 60 ? 'Jede Minute' : `Alle ${Math.round(seconds / 60)} Minuten`;
}

function describeCron(expression: string): string {
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(expression);
  const time = (hour: string, minute: string) => `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  if (daily) return `Täglich um ${time(daily[2], daily[1])} Uhr`;
  const weekdays = /^(\d{1,2}) (\d{1,2}) \* \* 1-5$/.exec(expression);
  if (weekdays) return `Montag bis Freitag um ${time(weekdays[2], weekdays[1])} Uhr`;
  const weekly = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/.exec(expression);
  if (weekly) return `Jeden ${WEEKDAYS.find((day) => day.value === weekly[3])?.label} um ${time(weekly[2], weekly[1])} Uhr`;
  const hourly = /^(\d{1,2}) \* \* \* \*$/.exec(expression);
  if (hourly) return `Stündlich zur Minute ${hourly[1]}`;
  return `Cron: ${expression}`;
}

export function describeRule(rule: ScheduleRule): string {
  if (rule.kind === 'interval') return `${describeInterval(rule.everySeconds)} (ab festem Ankerzeitpunkt)`;
  if (rule.kind === 'once') return `Einmalig am ${formatInstant(rule.atUtc, rule.timeZone)} (${rule.timeZone})`;
  const base = `${describeCron(rule.expression)} (${rule.timeZone})`;
  return rule.gapPolicy === 'run_after_gap' ? `${base}; fehlende Uhrzeit bei Zeitumstellung: nach der Lücke nachholen` : base;
}
