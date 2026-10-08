# M4B-implementer

Aufgabe: M4-B Zeitpläne in API, Weboberfläche und Worker (Admin-Limits, Retention). Kanban t_99cc18dc. REQ-DL-002 (req_hash 5d6398de6dbb5063), REQ-DL-003 (b83be904af3eded5), REQ-DL-001 (9fd10d9e84b53fb8). Worktree /work/wt/m4, Branch lane/scheduler, Basis b301cc0 (M4-A).

Status: fertig (nur lokal committet, nichts gepusht, Baum sauber). Braucht Review. Zwei Änderungen außerhalb meines Besitzbereichs sind nötig bzw. gemeldet, siehe "Einbindung in die Auslieferung" und "Annahmen" Nr. 14.

## Artefakte

Migrationen (neu, nur additiv):
- migrations/0043_subscription_targets.sql: `subscriptions.platform_hint`, `subscriptions.target_state` ('unvalidated' | 'valid' | 'invalid', Standard 'unvalidated')
- migrations/0044_runtime_policy.sql: `runtime_policy_versions` (unveränderliche Versionen der Admin-Limits, Primärschlüssel = Version)

packages/scheduler (Änderungen, alle aufgeführt):
- subscriptions.ts: `SubscriptionRecord` um `platformHint`/`targetState`; neu `listSubscriptions`, `updateSubscription` (setzt `target_state` zurück, wenn sich das Ziel ändert), `deleteSubscription` (mit `SubscriptionBusyError`), `listSchedules`, `deleteSchedule`
- job-queue.ts: neu `JobQueue.listRecentRuns(userId, subscriptionId, limit)` (neueste zuerst); `listRuns` unverändert
- runtime-policy.ts (neu): `RuntimePolicy`, `parseRuntimePolicy` (Validierung), `RuntimePolicyRepository` (`current`, `activate` mit Versionsprüfung), `toQueueLimits`
- retention.ts (neu): `RetentionCleaner`
- index.ts: zwei Re-Exports. package.json/tsconfig des Pakets unverändert (Exportmuster dist bleibt).

apps/api/src:
- schedule-routes.ts (neu): Abonnements, Zeitpläne, Vorschau, Laufverlauf
- runtime-policy-routes.ts (neu): `GET/PUT /api/v1/admin/runtime-policy`
- route-helpers.ts (neu): `adminOnly`, `responseError`, gemeinsame Typen
- app.ts: Registrierung der beiden Routenmodule; `pool.on('error', …)` (siehe Annahme 14)
- immich-routes.ts: lokales `requireAdmin` durch `adminOnly(requireSession)` ersetzt (9 Zeilen weniger, Verhalten gleich, Tests grün)
- package.json: Abhängigkeit `@kura/scheduler` (workspace)

apps/web/src: Subscriptions.tsx, ScheduleForm.tsx, AdminLimits.tsx, cron-presets.ts, schedule-format.ts (alle neu); api.ts (Typen und Aufrufe angehängt, `ApiError.problems`); App.tsx (zwei Navigationsknöpfe, zwei Ansichten). Tests: Subscriptions.test.tsx, AdminLimits.test.tsx, cron-presets.test.ts.

apps/worker/src: config.ts, scheduler-loop.ts, worker.ts (neu); index.ts (Einstieg, Signalbehandlung). package.json: `@kura/scheduler`, `pg` (8.23.1, gleiche Version wie API und Root, MIT).

Sonstiges: .env.example (zwei Worker-Variablen, auskommentiert), pnpm-lock.yaml (Folge der Workspace-Abhängigkeiten, 9 Zeilen).

Tests (neu, tests/m4b, echte PostgreSQL): scheduler-extensions.test.ts (33), schedules-api.test.ts (34), runtime-policy-api.test.ts (13), worker-loop.test.ts (10), api-fixture.ts (Hilfsdatei). Dazu 17 Web-Tests (siehe Prüfung).

Bericht: .claude/team/reports/M4B-implementer.md

## Zusammenfassung

