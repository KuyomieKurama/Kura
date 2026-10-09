import { describe, expect, it } from 'vitest';
import { classifyFailure, stopsWholeRun } from '../../apps/worker/src/failure.js';
import { AdapterError } from '../../packages/adapters/src/index.js';

describe('worker disposition of the Instagram failure codes', () => {
  it('maps AUTH_REQUIRED to waiting_auth and pauses the subscription (never \"no new posts\")', () => {
    const disposition = classifyFailure(new AdapterError('AUTH_REQUIRED', 'login required'));
    expect(disposition).toMatchObject({ runState: 'waiting_auth', code: 'AUTH_REQUIRED', retryable: false, pauseSubscription: true });
    expect(stopsWholeRun(disposition)).toBe(true);
  });

  it('maps RATE_LIMITED to waiting_rate_limit with a back-off and stops the run', () => {
    const disposition = classifyFailure(new AdapterError('RATE_LIMITED', 'throttled'));
    expect(disposition).toMatchObject({ runState: 'waiting_rate_limit', code: 'RATE_LIMITED', retryable: true });
    expect(disposition.retryAfterSeconds).toBeGreaterThanOrEqual(600);
    expect(stopsWholeRun(disposition)).toBe(true);
  });

  it('maps TARGET_NOT_FOUND to a terminal failure that keeps the archive', () => {
    const disposition = classifyFailure(new AdapterError('TARGET_NOT_FOUND', 'no such profile'));
    expect(disposition).toMatchObject({ runState: 'failed', code: 'TARGET_NOT_FOUND', retryable: false });
    expect(disposition.message).toContain('archivierte Dateien bleiben erhalten');
    expect(stopsWholeRun(disposition)).toBe(false);
  });

  it('uses the German sentence of the adapter for the precise reason, but only for these three codes', () => {
    const privateProfile = new AdapterError('AUTH_REQUIRED', 'private', undefined, 'Dieses Profil ist privat.');
    expect(classifyFailure(privateProfile)).toMatchObject({ runState: 'waiting_auth', message: 'Dieses Profil ist privat.' });
    const other = new AdapterError('PROCESS_FAILED', 'failed', undefined, 'Dieses Profil ist privat.');
    expect(classifyFailure(other).message).not.toContain('privat');
  });

  it('keeps tool output out of the message', () => {
    const error = new AdapterError('AUTH_REQUIRED', 'login', 'sessionid=SECRET-VALUE');
    expect(JSON.stringify(classifyFailure(error))).not.toContain('SECRET-VALUE');
  });
});
