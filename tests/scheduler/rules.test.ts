import { describe, expect, it } from 'vitest';
import {
  InvalidCronExpressionError,
  InvalidScheduleRuleError,
  InvalidTimeZoneError,
  candidatesAfter,
  nextDue,
  normalizeRule,
  parseCron,
  previewSchedule,
  type ScheduleRule
} from '../../packages/scheduler/src/index.js';

const berlin = (expression: string, gapPolicy?: 'skip' | 'run_after_gap'): ScheduleRule => ({
  kind: 'cron',
  expression,
  timeZone: 'Europe/Berlin',
  ...(gapPolicy ? { gapPolicy } : {})
});

/** Next `count` run instants (ISO strings) of a rule after a start instant. */
function runsAfter(rule: ScheduleRule, after: string, count: number): string[] {
  const runs: string[] = [];
  let cursor = new Date(after);
  for (let index = 0; index < count; index += 1) {
    const candidate = nextDue(rule, cursor);
    if (!candidate?.scheduledForUtc) break;
    runs.push(candidate.scheduledForUtc.toISOString());
    cursor = candidate.scheduledForUtc;
  }
  return runs;
}

describe('cron parsing', () => {
  it('parses lists, ranges, steps and names', () => {
    const cron = parseCron('*/20 8-10,22 1,15 JAN,mar MON-FRI');
    expect(cron.minutes).toEqual([0, 20, 40]);
    expect(cron.hours).toEqual([8, 9, 10, 22]);
    expect([...cron.daysOfMonth]).toEqual([1, 15]);
    expect([...cron.months]).toEqual([1, 3]);
    expect([...cron.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });

  it('treats 7 as Sunday and a/n as a-max/n', () => {
    expect([...parseCron('5/20 * * * 7').minutes]).toEqual([5, 25, 45]);
    expect([...parseCron('0 0 * * 7').daysOfWeek]).toEqual([0]);
  });

  it.each([
    ['', 'wrong field count'],
    ['* * * *', 'four fields'],
    ['0 0 * * * *', 'six fields (seconds)'],
    ['60 * * * *', 'minute out of range'],
    ['* 24 * * *', 'hour out of range'],
    ['* * 0 * *', 'day of month zero'],
    ['* * * 13 *', 'month out of range'],
    ['* * * * 8', 'weekday out of range'],
    ['*/0 * * * *', 'zero step'],
    ['5-1 * * * *', 'descending range'],
    ['@daily', 'alias'],
    ['0 0 ? * *', 'question mark'],
    ['0 0 L * *', 'last day'],
    ['1,,2 * * * *', 'empty list item'],
    ['1/2/3 * * * *', 'double step']
  ])('rejects %j (%s)', (expression) => {
    expect(() => parseCron(expression)).toThrow(InvalidCronExpressionError);
  });

  it('matches days by day-of-month OR day-of-week when both are restricted', () => {
    // 2026-03-02 is a Monday. "1st of the month or Monday".
    const rule = berlin('0 12 1 * MON');
    expect(runsAfter(rule, '2026-02-28T00:00:00Z', 3)).toEqual([
      '2026-03-01T11:00:00.000Z',
      '2026-03-02T11:00:00.000Z',
      '2026-03-09T11:00:00.000Z'
    ]);
  });
});

describe('rule validation', () => {
  it.each(['UTC+1', '+01:00', 'Foo/Bar', '', 'Europe/Berlin; DROP'])('rejects time zone %j', (timeZone) => {
    expect(() => normalizeRule({ kind: 'cron', expression: '0 0 * * *', timeZone })).toThrow(InvalidTimeZoneError);
  });

  it('rejects intervals below one minute and bad timestamps', () => {
    const base = { timeZone: 'UTC' };
    expect(() => normalizeRule({ kind: 'interval', everySeconds: 59, anchorUtc: '2026-01-01T00:00:00Z', ...base })).toThrow(InvalidScheduleRuleError);
    expect(() => normalizeRule({ kind: 'interval', everySeconds: 90.5, anchorUtc: '2026-01-01T00:00:00Z', ...base })).toThrow(InvalidScheduleRuleError);
    expect(() => normalizeRule({ kind: 'interval', everySeconds: 60, anchorUtc: 'yesterday-ish', ...base })).toThrow(InvalidScheduleRuleError);
    expect(() => normalizeRule({ kind: 'once', atUtc: 'nope', ...base })).toThrow(InvalidScheduleRuleError);
  });

  it('normalizes whitespace and fills the default gap policy from plan 04 (skip)', () => {
    expect(normalizeRule(berlin('  0   6 * *  *  '))).toMatchObject({ expression: '0 6 * * *', gapPolicy: 'skip' });
  });

  it('finds no due time for an expression that can never match', () => {
    expect(nextDue(berlin('0 0 31 2 *'), new Date('2026-01-01T00:00:00Z'))).toBeNull();
  });
});

describe('cron due times without DST effects', () => {
  it('computes local wall-clock times in the zone, with the right UTC offset in winter and summer', () => {
    expect(runsAfter(berlin('30 7 * * *'), '2026-01-10T12:00:00Z', 2)).toEqual([
      '2026-01-11T06:30:00.000Z',
      '2026-01-12T06:30:00.000Z'
    ]);
    expect(runsAfter(berlin('30 7 * * *'), '2026-07-10T12:00:00Z', 1)).toEqual(['2026-07-11T05:30:00.000Z']);
  });

  it('is strictly after the given instant', () => {
    expect(runsAfter(berlin('30 7 * * *'), '2026-01-11T06:30:00Z', 1)).toEqual(['2026-01-12T06:30:00.000Z']);
    expect(runsAfter(berlin('30 7 * * *'), '2026-01-11T06:29:59.999Z', 1)).toEqual(['2026-01-11T06:30:00.000Z']);
  });

  it('handles leap days', () => {
    expect(runsAfter({ kind: 'cron', expression: '0 0 29 2 *', timeZone: 'UTC' }, '2026-01-01T00:00:00Z', 1)).toEqual([
      '2028-02-29T00:00:00.000Z'
    ]);
  });

  it('is deterministic for identical input', () => {
    const first = runsAfter(berlin('*/7 3-5 * * 1-5'), '2026-03-20T00:00:00Z', 40);
    const second = runsAfter(berlin('*/7 3-5 * * 1-5'), '2026-03-20T00:00:00Z', 40);
    expect(second).toEqual(first);
  });
});

describe('DST gap (local time does not exist)', () => {
  // Europe/Berlin 2026-03-29: 02:00 CET jumps to 03:00 CEST; the transition instant is 01:00Z.
  const start = '2026-03-28T01:30:00Z'; // 02:30 CET on 28 March just ran

  it('skip (default, plan 04 text): the missing local occurrence is skipped', () => {
    expect(runsAfter(berlin('30 2 * * *'), start, 2)).toEqual([
      '2026-03-30T00:30:00.000Z', // 02:30 CEST on 30 March; 29 March has no 02:30
      '2026-03-31T00:30:00.000Z'
    ]);
  });

  it('run_after_gap: runs once at the first valid instant after the gap', () => {
    expect(runsAfter(berlin('30 2 * * *', 'run_after_gap'), start, 3)).toEqual([
      '2026-03-29T01:00:00.000Z', // 03:00 CEST, the first valid instant after the gap
      '2026-03-30T00:30:00.000Z',
      '2026-03-31T00:30:00.000Z'
    ]);
  });

  it('run_after_gap: occurrences that land on the same instant run only once', () => {
    const rule = berlin('0,30 2-3 * * *', 'run_after_gap');
    const candidates = [...candidatesAfter(rule, new Date('2026-03-28T23:00:00Z').getTime())].slice(0, 5);
    expect(candidates.map((c) => [c.localPlanTime, c.scheduledForUtc?.toISOString() ?? null, c.status])).toEqual([
      ['2026-03-29T02:00', '2026-03-29T01:00:00.000Z', 'gap_shifted'],
      ['2026-03-29T02:30', null, 'coalesced'],
      ['2026-03-29T03:00', null, 'coalesced'], // regular 03:00 CEST is the same instant
      ['2026-03-29T03:30', '2026-03-29T01:30:00.000Z', 'regular'],
      ['2026-03-30T02:00', '2026-03-30T00:00:00.000Z', 'regular']
    ]);
  });

  it('preview marks the skipped local occurrence (skip policy)', () => {
    const preview = previewSchedule(berlin('30 2 * * *'), new Date('2026-03-27T12:00:00Z'), 3);
    expect(preview.map((entry) => [entry.localPlanTime, entry.status])).toEqual([
      ['2026-03-28T02:30', 'regular'],
      ['2026-03-29T02:30', 'gap_skipped'],
      ['2026-03-30T02:30', 'regular'],
      ['2026-03-31T02:30', 'regular']
    ]);
    expect(preview[0]).toMatchObject({ timeZone: 'Europe/Berlin', utcOffsetMinutes: 60 });
    expect(preview[2]).toMatchObject({ utcOffsetMinutes: 120 });
  });

  it('works for a zone west of UTC (America/New_York, 2026-03-08, transition 07:00Z)', () => {
    const newYork = (gapPolicy: 'skip' | 'run_after_gap'): ScheduleRule => ({
      kind: 'cron',
      expression: '30 2 * * *',
      timeZone: 'America/New_York',
      gapPolicy
    });
    expect(runsAfter(newYork('skip'), '2026-03-07T07:30:00Z', 1)).toEqual(['2026-03-09T06:30:00.000Z']);
    expect(runsAfter(newYork('run_after_gap'), '2026-03-07T07:30:00Z', 1)).toEqual(['2026-03-08T07:00:00.000Z']);
  });
});

describe('DST overlap (local time occurs twice)', () => {
  // Europe/Berlin 2026-10-25: 03:00 CEST falls back to 02:00 CET; 02:30 happens at 00:30Z and again at 01:30Z.
  it('runs once, at the first appearance, and suppresses the second', () => {
    expect(runsAfter(berlin('30 2 * * *'), '2026-10-24T12:00:00Z', 3)).toEqual([
      '2026-10-25T00:30:00.000Z', // 02:30 CEST (first)
      '2026-10-26T01:30:00.000Z', // 02:30 CET next day; 01:30Z on the 25th is suppressed
      '2026-10-27T01:30:00.000Z'
    ]);
  });

  it('does not offer the second appearance even when asked right after the first run', () => {
    expect(nextDue(berlin('30 2 * * *'), new Date('2026-10-25T00:30:00Z'))?.scheduledForUtc?.toISOString()).toBe(
      '2026-10-26T01:30:00.000Z'
    );
  });

  it('hourly wall-clock rule: the repeated local hour is not run twice', () => {
    expect(runsAfter(berlin('30 * * * *'), '2026-10-24T22:00:00Z', 4)).toEqual([
      '2026-10-24T22:30:00.000Z', // 00:30 CEST
      '2026-10-24T23:30:00.000Z', // 01:30 CEST
      '2026-10-25T00:30:00.000Z', // 02:30 CEST (first)
      '2026-10-25T02:30:00.000Z' //  03:30 CET; the second 02:30 (01:30Z) is suppressed
    ]);
  });

  it('marks the first appearance in the preview', () => {
    const preview = previewSchedule(berlin('30 2 * * *'), new Date('2026-10-24T12:00:00Z'), 1);
    expect(preview[0]).toMatchObject({ status: 'overlap_first', utcOffsetMinutes: 120, localPlanTime: '2026-10-25T02:30' });
  });

  it('handles a 30 minute DST shift (Australia/Lord_Howe, 2026-04-05, transition 15:00Z)', () => {
    const rule: ScheduleRule = { kind: 'cron', expression: '*/15 1 * * *', timeZone: 'Australia/Lord_Howe' };
    expect(runsAfter(rule, '2026-04-04T13:59:00Z', 5)).toEqual([
      '2026-04-04T14:00:00.000Z', // 01:00 LHDT
      '2026-04-04T14:15:00.000Z',
      '2026-04-04T14:30:00.000Z', // 01:30 happens twice; first
      '2026-04-04T14:45:00.000Z', // 01:45 happens twice; first
      '2026-04-05T14:30:00.000Z' //  01:00 LHST on 6 April (+10:30) = 14:30Z
    ]);
  });
});

describe('interval and once rules', () => {
  it('interval counts elapsed time from the anchor, independent of DST', () => {
    const rule: ScheduleRule = { kind: 'interval', everySeconds: 3600, anchorUtc: '2026-10-25T00:00:00Z', timeZone: 'Europe/Berlin' };
    expect(runsAfter(rule, '2026-10-25T00:10:00Z', 4)).toEqual([
      '2026-10-25T01:00:00.000Z',
      '2026-10-25T02:00:00.000Z',
      '2026-10-25T03:00:00.000Z',
      '2026-10-25T04:00:00.000Z'
    ]);
  });

  it('interval starts at the anchor when asked before it, and is strictly after otherwise', () => {
    const rule: ScheduleRule = { kind: 'interval', everySeconds: 600, anchorUtc: '2026-05-01T10:00:00Z', timeZone: 'UTC' };
    expect(runsAfter(rule, '2026-05-01T09:00:00Z', 1)).toEqual(['2026-05-01T10:00:00.000Z']);
    expect(runsAfter(rule, '2026-05-01T10:00:00Z', 1)).toEqual(['2026-05-01T10:10:00.000Z']);
  });

  it('once fires a single time', () => {
    const rule: ScheduleRule = { kind: 'once', atUtc: '2026-06-01T08:00:00Z', timeZone: 'Europe/Berlin' };
    expect(runsAfter(rule, '2026-05-01T00:00:00Z', 3)).toEqual(['2026-06-01T08:00:00.000Z']);
    expect(nextDue(rule, new Date('2026-06-01T08:00:00Z'))).toBeNull();
  });
});
