// Browser-level fixtures for views that the API cannot fill without a running worker (history, Immich transfer).
// The screenshot script serves them through page.route; everything else comes from the real API.

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

function asset(index, overrides = {}) {
  const sha = Array.from({ length: 64 }, (_, position) => ((index * 7 + position * 5) % 16).toString(16)).join('');
  return {
    id: `asset-${index}-${overrides.postId ?? 'x'}`,
    index,
    sourceAssetId: `file-${index}`,
    originalName: `illustration_${String(index + 1).padStart(2, '0')}.png`,
    mediaType: 'image/png',
    state: 'stored',
    attempts: 1,
    byteSize: 1_800_000 + index * 311_000,
    sha256: sha,
    errorCode: null,
    errorMessage: null,
    storedAt: minutesAgo(40),
    localOriginalRetained: true,
    handover: {
      state: 'verified',
      at: minutesAgo(39),
      transferId: `transfer-${index}`,
      transferStatus: 'verified',
      evidence: { serverVersion: '2.1.0', byteLength: 1_800_000 + index * 311_000, album: 'assigned', verifiedAt: minutesAgo(39) }
    },
    ...overrides
  };
}

const notHandedOver = { state: 'not_attempted', at: null, transferId: null, transferStatus: null, evidence: null };

function post(id, title, subscriptionName, state, assets, discoveredMinutesAgo) {
  return {
    id,
    subscriptionId: 's1',
    subscriptionName,
    platform: 'pixiv',
    adapterId: 'gallery-dl',
    creatorId: '4411',
    creatorName: 'atelier_mori',
    platformPostId: id.replace('post-', '9'),
    title,
    sourceUrl: 'https://www.pixiv.net/artworks/123',
    state,
    discoveryComplete: true,
    discoveredAt: minutesAgo(discoveredMinutesAgo),
    completedAt: state === 'stored' ? minutesAgo(discoveredMinutesAgo - 3) : null,
    assets
  };
}

export const history = {
  runs: [
    {
      id: 'run-1', subscriptionId: 's1', subscriptionName: 'Atelier Mori', sourceUrl: 'https://www.pixiv.net/users/4411', triggerKind: 'schedule',
      platform: 'pixiv', adapterId: 'gallery-dl', adapterVersion: '1.32.2', state: 'stored', errorCode: null, errorMessage: null,
      postsFound: 3, postsSkipped: 1, assetsStored: 11, assetsFailed: 0, bytesStored: 48_231_552, startedAt: minutesAgo(46), finishedAt: minutesAgo(41)
    },
    {
      id: 'run-2', subscriptionId: 's2', subscriptionName: 'Kanal Nordlicht', sourceUrl: 'https://www.youtube.com/@nordlicht', triggerKind: 'manual',
      platform: 'youtube', adapterId: 'yt-dlp', adapterVersion: null, state: 'partially_completed', errorCode: 'PROCESS_FAILED',
      errorMessage: 'Das Werkzeug ist fehlgeschlagen. Der Lauf wird wiederholt.', postsFound: 1, postsSkipped: 0, assetsStored: 1, assetsFailed: 1,
      bytesStored: 612_345_678, startedAt: minutesAgo(130), finishedAt: minutesAgo(121)
    },
    {
      id: 'run-3', subscriptionId: 's3', subscriptionName: 'Fotoblog Hafen', sourceUrl: null, triggerKind: 'schedule', platform: null, adapterId: null,
      adapterVersion: null, state: 'waiting_auth', errorCode: 'AUTH_REQUIRED',
      errorMessage: 'Die Quelle verlangt eine Anmeldung oder die Anmeldung ist abgelaufen. Das Abonnement wurde pausiert.', postsFound: 0,
      postsSkipped: 0, assetsStored: 0, assetsFailed: 0, bytesStored: 0, startedAt: minutesAgo(300), finishedAt: minutesAgo(299)
    },
    {
      id: 'run-4', subscriptionId: 's1', subscriptionName: 'Atelier Mori', sourceUrl: 'https://www.pixiv.net/users/4411', triggerKind: 'schedule',
      platform: 'pixiv', adapterId: 'gallery-dl', adapterVersion: '1.32.2', state: 'downloading', errorCode: null, errorMessage: null,
      postsFound: 1, postsSkipped: 0, assetsStored: 0, assetsFailed: 0, bytesStored: 0, startedAt: minutesAgo(2), finishedAt: null
    }
  ],
  posts: [
    post('post-1', 'Frühlingsserie, Teil 3', 'Atelier Mori', 'stored', [0, 1, 2, 3, 4].map((index) => asset(index, { postId: 'p1' })), 46),
    post('post-2', 'Hafen bei Nacht', 'Atelier Mori', 'partially_completed', [
      asset(0, { postId: 'p2' }),
      asset(1, { postId: 'p2', handover: { ...notHandedOver, state: 'uploaded_unverified', transferId: 'transfer-u', transferStatus: 'uploaded_unverified' } }),
      asset(2, { postId: 'p2', state: 'failed', attempts: 3, byteSize: null, sha256: null, storedAt: null, errorMessage: 'Netzwerkfehler beim Abruf. Der Lauf wird wiederholt.', handover: notHandedOver }),
      asset(3, { postId: 'p2', state: 'downloading', byteSize: null, sha256: null, storedAt: null, handover: notHandedOver }),
      asset(4, { postId: 'p2', state: 'pending', byteSize: null, sha256: null, storedAt: null, handover: notHandedOver })
    ], 130),
    post('post-3', 'Skizzenbuch Oktober', 'Atelier Mori', 'stored', [
      asset(0, { postId: 'p3', handover: notHandedOver }),
      asset(1, { postId: 'p3', handover: { ...notHandedOver, state: 'no_connection' } })
    ], 300),
    post('post-4', 'Neue Veröffentlichung', 'Atelier Mori', 'discovered', [], 2)
  ]
};

export const transferVerified = {
  id: 'transfer-demo',
  status: 'verified',
  localOriginalRetained: true,
  evidence: { serverVersion: '2.1.0', byteLength: 2048, album: 'none' }
};

// Live view of the running run in the mocked history (run-4): no file yet, the queue has it.
export const historyLive = {
  run: { ...history.runs[3], jobRunId: 'job-4' },
  queue: { state: 'leased', lastError: null },
  active: true,
  counts: { pending: 0, downloading: 0, verifying: 0, stored: 0, failed: 0 },
  truncated: false,
  assets: []
};

// A picture for the history's fixture files (hasThumbnail): flat shapes, so the 56px post picture shows a real preview
// and not only the glyph. Served for thumbnail requests of the fixture assets (asset-<index>-<post>).
export function fixtureThumbnail(assetId) {
  const index = Number(/^asset-(\d+)-/.exec(assetId)?.[1] ?? 0);
  const sky = ['#9db7d5', '#d9b38c', '#a9c4a0', '#c8a2c8', '#e3c58a'][index % 5];
  const ground = ['#4c6a8a', '#8a5a3c', '#4f7a49', '#6c4a6c', '#8a6a2c'][index % 5];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" width="160" height="160"><rect width="160" height="160" fill="${sky}"/><circle cx="${50 + index * 12}" cy="52" r="20" fill="#f6efe2"/><path d="M0 120 L50 80 L90 112 L120 90 L160 124 L160 160 L0 160 Z" fill="${ground}"/></svg>`;
}
