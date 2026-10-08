/**
 * All time-dependent decisions in this package (due occurrences, lease expiry, backoff)
 * take their notion of "now" from a Clock. SQL never calls now() for those decisions,
 * so tests can move time without sleeping.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date()
};

/** Test clock: stands still until it is moved explicitly. */
export class ManualClock implements Clock {
  private current: Date;

  constructor(start: Date | string) {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(instant: Date | string): void {
    this.current = new Date(instant);
  }

  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}
