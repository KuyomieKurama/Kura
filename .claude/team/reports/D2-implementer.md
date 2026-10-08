# D2 V3-Befunde beheben (Worker im VM-Deploy, Egress-Sperre für externe Werkzeuge) — Bericht Implementer

Task t_60dec92a · req REQ-DL-003 `b83be904af3eded5`, REQ-DL-002 `5d6398de6dbb5063`, REQ-DL-001 `9fd10d9e84b53fb8` · Worktree `/work/wt/m5b`, Branch `lane/worker` (Basis b392ea5, Urteil V3: FAILED) · Iteration 1

## Aufgabe

Zwei Befunde von Verifier V3 beheben, nicht mehr:

1. REQ-DL-003 (blockierend): Das versionierte VM-Deployment startet nur den API-Container und packt keinen Worker. Scheduler-Schleife (M4-B) und Download-Executor (M5-B) liefen auf dem Teststand nie.
2. R-09 / Plan 04 „Externe Prozessausführung“: yt-dlp und gallery-dl haben keine eingebaute Allowlist (D-008); der Guard deckt nur die In-Process-Abrufe. Es fehlte eine Egress-Sperre für die externen Prozesse (fail closed).

## Status

**Fertig, braucht Review.** `corepack pnpm check` grün. **Nicht geprüft: Podman-Build** (kein Podman in der Sandbox); das Deployment-Skript ist gegen einen Podman-Ersatz getestet, nicht gegen echtes Podman. Weitere ungeprüfte Punkte stehen unter „Prüfung“.

## Artefakte

Commits auf `lane/worker` (englische Meldungen, neueste zuletzt):

- `82dbc1a` Package and start the worker in the VM deployment
- `264025a` Add production-tree proof run for API and worker (finding 1 evidence)
- `03f9180` Block yt-dlp and gallery-dl until an external egress barrier is confirmed
- `9fd4c7e` Extend the production-tree proof with the egress block (finding 2 evidence)
- dieser Bericht (eigener Commit)

Befund 1:

- `deploy/Containerfile`: baut zusätzlich `pnpm --filter @kura/worker deploy --prod /production-worker` und kopiert es nach `/app/apps/worker`. Ein Image, zwei Prozesse (Standard-CMD bleibt die API, Worker: `node apps/worker/dist/index.js`, Einstiegspunkt gegen `apps/worker/package.json` geprüft). Neu: beschreibbare Verzeichnisse `/var/lib/kura/staging` und `/var/lib/kura/blobstore` für den Benutzer `kura`, gesetzt als Standard für `KURA_WORK_DIR` und `KURA_STORAGE_ROOT` (vorher zeigte der Standard auf `/app/data/...`, das `kura` nicht beschreiben konnte).
- `deploy/kura-deploy.sh` (POSIX sh, `sh -n` und dash geprüft): startet nach der API (Health-Wait unverändert) den Container `kura-worker` aus demselben Image, `kura-net`, gleiche Env-Datei, `--restart=always`, kein veröffentlichter Port, `--no-healthcheck` (das Image-HEALTHCHECK fragt Port 8080). Liveness ohne Port: Container muss `running` sein und `"message":"worker started"` geloggt haben, und drei Sekunden später noch laufen; sonst Logs ausgeben und Exit 1. Idempotent: `podman rm -f` vor jedem `run`, `kura-postgres` bleibt unberührt. Optionale Mounts: Volume `kura-blobdata` bei Dateisystem-Backend, `KURA_TOOLS_HOST_DIR` schreibgeschützt nach `/opt/kura-tools` nur im Worker.
- `.env.example`, `docs/vm-setup.md` (neue Abschnitte „Environment file“, „Storage“, „External tools“), `deploy/README.md`: jede Worker-Einstellung dokumentiert.
- `tests/d2/deploy-script.test.ts` (11 Tests, Skript gegen Podman-Ersatz), `tests/d2/containerfile.test.ts` (3 Tests).
- `tests/d2/prod-proof/run.mjs` und `worker-launcher.mjs`: Beweislauf aus den Produktionsbäumen (nicht Teil von `pnpm check`).

Befund 2:

