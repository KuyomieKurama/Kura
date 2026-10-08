# M5-B Worker führt Downloads aus — Bericht Implementer

Task t_9dcd7ad9 · req REQ-DL-002 `5d6398de6dbb5063`, REQ-DL-003 `b83be904af3eded5`, REQ-DL-001 `9fd10d9e84b53fb8` · Worktree `/work/wt/m5b`, Branch `lane/worker` (Basis `lane/scheduler` 1a0aaa7, danach `lane/adapters` konfliktfrei gemergt, Merge 0605fa7) · Iteration 1

## Aufgabe

Kura soll tatsächlich herunterladen: Der Worker holt Läufe aus der Queue (M4), wählt einen Adapter (M5-A), legt jede Datei im Blobstore ab (M2), führt eine dauerhafte Historie und übergibt an die bestehende Immich-Übertragung (M3, ohne Löschen). API und Weboberfläche bekommen Adressprüfung, „Jetzt ausführen“, Adapterübersicht, Kill-Switches (Administrator) und eine Seite „Verlauf“.

## Status

**Fertig, braucht Review.** `corepack pnpm check` grün. Nicht geprüft (unbekannt): echter Aufruf von yt-dlp und gallery-dl, Podman-Image-Build mit dem Worker, die Oberfläche in einem echten Browser, mehrere Worker-Prozesse gleichzeitig, echter Immich-Server.

## Artefakte

Commits auf `lane/worker` (englische Meldungen, neueste zuletzt):

- `0334122` Migrationen 0050 und 0051
- `2956fe6` Quellenauswahl, Validierungsmodus der CLI-Adapter
- `cc13e23` Executor, Katalog, Historie, Import, Übergabe, Fehlerabbildung, Claim-Schleife
- `217abc3` Pipeline-Test Direct-URL auf PostgreSQL mit lokalem Server und Fake-Immich
- `1c35e24` Tests: CLI-Adapter, Teilerfolg, Auth/Rate-Limit, Kill-Switch, Quota, Abbruch, Crash-Resume
- `a58c1a8` API-Routen, Worker-Prozess-Tests, Löschpfad-Test, Fixture-Erweiterung
- `99e119f` Weboberfläche
- `5a37810` `.env.example`
- dieser Bericht (eigener Commit)

Neue Dateien:

- `migrations/0050_download_history.sql`: `download_runs`, `download_posts`, `download_assets`. Keine Fremdschlüssel auf Queue, Blobstore oder Immich-Übertragungen, damit Retention und spätere Aufräumschritte die Historie nicht berühren. Verknüpft ist nur der Besitzer (`users`, `ON DELETE RESTRICT`).
- `migrations/0051_sync_state_and_adapters.sql`: `subscription_sync_state` (zuletzt gesehener Beitrag/Revision, `checked_through`), `adapter_status` (vom Worker gemeldet), `adapter_kill_switches`.
- `packages/adapters/src/source-selection.ts`: `selectSource`, `createTargetRecognizer`. Ein Link auf eine bekannte Plattform geht nie an den Direct-URL-Adapter.
- `apps/worker/src/`: `config.ts`, `catalog.ts`, `history.ts`, `blob-import.ts`, `handover.ts`, `failure.ts`, `executor.ts`, `download-loop.ts`, `maintenance.ts`, `worker.ts`.
- `apps/api/src/source-routes.ts` (Routen siehe Zusammenfassung).
- `apps/web/src/`: `Adapters.tsx`, `History.tsx`, `SourceCheck.tsx`, `history-labels.ts`, `Sources.test.tsx`.
- `tests/m5b/`: `source-selection`, `pipeline-direct`, `pipeline-tools`, `pipeline-failures`, `worker-process`, `source-api`, `no-deletion` sowie Hilfen `file-server`, `fake-immich`, `tools`, `fixture`.

Geänderte bestehende Dateien (vollständige Liste der Eingriffe außerhalb der eigenen Pfade, wie von der Karte verlangt):

