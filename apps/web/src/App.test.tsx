// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App.js';

const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const admin = { id: 'admin', display_name: 'Admin', username: 'admin', role: 'admin', status: 'active', created_at: '2026-01-01T00:00:00Z' };
function mockAuthenticated(role: 'admin' | 'user' = 'admin', passwordChangeRequired = false) {
  return vi.fn()
    .mockResolvedValueOnce(response({ configured: true, authenticated: true, role, csrfToken: 'csrf', passwordChangeRequired }))
    .mockResolvedValueOnce(response({ users: [{ ...admin, role }] }))
    .mockResolvedValueOnce(response({ status: 'ok' }))
    .mockResolvedValueOnce(response({ version: '0.1.0', migrations: { appliedCount: 2, latestVersion: '0002' } }));
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows the setup form while unconfigured', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ configured: false, authenticated: false, role: null, csrfToken: null, passwordChangeRequired: false })));
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Kura einrichten' })).toBeInTheDocument();
  expect(screen.getByLabelText('Passwort')).toHaveAttribute('autocomplete', 'new-password');
});
it('shows dashboard status for an authenticated administrator', async () => {
  vi.stubGlobal('fetch', mockAuthenticated()); render(<App />);
  expect(await screen.findByText('Erreichbar')).toBeInTheDocument();
  expect(screen.getByText('Angewendete Migrationen: 2')).toBeInTheDocument();
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
  expect(await screen.findByRole('alert')).toHaveTextContent('Anmeldung fehlgeschlagen. Prüfen Sie Benutzername und Passwort.');
});
it('opens the create-user dialog for an administrator', async () => {
  vi.stubGlobal('fetch', mockAuthenticated()); render(<App />); await screen.findByText('Erreichbar'); fireEvent.click(screen.getByRole('button', { name: 'Benutzerverwaltung' })); fireEvent.click(await screen.findByRole('button', { name: 'Benutzer anlegen' }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.keyDown(window, { key: 'Escape' }); await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});
