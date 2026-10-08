/**
 * Wall-clock <-> UTC conversion for IANA time zones, built on Intl only (no dependency).
 *
 * A "naive local time" is a wall-clock reading without zone, represented as the UTC
 * milliseconds of the same digits (e.g. 2026-03-29 02:30 local -> Date.UTC(2026, 2, 29, 2, 30)).
 * Naive times are monotonic and free of DST jumps, which makes calendar iteration simple.
 */

const SECOND_MS = 1000;
const DAY_MS = 86_400_000;

export class InvalidTimeZoneError extends Error {
  constructor(timeZone: string) {
    super(`Not a valid IANA time zone: ${timeZone}`);
    this.name = 'InvalidTimeZoneError';
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Accepts IANA names only. Offset forms such as "+01:00" or "UTC+1" are rejected (plan 04, section 5). */
export function assertValidTimeZone(timeZone: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(timeZone)) throw new InvalidTimeZoneError(timeZone);
  try {
    formatterFor(timeZone);
  } catch {
    throw new InvalidTimeZoneError(timeZone);
  }
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric'
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Offset of the zone from UTC at an instant, in milliseconds (positive = east of UTC). */
export function utcOffsetMs(timeZone: string, instantMs: number): number {
  const flooredMs = Math.floor(instantMs / SECOND_MS) * SECOND_MS;
  return naiveLocalMs(timeZone, flooredMs) - flooredMs;
}

/** Wall-clock reading of an instant in the zone, as naive local milliseconds. */
export function naiveLocalMs(timeZone: string, instantMs: number): number {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  // Some ICU versions render midnight as hour 24 even with h23.
  const hour = parts.hour === 24 ? 0 : parts.hour;
  return Date.UTC(parts.year, parts.month - 1, parts.day, hour, parts.minute, parts.second);
}

export type LocalResolution =
  | { kind: 'unique'; instantMs: number }
  /** The wall-clock time occurs twice (clocks went back). first = earlier instant. */
  | { kind: 'overlap'; firstMs: number; secondMs: number }
  /** The wall-clock time does not exist (clocks went forward). transitionMs = first valid instant after the gap. */
  | { kind: 'gap'; transitionMs: number };

/**
 * Resolves a naive local time to UTC instants.
 * Assumes at most one offset transition within +-24 h of the wall-clock time, which holds
 * for every zone in the tz database.
 */
export function resolveLocalTime(timeZone: string, naiveMs: number): LocalResolution {
  const candidateOffsets = new Set([
    utcOffsetMs(timeZone, naiveMs - DAY_MS),
    utcOffsetMs(timeZone, naiveMs + DAY_MS)
  ]);

  const validInstants: number[] = [];
  for (const offset of candidateOffsets) {
    const instantMs = naiveMs - offset;
    if (utcOffsetMs(timeZone, instantMs) === offset) validInstants.push(instantMs);
  }
  validInstants.sort((a, b) => a - b);

  if (validInstants.length === 1) return { kind: 'unique', instantMs: validInstants[0] };
  if (validInstants.length === 2) return { kind: 'overlap', firstMs: validInstants[0], secondMs: validInstants[1] };
  return { kind: 'gap', transitionMs: findTransitionMs(timeZone, naiveMs) };
}

/** Binary search (1 s resolution) for the instant where the offset changes around a naive time. */
function findTransitionMs(timeZone: string, naiveMs: number): number {
  let low = naiveMs - 36 * 3_600_000;
  let high = naiveMs + 36 * 3_600_000;
  const offsetBefore = utcOffsetMs(timeZone, low);
  while (high - low > SECOND_MS) {
    const middle = Math.floor((low + high) / 2 / SECOND_MS) * SECOND_MS;
    if (utcOffsetMs(timeZone, middle) === offsetBefore) low = middle;
    else high = middle;
  }
  return high;
}

export function formatLocalPlanTime(naiveMs: number): string {
  return new Date(naiveMs).toISOString().slice(0, 16);
}
