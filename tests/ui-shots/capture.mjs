/* global process, console, fetch, setTimeout, document, Buffer */
// Screenshot capture for the Kura web UI: node tests/ui-shots/capture.mjs [--skip-build] [--only=name,name] [--out=dir]
// Starts the real API with the built web files, completes first-run setup through the API, seeds data through
// the API where possible and writes PNG files named view-theme-width.png. See tests/ui-shots/README.md.
import { mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { history, transferVerified } from './fixtures.mjs';
import { loadPlaywright, repoRoot, startStack } from './stack.mjs';

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));
const outDirectory = resolve(args.get('out') ?? resolve(repoRoot, 'shots-out'));
const only = args.has('only') ? new Set(args.get('only').split(',')) : null;

const ADMIN = { displayName: 'Mara Admin', username: 'mara', password: 'Kura-Beispiel-2026!' };
const variants = [
  { theme: 'light', width: 1440, height: 900 },
  { theme: 'dark', width: 1440, height: 900 },
  { theme: 'light', width: 390, height: 844 }
];

/** Minimal API client with a cookie, used for seeding. */
function apiClient(origin) {
  let cookie = '';
  let csrf = '';
  async function call(method, path, body) {
    const response = await fetch(`${origin}/api/v1${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(csrf && method !== 'GET' ? { 'x-kura-csrf': csrf } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setCookie = response.headers.getSetCookie?.() ?? [];
    if (setCookie.length) cookie = setCookie.map((entry) => entry.split(';')[0]).join('; ');
    const text = await response.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}: ${text}`);
    return json;
  }
  return {
    call,
    async setup() { csrf = (await call('POST', '/auth/setup', ADMIN)).csrfToken; },
    async login(username, password) { csrf = (await call('POST', '/auth/login', { username, password })).csrfToken; }
  };
}

async function seed(origin) {
  const api = apiClient(origin);
  await api.setup();
  const bob = await api.call('POST', '/users', { displayName: 'Bob Beispiel', username: 'bob', role: 'user', initialPassword: 'Bob-Beispiel-2026!' });
  const carla = await api.call('POST', '/users', { displayName: 'Carla Test', username: 'carla', role: 'user', initialPassword: 'Carla-Test-2026!!' });
  const carlaId = carla.user?.id ?? carla.id;
  if (carlaId) await api.call('PATCH', `/users/${carlaId}`, { status: 'blocked' });
  void bob;
  const subscriptions = [
    { name: 'Atelier Mori', targetUrl: 'https://www.pixiv.net/users/4411', platformHint: 'pixiv' },
    { name: 'Kanal Nordlicht', targetUrl: 'https://www.youtube.com/@nordlicht', platformHint: 'youtube' },
    { name: 'Fotoblog Hafen mit einem sehr langen Namen, damit man sieht, wie Kürzung aussieht', targetUrl: 'https://example.org/media/hafen/2026/10/sehr-lange-adresse-fuer-einen-test/index.html', platformHint: null }
  ];
  const created = [];
  for (const input of subscriptions) {
    const { subscription } = await api.call('POST', '/subscriptions', input);
    await api.call('POST', `/subscriptions/${subscription.id}/validate`).catch(() => undefined);
    created.push(subscription);
  }
  await api.call('POST', '/schedules', {
    subscriptionId: created[0].id,
    rule: { kind: 'cron', expression: '30 2 * * *', timeZone: 'Europe/Berlin', gapPolicy: 'skip' },
    jitterMaxSeconds: 30
  });
  await api.call('POST', '/schedules', {
    subscriptionId: created[0].id,
    rule: { kind: 'interval', everySeconds: 21_600, timeZone: 'Europe/Berlin' },
    jitterMaxSeconds: 0
  });
  await api.call('POST', `/subscriptions/${created[0].id}/run-now`).catch(() => undefined);
  await api.call('POST', `/subscriptions/${created[2].id}/pause`);
  await api.call('POST', '/admin/immich/endpoint-approvals', { host: '192.168.1.20', port: 2283 });
  await api.call('POST', '/admin/immich/endpoint-approvals', { host: 'immich.heim.lan', port: 443 });
}

