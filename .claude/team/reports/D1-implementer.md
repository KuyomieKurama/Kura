# D1-implementer

Aufgabe: D1 Container-Start reparieren (Paket-Exports auf dist). REQ-DL-003 (req_hash b83be904af3eded5), REQ-DL-002 (5d6398de6dbb5063). Worktree /work/wt/deploy, Branch fix/container-exports (Basis main = m3).

Status: fertig (nur lokal committet, nichts gepusht). Container-Image-Build selbst nicht ausgeführt (Podman im Sandbox nicht verfügbar) -> Nachweis auf Node-Ebene.

Artefakte:
- packages/{adapters,blobstore,contracts,domain,identity,immich-client,scheduler,storage}/package.json
- tests/deploy/package-exports.test.ts (neu)
- .claude/team/reports/D1-implementer.md
- deploy/Containerfile: unverändert (nicht nötig).

Zusammenfassung:
1. Ursache bestätigt: 7 Pakete deklarierten `"exports": "./src/index.ts"`. Im Produktionsbaum (`pnpm deploy --prod`) liegen sie unter node_modules; Node bricht mit ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING ab (im Test mit altem exports-Feld im deployten Baum exakt reproduziert, siehe Prüfung).
2. Alle 7 Pakete (nicht nur die vom API direkt importierten blobstore/identity/immich-client; contracts ist API-Dependency, adapters/domain/scheduler der Einheitlichkeit und des Regressionstests wegen) auf `"exports": { "types": "./src/index.ts", "development": "./src/index.ts", "default": "./dist/index.js" }` umgestellt. storage erhielt nur die zusätzliche `development`-Bedingung.
   - `types` -> src: tsc/typecheck unverändert (grün).
   - `development` -> src: vitest/vite setzt außerhalb von NODE_ENV=production die Bedingung `development`, reines Node nie. Ohne diese Bedingung nahm vitest `default` (dist) und 8 Testdateien scheiterten, wenn dist nicht gebaut war (pnpm check testet VOR dem Build). Abweichung vom reinen storage-Muster, bewusst, damit `pnpm check` auf frischem Checkout ohne dist läuft.
   - `default` -> dist: was Node im Image lädt.
3. Build-Skript geändert: `tsc -b` -> `tsc -p tsconfig.json --outDir dist` in den 7 Paketen. Grund: `outDir: "dist"` steht nur in tsconfig.base.json und wird relativ zur Basisdatei aufgelöst, also <repo>/dist. Dort überschrieben sich die Pakete gegenseitig (vorher enthielt <repo>/dist nur die Ausgabe eines Pakets); packages/*/dist entstand nie außer bei storage und api (eigenes outDir). Ein tsconfig-Edit war verboten und ist so nicht nötig. `tsc -b` erlaubt kein --outDir, daher `tsc -p`.
4. Regressionstest tests/deploy/package-exports.test.ts (25 Tests): jedes packages/*/package.json braucht exports-Objekt mit types+default, alle Laufzeit-Ziele (ohne types/development; inkl. main und bin) müssen unter ./dist/ liegen und dürfen nicht auf .ts enden, types muss auf src/*.ts zeigen, build-Skript muss existieren. Läuft in `pnpm test`/`pnpm check`. Negativprobe: domain-default auf ./src/index.ts gesetzt -> Test FAIL; danach zurückgesetzt.

Prüfung (ausgeführt):
- Vorher: `corepack pnpm exec vitest run` -> 13 Dateien, 110 passed, 1 skipped; `corepack pnpm check` Exit 0.
- Nachher: `corepack pnpm exec vitest run` -> 14 Dateien, 135 passed, 1 skipped (+25 neue Tests); `corepack pnpm check` (typecheck, lint, test, build) Exit 0.
- Produktionsbaum: `pnpm -r build` (Exit 0), `pnpm --filter @kura/api deploy --prod /tmp/prod` (90 Pakete). Anordnung wie im Image nachgebaut (/tmp/layout/apps/api = deploy-Ausgabe, apps/web/dist, migrations). Start: `NODE_ENV=production HOST=127.0.0.1 PORT=18080 DATABASE_URL=postgres://kura_dev:***@127.0.0.1:5432/kura_dev KURA_STORAGE_BACKEND=database KURA_SECRET_KEY=<openssl rand -base64 32> COOKIE_SECURE=false node apps/api/dist/index.js`:
  - Log: "Server listening at http://127.0.0.1:18080"
  - GET /healthz -> 200 {"status":"ok"}
  - GET /api/v1/status -> 200, 9 Migrationen, latest 0033_immich_endpoint_approvals
  - GET /api/v1/immich/connection -> 401 UNAUTHENTICATED
  - GET /api/v1/admin/immich/endpoint-approvals -> 401 UNAUTHENTICATED
  - GET /api/v1/auth/oidc/start und /callback (OIDC nicht konfiguriert) -> 404 OIDC_DISABLED
  - GET / -> 200 (Web-UI)
  - Mit OIDC-Variablen (Issuer http://127.0.0.1:1/ absichtlich unerreichbar): /healthz 200, /api/v1/auth/config oidcEnabled true, /api/v1/immich/connection 401, /oidc/callback 302, /oidc/start 500 OIDC_CONFIG_INVALID. Der 500 ist erwartetes Anwendungsverhalten bei nicht erreichbarem Issuer (Identity-Code aus dist wird ausgeführt), kein Modul-Ladefehler.
- Gegenprobe: im deployten Baum exports von blobstore/identity/immich-client/storage auf "./src/index.ts" zurückgesetzt -> `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING ... @kura/storage/src/index.ts` (Fehler reproduziert).
- Nicht geprüft: echter Podman/Docker-Image-Build und Lauf auf der Test-VM (unbekannt); voller OIDC-Login im Prod-Baum (die Fake-Provider-Tests laufen gegen src in vitest).

Annahmen:
- Nur Node 22.23.2 aus dem Sandbox; das Image nutzt node:22-trixie-slim (gleiche Hauptversion, Patch unbekannt).
- Das Containerfile baut mit `pnpm -r build` aus sauberem Kontext (kein altes tsbuildinfo/dist); lokal bestätigt, im Image unbekannt.
- `development`-Bedingung wird in Produktion nie von Node gesetzt (kein `--conditions=development`, kein NODE_OPTIONS dieser Art im Containerfile).

Risiken:
- apps/worker (`tsc -b`, kein eigenes outDir) schreibt weiterhin nach <repo>/dist (aufgefallen; nicht Teil des API-Images, Fix wäre outDir in apps/worker/tsconfig.json, orchestratoreigen, nicht angefasst). Das nun gebaute Root-dist ist git-ignoriert.
- Paket-`tsc -p ... --outDir dist` legt tsconfig.tsbuildinfo neben die tsconfig (git-ignoriert). Bleibt tsbuildinfo bei gelöschtem dist stehen, kann tsc dist als aktuell ansehen; im Image nicht relevant (sauberer Kontext).
- Weicht ein künftiges Paket vom Muster ab, schlägt tests/deploy/package-exports.test.ts fehl (gewollt).

Offene Fragen:
- Soll apps/worker/tsconfig.json ein eigenes outDir bekommen (Orchestrator)?

Nächster Schritt: Review des Branches fix/container-exports, Merge nach main, Image auf der Test-VM bauen und /healthz auf Port 8080 prüfen.

Rollback: `git revert` der beiden D1-Commits bzw. Branch fix/container-exports verwerfen; keine Daten-/Schemaänderung.
