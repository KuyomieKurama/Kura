// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { SourceValidationView } from './SourceCheck.js';
import type { CredentialPlatform, SourceValidation } from './api.js';

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const user = { id: 'u1', display_name: 'Alice', username: 'alice', role: 'user', status: 'active', created_at: '2026-01-01T00:00:00Z' };

type Status = Record<string, unknown>;
const kinds: Record<CredentialPlatform, 'cookies' | 'token'> = { instagram: 'cookies', patreon: 'cookies', pixiv: 'token', youtube: 'cookies' };
const absent = (platform: CredentialPlatform): Status => ({ platform, kind: kinds[platform], present: false });
const storedStatus = (platform: CredentialPlatform, extra: Status = {}): Status => ({
  platform, kind: kinds[platform], present: true, cookieCount: kinds[platform] === 'token' ? 1 : 3, earliestExpiry: kinds[platform] === 'token' ? null : '2030-01-01T00:00:00.000Z',
  expired: false, updatedAt: '2026-06-01T10:00:00.000Z', lastUsedAt: null, lastResult: 'unknown', ...extra
});

interface Api {
  statuses: Record<CredentialPlatform, Status>;
  secretKeyConfigured: boolean;
}

function freshApi(overrides: Partial<Record<CredentialPlatform, Status>> = {}, secretKeyConfigured = true): Api {
  return {
    secretKeyConfigured,
    statuses: { instagram: absent('instagram'), patreon: absent('patreon'), pixiv: absent('pixiv'), youtube: absent('youtube'), ...overrides }
  };
}

/** The API of the account page. A PUT stores the platform, a DELETE empties it. */
function mockApi(state: Api, rejectUpload?: { code: string; message: string }) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (path.endsWith('/api/v1/credentials') && method === 'GET') {
      return json({ secretKeyConfigured: state.secretKeyConfigured, credentials: Object.values(state.statuses) });
    }
    const match = /\/credentials\/(instagram|patreon|pixiv|youtube)$/.exec(path);
    if (match) {
      const platform = match[1] as CredentialPlatform;
      if (method === 'PUT') {
        if (rejectUpload) return json({ error: rejectUpload }, 400);
        state.statuses[platform] = storedStatus(platform);
        return json({ present: true, cookieCount: kinds[platform] === 'token' ? 1 : 3, droppedCount: kinds[platform] === 'token' ? 0 : 2, earliestExpiry: null });
      }
      if (method === 'DELETE') {
        state.statuses[platform] = absent(platform);
        return json(undefined, 204);
      }
    }
    if (path.endsWith('/auth/state')) return json({ configured: true, authenticated: true, role: 'user', csrfToken: 'csrf', passwordChangeRequired: false });
    if (path.endsWith('/api/v1/users')) return json({ users: [user] });
    if (path === '/healthz') return json({ status: 'ok' });
    if (path.endsWith('/api/v1/status')) return json({ version: '0.1.0', migrations: { appliedCount: 5, latestVersion: '0053' } });
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function openAccount(platform: string = 'Instagram') {
  render(<App />);
  await screen.findByText('Erreichbar');
  fireEvent.click(screen.getByRole('button', { name: /^Konto:/ }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Konto' }));
  return screen.findByRole('region', { name: platform });
}

const callsTo = (fetch: ReturnType<typeof vi.fn>, platform: string, method: string) =>
  fetch.mock.calls.filter(([input, init]) => String(input).endsWith(`/credentials/${platform}`) && (init?.method ?? 'GET') === method);

const COOKIES = '# Netscape HTTP Cookie File\n.instagram.com\tTRUE\t/\tTRUE\t1900000000\tsessionid\tFAKE-VALUE\n';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows the "Zugänge" section with one row per platform, each with instruction and risk notice', async () => {
  mockApi(freshApi());
  const section = await openAccount();

  const all = screen.getByRole('region', { name: 'Zugänge' });
  for (const platform of ['Instagram', 'Patreon', 'Pixiv', 'YouTube']) expect(within(all).getByRole('region', { name: platform })).toBeInTheDocument();

  expect(within(section).getByText('Kura nutzt deine Instagram-Sitzung. Viele oder schnelle Abrufe können zu Sperren deines Kontos führen. Nutze ein eigenes Konto und lade nur Inhalte, die du laden darfst.')).toBeInTheDocument();
  expect(within(section).getByText('Exportiere die Cookies deines angemeldeten Browsers im Netscape-Format (cookies.txt), z. B. mit einer Browser-Erweiterung deiner Wahl.')).toBeInTheDocument();
  expect(await within(section).findByText('Es sind keine Instagram-Cookies hinterlegt.')).toBeInTheDocument();
  expect(within(section).getByLabelText('cookies.txt hochladen')).toHaveAttribute('accept', '.txt,text/plain');

  const patreon = within(all).getByRole('region', { name: 'Patreon' });
  expect(within(patreon).getByText(/Kura nutzt deine Patreon-Sitzung/)).toBeInTheDocument();
  expect(within(patreon).getByText(/Cookie "session_id" von patreon.com/)).toBeInTheDocument();
  expect(within(patreon).getByText('Es sind keine Patreon-Cookies hinterlegt.')).toBeInTheDocument();

  expect(all.textContent).not.toMatch(/[—–]/); // no em or en dashes
});

