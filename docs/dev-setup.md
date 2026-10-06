# Development setup

## Prerequisites

Install Node.js 22 or later and enable Corepack. The repository pins pnpm 11.28.5:

```sh
corepack install
pnpm --version
```

Install PostgreSQL and its client tools on Debian/Ubuntu-like hosts:

```sh
sudo apt update
sudo apt install postgresql postgresql-client
```

The distribution starts the server under the dedicated non-root `postgres` account. For a local-only development cluster, keep PostgreSQL bound to loopback only. On Debian, start and verify the cluster with:

```sh
sudo pg_ctlcluster 17 main start
pg_isready -h 127.0.0.1 -p 5432
```

Create an unprivileged development role and database. Choose a unique password locally; do not reuse the example value below in a shared environment.

```sh
sudo -u postgres createuser --pwprompt --createdb kura_dev
sudo -u postgres createdb --owner=kura_dev kura_dev
```

`CREATEDB` is required only because the integration tests create and drop isolated disposable databases. Do not grant it to a production application role.

## Install and verify

```sh
pnpm install --frozen-lockfile
export DATABASE_URL='postgres://kura_dev:replace-this@127.0.0.1:5432/kura_dev'
pnpm migrate
pnpm check
```

`pnpm check` uses PostgreSQL for migration, uniqueness, and API health-check integration tests. It derives temporary database names, creates them using the configured role, and drops them after each test. Do not point `DATABASE_URL` at a production database or an account without permission to create/drop its own test databases.

## Configuration

Copy `.env.example` for local reference; environment variables are read by the API process. `DATABASE_URL` is mandatory. `PORT` defaults to 3000. `TRUST_PROXY` accepts `false`, `true`, or a comma-separated trusted proxy allow-list; numeric values are rejected. Database URLs and other secrets are not logged by the application.
