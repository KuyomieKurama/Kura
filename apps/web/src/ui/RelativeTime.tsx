import { useEffect, useState } from 'react';
import { absoluteFull, relativeText, upperFirst } from '../time-format.js';

const TICK_MS = 30_000;
const listeners = new Set<() => void>();
let timer: number | undefined;

/** One shared timer for all times on the page; it runs only while at least one is mounted. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) timer = window.setInterval(() => listeners.forEach((notify) => notify()), TICK_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

/**
 * A point in time as <time datetime>. Relative up to 24 hours, otherwise short and absolute; the full time is the title.
 * It refreshes every 30 seconds and does not announce the change to screen readers.
 */
export function RelativeTime({ value, detail = false, capitalize = false, timeZone }: {
  value: string | Date;
  detail?: boolean;
  capitalize?: boolean;
  timeZone?: string;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => subscribe(() => setNow(new Date())), []);
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;
  const text = relativeText(date, now, { detail, ...(timeZone ? { timeZone } : {}) });
  return (
    <time className="num" dateTime={date.toISOString()} title={absoluteFull(date, timeZone)}>
      {capitalize ? upperFirst(text) : text}
    </time>
  );
}
