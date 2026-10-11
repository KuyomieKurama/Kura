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

/**
 * Draws one picture per spec in a page and returns the encoded bytes, a 480px WebP preview and the average colour,
 * the same facts the worker derives with ffmpeg (UI2-A), so the screenshots show real aspect ratios and previews.
 */
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
      const previewWidth = Math.min(480, spec.width);
      const preview = document.createElement('canvas');
      preview.width = previewWidth;
      preview.height = Math.max(1, Math.round((spec.height * previewWidth) / spec.width));
      preview.getContext('2d').drawImage(canvas, 0, 0, preview.width, preview.height);
      const dot = document.createElement('canvas');
      dot.width = 1;
      dot.height = 1;
      const dotContext = dot.getContext('2d');
      dotContext.drawImage(canvas, 0, 0, 1, 1);
      const [red, green, blue] = dotContext.getImageData(0, 0, 1, 1).data;
      const averageColor = `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
      return {
        original: canvas.toDataURL(spec.mime, 0.86).split(',')[1],
        preview: preview.toDataURL('image/webp', 0.8).split(',')[1],
        averageColor
      };
    }), specs);
    return encoded.map((entry, index) => ({
      bytes: Buffer.from(entry.original, 'base64'),
      preview: Buffer.from(entry.preview, 'base64'),
      averageColor: entry.averageColor,
      width: specs[index].width,
      height: specs[index].height
    }));
  } finally {
    await page.close();
  }
}

/**
 * Records a short animation of any size as a real WebM file (MediaRecorder on a canvas, VP8). Playwright's own video
 * recording is capped to the size of a screen, this is not: 1080x1920 and 3840x2160 are real frame sizes.
 */
async function renderSizedVideo(browser, width, height) {
  const page = await browser.newPage();
  try {
    const encoded = await page.evaluate(async ([w, h]) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const context2d = canvas.getContext('2d');
      const recorder = new MediaRecorder(canvas.captureStream(10), { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 800000 });
      const chunks = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const stopped = new Promise((done) => { recorder.onstop = done; });
      recorder.start();
      const started = performance.now();
      await new Promise((done) => {
        const frame = () => {
          const t = (performance.now() - started) / 1000;
          context2d.fillStyle = '#0b3954';
          context2d.fillRect(0, 0, w, h);
          context2d.fillStyle = '#087e8b';
          context2d.fillRect(0, h * 0.62, w, h * 0.38);
          context2d.fillStyle = '#ffd166';
          context2d.beginPath();
          context2d.arc(w * (0.2 + 0.2 * t), h * 0.35, Math.min(w, h) * 0.12, 0, Math.PI * 2);
          context2d.fill();
          if (t < 1.4) requestAnimationFrame(frame);
          else done(undefined);
        };
        frame();
      });
      recorder.stop();
      await stopped;
      const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
      let text = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) text += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      return btoa(text);
    }, [width, height]);
    return Buffer.from(encoded, 'base64');
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
 * @param {{ browser: object, databaseUrl: string, extraFiles?: { name: string, mime: string, bytes: Buffer }[], large?: boolean }} input
 *   `extraFiles` become one more post of the finished run (the content check adds an SVG and an HTML file).
 *   `large` adds the post "Grosse Formate": real photos and videos at the sizes a camera or a phone produces (4000x6000,
 *   6000x1000, 1000x6000, 5000x3000 without dimensions in the API, videos 1080x1920 and 3840x2160). Off by default,
 *   because the screenshots and the keyboard check count the other files.
 * @returns facts the scripts need (nothing secret)
 */
export async function seedMedia({ browser, databaseUrl, extraFiles = [], large = false }) {
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
      // Landscape 3:2, portrait 3:4, 4:3, portrait 8:11, a panorama and a square: the gallery needs mixed ratios.
      width: [1200, 900, 1000, 800, 1600, 1000][index % 6],
      height: [800, 1200, 750, 1100, 700, 1000][index % 6],
      mime: index % 3 === 1 ? 'image/jpeg' : 'image/png',
      label: `Studie ${String(index + 1).padStart(2, '0')}`
    }));
    const pictures = await renderPictures(browser, [...pictureSpecs, { seed: 40, palette: PALETTES[2], width: 480, height: 270, mime: 'image/png', label: 'Zeitraffer' }]);
    const poster = pictures[pictureSpecs.length];
    // The large post: JPEG, so that a 24 megapixel picture stays a few hundred kilobytes.
    const largeSpecs = [
      { seed: 51, palette: PALETTES[0], width: 4000, height: 6000, mime: 'image/jpeg', name: 'portrait_4000x6000.jpg' },
      { seed: 52, palette: PALETTES[1], width: 6000, height: 1000, mime: 'image/jpeg', name: 'panorama_6000x1000.jpg' },
      { seed: 53, palette: PALETTES[3], width: 1000, height: 6000, mime: 'image/jpeg', name: 'streifen_1000x6000.jpg' },
      { seed: 54, palette: PALETTES[5], width: 5000, height: 3000, mime: 'image/jpeg', name: 'ohne_masse_5000x3000.jpg' },
      { seed: 55, palette: PALETTES[2], width: 540, height: 960, mime: 'image/png', name: 'poster_hoch' },
      { seed: 56, palette: PALETTES[4], width: 960, height: 540, mime: 'image/png', name: 'poster_quer' }
    ];
    const largePictures = large ? await renderPictures(browser, largeSpecs) : [];
    const largeVideos = large ? [await renderSizedVideo(browser, 1080, 1920), await renderSizedVideo(browser, 3840, 2160)] : [];
    const video = await renderVideo(browser);
    const pictureFor = (index) => ({
      ...pictures[index],
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
          // What the worker derives after storing: dimensions, duration, average colour and the 480px preview.
          await pool.query(
            `INSERT INTO asset_media_info (asset_id, status, width, height, duration_seconds, average_color, has_thumbnail)
             VALUES ($1, 'done', $2, $3, $4, $5, $6)`,
            [record.id, file.width ?? null, file.height ?? null, file.duration ?? null, file.averageColor ?? null, Boolean(file.preview)]
          );
          if (file.preview) {
            for (const width of [480, 960]) {
              await pool.query('INSERT INTO asset_thumbnails (asset_id, width, mime_type, data) VALUES ($1, $2, $3, $4)', [record.id, width, 'image/webp', file.preview]);
            }
          }
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
      { bytes: video, mime: 'video/webm', name: 'hafen_zeitraffer.webm', preview: poster.preview, averageColor: poster.averageColor, width: 480, height: 270, duration: 2.4 }
    ]);
    await addPost(finishedRun, '118840003', 'Skizzenbuch Oktober', 46, [pictureFor(7)]);
    await addPost(finishedRun, '118840004', 'Studie: Katze am Fenster', 44, [pictureFor(8)]);
    await addPost(finishedRun, '118840005', null, 42, [pictureFor(9), pictureFor(10)]);
    if (large) {
      const [portrait, panorama, tall, noDimensions, posterTall, posterWide] = largePictures.map((picture, index) => ({ ...picture, mime: largeSpecs[index].mime, name: largeSpecs[index].name }));
      await addPost(finishedRun, '118840050', 'Grosse Formate', 41, [
        portrait,
        panorama,
        tall,
        // What the API sends for a file the worker has not measured yet: no size, no preview, no colour.
        { bytes: noDimensions.bytes, mime: noDimensions.mime, name: noDimensions.name },
        { bytes: largeVideos[0], mime: 'video/webm', name: 'handy_1080x1920.webm', preview: posterTall.preview, averageColor: posterTall.averageColor, width: 1080, height: 1920, duration: 1.4 },
        { bytes: largeVideos[1], mime: 'video/webm', name: 'kino_3840x2160.webm', preview: posterWide.preview, averageColor: posterWide.averageColor, width: 3840, height: 2160, duration: 1.4 }
      ]);
    }
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
