// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App.js';

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const noContent = () => ({ ok: true, status: 204, json: async () => undefined });
const user = { id: 'u1', display_name: 'Alice', username: 'alice', role: 'user', status: 'active', created_at: '2026-01-01T00:00:00Z' };

const berlinCron = { kind: 'cron', expression: '30 2 * * *', timeZone: 'Europe/Berlin', gapPolicy: 'skip' };
const baseSubscription = {
  id: 's1', name: 'Creator A', targetUrl: 'https://example.test/creator-a', platformHint: 'youtube',
  targetState: 'unvalidated', status: 'active',
  schedules: [{ id: 'sc1', subscriptionId: 's1', version: 1, rule: berlinCron, jitterMaxSeconds: 0, enabled: true, nextDueAt: '2026-03-28T01:30:00.000Z' }]
};

type Handler = (path: string, init?: RequestInit) => ReturnType<typeof json> | undefined;

/** Fetch mock by path; every call is recorded so that tests can inspect request bodies. */
function mockApi(role: 'admin' | 'user', extra: Handler) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const fromTest = extra(path, init);
    if (fromTest) return fromTest;
    if (path.endsWith('/auth/state')) return json({ configured: true, authenticated: true, role, csrfToken: 'csrf', passwordChangeRequired: false });
    if (path.endsWith('/api/v1/users')) return json({ users: [{ ...user, role }] });
    if (path === '/healthz') return json({ status: 'ok' });
    if (path.endsWith('/api/v1/status')) return json({ version: '0.1.0', migrations: { appliedCount: 5, latestVersion: '0044' } });
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function openSubscriptions() {
  render(<App />);
  await screen.findByText('Erreichbar');
  fireEvent.click(screen.getByRole('button', { name: 'Abonnements' }));
  await screen.findByRole('heading', { name: 'Abonnements' });
}
const calls = (fetch: ReturnType<typeof vi.fn>, method: string, suffix: string) =>
  fetch.mock.calls.filter(([input, init]) => String(input).endsWith(suffix) && (init?.method ?? 'GET') === method);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('lists subscriptions with target, platform, validation state and schedule summary', async () => {
  mockApi('user', (path) => path.endsWith('/subscriptions') ? json({ subscriptions: [baseSubscription] }) : path.endsWith('/subscriptions/s1/runs') ? json({ runs: [] }) : undefined);
  await openSubscriptions();
  const card = await screen.findByRole('article', { name: 'Abonnement Creator A' });
  expect(within(card).getByText('Ziel: https://example.test/creator-a')).toBeInTheDocument();
  expect(within(card).getByText(/Noch nicht geprüft/)).toBeInTheDocument();
  expect(within(card).getByText('Status: Aktiv')).toBeInTheDocument();
  fireEvent.click(within(card).getByRole('button', { name: 'Zeitpläne und Läufe' }));
  expect(await within(card).findByText('Täglich um 02:30 Uhr (Europe/Berlin)')).toBeInTheDocument();
  expect(within(card).getByText('Noch keine Läufe.')).toBeInTheDocument();
});