- `packages/adapters/src/errors.ts`: neuer Fehlercode `EGRESS_NOT_CONFIRMED`.
- `apps/worker/src/config.ts`: `KURA_EXTERNAL_TOOLS_EGRESS_CONFIRMED` (nur `true`/`false`, Standard `false`, anderer Wert = Konfigurationsfehler), Feld `externalToolsEgressConfirmed`.
- `apps/worker/src/catalog.ts`: `AdapterCatalog` prüft, startet und registriert yt-dlp und gallery-dl nur bei bestätigter Sperre. Davor wird kein Hash geprüft und kein `--version` gestartet: kein Prozess. Verfügbarkeit `unavailable` mit Grund `EGRESS_NOT_CONFIRMED`; einmaliger Logeintrag. Der Katalog ist die einzige Stelle, die die CLI-Adapter baut (per Test festgenagelt).
- `apps/worker/src/executor.ts`, `failure.ts`: ein Auftrag für eine so gesperrte Plattform endet `failed` mit Code `EGRESS_NOT_CONFIRMED` und deutschem Text, nicht wiederholbar, Adresse bleibt `valid`.
- `apps/api/src/source-routes.ts`: Adapter-Übersicht und Quellenprüfung zeigen „Externe Werkzeuge gesperrt: Egress-Schutz nicht bestätigt. …“ (die Weboberfläche zeigt `adapter.message` ohnehin an).
- `tests/d2/egress-barrier.test.ts` (16 Tests), `apps/web/src/AdaptersEgress.test.tsx` (1 Test).
- Doku: `.env.example`, `docs/vm-setup.md` (Abschnitt „Egress barrier for the external tools“), `deploy/README.md`. Es werden keine Firewallregeln geschrieben.

Eingriff außerhalb der Dateien aus der Karte: `tests/m5b/fixture.ts` (3 Zeilen: Option `externalToolsEgressConfirmed`, Standard `true` im Test-Fixture, damit die bestehenden CLI-Pipeline-Tests laufen). Ohne diese Zeilen liefe jeder bestehende Test mit gefälschtem Werkzeug in die neue Sperre. Kein bestehender Test wurde geändert oder abgeschwächt.

## Zusammenfassung

Befund 1: Das Image enthält jetzt beide Prozesse, das Skript startet und prüft den Worker. Der Sandbox-Beweis läuft API und Worker aus den Bäumen, die `pnpm deploy --prod` erzeugt, gegen PostgreSQL: `/healthz` ok, Worker-Schleife läuft, ein per Zeitplan ausgelöster Direct-URL-Lauf geht bis „stored“ und Immich-Übergabe „verified“.

Befund 2: Standardmäßig sind die externen Werkzeuge gesperrt, auch mit gesetztem Pfad und Hash. Die Sperre sitzt an einer Stelle (Katalog), bevor ein Binary berührt wird. Der Betreiber bestätigt mit einer Umgebungsvariablen; Kura prüft die Regeln nicht und behauptet es nicht.

Wichtigster Fund bei der Analyse (Befund 1c): Die Karte setzt voraus, dass bei `filesystem` ein gemeinsames Volume API und Worker dieselben Objekte sehen lässt. Das stimmt nicht. Der Worker speichert immer in PostgreSQL (`DatabaseBlobStore`), und `FilesystemBlobStore` hält seinen Objektindex im Arbeitsspeicher des Prozesses (`this.objects`), ein Volume macht Objekte also nicht für einen zweiten Prozess sichtbar. Geteilter Speicher funktioniert nur mit `KURA_STORAGE_BACKEND=database`. Umgesetzt wurde trotzdem, was die Karte verlangt (Volume `kura-blobdata` in beiden Containern bei Dateisystem-Backend), dokumentiert wurde die Einschränkung klar, und die Empfehlung ist `database`. Siehe Offene Fragen.

## Prüfung

Ausgeführt (Sandbox, PostgreSQL 127.0.0.1:5432):

`corepack pnpm check`, wörtlich aus den Läufen:

- Vorher (HEAD b392ea5): `Test Files  34 passed (34)` / `Tests  633 passed | 1 skipped (634)`, Exit 0.
- Nachher (HEAD 9fd4c7e, ohne diesen Bericht): `Test Files  37 passed (37)` / `Tests  663 passed | 1 skipped (664)`, Exit 0. Zuwachs: 3 Dateien, 30 Tests (11 + 3 + 16), nichts übersprungen oder entfernt.
- Zusätzlich (nicht Teil von `check`): `corepack pnpm --filter @kura/web test`: `Test Files  7 passed (7)` / `Tests  41 passed (41)`.

