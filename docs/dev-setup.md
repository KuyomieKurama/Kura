# Development setup

## Prerequisites

Install Node.js 22 or later and enable Corepack. The repository pins pnpm 11.28.5:

```sh
corepack install
pnpm --version
```

Create a named Podman volume and start the local PostgreSQL container:

```sh
podman volume create kura-pgdata
podman run -d --name kura-postgres \
  -v kura-pgdata:/var/lib/postgresql/data \
  -e POSTGRES_USER=kura_dev \
  -e POSTGRES_PASSWORD=kura_dev \
  -e POSTGRES_DB=kura_dev \
  -p 127.0.0.1:5432:5432 \
  docker.io/library/postgres:17-trixie
```

`kura_dev` is a disposable development-only example password. Choose a unique local password outside this example and substitute it consistently in the command and `DATABASE_URL`. The loopback binding keeps the database local to the host.

The agent sandbox is managed by the orchestrator. Its container shares the sandbox network namespace, so PostgreSQL is reachable there at `127.0.0.1:5432`; see D-010. Verify readiness with:

```sh
pg_isready -h 127.0.0.1 -p 5432
```

The development role needs `CREATEDB` because the integration tests create and drop isolated disposable databases. Do not grant it to a production application role.

## Install and verify

```sh
pnpm install --frozen-lockfile
export DATABASE_URL='postgres://<user>:<password>@127.0.0.1:5432/<database>'
pnpm migrate
pnpm check
```

`pnpm check` uses PostgreSQL for migration, uniqueness, and API health-check integration tests. It derives temporary database names, creates them using the configured role, and drops them after each test. Do not point `DATABASE_URL` at a production database or an account without permission to create/drop its own test databases.

## Configuration

Copy `.env.example` for local reference; environment variables are read by the API process. `DATABASE_URL` is mandatory. `PORT` defaults to 3000. `TRUST_PROXY` accepts `false`, `true`, or a comma-separated trusted proxy allow-list; numeric values are rejected. Database URLs and other secrets are not logged by the application.
