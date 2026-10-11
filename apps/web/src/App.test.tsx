// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App.js';

const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const admin = { id: 'admin', display_name: 'Admin', username: 'admin', role: 'admin', status: 'active', created_at: '2026-01-01T00:00:00Z' };
/** The API of a signed-in session. Answers by path, so the order of the requests does not matter. */
function mockAuthenticated(role: 'admin' | 'user' = 'admin', passwordChangeRequired = false) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/auth/state')) return response({ configured: true, authenticated: true, role, csrfToken: 'csrf', passwordChangeRequired });
    if (path.endsWith('/api/v1/users')) return response({ users: [{ ...admin, role }] });
    if (path === '/healthz') return response({ status: 'ok' });
    if (path.endsWith('/api/v1/status')) return response({ version: '0.1.0', migrations: { appliedCount: 2, latestVersion: '0002' } });
    return response({}, 404);
  });
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows the setup form while unconfigured', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ configured: false, authenticated: false, role: null, csrfToken: null, passwordChangeRequired: false })));
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Willkommen bei Kura' })).toBeInTheDocument();
  expect(screen.getByLabelText('Passwort')).toHaveAttribute('autocomplete', 'new-password');
});
it('shows dashboard status for an authenticated administrator', async () => {
  vi.stubGlobal('fetch', mockAuthenticated()); render(<App />);
  expect(await screen.findByText('Erreichbar')).toBeInTheDocument();
  // The status row is a definition list: the term "Angewendete Migrationen" and the value "2" are separate elements.
  expect(screen.getByText('Angewendete Migrationen').nextElementSibling).toHaveTextContent('2');
  expect(screen.getByRole('button', { name: 'Benutzerverwaltung' })).toBeInTheDocument();
});
it('does not show user management to a normal user', async () => {
  vi.stubGlobal('fetch', mockAuthenticated('user')); render(<App />);
  await screen.findByText('Erreichbar');
  expect(screen.queryByRole('button', { name: 'Benutzerverwaltung' })).not.toBeInTheDocument();
});
it('requires a password change when the server demands it', async () => {
  vi.stubGlobal('fetch', mockAuthenticated('user', true)); render(<App />);
  expect(await screen.findByRole('heading', { name: 'Passwortänderung erforderlich' })).toBeInTheDocument();
  expect(screen.queryByText('Erreichbar')).not.toBeInTheDocument();
});
it('renders a generic login failure', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({ configured: true, authenticated: false, role: null, csrfToken: null, passwordChangeRequired: false })).mockResolvedValueOnce(response({ error: { message: 'ignored' } }, 401));
  vi.stubGlobal('fetch', fetch); render(<App />); await screen.findByRole('heading', { name: 'Anmelden' });
  fireEvent.change(screen.getByLabelText('Benutzername'), { target: { value: 'a' } }); fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'a' } }); fireEvent.click(screen.getByRole('button', { name: 'Anmelden' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Das hat nicht geklappt. Prüfe Benutzername und Passwort und versuche es noch einmal.');
});
it('shows the SSO login only when the API enables it', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ configured: true, authenticated: false, role: null, csrfToken: null, passwordChangeRequired: false, oidcEnabled: true })));
  render(<App />);
  expect(await screen.findByRole('link', { name: 'Mit SSO anmelden' })).toHaveAttribute('href', '/api/v1/auth/oidc/start');
});
it('opens the Immich page with connection and test-file controls', async () => {
  vi.stubGlobal('fetch', mockAuthenticated());
  render(<App />);
  await screen.findByText('Erreichbar');
  fireEvent.click(screen.getByRole('button', { name: 'Immich' }));
  expect(await screen.findByRole('heading', { name: 'Immich' })).toBeInTheDocument();
  expect(screen.getByLabelText('Server-URL')).toBeInTheDocument();
  expect(screen.getByLabelText('API-Schlüssel')).toHaveAttribute('type', 'password');
  expect(screen.getByLabelText('Testdatei')).toHaveAttribute('type', 'file');
  expect(screen.getByText('Lokale Originale werden bei diesem Test niemals gelöscht.')).toBeInTheDocument();
});
it('shows verification evidence after a verified test upload', async () => {
  const verified = { id: 'transfer-1', status: 'verified', localOriginalRetained: true, evidence: { serverVersion: '3.2.1', byteLength: 4, album: 'none' } };
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/auth/state')) return response({ configured: true, authenticated: true, role: 'admin', csrfToken: 'csrf', passwordChangeRequired: false });
    if (path.endsWith('/users')) return response({ users: [admin] });
    if (path === '/healthz') return response({ status: 'ok' });
    if (path.endsWith('/status')) return response({ version: '0.1.0', migrations: { appliedCount: 2, latestVersion: '0002' } });
    if (path.endsWith('/immich/connection')) return response({ connection: { serverUrl: 'https://immich.example', generation: 1, updatedAt: '2026-01-01T00:00:00Z' } });
    if (path.endsWith('/immich/test-transfer')) return response({ transfer: { id: verified.id, status: 'uploading', localOriginalRetained: true, evidence: null } });
    if (path.endsWith(`/immich/transfers/${verified.id}`)) return response({ transfer: verified });
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', fetch);
  render(<App />);
  await screen.findByText('Erreichbar');
  fireEvent.click(screen.getByRole('button', { name: 'Immich' }));
  await screen.findByRole('heading', { name: 'Immich' });
  const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });
  vi.stubGlobal('FormData', class { get(name: string) { return name === 'testFile' ? file : null; } });
  fireEvent.submit(screen.getByLabelText('Testdatei').closest('form')!);
  expect(await screen.findByText('Testübertragung verifiziert. Das lokale Original bleibt erhalten.')).toBeInTheDocument();
  expect(screen.getByText('Originalnachweis: Server 3.2.1, 4 Bytes, Album none.')).toBeInTheDocument();
});