1. API (angemeldet, mandantengetrennt; jede Abfrage läuft über `userId` der Sitzung, fremde Objekte liefern 404 wie unbekannte):
   - `GET/POST /api/v1/subscriptions`, `GET/PATCH/DELETE /api/v1/subscriptions/:id`, `POST …/pause`, `POST …/resume`, `GET …/runs?limit=` (Standard 20, 1 bis 100)
   - `GET/POST /api/v1/schedules`, `PATCH/DELETE /api/v1/schedules/:id`, `POST /api/v1/schedules/preview` (1 bis 20 Einträge, Standard 5)
   - Ziel-URL wird getrennt und unverändert gespeichert (nur Leerraum an den Rändern entfernt, höchstens 2048 Zeichen, keine Steuerzeichen), Zustand `unvalidated`, Feld `platformHint`. Keine URL-Prüfung (kommt mit M5-B).
   - Regel im Zeitplan: `rule` = `cron` (Ausdruck, Zeitzone, `gapPolicy` skip | run_after_gap, Standard skip) | `interval` | `once`. Ungültige Eingaben: 400 (`VALIDATION_ERROR` oder `INVALID_SCHEDULE`). Löschen eines Abonnements mit laufendem Job: 409 `SUBSCRIPTION_BUSY`.
   - Vorschau liefert je Eintrag Zeitpunkt, lokale Planzeit, Zeitzone, UTC-Versatz (`+02:00`) und Status (`regular`, `overlap_first`, `gap_shifted`, `gap_skipped`, `coalesced`). Nicht laufende Termine (`gap_skipped`, `coalesced`) haben `scheduledForUtc: null`.
   - Audit-Einträge für Anlegen, Ändern, Löschen, Pausieren, Fortsetzen (Ziel-URLs stehen nicht im Audit oder im Request-Log; getestet).
2. Admin-Limits (Plan 04 §10, Plan 07 `GET/PUT /admin/runtime-policy`): nur Administratoren (403 sonst, getestet für Lesen und Schreiben). Versioniert, atomar aktiviert, `expectedVersion` Pflicht, Versionskonflikt 409 mit `currentVersion`, Gültigkeitsfehler 400 mit allen Einzelproblemen. Durchgesetzt werden heute `maxConcurrentGlobal`, `maxConcurrentPerUser`, `perUser` (über `toQueueLimits` und `JobQueue.claim`, per Test belegt) und die Aufbewahrung. Alle übrigen Werte des Plans (`maxConcurrentPerSourceAccount`, Tagesbudgets, Bandbreite, `perAdapter`, Slots) werden gespeichert, geprüft und versioniert, aber nichts liest sie. Die API meldet das ehrlich in `enforced`, die Oberfläche schreibt "Wird gespeichert, aber noch nicht durchgesetzt" daneben.
3. Weboberfläche (deutsch, Stil der bestehenden Seiten): Seite "Abonnements" (Liste, Anlegen, Bearbeiten, Pausieren/Fortsetzen, Löschen mit Rückfrage, je Abonnement Zeitpläne und letzte Läufe; Zeitplanformular mit Vorlagen täglich / Montag bis Freitag / wöchentlich / stündlich / festes Intervall / einmalig / eigener Cron-Ausdruck, Zeitzonenauswahl mit Browserzone als Vorgabe, Lückenregel, Startverzögerung, Vorschau der nächsten fünf Läufe mit Hinweis bei Zeitumstellung) und Admin-Seite "Limits" (nur sichtbar für Administratoren; Ausnahmen je Benutzer, Versionskonflikt mit "Aktuelle Version laden").
4. Worker: `SchedulerLoop` (Tick alle 15 s, einstellbar): abgelaufene Leases zurückholen, fällige Läufe erzeugen (Durchläufe wiederholen, solange einer voll war, höchstens 20), Aufbewahrung höchstens einmal je Stunde. Jeder Schritt isoliert: ein Fehler (z. B. Tabelle fehlt) wird ohne Stack und ohne Verbindungsdaten protokolliert, die anderen Schritte laufen weiter; Aufbewahrung wird nach Fehler im nächsten Tick wiederholt. Uhr (`Clock`) und Wartefunktion (`Wait`) sind injizierbar; `stop()` lässt den laufenden Tick zu Ende laufen, ist idempotent, danach ist ein erneutes `start()` möglich. `Worker` besitzt den Pool und schließt ihn beim Stoppen. Der Worker führt keine Downloads aus.
5. Aufbewahrung (Risiko R-D aus M4-A): `RetentionCleaner.run(finishedRunDays)`, Standard 90 Tage, einstellbar auf der Limits-Seite (1 bis 3650). Gelöscht werden nur beendete Läufe (succeeded, failed, cancelled) mit `finished_at` vor der Grenze und Terminaufzeichnungen mit `scheduled_for` vor der Grenze, deren Lauf (falls vorhanden) beendet ist. Wartende, laufende und neue Daten bleiben. Reihenfolge Termine vor Läufen (Fremdschlüssel), in Stapeln zu 1000. Doppelte Läufe entstehen dadurch nicht, weil der Zeitplan-Cursor `generated_through` nur vorwärts läuft.

