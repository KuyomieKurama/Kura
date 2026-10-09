// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { SourceValidationView } from './SourceCheck.js';
import type { SourceValidation } from './api.js';

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const user = { id: 'u1', display_name: 'Alice', username: 'alice', role: 'user', status: 'active', created_at: '2026-01-01T00:00:00Z' };

type Status = Record<string, unknown>;
const noCookies: Status = { present: false, secretKeyConfigured: true };
const stored: Status = {
  present: true, secretKeyConfigured: true, cookieCount: 3, earliestExpiry: '2030-01-01T00:00:00.000Z', expired: false,
  updatedAt: '2026-06-01T10:00:00.000Z', lastUsedAt: null, lastResult: 'unknown'
};

/** The API of the account page; `state.status` is what GET /credentials/instagram answers next. */
function mockApi(state: { status: Status }) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (path.endsWith('/credentials/instagram')) {
      if (method === 'GET') return json(state.status);
      if (method === 'PUT') {
        state.status = stored;
        return json({ present: true, cookieCount: 3, droppedCount: 2, earliestExpiry: '2030-01-01T00:00:00.000Z' });
      }
      if (method === 'DELETE') {
        state.status = noCookies;
        return json(undefined, 204);
      }
    }
    if (path.endsWith('/auth/state')) return json({ configured: true, authenticated: true, role: 'user', csrfToken: 'csrf', passwordChangeRequired: false });
    if (path.endsWith('/api/v1/users')) return json({ users: [user] });
    if (path === '/healthz') return json({ status: 'ok' });
    if (path.endsWith('/api/v1/status')) return json({ version: '0.1.0', migrations: { appliedCount: 5, latestVersion: '0052' } });
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function openAccount() {
  render(<App />);
  await screen.findByText('Erreichbar');
  fireEvent.click(screen.getByRole('button', { name: 'Konto' }));
  return screen.findByRole('region', { name: 'Instagram' });
}

const instagramCalls = (fetch: ReturnType<typeof vi.fn>, method: string) =>
  fetch.mock.calls.filter(([input, init]) => String(input).endsWith('/credentials/instagram') && (init?.method ?? 'GET') === method);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows the Instagram section on the account page with instruction and risk notice', async () => {
  mockApi({ status: noCookies });
  const section = await openAccount();

  expect(within(section).getByText('Kura nutzt deine Instagram-Sitzung. Viele oder schnelle Abrufe können zu Sperren deines Kontos führen. Nutze ein eigenes Konto und lade nur Inhalte, die du laden darfst.')).toBeInTheDocument();
  expect(within(section).getByText('Exportiere die Cookies deines angemeldeten Browsers im Netscape-Format (cookies.txt), z. B. mit einer Browser-Erweiterung deiner Wahl.')).toBeInTheDocument();
  expect(await within(section).findByText('Es sind keine Instagram-Cookies hinterlegt.')).toBeInTheDocument();
  expect(within(section).getByLabelText('cookies.txt hochladen')).toHaveAttribute('accept', '.txt,text/plain');
  expect(section.textContent).not.toMatch(/[—–]/); // no em or en dashes
});

it('uploads the file as plain text and then shows the status without any cookie content', async () => {
  const fetch = mockApi({ status: noCookies });
  const section = await openAccount();
  await within(section).findByText('Es sind keine Instagram-Cookies hinterlegt.');

  const content = '# Netscape HTTP Cookie File\n.instagram.com\tTRUE\t/\tTRUE\t1900000000\tsessionid\tFAKE-VALUE\n';
  const input = within(section).getByLabelText('cookies.txt hochladen');
  fireEvent.change(input, { target: { files: [new File([content], 'cookies.txt', { type: 'text/plain' })] } });
  fireEvent.click(within(section).getByRole('button', { name: 'Hochladen' }));

  await waitFor(() => expect(instagramCalls(fetch, 'PUT')).toHaveLength(1));
  const [, init] = instagramCalls(fetch, 'PUT')[0]!;
  expect(init.body).toBe(content);
  expect(new Headers(init.headers).get('Content-Type')).toBe('text/plain; charset=utf-8');
  expect(new Headers(init.headers).get('X-Kura-CSRF')).toBe('csrf');

  const status = await within(section).findByLabelText('Status der Instagram-Cookies');
  expect(within(status).getByText('Cookies hinterlegt')).toBeInTheDocument();
  expect(within(status).getByText('Cookies: 3')).toBeInTheDocument();
  expect(within(status).getByText('Zuletzt benutzt: noch nie')).toBeInTheDocument();
  expect(within(section).getByText(/2 Cookies anderer Seiten wurden verworfen/)).toBeInTheDocument();
  expect(section.textContent).not.toContain('FAKE-VALUE');
});

