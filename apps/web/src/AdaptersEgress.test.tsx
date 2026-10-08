// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App.js';

// R-09: when the operator has not confirmed an egress barrier, the adapter overview says why yt-dlp and
// gallery-dl are not available. The text comes from the API; the page must show it as it is.

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const message = 'Externe Werkzeuge gesperrt: Egress-Schutz nicht bestätigt. yt-dlp (Videos) wird nicht gestartet, bis der Administrator den Netzwerkschutz für den Worker eingerichtet und bestätigt hat.';
const capabilities = {
  singlePost: true, creatorFeed: false, images: false, videos: true, pagination: false, resume: false,
  pageSnapshot: false, qualityVariants: false, authKind: 'none', authLabel: 'Keine Anmeldung', presets: ['BEST_AVAILABLE']
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('shows the egress block reason in the adapter overview', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/adapters')) {
      return json({
        adapters: [{
          id: 'yt-dlp', label: 'yt-dlp (Videos)', version: null, sourceTypes: [{ id: 'youtube', label: 'YouTube' }], capabilities,
          availability: 'unavailable', reasonCode: 'EGRESS_NOT_CONFIRMED', message, checkedAt: null, disabledByAdministrator: false
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

  expect(await screen.findByText(/Externe Werkzeuge gesperrt: Egress-Schutz nicht bestätigt/)).toBeInTheDocument();
  expect(screen.getByText(/Nicht verfügbar/)).toBeInTheDocument();
});
