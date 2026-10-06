Aufgabe: M1-A Gerüst (REQ-DL-002, Hash 5d6398de6dbb5063) / Status: fertig / Artefakte: pnpm workspace, API, Worker, domain/contracts/storage packages, migration 0001, PostgreSQL integration tests, development documentation / Zusammenfassung: Implemented the M1-A monorepo foundation on branch `m1-core`. The API exposes a database-backed `GET /healthz`; the worker has an explicit start/stop lifecycle; the storage package exposes ports only plus a small checksum-verified SQL migration runner. Migration 0001 creates users, identities, local_credentials, sessions, audit_events, and schema_migrations. The identities schema enforces exact unique issuer/subject pairs and deliberately permits identical email claims on separate identities.

Prüfung (ausgeführt, nicht geprüft + Grund):
- Executed: `corepack pnpm --version` -> `11.28.5`.
- Executed: `DATABASE_URL='postgres://kura_dev:kura_dev@127.0.0.1:5432/kura_dev' corepack pnpm migrate` -> exit code 0; migration runner completed.
- Executed: `corepack pnpm check` -> exit code 0; TypeScript typecheck, ESLint, 4 Vitest PostgreSQL integration tests, and all five workspace builds passed.
- Executed: `corepack pnpm audit --audit-level=high` -> exit code 0; output: `1 vulnerabilities found`, `Severity: 1 low`. Therefore no High or Critical advisory was reported.
- Executed: `pg_isready -h 127.0.0.1 -p 5432` -> `127.0.0.1:5432 - accepting connections`.
- Executed: `git diff --check` -> exit code 0.
- Not checked: a clean-machine apt installation was not performed because the coordinator had already installed and started PostgreSQL in the sandbox; `docs/dev-setup.md` documents the fresh-machine commands.

Annahmen:
- `REQ-DL-002` and its stated hash were provided by the Kanban task; no immutable REQ-DL-002 file exists in this checkout. The only checked-in requirement file is REQ-DL-001.
- Requested decisions D-004 through D-009 are not present in `.claude/team/decisions.md`; it contains D-001 and D-002 only. No implementation detail was inferred from missing decisions.
- The coordinator-provided PostgreSQL development role/database is disposable and used only for the verified migration command and isolated test-database creation.
- Current shell pnpm was 12.9.1, but Corepack installed and all project commands used the repository-pinned pnpm 11.28.5.

Risiken:
- The audit reports one low-severity advisory. It does not violate the task's High/Critical gate, but should be rechecked when dependencies are upgraded.
- `TRUST_PROXY=true` trusts all proxy headers; production deployments should prefer the documented explicit trusted-address allow-list.

Offene Fragen:
- The coordinator should provide or restore D-004 through D-009 if they are intended to constrain M1-A implementation.

Nächster Schritt: Review the `m1-core` commits, then merge the branch or release the dependent M1 work.

## Runde 2

Aufgabe / Status: Reviewmängel aus M1-A Runde 2 umgesetzt / Artefakte: advisory-lock-geschützter Migrationsrunner, Parallelitätstest, Podman-Entwicklungsanleitung / Zusammenfassung: `runMigrations` reserviert auf einer dedizierten PostgreSQL-Verbindung vor allen Datenbankprüfungen den benannten festen Advisory-Lock `MIGRATION_ADVISORY_LOCK_KEY` mit `pg_advisory_lock`. Die Verbindung wird erst nach `pg_advisory_unlock` freigegeben, auch bei Fehlern. Der neue Integrationstest startet zwei Runner gleichzeitig gegen dieselbe leere Testdatenbank und bestätigt genau einen Eintrag je Migration. `docs/dev-setup.md` verwendet jetzt ausschließlich den angeforderten Podman-Container, ein DATABASE_URL-Platzhalterbeispiel und den D-010-Sandbox-Hinweis.

Prüfung (ausgeführt):
- `git diff --check && corepack pnpm exec eslint packages/storage/src/migrator.ts tests/integration/migrations.test.ts`
  Ausgabe: leer; Exit-Code 0.
