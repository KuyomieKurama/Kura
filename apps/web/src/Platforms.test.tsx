// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AdaptersPanel } from './Adapters.js';
import type { HistoryAsset, HistoryPost, SourceValidation } from './api.js';
import { LedgerEntry } from './Ledger.js';
import { SourceValidationView } from './SourceCheck.js';

// P2: the adapter overview names the kinds of address per platform, a livestream that is running is shown as "noch
// nicht verfügbar" and not as a failure, and the address check explains YouTube and Pornhub lists.

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const base = { singlePost: true, resume: false, pageSnapshot: false, qualityVariants: false, presets: ['BEST_AVAILABLE'] };
const youtube = { ...base, creatorFeed: true, images: false, videos: true, pagination: true, authKind: 'cookies', authLabel: 'Cookies' };
const pornhub = { ...base, creatorFeed: true, images: false, videos: true, pagination: true, authKind: 'none', authLabel: 'Keine Anmeldung' };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('names the kinds of address per platform in the adapter overview', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/adapters')) {
      return json({
        adapters: [{
          id: 'yt-dlp', label: 'yt-dlp (Videos)', version: '2026.8.19', capabilities: youtube,
          sourceTypes: [
            { id: 'youtube', label: 'YouTube', capabilities: youtube, addressKinds: ['Einzelnes Video (watch, youtu.be, Shorts, Live)', 'Playlist', 'Kanal (Reiter Videos, Shorts, Livestreams)'] },
            { id: 'pornhub', label: 'Pornhub', capabilities: pornhub, addressKinds: ['Einzelnes Video', 'Öffentliche Playlist'] }
          ],
          availability: 'available', reasonCode: null, message: null, checkedAt: null, disabledByAdministrator: false
        }]
      });
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  }));

  render(<AdaptersPanel isAdmin={false} />);
  const details = screen.getByText('Unterstützte Quellen und Adapter').closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));

  await screen.findAllByRole('list', { name: 'Fähigkeiten' });
  const sources = document.querySelector('ul.source-list') as HTMLElement;
  expect(within(sources).getByText('YouTube')).toBeInTheDocument();
  expect(sources).toHaveTextContent('Playlist');
  expect(sources).toHaveTextContent('Kanal (Reiter Videos, Shorts, Livestreams)');
  expect(sources).toHaveTextContent('Öffentliche Playlist');
  // The abilities differ between YouTube (cookies) and Pornhub (no login), so each platform has its own list.
  const abilities = screen.getAllByRole('list', { name: 'Fähigkeiten' });
  expect(abilities).toHaveLength(2);
  expect(abilities[0]).toHaveTextContent('Anmeldung: Cookies');
  expect(abilities[1]).toHaveTextContent('Anmeldung: Keine Anmeldung');
});

const asset = (overrides: Partial<HistoryAsset>): HistoryAsset => ({
  id: 'a1', index: 0, sourceAssetId: 'video', originalName: 'Video nicht abrufbar', mediaType: 'application/octet-stream', state: 'failed', attempts: 1,
  byteSize: null, sha256: null, errorCode: null, errorMessage: null, storedAt: null, localOriginalRetained: true,
  handover: { state: 'not_attempted', at: null, transferId: null, transferStatus: null, evidence: null },
  ...overrides
});
const post = (assets: HistoryAsset[]): HistoryPost => ({
  id: 'p1', subscriptionId: 's1', subscriptionName: 'Kanal', platform: 'youtube', adapterId: 'yt-dlp', creatorId: 'UC1', creatorName: 'Own Test Channel',
  platformPostId: 'aaaaaaaaaa2', title: 'Live right now', sourceUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaa2', state: 'failed',
  discoveryComplete: true, discoveredAt: '2026-06-01T10:00:00Z', completedAt: null, assets
});

it('shows a running livestream as "noch nicht verfügbar" with its reason, and not as a failed file', () => {
  const reason = 'Der Livestream läuft gerade und wird nicht aufgezeichnet. Das Video wird nach dem Ende des Streams erneut geprüft.';
  render(<LedgerEntry post={post([asset({ errorCode: 'ASSET_NOT_YET_AVAILABLE', errorMessage: reason })])} />);

  expect(screen.getByText('0 von 1 gespeichert, 1 noch nicht verfügbar')).toBeInTheDocument();
  expect(screen.getAllByText('Noch nicht verfügbar').length).toBeGreaterThan(0);
  expect(screen.queryByText('Fehlgeschlagen')).not.toBeInTheDocument();
  expect(screen.queryByText(/fehlgeschlagen/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Dateien|Details|anzeigen/i }));
  const table = screen.getByRole('table');
  expect(within(table).getByText('Noch nicht verfügbar')).toBeInTheDocument();
  expect(within(table).getByText(reason)).not.toHaveClass('cell-note-danger');
});

it('keeps a terminal entry state a failure, with its reason in the danger style', () => {
  const reason = 'Das Video ist privat oder nur für bestimmte Konten freigegeben.';
  render(<LedgerEntry post={post([asset({ errorCode: 'ASSET_NOT_ACCESSIBLE', errorMessage: reason })])} />);

  expect(screen.getByText('0 von 1 gespeichert, 1 fehlgeschlagen')).toBeInTheDocument();
  expect(screen.queryByText('Noch nicht verfügbar')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Dateien|Details|anzeigen/i }));
  expect(screen.getByText(reason)).toHaveClass('cell-note-danger');
});

it('shows the notices of the address check for a YouTube channel and a refused Pornhub address', () => {
  const channel: SourceValidation = {
    supported: true, canonicalUrl: 'https://www.youtube.com/@owntestchannel/videos', platform: 'youtube', platformLabel: 'YouTube', targetKind: 'creator_feed',
    adapter: { id: 'yt-dlp', label: 'yt-dlp (Videos)', availability: 'available', version: '2026.8.19' }, capabilities: youtube, runnable: true,
    credentials: { platform: 'youtube', stored: false, loginNeeded: false },
    notices: ['Es werden die neuesten Einträge im Reiter Videos dieses Kanals geladen, je Lauf nur eine begrenzte Anzahl.']
  };
  const { unmount } = render(<SourceValidationView result={channel} />);
  expect(screen.getByText(/Erkannt:/).parentElement).toHaveTextContent('YouTube über yt-dlp (Videos)');
  expect(screen.getByText(/Reiter Videos dieses Kanals/)).toBeInTheDocument();
  expect(screen.getByRole('list', { name: 'Fähigkeiten' })).toHaveTextContent('Ganzer Kanal oder Creator');
  expect(screen.queryByText('Anmeldung nötig')).not.toBeInTheDocument();
  unmount();

  render(<SourceValidationView result={{ supported: false, code: 'TARGET_UNSUPPORTED', message: 'Diese Pornhub-Adresse ist zurzeit nicht unterstützt.', notices: [] }} />);
  expect(screen.getByText(/Nicht unterstützt: Diese Pornhub-Adresse ist zurzeit nicht unterstützt\./)).toBeInTheDocument();
});
