/* global process, console, fetch, document, window, getComputedStyle */
// Keyboard path check in a real browser: node tests/ui-shots/keyboard.mjs [--skip-build]
// Drives the real UI with the keyboard only (after the first page load): sign in, skip link, navigation,
// creating a subscription, the mobile menu. Fails with exit code 1 when a step does not behave.
import { loadPlaywright, startStack } from './stack.mjs';

const skipBuild = process.argv.includes('--skip-build');
const ADMIN = { displayName: 'Mara Admin', username: 'mara', password: 'Kura-Beispiel-2026!' };
const failures = [];
const check = (condition, description) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${description}`);
  if (!condition) failures.push(description);
};

const activeName = (page) => page.evaluate(() => {
  const element = document.activeElement;
  return element ? `${element.tagName.toLowerCase()}:${(element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 40)}` : 'none';
});
const focusRing = (page) => page.evaluate(() => {
  const style = getComputedStyle(document.activeElement);
  return { style: style.outlineStyle, width: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset), color: style.outlineColor };
});

async function tabUntil(page, predicate, limit = 25) {
  for (let step = 0; step < limit; step += 1) {
    await page.keyboard.press('Tab');
    if (await predicate()) return true;
  }
  return false;
}

const { chromium } = await loadPlaywright();
const stack = await startStack({ skipBuild });
const browser = await chromium.launch();
try {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, locale: 'de-DE' });
    const page = await context.newPage();
    console.log(`--- desktop, ${theme}`);
    if (theme === 'light') {
      // A plain fetch, so that the session cookie of the setup call does not end up in the browser.
      const response = await fetch(`${stack.origin}/api/v1/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(ADMIN)
      });
      check(response.ok, 'first-run setup through the API');
    }
    await page.goto(stack.origin);
    await page.getByRole('heading', { name: 'Anmelden', includeHidden: true }).waitFor();

    // Sign in with the keyboard only.
    await page.keyboard.press('Tab');
    check((await activeName(page)).includes('Benutzername') || (await page.evaluate(() => document.activeElement?.getAttribute('name'))) === 'username', 'first Tab on the login page reaches the user name field');
    await page.keyboard.type(ADMIN.username);
    await page.keyboard.press('Tab');
    await page.keyboard.type(ADMIN.password);
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Übersicht', level: 1 }).waitFor();
    check(true, 'Enter in the password field signs in');

    // Skip link: first Tab stop, visible when focused, Enter moves focus to main.
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Zum Inhalt springen' });
    check(await skip.evaluate((element) => element === document.activeElement), 'the skip link is the first Tab stop');
    const box = await skip.boundingBox();
    check(box !== null && box.y >= 0 && box.y < 100, 'the skip link is on screen while focused');
    await page.keyboard.press('Enter');
    check(await page.evaluate(() => document.activeElement?.id === 'main'), 'Enter on the skip link moves focus to the main content');

    // Navigation order and focus ring.
    await page.goto(stack.origin);
    await page.getByRole('heading', { name: 'Übersicht', level: 1 }).waitFor();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const first = await activeName(page);
    check(first.includes('Übersicht'), `Tab order reaches the navigation (${first})`);
    const ring = await focusRing(page);
    check(ring.style === 'solid' && ring.width >= 2 && ring.offset >= 2, `focus ring is 2px solid with 2px offset (${JSON.stringify(ring)})`);
    await page.keyboard.press('Tab');
    check((await activeName(page)).includes('Medien'), 'Tab moves to the next navigation item');
    await page.keyboard.press('Tab');
    check((await activeName(page)).includes('Abonnements'), 'Tab reaches the subscriptions entry');
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Abonnements', level: 1 }).waitFor();
    const current = await page.getByRole('navigation').getByRole('button', { name: 'Abonnements', exact: true }).getAttribute('aria-current');
    check(current === 'page', 'Enter opens the page and sets aria-current');
    check(await page.evaluate(() => document.activeElement?.id === 'main'), 'focus moves to the content after navigating');

    // One form, keyboard only: create a subscription.
    await page.getByText('Noch keine Abonnements.').or(page.getByRole('article').first()).first().waitFor();
    const reached = await tabUntil(page, async () => (await activeName(page)).includes('Abonnement anlegen'));
    check(reached, 'Tab reaches "Abonnement anlegen"');
    await page.keyboard.press('Enter');
    await page.getByRole('form', { name: 'Abonnement anlegen' }).waitFor();
    await tabUntil(page, async () => (await page.evaluate(() => document.activeElement?.getAttribute('name'))) === 'name');
    await page.keyboard.type(`Tastatur ${theme}`);
    await page.keyboard.press('Tab');
    check((await page.evaluate(() => document.activeElement?.getAttribute('name'))) === 'platformHint', 'Tab moves from name to platform');
    await page.keyboard.press('Tab');
    await page.keyboard.type('https://example.org/media/cat.jpg');
    check((await page.evaluate(() => document.activeElement?.getAttribute('aria-describedby'))) !== null, 'the URL field is linked to its helper text with aria-describedby');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    check((await page.evaluate(() => document.activeElement?.getAttribute('name'))) === 'name', 'Shift+Tab moves back to the name field');
    await page.keyboard.press('Enter');
    await page.getByRole('article', { name: `Abonnement Tastatur ${theme}` }).waitFor();
    check(true, 'Enter submits the form and the subscription appears');
    await context.close();
  }

  console.log('--- mobile, light');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light', locale: 'de-DE' });
  const page = await context.newPage();
  await page.goto(stack.origin);
  await page.getByLabel('Benutzername').fill(ADMIN.username);
  await page.getByLabel('Passwort').fill(ADMIN.password);
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Übersicht', level: 1 }).waitFor();
  const more = page.getByRole('button', { name: 'Mehr', exact: true });
  check(await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name: 'Verlauf', exact: true }).isVisible(), 'the bottom navigation shows the main pages on a narrow screen');
  check(!(await page.getByRole('button', { name: 'Immich', exact: true }).isVisible()), 'rarely used pages are behind "Mehr"');
  await more.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').waitFor();
  check(await page.getByRole('dialog').getByRole('button', { name: 'Immich', exact: true }).isVisible(), 'Enter on "Mehr" opens the sheet with the other pages');
  await page.keyboard.press('Escape');
  check(!(await page.getByRole('dialog').isVisible().catch(() => false)), 'Escape closes the sheet');
  check(await more.evaluate((element) => element === document.activeElement), 'focus returns to "Mehr"');
  const target = await more.boundingBox();
  check(target !== null && target.height >= 44, `the "Mehr" target is at least 44px high (${target?.height}px)`);
  await context.close();
} finally {
  await browser.close();
  await stack.stop();
}

if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('All keyboard checks passed.');
}
