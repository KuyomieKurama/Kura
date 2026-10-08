/**
 * Five-field cron expressions (minute hour day-of-month month day-of-week).
 *
 * Supported per field: "*", numbers, ranges "a-b", lists "a,b", steps "*\/n", "a-b/n", "a/n".
 * Month and weekday names (JAN, MON, ...) are accepted. Not supported (rejected with an error):
 * @aliases, "?", "L", "W", "#", seconds and year fields.
 *
 * Day matching follows the traditional cron rule: if both day-of-month and day-of-week are
 * restricted, a day matches when EITHER matches; if one of them is "*", only the other counts.
 */

export class InvalidCronExpressionError extends Error {
  constructor(message: string) {
    super(`Invalid cron expression: ${message}`);
    this.name = 'InvalidCronExpressionError';
  }
}

export interface ParsedCron {
  minutes: readonly number[];
  hours: readonly number[];
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  daysOfMonthRestricted: boolean;
  daysOfWeekRestricted: boolean;
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: readonly string[];
  nameOffset?: number;
}

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const MINUTE: FieldSpec = { name: 'minute', min: 0, max: 59 };
const HOUR: FieldSpec = { name: 'hour', min: 0, max: 23 };
const DAY_OF_MONTH: FieldSpec = { name: 'day-of-month', min: 1, max: 31 };
const MONTH: FieldSpec = { name: 'month', min: 1, max: 12, names: MONTH_NAMES, nameOffset: 1 };
const DAY_OF_WEEK: FieldSpec = { name: 'day-of-week', min: 0, max: 7, names: WEEKDAY_NAMES, nameOffset: 0 };

const MAX_EXPRESSION_LENGTH = 200;

export function parseCron(expression: string): ParsedCron {
  if (expression.length > MAX_EXPRESSION_LENGTH) throw new InvalidCronExpressionError('expression is too long');
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new InvalidCronExpressionError(`expected 5 fields, got ${fields.length}`);
  }
  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = fields;

  const daysOfWeek = new Set([...parseField(dayOfWeekField, DAY_OF_WEEK)].map((day) => day % 7));
  return {
    minutes: [...parseField(minuteField, MINUTE)].sort((a, b) => a - b),
    hours: [...parseField(hourField, HOUR)].sort((a, b) => a - b),
    daysOfMonth: parseField(dayOfMonthField, DAY_OF_MONTH),
    months: parseField(monthField, MONTH),
    daysOfWeek,
    daysOfMonthRestricted: !dayOfMonthField.startsWith('*'),
    daysOfWeekRestricted: !dayOfWeekField.startsWith('*')
  };
}

function parseField(field: string, spec: FieldSpec): Set<number> {
  const values = new Set<number>();
  for (const item of field.split(',')) {
    if (item === '') throw new InvalidCronExpressionError(`empty list item in ${spec.name}`);
    const [rangePart, stepPart, ...rest] = item.split('/');
    if (rest.length > 0) throw new InvalidCronExpressionError(`too many "/" in ${spec.name}`);

    let step = 1;
    if (stepPart !== undefined) {
      step = parseNumber(stepPart, { ...spec, names: undefined });
      if (step < 1) throw new InvalidCronExpressionError(`step must be at least 1 in ${spec.name}`);
    }

    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = spec.min;
      end = spec.name === 'day-of-week' ? 6 : spec.max;
    } else if (rangePart.includes('-')) {
      const [from, to, ...extra] = rangePart.split('-');
      if (extra.length > 0) throw new InvalidCronExpressionError(`bad range "${rangePart}" in ${spec.name}`);
      start = parseNumber(from, spec);
      end = parseNumber(to, spec);
      if (start > end) throw new InvalidCronExpressionError(`range start after end in ${spec.name}`);
    } else {
      start = parseNumber(rangePart, spec);
      end = stepPart !== undefined ? spec.max : start;
    }

    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

function parseNumber(text: string, spec: FieldSpec): number {
  let value: number;
  if (/^\d+$/.test(text)) {
    value = Number(text);
  } else if (spec.names && spec.names.includes(text.toUpperCase())) {
    value = spec.names.indexOf(text.toUpperCase()) + (spec.nameOffset ?? 0);
  } else {
    throw new InvalidCronExpressionError(`unsupported value "${text}" in ${spec.name}`);
  }
  if (value < spec.min || value > spec.max) {
    throw new InvalidCronExpressionError(`${value} is outside ${spec.min}-${spec.max} in ${spec.name}`);
  }
  return value;
}

/** Does the calendar day (naive local date) match the day and month fields? */
export function cronMatchesDay(cron: ParsedCron, year: number, month: number, day: number): boolean {
  if (!cron.months.has(month)) return false;
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const dayOfMonthMatches = cron.daysOfMonth.has(day);
  const dayOfWeekMatches = cron.daysOfWeek.has(dayOfWeek);
  if (cron.daysOfMonthRestricted && cron.daysOfWeekRestricted) return dayOfMonthMatches || dayOfWeekMatches;
  if (cron.daysOfMonthRestricted) return dayOfMonthMatches;
  if (cron.daysOfWeekRestricted) return dayOfWeekMatches;
  return true;
}