it('creates a subscription with the entered target and the platform hint', async () => {
  const fetch = mockApi('user', (path, init) => {
    if (path.endsWith('/subscriptions') && init?.method === 'POST') return json({ subscription: baseSubscription }, 201);
    if (path.endsWith('/subscriptions')) return json({ subscriptions: [] });
    return undefined;
  });
  await openSubscriptions();
  expect(await screen.findByText('Noch keine Abonnements.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Abonnement anlegen' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Creator A' } });
  fireEvent.change(screen.getByLabelText('Ziel-URL'), { target: { value: 'https://example.test/creator-a' } });
  fireEvent.change(screen.getByLabelText('Plattform (Hinweis)'), { target: { value: 'youtube' } });
  fireEvent.submit(screen.getByRole('form', { name: 'Abonnement anlegen' }));
  await waitFor(() => expect(calls(fetch, 'POST', '/subscriptions')).toHaveLength(1));
  expect(JSON.parse(String(calls(fetch, 'POST', '/subscriptions')[0][1]?.body))).toEqual({
    name: 'Creator A', targetUrl: 'https://example.test/creator-a', platformHint: 'youtube'
  });
});

it('shows the server message when the subscription is rejected', async () => {
  mockApi('user', (path, init) => {
    if (path.endsWith('/subscriptions') && init?.method === 'POST') return json({ error: { code: 'VALIDATION_ERROR', message: 'Die Ziel-URL ist erforderlich.' } }, 400);
    if (path.endsWith('/subscriptions')) return json({ subscriptions: [] });
    return undefined;
  });
  await openSubscriptions();
  fireEvent.click(await screen.findByRole('button', { name: 'Abonnement anlegen' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
  fireEvent.change(screen.getByLabelText('Ziel-URL'), { target: { value: 'y' } });
  fireEvent.submit(screen.getByRole('form', { name: 'Abonnement anlegen' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Die Ziel-URL ist erforderlich.');
});

it('pauses and resumes a subscription', async () => {
  let status = 'active';
  const fetch = mockApi('user', (path, init) => {
    if (path.endsWith('/subscriptions/s1/pause')) { status = 'paused'; return json({ subscription: { ...baseSubscription, status } }); }
    if (path.endsWith('/subscriptions/s1/resume')) { status = 'active'; return json({ subscription: { ...baseSubscription, status } }); }
    if (path.endsWith('/subscriptions') && !init?.method) return json({ subscriptions: [{ ...baseSubscription, status }] });
    return undefined;
  });
  await openSubscriptions();
  const card = await screen.findByRole('article', { name: 'Abonnement Creator A' });
  fireEvent.click(within(card).getByRole('button', { name: 'Pausieren' }));
  expect(await screen.findByText('Status: Pausiert: Es werden keine neuen Läufe angelegt.')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Creator A (pausiert)' })).toBeInTheDocument();
  expect(calls(fetch, 'POST', '/subscriptions/s1/pause')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Fortsetzen' }));
  expect(await screen.findByText('Status: Aktiv')).toBeInTheDocument();
});

it('asks before deleting and deletes only after confirmation', async () => {
  let present = true;
  const fetch = mockApi('user', (path, init) => {
    if (path.endsWith('/subscriptions/s1') && init?.method === 'DELETE') { present = false; return noContent(); }
    if (path.endsWith('/subscriptions')) return json({ subscriptions: present ? [baseSubscription] : [] });
    return undefined;
  });
  await openSubscriptions();
  fireEvent.click(await screen.findByRole('button', { name: 'Löschen' }));
  expect(calls(fetch, 'DELETE', '/subscriptions/s1')).toHaveLength(0);
  expect(screen.getByText(/Heruntergeladene Medien bleiben unberührt/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Endgültig löschen' }));
  expect(await screen.findByText('Noch keine Abonnements.')).toBeInTheDocument();
});

it('previews the next runs and marks the skipped DST occurrence', async () => {
  const fetch = mockApi('user', (path) => {
    if (path.endsWith('/subscriptions')) return json({ subscriptions: [{ ...baseSubscription, schedules: [] }] });
    if (path.endsWith('/subscriptions/s1/runs')) return json({ runs: [] });
    if (path.endsWith('/schedules/preview')) {
      return json({ entries: [
        { scheduledForUtc: '2026-03-28T01:30:00.000Z', localPlanTime: '2026-03-28T02:30', timeZone: 'Europe/Berlin', utcOffset: '+01:00', status: 'regular' },
        { scheduledForUtc: null, localPlanTime: '2026-03-29T02:30', timeZone: 'Europe/Berlin', utcOffset: null, status: 'gap_skipped' },
        { scheduledForUtc: '2026-03-30T00:30:00.000Z', localPlanTime: '2026-03-30T02:30', timeZone: 'Europe/Berlin', utcOffset: '+02:00', status: 'regular' }
      ] });
    }
    return undefined;
  });
  await openSubscriptions();
  const card = await screen.findByRole('article', { name: 'Abonnement Creator A' });
  fireEvent.click(within(card).getByRole('button', { name: 'Zeitpläne und Läufe' }));
  fireEvent.click(await within(card).findByRole('button', { name: 'Zeitplan hinzufügen' }));
  fireEvent.change(screen.getByLabelText('Zeitzone'), { target: { value: 'Europe/Berlin' } });
  fireEvent.change(screen.getByLabelText('Uhrzeit'), { target: { value: '02:30' } });
  fireEvent.click(screen.getByRole('button', { name: 'Vorschau der nächsten Läufe' }));

  const preview = await screen.findByRole('region', { name: 'Vorschau der nächsten Läufe' });
  expect(within(preview).getAllByRole('listitem')).toHaveLength(3);
  expect(within(preview).getByText(/29\.03\.2026 02:30 \(Europe\/Berlin\) – entfällt: Die Uhrzeit existiert wegen der Zeitumstellung nicht/)).toBeInTheDocument();
  expect(within(preview).getAllByText(/UTC\+01:00/)).toHaveLength(1);
  expect(within(preview).getAllByText(/UTC\+02:00/)).toHaveLength(1);
  const body = JSON.parse(String(calls(fetch, 'POST', '/schedules/preview')[0][1]?.body));
  expect(body).toEqual({ rule: { kind: 'cron', expression: '30 2 * * *', timeZone: 'Europe/Berlin', gapPolicy: 'skip' }, count: 5 });
});

it('sends the selected gap policy and cron preset when saving a schedule', async () => {
  const fetch = mockApi('user', (path, init) => {
    if (path.endsWith('/schedules') && init?.method === 'POST') return json({ schedule: baseSubscription.schedules[0] }, 201);
    if (path.endsWith('/subscriptions')) return json({ subscriptions: [{ ...baseSubscription, schedules: [] }] });
    if (path.endsWith('/subscriptions/s1/runs')) return json({ runs: [] });
    return undefined;
  });
  await openSubscriptions();
  const card = await screen.findByRole('article', { name: 'Abonnement Creator A' });
  fireEvent.click(within(card).getByRole('button', { name: 'Zeitpläne und Läufe' }));
  fireEvent.click(await within(card).findByRole('button', { name: 'Zeitplan hinzufügen' }));
  fireEvent.change(screen.getByLabelText('Art des Zeitplans'), { target: { value: 'weekdays' } });
  fireEvent.change(screen.getByLabelText('Uhrzeit'), { target: { value: '06:00' } });
  fireEvent.change(screen.getByLabelText('Zeitzone'), { target: { value: 'Europe/Berlin' } });
  fireEvent.change(screen.getByLabelText('Fehlende Uhrzeit bei Zeitumstellung'), { target: { value: 'run_after_gap' } });
  fireEvent.submit(screen.getByRole('form', { name: 'Zeitplan anlegen' }));
  await waitFor(() => expect(calls(fetch, 'POST', '/schedules')).toHaveLength(1));
  expect(JSON.parse(String(calls(fetch, 'POST', '/schedules')[0][1]?.body))).toEqual({
    subscriptionId: 's1',
    rule: { kind: 'cron', expression: '0 6 * * 1-5', timeZone: 'Europe/Berlin', gapPolicy: 'run_after_gap' },
    jitterMaxSeconds: 0
  });
});

it('shows recent runs with German status texts', async () => {
  mockApi('user', (path) => {
    if (path.endsWith('/subscriptions')) return json({ subscriptions: [baseSubscription] });
    if (path.endsWith('/subscriptions/s1/runs')) {
      return json({ runs: [
        { id: 'r2', triggerKind: 'schedule', state: 'failed', scheduledFor: '2026-03-28T01:30:00.000Z', attempts: 5, maxAttempts: 5, lastError: 'Quelle nicht erreichbar', finishedAt: '2026-03-28T01:40:00.000Z' },
        { id: 'r1', triggerKind: 'manual', state: 'succeeded', scheduledFor: '2026-03-27T01:30:00.000Z', attempts: 1, maxAttempts: 5, lastError: null, finishedAt: '2026-03-27T01:31:00.000Z' }
      ] });
    }
    return undefined;
  });
  await openSubscriptions();
  const card = await screen.findByRole('article', { name: 'Abonnement Creator A' });
  fireEvent.click(within(card).getByRole('button', { name: 'Zeitpläne und Läufe' }));
  const runs = await within(card).findByRole('region', { name: 'Letzte Läufe' });
  expect(await within(runs).findByText('Fehlgeschlagen')).toBeInTheDocument();
  expect(within(runs).getByText('Quelle nicht erreichbar')).toBeInTheDocument();
  expect(within(runs).getByText('Erfolgreich')).toBeInTheDocument();
  expect(within(runs).getByText('Manuell')).toBeInTheDocument();
});

it('does not show the Limits page to a normal user, but to an administrator', async () => {
  mockApi('user', () => undefined);
  const { unmount } = render(<App />);
  await screen.findByText('Erreichbar');
  expect(screen.getByRole('button', { name: 'Abonnements' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Limits' })).not.toBeInTheDocument();
  unmount();
  cleanup();

  mockApi('admin', () => undefined);
  render(<App />);
  await screen.findByText('Erreichbar');
  expect(screen.getByRole('button', { name: 'Limits' })).toBeInTheDocument();
});
