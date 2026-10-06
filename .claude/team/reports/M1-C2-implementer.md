Aufgabe: M1-C2 Auth-API härten und mit Tests belegen / Status: braucht Review / Artefakte: `migrations/0003_auth_hardening.sql`, `apps/api/src/app.ts`, `tests/integration/auth.test.ts`, angepasste Migrations-/Status-Tests / Zusammenfassung:
Die lokale Auth-API erzwingt für initiale Passwörter den serverseitigen Passwortwechsel: ein solcher Benutzer darf nur Passwortwechsel oder Abmeldung ausführen. Abgewiesene und gesperrte Logins schreiben ein nicht geheimes Audit-Ereignis mit Fehlerausgang. Abgewiesene zustandsändernde API-Anfragen werden zusätzlich zentral als `*.rejected` mit Akteur (falls vorhanden), Route, Ausgang und Quelladresse auditiert. Die Drosselung verwendet für Sperrzeit und Aktualisierung die injizierte Uhr. Passwortwechsel widerrufen nachweislich alle anderen Sitzungen, erhalten aber die auslösende Sitzung. Ergänzt wurde ein minimaler Einzelbenutzer-Leseweg `GET /api/v1/users/:id`, der Nicht-Admins beim Zugriff auf andere Benutzer mit dem einheitlichen `FORBIDDEN`-Fehler abweist.

Prüfung:
Ausgeführt: `pnpm check` — erfolgreich. Wörtliche Testausgabe: `Test Files  4 passed (4)` und `Tests  16 passed (16)`; vorher 6 Vitest-Tests, nachher 16.
Ausgeführt: `pnpm audit --audit-level=high` — Exit 0. Wörtliche Ausgabe: `2 vulnerabilities found` und `Severity: 1 low | 1 moderate`.
Ausgeführt: `pnpm vitest run tests/integration/auth.test.ts` gegen die vorhandene echte PostgreSQL-Testdatenbank — `Test Files  1 passed (1)`, `Tests  10 passed (10)`; Sitzungsablauf und Drosselung ausschließlich mit injizierter Uhr, ohne echte Sleeps.
Ausgeführt: `git diff --check 544b4bf..HEAD` — erfolgreich.

Annahmen:
`local_credentials.login_email_normalized` bleibt der lokale normalisierte Benutzername. scrypt mit N=32768, r=8, p=1, 32 Byte und 64 MiB maxmem erfüllt die Vorgabe. Der in der Review angeforderte Eigentümerfall wird durch den minimalen Einzelbenutzer-Leseweg umgesetzt; der bestehende Listenendpunkt bleibt für Nicht-Admins auf das eigene Konto gefiltert. T29/T30 waren in der Kartenbeschreibung nicht weiter definiert; der Test belegt als benannten Datenbank-Identitätsfall, dass zwei lokale Logins derselben Anmeldekennung zu derselben `users.id` führen. Die Sandbox-Arbeitskopie war unter `/work/Downloader` verfügbar, während der zugewiesene Scratch-Pfad nicht eingehängt war.

Risiken:
Der Fastify-Request-Logger protokolliert Anfrage-Metadaten; die geprüften Antworten und Auditdaten enthalten weder Passwortwerte noch Passwort- oder Sitzungs-Hashes. Die Tests prüfen keinen realen Proxy. Audit-Ereignisse für abgewiesene Schreibanfragen benutzen absichtlich die Route statt Nutzdaten als Ziel, damit Eingabewerte nicht gespeichert werden.

Offene Fragen:
Keine Rückfragen gemäß Auftrag. Nächster Schritt: Review der Auth- und Testsuite.