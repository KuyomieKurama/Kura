Aufgabe: M1-C Lokaler Modus / Status: teilweise / Artefakte: Migration 0002_local_auth, lokale Auth-API, Konfiguration / Zusammenfassung:
Die API besitzt eine erste lokale Authentifizierungsbasis: atomare einmalige Einrichtung mit Advisory Lock, scrypt-basierte Passwortspeicherung, serverseitige Cookie-Sitzungen, CSRF- und Origin-Prüfung für authentifizierte Schreibvorgänge, Login-Drosselung, Benutzerliste/Anlage/Sperre sowie Passwortänderung. Die neue Migration ergänzt Sitzungsmetadaten und Loginversuche. Abhängigkeit @fastify/cookie 11.0.2 (MIT) wurde ergänzt.

Prüfung:
Ausgeführt: `pnpm check` — erfolgreich (6 Vitest-Tests erfolgreich; Typecheck, ESLint und Builds erfolgreich).
Ausgeführt: `pnpm audit --audit-level=high` — Exit 0, Ausgabe: `2 vulnerabilities found`, Severity: `1 low | 1 moderate`; keine High/Critical.
Ausgeführt: Chromium-Prüfung — fehlgeschlagen, unter `$HOME/.cache/ms-playwright` wurde kein ausführbares Chromium gefunden (Befehl gab Exit 1 ohne Versionsausgabe zurück).
Nicht geprüft: Browser-Rauchtest und geforderte Authentifizierungs-Integrationstests; sie wurden innerhalb dieses Teilschritts nicht erstellt.

Annahmen:
Die bestehende Spalte `local_credentials.login_email_normalized` dient im lokalen Testmodus als normalisierter Benutzername, weil die Migration 0001 keine separate Benutzernamensspalte enthält. scrypt aus node:crypto wird verwendet, da keine Argon2-Bibliothek vorinstalliert war und eine native Toolchain vermieden werden soll; Parameter sind N=32768, r=8, p=1, 32 Byte und maxmem 64 MiB. Ohne `KURA_SETUP_TOKEN` ist die Einrichtung offen; das ist ausschließlich für den geforderten HTTP-Testbetrieb ein Risiko. `COOKIE_SECURE` bleibt standardmäßig true und kann für den HTTP-Teststand auf false gesetzt werden.

Risiken:
Der Umfang ist nicht vollständig: UI ist weiterhin die alte Statusansicht; fehlende API-/Komponententests lassen die neue Authentifizierungsbasis nur über Typecheck/Bestandsintegrationstest belegt. Audit- und Rate-Limit-Semantik benötigen einen spezialisierten Review. Passwortrücksetzung und SMTP sind bewusst nicht umgesetzt (M1-D).

Offene Fragen:
Keine Rückfragen gemäß Auftrag. Nächster Schritt: Auth-Integrationstests schreiben, API-Fehler- und Transaktionspfade prüfen und dann die Login-, Setup-, Konto- und Benutzerverwaltungsansichten implementieren.
