// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App.js';

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const admin = { id: 'a1', display_name: 'Admin', username: 'admin', role: 'admin', status: 'active', created_at: '2026-01-01T00:00:00Z' };
const bob = { id: '11111111-1111-4111-8111-111111111111', display_name: 'Bob', username: 'bob', role: 'user', status: 'active', created_at: '2026-01-02T00:00:00Z' };

type Policy = {
  downloads: {
    maxConcurrentGlobal: number | null; maxConcurrentPerUser: number | null; maxConcurrentPerSourceAccount: number | null;
    maxDownloadsPerDayPerUser: number | null; maxBytesPerDayPerUser: number | null; bandwidthBytesPerSecond: number | null;
    perAdapter: Record<string, { maxConcurrent: number | null }>; perUser: Record<string, { maxConcurrent: number | null }>;
  };
  workers: { downloadSlots: number; transferSlots: number; lifecycleReservedSlots: number };
  retention: { finishedRunDays: number };
};
const defaults: Policy = {
  downloads: {
    maxConcurrentGlobal: null, maxConcurrentPerUser: null, maxConcurrentPerSourceAccount: null,
    maxDownloadsPerDayPerUser: null, maxBytesPerDayPerUser: null, bandwidthBytesPerSecond: null,
    perAdapter: { youtube: { maxConcurrent: 1 } }, perUser: {}
  },
  workers: { downloadSlots: 4, transferSlots: 2, lifecycleReservedSlots: 1 },
  retention: { finishedRunDays: 90 }
};
const policyResponse = (version: number, policy: Policy = defaults) => ({
  version, policy, updatedAt: version ? '2026-10-08T10:00:00Z' : null,
  enforced: ['downloads.maxConcurrentGlobal', 'downloads.maxConcurrentPerUser', 'downloads.perUser', 'retention.finishedRunDays']
});

function mockApi(onPolicy: (init?: RequestInit) => ReturnType<typeof json>) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/auth/state')) return json({ configured: true, authenticated: true, role: 'admin', csrfToken: 'csrf', passwordChangeRequired: false });
    if (path.endsWith('/api/v1/users')) return json({ users: [admin, bob] });
    if (path === '/healthz') return json({ status: 'ok' });
    if (path.endsWith('/api/v1/status')) return json({ version: '0.1.0', migrations: { appliedCount: 5, latestVersion: '0044' } });
    if (path.endsWith('/admin/runtime-policy')) return onPolicy(init);
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function openLimits() {
  render(<App />);
  await screen.findByText('Erreichbar');
  fireEvent.click(screen.getByRole('button', { name: 'Limits' }));
  await screen.findByRole('form', { name: 'Limits bearbeiten' });
}
const puts = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter(([, init]) => init?.method === 'PUT');

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows the plan defaults, empty meaning "no limit", and marks values that are not enforced yet', async () => {
  mockApi(() => json(policyResponse(0)));
  await openLimits();
  expect(screen.getByLabelText(/Läufe gleichzeitig, insgesamt/)).toHaveValue(null);
  expect(screen.getByLabelText(/Downloads gleichzeitig/)).toHaveValue(4);
  expect(screen.getByLabelText(/Beendete Läufe aufbewahren/)).toHaveValue(90);
  expect(screen.getByText(/Du hast noch keine Limits gespeichert, es gelten die Standardwerte/)).toBeInTheDocument();
  // Empty fields say so, and each number has its unit behind it.
  expect(screen.getByLabelText(/Läufe gleichzeitig, insgesamt/)).toHaveAttribute('placeholder', 'Kein Limit');
  expect(screen.getByLabelText(/Beendete Läufe aufbewahren/).closest('.input-unit')).toHaveTextContent('Tage');
  // Stored but not enforced: said once per group, naming the fields, not once under each field.
  const notes = screen.getAllByText(/Wird gespeichert, wirkt aber noch nicht/);
  expect(notes).toHaveLength(2);
  expect(notes[0]).toHaveTextContent('Läufe gleichzeitig je Quellkonto');
  expect(notes[0]).toHaveTextContent('Bandbreite');
  expect(notes[0]).not.toHaveTextContent('Läufe gleichzeitig, insgesamt');
  expect(notes[1]).toHaveTextContent('Downloads gleichzeitig');
  // No save bar while nothing changed.
  expect(screen.queryByRole('button', { name: 'Limits speichern' })).toBeNull();
});

