// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MediaAsset, RunAssets, SubscriptionMediaPage } from './api.js';
import { RunLive } from './RunLive.js';
import { SubscriptionMedia } from './SubscriptionMedia.js';

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function asset(id: string, overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id, postId: 'post-1', assetIndex: 0, platform: 'instagram', platformPostId: 'P1', postTitle: 'Sommer am See',
    postUrl: 'https://www.instagram.com/p/P1/', creatorName: 'Creator', runId: 'run-1', originalName: `${id}.png`,
    mediaKind: 'image', mimeType: 'image/png', byteSize: 2048, state: 'stored', attempts: 1, errorCode: null, errorMessage: null,
    storedAt: '2026-06-01T10:00:00.000Z', immich: { state: 'not_attempted', verified: false, verifiedAt: null },
    ...overrides
  };
}

const requests = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(([input]) => String(input));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

// --- grid ---------------------------------------------------------------------------------------------

const carousel = [
  asset('a1', { assetIndex: 0 }),
  asset('a2', { assetIndex: 1 }),
  asset('a3', { assetIndex: 2, mediaKind: 'video', mimeType: 'video/mp4', originalName: 'clip.mp4' }),
  asset('b1', { postId: 'post-2', platformPostId: 'P2', postTitle: null, postUrl: null, originalName: 'einzel.png' })
];

function mockMedia(handler: (url: string) => ReturnType<typeof json> | undefined) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => handler(String(input)) ?? json({ error: { code: 'NOT_FOUND', message: 'Nicht gefunden.' } }, 404));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

it('shows the files grouped by post with their count, lazy images and video posters', async () => {
  mockMedia(() => json({ items: carousel, nextCursor: null, counts: { all: 4, image: 3, video: 1 } } satisfies SubscriptionMediaPage));
  render(<SubscriptionMedia subscriptionId="s1" />);

  const first = await screen.findByRole('region', { name: 'Beitrag Sommer am See' });
  expect(within(first).getByText('3 Dateien')).toBeInTheDocument();
  expect(within(first).getAllByRole('button')).toHaveLength(3);
  const second = screen.getByRole('region', { name: 'Beitrag Ohne Titel vom 01.06.' });
  expect(within(second).queryByText(/Dateien/)).not.toBeInTheDocument();
  // A raw platform id is never shown as a title.
  expect(screen.queryByText(/P2/)).not.toBeInTheDocument();

  const image = within(first).getByAltText('Bild: a1.png');
  expect(image).toHaveAttribute('loading', 'lazy');
  expect(image).toHaveAttribute('src', '/api/v1/assets/a1/content');
  // A video without a derived poster shows a placeholder; the file itself is not loaded before the viewer opens.
  expect(within(first).getByLabelText('Video: clip.mp4')).toBeInTheDocument();
  expect(first.querySelector('video')).toBeNull();
  expect(screen.getByRole('button', { name: 'Alle (4)' })).toHaveAttribute('aria-pressed', 'true');
});

it('gives each post a head with the time (absolute in the title) and a link to the post on its platform', async () => {
  mockMedia(() => json({ items: carousel, nextCursor: null, counts: { all: 4, image: 3, video: 1 } } satisfies SubscriptionMediaPage));
  render(<SubscriptionMedia subscriptionId="s1" />);

  const first = await screen.findByRole('region', { name: 'Beitrag Sommer am See' });
  const time = first.querySelector('header time');
  expect(time).not.toBeNull();
  expect(time).toHaveAttribute('datetime', '2026-06-01T10:00:00.000Z');
  expect(time?.getAttribute('title')).toMatch(/2026/);
  const link = within(first).getByRole('link', { name: /Beitrag auf Instagram öffnen/ });
  expect(link).toHaveAttribute('href', 'https://www.instagram.com/p/P1/');
  expect(link).toHaveAttribute('target', '_blank');
  expect(link.getAttribute('rel')).toContain('noopener');
  // The second post has no address: no link.
  const second = screen.getByRole('region', { name: /^Beitrag Ohne Titel/ });
  expect(within(second).queryByRole('link')).toBeNull();
});

