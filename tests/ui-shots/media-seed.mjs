/* global document, requestAnimationFrame, performance, Buffer */
// Seeds real (small, generated) media for the screenshots of the media view and the live run view.
//
// The files go in through the same code the worker uses: HistoryRepository (history rows) and DatabaseBlobStore
// (chunked storage in PostgreSQL), both from the built packages. Pictures are drawn in the browser (canvas) and
// the video is recorded by Playwright, so they are real PNG/JPEG/WebM files, not placeholders.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './stack.mjs';

const PALETTES = [
  ['#1d3557', '#457b9d', '#f1faee', '#e63946'],
  ['#264653', '#2a9d8f', '#e9c46a', '#e76f51'],
  ['#3d348b', '#7678ed', '#f7b801', '#f18701'],
  ['#0b3954', '#087e8b', '#bfd7ea', '#ff5a5f'],
  ['#2b2d42', '#8d99ae', '#edf2f4', '#ef233c'],
  ['#335c67', '#fff3b0', '#e09f3e', '#9e2a2b']
];

/** Draws one picture per spec in a page and returns the encoded bytes. */
async function renderPictures(browser, specs) {
  const page = await browser.newPage();
  try {
    const encoded = await page.evaluate((list) => list.map((spec) => {
      const canvas = document.createElement('canvas');
      canvas.width = spec.width;
      canvas.height = spec.height;
      const context = canvas.getContext('2d');
      const [sky, ground, light, accent] = spec.palette;
      const gradient = context.createLinearGradient(0, 0, 0, spec.height);
      gradient.addColorStop(0, sky);
      gradient.addColorStop(1, ground);
      context.fillStyle = gradient;
      context.fillRect(0, 0, spec.width, spec.height);
      context.fillStyle = light;
      context.beginPath();
      context.arc(spec.width * (0.25 + (spec.seed % 5) * 0.12), spec.height * 0.3, spec.height * 0.13, 0, Math.PI * 2);
      context.fill();
      for (let layer = 0; layer < 3; layer += 1) {
        context.fillStyle = layer === 2 ? accent : ground;
        context.globalAlpha = 0.55 + layer * 0.2;
        context.beginPath();
        context.moveTo(0, spec.height);
        for (let x = 0; x <= spec.width; x += 20) {
          const wave = Math.sin((x / spec.width) * (3 + layer + (spec.seed % 3)) * Math.PI + spec.seed) * spec.height * 0.07;
          context.lineTo(x, spec.height * (0.62 + layer * 0.12) + wave);
        }
        context.lineTo(spec.width, spec.height);
        context.closePath();
        context.fill();
      }
      context.globalAlpha = 1;
      context.fillStyle = light;
      context.font = `${Math.round(spec.height * 0.06)}px sans-serif`;
      context.fillText(spec.label, spec.width * 0.05, spec.height * 0.94);
      return canvas.toDataURL(spec.mime, 0.86).split(',')[1];
    }), specs);
    return encoded.map((base64) => Buffer.from(base64, 'base64'));
  } finally {
    await page.close();
  }
}