it('explains in plain German how to get the Pixiv token with gallery-dl oauth:pixiv', async () => {
  mockApi(freshApi());
  const pixiv = await openAccount('Pixiv');

  expect(within(pixiv).getByText(/nicht mit Cookies an, sondern mit einem Token/)).toBeInTheDocument();
  expect(within(pixiv).getByText('Gib ein: gallery-dl oauth:pixiv')).toBeInTheDocument();
  expect(within(pixiv).getByText(/lange Zeichenfolge/)).toBeInTheDocument();
  expect(within(pixiv).getByText(/Das Token gibt Zugriff auf dein Pixiv-Konto/)).toBeInTheDocument();
  expect(within(pixiv).getByText('Es ist kein Pixiv-Token hinterlegt.')).toBeInTheDocument();
  const field = within(pixiv).getByLabelText('Pixiv-Token');
  expect(field).toHaveAttribute('type', 'password');
  expect(field).toHaveAttribute('autocomplete', 'off');
  expect(pixiv.textContent).not.toMatch(/[—–]/);
});

it('says that the YouTube login is optional', async () => {
  mockApi(freshApi());
  const youtube = await openAccount('YouTube');
  expect(within(youtube).getByText(/Optional: Öffentliche Videos laden auch ohne Anmeldung/)).toBeInTheDocument();
  expect(within(youtube).getByText(/Es sind keine YouTube-Cookies hinterlegt. Das ist in Ordnung, die Anmeldung ist optional./)).toBeInTheDocument();
});

it('uploads the file as plain text and then shows the status without any cookie content', async () => {
  const fetch = mockApi(freshApi());
  const section = await openAccount();
  await within(section).findByText('Es sind keine Instagram-Cookies hinterlegt.');

  fireEvent.change(within(section).getByLabelText('cookies.txt hochladen'), { target: { files: [new File([COOKIES], 'cookies.txt', { type: 'text/plain' })] } });
  fireEvent.click(within(section).getByRole('button', { name: 'Hochladen' }));

  await waitFor(() => expect(callsTo(fetch, 'instagram', 'PUT')).toHaveLength(1));
  const [, init] = callsTo(fetch, 'instagram', 'PUT')[0]!;
  expect(init.body).toBe(COOKIES);
  expect(new Headers(init.headers).get('Content-Type')).toBe('text/plain; charset=utf-8');
  expect(new Headers(init.headers).get('X-Kura-CSRF')).toBe('csrf');

  const status = await within(section).findByRole('group', { name: 'Status der Instagram-Cookies' });
  expect(within(status).getByText('Cookies: 3')).toBeInTheDocument();
  expect(within(status).getByText('Zuletzt benutzt: noch nie')).toBeInTheDocument();
  expect(within(section).getByText('Cookies hinterlegt')).toBeInTheDocument();
  expect(within(section).getByText(/2 Cookies anderer Seiten wurden verworfen/)).toBeInTheDocument();
  expect(section.textContent).not.toContain('FAKE-VALUE');
});

