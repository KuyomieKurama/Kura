# M4A-implementer

Aufgabe: M4-A Zeitplan-Kern (packages/scheduler, Queue mit Leases, Migrationen 0040-0042). REQ-DL-002 (req_hash 5d6398de6dbb5063), REQ-DL-003 (b83be904af3eded5), REQ-DL-001 (9fd10d9e84b53fb8). Worktree /work/wt/m4, Branch lane/scheduler (Basis main = m3 + D1).

Status: fertig (nur lokal committet, nichts gepusht). Braucht Review. Ein Widerspruch zwischen Karte und Plan (DST-Lücke) ist als Entscheidung des Orchestrators offen, siehe "Offene Fragen" Nr. 1.

## Artefakte

Code (packages/scheduler/src, neu bis auf index.ts):
- clock.ts: `Clock`, `systemClock`, `ManualClock` (kein echtes Schlafen in Tests)
- timezone.ts: IANA-Prüfung, UTC-Offset, Auflösung einer lokalen Zeit zu Instant / Lücke / Überlappung (nur Intl, keine Abhängigkeit)
- cron.ts: Parser für fünffeldrige Cron-Ausdrücke
- rules.ts: `ScheduleRule` (cron | interval | once), `nextDue`, `previewSchedule`, `candidatesAfter`, DST-Regeln
- db.ts: `inTransaction`, `NotFoundError`
- subscriptions.ts: `SubscriptionRepository` (Abonnements, Zeitpläne, Pause/Fortsetzen, Versionierung)
- generator.ts: `OccurrenceGenerator` (dauerhafte Erzeugung logischer Termine)
- job-queue.ts: `JobQueue` (enqueueManual, claim, heartbeat, complete, fail, reclaimExpiredLeases), `QueueLimits`, `RetryPolicy`, `retryDelaySeconds`
- index.ts: Re-Exports. package.json und tsconfig.json des Pakets unverändert (Exportmuster types/development -> src, default -> dist, Build-Skript waren schon vorhanden).

Migrationen (neu, bestehende unverändert):
- migrations/0040_scheduler_subscriptions.sql: `subscriptions`, `schedules`
- migrations/0041_scheduler_job_runs.sql: `job_runs` (Queue/Outbox), `scheduler_user_state`, Sequenz `scheduler_claim_no_seq`
- migrations/0042_scheduler_occurrences.sql: `schedule_occurrences`

Tests (tests/scheduler, 82 neue Tests): rules.test.ts (43), occurrences.test.ts (17), queue.test.ts (22), fixture.ts (Hilfsdatei).

Bericht: .claude/team/reports/M4A-implementer.md

Neue Abhängigkeiten: keine (kein Cron-Paket; `pg` wird wie in den anderen Paketen nur als Typ aus der Root-Abhängigkeit importiert). Dadurch keine Änderung an package.json/pnpm-lock.yaml. Lizenzfrage entfällt.

## Zusammenfassung

1. Zeitplanregeln mit expliziter IANA-Zeitzone. `cron` (fünf Felder: Listen, Bereiche, Schritte, Monats-/Wochentagsnamen; dom/dow nach klassischer Cron-Regel mit ODER), `interval` (verstrichene Zeit ab UTC-Anker, Zeitzone nur zur Anzeige, Mindestintervall 60 s) und `once`. Offset-Schreibweisen (`UTC+1`, `+01:00`) werden abgelehnt. Die Berechnung des nächsten Termins ist rein und deterministisch (`nextDue(rule, after)`: strikt nach `after`). `previewSchedule` liefert die nächsten N Läufe mit Zeitzone und UTC-Offset und zeigt übersprungene DST-Termine an.
2. DST-Regeln (in rules.ts dokumentiert, in rules.test.ts getestet):
   - Überlappung (Herbst, lokale Zeit doppelt): läuft einmal beim ersten Auftreten, das zweite wird unterdrückt (Europe/Berlin 2026-10-25 02:30: nur 00:30Z).
   - Lücke (Frühling, lokale Zeit fehlt): Option `gapPolicy` je Regel. `skip` (Standard, so steht es in Plan 04 §5): Termin entfällt, Vorschau kennzeichnet ihn (`gap_skipped`). `run_after_gap` (so steht es in der Karte): Lauf zum ersten gültigen Zeitpunkt nach der Lücke (Übergangsinstant, 2026-03-29T01:00Z). Mehrere Termine auf demselben Instant laufen einmal (`coalesced`). Der Widerspruch ist in "Offene Fragen" Nr. 1.
   - Zusätzlich getestet: America/New_York und Australia/Lord_Howe (30-Minuten-Versatz), 29. Februar, nie passende Ausdrücke.