- `packages/adapters/src/cli-support.ts`, `yt-dlp-adapter.ts`, `gallery-dl-adapter.ts`, `index.ts`: Option `validationOnly` (die Plattformerkennung läuft ohne Binary und ohne Prozess; `assertUsable()` wirft `BINARY_NOT_CONFIGURED`, bevor etwas gestartet wird), `runMetadata` jetzt `async`, Export von `source-selection`. Grund: Die API soll Adressen erkennen, ohne ein Werkzeug zu besitzen.
- `packages/scheduler/src/subscriptions.ts`: neue Methode `setTargetState(userId, subscriptionId, 'valid'|'invalid', checkedSourceRef)`. Wirkt nur, wenn `source_ref` unverändert ist (kein veraltetes Ergebnis nach einer Änderung der URL).
- `apps/worker/package.json`: Build `tsc -p tsconfig.json --outDir dist` (damit `apps/worker/tsconfig.json` unangetastet bleibt, die Datei ist gesperrt), Abhängigkeiten auf `@kura/adapters`, `blobstore`, `contracts`, `immich-client`, `scheduler` (`workspace:*`) und `pg` 8.23.1 (bereits im Repo verwendet, MIT).
- `apps/api/package.json`: `@kura/adapters` (`workspace:*`).
- `pnpm-lock.yaml`: 12 Zeilen, nur Importer-Einträge (Folge der Workspace-Abhängigkeiten).
- `apps/web/src/App.tsx`, `Subscriptions.tsx`, `api.ts`. `App.tsx` hat sehr lange Zeilen (Hotspot, schon aus M4-B bekannt); ich habe dort nur Ansicht „Verlauf“ und `isAdmin` ergänzt.
- `.env.example`: Abschnitt „Download execution (M5-B)“.

Neue Abhängigkeiten von Dritten: keine. `pnpm audit --audit-level=high`: „2 vulnerabilities found, Severity: 1 low | 1 moderate“ (kein high/critical, unverändert gegenüber M5-A).

Nicht angefasst: gesperrte Pfade (Root-`package.json`, `pnpm-workspace.yaml`, `tsconfig*`, `.github`, `docs/planning`, `CLAUDE.md`, `.claude/team/*.md`, bestehende Migrationen, `packages/immich-client`, `packages/blobstore`), `deploy/**`.

## Zusammenfassung

[Iroha] Die kürzeste Linie, die die Karte erfüllt: ein Executor, der pro Lauf Adapter wählen, entdecken, auflösen, laden, in den Blobstore streamen, Historie schreiben und an Immich übergeben kann, und eine Claim-Schleife darum herum. Der Heartbeat der Lease liegt in der Schleife, nicht im Executor — so kann kein Adapter ihn aushungern. Die Kosten: viel Code (`executor.ts` hat rund 500 Zeilen) und ein paar Dinge, die ich bewusst NICHT gebaut habe (siehe Offene Fragen). Abkürzung, die ich genommen habe: Die Adapter werden beim Start einmal und danach alle 10 Minuten geprüft, statt bei jedem Lauf. Das ist deklariert unter Annahmen.

[Yui] Ich habe vor allem daran gedacht, was passiert, wenn etwas schiefgeht. Eine abgelaufene Anmeldung darf nie wie „keine neuen Beiträge“ aussehen: `AUTH_REQUIRED` → Zustand `waiting_auth`, Abonnement wird pausiert, die Meldung ist deutsch und enthält nichts, was vom Werkzeug oder Server stammt. Eine Entdeckungsmarke ist kein Download-Erfolg: `checked_through` rückt nur nach vollständiger Enumeration vor, und ein Beitrag mit fehlgeschlagener Datei ist `partially_completed`, die fertigen Dateien werden nicht erneut geladen. Der Import vertraut dem Adapter nicht: Datei erneut prüfen, in 4-MiB-Stücken in den Blobstore streamen, bei Abweichung Quarantäne statt „fertig“. Und nichts in diesem Code kann ein Original, einen Blob oder eine Historienzeile löschen; `tests/m5b/no-deletion.test.ts` prüft das per Textsuche.

Was umgesetzt ist:

