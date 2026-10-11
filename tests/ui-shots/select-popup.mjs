/* global process, console, fetch, document, window, getComputedStyle, requestAnimationFrame */
// The subscription select of the media page opens where it belongs:
//   node tests/ui-shots/select-popup.mjs [--skip-build] [--out=dir] [--only=390x844,1440x900] [--allow-native]
//
// REQ-DL-008 / UI2-J. The select used to be a native <select>; the browser draws its list and neither position nor
// colours can be controlled (the user saw it ~770px left of the field, cut off, system blue). The select is now a button
// plus a listbox of our own. For 390x844, 844x390, 1024x700 and 1440x900, light and dark, with the test strip and with
// the strip removed from the DOM, at scroll 0 and after scrolling 400px, it opens the list and checks that
//   1. a list exists in the DOM at all (a native popup does not: this is the check that is red with <select>);
//   2. from 640px: the list lies completely inside the viewport, its left edge and its width differ at most 1px from the
//      button, and it touches the button (directly below, or above when there is no room below);
//   3. below 640px: a sheet from the bottom edge (bottom = viewport bottom, left 0, right = viewport width, completely
//      inside the viewport), rows of at least 44px, and it covers the bottom navigation;
//   4. the list has an edge and a shadow, the highlighted row uses --accent-soft (not the system colour) and the chosen
//      row has a check mark;
//   5. keys: ArrowDown moves aria-activedescendant, Escape closes and the focus is on the button, Enter chooses;
//      a click outside closes.
// Also, once per colour scheme: the root colour-scheme and the one of a native select (settings forms) match the theme.
// With --allow-native the check 1 is reported but does not stop the other checks (used to read the baseline).
// With --out=dir it writes a viewport shot of every open list. Exits with 1 when a check fails.
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadPlaywright, startStack } from './stack.mjs';
import { seedMedia } from './media-seed.mjs';

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));
const outDirectory = args.has('out') ? resolve(args.get('out')) : null;
const ADMIN = { displayName: 'Mara Admin', username: 'mara', password: 'Kura-Beispiel-2026!' };
const TOLERANCE = 1;
const SUBSCRIPTIONS = [
  'Atelier Mori', 'Laura', 'Alusagichan', 'Pixiv test', 'Ein Abonnement mit einem sehr langen Namen, der nicht in die Zeile passt',
  'Kanal Nord', 'Kanal Sued', 'Studio Hoshi', 'Mina Archiv', 'Rotes Skizzenbuch', 'Hafenfotos', 'Zeichnungen 2026'
];
const ALL_VIEWPORTS = [
  { name: '390x844', width: 390, height: 844 },
  { name: '844x390', width: 844, height: 390 },
  { name: '1024x700', width: 1024, height: 700 },
  { name: '1440x900', width: 1440, height: 900 }
];
const only = args.has('only') ? args.get('only').split(',') : null;
const VIEWPORTS = only ? ALL_VIEWPORTS.filter((viewport) => only.includes(viewport.name)) : ALL_VIEWPORTS;