## Prüfung

Ausgeführt (Umgebung: DATABASE_URL auf die Entwicklungs-PostgreSQL 127.0.0.1:5432, Node v22, echte PostgreSQL, Testdatenbanken je Datei):
- Vorher (Stand b301cc0, eigener Lauf): `corepack pnpm check` Exit 0, `Test Files 17 passed (17)`, `Tests 217 passed | 1 skipped (218)`.
- Nachher (HEAD 0a7dfdf plus dieser Bericht): `corepack pnpm check` (typecheck, lint, test, build) Exit 0, literale Ausgabe der Testzeilen: `Test Files  21 passed (21)`, `Tests  307 passed | 1 skipped (308)`. Differenz +90 Tests, +4 Dateien, alle in tests/m4b (33 + 34 + 13 + 10). Keine "Errors"-Zeile.
- Web-Tests laufen NICHT im Prüftor (Root-vitest sammelt nur `tests/**/*.test.ts`; das war schon vorher so). Einzeln: `cd apps/web && npx vitest run`: vorher 14 Tests in 2 Dateien, jetzt `Test Files 5 passed (5)`, `Tests 31 passed (31)` (+17: 9 Abonnements, 4 Limits, 4 Vorlagen). `tsc --noEmit` für apps/web grün. Eine Negativprobe: Text der Lückenmeldung kurz verändert, Test "previews the next runs…" lief rot, Änderung zurückgenommen.
- `corepack pnpm audit --audit-level=high`: "2 vulnerabilities found, Severity: 1 low | 1 moderate", keine hohen (gleicher Stand wie M4-A). Neue Abhängigkeiten: keine neuen Pakete (`pg` 8.23.1 und der Workspace-Verweis waren schon im Lockfile).
- Echter Prozesslauf (nicht nur Test): API (`node apps/api/dist/index.js`) und Worker (mit `tsc --outDir dist` gebaut, `node dist/index.js`, Tick 2 s) als getrennte Prozesse gegen eine frische Datenbank. Per curl: Ersteinrichtung, Abonnement, Intervallzeitplan (60 s), Vorschau, danach legte der Worker 0,5 s nach Fälligkeit genau einen Lauf `queued` an (`/subscriptions/:id/runs`), der Web-Bundle enthält "Abonnements". SIGTERM beendete den Worker mit "worker stopped". Zusätzlich `pnpm deploy --prod` für API und Worker in ein Temp-Verzeichnis: `import('@kura/scheduler')` (38 Exporte) und der Worker laufen unter reinem Node mit den kopierten dist-Dateien. Temp-Verzeichnisse und Testdatenbank danach gelöscht.
- Stabilität: Beim Hochfahren der Last traten zufällig "Unhandled Errors: terminating connection due to administrator command (57P01)" auf, auch in alten Dateien (tests/scheduler/queue, occurrences, api-oidc, wiring). Ursache: `database.cleanup()` beendet Backends direkt nach `pool.end()`; ein noch schließender Leerlauf-Client meldet den Fehler am Pool, ohne `error`-Listener ist das ein unbehandeltes Ereignis. Behoben (Annahme 14). Danach 11 von 12 vollständigen vitest-Läufen sauber; der zwölfte scheiterte an meinem Verbindungszähl-Test im Worker-Test (Server räumt Backends einen Moment später ab), mit `vi.waitFor` behoben, danach 6 von 6 Läufen der Datei grün und ein vollständiges `pnpm check` grün. Ein weiterer vollständiger Mehrfachlauf nach dem letzten Fix wurde nicht gemacht.