3. Dauerhafte Erzeugung (`OccurrenceGenerator.generateDue`): ein Durchlauf = eine Transaktion. Fällige Zeitpläne werden mit `FOR UPDATE OF sch SKIP LOCKED` gesperrt (Abonnement `FOR SHARE ... SKIP LOCKED`, damit Pause nicht dazwischen läuft). Eindeutigkeit in der Datenbank (`schedule_occurrences`): `UNIQUE (subscription_id, scheduled_for)` (schärfer als Plan 04 `(schedule_id, schedule_version, scheduled_for_utc)`, dessen Folge es ist: gilt auch über Regelversionen und Zeitpläne desselben Abonnements) und `UNIQUE (schedule_id, schedule_version, local_plan_time)` (Winterzeitfall; NULL für interval/once, damit stündliche Intervalle nicht unterdrückt werden). Einfügen mit `ON CONFLICT DO NOTHING`. Der Cursor `generated_through` wird in derselben Transaktion fortgeschrieben; ein Crash lässt weder Termin noch Cursor zurück.
   - `catch_up_once` (Plan-Standard): nach Ausfall läuft nur der letzte fällige Termin, die früheren werden in `missed_count` gezählt (Test: 2 h Ausfall, 1-Minuten-Intervall: 1 Lauf, missed_count 119).
   - Läuft für das Abonnement schon ein Lauf (queued/leased/retry_wait), wird der Termin zusammengefasst (`coalesced`), kein paralleler Scan. Durchgesetzt durch partiellen Unique-Index `job_runs_one_open_run_per_subscription_idx`.
   - Jitter: einmal je Lauf gezogen und gespeichert (`jitter_seconds`), `scheduled_for` bleibt der Originaltermin, `run_after = scheduled_for + Jitter`. Retries ziehen keinen neuen Start-Jitter.
   - Bearbeitung erhöht `schedules.version`; der Lauf trägt `config_snapshot` (Regel, Version, Quellreferenz). Eine neue Version setzt nach dem Cursor fort, erzeugt also keinen Termin doppelt.
4. Queue mit Leases (`JobQueue`): `claim` mit `SELECT ... FOR UPDATE OF jr SKIP LOCKED`, Lease mit Ablauf, `heartbeat` (verlängert nur gültige Leases), `complete`, `fail`, Rückholung abgelaufener Leases (Lauf geht nach `retry_wait`, sofort claimbar, oder nach `failed`, wenn die Versuche aufgebraucht sind). `attempts` ist zugleich Lease-Generation (Fencing-Token): ein Worker mit abgelaufener oder veralteter Lease kann weder abschließen noch scheitern noch verlängern (`LeaseLostError`, Plan 08 T18). Strikt: auch eine abgelaufene, noch nicht zurückgeholte Lease gilt als verloren.
   - Retry: gedeckelt exponentiell 30 s, 120 s, 480 s, 1800 s (Deckel) plus bis zu 10 % Jitter (Standard, injizierbar, `jitterRatio: 0` für exakte Tests). Plan nennt "beispielsweise 30 s, 2 min, 10 min, 30 min"; 4 als Faktor liefert 8 statt 10 min (Abweichung bewusst, siehe Annahmen). `Retry-After` wird beachtet (längerer Wert gewinnt, höchstens 24 h). Maximale Versuche Standard 5 (konfigurierbar). `retryable: false` beendet sofort mit `failed`. Fehlertext auf 2000 Zeichen gekürzt.
   - Pause/Fortsetzen: pausiertes Abonnement erzeugt keine neuen Läufe, seine wartenden Läufe werden nicht geclaimt, ein laufender Job bleibt unberührt. Fortsetzen holt die Pause nicht nach (Cursor springt auf "jetzt"); Fortsetzen eines aktiven Abonnements ändert nichts. "Jetzt ausführen" (`enqueueManual`) ist bei pausiertem Abonnement verweigert.