Befund 1, Beweislauf `node tests/d2/prod-proof/run.mjs /tmp/prod-api /tmp/prod-worker` (Exit 0, „PROOF OK“; PORT 18080; `KURA_STORAGE_BACKEND=database`; `KURA_SECRET_KEY` frisch per `randomBytes`). Die Bäume entstanden aus `pnpm -r build`, `pnpm --filter @kura/api deploy --prod /tmp/prod-api` und `pnpm --filter @kura/worker deploy --prod /tmp/prod-worker`. Auszug (Zeilen gekürzt):

```
GET /healthz -> 200 {"status":"ok"}
OK   administrator setup -- HTTP 201
OK   Immich endpoint approved by the administrator -- HTTP 201
OK   Immich connection saved (needs KURA_SECRET_KEY in the API) -- HTTP 204
=== Worker 1: unmodified node apps/worker/dist/index.js (production defaults)
OK   worker logged "worker started"
adapter_status written by the worker: [direct-url available, gallery-dl BINARY_NOT_CONFIGURED, yt-dlp EGRESS_NOT_CONFIRMED]
download_runs row with production network defaults: {"state":"failed","error_code":"NETWORK_BLOCKED",...}
    {"level":"info","message":"worker started"}
    {"level":"info","message":"scheduler tick","reclaimed":{...},"generated":{"schedulesProcessed":0,"enqueued":0,...}}
    {"level":"error","message":"run failed","runId":"9721f0e5-...","code":"NETWORK_BLOCKED"}
OK   worker 1 stops on SIGTERM and logs "worker stopped" -- exit {"code":0,"signal":null}
=== Worker 2: same production tree through worker-launcher.mjs
    {"level":"info","message":"scheduler tick",...,"generated":{"schedulesProcessed":1,"enqueued":1,"coalesced":0},"retention":null}
    {"level":"info","message":"run finished","runId":"32e62818-...","result":"stored"}
download_runs: {"state":"stored","trigger_kind":"schedule","adapter_id":"direct-url","assets_stored":1,"error_code":null}
download_assets: {"state":"stored","sha256":"526e7cd2...","byte_size":"2072","handover_state":"verified","media_type":"image/jpeg",...}
OK   bytes sit in the PostgreSQL blob store (shared with the API) -- {"chunks":1,"bytes":2072}
OK   Immich received exactly the served bytes -- 1 asset(s)
OK   the API shows the run in the history (worker and API share the database) -- 2 run(s)
PROOF OK
```

Gezeigt wird damit: beide Prozesse starten aus den Produktionsbäumen (Layout wie im Image: `apps/api`, `apps/worker`, `migrations`, `apps/web/dist`), der Scheduler erzeugt den Lauf, der Worker führt ihn aus, die API sieht das Ergebnis. Der **unveränderte** `index.js` verweigert die Loopback-URL (`NETWORK_BLOCKED`): die Produktionsvorgaben sind nicht aufgeweicht. Für den Erfolgspfad startet `worker-launcher.mjs` dieselbe `Worker`-Klasse aus demselben Baum mit einer **testweise injizierten** Policy (Loopback nur für den lokalen Dateiserver, https wird auf HTTP umgelenkt, wie im M5-B-Fixture); das Launcher-Skript liegt unter `tests/d2/`, nicht im Image. Der Immich-Fake auf Loopback wird über die bestehende Admin-Freigabe (`/api/v1/admin/immich/endpoint-approvals`) erlaubt.

