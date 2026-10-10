// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { HistoryAsset, HistoryPost } from './api.js';
import { LedgerEntry } from './Ledger.js';

// F2: a Patreon post that the account may not view is shown as "nicht zugänglich" with its reason, and not as a failure.

afterEach(cleanup);

const reason = 'Nicht zugänglich: Der Beitrag ist für das hinterlegte Patreon-Konto gesperrt (zum Beispiel nur für Mitglieder einer höheren Stufe). Das ist kein Fehler.';
const asset = (overrides: Partial<HistoryAsset>): HistoryAsset => ({
  id: 'a1', index: 0, sourceAssetId: 'locked', originalName: 'Beitrag nicht zugänglich', mediaType: 'application/octet-stream', state: 'failed', attempts: 1,
  byteSize: null, sha256: null, errorCode: 'ASSET_LOCKED', errorMessage: reason, storedAt: null, localOriginalRetained: true,
  handover: { state: 'not_attempted', at: null, transferId: null, transferStatus: null, evidence: null },
  ...overrides
});
const post = (assets: HistoryAsset[]): HistoryPost => ({
  id: 'p1', subscriptionId: 's1', subscriptionName: 'Creator', platform: 'patreon', adapterId: 'gallery-dl', creatorId: '55', creatorName: 'Own Test Creator',
  platformPostId: '1003', title: 'Members only', sourceUrl: 'https://www.patreon.com/posts/1003', state: 'failed',
  discoveryComplete: true, discoveredAt: '2026-06-01T10:00:00Z', completedAt: null, assets
});

it('shows a locked post as "nicht zugänglich" with its reason, in the plain note style and not as a failure', () => {
  render(<LedgerEntry post={post([asset({})])} />);

  expect(screen.getByText('0 von 1 gespeichert, 1 nicht zugänglich')).toBeInTheDocument();
  expect(screen.getAllByText('Nicht zugänglich').length).toBeGreaterThan(0);
  expect(screen.queryByText('Fehlgeschlagen')).not.toBeInTheDocument();
  expect(screen.queryByText(/fehlgeschlagen/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Dateien|Details|anzeigen/i }));
  const table = screen.getByRole('table');
  expect(within(table).getByText('Nicht zugänglich')).toBeInTheDocument();
  expect(within(table).getByText(reason)).not.toHaveClass('cell-note-danger');
});

it('still counts a really failed file next to a locked one as failed', () => {
  render(<LedgerEntry post={post([asset({}), asset({ id: 'a2', index: 1, errorCode: 'DOWNLOAD_FAILED', errorMessage: 'Der Abruf ist fehlgeschlagen.' })])} />);

  expect(screen.getByText('0 von 2 gespeichert, 1 fehlgeschlagen, 1 nicht zugänglich')).toBeInTheDocument();
  expect(screen.getAllByText('Fehlgeschlagen').length).toBeGreaterThan(0);
});