Nicht geprüft:
- Weboberfläche in einem echten Browser: das Browserwerkzeug dieser Umgebung blockiert private Adressen (`Blocked: URL targets a private or internal address`), die Seiten wurden nur in jsdom getestet. Optik, Tastaturbedienung und Layout sind unbekannt. Der Orchestrator sollte sie auf dem Prüfstand ansehen.
- Containerimage (`podman` ist in der Sandbox nicht vorhanden): Build und Start des Worker-Containers sind unbekannt.
- Mehrere Worker-Prozesse gleichzeitig (nur mehrere Loop-Instanzen in einem Prozess über einen Pool, 4 Instanzen, 10 Zeitpläne, keine Duplikate).
- Last (100 Benutzer, große `job_runs`-Bestände), Dauer der Aufbewahrung bei Millionen Zeilen.
- Zeitzonenbehandlung der Oberfläche in anderen Browsern/Zeitzonen (die Vorschau nutzt `Intl` des Browsers).

## Annahmen

1. Plan 07 nennt `POST /schedules/preview` ohne Körperformat; gewählt: `{ rule, count }`, zustandslos (keine gespeicherten Daten), aber nur mit Sitzung.
2. Zeitplan-Regel in der API als `rule`-Objekt (so wie in der Datenbank), nicht flach. Intervalle ohne `anchorUtc` bekommen "jetzt" als Anker; beim Bearbeiten behält die Oberfläche den Anker.
3. Ziel-URL: Pflicht, getrimmt, 2048 Zeichen, Steuerzeichen abgelehnt, sonst keine Prüfung. Plattformhinweis: Muster `[a-z0-9][a-z0-9_-]{0,63}`, die Oberfläche bietet die Plan-Kandidaten als Liste an (YouTube, Instagram, Patreon, Pixiv, Pornhub, direkte URL, Webseite) oder "Keine Angabe". Ändert sich das Ziel, springt `target_state` auf `unvalidated` zurück.
4. Löschen eines Abonnements entfernt auch Zeitpläne, Terminaufzeichnungen und Laufverlauf (nur Planungsdaten; Medien gibt es in M4 nicht). Verweigert (409), solange ein Lauf `leased` ist. Löschen eines Zeitplans behält die Läufe als Verlauf ohne Zeitplanbezug.
5. Es gibt keine Route "Jetzt ausführen" (nicht in der Kartenliste; M4-A Frage 2 zu pausierten Abonnements ist unbeantwortet). `JobQueue.enqueueManual` existiert, ist nur nicht angebunden.
6. Admin-Konfiguration: Dokument = Plan-Vertrag aus Plan 04 §10 plus `retention.finishedRunDays`. Fehlende Werte erben den Standard (Plan: "Fehlende Werte erben die übergeordnete Policy"), unbekannte Schlüssel werden abgelehnt (Tippfehler sollen kein Limit stillschweigend leer lassen). Formen von `perUser` und `perAdapter`: `{ <id>: { maxConcurrent: Zahl | null } }` (der Plan nennt nur `{}`; Form von mir festgelegt, `perUser` passt zu `QueueLimits`). Schlüssel: Benutzer-UUID in Kleinbuchstaben (muss existieren), Adapter-ID `[a-z0-9][a-z0-9_-]{0,63}`.
7. Wertebereiche (Plan 04 nennt keine): Parallelität 0 bis 10 000 oder null, Tageslimit Downloads 0 bis 10^9, Bytes und Bandbreite 0 bis 2^53-1, Slots 0 bis 1000 (nicht null), Aufbewahrung 1 bis 3650 Tage. Höchstens 1000 Einträge je Ausnahmeliste.
8. Fairness: Der Plan definiert keine einstellbaren Fairness-Werte ("Fairness verteilt freie Slots auf wartende Benutzer"); es gibt deshalb keine. Die feste Round-Robin-Regel aus M4-A bleibt.
9. Das Lesen der Limits ist nur für Administratoren erlaubt; normale Benutzer sehen ihre wirksame Grenze nicht (Plan 07 verlangt nur die Adminseite).
10. Aufbewahrung: Termine nach `scheduled_for`, Läufe nach `finished_at`, jeweils gegen die Uhr des Aufrufers (`Clock`), nicht gegen `created_at` (das die Datenbank mit `now()` setzt und das unter Testuhr nicht mitläuft). Die erste Bereinigung läuft im ersten Tick nach dem Start, danach höchstens einmal je `WORKER_RETENTION_INTERVAL_SECONDS` (Standard 3600).
11. Worker: Tick 15 s (`WORKER_TICK_SECONDS`, 1 bis 3600), Stapel 100 Zeitpläne je Durchlauf, höchstens 20 Durchläufe je Tick. Der Worker führt keine Migrationen aus; startet er vor der API, protokolliert er je Tick drei Fehler ("relation does not exist"), bis die API migriert hat.
12. Einmal-Zeitpläne ("Einmalig") nimmt die Oberfläche in UTC entgegen (Feldname "Zeitpunkt (UTC)"), um keine eigene Umrechnung lokaler Zeiten zu bauen. Nach Erschöpfen bleibt ein `once`-Zeitplan wie in M4-A `enabled` mit `next_due_at = NULL` (Frage 5 aus M4-A unverändert offen).
13. Die API-Tests laufen mit einer festen Testuhr (2026-06-01), weil Sitzungen die gleiche Uhr benutzen; sie bewegen sie deshalb höchstens um wenige Stunden (Sitzung: Leerlauf 2 h).
14. Zwei Änderungen außerhalb der genannten Dateiliste, beide klein und begründet: (a) `tests/helpers/database.ts`: ein `pool.on('error', …)` mit Kommentar (Ursache siehe Prüfung "Stabilität"; ohne die Zeile wird `pnpm check` bei mehr Testlast zufällig rot). (b) `apps/api/src/app.ts`: `pool.on('error', …)` mit Log. Das ist zugleich eine echte Betriebsverbesserung (ein Neustart der Datenbank hätte sonst die API beendet); `apps/api/src/index.ts` erzeugt den Pool weiter ohne eigenen Listener, weil `buildApp` ihn setzt. `pnpm-lock.yaml` ist durch die neuen Workspace-Abhängigkeiten geändert (nicht in der Liste, aber zwangsläufig).
15. Gelesen, nicht gelaufen: Plan 07 außerhalb der Zeilen zu Abonnements, Zeitplänen und Laufzeitrichtlinie; Plan 04 §9 (Jitter) ist durch M4-A umgesetzt und wurde hier nur durchgereicht (`jitterMaxSeconds`, 0 bis 3600).