it('labels a reconciling test upload as uncertain instead of completed', async () => {
  const reconciling = { id: 'transfer-2', status: 'reconciling', localOriginalRetained: true, evidence: null };
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/auth/state')) return response({ configured: true, authenticated: true, role: 'admin', csrfToken: 'csrf', passwordChangeRequired: false });
    if (path.endsWith('/users')) return response({ users: [admin] });
    if (path === '/healthz') return response({ status: 'ok' });
    if (path.endsWith('/status')) return response({ version: '0.1.0', migrations: { appliedCount: 2, latestVersion: '0002' } });
    if (path.endsWith('/immich/connection')) return response({ connection: { serverUrl: 'https://immich.example', generation: 1, updatedAt: '2026-01-01T00:00:00Z' } });
    if (path.endsWith('/immich/test-transfer')) return response({ transfer: { id: reconciling.id, status: 'reconciling', localOriginalRetained: true, evidence: null } });
    if (path.endsWith(`/immich/transfers/${reconciling.id}`)) return response({ transfer: reconciling });
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', fetch);
  render(<App />);
  await screen.findByText('Erreichbar');
  fireEvent.click(screen.getByRole('button', { name: 'Immich' }));
  await screen.findByRole('heading', { name: 'Immich' });
  const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });
  vi.stubGlobal('FormData', class { get(name: string) { return name === 'testFile' ? file : null; } });
  fireEvent.submit(screen.getByLabelText('Testdatei').closest('form')!);
  expect(await screen.findByText('Testübertragung ist unklar und wird abgeglichen. Das lokale Original bleibt erhalten.')).toBeInTheDocument();
  expect(screen.getByText('Originalnachweis: noch nicht vorhanden.')).toBeInTheDocument();
  expect(screen.queryByText('Testübertragung abgeschlossen. Das lokale Original bleibt erhalten.')).not.toBeInTheDocument();
});

