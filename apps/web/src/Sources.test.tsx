// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App.js';

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const user = { id: 'u1', display_name: 'Alice', username: 'alice', role: 'user', status: 'active', created_at: '2026-01-01T00:00:00Z' };

const subscription = {
  id: 's1', name: 'Creator A', targetUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', platformHint: null,
  targetState: 'unvalidated', status: 'active', schedules: []
};
const youtube = {
  supported: true, canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', platform: 'youtube', platformLabel: 'YouTube', targetKind: 'post',
  adapter: { id: 'yt-dlp', label: 'yt-dlp (Videos)', availability: 'unavailable', version: null },
  capabilities: { singlePost: true, creatorFeed: false, images: false, videos: true, pagination: false, resume: false, pageSnapshot: false, qualityVariants: false, authKind: 'none', authLabel: 'Keine Anmeldung', presets: ['BEST_AVAILABLE'] },
  runnable: false, notices: ['yt-dlp (Videos) ist auf dem Server nicht installiert oder nicht freigegeben.']
};

type Handler = (path: string, init?: RequestInit) => ReturnType<typeof json> | undefined;
function mockApi(role: 'admin' | 'user', extra: Handler) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const fromTest = extra(path, init);
    if (fromTest) return fromTest;
    if (path.endsWith('/auth/state')) return json({ configured: true, authenticated: true, role, csrfToken: 'csrf', passwordChangeRequired: false });
    if (path.endsWith('/api/v1/users')) return json({ users: [{ ...user, role }] });
    if (path === '/healthz') return json({ status: 'ok' });
    if (path.endsWith('/api/v1/status')) return json({ version: '0.1.0', migrations: { appliedCount: 5, latestVersion: '0051' } });
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const calls = (fetch: ReturnType<typeof vi.fn>, method: string, suffix: string) =>
  fetch.mock.calls.filter(([input, init]) => String(input).endsWith(suffix) && (init?.method ?? 'GET') === method);