## Risiken

- R-G: Es gibt keine Obergrenze für Abonnements und Zeitpläne je Benutzer (kein Kontingent im Plan für M4). Ein Benutzer kann viele anlegen; der Generator verarbeitet höchstens 100 je Durchlauf, holt aber auf.
- R-H: `POST /schedules/preview` rechnet auf Anforderung (höchstens 20 Treffer, Cron-Suche mit Obergrenze von neun Jahren je Treffer). Für eine schwer erfüllbare Regel (zum Beispiel 29. Februar) kostet das einige Millisekunden CPU; ein Anmeldezwang schützt, ein Ratenlimit gibt es nicht.
- R-I: Die Limits `perAdapter`, Slots, Tagesbudgets, Bandbreite sind nur Speicher. Ein Admin könnte sie für wirksam halten. Gegenmaßnahme: Hinweis in der Oberfläche und `enforced` in der API; bleibt bis M5-B/M6 so.
- R-J: Die Aufbewahrung löscht Laufverlauf (auch `last_error`) nach 90 Tagen unwiderruflich. Wer längere Historie braucht, muss den Wert hochsetzen; die Standardgrenze ist eine Annahme.
- R-K: Ein mitten im Tick beendeter Worker (SIGKILL) hinterlässt nichts Halbfertiges (jeder Schritt ist eine Transaktion), eine abgelaufene Lease holt der nächste Tick zurück. Ein Tick, der länger als das Intervall dauert, verzögert den nächsten, überlappt aber nie.
- R-L: Fehler im Betrieb ohne migrierte Datenbank erzeugen drei Logzeilen je Tick (Rauschen, kein Absturz).
- R-M: Die API-Tests dauern wegen scrypt je Benutzer (etwa 30 s für `schedules-api.test.ts`); das Prüftor ist dadurch von etwa 22 s auf etwa 35 s Testzeit gewachsen.
- R-N: `apps/web/src/App.tsx` besteht aus sehr langen Zeilen und ist ein Konfliktherd für weitere Oberflächenarbeiten (M5/M6); neue Seiten liegen deshalb in eigenen Dateien, in `App.tsx` wurden nur vier Stellen berührt.

