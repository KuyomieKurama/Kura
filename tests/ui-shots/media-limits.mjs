/* global process, console, fetch, document, window, getComputedStyle, Buffer */
// Browser limits of the media views: node tests/ui-shots/media-limits.mjs [--skip-build] [--out=dir]
//
// Real sizes instead of 160px placeholders: the post "Grosse Formate" holds photos of 4000x6000, 6000x1000 and
// 1000x6000, a 5000x3000 picture the API knows no dimensions of, and videos of 1080x1920 and 3840x2160.
// For every viewport (390, 768, 1024, 1440, 1920 wide, 1440x700 and the phone on its side, 844x390) it checks
//   1. the overview and the media page: the page never scrolls sideways
//      (documentElement.scrollWidth <= clientWidth) and no tile leaves the viewport width;
//   2. the viewer, for every one of those files and a normal one, with and without the info column: the box of
//      .viewer-media lies completely inside window.innerWidth x window.innerHeight (at the scroll position the
//      viewer opens at), has a usable size, and the viewer itself does not scroll sideways.
// The measurement runs with prefers-reduced-motion (no View Transition when the viewer opens); --motion switches the
// transition on again.
// With --out=dir it also writes a viewport shot of each viewer case. Exits with 1 when a check fails.
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { seedMedia } from './media-seed.mjs';
import { loadPlaywright, startStack } from './stack.mjs';

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));
const outDirectory = args.has('out') ? resolve(args.get('out')) : null;
const ADMIN = { displayName: 'Mara Admin', username: 'mara', password: 'Kura-Beispiel-2026!' };

const VIEWPORTS = [
  { name: '390', width: 390, height: 844 },
  { name: '768', width: 768, height: 1024 },
  { name: '1024', width: 1024, height: 768 },
  { name: '1440', width: 1440, height: 900 },
  { name: '1920', width: 1920, height: 1080 },
  { name: '1440x700', width: 1440, height: 700 },
  { name: '844x390', width: 844, height: 390 }
];

if (args.has('size')) {
  const [width, height] = args.get('size').split('x').map(Number);
  VIEWPORTS.push({ name: args.get('size'), width, height });
}

const FILES = [
  { name: 'portrait_4000x6000.jpg', label: 'portrait' },
  { name: 'panorama_6000x1000.jpg', label: 'panorama' },
  { name: 'streifen_1000x6000.jpg', label: 'streifen' },
  { name: 'ohne_masse_5000x3000.jpg', label: 'ohne-masse' },
  { name: 'handy_1080x1920.webm', label: 'video-hoch' },
  { name: 'kino_3840x2160.webm', label: 'video-quer' }
];