5. Fairness und Budgets (Plan 04 §10), soweit der Plan sie definiert: `QueueLimits { maxConcurrentGlobal, maxConcurrentPerUser, perUser }` mit der Semantik `null` = kein zusätzliches Limit, `0` = pausiert, positiv = Limit; ein Eintrag in `perUser` ersetzt den Default für diesen Benutzer, das globale Limit gilt zusätzlich, das kleinere gewinnt. Gesenkte Grenze startet nichts Neues, beschädigt aber nichts Laufendes (getestet). Fairness: unter den startberechtigten Benutzern gewinnt der mit den wenigsten laufenden Jobs, bei Gleichstand der mit dem ältesten letzten Claim (Round-Robin über `scheduler_claim_no_seq`), innerhalb eines Benutzers der früheste `run_after`. Ein Advisory-Lock serialisiert Claims, damit Kappungen nicht durch Rennen überschritten werden.
6. Eigentümerschaft (OWN-01): Alle fünf Tabellen haben `user_id NOT NULL`; alle sechs Fremdschlüssel zwischen ihnen sind zusammengesetzt `(…_id, user_id)` auf `UNIQUE (id, user_id)`. Die Repositories nehmen die `userId` immer mit und melden fremde Zeilen als `NotFoundError`. Tests prüfen Katalog (Spalten, Schlüssel), Datenbankverweigerung und API-Verhalten.
7. Die Bibliothek führt nichts aus und spricht mit keiner Plattform; sie legt nur "führe dieses Abonnement jetzt aus"-Läufe an (`job_runs`).

## Prüfung

Ausgeführt (Umgebung: `DATABASE_URL=postgres://kura_dev:***@127.0.0.1:5432/kura_dev`, Node v22.23.2, ICU 78.2, tz 2026a, echte PostgreSQL):
- Vorher (unveränderter Stand e2c2de8): `corepack pnpm check` Exit 0, `Test Files 14 passed (14)`, `Tests 135 passed | 1 skipped (136)`.
- Nachher (HEAD f166ce6 plus dieser Bericht): `corepack pnpm check` (typecheck, lint, test, build) Exit 0, `Test Files 17 passed (17)`, `Tests 217 passed | 1 skipped (218)`. Differenz +82 Tests, +3 Dateien, alle in tests/scheduler.
- Einzeln: `npx vitest run tests/scheduler` -> 3 Dateien, 82 Tests grün. `eslint --max-warnings=0` und `tsc --noEmit -p packages/scheduler` ohne Befund.
- Gebautes dist unter reinem Node geladen: `import('./packages/scheduler/dist/index.js')` liefert 29 Exporte; `nextDue` für `30 2 * * *` Europe/Berlin nach 2026-03-28T01:30Z ergibt 2026-03-30T00:30:00.000Z (skip-Regel). tests/deploy/package-exports.test.ts deckt das Paket weiter ab (grün).
- Negativproben (Quelle kurz verändert, Test lief rot, danach per `git checkout` zurückgesetzt, Baum sauber): Round-Robin durch FIFO ersetzt -> Fairness-Test rot; Lease-Generation aus der Bedingung entfernt -> 12 Queue-Tests rot; `SKIP LOCKED` aus dem Generator entfernt -> der Test mit gesperrtem Zeitplan läuft in den Timeout (30 s), Folgetests rot. Die zweite und dritte Probe sind grobe Eingriffe (Parameter bzw. Sperre fehlen), also nur ein schwacher Beleg für die Feinheit der Tests.
- `corepack pnpm audit --audit-level=high`: "2 vulnerabilities found, Severity: 1 low | 1 moderate", keine hohen. Keine neue Abhängigkeit durch diese Karte; den Stand davor habe ich nicht verglichen.

