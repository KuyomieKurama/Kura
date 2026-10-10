/* global process, console, fetch, document, window, URL */
// Real-browser check of the media content route and the viewer: node tests/ui-shots/media-check.mjs [--skip-build]
// - the content route in a browser tab: a picture is shown (under the sandbox policy), SVG and HTML are downloaded and
//   never rendered, and the security headers are on the responses; a video seeks with Range requests in the viewer
// - the viewer with the keyboard in Chromium: Enter opens it, arrows move on, Tab stays inside, Escape closes and the
//   focus returns to the cell of the file that was shown last
// Exits with 1 when a step does not behave.
import { seedMedia } from './media-seed.mjs';
import { loadPlaywright, startStack } from './stack.mjs';

const skipBuild = process.argv.includes('--skip-build');
const ADMIN = { displayName: 'Mara Admin', username: 'mara', password: 'Kura-Beispiel-2026!' };
const failures = [];
const check = (condition, description) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${description}`);
  if (!condition) failures.push(description);
};

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><script>document.title="pwned"</script><circle cx="20" cy="20" r="10"/></svg>');
const HTML = Buffer.from('<!doctype html><title>pwned</title><script>document.title="pwned"</script><h1>Hallo</h1>');

const { chromium } = await loadPlaywright();
const stack = await startStack({ skipBuild });
const browser = await chromium.launch();
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
  await seedMedia({
    browser,
    databaseUrl: stack.databaseUrl,
    extraFiles: [
      { name: 'zeichnung.svg', mime: 'image/svg+xml', bytes: SVG },
      { name: 'seite.html', mime: 'text/html', bytes: HTML }
    ]
  });
  const listed = await (await fetch(`${stack.origin}/api/v1/subscriptions/${(await created.json()).subscription.id}/media?limit=100`, { headers: { cookie } })).json();
  const byName = (name) => listed.items.find((item) => item.originalName === name);
  check(listed.items.length >= 15, `the media list has the seeded files (${listed.items.length})`);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'de-DE', acceptDownloads: true });
  await context.addCookies(cookie.split('; ').map((pair) => {
    const [name, ...rest] = pair.split('=');
    return { name, value: rest.join('='), url: stack.origin };
  }));
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // --- the content route in a tab -------------------------------------------------------------------------
  const image = byName('illustration_01.png');
  const imageResponse = await page.goto(`${stack.origin}/api/v1/assets/${image.id}/content`);
  check(imageResponse.status() === 200 && imageResponse.headers()['content-type'] === 'image/png', 'picture: 200 and image/png');
  check(imageResponse.headers()['x-content-type-options'] === 'nosniff', 'picture: nosniff');
  check(imageResponse.headers()['content-security-policy'] === "default-src 'none'; sandbox", 'picture: sandbox policy');
  check(await page.evaluate(() => document.images[0]?.naturalWidth > 0), 'picture is displayed by the browser as an image document');

  const video = byName('hafen_zeitraffer.webm');
  const videoHeaders = (await context.request.get(`${stack.origin}/api/v1/assets/${video.id}/content`, { headers: { range: 'bytes=0-9' } })).headers();
  check(videoHeaders['content-security-policy'] === "default-src 'none'; sandbox" && videoHeaders['x-content-type-options'] === 'nosniff', 'video: sandbox policy and nosniff on the 206 answer');
  // Opened on its own in a tab, Chromium refuses the video (media-src falls back to default-src 'none'). The app embeds
  // it in the viewer, which the policy of the page governs, and offers a download; see the report.

  for (const [name, expected] of [['zeichnung.svg', 'image/svg+xml'], ['seite.html', 'text/html']]) {
    const asset = byName(name);
    const downloadPromise = page.waitForEvent('download');
    await page.goto(`${stack.origin}/api/v1/assets/${asset.id}/content`).catch(() => undefined);
    const download = await downloadPromise;
    check(download.suggestedFilename() === name, `${expected}: downloaded as ${download.suggestedFilename()}, not rendered`);
  }
  const headResponse = await context.request.get(`${stack.origin}/api/v1/assets/${byName('zeichnung.svg').id}/content`);
  check(headResponse.headers()['content-disposition'].startsWith('attachment;') && headResponse.headers()['content-type'] === 'application/octet-stream', 'svg: attachment and opaque type');
  check(!pageErrors.includes('pwned') && (await page.title()) !== 'pwned', 'no script of an SVG or HTML file ran');

  // --- the viewer with the keyboard -----------------------------------------------------------------------
  await page.goto(stack.origin);
  await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name: 'Abonnements', exact: true }).click();
  await page.getByRole('button', { name: 'Medien', exact: true }).click();
  const cell = page.getByRole('button', { name: /^Bild illustration_01/ });
  await cell.waitFor();
  await cell.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const title = () => dialog.getByRole('heading', { level: 2 }).textContent();
  const first = await title();
  check(first === 'illustration_01.png', `Enter opens the viewer (${first})`);
  check(await page.evaluate(() => document.activeElement?.getAttribute('role') === 'dialog'), 'focus moves into the dialog');
  await page.keyboard.press('ArrowRight');
  const second = await title();
  check(second !== first, `ArrowRight shows the next file (${second})`);
  await page.keyboard.press('ArrowLeft');
  check((await title()) === first, 'ArrowLeft goes back');

  let inside = true;
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press('Tab');
    inside &&= await page.evaluate(() => Boolean(document.activeElement?.closest('[role=dialog]')));
  }
  check(inside, 'twelve Tab presses never leave the dialog');
  for (let step = 0; step < 4; step += 1) {
    await page.keyboard.press('Shift+Tab');
    inside &&= await page.evaluate(() => Boolean(document.activeElement?.closest('[role=dialog]')));
  }
  check(inside, 'Shift+Tab stays inside as well');

  await page.keyboard.press('ArrowRight');
  const shown = await title();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  const restored = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
  check(restored.includes(shown), `Escape closes and the focus returns to the cell of ${shown} (${restored})`);

  // A video in the viewer plays with its own controls, seeks through Range requests and keeps the arrow keys for seeking.
  const rangeRequests = [];
  page.on('request', (request) => { if (request.url().includes(`/assets/${video.id}/content`)) rangeRequests.push(request.headers().range ?? null); });
  await page.getByRole('button', { name: /^Video hafen_zeitraffer/ }).click();
  await page.locator('[role=dialog] video').waitFor();
  await page.waitForFunction(() => document.querySelector('[role=dialog] video')?.readyState >= 2);
  const duration = await page.evaluate(() => document.querySelector('[role=dialog] video').duration);
  await page.evaluate(() => { document.querySelector('[role=dialog] video').currentTime = 1.5; });
  await page.waitForFunction(() => { const element = document.querySelector('[role=dialog] video'); return element.currentTime >= 1.4 && !element.seeking; });
  check(duration > 1, `the video in the viewer decodes and seeks (duration ${duration.toFixed(1)} s)`);
  check(rangeRequests.some((range) => range && /^bytes=\d+-/.test(range)), `the browser sent Range requests (${rangeRequests.filter(Boolean).join(', ')})`);
  await page.locator('[role=dialog] video').focus();
  const before = await title();
  await page.keyboard.press('ArrowRight');
  check((await title()) === before, 'ArrowRight on a focused video belongs to its controls (the viewer stays)');
  await page.keyboard.press('Escape');
  check(pageErrors.length === 0, `no page errors (${pageErrors.join('; ')})`);
  await context.close();
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