it('uploads Patreon cookies to the Patreon route and names the domain', async () => {
  const fetch = mockApi(freshApi());
  const section = await openAccount('Patreon');
  await within(section).findByText('Es sind keine Patreon-Cookies hinterlegt.');

  fireEvent.change(within(section).getByLabelText('cookies.txt hochladen'), { target: { files: [new File([COOKIES], 'cookies.txt')] } });
  fireEvent.click(within(section).getByRole('button', { name: 'Hochladen' }));

  await waitFor(() => expect(callsTo(fetch, 'patreon', 'PUT')).toHaveLength(1));
  expect(callsTo(fetch, 'instagram', 'PUT')).toHaveLength(0);
  expect(await within(section).findByText(/Gespeichert: 3 Cookies von patreon.com/)).toBeInTheDocument();
  expect(await within(section).findByRole('group', { name: 'Status der Patreon-Cookies' })).toBeInTheDocument();
});

it('saves the Pixiv token as plain text, trims it, and never shows it again', async () => {
  const fetch = mockApi(freshApi());
  const section = await openAccount('Pixiv');
  await within(section).findByText('Es ist kein Pixiv-Token hinterlegt.');

  fireEvent.change(within(section).getByLabelText('Pixiv-Token'), { target: { value: '  FAKE-pixiv_refresh-token-for-tests-ONLY-0123 \n' } });
  fireEvent.click(within(section).getByRole('button', { name: 'Speichern' }));

  await waitFor(() => expect(callsTo(fetch, 'pixiv', 'PUT')).toHaveLength(1));
  const [, init] = callsTo(fetch, 'pixiv', 'PUT')[0]!;
  expect(init.body).toBe('FAKE-pixiv_refresh-token-for-tests-ONLY-0123');
  expect(new Headers(init.headers).get('Content-Type')).toBe('text/plain; charset=utf-8');

  const status = await within(section).findByRole('group', { name: 'Status des Pixiv-Tokens' });
  expect(within(section).getByText('Token hinterlegt')).toBeInTheDocument();
  expect(within(status).queryByText(/Cookies:/)).not.toBeInTheDocument();
  expect(within(status).getByText('Zuletzt benutzt: noch nie')).toBeInTheDocument();
  expect(section.textContent).not.toContain('FAKE-pixiv');
  expect((within(section).getByLabelText('Neues Pixiv-Token') as HTMLInputElement).value).toBe('');
});

it('refuses an empty Pixiv token and a file over 256 KiB without sending anything', async () => {
  const fetch = mockApi(freshApi());
  const section = await openAccount('Pixiv');
  await within(section).findByText('Es ist kein Pixiv-Token hinterlegt.');
  fireEvent.click(within(section).getByRole('button', { name: 'Speichern' }));
  expect(await within(section).findByText('Bitte füge das Token ein.')).toBeInTheDocument();
  expect(callsTo(fetch, 'pixiv', 'PUT')).toHaveLength(0);

  const instagram = screen.getByRole('region', { name: 'Instagram' });
  const big = new File(['x'.repeat(256 * 1024 + 1)], 'cookies.txt', { type: 'text/plain' });
  fireEvent.change(within(instagram).getByLabelText('cookies.txt hochladen'), { target: { files: [big] } });
  fireEvent.click(within(instagram).getByRole('button', { name: 'Hochladen' }));
  expect(await within(instagram).findByText('Die Datei darf höchstens 256 KiB groß sein.')).toBeInTheDocument();
  expect(callsTo(fetch, 'instagram', 'PUT')).toHaveLength(0);
});

it('shows the server message when the upload is rejected', async () => {
  mockApi(freshApi(), { code: 'COOKIES_INVALID', message: 'Die Datei enthält kein Cookie "session_id" für patreon.com.' });
  const section = await openAccount('Patreon');
  await within(section).findByText('Es sind keine Patreon-Cookies hinterlegt.');

  fireEvent.change(within(section).getByLabelText('cookies.txt hochladen'), { target: { files: [new File(['abc'], 'cookies.txt')] } });
  fireEvent.click(within(section).getByRole('button', { name: 'Hochladen' }));

  expect(await within(section).findByText(/kein Cookie "session_id"/)).toBeInTheDocument();
});