## Offene Fragen

1. [Iroha] Soll "Jetzt ausführen" (Plan 04 §5 "sofortiger Start") schon in M4 angeboten werden? [Yui] Die Bibliothek verweigert es bei pausierten Abonnements; ich habe nichts angeboten, bis das bestätigt ist (M4-A Frage 2).
2. Soll ein erschöpfter `once`-Zeitplan automatisch `enabled = false` werden (M4-A Frage 5)? Heute bleibt er an, ohne nächsten Termin.
3. Bedeutung der Slots (`downloadSlots`, `transferSlots`, `lifecycleReservedSlots`) und der Form von `perAdapter`/Quellkonto-Budgets: der Plan nennt nur Startwerte. unbekannt, wie M5-B/M6 sie lesen sollen; die gewählte Form steht in Annahme 6.
4. Plan 04 §10 und Plan 07, hier NICHT umgesetzt: Anzeige, ob ein Auftrag auf Kapazität, Policy, Quelllimit oder Kontofreigabe wartet; Slotbelegung und Warteschlangen in der Admin-Seite ("Ausführung"); Kill-Switch je Adapterversion; 429-Kontodrosselung, 401/403 → Pausieren und Anmeldung anfordern; kontrollierter Abbruch eines laufenden Jobs bei Pause (R-F aus M4-A); UTC-Tagesabrechnung der Budgets; Konfiguration per Dienstkonfiguration/CLI-Reload (nur die Admin-API existiert). Alle gehören zu M5-B/M6.
5. Soll die wirksame Grenze auch normalen Benutzern angezeigt werden (Annahme 9)?

## Einbindung in die Auslieferung (Änderungen für den Orchestrator, nichts davon in deploy/** oder tsconfig*.json von mir geändert)

Der Worker braucht einen eigenen Prozess; das heutige Image startet nur die API. Genau nötig:
1. `apps/worker/tsconfig.json`: `"outDir": "dist"` in `compilerOptions` ergänzen. Ohne diese Zeile schreibt `tsc -b` des Workers nach `<repo>/dist` (der `outDir` der `tsconfig.base.json` gilt relativ zur Basisdatei; schon in D1 aufgefallen), `node dist/index.js` in `apps/worker` findet nichts. Mit der Zeile (per `tsc --outDir dist` nachgestellt) läuft der Worker unter reinem Node.
2. `deploy/Containerfile`, Build-Stufe: hinter dem API-Deploy `&& pnpm --filter @kura/worker deploy --prod /production-worker` (am Ende der bestehenden `RUN`-Zeile), Laufzeit-Stufe: `COPY --from=build --chown=kura:kura /production-worker ./apps/worker`. Das Image bleibt eins; `pnpm deploy --prod` für den Worker funktioniert (geprüft ohne Container).
3. `deploy/kura-deploy.sh`: nach dem Start von `kura-app` ein zweiter Container aus demselben Image, ohne Port: `podman rm -f kura-worker …; podman run -d --name kura-worker --network kura-net --restart=always --env-file "$ENV_FILE" "localhost/kura:$COMMIT" node apps/worker/dist/index.js`. Er benötigt nur `DATABASE_URL` (steht in `kura.env`), optional `WORKER_TICK_SECONDS` und `WORKER_RETENTION_INTERVAL_SECONDS`. Die `HEALTHCHECK`-Anweisung des Images (Port 8080) trifft den Worker nicht zu; Podman ignoriert sie im OCI-Format ohnehin (D-016). Reihenfolge: API zuerst starten (führt die Migrationen aus).
4. `deploy/README.md`: eine Zeile zum Worker.
Ob das Image so baut, ist unbekannt (kein Podman in der Sandbox). Alternative ohne Containeränderung: den `SchedulerLoop` im API-Prozess starten (nicht gebaut, weil die Karte einen Worker verlangt).