it('refuses a file over 256 KiB without sending it', async () => {
  const fetch = mockApi({ status: noCookies });
  const section = await openAccount();
  await within(section).findByText('Es sind keine Instagram-Cookies hinterlegt.');

  const big = new File(['x'.repeat(256 * 1024 + 1)], 'cookies.txt', { type: 'text/plain' });
  fireEvent.change(within(section).getByLabelText('cookies.txt hochladen'), { target: { files: [big] } });
  fireEvent.click(within(section).getByRole('button', { name: 'Hochladen' }));

  expect(await within(section).findByText('Die Datei darf höchstens 256 KiB groß sein.')).toBeInTheDocument();
  expect(instagramCalls(fetch, 'PUT')).toHaveLength(0);
});

it('shows the server message when the upload is rejected', async () => {
  mockApi({ status: noCookies });
  const section = await openAccount();
  await within(section).findByText('Es sind keine Instagram-Cookies hinterlegt.');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/credentials/instagram') && init?.method === 'PUT') {
      return json({ error: { code: 'COOKIES_INVALID', message: 'Die Datei enthält kein Cookie "sessionid" für instagram.com.' } }, 400);
    }
    return json(noCookies);
  }));

  fireEvent.change(within(section).getByLabelText('cookies.txt hochladen'), { target: { files: [new File(['abc'], 'cookies.txt')] } });
  fireEvent.click(within(section).getByRole('button', { name: 'Hochladen' }));

  expect(await within(section).findByText(/kein Cookie "sessionid"/)).toBeInTheDocument();
});

it('asks for confirmation before deleting and then shows the empty state', async () => {
  const fetch = mockApi({ status: stored });
  const section = await openAccount();
  await within(section).findByLabelText('Status der Instagram-Cookies');

  fireEvent.click(within(section).getByRole('button', { name: 'Cookies löschen' }));
  const dialog = await screen.findByRole('dialog', { name: 'Instagram-Cookies löschen' });
  expect(instagramCalls(fetch, 'DELETE')).toHaveLength(0);

  fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(instagramCalls(fetch, 'DELETE')).toHaveLength(0);

  fireEvent.click(within(section).getByRole('button', { name: 'Cookies löschen' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Endgültig löschen' }));

  await waitFor(() => expect(instagramCalls(fetch, 'DELETE')).toHaveLength(1));
  expect(await within(section).findByText('Es sind keine Instagram-Cookies hinterlegt.')).toBeInTheDocument();
});

it('says "Anmeldung abgelaufen" when Instagram rejected the stored cookies', async () => {
  mockApi({ status: { ...stored, lastResult: 'auth_required', lastUsedAt: '2026-06-02T08:00:00.000Z' } });
  const section = await openAccount();
  const status = await within(section).findByLabelText('Status der Instagram-Cookies');
  expect(within(status).getByText('Anmeldung abgelaufen')).toBeInTheDocument();
  expect(within(status).getByText('Ergebnis: Instagram-Anmeldung abgelaufen: bitte Cookies neu hochladen')).toBeInTheDocument();
});

it('blocks the upload and explains why when the server has no secret key', async () => {
  mockApi({ status: { present: false, secretKeyConfigured: false } });
  const section = await openAccount();
  expect(await within(section).findByText(/KURA_SECRET_KEY/)).toBeInTheDocument();
  expect(within(section).getByRole('button', { name: 'Hochladen' })).toBeDisabled();
});

it('shows "Anmeldung nötig" for an Instagram profile without stored cookies, and not once cookies are stored', () => {
  const base = {
    supported: true, canonicalUrl: 'https://www.instagram.com/own_test/', platform: 'instagram', platformLabel: 'Instagram', targetKind: 'creator_feed',
    adapter: { id: 'gallery-dl', label: 'gallery-dl (Bilder und Beiträge)', availability: 'available', version: '1.32.16' },
    capabilities: { singlePost: true, creatorFeed: true, images: true, videos: true, pagination: true, resume: false, pageSnapshot: false, qualityVariants: false, authKind: 'cookies', authLabel: 'Cookies', presets: ['BEST_AVAILABLE'] },
    runnable: true, notices: []
  };
  const { rerender } = render(<SourceValidationView result={{ ...base, credentials: { platform: 'instagram', stored: false, loginNeeded: true } } as SourceValidation} />);
  expect(screen.getByText('Anmeldung nötig')).toBeInTheDocument();

  rerender(<SourceValidationView result={{ ...base, credentials: { platform: 'instagram', stored: true, loginNeeded: false } } as SourceValidation} />);
  expect(screen.queryByText('Anmeldung nötig')).not.toBeInTheDocument();
});
