/* global process, console, fetch, document, window, requestAnimationFrame */
// The sidebar stands still while the page scrolls: node tests/ui-shots/sidebar-sticky.mjs [--skip-build] [--out=dir]
//
// From 1024px the test strip sits at the top and the sidebar below it. Only the content may scroll. For 1440x900 and
// 1024x700, with the strip and with the strip removed from the DOM, on the pages Medien, Verlauf and Abo-Detail it
// measures getBoundingClientRect() of the brand (wordmark), the first navigation entry and the foot of the sidebar at
//   scroll 0, 50, 400 and the very bottom of the page,
// and checks that
//   1. all three boxes stay where they were at scroll 0 (tolerance 0.5px);
//   2. the sidebar fills the height without a gap: its bottom is the bottom of the viewport and its top is the
//      bottom of the strip (0 without a strip);
//   3. the strip stays visible at the top (top 0, in the viewport) at every position;
//   4. the sticky day heading of the media page sits directly under the strip, not under a top bar that is not there.
// A page that is too short to scroll 400px gets a spacer of 2400px inside .page, so that every position can be reached;
// the output says so ("padded"). Below 1024px (390x844, media page) it checks that nothing changed: the top bar stays
// at the top, the bottom navigation at the bottom, the strip scrolls away with the page.
// With --out=dir it also writes a viewport shot at scroll 400 for each case. Exits with 1 when a check fails.
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { history, fixtureThumbnail } from './fixtures.mjs';
import { seedMedia } from './media-seed.mjs';
import { loadPlaywright, startStack } from './stack.mjs';

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));
const outDirectory = args.has('out') ? resolve(args.get('out')) : null;
const ADMIN = { displayName: 'Mara Admin', username: 'mara', password: 'Kura-Beispiel-2026!' };
const TOLERANCE = 0.5;

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1024x700', width: 1024, height: 700 }
];
const PAGES = ['Medien', 'Verlauf', 'Abo-Detail'];