it('shows the save bar only when something changed, with a way to discard', async () => {
  mockApi(() => json(policyResponse(0)));
  await openLimits();
  fireEvent.change(screen.getByLabelText(/Beendete Läufe aufbewahren/), { target: { value: '30' } });
  expect(await screen.findByText('Nicht gespeicherte Änderungen')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Verwerfen' }));
  await waitFor(() => expect(screen.queryByText('Nicht gespeicherte Änderungen')).toBeNull());
  expect(screen.getByLabelText(/Beendete Läufe aufbewahren/)).toHaveValue(90);
});

it('saves with the version it loaded, null for empty fields, and keeps the adapter limits it does not edit', async () => {
  const fetch = mockApi((init) => init?.method === 'PUT' ? json(policyResponse(1)) : json(policyResponse(0)));
  await openLimits();
  fireEvent.change(screen.getByLabelText(/Läufe gleichzeitig, insgesamt/), { target: { value: '6' } });
  fireEvent.change(screen.getByLabelText(/Beendete Läufe aufbewahren/), { target: { value: '30' } });
  fireEvent.change(screen.getByLabelText('Ausnahme hinzufügen'), { target: { value: bob.id } });
  fireEvent.change(screen.getByLabelText('Limit für Bob'), { target: { value: '1' } });
  fireEvent.submit(screen.getByRole('form', { name: 'Limits bearbeiten' }));

  expect(await screen.findByText(/Limits gespeichert \(Version 1\)/)).toBeInTheDocument();
  const body = JSON.parse(String(puts(fetch)[0][1]?.body));
  expect(body.expectedVersion).toBe(0);
  expect(body.policy.downloads).toMatchObject({
    maxConcurrentGlobal: 6, maxConcurrentPerUser: null, maxBytesPerDayPerUser: null,
    perAdapter: { youtube: { maxConcurrent: 1 } }, perUser: { [bob.id]: { maxConcurrent: 1 } }
  });
  expect(body.policy.retention).toEqual({ finishedRunDays: 30 });
  expect(body.policy.workers).toEqual({ downloadSlots: 4, transferSlots: 2, lifecycleReservedSlots: 1 });
});

it('lists every validation problem returned by the server', async () => {
  mockApi((init) => init?.method === 'PUT'
    ? json({ error: { code: 'VALIDATION_ERROR', message: 'Die Limits sind ungültig.', problems: ['downloads.maxConcurrentGlobal must be null or an integer between 0 and 10000', 'retention.finishedRunDays must be an integer between 1 and 3650'] } }, 400)
    : json(policyResponse(0)));
  await openLimits();
  fireEvent.change(screen.getByLabelText(/Läufe gleichzeitig, insgesamt/), { target: { value: '-1' } });
  fireEvent.submit(screen.getByRole('form', { name: 'Limits bearbeiten' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('downloads.maxConcurrentGlobal must be null or an integer between 0 and 10000');
  expect(alert).toHaveTextContent('retention.finishedRunDays must be an integer between 1 and 3650');
});

it('offers to reload when another administrator saved first', async () => {
  let version = 0;
  mockApi((init) => {
    if (init?.method === 'PUT') return json({ error: { code: 'VERSION_CONFLICT', message: 'Die Limits wurden zwischenzeitlich geändert. Bitte laden Sie die aktuelle Version neu.' }, currentVersion: 3 }, 409);
    return json(policyResponse(version));
  });
  await openLimits();
  version = 3;
  fireEvent.submit(screen.getByRole('form', { name: 'Limits bearbeiten' }));
  expect(await screen.findByText(/zwischenzeitlich geändert/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Aktuelle Version laden' }));
  await waitFor(() => expect(screen.getByText(/\(Version 3\)/)).toBeInTheDocument());
});

it('shows data limits in MiB and converts to bytes on save', async () => {
  const response = policyResponse(0, { ...defaults, downloads: { ...defaults.downloads, maxBytesPerDayPerUser: 5 * 1024 * 1024 } });
  const fetch = mockApi((init) => init?.method === 'PUT' ? json(policyResponse(1)) : json(response));
  await openLimits();
  const daily = screen.getByLabelText(/Datenmenge pro Tag und Benutzer/);
  expect(daily).toHaveValue(5);
  expect(daily.closest('.input-unit')).toHaveTextContent('MiB');
  expect(screen.getByLabelText(/Bandbreite/).closest('.input-unit')).toHaveTextContent('MiB pro Sekunde');
  fireEvent.change(screen.getByLabelText(/Bandbreite/), { target: { value: '1.5' } });
  fireEvent.submit(screen.getByRole('form', { name: 'Limits bearbeiten' }));
  await screen.findByText(/Limits gespeichert/);
  const body = JSON.parse(String(puts(fetch)[0][1]?.body));
  expect(body.policy.downloads).toMatchObject({ maxBytesPerDayPerUser: 5 * 1024 * 1024, bandwidthBytesPerSecond: 1.5 * 1024 * 1024 });
});

it('says what an empty or zero limit means only once', async () => {
  mockApi(() => json(policyResponse(0)));
  await openLimits();
  expect(screen.getAllByText(/Leer heißt: kein Limit/)).toHaveLength(1);
});