Befund 2, Tests, die ohne den Fix scheitern: `tests/d2/egress-barrier.test.ts` gegen den Stand ohne die Änderungen in `apps/` und `packages/` (per `git stash` geprüft): `Tests  12 failed | 4 passed (16)`. Mit dem Fix: 16 von 16 grün. Inhalt: Konfiguration (Standard `false`, nur `true` schaltet frei, andere Werte werfen); Katalog mit Fake-Programmen, die jeden Start protokollieren (ungesetzt oder `false` → Aufrufe = 0, auch kein `--version`, beide Werkzeuge `EGRESS_NOT_CONFIRMED`, nicht registriert; gesetzt → verfügbar, Aufrufe > 0); Fehlerabbildung (`failed`, nicht wiederholbar, deutscher Text); Pipeline auf echter PostgreSQL (Auftrag für YouTube und Pixiv scheitert mit `EGRESS_NOT_CONFIRMED`, Aufrufe = 0, nichts gespeichert; Direct-URL-Lauf funktioniert weiter; mit Bestätigung läuft derselbe Auftrag); API-Adapterübersicht und Quellenprüfung zeigen den Text; der Katalog ist die einzige Baustelle der CLI-Adapter. Die bestehenden CLI-Tests (`tests/adapters`, `tests/m5b`) laufen unverändert grün, die Pipeline-Tests mit der Bestätigung im Fixture. Der Beweislauf zeigt zusätzlich mit den echten Produktionsbäumen: Pfad und Hash für ein Fake-yt-dlp gesetzt, Bestätigung nicht gesetzt → Status `EGRESS_NOT_CONFIRMED`, `GET /api/v1/adapters` liefert „Externe Werkzeuge gesperrt: Egress-Schutz nicht bestätigt. …“, und die Datei, in die das Fake-Programm bei jedem Start schreibt, existiert nach beiden Worker-Läufen nicht.

Nicht geprüft (unbekannt):

- **Podman-Build** des Images und der Start der Container (nicht möglich in der Sandbox; Orchestrator führt das aus).
- Echtes Podman-Verhalten des Skripts: `podman run --no-healthcheck`, `podman inspect -f '{{.State.Status}}'`, `podman logs` mit dem Logformat, rootless Named Volume auf `/var/lib/kura/blobstore` (Besitzer wird aus dem Image übernommen — angenommen, nicht gesehen).
- Echte Programme yt-dlp und gallery-dl; Lauffähigkeit eines heruntergeladenen Binary im Debian-Image des Containers.
- Echter Browser, echter Immich.
- Echte Egress-Regeln (VLAN/nftables): gibt es nicht, Kura prüft sie nicht.

## Annahmen

- Der Beweislauf nutzt eine frische Scratch-Datenbank (`kura_d2_proof_*`, am Ende gelöscht) auf demselben Server statt `kura_dev`, damit `kura_dev` unberührt bleibt und die Migrationen aus dem leeren Zustand laufen. Rest wie in der Karte (127.0.0.1:5432, `kura_dev`-Zugang, PORT 18080).
- Direct-URL-Erfolgspfad nur mit testweiser Policy: Plan 05 §2 sieht die Admin-Freigaben nur für den Immich-Transfer vor („nicht für Download-URLs“), deshalb gibt es in Produktion keinen Weg, eine Loopback-URL per Freigabe zu erlauben. Die Karte erlaubte beide Wege.
- Mount von `kura-blobdata` in beide Container folgt der Karte wörtlich, obwohl der Worker das Volume nicht nutzt (siehe Zusammenfassung).
- Die Env-Datei wird vom Skript mit `sed` nach `KEY=value`-Zeilen gelesen (nicht als Shell gesourct), ohne Anführungszeichen; Pfade für `KURA_STORAGE_ROOT` und `KURA_TOOLS_HOST_DIR` ohne Leerzeichen (wird abgelehnt).
- Ist ein Werkzeug gar nicht konfiguriert, bleibt der Grund `BINARY_NOT_CONFIGURED` (nichts zu sperren); `EGRESS_NOT_CONFIRMED` erscheint, sobald Pfad und Hash gesetzt sind. Dadurch bleiben bestehende Tests und Meldungen unverändert.
- Ein ungültiger Wert für `KURA_EXTERNAL_TOOLS_EGRESS_CONFIRMED` (z. B. `yes`) bricht den Workerstart mit klarer Meldung ab (wie die anderen Schalter), statt still zu sperren. Das Deploy-Skript meldet das als „did not start“.
- `~/bin/kura-deploy.sh` auf der VM ist eine Kopie oder ein Link auf `deploy/kura-deploy.sh`; ob Kopie, ist unbekannt (siehe Betrieb).
- Die Werkzeuge liegen auf dem Host und werden per `KURA_TOOLS_HOST_DIR` eingebunden; das Image enthält weder Python noch ffmpeg.

