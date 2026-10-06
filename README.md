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

## License

MIT for Kura-owned code. Third-party components retain their respective licenses.