Nicht geprüft:
- Mehrere Betriebssystemprozesse als Scheduler: die Tests nutzen viele gleichzeitige Verbindungen eines Prozesses (Pool), nicht getrennte Prozesse. Der Mechanismus (Zeilensperren, Unique-Constraints, Advisory-Lock) ist derselbe, ein echter Mehrprozess-Lauf fehlt (unbekannt).
- Last und Dauer für 100 Benutzer (T47), Leistung des Claim-Statements mit großen `job_runs`-Beständen (unbekannt; Indizes sind angelegt, nicht gemessen).
- Zeitumstellungen anderer Zonen als Berlin, New York, Lord_Howe; Verhalten bei künftigen Änderungen der tz-Datenbank (Termine werden bei jeder Berechnung aus Regel und Datenbank neu bestimmt, gespeicherte `next_due_at` können nach einem tz-Update abweichen, bis der Zeitplan neu berechnet wird).
- Zwei gleichzeitige Übergänge einer Zone innerhalb von ±24 h (kommt in der tz-Datenbank nicht vor, nicht belegt).

## Annahmen

1. Plan 04 §5 (Lücke: überspringen) hat Vorrang vor der Parenthese der Karte, solange nichts anderes entschieden ist; beide Verhalten sind umgesetzt und getestet, der Standard ist `skip`. Umstellung auf `run_after_gap` als Standard ist eine Konstante in `normalizeRule` (rules.ts) plus Testanpassung.
2. Backoff-Faktor 4 mit Deckel 1800 s als "gedeckelt exponentiell"; Jitter 10 % bei Retry (Plan: "plus Jitter", ohne Zahl); Standard 5 Versuche (Plan nennt keine Zahl, die Karte verlangt eine Obergrenze). Alles konfigurierbar (`retry`, `maxAttempts`).
3. Abgelaufene Leases gehen ohne Backoff direkt in `retry_wait` mit `run_after = jetzt`, zählen aber als Versuch; Absturzschleifen enden so durch `max_attempts`.
4. Pro Abonnement höchstens ein offener Lauf (auch bei mehreren Zeitplänen). Das setzt "kein paralleler Scan desselben Abonnements" (Plan 04 §5) strikt um; ein später gewünschter paralleler Lauf zweier Zeitpläne bräuchte eine neue Migration.
5. `catch_up_once` ist die einzige Nachholregel. Der Plan nennt "Standard `catch_up_once`", andere Regeln sind nicht spezifiziert, deshalb nicht gebaut.
6. Fortsetzen und Wiedereinschalten holen die Pausenzeit nicht nach. Der Plan sagt nichts dazu; einfachste und gefahrloseste Wahl.
7. Eine Bearbeitung der Regel verwirft fällige, noch nicht erzeugte Termine der alten Regel (Cursor springt auf "jetzt").
8. `subscriptions.source_ref` ist eine undurchsichtige Zeichenkette (max. 2048 Zeichen) ohne Bedeutung in M4; Adapter (M5) interpretieren sie. Weitere Quellspalten verlangen spätere Migrationen.
9. Pro Zeitplan und Durchlauf werden höchstens 10 000 fällige Termine untersucht (`maxOccurrencesPerPass`); sehr lange Ausfälle sehr häufiger Regeln werden in mehreren Durchläufen aufgeholt.
10. Fehlertexte in `fail` sind vom Aufrufer bereits von Geheimnissen bereinigt; die Bibliothek kürzt nur.
11. Gelesen, aber nicht gelaufen: Immich-/Blobstore-Pakete (nur als Stilvorlage), Plan 08 außerhalb der M4- und JOB-01-Zeilen.

## Risiken