async function open(page: 'Abonnements' | 'Verlauf') {
  render(<App />);
  await screen.findByText('Erreichbar');
  fireEvent.click(screen.getByRole('button', { name: page }));
  await screen.findByRole('heading', { name: page });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('checks an address without saving and shows platform, capabilities and the missing tool', async () => {
  const fetch = mockApi('user', (path, init) => {
    if (path.endsWith('/sources/validate') && init?.method === 'POST') return json(youtube);
    if (path.endsWith('/subscriptions')) return json({ subscriptions: [] });
    return undefined;
  });
  await open('Abonnements');
  fireEvent.click(await screen.findByRole('button', { name: 'Abonnement anlegen' }));
  fireEvent.change(screen.getByLabelText('Ziel-URL'), { target: { value: youtube.canonicalUrl } });
  fireEvent.click(screen.getByRole('button', { name: 'Adresse prüfen' }));

  const result = await screen.findByLabelText('Ergebnis der Adressprüfung');
  expect(within(result).getByText(/Erkannt:/).closest('p')).toHaveTextContent('Erkannt: YouTube über yt-dlp (Videos)');
  const capabilities = within(within(result).getByText(/Fähigkeiten:/).parentElement!).getByRole('list', { name: 'Fähigkeiten' });
  expect(within(capabilities).getAllByRole('listitem').map((item) => item.textContent))
    .toEqual(['Einzelner Beitrag', 'Kein ganzer Kanal, keine Playlist', 'Videos', 'Anmeldung: Keine Anmeldung']);
  expect(within(result).getByText('Werkzeug: Nicht verfügbar')).toBeInTheDocument();
  expect(within(result).getByText(/nicht installiert oder nicht freigegeben/)).toBeInTheDocument();
  expect(JSON.parse(String(calls(fetch, 'POST', '/sources/validate')[0][1]?.body))).toEqual({ url: youtube.canonicalUrl });
  expect(calls(fetch, 'POST', '/subscriptions')).toHaveLength(0);
});

it('says clearly that an address is not supported', async () => {
  mockApi('user', (path, init) => {
    if (path.endsWith('/sources/validate') && init?.method === 'POST') {
      return json({ supported: false, code: 'TARGET_BROKEN', message: 'Für diese Art von Adresse (zum Beispiel Instagram-Profile) ist die Unterstützung zurzeit bekanntermaßen defekt.', notices: [] });
    }
    if (path.endsWith('/subscriptions')) return json({ subscriptions: [] });
    return undefined;
  });
  await open('Abonnements');
  fireEvent.click(await screen.findByRole('button', { name: 'Abonnement anlegen' }));
  fireEvent.change(screen.getByLabelText('Ziel-URL'), { target: { value: 'https://www.instagram.com/someprofile/' } });
  fireEvent.click(screen.getByRole('button', { name: 'Adresse prüfen' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Nicht unterstützt: Für diese Art von Adresse (zum Beispiel Instagram-Profile)');
});

it('validates the saved address after saving and shows the stored result on the card', async () => {
  let state = 'unvalidated';
  const fetch = mockApi('user', (path, init) => {
    if (path.endsWith('/subscriptions') && init?.method === 'POST') return json({ subscription: subscription }, 201);
    if (path.endsWith('/subscriptions/s1/validate')) { state = 'valid'; return json({ targetState: 'valid', validation: youtube }); }
    if (path.endsWith('/subscriptions')) return json({ subscriptions: [{ ...subscription, targetState: state }] });
    return undefined;
  });
  await open('Abonnements');
  fireEvent.click(await screen.findByRole('button', { name: 'Abonnement anlegen' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Creator A' } });
  fireEvent.change(screen.getByLabelText('Ziel-URL'), { target: { value: subscription.targetUrl } });
  fireEvent.submit(screen.getByRole('form', { name: 'Abonnement anlegen' }));
  await waitFor(() => expect(calls(fetch, 'POST', '/subscriptions/s1/validate')).toHaveLength(1));
  const card = await screen.findByRole('article', { name: 'Abonnement Creator A' });
  expect(await within(card).findByText(/Adresse erkannt und unterstützt/)).toBeInTheDocument();
});

it('queues a run with "Jetzt ausführen" and points to the history; it explains a coalesced click', async () => {
  const responses = [
    { coalesced: false, run: { id: 'r1', state: 'queued', runAfter: '2026-06-01T10:00:00Z' } },
    { coalesced: true, run: { id: 'r1', state: 'queued', runAfter: '2026-06-01T10:00:00Z' } }
  ];
  const fetch = mockApi('user', (path) => {
    if (path.endsWith('/subscriptions/s1/run-now')) return json(responses.shift(), 202);
    if (path.endsWith('/subscriptions')) return json({ subscriptions: [subscription] });
    return undefined;
  });
  await open('Abonnements');
  const card = await screen.findByRole('article', { name: 'Abonnement Creator A' });
  fireEvent.click(within(card).getByRole('button', { name: 'Jetzt ausführen' }));
  expect(await within(card).findByText(/Der Lauf wurde eingereiht/)).toBeInTheDocument();
  fireEvent.click(within(card).getByRole('button', { name: 'Jetzt ausführen' }));
  expect(await within(card).findByText(/Es gibt bereits einen offenen Lauf .* Es wird kein zweiter angelegt/)).toBeInTheDocument();
  expect(calls(fetch, 'POST', '/subscriptions/s1/run-now')).toHaveLength(2);
});

it('does not offer "Jetzt ausführen" for a paused subscription', async () => {
  mockApi('user', (path) => path.endsWith('/subscriptions') ? json({ subscriptions: [{ ...subscription, status: 'paused' }] }) : undefined);
  await open('Abonnements');
  const card = await screen.findByRole('article', { name: /Abonnement Creator A/ });
  expect(within(card).getByRole('button', { name: 'Jetzt ausführen' })).toBeDisabled();
});

const storedAsset = {
  id: 'a1', index: 0, sourceAssetId: 'file', originalName: 'cat.jpg', mediaType: 'image/jpeg', state: 'stored', attempts: 1, byteSize: 2048,
  sha256: 'ab'.repeat(32), errorCode: null, errorMessage: null, storedAt: '2026-06-01T10:00:00Z', localOriginalRetained: true,
  handover: { state: 'verified', at: '2026-06-01T10:00:01Z', transferId: 't1', transferStatus: 'verified', evidence: { serverVersion: '3.2.1', byteLength: 2048, album: 'none', verifiedAt: '2026-06-01T10:00:01Z' } }
};
const failedAsset = { ...storedAsset, id: 'a2', index: 1, originalName: 'dog.jpg', state: 'failed', attempts: 2, byteSize: null, sha256: null, errorMessage: 'Netzwerkfehler beim Abruf. Der Lauf wird wiederholt.', handover: { state: 'not_attempted', at: null, transferId: null, transferStatus: null, evidence: null } };
const history = {
  runs: [
    { id: 'r1', subscriptionId: 's1', subscriptionName: 'Creator A', sourceUrl: 'https://x.test/a', triggerKind: 'manual', platform: 'pixiv', adapterId: 'gallery-dl', adapterVersion: '1.32.2', state: 'partially_completed', errorCode: 'PROCESS_FAILED', errorMessage: 'Das Werkzeug ist fehlgeschlagen. Der Lauf wird wiederholt.', postsFound: 1, postsSkipped: 0, assetsStored: 1, assetsFailed: 1, bytesStored: 2048, startedAt: '2026-06-01T10:00:00Z', finishedAt: '2026-06-01T10:00:02Z' },
    { id: 'r0', subscriptionId: 's1', subscriptionName: 'Creator A', sourceUrl: null, triggerKind: 'schedule', platform: null, adapterId: null, adapterVersion: null, state: 'waiting_auth', errorCode: 'AUTH_REQUIRED', errorMessage: 'Die Quelle verlangt eine Anmeldung oder die Anmeldung ist abgelaufen. Das Abonnement wurde pausiert.', postsFound: 0, postsSkipped: 0, assetsStored: 0, assetsFailed: 0, bytesStored: 0, startedAt: '2026-05-31T10:00:00Z', finishedAt: '2026-05-31T10:00:01Z' }
  ],
  posts: [{
    id: 'p1', subscriptionId: 's1', subscriptionName: 'Creator A', platform: 'pixiv', adapterId: 'gallery-dl', creatorId: '12345', creatorName: 'own_artist',
    platformPostId: '98765', title: 'Own test artwork', sourceUrl: 'https://www.pixiv.net/artworks/98765', state: 'partially_completed',
    discoveryComplete: true, discoveredAt: '2026-06-01T10:00:00Z', completedAt: null, assets: [storedAsset, failedAsset]
  }]
};

it('shows runs, posts and the state of every file with its Immich evidence', async () => {
  const fetch = mockApi('user', (path) => {
    if (path.endsWith('/history')) return json(history);
    if (path.endsWith('/immich/transfers/t1')) return json({ transfer: { id: 't1', status: 'verified', localOriginalRetained: true, evidence: null } });
    return undefined;
  });
  await open('Verlauf');

  const runs = await screen.findByRole('table', { name: 'Läufe' });
  expect(within(runs).getByText('Teilweise gespeichert')).toBeInTheDocument();
  expect(within(runs).getByText('Anmeldung erforderlich')).toBeInTheDocument();
  expect(within(runs).getByText(/Die Quelle verlangt eine Anmeldung/)).toBeInTheDocument();
  expect(within(runs).getByText('1 Beitrag, 1 Datei gespeichert (2 KiB), 1 fehlgeschlagen')).toBeInTheDocument();

  const post = screen.getByRole('article', { name: 'Beitrag Own test artwork' });
  expect(within(post).getByText('Status: Teilweise gespeichert')).toBeInTheDocument();
  const files = within(post).getByRole('table', { name: 'Dateien von Own test artwork' });
  const rows = within(files).getAllByRole('row');
  expect(within(rows[1]).getByText('Gespeichert')).toBeInTheDocument();
  expect(within(rows[1]).getByText('In Immich geprüft (Original stimmt überein)')).toBeInTheDocument();
  expect(within(rows[2]).getByText(/Fehlgeschlagen/)).toHaveTextContent('Fehlgeschlagen (Versuch 2)');
  expect(within(rows[2]).getByText('Netzwerkfehler beim Abruf. Der Lauf wird wiederholt.')).toBeInTheDocument();
  expect(within(post).getAllByText(/Immich-Nachweis/)).toHaveLength(1);
  expect(within(post).getByText('Immich-Version: 3.2.1')).toBeInTheDocument();
  expect(within(post).getByText('Das lokale Original bleibt in Kura erhalten.')).toBeInTheDocument();

  fireEvent.click(within(post).getByRole('button', { name: 'Aktuellen Stand abrufen' }));
  expect(await within(post).findByText(/Aktueller Stand: In Immich geprüft .* Das lokale Original bleibt erhalten\./)).toBeInTheDocument();
  expect(calls(fetch, 'GET', '/immich/transfers/t1')).toHaveLength(1);
});

it('says what to do when there is no history yet', async () => {
  mockApi('user', (path) => path.endsWith('/history') ? json({ runs: [], posts: [] }) : undefined);
  await open('Verlauf');
  expect(await screen.findByText(/Noch keine Läufe/)).toBeInTheDocument();
  expect(screen.getByText('Noch nichts heruntergeladen.')).toBeInTheDocument();
});

it('lists the adapters and lets only administrators switch one off', async () => {
  const adapter = {
    id: 'yt-dlp', label: 'yt-dlp (Videos)', version: null, sourceTypes: [{ id: 'youtube', label: 'YouTube' }], capabilities: youtube.capabilities,
    availability: 'unavailable', reasonCode: 'BINARY_NOT_CONFIGURED', message: 'yt-dlp (Videos) ist auf dem Server nicht installiert oder nicht freigegeben.', checkedAt: null, disabledByAdministrator: false
  };
  let switches: unknown[] = [];
  const fetch = mockApi('admin', (path, init) => {
    if (path.endsWith('/adapters')) return json({ adapters: [adapter] });
    if (path.endsWith('/admin/adapter-kill-switches') && init?.method === 'POST') {
      switches = [{ id: 'k1', adapterId: 'yt-dlp', adapterVersion: null, sourceType: null, reason: 'Extraktor defekt', createdAt: '2026-06-01T10:00:00Z' }];
      return json({ killSwitch: switches[0] }, 201);
    }
    if (path.endsWith('/admin/adapter-kill-switches')) return json({ killSwitches: switches });
    if (path.endsWith('/subscriptions')) return json({ subscriptions: [] });
    return undefined;
  });
  await open('Abonnements');
  const details = screen.getByText('Unterstützte Quellen und Adapter').closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  expect(await screen.findByText(/Nicht verfügbar/)).toBeInTheDocument();
  expect(screen.getByRole('cell', { name: 'YouTube' })).toBeInTheDocument();
  expect(await screen.findByText('Es ist nichts abgeschaltet.')).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Grund'), { target: { value: 'Extraktor defekt' } });
  fireEvent.submit(screen.getByRole('form', { name: 'Adapter abschalten' }));
  expect(await screen.findByText(/Extraktor defekt/)).toBeInTheDocument();
  expect(JSON.parse(String(calls(fetch, 'POST', '/admin/adapter-kill-switches')[0][1]?.body))).toEqual({ adapterId: 'yt-dlp', reason: 'Extraktor defekt' });
});

it('does not show the kill switch controls to normal users', async () => {
  mockApi('user', (path) => path.endsWith('/adapters') ? json({ adapters: [] }) : path.endsWith('/subscriptions') ? json({ subscriptions: [] }) : undefined);
  await open('Abonnements');
  const details = screen.getByText('Unterstützte Quellen und Adapter').closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  await waitFor(() => expect(screen.queryByText('Wird abgerufen …')).not.toBeInTheDocument());
  expect(screen.queryByRole('form', { name: 'Adapter abschalten' })).not.toBeInTheDocument();
});
