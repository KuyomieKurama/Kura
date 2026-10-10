# Kura

Kura is a self-hosted application for scheduled media downloads and verified transfer to Immich. The M1-A foundation provides the TypeScript/pnpm workspace, PostgreSQL schema migrations, a database-backed API health check, and an intentionally empty worker lifecycle. It does not yet implement downloads, authentication flows, storage adapters, or Immich transfers.

## Prerequisites

- Node.js 22 or later
- Corepack with pnpm 11 (the repository pins `pnpm@11.28.5`)
- PostgreSQL 17 or later

## Quick start

```sh
corepack install
pnpm install --frozen-lockfile
cp .env.example .env
# edit DATABASE_URL in .env for your local development database
export DATABASE_URL='postgres://kura_dev:replace-this@127.0.0.1:5432/kura_dev'
pnpm migrate
pnpm check
```

`pnpm check` runs TypeScript type checking, linting, integration tests against PostgreSQL, and production builds. See [docs/dev-setup.md](docs/dev-setup.md) for PostgreSQL setup and the test database behaviour.

## Run the API

```sh
export DATABASE_URL='postgres://kura_dev:replace-this@127.0.0.1:5432/kura_dev'
pnpm --filter @kura/api start
```

The API listens on `127.0.0.1:3000` by default and exposes `GET /healthz`. Set `TRUST_PROXY` to `false`, `true`, or a comma-separated list of trusted proxy addresses/CIDRs; numeric values are rejected.

## Version and update check

The running version is the `version` of the root `package.json` plus the git commit; the container build embeds both
(`KURA_VERSION`, `KURA_COMMIT`) and `GET /api/v1/status` reports them. Releases are annotated git tags `vMAJOR.MINOR.PATCH`.
The API process asks the public GitHub REST API for the tags every 12 hours (and when an administrator clicks "Jetzt
prüfen"), compares the highest stable tag with the running version, and shows a notice in the web UI when the instance
is outdated. Everybody sees the version in the sidebar, administrators get a dismissible notice and the upgrade steps on
the "Über Kura" page. Kura never updates itself: an upgrade is a manual `deploy/kura-deploy.sh <tag>` on the host.

The check reveals the server's IP address to GitHub. Disable it with `KURA_UPDATE_CHECK=false`; `KURA_UPDATE_REPO`
(default `KuyomieKurama/Kura`) and `KURA_UPDATE_CHANNEL` (`stable` or `prerelease`) adjust it. Details, upgrade and
rollback: [docs/vm-setup.md](docs/vm-setup.md), "Version und Update".

## License

MIT for Kura-owned code. Third-party components retain their respective licenses.