- R-A: Bei `skip` entfällt ein täglicher Lauf zur Lückenzeit ganz (Nutzer sieht ihn nur in der Vorschau). Bei `run_after_gap` läuft er stattdessen eine Stunde "zu früh/spät" nach lokaler Uhr. Beides ist Produktentscheidung (Frage 1).
- R-B: `claim` serialisiert alle Claims über einen Advisory-Lock. Für 1 bis 100 Benutzer und wenige Worker unkritisch (Claim ist kurz), bei vielen hundert Workern wäre es ein Engpass (nicht gemessen).
- R-C: Der Claim berechnet laufende Jobs je Benutzer mit einer Aggregation über `job_runs` im Zustand `leased`; dank Teilindex klein, aber ohne Messung.
- R-D: `job_runs` und `schedule_occurrences` wachsen unbegrenzt. Aufbewahrung/Bereinigung ist nicht Teil dieser Karte (unbekannt, wer sie baut).
- R-E: Erkennung von "Worker tot" hängt allein an `lease_expires_at` und der Uhr des Aufrufers (`Clock`). Gehen Uhren zwischen Prozessen auseinander, verlängern oder verkürzen sich Leases entsprechend; Annahme: Prozesse laufen auf demselben Host oder mit NTP.
- R-F: Pause ist nur "keine neuen Läufe". Ein laufender Job wird nicht unterbrochen; ein kontrollierter Abbruchweg fehlt (Plan 04 §5/§10 verlangen ihn). Er gehört zu M4-B/M5.

## Offene Fragen

1. (Entscheidung Orchestrator/Auftraggeber) DST-Lücke: Die Karte schreibt "gap = run at the first valid instant after the gap", Plan 04 §5 schreibt "Diesen lokalen Termin überspringen und in Vorschau kenntlich machen". Beide sind umgesetzt (`gapPolicy`), Standard ist `skip` laut Plan. Soll der Standard `run_after_gap` werden, oder ist die Regel je Zeitplan wählbar (UI)?
2. [Iroha] Wäre bei "jetzt ausführen" für pausierte Abonnements ein Lauf nicht oft gewollt? [Yui] Ich habe es verweigert (Pause = keine neuen Läufe) und bitte um Bestätigung, bevor M4-B die Schaltfläche anbietet.
3. Plan 04 §10, vom Plan definiert, aber hier NICHT umgesetzt (unbekannt, wer es baut; M4-B/M5/M6):
   - Budgets je Quellkonto und Adapter (`maxConcurrentPerSourceAccount`, `perAdapter`)
   - Tagesbudgets (`maxDownloadsPerDayPerUser`, `maxBytesPerDayPerUser`, `bandwidthBytesPerSecond`) einschließlich UTC-Tagesabrechnung und Reservierung
   - getrennte Pools/Slots (`downloadSlots`, `transferSlots`, `lifecycleReservedSlots`)
   - Persistenz, Validierung, Versionierung und atomare Aktivierung der Admin-Konfiguration (die Bibliothek bekommt `QueueLimits` je `claim`-Aufruf übergeben)
   - Anzeige, ob ein Lauf auf Kapazität, Policy, Quelllimit oder Kontofreigabe wartet
   - 429-Kontodrosselung (nur `Retry-After` je Lauf wird beachtet), 401/403 -> Pausieren und Anmeldung anfordern, Kill-Switch je Adaptersversion
4. Plan 04 §5 "Vorschau zeigt die nächsten fünf Läufe": die Berechnung existiert (`previewSchedule`), eine API/UI-Anbindung nicht.
5. Soll ein Zeitplan nach Erschöpfen (`once`) automatisch deaktiviert werden? Aktuell bleibt `enabled = true` mit `next_due_at = NULL`.
6. Aufbewahrungsdauer und Bereinigung von `job_runs`/`schedule_occurrences`: nicht entschieden.

## Einbindung (für M4-B)

Benötigt: Migrationen 0040-0042 (laufen mit dem bestehenden Migrator; Reihenfolge 0033 -> 0040; M4-B darf nur Nummern ab 0043 verwenden, falls der Orchestrator nichts anderes vergibt, in 004* wären 0043-0049 frei). Import: `@kura/scheduler` (types/development -> src, default -> dist). Alle Klassen bekommen einen `pg.Pool`; die Uhr ist optional (`Clock`, Standard `systemClock`).