/** Records a two second animation as a real WebM file. */
async function renderVideo(browser) {
  const directory = await mkdtemp(resolve(tmpdir(), 'kura-shots-video-'));
  const context = await browser.newContext({ viewport: { width: 480, height: 270 }, recordVideo: { dir: directory, size: { width: 480, height: 270 } } });
  try {
    const page = await context.newPage();
    await page.setContent('<body style="margin:0"><canvas id="c" width="480" height="270"></canvas></body>');
    await page.evaluate(() => new Promise((done) => {
      const canvas = document.getElementById('c');
      const context2d = canvas.getContext('2d');
      const started = performance.now();
      const frame = (now) => {
        const t = (now - started) / 1000;
        context2d.fillStyle = '#0b3954';
        context2d.fillRect(0, 0, 480, 270);
        context2d.fillStyle = '#087e8b';
        context2d.fillRect(0, 170, 480, 100);
        context2d.fillStyle = '#ffd166';
        context2d.beginPath();
        context2d.arc(60 + t * 150, 90 + Math.sin(t * 4) * 30, 34, 0, Math.PI * 2);
        context2d.fill();
        context2d.fillStyle = '#ff5a5f';
        context2d.fillRect(40, 200, 100 + t * 120, 24);
        if (t < 2.4) requestAnimationFrame(frame);
        else done(undefined);
      };
      requestAnimationFrame(frame);
    }));
    const video = page.video();
    await context.close();
    return await readFile(await video.path());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000);

/**
 * @param {{ browser: object, databaseUrl: string, extraFiles?: { name: string, mime: string, bytes: Buffer }[] }} input
 *   `extraFiles` become one more post of the finished run (the content check adds an SVG and an HTML file).
 * @returns facts the scripts need (nothing secret)
 */
export async function seedMedia({ browser, databaseUrl, extraFiles = [] }) {
  const { default: pg } = await import(pathToFileURL(resolve(repoRoot, 'node_modules/pg/lib/index.js')).href);
  const { HistoryRepository } = await import(pathToFileURL(resolve(repoRoot, 'apps/worker/dist/history.js')).href);
  const { DatabaseBlobStore, sha256Digest } = await import(pathToFileURL(resolve(repoRoot, 'packages/blobstore/dist/index.js')).href);
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const user = (await pool.query("SELECT user_id FROM local_credentials WHERE login_email_normalized = 'mara'")).rows[0].user_id;
    const subscription = (await pool.query("SELECT id FROM subscriptions WHERE user_id = $1 AND name = 'Atelier Mori'", [user])).rows[0].id;
    const queuedRun = (await pool.query("SELECT id FROM job_runs WHERE subscription_id = $1 AND state = 'queued'", [subscription])).rows[0]?.id ?? randomUUID();

    let seedTime = minutesAgo(60);
    const clock = { now: () => seedTime };
    const history = new HistoryRepository(pool, clock);
    const blobs = new DatabaseBlobStore(pool, { quotaBytes: 512 * 1024 * 1024 });

    const pictureSpecs = Array.from({ length: 16 }, (_, index) => ({
      seed: index + 1,
      palette: PALETTES[index % PALETTES.length],
      width: [1200, 900, 1000, 800][index % 4],
      height: [800, 1200, 750, 1100][index % 4],
      mime: index % 3 === 1 ? 'image/jpeg' : 'image/png',
      label: `Studie ${String(index + 1).padStart(2, '0')}`
    }));
    const pictures = await renderPictures(browser, pictureSpecs);
    const video = await renderVideo(browser);
    const pictureFor = (index) => ({
      bytes: pictures[index],
      mime: pictureSpecs[index].mime,
      name: `illustration_${String(index + 1).padStart(2, '0')}.${pictureSpecs[index].mime === 'image/png' ? 'png' : 'jpg'}`
    });

    async function store(bytes) {
      const session = await blobs.beginWrite({ ownerUserId: user });
      const chunk = 1024 * 1024;
      for (let offset = 0; offset < bytes.length; offset += chunk) await blobs.append(session, bytes.subarray(offset, offset + chunk));
      return (await blobs.finalize(session, sha256Digest(bytes))).id;
    }

    async function createRun(jobRunId, minutes, finished) {
      seedTime = minutesAgo(minutes);
      const runId = await history.startRun({
        userId: user, jobRunId, leaseGeneration: 1, subscriptionId: subscription, subscriptionName: 'Atelier Mori',
        sourceUrl: 'https://www.pixiv.net/users/4411', triggerKind: finished ? 'schedule' : 'manual'
      });
      await history.updateRun(runId, { state: finished ? 'stored' : 'downloading', platform: 'pixiv', adapterId: 'gallery-dl', adapterVersion: '1.32.2' });
      return runId;
    }

    async function addPost(runId, key, title, minutes, files) {
      seedTime = minutesAgo(minutes);
      const post = await history.upsertPost({
        userId: user, runId, subscriptionId: subscription, platform: 'pixiv', adapterId: 'gallery-dl', adapterVersion: '1.32.2',
        creatorPlatformId: '4411', creatorName: 'atelier_mori', platformPostId: key, revisionKey: '1', title,
        sourceUrl: `https://www.pixiv.net/artworks/${key}`, publishedAt: null
      });
      const manifest = files.map((file, assetIndex) => ({
        assetIndex, sourceAssetId: `${key}-${assetIndex}`, originalName: file.name, mediaType: file.mime, role: 'original', variant: 'original',
        quality: { preset: 'BEST_AVAILABLE', width: null, height: null, container: null }, declaredBytes: null, completeness: 'complete'
      }));
      const records = await history.upsertAssets(post.id, user, manifest);
      for (const [position, file] of files.entries()) {
        const record = records[position];
        seedTime = minutesAgo(minutes - position * 0.1);
        const state = file.state ?? 'stored';
        if (state === 'stored') {
          const blobObjectId = await store(file.bytes);
          await history.markAssetStored(record.id, {
            sha256: createHash('sha256').update(file.bytes).digest('hex'), sha1: createHash('sha1').update(file.bytes).digest('hex'),
            byteSize: file.bytes.length, blobObjectId
          });
          if (file.verified) {
            const transferId = randomUUID();
            await pool.query(
              `INSERT INTO immich_transfers (id, user_id, object_id, target_id, status, own_sha256, verified_at, verified_server_version, verified_byte_size, verified_album_state)
               VALUES ($1, $2, $3, 'shots-target', 'verified', $4, now(), '2.1.0', $5, 'none')`,
              [transferId, user, blobObjectId, createHash('sha256').update(file.bytes).digest('hex'), file.bytes.length]
            );
            await history.setHandover(record.id, 'verified', transferId);
          } else if (file.handover) {
            await history.setHandover(record.id, file.handover);
          }
        } else if (state === 'downloading') {
          await history.startAsset(record.id);
        } else if (state === 'failed') {
          await history.markAssetFailed(record.id, 'DOWNLOAD_FAILED', 'Netzwerkfehler beim Abruf. Der Lauf wird wiederholt.');
        }
      }
      await history.setPostState(post.id, files.every((file) => (file.state ?? 'stored') === 'stored') ? 'stored' : 'downloading', true);
    }

    const finishedRun = await createRun(randomUUID(), 55, true);
    await addPost(finishedRun, '118840001', 'Frühlingsserie, Teil 3', 54, [0, 1, 2, 3, 4].map((index) => ({ ...pictureFor(index), verified: index < 3 })));
    await addPost(finishedRun, '118840002', 'Hafen bei Nacht', 50, [
      { ...pictureFor(5), handover: 'uploaded_unverified' },
      pictureFor(6),
      { bytes: video, mime: 'video/webm', name: 'hafen_zeitraffer.webm' }
    ]);
    await addPost(finishedRun, '118840003', 'Skizzenbuch Oktober', 46, [pictureFor(7)]);
    await addPost(finishedRun, '118840004', 'Studie: Katze am Fenster', 44, [pictureFor(8)]);
    await addPost(finishedRun, '118840005', null, 42, [pictureFor(9), pictureFor(10)]);
    if (extraFiles.length > 0) await addPost(finishedRun, '118840099', 'Dateien mit riskantem Typ', 40, extraFiles);
    await history.updateRun(finishedRun, { state: 'stored', stats: { postsFound: 5, postsSkipped: 0, assetsStored: 12, assetsFailed: 0, bytesStored: 1 }, finished: true });

    // The run that is still going: it belongs to the queued run that "Jetzt ausführen" shows.
    const liveRun = await createRun(queuedRun, 3, false);
    await addPost(liveRun, '118840006', 'Neue Veröffentlichung', 2, [
      pictureFor(11),
      pictureFor(12),
      { name: 'making_of.webm', mime: 'video/webm', state: 'downloading' },
      { name: 'illustration_14.png', mime: 'image/png', state: 'pending' },
      { name: 'illustration_15.png', mime: 'image/png', state: 'failed' }
    ]);
    seedTime = minutesAgo(0);
    await history.updateRun(liveRun, { stats: { postsFound: 1, postsSkipped: 0, assetsStored: 2, assetsFailed: 1, bytesStored: 1 } });

    return { storedFiles: 14, liveRunId: liveRun, queuedRunId: queuedRun };
  } finally {
    await pool.end();
  }
}
