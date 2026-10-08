import { cronMatchesDay, parseCron, type ParsedCron } from './cron.js';
import {
  assertValidTimeZone,
  formatLocalPlanTime,
  naiveLocalMs,
  resolveLocalTime,
  utcOffsetMs
} from './timezone.js';

/**
 * Schedule rules and the deterministic computation of logical due times (plan 04, section 5).
 *
 * DST behaviour of cron rules (wall-clock rules in the rule's IANA zone):
 *
 * - Gap (the local time does not exist, e.g. 02:30 on the spring-forward day):
 *     gapPolicy "skip" (default, as written in plan 04): that local occurrence is skipped and
 *       shown as skipped in the preview.
 *     gapPolicy "run_after_gap": the occurrence runs at the first valid instant after the gap
 *       (the transition instant). If several gap occurrences, or a regular occurrence, land on
 *       that same instant, only the earliest one runs ("coalesced").
 * - Overlap (the local time occurs twice, e.g. 02:30 on the fall-back day): the occurrence runs
 *   once, at its first appearance. The second appearance of the same local plan time is suppressed.
 *
 * Interval rules count elapsed time from an anchor in UTC and do not follow wall-clock changes;
 * their time zone is kept for display only. Once rules fire at one UTC instant.
 */

export type GapPolicy = 'skip' | 'run_after_gap';

export type ScheduleRule =
  | { kind: 'cron'; expression: string; timeZone: string; gapPolicy?: GapPolicy }
  | { kind: 'interval'; everySeconds: number; anchorUtc: string; timeZone: string }
  | { kind: 'once'; atUtc: string; timeZone: string };

export class InvalidScheduleRuleError extends Error {
  constructor(message: string) {
    super(`Invalid schedule rule: ${message}`);
    this.name = 'InvalidScheduleRuleError';
  }
}

export type CandidateStatus =
  | 'regular'
  | 'overlap_first'
  | 'gap_shifted'
  /** Not scheduled: the local time falls into a DST gap and gapPolicy is "skip". */
  | 'gap_skipped'
  /** Not scheduled: another occurrence already runs at exactly this instant. */
  | 'coalesced';

export interface Candidate {
  /** UTC instant of the run, or null when the candidate does not run. */
  scheduledForUtc: Date | null;
  /** Wall-clock plan time "YYYY-MM-DDTHH:mm" for cron rules; null for interval and once rules. */
  localPlanTime: string | null;
  utcOffsetMinutes: number | null;
  timeZone: string;
  status: CandidateStatus;
}

const MINIMUM_INTERVAL_SECONDS = 60;
const DAY_MS = 86_400_000;
/** Longest gap between two matches of a valid cron expression (29 February across a skipped leap year). */
const CRON_SEARCH_HORIZON_DAYS = 366 * 9;

export function normalizeRule(rule: ScheduleRule): ScheduleRule {
  assertValidTimeZone(rule.timeZone);
  switch (rule.kind) {
    case 'cron':
      parseCron(rule.expression);
      if (rule.gapPolicy !== undefined && rule.gapPolicy !== 'skip' && rule.gapPolicy !== 'run_after_gap') {
        throw new InvalidScheduleRuleError('unknown gapPolicy');
      }
      return { ...rule, expression: rule.expression.trim().replace(/\s+/g, ' '), gapPolicy: rule.gapPolicy ?? 'skip' };
    case 'interval':
      if (!Number.isInteger(rule.everySeconds) || rule.everySeconds < MINIMUM_INTERVAL_SECONDS) {
        throw new InvalidScheduleRuleError(`everySeconds must be an integer >= ${MINIMUM_INTERVAL_SECONDS}`);
      }
      return { ...rule, anchorUtc: parseInstant(rule.anchorUtc, 'anchorUtc').toISOString() };
    case 'once':
      return { ...rule, atUtc: parseInstant(rule.atUtc, 'atUtc').toISOString() };
    default:
      throw new InvalidScheduleRuleError('unknown rule kind');
  }
}

function parseInstant(value: string, field: string): Date {
  const instant = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(instant.getTime())) {
    throw new InvalidScheduleRuleError(`${field} is not a valid timestamp`);
  }
  return instant;
}

function describeInstant(
  timeZone: string,
  instantMs: number,
  localPlanTime: string | null,
  status: CandidateStatus
): Candidate {
  return {
    scheduledForUtc: new Date(instantMs),
    localPlanTime,
    utcOffsetMinutes: utcOffsetMs(timeZone, instantMs) / 60_000,
    timeZone,
    status
  };
}

/**
 * Candidates in chronological order whose effective instant lies strictly after `afterMs`,
 * including candidates that do not run (skipped or coalesced) so previews can show them.
 * Cron and once candidates end when exhausted; interval candidates continue indefinitely.
 */
export function* candidatesAfter(rule: ScheduleRule, afterMs: number): Generator<Candidate> {
  const normalized = normalizeRule(rule);
  if (normalized.kind === 'once') yield* onceCandidatesAfter(normalized, afterMs);
  else if (normalized.kind === 'interval') yield* intervalCandidatesAfter(normalized, afterMs);
  else yield* cronCandidatesAfter(normalized, afterMs);
}

