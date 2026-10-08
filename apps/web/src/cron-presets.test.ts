import { describe, expect, it } from 'vitest';
import { browserTimeZone, cronFromPreset, intervalSeconds, splitInterval, timeZoneOptions } from './cron-presets.js';

const input = { time: '06:30', weekday: '1', minute: '15' };

describe('cron presets', () => {
  it('builds five-field expressions for the simple choices', () => {
    expect(cronFromPreset('daily', input)).toBe('30 6 * * *');
    expect(cronFromPreset('weekdays', input)).toBe('30 6 * * 1-5');
    expect(cronFromPreset('weekly', { ...input, weekday: '0' })).toBe('30 6 * * 0');
    expect(cronFromPreset('hourly', input)).toBe('15 * * * *');
  });

  it('returns null while the input is incomplete or out of range', () => {
    expect(cronFromPreset('daily', { ...input, time: '' })).toBeNull();
    expect(cronFromPreset('daily', { ...input, time: '24:00' })).toBeNull();
    expect(cronFromPreset('weekly', { ...input, weekday: '7' })).toBeNull();
    expect(cronFromPreset('hourly', { ...input, minute: '60' })).toBeNull();
    expect(cronFromPreset('hourly', { ...input, minute: '1.5' })).toBeNull();
  });

  it('converts intervals both ways', () => {
    expect(intervalSeconds(2, 'hours')).toBe(7200);
    expect(splitInterval(7200)).toEqual({ amount: 2, unit: 'hours' });
    expect(splitInterval(172_800)).toEqual({ amount: 2, unit: 'days' });
    expect(splitInterval(900)).toEqual({ amount: 15, unit: 'minutes' });
  });

  it('offers Europe/Berlin and UTC first and knows the browser zone', () => {
    const zones = timeZoneOptions();
    expect(zones[0]).toBe('Europe/Berlin');
    expect(zones).toContain('UTC');
    expect(new Set(zones).size).toBe(zones.length);
    expect(browserTimeZone().length).toBeGreaterThan(0);
  });
});