- `for run in 1 2 3; do printf '\n=== migration concurrency test run %s ===\n' "$run"; corepack pnpm exec vitest run tests/integration/migrations.test.ts || exit $?; done`
  Ausgabe:
  ```text
  === migration concurrency test run 1 ===

   RUN  v5.0.3 /work/Downloader


   Test Files  1 passed (1)
        Tests  3 passed (3)
     Start at  18:13:46
     Duration  291ms (tests 77%, transform 11%, import 10%, worker 2%)


  === migration concurrency test run 2 ===

   RUN  v5.0.3 /work/Downloader


   Test Files  1 passed (1)
        Tests  3 passed (3)
     Start at  18:13:46
     Duration  278ms (tests 75%, transform 14%, import 11%, worker 1%)


  === migration concurrency test run 3 ===

   RUN  v5.0.3 /work/Downloader


   Test Files  1 passed (1)
        Tests  3 passed (3)
     Start at  18:13:47
     Duration  302ms (tests 75%, transform 12%, import 11%, worker 2%)
  ```
- `corepack pnpm check`
  Ausgabe:
  ```text
  $ pnpm typecheck && pnpm lint && pnpm test && pnpm build
  $ pnpm -r typecheck
  Scope: 5 of 6 workspace projects
  packages/contracts typecheck$ tsc --noEmit
  packages/domain typecheck$ tsc --noEmit
  packages/storage typecheck$ tsc --noEmit
  packages/contracts typecheck: Done
  apps/api typecheck$ tsc --noEmit
  apps/worker typecheck$ tsc --noEmit
  packages/domain typecheck: Done
  packages/storage typecheck: Done
  apps/worker typecheck: Done
  apps/api typecheck: Done
  $ eslint . --max-warnings=0
  $ vitest run

   RUN  v5.0.3 /work/Downloader

   Test Files  2 passed (2)
        Tests  5 passed (5)
     Start at  18:13:55
     Duration  327ms (tests 72%, import 18%, transform 8%, worker 2%)

  $ pnpm -r build
  Scope: 5 of 6 workspace projects
  packages/contracts build$ tsc -b
  packages/storage build$ tsc -b
  packages/domain build$ tsc -b
  packages/contracts build: Done
  apps/api build$ tsc -b
  apps/worker build$ tsc -b
  packages/domain build: Done
  packages/storage build: Done
  apps/worker build: Done
  apps/api build: Done
  ```
- `corepack pnpm audit --audit-level=high`
  Ausgabe:
  ```text
  1 vulnerabilities found
  Severity: 1 low
  ```
  Exit-Code: 0.

Annahmen:
- Die von der Karte genannte Anforderung `REQ-DL-002` hat den verifizierten SHA-256-Präfix `5d6398de6dbb5063`; die lokale Datei enthält nur den Auftraggebertext, die konkreten Runde-2-Abnahmekriterien stammen daher aus der Kanban-Karte.
- Die Container- und Volume-Befehle in `docs/dev-setup.md` wurden nicht ausgeführt, weil die Sandbox-Umgebung laut D-010 vom Orchestrator verwaltet wird. Die vorhandene PostgreSQL-Instanz auf `127.0.0.1:5432` führte alle Integrationstests aus.

Risiken / Rückweg:
- Der Advisory-Lock serialisiert Migrationsstarts für die Dauer jedes Laufs; ein hängen gebliebener Client hält ihn nur bis zum Verlust seiner PostgreSQL-Sitzung. Rückweg: diesen Commit revertieren; dadurch kehrt das frühere parallele Verhalten zurück.
- Die Dokumentationsänderung überschreibt keine Container- oder Datenbankdaten. Ein bereits vorhandener Container namens `kura-postgres` muss vor dem Podman-Start bewusst behandelt werden.

Offene Fragen: Keine innerhalb des Auftragsumfangs.
