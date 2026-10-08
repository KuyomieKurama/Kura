export type CronPreset = 'daily' | 'weekdays' | 'weekly' | 'hourly' | 'custom';

export const WEEKDAYS = [
  { value: '1', label: 'Montag' },
  { value: '2', label: 'Dienstag' },
  { value: '3', label: 'Mittwoch' },
  { value: '4', label: 'Donnerstag' },
  { value: '5', label: 'Freitag' },
  { value: '6', label: 'Samstag' },
  { value: '0', label: 'Sonntag' }
] as const;

export type PresetInput = { time: string; weekday: string; minute: string };

/** Builds a five-field cron expression from the simple choices. Returns null while the input is incomplete. */
export function cronFromPreset(preset: Exclude<CronPreset, 'custom'>, input: PresetInput): string | null {
  if (preset === 'hourly') {
    const minute = Number(input.minute);
    return Number.isInteger(minute) && minute >= 0 && minute <= 59 ? `${minute} * * * *` : null;
  }
  const match = /^(\d{2}):(\d{2})$/.exec(input.time);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  if (preset === 'daily') return `${minute} ${hour} * * *`;
  if (preset === 'weekdays') return `${minute} ${hour} * * 1-5`;
  return /^[0-6]$/.test(input.weekday) ? `${minute} ${hour} * * ${input.weekday}` : null;
}

export const COMMON_TIME_ZONES = ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'UTC'];

/** All IANA zones known to the browser, with the common ones first. */
export function timeZoneOptions(): string[] {
  const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const rest = supported.filter((zone) => !COMMON_TIME_ZONES.includes(zone));
  return [...COMMON_TIME_ZONES, ...rest];
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const INTERVAL_UNITS = { minutes: 60, hours: 3600, days: 86_400 } as const;
export type IntervalUnit = keyof typeof INTERVAL_UNITS;

export function intervalSeconds(amount: number, unit: IntervalUnit): number {
  return amount * INTERVAL_UNITS[unit];
}

/** Largest unit that divides the interval evenly, so that an edited rule shows 2 hours and not 120 minutes. */
export function splitInterval(seconds: number): { amount: number; unit: IntervalUnit } {
  if (seconds % INTERVAL_UNITS.days === 0) return { amount: seconds / INTERVAL_UNITS.days, unit: 'days' };
  if (seconds % INTERVAL_UNITS.hours === 0) return { amount: seconds / INTERVAL_UNITS.hours, unit: 'hours' };
  return { amount: Math.max(1, Math.round(seconds / INTERVAL_UNITS.minutes)), unit: 'minutes' };
}