## Risiken

- **Restrisiko der Egress-Sperre:** Die Werkzeuge laufen als Kindprozesse im Worker-Container. Der Worker braucht `kura-postgres` und die Immich-Server, also müssen genau diese Ziele auf Containerebene erlaubt sein, und die Werkzeuge erreichen sie damit auch. Eine saubere Trennung (Werkzeuge in eigenem Container/Netz) ist nicht Teil dieser Karte. Die Bestätigung per Variable ist eine Aussage des Betreibers; Kura kann sie nicht prüfen.
- **Speicher-Backend:** Bleibt `KURA_STORAGE_BACKEND` auf `filesystem`, sieht die API die Objekte des Workers nicht (und das Dateisystem-Backend verliert seinen Index beim Neustart). Für die heutigen Funktionen liest die API keine Worker-Objekte (nur der Immich-Testtransfer schreibt), der Schaden ist begrenzt, aber der Zustand ist irreführend. Empfehlung `database`.
- Beim Wechsel von `filesystem` auf `database` werden vorhandene Dateisystem-Objekte nicht migriert (auf dem Teststand voraussichtlich keine; unbekannt).
- Das Image wächst um den zweiten Produktionsbaum (lokal gemessen: API-Baum 22 MB, Worker-Baum 1,7 MB, Auslieferung der Layer unbekannt).
- Die Liveness-Prüfung gilt zum Zeitpunkt des Deployments; ein späterer Absturz wird von `--restart=always` aufgefangen, aber nicht gemeldet.
- `KURA_WORK_DIR` liegt im Container-Dateisystem (nicht persistent); Staging-Daten gehen beim Neuanlegen des Containers verloren (gewollt, der Worker räumt verwaiste Arbeitsverzeichnisse ohnehin auf). Platz im Podman-Speicher: größte Datei zweimal.
- Verlaufseinträge, die ein getöteter Worker offen ließ, schließt der Nachfolger (M5-B-Fix, unverändert).

## Offene Fragen

- [Iroha] Der Mount von `kura-blobdata` in den Worker kostet eine Zeile und erfüllt die Karte; Umbauen des Workers auf das Dateisystem-Backend wäre der teure Weg und gehört nicht in diesen Umfang.
- [Yui] Ein Volume im Worker, das er nie benutzt, suggeriert gemeinsamen Speicher, den es nicht gibt. Würde der Coordinator das Dateisystem-Backend auf der VM lieber ablehnen (Skript bricht ab, wenn `KURA_STORAGE_BACKEND` nicht `database` ist) oder im Worker unterstützen (Index auf Platte statt im Speicher, Änderung in `packages/blobstore`, hier verboten)? Beides ist eine Entscheidung für den Coordinator.
- Soll die Trennung der Werkzeuge vom Worker (eigener Container oder Netz, damit die Egress-Regeln auch `kura-postgres` und Immich sperren können) ein eigener Arbeitsauftrag werden?
- Welcher Wert steht heute in `~/.config/kura/kura.env` für `KURA_STORAGE_BACKEND` und `KURA_SECRET_KEY`? Unbekannt (kein VM-Zugriff).
- Ist `~/bin/kura-deploy.sh` ein Link auf das Repo-Skript oder eine Kopie? Unbekannt.

## Nächster Schritt

Review durch Reviewer, danach Orchestrator: Podman-Build und Container-Deployment auf der VM nach dem Abschnitt unten, anschließend Verifier-Urteil. Entscheidung des Coordinators zum Speicher-Backend (siehe Offene Fragen).

## Betrieb auf der VM (Schritte für den Orchestrator)

Voraussetzung: Ref `lane/worker` (oder der gemergte Stand) liegt in `origin`; der Orchestrator pusht, nicht der Agent.

