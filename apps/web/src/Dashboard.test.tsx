// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MediaAsset, Overview } from './api.js';
import { Dashboard, runResult } from './Dashboard.js';

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const status = { version: '0.2.0', migrations: { appliedCount: 70, latestVersion: '0070' } };

function asset(id: string): MediaAsset {
  return {
    id, postId: `p-${id}`, assetIndex: 0, platform: 'pixiv', platformPostId: id, postTitle: `Beitrag ${id}`, postUrl: null, creatorName: null,
    runId: 'r1', originalName: `${id}.png`, mediaKind: 'image', mimeType: 'image/png', byteSize: 10, state: 'stored', attempts: 1,
    errorCode: null, errorMessage: null, storedAt: new Date().toISOString(), width: 800, height: 600, durationSeconds: null, averageColor: null,
    hasThumbnail: false, immich: { state: 'none', verified: false, verifiedAt: null }
  } as MediaAsset;
}

const empty: Overview = { recentAssets: [], activeRuns: [], upcoming: [], attention: [], lastRuns: [] };

function renderDashboard(onNavigate = vi.fn()) {
  return render(<Dashboard health="ok" status={status} checkedAt={new Date()} onNavigate={onNavigate} />);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('overview empty: says what to do and offers the first subscription', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(empty)));
  const onNavigate = vi.fn();
  renderDashboard(onNavigate);
  expect(await screen.findByText('Noch nichts im Archiv.')).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button', { name: 'Abonnement anlegen' })[0]!);
  expect(onNavigate).toHaveBeenCalledWith('subscriptions');
});

it('overview error: names the problem, says what to do and reloads on request', async () => {
  let fail = true;
  const fetch = vi.fn(async () => (fail ? json({ error: { message: 'kaputt' } }, 500) : json(empty)));
  vi.stubGlobal('fetch', fetch);
  renderDashboard();
  expect(await screen.findByText('Die Übersicht konnte nicht geladen werden.')).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Erneut laden' }));
  await waitFor(() => expect(screen.queryByText('Die Übersicht konnte nicht geladen werden.')).not.toBeInTheDocument());
});

it('overview with data: mosaic of the newest files, running and next runs, what needs attention', async () => {
  const overview: Overview = {
    ...empty,
    recentAssets: [asset('a'), asset('b'), asset('c')],
    activeRuns: [{
      runId: 'r1', subscriptionId: 's1', subscriptionName: 'Atelier Mori', triggerKind: 'manual', queueState: 'running', state: 'downloading',
      platform: 'pixiv', startedAt: new Date().toISOString(), queuedAt: new Date().toISOString(), bytesStored: 0,
      counts: { postsFound: 1, stored: 4, failed: 0, pending: 1, downloading: 0, verifying: 0 }
    }],
    upcoming: [{ subscriptionId: 's1', subscriptionName: 'Atelier Mori', dueAt: new Date(Date.now() + 3 * 3600_000).toISOString() }],
    attention: [{
      kind: 'auth_required', subscriptionId: 's2', subscriptionName: 'Kanal Nordlicht', runId: 'r0', state: 'failed', platform: 'youtube',
      errorCode: 'auth', errorMessage: null, finishedAt: new Date().toISOString()
    }]
  };
  vi.stubGlobal('fetch', vi.fn(async () => json(overview)));
  renderDashboard();
  expect(await screen.findByText(/Kanal Nordlicht: /)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Zugang erneuern' })).toBeInTheDocument();
  const mosaic = document.querySelector('.mosaic') as HTMLElement;
  expect(within(mosaic).getAllByRole('button')).toHaveLength(3);
  expect(screen.getByText('Läuft gerade')).toBeInTheDocument();
  expect(screen.getAllByText('Atelier Mori').length).toBeGreaterThan(0);
});

it('run result: only a deviation carries a tone', () => {
  expect(runResult({ state: 'succeeded', assetsStored: 3, assetsFailed: 0 }).tone).toBe('plain');
  expect(runResult({ state: 'failed', assetsStored: 0, assetsFailed: 2 }).tone).not.toBe('plain');
});
