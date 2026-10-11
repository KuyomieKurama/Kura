// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App.js';

// Keyboard path and accessibility structure of the shell. Real focus rings and tab order in a browser are
// checked by tests/ui-shots/keyboard.mjs; jsdom cannot evaluate CSS.

const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const admin = { id: 'a1', display_name: 'Admin', username: 'admin', role: 'admin', status: 'active', created_at: '2026-01-01T00:00:00Z' };

function stubApi(authenticated: boolean) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/auth/state')) {
      return response({ configured: true, authenticated, role: authenticated ? 'admin' : null, csrfToken: 'csrf', passwordChangeRequired: false });
    }
    if (path.endsWith('/api/v1/users')) return response({ users: [admin] });
    if (path === '/healthz') return response({ status: 'ok' });
    if (path.endsWith('/api/v1/status')) return response({ version: '0.1.0', migrations: { appliedCount: 2, latestVersion: '0002' } });
    if (path.endsWith('/history')) return response({ runs: [], posts: [] });
    throw new Error(`Unexpected request: ${path}`);
  }));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('offers a skip link as the first control and a main landmark to jump to', async () => {
  stubApi(true);
  render(<App />);
  await screen.findByText('Erreichbar');
  const skip = screen.getByRole('link', { name: 'Zum Inhalt springen' });
  expect(skip).toHaveAttribute('href', '#main');
  expect(document.querySelector('#main')).toBe(screen.getByRole('main'));
  const focusable = [...document.querySelectorAll<HTMLElement>('a[href], button, input, select')];
  expect(focusable[0]).toBe(skip);
});

it('marks the active page in the navigation and moves focus to the content when navigating', async () => {
  stubApi(true);
  render(<App />);
  await screen.findByText('Erreichbar');
  const navigation = screen.getByRole('navigation', { name: 'Hauptnavigation' });
  expect(within(navigation).getByRole('button', { name: 'Übersicht' })).toHaveAttribute('aria-current', 'page');
  const history = within(navigation).getByRole('button', { name: 'Verlauf' });
  history.focus();
  expect(history).toHaveFocus();
  fireEvent.click(history);
  expect(await screen.findByRole('heading', { level: 1, name: 'Verlauf' })).toBeInTheDocument();
  expect(history).toHaveAttribute('aria-current', 'page');
  expect(within(navigation).getByRole('button', { name: 'Übersicht' })).not.toHaveAttribute('aria-current');
  expect(screen.getByRole('main')).toHaveFocus();
  expect(document.title).toBe('Verlauf | Kura');
});

it('uses a bottom navigation with a "Mehr" sheet on small screens; Escape closes the sheet and returns the focus', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: !query.includes('min-width: 1024px'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
  stubApi(true);
  render(<App />);
  await screen.findByText('Erreichbar');
  const navigation = screen.getByRole('navigation', { name: 'Hauptnavigation' });
  expect(screen.getAllByRole('navigation')).toHaveLength(1);
  const more = within(navigation).getByRole('button', { name: 'Mehr' });
  more.focus();
  fireEvent.click(more);
  const sheet = await screen.findByRole('dialog', { name: 'Mehr' });
  expect(within(sheet).getByRole('button', { name: 'Abmelden' })).toBeInTheDocument();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(more).toHaveFocus();
});

it('gives every field of the login form a label, and the setup password field its helper text', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ configured: false, authenticated: false, role: null, csrfToken: null, passwordChangeRequired: false })));
  render(<App />);
  await screen.findByRole('heading', { name: 'Willkommen bei Kura' });
  for (const name of ['Anzeigename', 'Benutzername', 'Passwort', 'Passwort wiederholen', 'Einrichtungs-Token']) {
    expect(screen.getByLabelText(name)).toBeInTheDocument();
  }
  const password = screen.getByLabelText('Passwort');
  const hint = document.getElementById(password.getAttribute('aria-describedby')!);
  expect(hint).toHaveTextContent('Mindestens 12 Zeichen');
  expect(screen.getByRole('main')).toBeInTheDocument();
});

it('describes a failed form with an alert that is announced, not a toast', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(response({ configured: true, authenticated: false, role: null, csrfToken: null, passwordChangeRequired: false }))
    .mockResolvedValueOnce(response({ error: { message: 'ignored' } }, 401));
  vi.stubGlobal('fetch', fetch);
  render(<App />);
  await screen.findByRole('heading', { name: 'Anmelden' });
  fireEvent.change(screen.getByLabelText('Benutzername'), { target: { value: 'a' } });
  fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'a' } });
  fireEvent.submit(screen.getByLabelText('Passwort').closest('form')!);
  expect(await screen.findByRole('alert')).toHaveTextContent('Das hat nicht geklappt');
});

it('gives table headers a scope and every row action a text name', async () => {
  stubApi(true);
  render(<App />);
  await screen.findByText('Erreichbar');
  fireEvent.click(screen.getByRole('button', { name: 'Benutzerverwaltung' }));
  const table = await screen.findByRole('table', { name: 'Benutzerverwaltung' });
  for (const header of within(table).getAllByRole('columnheader')) expect(header).toHaveAttribute('scope', 'col');
  for (const button of within(table).queryAllByRole('button')) expect(button).toHaveAccessibleName(/\S/);
});