Verdrahtung:
1. Dienst/Worker erzeugt `new OccurrenceGenerator(pool, { maxAttempts? })` und ruft `generateDue()` periodisch auf (z. B. alle 10 bis 30 s). Mehrere Instanzen gleichzeitig sind ausdrücklich unkritisch. Rückgabe: Zähler `schedulesProcessed/enqueued/coalesced/alreadyRecorded` (für Logs/Metriken; ohne Geheimnisse).
2. Der spätere Download-Worker (M5) ruft `queue.claim({ workerId, leaseSeconds, limits })`, hält die Lease mit `queue.heartbeat(lease, seconds)` (empfohlen: Intervall höchstens ein Drittel von `leaseSeconds`), meldet `complete(lease)` oder `fail(lease, { error, retryable, retryAfterSeconds })` und fängt `LeaseLostError` ab (dann sofort abbrechen, nichts committen). `lease.leaseGeneration` ist das Fencing-Token für Plan 07 (`leaseGeneration` im result.json). `lease.configSnapshot` enthält Regelversion und `sourceRef`.
3. API (Vorschlag, alles mit `userId` der Sitzung): `SubscriptionRepository.createSubscription / getSubscription / pauseSubscription / resumeSubscription / createSchedule / updateSchedule / getSchedule`; `JobQueue.enqueueManual / getRun / listRuns`; Vorschau über `previewSchedule(rule, new Date(), 5)` (liefert Zeit, Offset, Status). Regeleingabe `ScheduleRule`: Fehler `InvalidScheduleRuleError`, `InvalidCronExpressionError`, `InvalidTimeZoneError` sind Eingabefehler (HTTP 400); `NotFoundError` -> 404 (auch für fremde Objekte); `SubscriptionPausedError` -> 409. Die Bibliothek hat noch keine Listenabfrage für Abonnements/Zeitpläne eines Benutzers (nur Einzelabruf und `listRuns`); falls M4-B sie braucht, bitte als kleine Ergänzung im Paket nachziehen oder den Auftrag erweitern.
4. Admin-Limits: M4-B lädt die aktuelle Konfiguration und übergibt sie je `claim` als `QueueLimits`; Gültigkeitsprüfung (nicht negativ, ganzzahlig) macht `claim` selbst (`RangeError`), die Konfigurationsspeicherung ist nicht Teil dieser Karte (Frage 3).
5. Zeitzonen kommen aus der Node-ICU-Datenbank (hier tz 2026a). Das Produktionsimage braucht Node mit vollständiger ICU (`node:22-trixie` hat sie; im Image nicht geprüft, unbekannt).
6. Kein Eintrag in apps/** oder anderen Paketen wurde angefasst; `apps/worker` ruft noch nichts aus dem Paket auf.

Änderungsverzeichnis und Rückweg: siehe Envelope; Rückgängig: `git revert` der drei Commits 6fee2f0, d539eea, f166ce6 und des Berichts-Commits. Die Migrationen 0040-0042 sind nur additiv (neue Tabellen); auf einer bereits migrierten Datenbank hieße der Rückweg `DROP TABLE schedule_occurrences, job_runs, scheduler_user_state, schedules, subscriptions; DROP SEQUENCE scheduler_claim_no_seq; DELETE FROM schema_migrations WHERE version IN ('0040_scheduler_subscriptions','0041_scheduler_job_runs','0042_scheduler_occurrences');`. Nicht ausgeführt, nur beschrieben (zerstörerisch, nur nach Rückfrage).

## Nächster Schritt

Review durch den Reviewer, dann Entscheidung zu Frage 1 (Lückenregel) und zu den nicht umgesetzten Budgetpunkten (Frage 3). Danach M4-B (API/UI-Anbindung, periodischer Generator-Lauf im Dienst, Admin-Konfiguration).