1. **Executor** (`executor.ts`): `validateTarget` → `probe` → `discover` → `resolveAssets` → `download` → Import → Historie → Übergabe. Höchstens 500 Beiträge je Lauf. Zustände wie Plan 04 §4. Fehler werden in `failure.ts` abgebildet: Auth → `waiting_auth` und Pause; Rate-Limit → `waiting_rate_limit` (15 min oder `Retry-After`); Quota und Abbruch → eigene Meldungen; Quelle weg → terminal; sonst Wiederholung mit Backoff bis `max_attempts`.
2. **Historie** (0050): Läufe, Beiträge, Dateien mit Größe, SHA-256, Zustand, Fehlercode und -text, Übergabezustand. Der Beitrag bleibt am Lauf, der ihn zuerst fand. Die Historie enthält keine Cookies, Zugangsdaten, signierten Links oder Werkzeugausgaben.
3. **Immich-Übergabe** (`handover.ts`): bestehender `TransferService` mit Originalnachweis, unsichere Ergebnisse bleiben unsicher (`reconciling`/`uploaded_unverified`), `localOriginalRetained: true`. Freigaben für Loopback/Privatnetz gelten nur für Immich-Ziele (`immich_endpoint_approvals`). Für Download-URLs gilt in Produktion `approveNothing`, also keine Freigabe.
4. **Werkzeug-Konfiguration** (`config.ts`, `catalog.ts`): absoluter Pfad plus erwartetes SHA-256 je Werkzeug aus der Umgebung. Fehlt eines, wird der Adapter als „nicht verfügbar“ gemeldet (`adapter_status`), Läufe für diese Quelle enden mit deutscher Meldung. Der Direct-URL-Adapter braucht kein Werkzeug.
5. **Kill-Switches**: Tabelle `adapter_kill_switches`, vom Worker vor jedem Lauf geladen, vom Administrator über die API/UI gesetzt und aufgehoben.
6. **API** (`source-routes.ts`, alle hinter Sitzung, Besitzerfilter, Fremdes = 404):
   - `POST /api/v1/sources/validate`, `POST /api/v1/subscriptions/:id/validate` (Plattform, Adapter, Fähigkeiten, Hinweise, oder klare Ablehnung auf Deutsch; es wird nichts geladen und kein Netzwerkzugriff gemacht)
   - `POST /api/v1/subscriptions/:id/run-now` (ein manueller Lauf, zweiter Klick wird zusammengelegt, pausiertes Abo = 409)
   - `GET /api/v1/subscriptions/:id/sync-state`
   - `GET /api/v1/adapters`
   - `GET /api/v1/history` (Läufe, Beiträge, Dateien mit Immich-Nachweis; `limit` 1–100, `subscriptionId`)
   - Administrator: `GET/POST /api/v1/admin/adapter-kill-switches`, `DELETE …/:id`
7. **Weboberfläche** (deutsch): „Adresse prüfen“ im Abo-Formular und an jeder Abo-Karte, „Jetzt ausführen“, Panel „Unterstützte Quellen und Adapter“ (mit Abschaltungen nur für Administratoren), Seite „Verlauf“ mit Läufen, Beiträgen, Zustand je Datei und Immich-Nachweis. Die Texte kommen aus festen deutschen Tabellen, nie aus Werkzeug- oder Serverausgaben.

## Prüfung

Alle Läufe mit `DATABASE_URL=postgres://kura_dev:***@127.0.0.1:5432/kura_dev` (echtes PostgreSQL).

- **Vorher** (Stand nach Merge und Install, vor jeder Änderung; Log `/tmp/m5b-baseline.txt`): `corepack pnpm check` Exit 0, `Test Files  27 passed (27)`, `Tests  512 passed | 1 skipped (513)`.
- **Nachher** (nach `5a37810`; Log `/tmp/m5b-final.txt`): `corepack pnpm check` Exit 0, `Test Files  34 passed (34)`, `Tests  629 passed | 1 skipped (630)`. Das sind +7 Dateien und +117 Tests, alle in `tests/m5b/`.
- **Nach Review-Runde 1** (Korrektur offener Verlaufszeilen; Log `/tmp/m5b-round2.txt`): `corepack pnpm check` Exit 0, `Test Files  34 passed (34)`, `Tests  633 passed | 1 skipped (634)` (+4 Tests in `tests/m5b/pipeline-failures.test.ts`). Gegenprobe: ohne den Aufruf in `startRun` schlägt der Test „zombie never wakes up“ fehl.
- Weboberfläche (nicht Teil von `pnpm check`, wie schon in M4-B): `apps/web` `vitest run`: `Test Files  6 passed (6)`, `Tests  40 passed (40)` (vorher 31; +9 in `Sources.test.tsx`); `tsc --noEmit` und `pnpm --filter @kura/web build` ohne Fehler.
- `eslint . --max-warnings=0` ohne Ausgabe (vor jedem Commit).
- **Echter Prozess mit Produktions-Build:** `pnpm --filter @kura/worker deploy --prod` in ein Verzeichnis, dort `node dist/index.js` gegen eine frische, migrierte Datenbank (danach gelöscht), mit einem selbst geschriebenen gallery-dl-Ersatz (Skript, Pfad + SHA-256 konfiguriert), einem eingereihten manuellen Lauf für eine Pixiv-URL. Ergebnis: Log „run finished … result stored“, `download_runs`: 1 Zeile `stored`, `assets_stored` 2, `adapter_version` 1.32.2; `download_assets`: 2 Zeilen `stored`; `job_runs`: `succeeded`; `adapter_status`: gallery-dl `available`, yt-dlp `unavailable` (`BINARY_NOT_CONFIGURED`), direct-url `available`; `blobstore_objects`: 2; Übergabe `no_connection` (kein Immich eingerichtet); danach SIGTERM → „worker stopped“. Das belegt, dass das gebaute Paket mit seinen Abhängigkeiten startet und einen Lauf zu Ende bringt. Es belegt NICHT, dass das echte gallery-dl so antwortet.

