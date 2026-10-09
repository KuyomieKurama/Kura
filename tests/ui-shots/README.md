# UI screenshots and keyboard check

Tools for looking at the real web UI and for checking it with the keyboard. Nothing here writes into the repository
except `shots-out/` (not committed, do not `git add` it).

## Screenshots

    corepack pnpm build                      # once: the API and the web files must be built
    node tests/ui-shots/capture.mjs          # builds the web app, then captures
    node tests/ui-shots/capture.mjs --skip-build --only=history,dashboard --out=/tmp/shots

What it does:

1. Creates a throwaway database `kura_shots_<id>` next to `DATABASE_URL`
   (default `postgres://kura_dev:kura_dev@127.0.0.1:5432/kura_dev`) and drops it at the end.
2. Starts the real API (`apps/api/dist/index.js`) with the built web files on a free port,
   `KURA_STORAGE_BACKEND=database`, a generated `KURA_SECRET_KEY`, `COOKIE_SECURE=false`.
3. Captures the setup screen, completes first-run setup through the API, seeds two users, three subscriptions,
   two schedules, one queued run and two Immich endpoint approvals through the API.
4. Signs in and captures every view at 1440x900 light, 1440x900 dark and 390x844 light.
   Files are named `view-theme-width.png`, for example `history-expanded-dark-1440.png`.
5. Prints browser console errors and failed requests. Two are expected: the 401 of the failed login that
   `login-error` provokes and the 500 that `subscriptions-error` mocks.

Views the API cannot fill without a worker are served by `page.route` from `fixtures.mjs`: the history (runs and
posts), the Immich test transfer, and the empty, loading and error states of the subscription list.
Everything else is real API data.

Views: setup, login, login-error, dashboard, menu-open (narrow only), subscriptions, subscriptions-expanded,
subscriptions-adapters, subscriptions-form, subscriptions-empty, subscriptions-loading, subscriptions-error,
history, history-expanded, immich, immich-transfer, users, users-dialog, dialog, limits, account.

Playwright is not a dependency of this repository. `stack.mjs` loads `playwright-core` from
`PLAYWRIGHT_CORE_DIR` (default: the copy installed in `/work/SuperTakt`) and the browsers from
`PLAYWRIGHT_BROWSERS_PATH` (default `/work/.ms-playwright`).

## Keyboard check

    node tests/ui-shots/keyboard.mjs [--skip-build]

Drives the UI with the keyboard only (sign in, skip link, navigation order, focus ring, creating a subscription,
the mobile menu with Escape) in light and dark and exits with 1 when a step fails.

## Contrast test

`contrast.test.ts` runs with `corepack pnpm test` (root vitest). It reads `apps/web/src/styles/tokens.css` and checks
WCAG AA for every text/background and border/background pair the stylesheets use, in both colour schemes,
and guards the radius rule, the colour literals and the single gradient.