const only = args.has('viewports') ? new Set(args.get('viewports').split(',')) : null;
const onlyFiles = args.has('files') ? new Set(args.get('files').split(',')) : null;
const failures = [];
const rows = [];
const check = (condition, description) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${description}`);
  if (!condition) failures.push(description);
};
const px = (value) => Math.round(value * 10) / 10;

const { chromium } = await loadPlaywright();
const stack = await startStack({ skipBuild: args.has('skip-build') });
// --disable-dev-shm-usage: a container's /dev/shm is small and a 4K video decode fills it.
// --num-raster-threads=1: the software GL of the sandbox crashes the renderer when several raster threads scale a
// 24 megapixel picture at once (seen at 844x390 and 1920x1080, with the old and the new layout alike).
const launchOptions = { args: ['--num-raster-threads=1', ...(args.get('chromium') ?? '').split(',').filter(Boolean)] };
const browser = await chromium.launch(launchOptions);

/** Page level: does the document scroll sideways, and does anything stick out on the right. */
const measurePage = () => {
  const root = document.documentElement;
  const width = root.clientWidth;
  const offenders = [];
  for (const element of document.querySelectorAll('main *, .main *, .gallery-item, .tile')) {
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.right > width + 1 && getComputedStyle(element).position !== 'fixed') offenders.push(`${element.tagName.toLowerCase()}.${String(element.className).split(' ')[0]} right ${Math.round(box.right)}`);
    if (offenders.length >= 3) break;
  }
  return { scrollWidth: root.scrollWidth, clientWidth: width, bodyScrollWidth: document.body.scrollWidth, offenders };
};

/** Viewer level: where is the shown medium, and where the screen it sits on. */
const measureViewer = () => {
  const screen = document.querySelector('.viewer-screen');
  const media = screen?.querySelector('.viewer-media');
  if (!screen || !media) return null;
  const box = media.getBoundingClientRect();
  const stage = screen.querySelector('.viewer-stage')?.getBoundingClientRect();
  const strip = screen.querySelector('.viewer-strip')?.getBoundingClientRect();
  const infoElement = screen.querySelector('.viewer-info');
  const info = infoElement && !infoElement.hidden ? infoElement.getBoundingClientRect() : null;
  return {
    box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height },
    stage: stage ? { top: stage.top, bottom: stage.bottom, height: stage.height } : null,
    strip: strip ? { top: strip.top, bottom: strip.bottom, height: strip.height } : null,
    info: info ? { top: info.top, left: info.left, bottom: info.bottom } : null,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    screenScrollWidth: screen.scrollWidth,
    screenClientWidth: screen.clientWidth,
    screenScrollTop: screen.scrollTop,
    natural: media instanceof HTMLImageElement ? [media.naturalWidth, media.naturalHeight] : [media.videoWidth, media.videoHeight]
  };
};

try {
  const setup = await fetch(`${stack.origin}/api/v1/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ADMIN)
  });
  const csrf = (await setup.json()).csrfToken;
  const cookie = setup.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');
  const created = await fetch(`${stack.origin}/api/v1/subscriptions`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-kura-csrf': csrf },
    body: JSON.stringify({ name: 'Atelier Mori', targetUrl: 'https://www.pixiv.net/users/4411', platformHint: 'pixiv' })
  });
  check(created.ok, 'subscription created through the API');
  await seedMedia({ browser, databaseUrl: stack.databaseUrl, large: true });
  const listed = await (await fetch(`${stack.origin}/api/v1/subscriptions/${(await created.json()).subscription.id}/media?limit=100`, { headers: { cookie } })).json();
  for (const file of FILES) check(listed.items.some((item) => item.originalName === file.name), `seeded: ${file.name}`);
  const unmeasured = listed.items.find((item) => item.originalName === 'ohne_masse_5000x3000.jpg');
  check(unmeasured && !unmeasured.width && !unmeasured.height && !unmeasured.hasThumbnail, 'the API sends no dimensions and no preview for ohne_masse_5000x3000.jpg');

  if (outDirectory) await mkdir(outDirectory, { recursive: true });

  // One browser per viewport and one retry when the renderer of this sandbox (software GL) crashes: it does so now and
  // then after many decodes of 24 megapixel pictures, also on the old layout. A retry is printed, never hidden.
  const runViewport = async (viewport, browser) => {
    let crashed = false;
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: 'dark', reducedMotion: args.has('motion') ? 'no-preference' : 'reduce', locale: 'de-DE', timezoneId: 'Europe/Berlin' });
    await context.addCookies(cookie.split('; ').map((pair) => {
      const [name, ...rest] = pair.split('=');
      return { name, value: rest.join('='), url: stack.origin };
    }));
    const page = await context.newPage();
    const tag = `${viewport.name}`;
    try {
      await page.goto(stack.origin);
      await page.getByRole('heading', { name: 'Übersicht', level: 1 }).waitFor();
      await page.waitForTimeout(400);
      let measured = await page.evaluate(measurePage);
      check(measured.scrollWidth <= measured.clientWidth, `${tag} overview: no sideways scroll (scrollWidth ${measured.scrollWidth}, clientWidth ${measured.clientWidth}${measured.offenders.length ? `; ${measured.offenders.join(', ')}` : ''})`);
      rows.push({ viewport: tag, view: 'overview', ...measured });

      // The media page.
      const nav = page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name: /^Medien$/ });
      if (await nav.count() > 0) await nav.click();
      else {
        await page.getByRole('button', { name: 'Mehr', exact: true }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Medien', exact: true }).click();
      }
      await page.getByRole('button', { name: /^Bild portrait_4000x6000/ }).waitFor();
      await page.evaluate(() => document.querySelectorAll('img[loading="lazy"]').forEach((image) => { image.loading = 'eager'; }));
      await page.waitForFunction(() => [...document.images].every((image) => image.complete));
      await page.waitForTimeout(300);
      measured = await page.evaluate(measurePage);
      check(measured.scrollWidth <= measured.clientWidth, `${tag} media page: no sideways scroll (scrollWidth ${measured.scrollWidth}, clientWidth ${measured.clientWidth}${measured.offenders.length ? `; ${measured.offenders.join(', ')}` : ''})`);
      rows.push({ viewport: tag, view: 'media-page', ...measured });
      if (outDirectory) {
        await page.evaluate(() => document.querySelector('[aria-label^="Beitrag Grosse Formate"]')?.scrollIntoView());
        await page.waitForTimeout(150);
        await page.screenshot({ path: resolve(outDirectory, `media-large-gallery-dark-${tag}.png`) });
      }

      // The viewer, file by file, with and without the info column.
      await page.getByRole('button', { name: new RegExp(`^(Bild|Video) ${args.get('first') ?? 'portrait_4000x6000'}`) }).click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      for (const file of [...FILES, { name: 'illustration_01.png', label: 'normal' }].filter((entry) => !onlyFiles || onlyFiles.has(entry.label))) {
        // Pictures that are not in this post's strip (illustration_01) are reached through the tile; the others through the strip.
        const strip = dialog.getByRole('list', { name: 'Dateien dieses Beitrags' }).getByRole('button', { name: new RegExp(` ${file.name}$`) });
        if (file.label === 'normal') {
          await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'detached' });
          await page.getByRole('button', { name: /^Bild illustration_01/ }).click();
          await dialog.waitFor();
        } else {
          await strip.evaluate((button) => button.click());
        }
        for (const infoOn of [false, true]) {
          const current = (await dialog.getAttribute('data-info')) === 'true';
          if (current !== infoOn) await dialog.getByRole('button', { name: 'Info', exact: true }).evaluate((button) => button.click());
          await page.waitForFunction((expected) => document.querySelector('.viewer-screen')?.getAttribute('data-info') === String(expected), infoOn);
          await page.waitForFunction(() => {
            const media = document.querySelector('.viewer-screen .viewer-media');
            if (!media) return false;
            return media instanceof HTMLImageElement ? media.complete && media.naturalWidth > 0 : media.readyState >= 1;
          }, undefined, { timeout: 20000 });
          // The fade-in of the viewer must be over before a box is measured.
          await page.waitForTimeout(350);
          const m = await page.evaluate(measureViewer);
          const label = `${tag} viewer ${file.label} info ${infoOn ? 'on ' : 'off'}`;
          const inside = m.box.left >= -0.5 && m.box.top >= -0.5 && m.box.right <= m.innerWidth + 0.5 && m.box.bottom <= m.innerHeight + 0.5;
          const usable = m.box.width >= 60 && m.box.height >= 60;
          const noSideways = m.screenScrollWidth <= m.screenClientWidth;
          rows.push({ viewport: tag, view: `viewer ${file.label} info-${infoOn ? 'on' : 'off'}`, box: m.box, stage: m.stage, strip: m.strip, info: m.info, natural: m.natural });
          check(inside, `${label}: medium inside the viewport (box ${px(m.box.left)},${px(m.box.top)} to ${px(m.box.right)},${px(m.box.bottom)} = ${px(m.box.width)}x${px(m.box.height)}; window ${m.innerWidth}x${m.innerHeight}; natural ${m.natural.join('x')})`);
          check(usable, `${label}: medium has a usable size (${px(m.box.width)}x${px(m.box.height)})`);
          // Under the picture (narrow) the info column must not cover the strip; beside it (wide) it must not cover the stage.
          const overlaps = m.info && m.strip && m.info.left <= 1 && m.strip.bottom > m.info.top + 0.5;
          check(!overlaps, `${label}: the strip is not covered by the info column${m.strip && m.info ? ` (strip bottom ${px(m.strip.bottom)}, info top ${px(m.info.top)})` : ''}`);
          check(!m.strip || m.strip.height >= 56 + 2, `${label}: the strip keeps the height of its tiles (${m.strip ? px(m.strip.height) : 'no strip'} >= 58)`);
          check(noSideways, `${label}: viewer does not scroll sideways (${m.screenScrollWidth} <= ${m.screenClientWidth})`);
          if (outDirectory && file.label !== 'normal') {
            await page.screenshot({ path: resolve(outDirectory, `media-viewer-${file.label}-info-${infoOn ? 'on' : 'off'}-dark-${tag}.png`) });
          }
        }
      }
      await page.keyboard.press('Escape');
    } catch (error) {
      if (/crashed/i.test(error.message)) crashed = true;
      else check(false, `${tag}: script error ${String(error.message).split('\n')[0]}`);
    }
    await context.close().catch(() => undefined);
    return crashed;
  };
  for (const viewport of VIEWPORTS.filter((entry) => !only || only.has(entry.name))) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const own = await chromium.launch(launchOptions);
      const mark = failures.length;
      const crashed = await runViewport(viewport, own);
      await own.close();
      if (!crashed) break;
      failures.length = mark;
      if (attempt === 2) check(false, `${viewport.name}: the renderer crashed twice`);
      else console.log(`note ${viewport.name}: the renderer crashed (known flake of the sandbox), measuring again in a fresh browser`);
    }
  }
} finally {
  await browser.close();
  await stack.stop();
}

if (args.has('json')) console.log(JSON.stringify(rows));
if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll checks passed.');
}