Abgedeckt durch die Tests (Auszug):

- Ende-zu-Ende mit lokalem HTTP-Server und Fake-Immich: Abo → Einreihen → Worker → Blob → Historie → Übertragung mit Nachweis. Loopback nur über eine im Test eingespritzte Freigabe, die Produktionsvorgabe (`approveNothing`) ist unverändert und hat einen eigenen Test.
- Mehrseitiger Beitrag, Teilerfolg (`partially_completed`, fertige Dateien werden nicht erneut geladen), Entdeckungsmarke ≠ Erfolg, 429 mit `Retry-After`, Auth-Fehler, Quota, Abbruch, Kill-Switch (Lauf wird abgewiesen, andere Adapter laufen weiter), Absturz und Wiederaufnahme nach Lease-Ablauf, Zwei-Benutzer-Isolation (Historie, Sync-Stand, Übertragung), Immich-Modi normal/unsicher/beschädigt.
- API: Erkennung aller Plattformen, Ablehnungen mit Meldung, Verfügbarkeit nach Meldung des Workers, Admin-only und Audit für Kill-Switches, Validierungsfehler, „Jetzt ausführen“ (Zusammenlegen, Fremdes, pausiert), Historie nach Löschen des Abonnements.
- Löschpfad: Textsuche über neuen Code und Migrationen (kein `DELETE FROM`, `DROP`, `TRUNCATE`, `unlink`, `rm` auf Originale, Blobs, Historie).
- Wiederholung: `vitest run tests/m5b` mehrfach ohne Flackern (drei Durchläufe nach den Stall-Änderungen).

## Betrieb auf der VM

Ich habe `deploy/**` NICHT geändert; die Karte erlaubt nur 1–2-Zeilen-Korrekturen, hier ist mehr nötig. Ob das Image so baut und startet, ist **unbekannt** (kein Podman in der Sandbox).

Genau nötige Änderungen für den Orchestrator (ersetzen die vier aus dem M4-B-Bericht; die erste entfällt, weil der Worker-Build jetzt `--outDir dist` selbst setzt):

1. `deploy/Containerfile`, Build-Stufe: an die bestehende `RUN`-Zeile `&& pnpm --filter @kura/worker deploy --prod /production-worker` anhängen. Laufzeit-Stufe: `COPY --from=build --chown=kura:kura /production-worker ./apps/worker`. (Geprüft in der Sandbox: `pnpm deploy --prod` für den Worker erzeugt ein startfähiges Verzeichnis.)
2. `deploy/kura-deploy.sh`: nach `kura-app` ein zweiter Container aus demselben Image, ohne Port, mit eigenem Befehl und beschreibbarem Staging-Verzeichnis:
   `podman rm -f kura-worker; podman run -d --name kura-worker --network kura-net --restart=always --env-file "$ENV_FILE" -e KURA_WORK_DIR=/data/staging -v kura-staging:/data/staging -v kura-tools:/opt/kura-tools:ro "localhost/kura:$TAG" node apps/worker/dist/index.js`
   Das Volume `kura-staging` muss dem Benutzer `kura` im Container gehören (beim ersten Anlegen `podman unshare chown` oder ein Init-Schritt). Das Staging muss groß genug sein für die größte Datei, zweimal.