it('opens the create-user dialog for an administrator', async () => {
  vi.stubGlobal('fetch', mockAuthenticated()); render(<App />); await screen.findByText('Erreichbar'); fireEvent.click(screen.getByRole('button', { name: 'Benutzerverwaltung' })); fireEvent.click(await screen.findByRole('button', { name: 'Benutzer anlegen' }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.keyDown(window, { key: 'Escape' }); await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('lets an administrator approve and revoke private Immich endpoints', async () => {
  const approvals = [{ host: '192.168.1.20', port: 2283, approvedAt: '2026-10-08T10:00:00Z' }];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/auth/state')) return response({ configured: true, authenticated: true, role: 'admin', csrfToken: 'csrf', passwordChangeRequired: false });
    if (path.endsWith('/users')) return response({ users: [admin] });
    if (path.endsWith('/healthz')) return response({ status: 'ok' });
    if (path.endsWith('/status')) return response({ version: '0.1.0', migrations: { appliedCount: 2, latestVersion: '0002' } });
    if (path.endsWith('/immich/connection')) return response({ connection: null });
    if (path.endsWith('/admin/immich/endpoint-approvals') && init?.method === 'POST') {
      approvals.push({ host: '10.0.0.5', port: 2283, approvedAt: '2026-10-08T10:01:00Z' });
      return response({ approval: { host: '10.0.0.5', port: 2283 } }, 201);
    }
    if (path.endsWith('/admin/immich/endpoint-approvals')) return response({ approvals });
    if (path.includes('/admin/immich/endpoint-approvals/') && init?.method === 'DELETE') {
      approvals.splice(0, approvals.length);
      return { ok: true, status: 204, json: async () => undefined };
    }
    return response({}, 404);
  });
  vi.stubGlobal('fetch', fetch);
  render(<App />);
  await screen.findByText('Erreichbar');
  fireEvent.click(screen.getByRole('button', { name: 'Immich' }));
  expect(await screen.findByText('192.168.1.20:2283')).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Host'), { target: { value: '10.0.0.5' } });
  fireEvent.change(screen.getByLabelText('Port'), { target: { value: '2283' } });
  fireEvent.click(screen.getByRole('button', { name: 'Endpunkt freigeben' }));
  expect(await screen.findByText('10.0.0.5:2283')).toBeInTheDocument();
  const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST' && String(init.body).includes('10.0.0.5'));
  expect(JSON.parse(String(post?.[1]?.body))).toEqual({ host: '10.0.0.5', port: 2283 });

  fireEvent.click(screen.getByRole('button', { name: 'Freigabe für 192.168.1.20:2283 entziehen' }));
  // The dialog names the endpoint and puts the focus on "Abbrechen"; nothing is sent before the confirmation.
  const dialog = await screen.findByRole('dialog', { name: 'Freigabe für 192.168.1.20:2283 entziehen' });
  expect(within(dialog).getByRole('button', { name: 'Abbrechen' })).toHaveFocus();
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Freigabe entziehen' }));
  expect(await screen.findByText('Keine Freigaben vorhanden.')).toBeInTheDocument();
  expect(fetch.mock.calls.some(([input, init]) => String(input).endsWith('/admin/immich/endpoint-approvals/192.168.1.20/2283') && init?.method === 'DELETE')).toBe(true);
});
it('does not offer Immich endpoint approval to a normal user', async () => {
  vi.stubGlobal('fetch', mockAuthenticated('user'));
  render(<App />);
  await screen.findByText('Erreichbar');
  fireEvent.click(screen.getByRole('button', { name: 'Immich' }));
  await screen.findByRole('heading', { name: 'Immich' });
  expect(screen.queryByRole('button', { name: 'Endpunkt freigeben' })).not.toBeInTheDocument();
  expect(screen.queryByText('Freigaben für private Immich-Endpunkte')).not.toBeInTheDocument();
});

it('asks before locking a user, names the person and puts the focus on "Abbrechen"', async () => {
  const other = { id: 'u2', display_name: 'Mara Muster', username: 'mara', role: 'user', status: 'active', created_at: '2026-01-02T00:00:00Z' };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/auth/state')) return response({ configured: true, authenticated: true, role: 'admin', csrfToken: 'csrf', passwordChangeRequired: false });
    if (path.endsWith('/api/v1/users')) return response({ users: [admin, other] });
    if (path.endsWith('/users/u2/status') && init?.method === 'PATCH') return response({ user: { ...other, status: 'locked' } });
    if (path === '/healthz') return response({ status: 'ok' });
    if (path.endsWith('/api/v1/status')) return response({ version: '0.1.0', migrations: { appliedCount: 2, latestVersion: '0002' } });
    return response({}, 404);
  });
  vi.stubGlobal('fetch', fetch);
  render(<App />);
  await screen.findByText('Erreichbar');
  fireEvent.click(screen.getByRole('button', { name: 'Benutzerverwaltung' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Mara Muster sperren' }));

  const dialog = await screen.findByRole('dialog', { name: 'Mara Muster sperren' });
  expect(within(dialog).getByText(/Mara Muster \(mara\) wird gesperrt/)).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Abbrechen' })).toHaveFocus();
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  expect(dialog.textContent).not.toMatch(/[—–]/);
});

it('lists users with avatar, "Du" on the own row and a chip only for a lock', async () => {
  const blocked = { id: 'u3', display_name: 'Bob Beispiel', username: 'bob', role: 'user', status: 'blocked', created_at: '2026-01-03T00:00:00Z' };
  const other = { id: 'u2', display_name: 'Mara Muster', username: 'mara', role: 'user', status: 'active', created_at: '2026-01-02T00:00:00Z' };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/auth/state')) return response({ configured: true, authenticated: true, role: 'admin', csrfToken: 'csrf', passwordChangeRequired: false });
    if (path.endsWith('/api/v1/users')) return response({ users: [admin, other, blocked] });
    if (path === '/healthz') return response({ status: 'ok' });
    if (path.endsWith('/api/v1/status')) return response({ version: '0.1.0', migrations: { appliedCount: 2, latestVersion: '0002' } });
    return response({}, 404);
  }));
  render(<App />);
  await screen.findByText('Erreichbar');
  fireEvent.click(screen.getByRole('button', { name: 'Benutzerverwaltung' }));

  const list = await screen.findByRole('list', { name: 'Benutzerverwaltung' });
  const rows = within(list).getAllByRole('listitem');
  expect(rows).toHaveLength(3);
  // Own row: "Du". Other rows: no "Du", no "Aktiv" chip.
  const own = rows.find((row) => within(row).queryByText('Du') !== null);
  expect(own).toBeDefined();
  expect(own?.textContent).toContain(admin.display_name);
  expect(within(list).queryByText('Aktiv')).toBeNull();
  expect(list.querySelectorAll('.chip')).toHaveLength(1);
  expect(within(rows[2]!).getByText('Gesperrt')).toBeInTheDocument();
  expect(within(rows[1]!).getByText('mara')).toHaveClass('mono');
});