## Einbindung für M5-B (Worker holt und beendet Jobs über die Queue)

Der Scheduler-Worker aus dieser Karte erzeugt Läufe und holt abgelaufene Leases zurück (`reclaimExpiredLeases` jeden Tick); der Download-Worker muss das nicht selbst tun. M5-B ergänzt in `apps/worker` einen Ausführungsteil, der nur die Queue benutzt:
1. `const queue = new JobQueue(pool, { maxAttempts? })`; Grenzen je `claim` frisch aus der Policy: `const limits = toQueueLimits((await new RuntimePolicyRepository(pool).current()).policy)` (eine kurze Zwischenspeicherung von einigen Sekunden ist unkritisch; eine Absenkung wirkt nur auf neue Starts).
2. `const lease = await queue.claim({ workerId, leaseSeconds, limits })`; `null` heißt: nichts startberechtigt (leer, pausiert, Limit erreicht, Fairness). `lease.configSnapshot.sourceRef` ist die gespeicherte Ziel-URL zum Zeitpunkt der Anlage des Laufs, `lease.userId` der Eigentümer, `lease.leaseGeneration` das Fencing-Token (für result.json).
3. Während der Arbeit `queue.heartbeat(lease, leaseSeconds)` höchstens alle `leaseSeconds / 3`. Abschluss mit `queue.complete(lease)` oder `queue.fail(lease, { error, retryable, retryAfterSeconds })` (Fehlertext bereinigt, höchstens 2000 Zeichen; 429 → `retryAfterSeconds`). `LeaseLostError` bei jedem dieser Aufrufe heißt: sofort abbrechen, nichts übernehmen.
4. Vorgesehene Felder: `subscriptions.source_ref` (Ziel-URL), `subscriptions.platform_hint`, `subscriptions.target_state`. Eine Adapterprüfung setzt `target_state` auf `valid`/`invalid`; dafür gibt es noch keine Repository-Methode (`updateSubscription` setzt auf `unvalidated` zurück, wenn sich die URL ändert). M5-B ergänzt dort eine kleine `setTargetState`-Methode oder prüft beim Anlegen in der API.
5. Noch ohne Durchsetzung (M5-B/M6 entscheiden): Slots, Quellkonto-Limit, Tagesbudgets, Bandbreite, `perAdapter` (stehen in `RuntimePolicy`).
6. Wiederholungen, Backoff und Lease-Rückgewinnung sind in `JobQueue` fertig (M4-A, unverändert).

## Rückweg

Code: `git revert` der sechs Commits d9dee71, dd453ef, 79548e9, 296ee54, fcbd76f, 0a7dfdf und des Berichts-Commits (Reihenfolge von hinten). Datenbank auf einer bereits migrierten Instanz (nur beschrieben, nicht ausgeführt, löscht Daten): `DROP TABLE runtime_policy_versions; ALTER TABLE subscriptions DROP COLUMN platform_hint, DROP COLUMN target_state; DELETE FROM schema_migrations WHERE version IN ('0043_subscription_targets','0044_runtime_policy');`. Die Migrationen sind additiv, ein Zurückrollen des Codes ohne Datenbankänderung ist verträglich (neue Spalten haben Standardwerte, die alte Version ignoriert sie).

## Nächster Schritt

Review. Danach Entscheidung des Orchestrators zu den vier Auslieferungsänderungen (tsconfig des Workers, Containerfile, Deploy-Skript, README), Sichtprüfung der Oberfläche auf dem Prüfstand (Abonnements, Limits) und Antwort auf die Fragen 1 bis 3. Dann M5-B (Adapter und Ausführung) auf Basis der Einbindung oben.