it('reloads with the type when a filter is chosen', async () => {
  const fetch = mockMedia((url) => json(url.includes('type=video')
    ? { items: [carousel[2]], nextCursor: null, counts: { all: 4, image: 3, video: 1 } }
    : { items: carousel, nextCursor: null, counts: { all: 4, image: 3, video: 1 } }));
  render(<SubscriptionMedia subscriptionId="s1" />);
  await screen.findByRole('region', { name: 'Beitrag Sommer am See' });

  fireEvent.click(screen.getByRole('button', { name: 'Videos (1)' }));
  await waitFor(() => expect(requests(fetch).some((url) => url.endsWith('/subscriptions/s1/media?type=video'))).toBe(true));
  await waitFor(() => expect(screen.queryByAltText('Bild: a1.png')).not.toBeInTheDocument());
  expect(screen.getByLabelText('Video: clip.mp4')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Videos (1)' })).toHaveAttribute('aria-pressed', 'true');
});

it('loads further pages on request and merges a post that continues', async () => {
  const fetch = mockMedia((url) => json(url.includes('cursor=c1')
    ? { items: [asset('a9', { assetIndex: 3 })], nextCursor: null }
    : { items: [carousel[0]], nextCursor: 'c1', counts: { all: 2, image: 2, video: 0 } }));
  render(<SubscriptionMedia subscriptionId="s1" />);
  await screen.findByAltText('Bild: a1.png');
  fireEvent.click(screen.getByRole('button', { name: 'Weitere laden' }));
  await screen.findByAltText('Bild: a9.png');
  expect(requests(fetch).some((url) => url.includes('cursor=c1'))).toBe(true);
  expect(screen.getAllByRole('region', { name: /^Beitrag/ })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Weitere laden' })).not.toBeInTheDocument();
});

it('shows skeletons while loading, then the empty state', async () => {
  let release: (value: ReturnType<typeof json>) => void = () => undefined;
  vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { release = resolve; })));
  render(<SubscriptionMedia subscriptionId="s1" />);
  expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  await act(async () => { release(json({ items: [], nextCursor: null, counts: { all: 0, image: 0, video: 0 } })); });
  expect(await screen.findByText('Noch nichts geladen. Starte einen Lauf mit Jetzt ausführen.')).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Medientyp' })).not.toBeInTheDocument();
});