function* onceCandidatesAfter(
  rule: Extract<ScheduleRule, { kind: 'once' }>,
  afterMs: number
): Generator<Candidate> {
  const atMs = new Date(rule.atUtc).getTime();
  if (atMs > afterMs) yield describeInstant(rule.timeZone, atMs, null, 'regular');
}

function* intervalCandidatesAfter(
  rule: Extract<ScheduleRule, { kind: 'interval' }>,
  afterMs: number
): Generator<Candidate> {
  const anchorMs = new Date(rule.anchorUtc).getTime();
  const everyMs = rule.everySeconds * 1000;
  let index = afterMs < anchorMs ? 0 : Math.floor((afterMs - anchorMs) / everyMs) + 1;
  for (;;) {
    yield describeInstant(rule.timeZone, anchorMs + index * everyMs, null, 'regular');
    index += 1;
  }
}

function* cronCandidatesAfter(
  rule: Extract<ScheduleRule, { kind: 'cron' }>,
  afterMs: number
): Generator<Candidate> {
  const cron = parseCron(rule.expression);
  const { timeZone } = rule;
  const gapPolicy = rule.gapPolicy ?? 'skip';
  let lastRunMs = Number.NEGATIVE_INFINITY;

  // Start one local day early so that candidates near `afterMs` are never missed because of the offset.
  let dayMs = startOfDay(naiveLocalMs(timeZone, afterMs)) - DAY_MS;
  for (let dayIndex = 0; dayIndex < CRON_SEARCH_HORIZON_DAYS; dayIndex += 1, dayMs += DAY_MS) {
    const day = new Date(dayMs);
    if (!cronMatchesDay(cron, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate())) continue;

    const fixedOffsetMs = offsetIfStableAround(timeZone, dayMs);
    for (const naiveMs of localTimesOfDay(cron, dayMs)) {
      const localPlanTime = formatLocalPlanTime(naiveMs);

      if (fixedOffsetMs !== null) {
        const instantMs = naiveMs - fixedOffsetMs;
        if (instantMs <= afterMs) continue;
        lastRunMs = instantMs;
        yield describeInstant(timeZone, instantMs, localPlanTime, 'regular');
        continue;
      }

      const resolution = resolveLocalTime(timeZone, naiveMs);
      if (resolution.kind === 'gap') {
        if (resolution.transitionMs <= afterMs) continue;
        if (gapPolicy === 'skip') {
          yield {
            scheduledForUtc: null,
            localPlanTime,
            utcOffsetMinutes: null,
            timeZone,
            status: 'gap_skipped'
          };
        } else if (resolution.transitionMs <= lastRunMs) {
          yield { scheduledForUtc: null, localPlanTime, utcOffsetMinutes: null, timeZone, status: 'coalesced' };
        } else {
          lastRunMs = resolution.transitionMs;
          yield describeInstant(timeZone, resolution.transitionMs, localPlanTime, 'gap_shifted');
        }
        continue;
      }

      const instantMs = resolution.kind === 'unique' ? resolution.instantMs : resolution.firstMs;
      if (instantMs <= afterMs) continue;
      if (instantMs <= lastRunMs) {
        yield { scheduledForUtc: null, localPlanTime, utcOffsetMinutes: null, timeZone, status: 'coalesced' };
        continue;
      }
      lastRunMs = instantMs;
      yield describeInstant(timeZone, instantMs, localPlanTime, resolution.kind === 'overlap' ? 'overlap_first' : 'regular');
    }
  }
}

function startOfDay(naiveMs: number): number {
  return Math.floor(naiveMs / DAY_MS) * DAY_MS;
}

function* localTimesOfDay(cron: ParsedCron, dayMs: number): Generator<number> {
  for (const hour of cron.hours) {
    for (const minute of cron.minutes) yield dayMs + (hour * 60 + minute) * 60_000;
  }
}

/**
 * Fast path: when the zone has the same offset a day before and two days after the local day,
 * no transition can affect it and every local time maps to exactly one instant.
 */
function offsetIfStableAround(timeZone: string, dayMs: number): number | null {
  const before = utcOffsetMs(timeZone, dayMs - DAY_MS);
  const after = utcOffsetMs(timeZone, dayMs + 2 * DAY_MS);
  return before === after ? before : null;
}

/** First logical due time strictly after `after`, or null when the rule never fires again. */
export function nextDue(rule: ScheduleRule, after: Date): Candidate | null {
  for (const candidate of candidatesAfter(rule, after.getTime())) {
    if (candidate.scheduledForUtc !== null) return candidate;
  }
  return null;
}

/**
 * Preview for the UI (plan 04, section 5): the next `runCount` runs with zone and UTC offset,
 * interleaved with the occurrences that do not run because of DST rules.
 */
export function previewSchedule(rule: ScheduleRule, from: Date, runCount = 5): Candidate[] {
  const entries: Candidate[] = [];
  let runs = 0;
  for (const candidate of candidatesAfter(rule, from.getTime())) {
    entries.push(candidate);
    if (candidate.scheduledForUtc !== null) runs += 1;
    if (runs >= runCount) break;
  }
  return entries;
}