const failures = [];
const rows = [];
const check = (condition, description) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${description}`);
  if (!condition) failures.push(description);
};
const px = (value) => Math.round(value * 10) / 10;
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const { chromium } = await loadPlaywright();
const stack = await startStack({ skipBuild: args.has('skip-build') });
const browser = await chromium.launch({ args: ['--num-raster-threads=1'] });

/** Boxes of the sidebar parts, the strip and the sticky day heading at the current scroll position. */
const measure = () => {
  const box = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const { top, bottom, left, right } = element.getBoundingClientRect();
    return { top, bottom, left, right };
  };
  const root = document.documentElement;
  return {
    scrollY: window.scrollY,
    maxScroll: root.scrollHeight - window.innerHeight,
    innerHeight: window.innerHeight,
    brand: box('.sidebar-top .wordmark'),
    firstNav: box('.sidebar .nav-item'),
    foot: box('.sidebar-foot'),
    sidebar: box('.sidebar-sticky'),
    strip: box('.shell > .test-strip'),
    topbar: box('.topbar'),
    bottomnav: box('.bottomnav'),
    heading: box('.day-heading')
  };
};

/** Scrolls the document and waits until two frames have been drawn, so the compositor has settled. */
const scrollTo = async (page, y) => {
  await page.evaluate((target) => new Promise((done) => {
    window.scrollTo(0, target);
    requestAnimationFrame(() => requestAnimationFrame(done));
  }), y);
  await page.waitForTimeout(60);
  return page.evaluate(measure);
};

const apiHeaders = (csrf, cookie) => ({ 'content-type': 'application/json', cookie, 'x-kura-csrf': csrf });

try {
  const setup = await fetch(`${stack.origin}/api/v1/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ADMIN) });
  const csrf = (await setup.json()).csrfToken;
  const cookie = setup.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');
  const created = await fetch(`${stack.origin}/api/v1/subscriptions`, {
    method: 'POST', headers: apiHeaders(csrf, cookie),
    body: JSON.stringify({ name: 'Atelier Mori', targetUrl: 'https://www.pixiv.net/users/4411', platformHint: 'pixiv' })
  });
  check(created.ok, 'subscription created through the API');
  await seedMedia({ browser, databaseUrl: stack.databaseUrl });

  if (outDirectory) await mkdir(outDirectory, { recursive: true });

  const openPage = async (page, name) => {
    const nav = (label) => page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name: new RegExp(`^${label}$`) });
    if (name === 'Medien') {
      await nav('Medien').click();
      await page.getByRole('button', { name: /^Bild illustration_/ }).first().waitFor();
    } else if (name === 'Verlauf') {
      await nav('Verlauf').click();
      await page.getByRole('heading', { name: 'Läufe' }).waitFor();
    } else {
      await nav('Abonnements').click();
      await page.getByRole('button', { name: 'Atelier Mori öffnen' }).click();
      await page.getByRole('heading', { name: 'Atelier Mori', level: 1 }).waitFor();
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
  };

  for (const viewport of VIEWPORTS) {
    for (const name of PAGES) {
      for (const withStrip of [true, false]) {
        const tag = `${viewport.name} ${name} ${withStrip ? 'with strip' : 'no strip '}`;
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: 'dark', reducedMotion: 'reduce', locale: 'de-DE', timezoneId: 'Europe/Berlin' });
        await context.addCookies(cookie.split('; ').map((pair) => {
          const [key, ...rest] = pair.split('=');
          return { name: key, value: rest.join('='), url: stack.origin };
        }));
        const page = await context.newPage();
        try {
          if (name === 'Verlauf') {
            await page.route('**/api/v1/history', (route) => json(route, history));
            await page.route(/\/api\/v1\/assets\/asset-\d+-[^/]+\/thumbnail/, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: fixtureThumbnail(/assets\/([^/]+)\/thumbnail/.exec(route.request().url())?.[1] ?? 'asset-0-x') }));
          }
          await page.goto(stack.origin);
          await page.getByRole('heading', { name: 'Übersicht', level: 1 }).waitFor();
          await openPage(page, name);
          if (!withStrip) await page.evaluate(() => document.querySelector('.shell > .test-strip')?.remove());

          let padded = false;
          const initial = await page.evaluate(measure);
          if (initial.maxScroll < 800) {
            await page.evaluate(() => {
              const spacer = document.createElement('div');
              spacer.style.height = '2400px';
              spacer.setAttribute('aria-hidden', 'true');
              document.querySelector('.page')?.append(spacer);
            });
            padded = true;
          }

          const steps = [];
          const start = await scrollTo(page, 0);
          steps.push({ at: 'top', m: start });
          steps.push({ at: '50px', m: await scrollTo(page, 50) });
          steps.push({ at: '400px', m: await scrollTo(page, 400) });
          const bottomTarget = (await page.evaluate(measure)).maxScroll;
          steps.push({ at: `bottom (${Math.round(bottomTarget)}px)`, m: await scrollTo(page, bottomTarget) });
          if (outDirectory) {
            await scrollTo(page, 400);
            await page.screenshot({ path: resolve(outDirectory, `sidebar-${name.toLowerCase()}-${withStrip ? 'strip' : 'nostrip'}-${viewport.name}.png`) });
          }
          rows.push({ case: tag, padded, steps });

          const wanted = withStrip ? 32 : 0;
          const stripBottom = start.strip ? start.strip.bottom : 0;
          check(Boolean(start.strip) === withStrip && Math.abs(stripBottom - wanted) <= TOLERANCE, `${tag}: strip ${withStrip ? `above the sidebar (bottom ${px(stripBottom)})` : 'removed'}${padded ? ' [padded]' : ''}`);
          check(start.maxScroll >= 400, `${tag}: the page scrolls at least 400px (${px(start.maxScroll)})`);
          for (const { at, m } of steps) {
            const drift = ['brand', 'firstNav', 'foot'].map((part) => `${part} ${px(m[part].top - start[part].top)}`);
            const moved = ['brand', 'firstNav', 'foot'].some((part) => Math.abs(m[part].top - start[part].top) > TOLERANCE || Math.abs(m[part].bottom - start[part].bottom) > TOLERANCE);
            check(!moved, `${tag}, scroll ${at}: brand, first entry and foot stay put (shift ${drift.join(', ')})`);
            const top = m.sidebar.top;
            const gapTop = Math.abs(top - stripBottom) <= TOLERANCE;
            const gapBottom = Math.abs(m.sidebar.bottom - m.innerHeight) <= TOLERANCE;
            check(gapTop && gapBottom, `${tag}, scroll ${at}: the sidebar fills the height (top ${px(top)} vs ${px(stripBottom)}, bottom ${px(m.sidebar.bottom)} vs ${m.innerHeight})`);
            if (withStrip) check(m.strip && Math.abs(m.strip.top) <= TOLERANCE && m.strip.bottom <= m.innerHeight, `${tag}, scroll ${at}: the strip stays visible (top ${m.strip ? px(m.strip.top) : 'gone'})`);
          }
          const at400 = steps[2].m;
          if (name === 'Medien' && at400.heading) {
            check(Math.abs(at400.heading.top - stripBottom) <= TOLERANCE, `${tag}, scroll 400px: the sticky day heading sits under the strip (top ${px(at400.heading.top)} vs ${px(stripBottom)})`);
          }
        } catch (error) {
          check(false, `${tag}: script error ${String(error.message).split('\n')[0]}`);
        }
        await context.close().catch(() => undefined);
      }
    }
  }

  // Below 1024px nothing changes: the top bar stays on top, the bottom navigation at the bottom, the strip scrolls away.
  {
    const tag = '390x844 Medien';
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', reducedMotion: 'reduce', locale: 'de-DE', timezoneId: 'Europe/Berlin' });
    await context.addCookies(cookie.split('; ').map((pair) => {
      const [key, ...rest] = pair.split('=');
      return { name: key, value: rest.join('='), url: stack.origin };
    }));
    const page = await context.newPage();
    try {
      await page.goto(stack.origin);
      await page.getByRole('heading', { name: 'Übersicht', level: 1 }).waitFor();
      await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name: /^Medien$/ }).click();
      await page.getByRole('button', { name: /^Bild illustration_/ }).first().waitFor();
      await page.waitForTimeout(300);
      const start = await scrollTo(page, 0);
      const later = await scrollTo(page, 400);
      check(start.sidebar === null && start.topbar && start.bottomnav, `${tag}: top bar and bottom navigation, no sidebar`);
      check(Math.abs(later.topbar.top) <= TOLERANCE, `${tag}, scroll 400px: the top bar stays at the top (top ${px(later.topbar.top)})`);
      check(Math.abs(later.bottomnav.bottom - later.innerHeight) <= TOLERANCE, `${tag}, scroll 400px: the bottom navigation stays at the bottom (bottom ${px(later.bottomnav.bottom)} vs ${later.innerHeight})`);
      check(later.strip && later.strip.bottom <= 0, `${tag}, scroll 400px: the strip scrolls away with the page (bottom ${later.strip ? px(later.strip.bottom) : 'gone'})`);
      rows.push({ case: tag, steps: [{ at: 'top', m: start }, { at: '400px', m: later }] });
    } catch (error) {
      check(false, `${tag}: script error ${String(error.message).split('\n')[0]}`);
    }
    await context.close().catch(() => undefined);
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