const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function navigate(page, name) {
  const menu = page.getByRole('button', { name: 'Menü' });
  if (await menu.isVisible() && (await menu.getAttribute('aria-expanded')) !== 'true') await menu.click();
  await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name, exact: true }).click();
  await page.waitForTimeout(150);
}

async function signIn(context, origin) {
  const state = await (await context.request.get(`${origin}/api/v1/auth/state`)).json();
  const login = await context.request.post(`${origin}/api/v1/auth/login`, {
    data: { username: ADMIN.username, password: ADMIN.password },
    headers: { 'x-kura-csrf': state.csrfToken ?? '' }
  });
  if (!login.ok()) throw new Error(`login failed: ${login.status()} ${await login.text()}`);
}

async function main() {
  const { chromium } = await loadPlaywright();
  await mkdir(outDirectory, { recursive: true });
  for (const file of await readdir(outDirectory)) if (file.endsWith('.png')) await rm(resolve(outDirectory, file));

  const stack = await startStack({ skipBuild: args.has('skip-build') });
  const browser = await chromium.launch();
  const problems = [];
  const written = [];
  try {
    const open = async (variant) => {
      const context = await browser.newContext({
        viewport: { width: variant.width, height: variant.height },
        colorScheme: variant.theme,
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin'
      });
      const page = await context.newPage();
      page.on('console', (message) => { if (message.type() === 'error') problems.push(`console error: ${message.text()}`); });
      page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
      page.on('requestfailed', (request) => problems.push(`request failed: ${request.url()}`));
      return { context, page };
    };
    const shooter = (page, variant) => async (name) => {
      if (only && !only.has(name)) return;
      const file = `${name}-${variant.theme}-${variant.width}.png`;
      await page.screenshot({ path: resolve(outDirectory, file), fullPage: true });
      written.push(file);
    };

    // 1. Setup screens need an unconfigured database.
    for (const variant of variants) {
      const { context, page } = await open(variant);
      await page.goto(stack.origin);
      await page.getByRole('heading', { name: 'Kura einrichten' }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await shooter(page, variant)('setup');
      await context.close();
    }

    await seed(stack.origin);

    for (const variant of variants) {
      const { context, page } = await open(variant);
      const shot = shooter(page, variant);

      // 2. Login, including a failed attempt.
      await page.goto(stack.origin);
      await page.getByRole('heading', { name: 'Anmelden' }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await shot('login');
      await page.getByLabel('Benutzername').fill('mara');
      await page.getByLabel('Passwort').fill('falsch');
      await page.getByRole('button', { name: 'Anmelden' }).click();
      await page.getByRole('alert').waitFor();
      await shot('login-error');

      // 3. Signed in.
      await signIn(context, stack.origin);
      await page.goto(stack.origin);
      await page.getByText('Erreichbar', { exact: true }).waitFor();
      await shot('dashboard');

      if (variant.width < 1024) {
        await page.getByRole('button', { name: 'Menü' }).click();
        await shot('menu-open');
        await page.getByRole('button', { name: 'Menü' }).click();
      }

      // Subscriptions: list, details, form, empty, loading, error.
      await navigate(page, 'Abonnements');
      await page.getByRole('article').first().waitFor();
      await shot('subscriptions');
      await page.getByRole('article', { name: /Abonnement Atelier Mori/ }).getByRole('button', { name: 'Zeitpläne und Läufe' }).click();
      await page.getByText('Zeitpläne', { exact: true }).first().waitFor();
      await page.waitForTimeout(300);
      await shot('subscriptions-expanded');
      await page.getByText('Unterstützte Quellen und Adapter').click();
      await page.waitForTimeout(500);
      await shot('subscriptions-adapters');
      await page.getByRole('button', { name: 'Abonnement anlegen' }).click();
      const createForm = page.getByRole('form', { name: 'Abonnement anlegen' });
      await createForm.getByLabel('Ziel-URL').fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      await createForm.getByRole('button', { name: 'Adresse prüfen' }).click();
      await page.getByLabel('Ergebnis der Adressprüfung').waitFor();
      await shot('subscriptions-form');

      await page.route('**/api/v1/subscriptions', (route) => route.request().method() === 'GET' ? json(route, { subscriptions: [] }) : route.continue());
      await navigate(page, 'Übersicht');
      await navigate(page, 'Abonnements');
      await page.getByText('Noch keine Abonnements.').waitFor();
      await shot('subscriptions-empty');
      await page.unroute('**/api/v1/subscriptions');

      await page.route('**/api/v1/subscriptions', async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        await new Promise((done) => setTimeout(done, 4000));
        return route.continue();
      });
      await navigate(page, 'Übersicht');
      await navigate(page, 'Abonnements');
      await page.getByRole('status').first().waitFor({ state: 'attached' });
      await shot('subscriptions-loading');
      await page.unroute('**/api/v1/subscriptions');

      await page.route('**/api/v1/subscriptions', (route) => route.request().method() === 'GET'
        ? json(route, { error: { code: 'INTERNAL', message: 'Die Datenbank antwortet nicht.' } }, 500)
        : route.continue());
      await navigate(page, 'Übersicht');
      await navigate(page, 'Abonnements');
      await page.getByRole('alert').first().waitFor();
      await shot('subscriptions-error');
      await page.unroute('**/api/v1/subscriptions');

      // History: mocked, because runs and posts only exist once a worker has downloaded something.
      await page.route('**/api/v1/history', (route) => json(route, history));
      await navigate(page, 'Verlauf');
      await page.getByRole('heading', { name: 'Läufe' }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await shot('history');
      for (const button of await page.getByRole('button', { name: /Dateien anzeigen/ }).all()) await button.click();
      await page.waitForTimeout(400);
      await shot('history-expanded');

      // Immich, with a mocked transfer.
      await page.route('**/api/v1/immich/test-transfer', (route) => json(route, { transfer: { ...transferVerified, status: 'uploading', evidence: null } }, 202));
      await page.route('**/api/v1/immich/transfers/*', (route) => json(route, { transfer: transferVerified }));
      await navigate(page, 'Immich');
      await page.getByRole('heading', { name: 'Freigaben für private Immich-Endpunkte' }).waitFor();
      await shot('immich');
      await page.getByLabel('Testdatei').setInputFiles({ name: 'test.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('test') });
      await page.getByRole('button', { name: 'Testdatei übertragen' }).click();
      await page.getByText('Testübertragung verifiziert.').waitFor();
      await shot('immich-transfer');

      await navigate(page, 'Benutzerverwaltung');
      await page.getByRole('table', { name: 'Benutzerverwaltung' }).waitFor();
      await shot('users');
      await page.getByRole('button', { name: 'Benutzer anlegen' }).click();
      await page.getByRole('dialog').waitFor();
      await shot('users-dialog');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Sperren' }).first().click();
      await page.getByRole('dialog').waitFor();
      await shot('dialog');
      await page.keyboard.press('Escape');

      await navigate(page, 'Limits');
      await page.getByRole('form', { name: 'Limits bearbeiten' }).waitFor();
      await shot('limits');

      await navigate(page, 'Konto');
      await page.getByRole('heading', { name: 'Passwort ändern' }).waitFor();
      await shot('account');

      await context.close();
    }
  } finally {
    await browser.close();
    await stack.stop();
  }

  console.log(`Wrote ${written.length} screenshots to ${outDirectory}`);
  const unique = [...new Set(problems)];
  console.log(unique.length === 0 ? 'Browser console: no errors, no failed requests.' : `Browser console problems (${unique.length}):\n${unique.join('\n')}`);
  if (unique.length > 0) process.exitCode = 2;
}

await main();