3. `deploy/README.md`: eine Zeile zum Worker und zu den Werkzeugen.
4. Der Blobstore liegt in PostgreSQL und wird von Worker und API gemeinsam genutzt: Beide müssen dieselbe `DATABASE_URL`, denselben `KURA_SECRET_KEY` und denselben `KURA_STORAGE_QUOTA_BYTES` bekommen (alle in der gemeinsamen `--env-file`).

Umgebungsvariablen des Workers (alle in `.env.example` dokumentiert): `DATABASE_URL` (Pflicht), `KURA_SECRET_KEY` (sonst können gespeicherte Immich-Schlüssel nicht gelesen werden und jede Übergabe wird „fehlgeschlagen“), `KURA_WORK_DIR`, `KURA_STORAGE_QUOTA_BYTES`, `WORKER_DOWNLOADS`, `WORKER_DOWNLOAD_CONCURRENCY`, `WORKER_POLL_SECONDS`, `WORKER_LEASE_SECONDS`, `WORKER_MAX_ASSET_BYTES`, `WORKER_ADAPTER_RECHECK_SECONDS`, `WORKER_TICK_SECONDS`, `WORKER_RETENTION_INTERVAL_SECONDS`.

Werkzeuge (vom Betreiber installiert, nicht Teil des Images):

- yt-dlp ≥ 2026.07.04 (D-007) und gallery-dl (getestet gegen das Verhalten von 1.32.2 laut Fake), jeweils als absolute Datei, z. B. unter `/opt/kura-tools/`.
- Je Werkzeug `sha256sum <datei>` und beides setzen: `KURA_YTDLP_PATH` + `KURA_YTDLP_SHA256`, `KURA_GALLERYDL_PATH` + `KURA_GALLERYDL_SHA256`. Pfad und Hash müssen zusammen gesetzt sein, sonst startet der Worker nicht.
- Optional `KURA_TOOL_PATH` für ein festes ffmpeg (yt-dlp braucht es zum Zusammenfügen; ob und wie es installiert wird, ist offen).
- Ohne Werkzeug: Direct-URL läuft, die Plattformen melden „nicht installiert oder nicht freigegeben“. Das ist der erwartete Zustand eines frisch aufgesetzten Teststands und kein Fehler.

Betriebsfolgen: Der Worker erzeugt weiter die Zeitplan-Läufe (Scheduler) und führt sie jetzt auch aus. Wer einen Prozess nur als Scheduler will, setzt `WORKER_DOWNLOADS=false`. Migrationen 0050 und 0051 laufen mit dem bestehenden Migrationslauf beim Start.

Rückweg: `git revert` der Commits ab `0334122` (neueste zuerst), oder das Image auf den vorherigen Tag zurückstellen und `kura-worker` entfernen. Die Migrationen legen nur Tabellen an. Bleiben die Tabellen (`download_*`, `subscription_sync_state`, `adapter_*`) nach einem Rückbau zurück, stört das den alten Stand nicht; Daten darin sind Historie und werden von Kura nicht gelöscht.

## Änderungen in Review-Runde 1

1. **Offene Verlaufszeilen nach Absturz** (Befund des Reviewers, bestätigt): Eine `download_runs`-Zeile eines abgestürzten Versuchs blieb `downloading` mit `finished_at` NULL, solange der Zombie nicht selbst aufwachte. Jetzt schließt `HistoryRepository.closeOrphanedRuns()` (nur `UPDATE`, kein Löschen) jede offene Zeile ohne lebende Lease: Zustand `retry_wait`, Code `LEASE_LOST`, deutsche Meldung. „Lebend“ heißt: `job_runs.state = 'leased'` und `job_runs.attempts = download_runs.lease_generation` (die Spalte `attempts` ist das Fencing-Token; der Vorschlag des Reviewers nannte `lease_generation`, die gibt es in `job_runs` nicht). Per `NOT EXISTS`, damit es auch greift, wenn die Queue-Zeile durch Retention schon weg ist. Aufgerufen (a) in `startRun` für frühere Versuche desselben Laufs, (b) beim Start von `DownloadMaintenance` und (c) bei jedem Wartungsdurchlauf (alle `WORKER_ADAPTER_RECHECK_SECONDS`). Ein Lauf endet normal immer mit `finished_at` VOR dem Freigeben der Lease, ein lebender Lauf wird also nicht getroffen. Eine abgelaufene, aber noch nicht zurückgeholte Lease zählt noch als lebend (der Scheduler-Schritt `reclaimExpiredLeases` holt sie zurück).
   Rückweg: `git revert` des Commits dieser Runde; die Zeilen bleiben dann bei einem Absturz wieder offen. Keine Migration.
