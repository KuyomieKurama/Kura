// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App.js';
import type { VersionInfo } from './api.js';

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const person = { id: 'u1', display_name: 'Alex', username: 'alex', role: 'admin', status: 'active', created_at: '2026-01-01T00:00:00Z' };

const outdated: VersionInfo = {
  version: '0.2.0', commit: 'abcdef1', status: 'outdated', latestVersion: '0.3.0', latestTag: 'v0.3.0',
  checkedAt: '2026-10-11T10:00:00.000Z', attemptedAt: '2026-10-11T10:00:00.000Z', reason: null, hasRelease: true,
  releaseUrl: 'https://github.com/KuyomieKurama/Kura/releases/tag/v0.3.0', releaseNotes: 'Neu: Versionsprüfung.\nZweite Zeile.',
  channel: 'stable', repository: 'KuyomieKurama/Kura', checkEnabled: true, noticeDismissed: false
};
const current: VersionInfo = { ...outdated, status: 'current', version: '0.3.0', releaseNotes: null, hasRelease: false };

interface Calls { dismissed: string[]; checks: number }

/** The API of a signed-in session with a configurable answer for GET /version. */
function mockApi(role: 'admin' | 'user', version: VersionInfo | 'fail', afterCheck?: VersionInfo): Calls {
  const calls: Calls = { dismissed: [], checks: 0 };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (path.endsWith('/auth/state')) return json({ configured: true, authenticated: true, role, csrfToken: 'csrf', passwordChangeRequired: false });
    if (path.endsWith('/api/v1/users')) return json({ users: [{ ...person, role }] });
    if (path === '/healthz') return json({ status: 'ok' });
    if (path.endsWith('/api/v1/status')) return json({ version: '0.2.0', migrations: { appliedCount: 5, latestVersion: '0069' } });
    if (path.endsWith('/api/v1/version') && method === 'GET') return version === 'fail' ? json({ error: { message: 'kaputt' } }, 500) : json(version);
    if (path.endsWith('/api/v1/version/dismiss') && method === 'POST') {
      calls.dismissed.push(String(JSON.parse(String(init?.body)).version));
      return { ok: true, status: 204, json: async () => undefined };
    }
    if (path.endsWith('/api/v1/version/check') && method === 'POST') {
      calls.checks += 1;
      return json(afterCheck ?? version);
    }
    return json({}, 404);
  }));
  return calls;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openVersionPage() {
  fireEvent.click(await screen.findByRole('button', { name: /^Kura 0\.\d\.\d/ }));
  return screen.findByRole('heading', { name: 'Über Kura', level: 1 });
}

it('shows the version in the sidebar footer for a normal user, with a quiet marker and no notice strip', async () => {
  mockApi('user', outdated);
  render(<App />);
  const link = await screen.findByRole('button', { name: /Kura 0\.2\.0/ });
  expect(within(link).getByText('Kura 0.2.0')).toBeInTheDocument();
  expect(within(link).getByText('Neue Version 0.3.0')).toBeInTheDocument();
  expect(screen.queryByText('Kura 0.3.0 ist verfügbar. Du nutzt 0.2.0.')).not.toBeInTheDocument();
});

it('shows no marker when the installation is up to date', async () => {
  mockApi('user', current);
  render(<App />);
  const link = await screen.findByRole('button', { name: 'Kura 0.3.0' });
  expect(within(link).queryByText(/Neue Version/)).not.toBeInTheDocument();
});

it('shows a notice strip to an administrator when the version is outdated', async () => {
  mockApi('admin', outdated);
  render(<App />);
  expect(await screen.findByText('Kura 0.3.0 ist verfügbar. Du nutzt 0.2.0.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Details' })).toBeInTheDocument();
});

it('shows no strip to an administrator when the installation is up to date', async () => {
  mockApi('admin', current);
  render(<App />);
  await screen.findByRole('button', { name: 'Kura 0.3.0' });
  expect(screen.queryByRole('button', { name: 'Details' })).not.toBeInTheDocument();
});

