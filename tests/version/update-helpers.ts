import type { CheckState, Timers, UpdateCheckStore } from '../../apps/api/src/update-check.js';

/** A clock and timers that only move when the test says so. */
export class FakeTime implements Timers {
  private current: number;
  private nextId = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  constructor(start = '2026-10-11T12:00:00Z') {
    this.current = Date.parse(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.pending.set(id, { at: this.current + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Milliseconds until the next timer fires, or null when none is waiting. */
  get nextInMs(): number | null {
    const times = [...this.pending.values()].map((timer) => timer.at - this.current);
    return times.length ? Math.min(...times) : null;
  }

  /** Moves time forward and runs every timer that becomes due, letting async callbacks finish in between. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = [...this.pending.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.current = Math.max(this.current, due[1].at);
      due[1].callback();
      await settle();
    }
    this.current = target;
  }
}

/** Lets pending promise chains and stream reads finish. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

export class MemoryStore implements UpdateCheckStore {
  state: CheckState | null = null;
  saves = 0;
  loads = 0;
  readonly dismissals = new Map<string, string>();
  failSave = false;
  failLoad = false;

  async load(): Promise<CheckState | null> {
    this.loads += 1;
    if (this.failLoad) throw new Error('load failed');
    return this.state ? { ...this.state } : null;
  }

  async save(state: CheckState): Promise<void> {
    if (this.failSave) throw new Error('save failed');
    this.saves += 1;
    this.state = { ...state };
  }

  async dismissedVersion(userId: string): Promise<string | null> {
    return this.dismissals.get(userId) ?? null;
  }

  async dismiss(userId: string, version: string): Promise<void> {
    this.dismissals.set(userId, version);
  }
}

export interface ScriptedResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A fetch that answers from a table keyed by URL path, records every call, and never touches the network. */
export class ScriptedFetch {
  readonly calls: { path: string; headers: Record<string, string> }[] = [];
  private readonly routes = new Map<string, () => ScriptedResponse | Promise<ScriptedResponse>>();

  set(path: string, response: ScriptedResponse | (() => ScriptedResponse | Promise<ScriptedResponse>)): this {
    this.routes.set(path, typeof response === 'function' ? response : () => response);
    return this;
  }

  callsTo(path: string) {
    return this.calls.filter((call) => call.path === path);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    this.calls.push({ path: url.pathname, headers: init?.headers as Record<string, string> });
    const route = this.routes.get(url.pathname);
    const scripted = route ? await route() : { status: 404, body: { message: 'Not Found' } };
    const status = scripted.status ?? 200;
    return new Response(status === 304 ? null : JSON.stringify(scripted.body ?? null), { status, headers: scripted.headers });
  };
}
