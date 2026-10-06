Aufgabe: M1-C3 Weboberfläche für den lokalen Modus / Status: teilweise / Artefakte: `apps/web/src/{App.tsx,api.ts,labels.ts,styles.css}` sowie Komponenten- und Clienttests / Zusammenfassung:
Die React-Oberfläche führt über Einrichtung, Anmeldung, erzwungenen Passwortwechsel, Statusübersicht, Konto und administratorische Benutzerverwaltung. Ein kleines Fetch-Modul verwendet Same-Origin-Cookies, verwaltet den CSRF-Token, reicht ihn bei Schreibzugriffen weiter und führt bei 401 zur Anmeldung zurück. Alle sichtbaren deutschen UI-Texte liegen in `labels.ts`; nicht implementierte Bereiche sind sichtbar, aber nicht klickbar.

Prüfung:
Ausgeführt: `pnpm check` — erfolgreich. Wörtliche Testausgabe: `Test Files  4 passed (4)` und `Tests  16 passed (16)`.
Ausgeführt: `pnpm audit --audit-level=high` — Exit 0. Wörtliche Ausgabe: `2 vulnerabilities found` und `Severity: 1 low | 1 moderate`.
Ausgeführt: Chromium-Prüfung — erfolgreich: `Google Chrome for Testing 151.0.7922.34` mit `--no-sandbox --version`.
Ausgeführt: Browser-Bundle — vor der Änderung 196215 Bytes, danach 209026 Bytes (+12811 Bytes). Das JS-Bundle stieg von 195.03 kB auf 206.59 kB (gzip 61.41 auf 64.35 kB).
Nicht ausgeführt: Playwright-E2E gegen lokal gestartete API/Testdatenbank. Zwar startet Chromium, im Workspace gibt es jedoch weder das Playwright-Paket noch eine vorhandene Browser-Automationssuite; diese Karte ergänzt ohne neue Abhängigkeit daher keine nicht verifizierbare CDP-Alternative.

Annahmen:
Der bestehende Endpunkt `GET /api/v1/users` liefert nach einer Anmeldung das eigene Konto als ersten Eintrag; die Kopfzeile verwendet diesen Eintrag für Name und Benutzername. Der vorhandene API-Vertrag liefert bei Login keine Sperrwartezeit, daher zeigt die UI nur sichere generische Anmeldefehler. D-015 war in `decisions.md` nicht vorhanden; D-013/D-014 wurden berücksichtigt. Keine neuen Abhängigkeiten; folglich keine neuen Lizenzen.

Risiken:
Der geforderte Browser-End-to-End-Ablauf ist offen. Bei mehreren Administratoren kann die Kopfzeile wegen des bestehenden Listenvertrags den ersten statt des aktuell angemeldeten Administrators darstellen; ein `/me`-Feld im Auth-State wäre eine spätere minimale Vertragsverbesserung.

Offene Fragen:
Keine Rückfragen gemäß Auftrag. Nächster Schritt: Review und ein E2E-Setup mit explizit freigegebener Playwright-Abhängigkeit oder vorhandener Browser-Testinfrastruktur.