it('asks for confirmation before deleting and then shows the empty state', async () => {
  const fetch = mockApi(freshApi({ instagram: storedStatus('instagram') }));
  const section = await openAccount();
  await within(section).findByRole('group', { name: 'Status der Instagram-Cookies' });

  fireEvent.click(within(section).getByRole('button', { name: 'Cookies löschen' }));
  const dialog = await screen.findByRole('dialog', { name: 'Instagram-Cookies löschen' });
  expect(callsTo(fetch, 'instagram', 'DELETE')).toHaveLength(0);

  fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(callsTo(fetch, 'instagram', 'DELETE')).toHaveLength(0);

  fireEvent.click(within(section).getByRole('button', { name: 'Cookies löschen' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Endgültig löschen' }));

  await waitFor(() => expect(callsTo(fetch, 'instagram', 'DELETE')).toHaveLength(1));
  expect(await within(section).findByText('Es sind keine Instagram-Cookies hinterlegt.')).toBeInTheDocument();
});

it('deletes a Pixiv token through its own dialog', async () => {
  const fetch = mockApi(freshApi({ pixiv: storedStatus('pixiv') }));
  const section = await openAccount('Pixiv');
  await within(section).findByRole('group', { name: 'Status des Pixiv-Tokens' });

  fireEvent.click(within(section).getByRole('button', { name: 'Token löschen' }));
  const dialog = await screen.findByRole('dialog', { name: 'Pixiv-Token löschen' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Endgültig löschen' }));

  await waitFor(() => expect(callsTo(fetch, 'pixiv', 'DELETE')).toHaveLength(1));
  expect(await within(section).findByText('Es ist kein Pixiv-Token hinterlegt.')).toBeInTheDocument();
});

it('says "Anmeldung abgelaufen" when a platform rejected the stored login', async () => {
  mockApi(freshApi({
    instagram: storedStatus('instagram', { lastResult: 'auth_required', lastUsedAt: '2026-06-02T08:00:00.000Z' }),
    pixiv: storedStatus('pixiv', { lastResult: 'auth_required' })
  }));
  const instagram = await openAccount();
  const status = await within(instagram).findByRole('group', { name: 'Status der Instagram-Cookies' });
  expect(within(instagram).getByText('Anmeldung abgelaufen')).toBeInTheDocument();
  expect(within(status).getByText('Ergebnis: Instagram-Anmeldung abgelaufen: bitte Cookies neu hochladen')).toBeInTheDocument();

  const pixiv = screen.getByRole('region', { name: 'Pixiv' });
  expect(within(pixiv).getByText('Ergebnis: Pixiv-Anmeldung abgelaufen: bitte Token neu hinterlegen')).toBeInTheDocument();
});

it('blocks every upload and explains why when the server has no secret key', async () => {
  mockApi(freshApi({}, false));
  const section = await openAccount();
  expect(await screen.findByText(/KURA_SECRET_KEY/)).toBeInTheDocument();
  for (const platform of ['Instagram', 'Patreon', 'YouTube']) {
    expect(within(screen.getByRole('region', { name: platform })).getByRole('button', { name: 'Hochladen' })).toBeDisabled();
  }
  expect(within(screen.getByRole('region', { name: 'Pixiv' })).getByRole('button', { name: 'Speichern' })).toBeDisabled();
  expect(section).toBeInTheDocument();
});

it.each([
  ['instagram', 'Instagram', 'creator_feed'],
  ['patreon', 'Patreon', 'creator_feed'],
  ['pixiv', 'Pixiv', 'post']
] as const)('shows "Anmeldung nötig" for a %s address without stored login, and not once it is stored', (platform, platformLabel, targetKind) => {
  const base = {
    supported: true, canonicalUrl: `https://www.${platform}.com/own_test/`, platform, platformLabel, targetKind,
    adapter: { id: 'gallery-dl', label: 'gallery-dl (Bilder und Beiträge)', availability: 'available', version: '1.32.16' },
    capabilities: { singlePost: true, creatorFeed: true, images: true, videos: true, pagination: true, resume: false, pageSnapshot: false, qualityVariants: false, authKind: 'cookies', authLabel: 'Cookies', presets: ['BEST_AVAILABLE'] },
    runnable: true, notices: []
  };
  const { rerender } = render(<SourceValidationView result={{ ...base, credentials: { platform, stored: false, loginNeeded: true } } as SourceValidation} />);
  expect(screen.getByText('Anmeldung nötig')).toBeInTheDocument();

  rerender(<SourceValidationView result={{ ...base, credentials: { platform, stored: true, loginNeeded: false } } as SourceValidation} />);
  expect(screen.queryByText('Anmeldung nötig')).not.toBeInTheDocument();
});