2. Tests (`tests/m5b/pipeline-failures.test.ts`, Block „history of runs whose worker died“): Nachfolger startet, Zombie wacht nie auf; keine Nachfolger-Lease mehr (Versuche aufgebraucht, Queue `failed`) und Sweep; Queue-Zeile bereits gelöscht; lebende Lease bleibt unberührt. Der No-Deletion-Test ist weiter grün.

## Annahmen

0. **`subscription_sync_state` wird nur geschrieben, nicht gelesen.** `HistoryRepository.getSyncState` und der `target_hash`-Vergleich werden vom Executor nie ausgewertet (nur die API `GET …/sync-state` zeigt den Stand). Jeder Lauf listet alles neu auf und überspringt bereits archivierte Beiträge über `download_posts`. Das reicht für die heutigen Ein-Beitrag-Adapter (Direct-URL) und für die Werkzeug-Adapter bei kleinen Zielen; „inkrementell“ ist damit nur eine aufgezeichnete Marke, kein Abkürzen der Entdeckung. Echte Abkürzung (nur neuere Beiträge als `last_seen_*` anfragen) ist nicht gebaut und gehört vor Einsatz mit großen Profilen nachgezogen.

1. Die Adapter-Verfügbarkeit wird beim Start und danach alle `WORKER_ADAPTER_RECHECK_SECONDS` (Standard 600) neu bestimmt, nicht bei jedem Lauf. Ein ausgetauschtes Binary wird aber vor JEDEM Start vom Runner gehasht (M5-A), die Anzeige kann also nur kurz veraltet sein.
2. Die API kennt die Verfügbarkeit nur aus `adapter_status`, nicht aus eigener Prüfung. Solange der Worker noch nicht gemeldet hat, steht dort „Noch nicht gemeldet“ und der Lauf ist erlaubt (`runnable: true`).
3. Plattform-Hosts: `youtube.com`, `youtu.be`, `instagram.com`, `pixiv.net`, `patreon.com`, `pornhub.com`. Eine Adresse auf einen davon geht nie an den Direct-URL-Adapter, auch wenn sie nicht erkannt wird; sie wird dann als nicht unterstützt gemeldet (z. B. YouTube-Playlist, Pornhub-Link, Instagram-Profil).
4. Standardwerte: Parallelität 2, Poll 5 s, Lease 120 s (Heartbeat bei ⅓), Wartezeit bei Ratenbegrenzung 15 min, höchstens 500 Beiträge je Lauf, 4-MiB-Stücke, Staging-Reste älter als 24 h werden entfernt (nur Verzeichnisse mit dem Muster `run-<24 hex>` im eigenen Staging-Verzeichnis).
5. Der Direct-URL-Adapter lädt eine Datei = ein Beitrag. `creatorId` ist der Hostname, `platformPostId` ein Hash der kanonischen URL.
6. Fehlertexte sind feste deutsche Meldungen je Fehlercode. Die Werkzeug- und Serverausgabe (`untrustedDiagnostics`) wird nirgends gespeichert.
7. Ein Kill-Switch ohne Version und Quelltyp schaltet den ganzen Adapter ab; mit Angaben nur den Umfang. Ein abgeschalteter Adapter macht eine Adresse nicht „ungültig“, sondern bleibt unverändert (`unvalidated`).
8. `pnpm deploy --prod` des Workers wurde in der Sandbox ausgeführt; der Container-Build ist unbekannt (kein Podman).
9. Der gallery-dl-Ersatz im Prozesstest ist ein Skript nach dem, was die M5-A-Fakes über die Ausgabe von `--dump-json` annehmen. Das echte Verhalten ist unbekannt.

## Risiken

