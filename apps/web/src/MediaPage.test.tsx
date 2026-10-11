// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MediaAsset } from './api.js';
import { MediaPage, groupByDay } from './MediaPage.js';

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function asset(id: string, storedAt: string, extra: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id, postId: `p-${id}`, assetIndex: 0, platform: 'pixiv', platformPostId: id, postTitle: `Beitrag ${id}`, postUrl: null, creatorName: null,
    runId: 'r1', originalName: `${id}.png`, mediaKind: 'image', mimeType: 'image/png', byteSize: 10, state: 'stored', attempts: 1,
    errorCode: null, errorMessage: null, storedAt, width: 800, height: 600, durationSeconds: null, averageColor: null, hasThumbnail: false,
    immich: { state: 'none', verified: false, verifiedAt: null }, ...extra
  };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('groups the files by the day they were stored, newest first', () => {
  const now = new Date(2026, 9, 11, 12, 0);
  const days = groupByDay([
    asset('a', new Date(2026, 9, 11, 9, 0).toISOString()),
    asset('b', new Date(2026, 9, 11, 8, 0).toISOString()),
    asset('c', new Date(2026, 9, 10, 20, 0).toISOString()),
    asset('d', new Date(2026, 9, 5, 20, 0).toISOString())
  ], now);
  expect(days.map((day) => [day.label, day.assets.length])).toEqual([['Heute', 2], ['Gestern', 1], ['Montag, 5. Oktober', 1]]);
});

it('loads the first page, shows a day heading and asks the server again when the type changes', async () => {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/subscriptions')) return json({ subscriptions: [] });
    if (path.includes('/media?kind=video')) return json({ items: [], nextCursor: null, counts: { all: 2, image: 2, video: 0 } });
    if (path.includes('/media')) return json({ items: [asset('a', new Date().toISOString()), asset('b', new Date().toISOString())], nextCursor: 'c2', counts: { all: 2, image: 2, video: 0 } });
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', fetch);
  render(<MediaPage />);
  const today = await screen.findByRole('region', { name: 'Heute' });
  expect(within(today).getByText('2 Dateien')).toBeInTheDocument();
  expect(within(today).getAllByRole('button')).toHaveLength(2);
  expect(screen.getByText('2 von 2')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Videos' }));
  await waitFor(() => expect(fetch.mock.calls.some(([input]) => String(input).includes('kind=video'))).toBe(true));
  expect(await screen.findByText('Dafür gibt es keine Dateien.')).toBeInTheDocument();
});

it('says what to do when nothing is stored yet', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/subscriptions') ? json({ subscriptions: [] }) : json({ items: [], nextCursor: null })));
  render(<MediaPage />);
  expect(await screen.findByText('Noch keine Medien.')).toBeInTheDocument();
  expect(screen.getByText('Sobald Kura etwas lädt, erscheint es hier.')).toBeInTheDocument();
});
