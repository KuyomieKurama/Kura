// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App.js';

// gallery-dl serves Instagram profiles but Pixiv and Patreon only as single posts. The adapter overview must
// not tell users that Pixiv can fetch a whole creator, so it lists the abilities per platform when they differ.

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const base = { singlePost: true, resume: false, pageSnapshot: false, qualityVariants: false, presets: ['BEST_AVAILABLE'] };
const instagram = { ...base, creatorFeed: true, images: true, videos: true, pagination: true, authKind: 'cookies', authLabel: 'Cookies' };
const pixiv = { ...base, creatorFeed: false, images: true, videos: false, pagination: false, authKind: 'none', authLabel: 'Keine Anmeldung' };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('lists the abilities of Instagram and Pixiv separately when they differ', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/adapters')) {
      return json({
        adapters: [{
          id: 'gallery-dl', label: 'gallery-dl (Bilder und Beiträge)', version: '1.32.16', capabilities: instagram,
          sourceTypes: [{ id: 'pixiv', label: 'Pixiv', capabilities: pixiv }, { id: 'instagram', label: 'Instagram', capabilities: instagram }],
          availability: 'available', reasonCode: null, message: null, checkedAt: null, disabledByAdministrator: false
        }]
      });
    }
    if (path.endsWith('/subscriptions')) return json({ subscriptions: [] });
    if (path.endsWith('/auth/state')) return json({ configured: true, authenticated: true, role: 'user', csrfToken: 'csrf', passwordChangeRequired: false });
    if (path.endsWith('/api/v1/users')) return json({ users: [] });
    if (path === '/healthz') return json({ status: 'ok' });
    if (path.endsWith('/api/v1/status')) return json({ version: '0.1.0', migrations: { appliedCount: 5, latestVersion: '0051' } });
    throw new Error(`Unexpected request: ${path}`);
  }));

  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Abonnements' }));
  const details = (await screen.findByText('Unterstützte Quellen und Adapter')).closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));

  const lists = await screen.findAllByRole('list', { name: 'Fähigkeiten' });
  expect(lists).toHaveLength(2);
  const [pixivList, instagramList] = lists;
  expect(pixivList).toHaveTextContent('Kein ganzer Kanal, keine Playlist');
  expect(pixivList).toHaveTextContent('Anmeldung: Keine Anmeldung');
  expect(instagramList).toHaveTextContent('Ganzer Kanal oder Creator');
  expect(instagramList).toHaveTextContent('Videos');
  expect(instagramList).toHaveTextContent('Anmeldung: Cookies');
});
