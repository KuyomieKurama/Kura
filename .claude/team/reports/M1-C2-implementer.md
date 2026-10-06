Aufgabe: M1-C2 Auth-API härten und mit Tests belegen / Status: braucht Review / Artefakte: `migrations/0003_auth_hardening.sql`, `apps/api/src/app.ts`, `tests/integration/auth.test.ts`, angepasste Migrations-/Status-Tests / Zusammenfassung:
Die lokale Auth-API wurde mit einer injizierbaren Uhr für Sitzungsprüfungen, getrennten Drosselungszählern je Benutzername und Quelladresse sowie transaktionssicherer Benutzeranlage gehärtet. Neu angelegte Benutzer erhalten `must_change_password`; Login und State liefern dies aus, die Passwortänderung hebt es auf. Die Auth-Integrationstests prüfen atomare parallele Einrichtung, Passwortregeln und Hashspeicherung, identische Loginfehler, die Nichtbeachtung von X-Forwarded-For ohne trustProxy, Cookie/CSRF, Inaktivitätsablauf ohne Sleep, Logout, Schutz des letzten Admins, Eigentümerfilter, Passwortwechsel und Audit-Ereignisse.

Prüfung:
Ausgeführt: `pnpm check` — erfolgreich. Wörtliche Testausgabe: `Test Files  4 passed (4)` und `Tests  10 passed (10)`; vorher 6 Vitest-Tests, nachher 10.
Ausgeführt: `pnpm audit --audit-level=high` — Exit 0. Wörtliche Ausgabe: `2 vulnerabilities found` und `Severity: 1 low | 1 moderate`.
Ausgeführt: Migrations- und Auth-Integrationstests gegen die vorhandene echte PostgreSQL-Testdatenbank, ohne echte Sleeps.
Nicht geprüft: produktiver Reverse-Proxy-Fall mit `trustProxy=true`; die Implementierung verwendet hierfür weiterhin die bestehende Fastify-Konfiguration.

Annahmen:
`local_credentials.login_email_normalized` bleibt der lokale normalisierte Benutzername. scrypt mit N=32768, r=8, p=1, 32 Byte und 64 MiB maxmem erfüllt die Vorgabe. Die zusätzliche Spalte `must_change_password` ist als kleine additive Migration zulässig; vorhandene lokale Konten bleiben wegen des Defaults `false` unverändert. Die Sandbox-Arbeitskopie war unter `/work/Downloader` verfügbar, während der zugewiesene Scratch-Pfad nicht eingehängt war.

Risiken:
Der Fastify-Request-Logger protokolliert Anfrage-Metadaten; die geprüften Antworten und Auditdaten enthalten weder Passwortwerte noch Passwort- oder Sitzungs-Hashes. Die Tests prüfen keinen realen Proxy.

Offene Fragen:
Keine Rückfragen gemäß Auftrag. Nächster Schritt: Review der Auth- und Testsuite.