it('leads from the strip to the details page', async () => {
  mockApi('admin', outdated);
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
  expect(await screen.findByRole('heading', { name: 'Über Kura', level: 1 })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Details' })).not.toBeInTheDocument();
});

it('remembers the dismissal for the offered version on the server and hides the strip', async () => {
  const calls = mockApi('admin', outdated);
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Ausblenden' }));
  await waitFor(() => expect(screen.queryByText('Kura 0.3.0 ist verfügbar. Du nutzt 0.2.0.')).not.toBeInTheDocument());
  expect(calls.dismissed).toEqual(['0.3.0']);
  // The sidebar marker stays: hiding the strip does not hide the fact.
  expect(screen.getByText('Neue Version 0.3.0')).toBeInTheDocument();
});

it('keeps the strip hidden after a reload when the server says it was dismissed for this version', async () => {
  mockApi('admin', { ...outdated, noticeDismissed: true });
  render(<App />);
  await screen.findByRole('button', { name: /Kura 0\.2\.0/ });
  expect(screen.queryByText('Kura 0.3.0 ist verfügbar. Du nutzt 0.2.0.')).not.toBeInTheDocument();
});

it('shows the strip again for a newer version than the dismissed one', async () => {
  // The server reports noticeDismissed per offered version: a newer version arrives as not dismissed.
  mockApi('admin', { ...outdated, latestVersion: '0.4.0', latestTag: 'v0.4.0', noticeDismissed: false });
  render(<App />);
  expect(await screen.findByText('Kura 0.4.0 ist verfügbar. Du nutzt 0.2.0.')).toBeInTheDocument();
});

it('gives an administrator the exact commands, the backup hint, the release link and the no-self-update statement', async () => {
  mockApi('admin', outdated);
  render(<App />);
  await openVersionPage();
  const dd = (term: string) => screen.getByText(term).nextElementSibling as HTMLElement;
  expect(dd('Version')).toHaveTextContent('0.2.0');
  expect(dd('Commit')).toHaveTextContent('abcdef1');
  expect(dd('Status')).toHaveTextContent('Veraltet');
  expect(dd('Neueste Version')).toHaveTextContent('0.3.0');
  expect(dd('Letzte Prüfung')).not.toHaveTextContent('noch nie');
  expect(screen.getByText('~/bin/kura-deploy.sh v0.3.0')).toBeInTheDocument();
  expect(screen.getByText(/cp ~\/work\/Kura\/deploy\/kura-deploy\.sh ~\/bin\//)).toBeInTheDocument();
  expect(screen.getByText(/kura-pgdata/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Release auf GitHub ansehen/ })).toHaveAttribute('href', 'https://github.com/KuyomieKurama/Kura/releases/tag/v0.3.0');
  expect(screen.getByText(/Kura aktualisiert sich nicht selbst und hat keinen Knopf, der ein Update startet/)).toBeInTheDocument();
  expect(screen.getByText(/Neu in 0\.3\.0/)).toBeInTheDocument();
});

it('has no button that starts an update', async () => {
  mockApi('admin', outdated);
  render(<App />);
  await openVersionPage();
  const names = screen.getAllByRole('button').map((button) => button.textContent ?? '');
  expect(names.filter((name) => /update|upgrade|installier|aktualisier|deploy/i.test(name))).toEqual([]);
});

it('shows a normal user the status and that the administrator updates Kura, without commands or check button', async () => {
  mockApi('user', outdated);
  render(<App />);
  await openVersionPage();
  expect(screen.getByText(/Die Administration aktualisiert Kura\./)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Jetzt prüfen' })).not.toBeInTheDocument();
  expect(screen.queryByText(/kura-deploy\.sh/)).not.toBeInTheDocument();
  expect(screen.queryByText(/kura-pgdata/)).not.toBeInTheDocument();
});

it('lets an administrator check now and shows the new result', async () => {
  const calls = mockApi('admin', outdated, { ...outdated, status: 'current', version: '0.2.0', latestVersion: '0.2.0', latestTag: 'v0.2.0' });
  render(<App />);
  await openVersionPage();
  fireEvent.click(screen.getByRole('button', { name: 'Jetzt prüfen' }));
  await waitFor(() => expect(screen.getByText('Status').nextElementSibling).toHaveTextContent('Aktuell'));
  expect(calls.checks).toBe(1);
  expect(screen.queryByText('~/bin/kura-deploy.sh v0.2.0')).not.toBeInTheDocument();
});

it('shows release notes as text, never as markup', async () => {
  mockApi('admin', { ...outdated, releaseNotes: '<img src=x onerror="alert(1)"> **fett** <script>alert(1)</script>' });
  const { container } = render(<App />);
  await openVersionPage();
  expect(screen.getByText(/<img src=x onerror="alert\(1\)">/)).toBeInTheDocument();
  expect(container.querySelector('img, script')).toBeNull();
});

it('does not link to an address outside GitHub and prints no command for an unsafe tag', async () => {
  mockApi('admin', { ...outdated, releaseUrl: 'javascript:alert(1)', latestTag: 'v1.0.0; rm -rf ~' });
  render(<App />);
  await openVersionPage();
  expect(screen.queryByRole('link', { name: /GitHub/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/rm -rf/)).not.toBeInTheDocument();
  expect(screen.getByText(/keinen Befehl/)).toBeInTheDocument();
});

it('says plainly when the check is switched off and offers no check button', async () => {
  mockApi('admin', {
    ...outdated, status: 'disabled', latestVersion: null, latestTag: null, checkedAt: null, hasRelease: false, releaseUrl: null, releaseNotes: null,
    checkEnabled: false, reason: 'Die Versionsprüfung ist ausgeschaltet (KURA_UPDATE_CHECK=false). Es werden keine Anfragen an GitHub gesendet.'
  });
  render(<App />);
  await openVersionPage();
  expect(screen.getByText('Status').nextElementSibling).toHaveTextContent('Deaktiviert');
  expect(screen.getByText(/ausgeschaltet/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Jetzt prüfen' })).not.toBeInTheDocument();
  expect(screen.queryByText(/kura-deploy\.sh/)).not.toBeInTheDocument();
});

it('shows the reason when the status is unknown', async () => {
  mockApi('admin', { ...outdated, status: 'unknown', latestVersion: null, latestTag: null, checkedAt: null, hasRelease: false, releaseUrl: null, releaseNotes: null, reason: 'GitHub ist nicht erreichbar.' });
  render(<App />);
  await openVersionPage();
  expect(screen.getByText('GitHub ist nicht erreichbar.')).toBeInTheDocument();
  expect(screen.getByText('Letzte Prüfung').nextElementSibling).toHaveTextContent('noch nie');
});

it('is reachable from the account page', async () => {
  mockApi('user', current);
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Konto' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Version und Update' }));
  expect(await screen.findByRole('heading', { name: 'Über Kura', level: 1 })).toBeInTheDocument();
});

it('works without version information when the request fails', async () => {
  mockApi('admin', 'fail');
  render(<App />);
  expect(await screen.findByText('Erreichbar')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Kura 0/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Details' })).not.toBeInTheDocument();
});

it('uses neither em dashes nor emoji on the version page', async () => {
  mockApi('admin', outdated);
  const { container } = render(<App />);
  await openVersionPage();
  const text = container.textContent ?? '';
  expect(text).not.toMatch(/[\u2014\u2013]/);
  expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
});