it('shows an error banner with a retry', async () => {
  let fail = true;
  mockMedia(() => fail ? json({ error: { code: 'X', message: 'Datenbank nicht erreichbar.' } }, 500) : json({ items: [carousel[0]], nextCursor: null, counts: { all: 1, image: 1, video: 0 } }));
  render(<SubscriptionMedia subscriptionId="s1" />);
  const banner = await screen.findByRole('alert');
  expect(banner).toHaveTextContent('Datenbank nicht erreichbar.');
  fail = false;
  fireEvent.click(within(banner).getByRole('button', { name: 'Erneut laden' }));
  await screen.findByAltText('Bild: a1.png');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('moves the focus through the grid with the arrow keys', async () => {
  mockMedia(() => json({ items: carousel, nextCursor: null, counts: { all: 4, image: 3, video: 1 } }));
  render(<SubscriptionMedia subscriptionId="s1" />);
  await screen.findByAltText('Bild: a1.png');
  const cells = screen.getAllByRole('button', { name: /ansehen$/ });
  cells[0]!.focus();
  fireEvent.keyDown(cells[0]!, { key: 'ArrowRight' });
  expect(cells[1]).toHaveFocus();
  fireEvent.keyDown(cells[1]!, { key: 'End' });
  expect(cells[3]).toHaveFocus();
  fireEvent.keyDown(cells[3]!, { key: 'ArrowLeft' });
  expect(cells[2]).toHaveFocus();
  fireEvent.keyDown(cells[2]!, { key: 'Home' });
  expect(cells[0]).toHaveFocus();
});

// --- viewer -------------------------------------------------------------------------------------------

async function openViewer() {
  mockMedia(() => json({ items: carousel, nextCursor: null, counts: { all: 4, image: 3, video: 1 } }));
  render(<SubscriptionMedia subscriptionId="s1" />);
  await screen.findByAltText('Bild: a1.png');
  const opener = screen.getByRole('button', { name: 'Bild a1.png ansehen' });
  opener.focus();
  fireEvent.click(opener);
  return { opener, dialog: await screen.findByRole('dialog') };
}

it('opens the viewer with the file, the metadata, the source link and the download', async () => {
  const { dialog } = await openViewer();
  expect(dialog.querySelector(`[alt$=': a1.png'], [aria-label$=': a1.png']`), 'file shown: a1.png').not.toBeNull();
  expect(within(dialog).getByAltText('Bild: a1.png')).toHaveAttribute('src', '/api/v1/assets/a1/content');
  expect(within(dialog).getByText('2 KiB')).toBeInTheDocument();
  expect(within(dialog).getByText('Bild (image/png)')).toBeInTheDocument();
  const source = within(dialog).getByRole('link', { name: /Beitrag auf Instagram öffnen/ });
  expect(source).toHaveAttribute('href', 'https://www.instagram.com/p/P1/');
  expect(source).toHaveAttribute('target', '_blank');
  expect(source).toHaveAttribute('rel', 'noopener noreferrer');
  const download = within(dialog).getByRole('link', { name: 'Herunterladen' });
  expect(download).toHaveAttribute('href', '/api/v1/assets/a1/content?download=1');
  expect(within(dialog).getByText('Noch nicht an Immich übergeben')).toBeInTheDocument();
  expect(within(dialog).getByText('1 von 4')).toBeInTheDocument();
});

it('does not offer a source link for an address that is not a web link', async () => {
  mockMedia(() => json({ items: [asset('x1', { postUrl: 'javascript:alert(1)' })], nextCursor: null, counts: { all: 1, image: 1, video: 0 } }));
  render(<SubscriptionMedia subscriptionId="s1" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Bild x1.png ansehen' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).queryByRole('link', { name: /öffnen/ })).not.toBeInTheDocument();
});

it('walks through the files with the arrow keys and plays videos with native controls', async () => {
  const { dialog } = await openViewer();
  fireEvent.keyDown(document, { key: 'ArrowRight' });
  expect(dialog.querySelector(`[alt$=': a2.png'], [aria-label$=': a2.png']`), 'file shown: a2.png').not.toBeNull();
  fireEvent.keyDown(document, { key: 'ArrowRight' });
  const video = within(dialog).getByLabelText('Video: clip.mp4');
  expect(video.tagName).toBe('VIDEO');
  expect(video).toHaveAttribute('controls');
  expect(video).toHaveAttribute('src', '/api/v1/assets/a3/content');
  // The arrow keys on a focused video belong to its controls.
  fireEvent.keyDown(video, { key: 'ArrowRight' });
  expect(dialog.querySelector(`[alt$=': clip.mp4'], [aria-label$=': clip.mp4']`), 'file shown: clip.mp4').not.toBeNull();
  fireEvent.keyDown(document, { key: 'ArrowRight' });
  expect(dialog.querySelector(`[alt$=': einzel.png'], [aria-label$=': einzel.png']`), 'file shown: einzel.png').not.toBeNull();
  expect(within(dialog).getByRole('button', { name: 'Nächste' })).toBeDisabled();
  fireEvent.keyDown(document, { key: 'ArrowRight' });
  expect(dialog.querySelector(`[alt$=': einzel.png'], [aria-label$=': einzel.png']`), 'file shown: einzel.png').not.toBeNull();
  fireEvent.keyDown(document, { key: 'ArrowLeft' });
  expect(dialog.querySelector(`[alt$=': clip.mp4'], [aria-label$=': clip.mp4']`), 'file shown: clip.mp4').not.toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Vorherige' }));
  expect(dialog.querySelector(`[alt$=': a2.png'], [aria-label$=': a2.png']`), 'file shown: a2.png').not.toBeNull();
});

it('closes with Escape and returns the focus to the cell it was opened from', async () => {
  const { opener } = await openViewer();
  expect(screen.getByRole('dialog')).toHaveFocus();
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(opener).toHaveFocus();
});

it('returns the focus to the cell of the file that was shown last', async () => {
  await openViewer();
  fireEvent.keyDown(document, { key: 'ArrowRight' });
  fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Bild a2.png ansehen' })).toHaveFocus();
});

it('keeps the focus inside the dialog while it is open', async () => {
  const { dialog } = await openViewer();
  const close = within(dialog).getByRole('button', { name: 'Schließen' });
  const download = within(dialog).getByRole('link', { name: 'Herunterladen' });
  const focusable = [...dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
  expect(focusable[0]).toBe(close);
  expect(focusable.at(-1)).toBe(download);

  download.focus();
  fireEvent.keyDown(download, { key: 'Tab' });
  expect(close).toHaveFocus();
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
  expect(download).toHaveFocus();

  // Focus that lands behind the dialog is pulled back.
  const behind = screen.getByRole('button', { name: 'Alle (4)' });
  behind.focus();
  expect(dialog).toHaveFocus();
});

it('shows the Immich verification only for a verified original', async () => {
  mockMedia(() => json({
    items: [asset('v1', { immich: { state: 'verified', verified: true, verifiedAt: '2026-06-02T08:00:00.000Z' } })],
    nextCursor: null, counts: { all: 1, image: 1, video: 0 }
  }));
  render(<SubscriptionMedia subscriptionId="s1" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Bild v1.png ansehen' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('In Immich geprüft (Original stimmt überein)')).toBeInTheDocument();
});

// --- live view and polling ----------------------------------------------------------------------------

function runAssets(overrides: Partial<RunAssets> = {}): RunAssets {
  return {
    run: {
      id: 'run-1', jobRunId: 'job-1', subscriptionId: 's1', subscriptionName: 'Creator A', triggerKind: 'manual', platform: 'instagram',
      state: 'downloading', errorCode: null, errorMessage: null, postsFound: 1, postsSkipped: 0, assetsStored: 1, assetsFailed: 0,
      bytesStored: 2048, startedAt: '2026-06-01T10:00:00Z', finishedAt: null
    },
    queue: { state: 'leased', lastError: null },
    active: true,
    counts: { pending: 1, downloading: 1, verifying: 0, stored: 1, failed: 0 },
    truncated: false,
    assets: [
      asset('s1', { assetIndex: 0 }),
      asset('d1', { assetIndex: 1, state: 'downloading', originalName: 'laedt.mp4', mediaKind: 'video', mimeType: 'video/mp4', storedAt: null }),
      asset('p1', { assetIndex: 2, state: 'pending', originalName: 'wartet.png', storedAt: null })
    ],
    ...overrides
  };
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => { setVisibility('visible'); });

it('shows progress per file and the stored files as pictures', async () => {
  mockMedia(() => json(runAssets()));
  render(<RunLive runId="job-1" />);
  expect(await screen.findByText('1 gespeichert, 1 wird geladen, 1 wartet')).toBeInTheDocument();
  expect(screen.getByAltText('Bild: s1.png')).toBeInTheDocument();
  expect(screen.getByText('laedt.mp4')).toBeInTheDocument();
  expect(screen.getByText('Wird geladen')).toBeInTheDocument();
  expect(screen.getByText('Wartet')).toBeInTheDocument();
  expect(screen.getByText('Wird heruntergeladen')).toBeInTheDocument();
});

it('AC25: one sentence, one bar from the same two numbers, state tiles instead of dashed boxes', async () => {
  mockMedia(() => json(runAssets({
    counts: { pending: 1, downloading: 1, verifying: 0, stored: 1, failed: 1 },
    assets: [
      asset('s1', { assetIndex: 0 }),
      asset('d1', { assetIndex: 1, state: 'downloading', originalName: 'laedt.mp4', mediaKind: 'video', mimeType: 'video/mp4', storedAt: null }),
      asset('p1', { assetIndex: 2, state: 'pending', originalName: 'wartet.png', storedAt: null }),
      asset('f1', { assetIndex: 3, state: 'failed', originalName: 'kaputt.png', storedAt: null, errorMessage: 'Netzwerkfehler beim Abruf.' })
    ]
  })));
  render(<RunLive runId="job-1" />);
  expect(await screen.findByText('1 gespeichert, 1 wird geladen, 1 wartet, 1 fehlgeschlagen')).toBeInTheDocument();
  const bar = screen.getByRole('progressbar', { name: 'Fortschritt des Laufs' });
  expect(bar).toHaveAttribute('aria-valuenow', '1');
  expect(bar).toHaveAttribute('aria-valuemax', '4');
  // Every file that is not stored has a tile with glyph and text, none is an empty box.
  expect(screen.getByRole('group', { name: 'Bild wartet.png: Wartet' })).toHaveTextContent('Wartet');
  expect(screen.getByRole('group', { name: /laedt\.mp4: Wird geladen/ })).toHaveTextContent('Wird geladen');
  const failed = screen.getByRole('group', { name: /kaputt\.png: Fehlgeschlagen/ });
  expect(failed).toHaveTextContent('Fehlgeschlagen');
  expect(failed).toHaveAttribute('title', 'Netzwerkfehler beim Abruf.');
  // The announcement for the screen reader is its own region and is throttled; it names the same numbers.
  expect(screen.getByRole('status')).toBeInTheDocument();
});

it('says that a queued run waits for a worker', async () => {
  mockMedia(() => json(runAssets({ run: null, queue: { state: 'queued', lastError: null }, assets: [], counts: { pending: 0, downloading: 0, verifying: 0, stored: 0, failed: 0 } })));
  render(<RunLive runId="job-1" />);
  expect(await screen.findByText('Der Lauf ist eingereiht und wartet auf einen freien Worker.')).toBeInTheDocument();
});

it('polls every 3 seconds while the run is active, shows new files and stops when it is over', async () => {
  vi.useFakeTimers();
  let answers = 0;
  const fetch = mockMedia(() => {
    answers += 1;
    if (answers === 1) return json(runAssets());
    if (answers === 2) return json(runAssets({ counts: { pending: 0, downloading: 1, verifying: 0, stored: 2, failed: 0 }, assets: [asset('s1'), asset('s2', { assetIndex: 1 })] }));
    return json(runAssets({ active: false, run: { ...runAssets().run!, state: 'stored', finishedAt: '2026-06-01T10:01:00Z' }, counts: { pending: 0, downloading: 0, verifying: 0, stored: 3, failed: 0 }, assets: [asset('s1'), asset('s2', { assetIndex: 1 }), asset('s3', { assetIndex: 2 })] }));
  });
  const onFinished = vi.fn();
  render(<RunLive runId="job-1" onFinished={onFinished} />);

  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(requests(fetch)[0]).toBe('/api/v1/runs/job-1/assets');

  await act(async () => { await vi.advanceTimersByTimeAsync(2900); });
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(screen.getByAltText('Bild: s2.png')).toBeInTheDocument();
  expect(onFinished).not.toHaveBeenCalled();

  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(screen.getByAltText('Bild: s3.png')).toBeInTheDocument();
  expect(screen.getByText('Beendet')).toBeInTheDocument();
  expect(onFinished).toHaveBeenCalledTimes(1);

  // The run is over: no further requests.
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('pauses while the tab is hidden and fetches at once when it is visible again', async () => {
  vi.useFakeTimers();
  const fetch = mockMedia(() => json(runAssets()));
  render(<RunLive runId="job-1" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(fetch).toHaveBeenCalledTimes(1);

  await act(async () => { setVisibility('hidden'); });
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(fetch).toHaveBeenCalledTimes(1);

  await act(async () => { setVisibility('visible'); await vi.advanceTimersByTimeAsync(0); });
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('does not start a request while the tab is hidden after the last answer', async () => {
  vi.useFakeTimers();
  const fetch = mockMedia(() => json(runAssets()));
  render(<RunLive runId="job-1" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); setVisibility('hidden'); await vi.advanceTimersByTimeAsync(5000); });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('stops polling when the component is removed', async () => {
  vi.useFakeTimers();
  const fetch = mockMedia(() => json(runAssets()));
  const { unmount } = render(<RunLive runId="job-1" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('keeps polling after a failed request and shows the error', async () => {
  vi.useFakeTimers();
  let fail = true;
  const fetch = mockMedia(() => fail ? json({ error: { code: 'X', message: 'Kurz nicht erreichbar.' } }, 500) : json(runAssets()));
  render(<RunLive runId="job-1" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByRole('alert')).toHaveTextContent('Kurz nicht erreichbar.');
  fail = false;
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('opens a stored file of the live view in the viewer', async () => {
  mockMedia(() => json(runAssets()));
  render(<RunLive runId="job-1" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Bild s1.png ansehen' }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog.querySelector(`[alt$=': s1.png'], [aria-label$=': s1.png']`), 'file shown: s1.png').not.toBeNull();
  // Only stored files can be walked through.
  expect(within(dialog).getByText('1 von 1')).toBeInTheDocument();
});