1. Skript aktualisieren: Das neue `deploy/kura-deploy.sh` muss das alte `~/bin/kura-deploy.sh` ersetzen, falls dieses eine Kopie ist (z. B. `install -m 755 ~/work/Kura/deploy/kura-deploy.sh ~/bin/kura-deploy.sh` nach dem Checkout des Stands). Das Skript holt zwar den Ref selbst, führt aber die alte Fassung aus, bis sie ersetzt ist.
2. Env-Datei `~/.config/kura/kura.env` (Modus 600) prüfen und ergänzen, ohne Geheimnisse in Logs oder Commits zu schreiben:
   - `KURA_STORAGE_BACKEND=database` (Empfehlung; sonst gilt der Dateisystem-Hinweis oben).
   - `KURA_SECRET_KEY=<base64, 32 Byte>`: falls noch nicht vorhanden mit `openssl rand -base64 32` erzeugen und **nur einmal** eintragen (beide Container lesen dieselbe Datei). Ohne Schlüssel kann die API keinen Immich-Schlüssel speichern und der Worker keinen lesen.
   - `DATABASE_URL` bleibt wie bisher (Host `kura-postgres`).
   - `KURA_EXTERNAL_TOOLS_EGRESS_CONFIRMED` **nicht** setzen (oder `false`), solange keine Egress-Regeln für `kura-worker` existieren. Externe Werkzeuge sind dann gesperrt, Direct-URL-Downloads laufen.
   - Optional (nur wenn Werkzeuge getestet werden sollen und die Regeln stehen): `KURA_TOOLS_HOST_DIR`, `KURA_YTDLP_PATH`/`KURA_YTDLP_SHA256`, `KURA_GALLERYDL_PATH`/`KURA_GALLERYDL_SHA256`.
3. Deployment: `~/bin/kura-deploy.sh lane/worker` (bzw. der gemergte Ref). Erwartet: Image-Build, `kura-app` neu, `/healthz` erreichbar, `kura-worker` neu, Ausgabe `kura <commit> is up: http://<ip>:8080 (api and worker running)`. Bei Fehlern gibt das Skript die letzten 40 Logzeilen des betroffenen Containers aus und endet mit Exit 1.
4. Kontrolle:
   - `podman ps --filter name=kura-`: `kura-postgres`, `kura-app`, `kura-worker` sind `Up`; `kura-worker` hat keine Portzuordnung.
   - `podman logs --tail 20 kura-worker`: Zeile `"message":"worker started"`, regelmäßig `scheduler tick`, keine `"level":"error"`-Zeilen. Ist ein Werkzeugpfad samt Hash gesetzt und die Bestätigung nicht, steht einmal `external tools blocked: egress protection not confirmed …`; ohne gesetzten Werkzeugpfad erscheint diese Zeile nicht.
   - `curl -fsS http://127.0.0.1:8080/healthz` → `{"status":"ok"}`.
   - Weboberfläche `http://<vm-ip>:8080/`: Immich verbinden, Quelle mit https-Direct-URL anlegen, „Jetzt ausführen“; im Verlauf Zustand „stored“ und Immich-Übergabe. Das ist der Nachweis für REQ-DL-003 auf dem Teststand und wurde in der Sandbox nicht gegen das Image gelaufen.
   - Nur mit gesetztem Werkzeugpfad: Unter „Unterstützte Quellen und Adapter“ steht bei yt-dlp/gallery-dl „Externe Werkzeuge gesperrt: Egress-Schutz nicht bestätigt“.
5. Freigabe der externen Werkzeuge (später, nicht Teil dieses Auftrags): erst Egress-Regeln für `kura-worker` bereitstellen und von innen testen (`docs/vm-setup.md`, „Egress barrier“), dann `KURA_EXTERNAL_TOOLS_EGRESS_CONFIRMED=true` eintragen und `~/bin/kura-deploy.sh <ref>` erneut ausführen (ein bloßes `podman restart` liest die Env-Datei nicht neu).
6. Rückweg: `~/bin/kura-deploy.sh <vorheriger-ref>` (altes Skript wiederherstellen, falls ersetzt); nur den Worker entfernen: `podman rm -f kura-worker`. Das Volume `kura-blobdata` (nur bei Dateisystem-Backend angelegt) und `kura-pgdata` bleiben bestehen und werden von keinem Schritt gelöscht.
7. Im Bericht des Orchestrators festhalten: „nicht geprüft: Podman-Build“ gilt bis zu Schritt 3; die Punkte unter „Nicht geprüft“ oben werden dabei mit abgedeckt oder bleiben offen.
