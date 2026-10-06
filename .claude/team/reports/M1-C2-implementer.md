Aufgabe: M1-C2 Auth-API härten und mit Tests belegen / Status: braucht Review / Artefakte: `migrations/0003_auth_hardening.sql`, `apps/api/src/app.ts`, `tests/integration/auth.test.ts`, angepasste Migrations-/Status-Tests / Zusammenfassung:
Die lokale Auth-API erzwingt für initiale Passwörter den serverseitigen Passwortwechsel: ein solcher Benutzer darf nur Passwortwechsel oder Abmeldung ausführen. Abgewiesene und gesperrte Logins schreiben nun ein nicht geheimes Audit-Ereignis mit Fehlerausgang. Ergänzt wurde ein minimaler Einzelbenutzer-Leseweg `GET /api/v1/users/:id`, der Nicht-Admins beim Zugriff auf andere Benutzer mit dem einheitlichen `FORBIDDEN`-Fehler abweist. Die echte PostgreSQL-Testsuite belegt zusätzlich Setup-Token, Secure-Cookie, CSRF-Origin-Ablehnung, absoluten Ablauf bei Aktivität, Sperr-Widerruf für einen anderen Benutzer, Audit ohne Geheimnisse, State- und Admin-Fehlerpfade sowie stabile lokale Benutzeridentität über zwei Logins.

Prüfung:
Ausgeführt: `pnpm check` — erfolgreich. Wörtliche Testausgabe: `Test Files  4 passed (4)` und `Tests  13 passed (13)`; vorher 6 Vitest-Tests, nachher 13.
Ausgeführt: `pnpm audit --audit-level=high` — Exit 0. Wörtliche Ausgabe: `2 vulnerabilities found` und `Severity: 1 low | 1 moderate`.
Ausgeführt: `pnpm vitest run tests/integration/auth.test.ts` gegen die vorhandene echte PostgreSQL-Testdatenbank — `Test Files  1 passed (1)`, `Tests  7 passed (7)`; Sitzungsablauf ausschließlich mit injizierter Uhr, ohne echte Sleeps.
Nicht geprüft: produktiver Reverse-Proxy-Fall mit `trustProxy=true`; die Implementierung verwendet hierfür weiterhin die bestehende Fastify-Konfiguration.

Annahmen:
`local_credentials.login_email_normalized` bleibt der lokale normalisierte Benutzername. scrypt mit N=32768, r=8, p=1, 32 Byte und 64 MiB maxmem erfüllt die Vorgabe. Der in der Review angeforderte Eigentümerfall wird durch den minimalen Einzelbenutzer-Leseweg umgesetzt; der bestehende Listenendpunkt bleibt für Nicht-Admins auf das eigene Konto gefiltert. T29/T30 waren in der Kartenbeschreibung nicht weiter definiert; der Test belegt als benannten Datenbank-Identitätsfall, dass zwei lokale Logins derselben Anmeldekennung zu derselben `users.id` führen. Die Sandbox-Arbeitskopie war unter `/work/Downloader` verfügbar, während der zugewiesene Scratch-Pfad nicht eingehängt war.

Risiken:
Der Fastify-Request-Logger protokolliert Anfrage-Metadaten; die geprüften Antworten und Auditdaten enthalten weder Passwortwerte noch Passwort- oder Sitzungs-Hashes. Die Tests prüfen keinen realen Proxy.

Offene Fragen:
Keine Rückfragen gemäß Auftrag. Nächster Schritt: Review der Auth- und Testsuite.
