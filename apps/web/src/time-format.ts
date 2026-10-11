/**
 * Time statements of the interface: relative up to 24 hours ("vor 3 Min.", "in 2 Std."), after that short and absolute
 * ("Mo., 12.10., 02:30") in the time zone of the user. The full absolute time goes into the title attribute.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function absoluteShort(date: Date, timeZone?: string): string {
  return date.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
}

/** "Mo., 12.10., 02:30", the year only when it is not the current one. No seconds: for stated times in lists and settings. */
export function absoluteMinute(value: string | Date, now: Date = new Date(), timeZone?: string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  const year = (day: Date) => day.toLocaleString('de-DE', { year: 'numeric', ...(timeZone ? { timeZone } : {}) });
  return date.toLocaleString('de-DE', {
    weekday: 'short', day: '2-digit', month: '2-digit', ...(year(date) === year(now) ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {})
  });
}

export function absoluteFull(date: Date, timeZone?: string): string {
  return date.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', ...(timeZone ? { timeZone } : {}) });
}

/** "Mo., 12.10.2026" style date for group headings. */
export function dayLabel(date: Date, now: Date = new Date()): string {
  const start = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((start(now) - start(date)) / DAY_MS);
  if (days === 0) return 'Heute';
  if (days === 1) return 'Gestern';
  return date.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}

/**
 * The text for a point in time. `detail` adds the minutes to hours ("in 2 Std. 10 Min."), as the lede of the overview does.
 */
export function relativeText(date: Date, now: Date = new Date(), options: { detail?: boolean; timeZone?: string } = {}): string {
  const diff = date.getTime() - now.getTime();
  const future = diff > 0;
  const absolute = Math.abs(diff);
  if (absolute >= DAY_MS) return absoluteShort(date, options.timeZone);
  const minutes = Math.floor(absolute / 60_000);
  const wrap = (text: string) => (future ? `in ${text}` : `vor ${text}`);
  if (minutes < 1) return future ? 'gleich' : 'gerade eben';
  if (minutes < 60) return wrap(`${minutes} Min.`);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return wrap(options.detail && rest > 0 ? `${hours} Std. ${rest} Min.` : `${hours} Std.`);
}

export function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** 48 -> "0:48", 3725 -> "1:02:05". */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}
