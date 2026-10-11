// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MediaAsset } from './api.js';
import { Gallery, aspectRatio } from './MediaGrid.js';
import { useThrottledText } from './RunLive.js';
import { openViewer, VIEWER_TRANSITION_NAME } from './viewTransition.js';

function asset(id: string, overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id, postId: 'post-1', assetIndex: 0, platform: 'instagram', platformPostId: 'P1', postTitle: 'Sommer am See',
    postUrl: 'https://www.instagram.com/p/P1/', creatorName: 'Creator', runId: 'run-1', originalName: `${id}.png`,
    mediaKind: 'image', mimeType: 'image/png', byteSize: 2048, state: 'stored', attempts: 1, errorCode: null, errorMessage: null,
    storedAt: '2026-06-01T10:00:00.000Z', immich: { state: 'not_attempted', verified: false, verifiedAt: null },
    ...overrides
  };
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); document.documentElement.removeAttribute('data-view-transition'); });

// --- gallery layout -----------------------------------------------------------------------------------

it('computes the aspect ratio as width / height, clamped to 0.6 .. 2.4, and 1 when the size is unknown', () => {
  expect(aspectRatio({ width: 1600, height: 900 })).toBeCloseTo(16 / 9, 5);
  expect(aspectRatio({ width: 900, height: 1200 })).toBeCloseTo(0.75, 5);
  expect(aspectRatio({ width: 1000, height: 1000 })).toBe(1);
  // A panorama and a tall strip do not take over a row.
  expect(aspectRatio({ width: 6000, height: 1000 })).toBe(2.4);
  expect(aspectRatio({ width: 1000, height: 6000 })).toBe(0.6);
  expect(aspectRatio({ width: null, height: null })).toBe(1);
  expect(aspectRatio({ width: 800, height: null })).toBe(1);
  expect(aspectRatio({ width: 0, height: 600 })).toBe(1);
});

it('gives every tile of the gallery its own --ar, so rows are justified by the real proportions', () => {
  render(<Gallery onOpen={() => undefined} assets={[
    asset('wide', { width: 1600, height: 900 }),
    asset('tall', { width: 900, height: 1200 }),
    asset('unknown'),
    asset('pano', { width: 6000, height: 1000 })
  ]} />);
  const items = screen.getAllByRole('listitem');
  expect(items).toHaveLength(4);
  const ratios = items.map((item) => Number.parseFloat(item.style.getPropertyValue('--ar')));
  expect(ratios[0]).toBeCloseTo(16 / 9, 3);
  expect(ratios[1]).toBeCloseTo(0.75, 3);
  expect(ratios[2]).toBe(1);
  expect(ratios[3]).toBe(2.4);
});

it('shows a state tile (never an empty box) for files that are not stored', () => {
  render(<Gallery onOpen={() => undefined} assets={[
    asset('w', { state: 'pending', storedAt: null }),
    asset('l', { state: 'downloading', storedAt: null }),
    asset('f', { state: 'failed', storedAt: null, errorMessage: 'Netzwerkfehler.' })
  ]} />);
  expect(screen.getByRole('group', { name: /w\.png: Wartet/ })).toHaveTextContent('Wartet');
  expect(screen.getByRole('group', { name: /l\.png: Wird geladen/ })).toHaveTextContent('Wird geladen');
  expect(screen.getByRole('group', { name: /f\.png: Fehlgeschlagen/ })).toHaveAttribute('title', 'Netzwerkfehler.');
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});

// --- announcement throttle (AC25) ---------------------------------------------------------------------

it('announces a changed text at most every 5 seconds', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-11T10:00:00Z'));
  const { result, rerender } = renderHook(({ text }) => useThrottledText(text), { initialProps: { text: '0 von 4 Dateien gespeichert' } });
  expect(result.current).toBe('0 von 4 Dateien gespeichert');

  // The first change goes out at once (the last announcement is long ago, the initial value counted as 0).
  rerender({ text: '1 von 4 Dateien gespeichert' });
  act(() => { vi.advanceTimersByTime(0); });
  expect(result.current).toBe('1 von 4 Dateien gespeichert');

  // Three more changes within 5 seconds: nothing is announced before the window is over, then only the latest text.
  act(() => { vi.advanceTimersByTime(1000); });
  rerender({ text: '2 von 4 Dateien gespeichert' });
  act(() => { vi.advanceTimersByTime(1000); });
  rerender({ text: '3 von 4 Dateien gespeichert' });
  act(() => { vi.advanceTimersByTime(1000); });
  rerender({ text: '4 von 4 Dateien gespeichert' });
  expect(result.current).toBe('1 von 4 Dateien gespeichert');
  act(() => { vi.advanceTimersByTime(1900); });
  expect(result.current).toBe('1 von 4 Dateien gespeichert');
  act(() => { vi.advanceTimersByTime(200); });
  expect(result.current).toBe('4 von 4 Dateien gespeichert');
});

// --- viewer opening (AC23) ----------------------------------------------------------------------------

function tile() {
  const button = document.createElement('button');
  const image = document.createElement('img');
  button.append(image);
  document.body.append(button);
  return { button, image };
}

it('opens at once when the browser has no View Transition API (the viewer then fades in by itself)', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const update = vi.fn();
  openViewer(tile().button, update);
  expect(update).toHaveBeenCalledTimes(1);
  expect(document.documentElement).not.toHaveAttribute('data-view-transition');
});

it('opens inside document.startViewTransition and names the tile image for the morph', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const { button, image } = tile();
  let namedDuringCapture = '';
  let flagged = false;
  const update = vi.fn();
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  (document as unknown as { startViewTransition: unknown }).startViewTransition = (callback: () => void) => {
    namedDuringCapture = image.style.getPropertyValue('view-transition-name');
    flagged = document.documentElement.getAttribute('data-view-transition') === 'viewer';
    callback();
    return { finished };
  };
  try {
    openViewer(button, update);
    expect(namedDuringCapture).toBe(VIEWER_TRANSITION_NAME);
    expect(flagged).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    // The name moves to the viewer frame; the tile must not keep it, or two elements would carry one name.
    expect(image.style.getPropertyValue('view-transition-name')).toBe('');
    finish();
    await finished;
    await Promise.resolve();
    expect(document.documentElement).not.toHaveAttribute('data-view-transition');
  } finally {
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  }
});

it('skips the view transition under prefers-reduced-motion', () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('prefers-reduced-motion') }));
  const start = vi.fn();
  (document as unknown as { startViewTransition: unknown }).startViewTransition = start;
  try {
    const update = vi.fn();
    openViewer(tile().button, update);
    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  } finally {
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  }
});