1. **Werkzeug-Netzwerk ungeschützt:** yt-dlp und gallery-dl öffnen ihre Verbindungen selbst; der Netzwerkwächter des Direct-URL-Adapters gilt dort nicht (offene Frage aus M5-A, R-09). Auf der VM gibt es keine Egress-Sperre. Vor echtem Betrieb mit fremden Zielen: nftables-Regeln oder eigenes VLAN.
2. **Hash-Prüfung und Start sind zwei Schritte** (M5-A, Risiko 2); ein Austausch zwischen beiden Schritten ist theoretisch möglich, wenn das Werkzeugverzeichnis für den Kura-Benutzer beschreibbar ist. Das Volume `kura-tools` deshalb nur lesbar einbinden.
3. **Echte Plattformen sind nicht getestet** (R-01): Instagram, Pixiv, Patreon, YouTube, Pornhub. Die Fehlerabbildung hängt an den Codes aus M5-A; wie echte Werkzeuge Anmelde- und Ratenfehler melden, ist unbekannt.
4. **Anmeldedaten für Quellen gibt es noch nicht:** Es gibt keine Stelle, an der ein Benutzer Cookies oder Tokens für Patreon/Instagram hinterlegt. Solche Quellen enden bei Bedarf in `waiting_auth` und das Abo wird pausiert. Das ist der sichere Fehlerfall, aber die Quelle ist dann nicht nutzbar.
5. **Absturz mitten in der Übergabe:** Stirbt der Worker nach dem Immich-Upload und vor dem Schreiben des Übergabezustands, gibt es danach einen offenen Zustand. Geprüft ist der Absturz und die Wiederaufnahme nach Lease-Ablauf in den Tests (Crash-Resume); ob in jedem Zeitpunkt des Uploads keine zweite Übertragung entsteht, ist **unbekannt**.
6. **Staging-Platz:** Läuft das Staging-Volume voll, schlagen Läufe mit einer Platzmeldung fehl; das Aufräumen alter Reste ist auf 24 h gestellt und nicht einstellbar.
7. **Kein Löschen, auch nicht gewollt:** Der Speicherverbrauch der Quota wächst nur. Das ist Absicht (R-05, R-12), muss aber irgendwann gelöst werden (Karte außerhalb dieses Umfangs).
8. **`apps/web/src/App.tsx`** (sehr lange Zeilen) ist weiterhin ein Kollisions-Hotspot; Hinweis aus M4-B bleibt bestehen.

## Offene Fragen

0. Soll die Entdeckung wirklich inkrementell werden (Sync-Stand lesen, nur Neueres anfragen)? Siehe Annahme 0; derzeit nur Marke.
1. Soll `deploy/**` wie oben beschrieben vom Orchestrator geändert werden, oder soll der Worker vorerst im API-Prozess mitlaufen? (Ich habe es nicht gebaut; die Karte verlangt einen Worker.)
2. Wo sollen Anmeldedaten für Quellen (Cookies, Tokens) künftig liegen? Bis dahin sind nur öffentliche Quellen nutzbar. Nicht Teil dieser Karte, nicht gebaut.
3. Wie wird ffmpeg für yt-dlp bereitgestellt und gepinnt? Unbekannt; ohne ffmpeg schlagen Videos fehl, die zusammengefügt werden müssen.
4. Soll `partially_completed` automatisch wiederholt werden? Derzeit entscheidet die Wiederholungsregel der Queue (`max_attempts`); fertige Dateien werden nicht erneut geladen, nur die fehlgeschlagenen.
5. [Iroha vs. Yui, Uneinigkeit]: Iroha würde die Adapterprüfung bei Start und alle 10 Minuten so lassen (billig, einfach). Yui möchte sie vor jedem Lauf wiederholen, damit die Anzeige im Verlauf nie veraltet ist. Ich habe die einfache Variante gebaut und lege die Entscheidung vor.

## Nächster Schritt

Review. Danach: Entscheidung des Orchestrators zu den Deploy-Änderungen (Abschnitt „Betrieb auf der VM“), Stand auf der VM bauen, `pnpm check` dort ausführen, beide Werkzeuge mit Pfad und Hash einrichten und einen echten Lauf gegen eine eigene, öffentliche Quelle prüfen (bisher unbekannt), sowie Antwort auf die Fragen 1–5.