const failures = [];
const check = (condition, description) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${description}`);
  if (!condition) failures.push(description);
};
const px = (value) => Math.round(value * 10) / 10;

const { chromium } = await loadPlaywright();
const stack = await startStack({ skipBuild: args.has('skip-build') });
const browser = await chromium.launch({ args: ['--num-raster-threads=1'] });

/** Everything on the way from the select to the root that moves or clips a native popup, for the report. */
const ancestry = () => {
  const target = document.querySelector('[role="combobox"][aria-label="Abonnement"], select[aria-label="Abonnement"]');
  const rows = [];
  for (let node = target; node && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    const flags = [];
    if (style.transform !== 'none') flags.push(`transform ${style.transform}`);
    if (style.willChange !== 'auto') flags.push(`will-change ${style.willChange}`);
    if (style.contain !== 'none') flags.push(`contain ${style.contain}`);
    if (style.filter !== 'none') flags.push(`filter ${style.filter}`);
    if (style.backdropFilter && style.backdropFilter !== 'none') flags.push(`backdrop-filter ${style.backdropFilter}`);
    if (style.contentVisibility !== 'visible') flags.push(`content-visibility ${style.contentVisibility}`);
    if (style.viewTransitionName && style.viewTransitionName !== 'none') flags.push(`view-transition-name ${style.viewTransitionName}`);
    if (style.position === 'fixed' || style.position === 'sticky') flags.push(`position ${style.position}`);
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX + style.overflowY)) flags.push(`overflow ${style.overflowX}/${style.overflowY}`);
    if (flags.length > 0) rows.push(`${node.tagName.toLowerCase()}${node.className ? `.${String(node.className).split(' ')[0]}` : ''}: ${flags.join(', ')}`);
  }
  return rows;
};

/** Measures the open list and the button. Runs in the page. */
const measureOpen = () => {
  const button = document.querySelector('[role="combobox"][aria-label="Abonnement"]');
  const list = document.querySelector('[role="listbox"]');
  const surface = list?.closest('[data-select-surface]') ?? list;
  const nav = document.querySelector('.bottomnav');
  const rows = list ? Array.from(list.querySelectorAll('[role="option"]')) : [];
  const probe = document.createElement('span');
  probe.style.background = 'var(--accent-soft)';
  document.body.append(probe);
  const accentSoft = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const active = list?.querySelector('[role="option"][data-active="true"]');
  const chosen = list?.querySelector('[role="option"][aria-selected="true"]');
  const surfaceStyle = surface ? getComputedStyle(surface) : null;
  let covered = null;
  if (nav) {
    const rect = nav.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    covered = Boolean(hit && !nav.contains(hit));
  }
  const rect = (element) => {
    if (!element) return null;
    const { top, bottom, left, right, width, height } = element.getBoundingClientRect();
    return { top, bottom, left, right, width, height };
  };
  return {
    innerWidth: document.documentElement.clientWidth,
    innerHeight: document.documentElement.clientHeight,
    button: rect(button),
    surface: rect(surface),
    list: rect(list),
    mode: surface?.getAttribute('data-mode') ?? null,
    rowHeights: rows.map((row) => row.getBoundingClientRect().height),
    rowCount: rows.length,
    activeBackground: active ? getComputedStyle(active).backgroundColor : null,
    accentSoft,
    chosenHasCheck: Boolean(chosen?.querySelector('svg')),
    border: surfaceStyle ? surfaceStyle.borderTopWidth : null,
    shadow: surfaceStyle ? surfaceStyle.boxShadow : null,
    expanded: button?.getAttribute('aria-expanded') ?? null,
    activeDescendant: button?.getAttribute('aria-activedescendant') ?? null,
    covered,
    scrollable: list ? list.scrollHeight > list.clientHeight : false
  };
};

const apiHeaders = (csrf, cookie) => ({ 'content-type': 'application/json', cookie, 'x-kura-csrf': csrf });

try {
  const setup = await fetch(`${stack.origin}/api/v1/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ADMIN) });
  const csrf = (await setup.json()).csrfToken;
  const cookie = setup.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');
  let created = 0;
  for (const [index, name] of SUBSCRIPTIONS.entries()) {
    const response = await fetch(`${stack.origin}/api/v1/subscriptions`, {
      method: 'POST', headers: apiHeaders(csrf, cookie),
      body: JSON.stringify({ name, targetUrl: `https://www.pixiv.net/users/${4400 + index}`, platformHint: 'pixiv' })
    });
    if (response.ok) created += 1;
  }
  check(created === SUBSCRIPTIONS.length, `${created} subscriptions created through the API`);
  await seedMedia({ browser, databaseUrl: stack.databaseUrl });
  if (outDirectory) await mkdir(outDirectory, { recursive: true });

  let reported = false;
  let themeChecked = new Set();
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark']) {
      for (const withStrip of [true, false]) {
        const base = `${viewport.name} ${scheme} ${withStrip ? 'strip' : 'no strip'}`;
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: scheme, reducedMotion: 'reduce', locale: 'de-DE', timezoneId: 'Europe/Berlin', hasTouch: viewport.width < 640, isMobile: viewport.width < 640 });
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
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(300);
          if (!withStrip) await page.evaluate(() => document.querySelector('.shell > .test-strip')?.remove());
          // The page must be able to scroll 400px, whatever the seed brings.
          await page.evaluate(() => {
            if (document.documentElement.scrollHeight - window.innerHeight < 800) {
              const spacer = document.createElement('div');
              spacer.style.height = '2400px';
              spacer.setAttribute('aria-hidden', 'true');
              document.querySelector('.page')?.append(spacer);
            }
          });

          if (!reported) {
            reported = true;
            const rows = await page.evaluate(ancestry);
            console.log(`note: ancestors of the select that move or clip a popup: ${rows.length === 0 ? 'none' : rows.join(' | ')}`);
          }
          if (!themeChecked.has(scheme)) {
            themeChecked.add(scheme);
            const scheme2 = await page.evaluate(() => {
              const native = document.createElement('select');
              document.body.append(native);
              const result = { root: getComputedStyle(document.documentElement).colorScheme, native: getComputedStyle(native).colorScheme };
              native.remove();
              return result;
            });
            check(scheme2.root === scheme && scheme2.native === scheme, `${scheme}: colour-scheme of the root and of a native select is "${scheme}" (root ${scheme2.root}, select ${scheme2.native})`);
          }

          for (const scroll of [0, 400]) {
            const tag = `${base}, scroll ${scroll}`;
            await page.evaluate((y) => new Promise((done) => { window.scrollTo(0, y); requestAnimationFrame(() => requestAnimationFrame(done)); }), scroll);
            await page.waitForTimeout(80);
            const button = page.getByRole('combobox', { name: 'Abonnement' });
            // The button of the page header is in the document; at scroll 400 on a narrow screen it may be above the fold.
            await button.scrollIntoViewIfNeeded().catch(() => undefined);
            await button.click();
            const appeared = await page.locator('[role="listbox"]').first().waitFor({ timeout: 1500 }).then(() => true, () => false);
            check(appeared, `${tag}: opening the select puts a list into the document (a native popup is not in the DOM)`);
            if (!appeared) {
              if (!args.has('allow-native')) continue;
              continue;
            }
            await page.waitForTimeout(120);
            const m = await page.evaluate(measureOpen);
            const inside = (r) => r.left >= -0.5 && r.top >= -0.5 && r.right <= m.innerWidth + 0.5 && r.bottom <= m.innerHeight + 0.5;
            check(m.expanded === 'true', `${tag}: aria-expanded is true`);
            check(inside(m.surface), `${tag}: the list lies completely in the viewport (${px(m.surface.left)},${px(m.surface.top)} to ${px(m.surface.right)},${px(m.surface.bottom)} of ${m.innerWidth}x${m.innerHeight})`);
            if (viewport.width >= 640) {
              check(m.mode === 'popup', `${tag}: popup mode from 640px`);
              check(Math.abs(m.surface.left - m.button.left) <= TOLERANCE, `${tag}: left edge ${px(m.surface.left)} vs button ${px(m.button.left)}`);
              check(Math.abs(m.surface.width - m.button.width) <= TOLERANCE, `${tag}: width ${px(m.surface.width)} vs button ${px(m.button.width)}`);
              const below = m.surface.top >= m.button.bottom - TOLERANCE && m.surface.top <= m.button.bottom + 12;
              const above = m.surface.bottom <= m.button.top + TOLERANCE && m.surface.bottom >= m.button.top - 12;
              check(below || above, `${tag}: the list touches the button (${below ? 'below' : above ? 'above' : `neither: list ${px(m.surface.top)}-${px(m.surface.bottom)}, button ${px(m.button.top)}-${px(m.button.bottom)}`})`);
            } else {
              check(m.mode === 'sheet', `${tag}: bottom sheet below 640px`);
              check(Math.abs(m.surface.bottom - m.innerHeight) <= TOLERANCE, `${tag}: the sheet sits on the bottom edge (bottom ${px(m.surface.bottom)} of ${m.innerHeight})`);
              check(Math.abs(m.surface.left) <= TOLERANCE && Math.abs(m.surface.right - m.innerWidth) <= TOLERANCE, `${tag}: the sheet spans the width (${px(m.surface.left)} to ${px(m.surface.right)} of ${m.innerWidth})`);
              check(m.rowHeights.every((height) => height >= 44 - 0.5), `${tag}: every row is at least 44px high (smallest ${px(Math.min(...m.rowHeights))})`);
              check(m.covered === true, `${tag}: the sheet covers the bottom navigation`);
            }
            check(m.border !== '0px' && m.shadow !== 'none', `${tag}: the list has an edge (${m.border}) and a shadow`);
            check(m.chosenHasCheck, `${tag}: the chosen row has a check mark`);
            check(m.scrollable || m.rowCount < 8, `${tag}: a long list scrolls inside itself (${m.rowCount} rows)`);
            if (outDirectory) await page.screenshot({ path: resolve(outDirectory, `select-${viewport.name}-${scheme}-${withStrip ? 'strip' : 'nostrip'}-scroll${scroll}.png`) });

            if (scroll === 0 && withStrip) {
              await page.keyboard.press('ArrowDown');
              await page.waitForTimeout(80);
              const afterDown = await page.evaluate(measureOpen);
              check(afterDown.activeDescendant !== null && afterDown.activeBackground === afterDown.accentSoft, `${tag}: ArrowDown moves aria-activedescendant, the highlighted row is --accent-soft (${afterDown.activeBackground} vs ${afterDown.accentSoft})`);
              await page.keyboard.press('Escape');
              await page.waitForTimeout(60);
              const closed = await page.evaluate(() => ({ lists: document.querySelectorAll('[role="listbox"]').length, focused: document.activeElement?.getAttribute('aria-label') ?? null }));
              check(closed.lists === 0 && closed.focused === 'Abonnement', `${tag}: Escape closes and the focus is back on the button (${closed.lists} lists, focus ${closed.focused})`);
              await page.keyboard.press('ArrowDown');
              await page.locator('[role="listbox"]').first().waitFor({ timeout: 1500 });
              await page.keyboard.press('ArrowDown');
              await page.keyboard.press('Enter');
              await page.waitForTimeout(150);
              const chosen = await page.evaluate(() => ({ lists: document.querySelectorAll('[role="listbox"]').length, text: document.querySelector('[role="combobox"][aria-label="Abonnement"]')?.textContent ?? '' }));
              check(chosen.lists === 0 && !/Alle Abonnements/.test(chosen.text), `${tag}: Enter chooses and closes (button now "${chosen.text.trim()}")`);
              await page.getByRole('combobox', { name: 'Abonnement' }).click();
              await page.locator('[role="listbox"]').first().waitFor({ timeout: 1500 });
              await page.mouse.click(viewport.width < 640 ? 20 : 5, 5);
              await page.waitForTimeout(80);
              check(await page.locator('[role="listbox"]').count() === 0, `${tag}: a click outside closes the list`);
              await page.getByRole('combobox', { name: 'Abonnement' }).click();
              await page.locator('[role="listbox"]').first().waitFor({ timeout: 1500 });
              await page.getByRole('option').first().click();
              await page.waitForTimeout(150);
            } else {
              await page.keyboard.press('Escape');
              await page.waitForTimeout(60);
            }
          }
        } catch (error) {
          check(false, `${base}: script error ${String(error.message).split('\n')[0]}`);
        }
        await context.close().catch(() => undefined);
      }
    }
  }
} finally {
  await browser.close();
  await stack.stop();
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll checks passed.');
}
