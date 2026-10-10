# VER Implementer: Versionsprüfung (eigene Version, Abgleich mit GitHub-Tags, Hinweis, Update-Anleitung)

- Aufgabe: `t_fac7a93e` VER. Anforderung REQ-DL-007 `e5998b5ad31199cf` (Kontext REQ-DL-003 `b83be904af3eded5`). Auftraggeber: "Alles klar, baue noch eine Versions prüfung ein. Damit die Personen wissen, dass ihre Version veraltet ist und upgraden können. Und sag mir bescheid, wenn du fertig bist."
- Status: fertig (zur Abnahme). Offener Punkt: `pnpm audit` ist nicht sauber, die zwei Funde sind vorhanden und liegen in Dateien, die diese Karte nicht ändern darf (siehe Risiken).
- Artefakte: Branch `lane/version`, Worktree `/work/wt/ver`, Basis `593eb07`, Commits je grünem Schritt, Baum sauber, nichts gepusht. Neue Dateien: `apps/api/src/{semver,build-info,github-releases,update-check,version-routes}.ts`, `migrations/0069_version_check.sql`, `apps/web/src/Version.tsx`, `apps/web/src/styles/version.css`, `tests/version/*`, `apps/web/src/Version.test.tsx`. Geändert: `apps/api/src/{app,config,index}.ts`, `apps/web/src/{App,AppShell,api,main}.ts(x)`, `apps/web/src/App.test.tsx` (nur der Hilfs-Mock), `deploy/{Containerfile,kura-deploy.sh,README.md}`, `docs/vm-setup.md`, `README.md`, `.env.example`.
- Zusammenfassung: Eine Instanz kennt ihre Version (Wurzel-`package.json` zur Build-Zeit plus Git-Commit, als Build-Argumente in das Image), fragt serverseitig alle 12 Stunden die GitHub-Tags ab, vergleicht nach Semver und zeigt es an: Versionszeile in der Seitenleiste für alle, ausblendbarer Streifen und die Seite "Über Kura" mit Befehlen, Sicherungshinweis und Release-Link für Administratoren. Es gibt keinen Weg, der ein Update auslöst (weder Route noch Knopf).

## Was geändert wurde (Änderung, Grund, Auswirkung, Rückweg)

1. Version und Commit im Image. `deploy/Containerfile`: `ARG KURA_VERSION`, `ARG KURA_COMMIT` und `ENV` in der letzten Stufe (Build-Argumente gelten nicht stufenübergreifend; spät deklariert, damit der Cache der Schichten darüber bleibt). `deploy/kura-deploy.sh` liest die Version mit `sed` aus `package.json` des ausgecheckten Standes (der Host hat kein Node), prüft sie, reicht `--build-arg KURA_VERSION=... --build-arg KURA_COMMIT=...` durch, warnt wenn Tag und `package.json` nicht zusammenpassen. Rückweg: Commit zurücknehmen. Ohne Build-Argumente liest die API zur Laufzeit die Wurzel-`package.json` (nur im Quellbaum vorhanden) und meldet den Commit als "unbekannt".
2. Fehler im Deploy-Skript behoben, der zur Aufgabe gehört: `git reset --hard origin/<ref>` scheitert bei einem Tag (es gibt kein `origin/v0.3.0`), `kura-deploy.sh v0.3.0` hätte also nie funktioniert. Jetzt: Branch auf origin folgt dem Remote wie bisher, ein Tag wird detached ausgecheckt, alles andere bricht mit klarer Meldung ab, bevor etwas gestartet wird. `git fetch --tags`. Idempotent (zweimal derselbe Lauf liefert denselben Build).
3. API (`apps/api/src`): `semver.ts` (eigene, kleine Semver-Umsetzung, keine neue Abhängigkeit), `build-info.ts`, `github-releases.ts` (Client: unauthentifiziert, User-Agent, 10 s, 1 MiB, keine Weiterleitungen, ETag, Rückstau bei 403/429 aus `Retry-After` bzw. `x-ratelimit-reset`, begrenzt auf 1 min bis 24 h, bis zu 5 Seiten Tags), `update-check.ts` (Ablauf, Speicher im Hauptspeicher und in der Datenbank, Zeitplan: 60 s nach dem Start, dann alle 12 h, nach einem Fehlschlag nach 1 h), `version-routes.ts`. `GET /api/v1/version` (angemeldet), `POST /api/v1/version/check` (nur Administrator, Audit `version.check`, 409 `UPDATE_CHECK_DISABLED` wenn aus), `POST /api/v1/version/dismiss` (nur Administrator). `/api/v1/status` liefert die echte Version statt `'0.1.0'`. Konfiguration: `KURA_UPDATE_CHECK`, `KURA_UPDATE_REPO`, `KURA_UPDATE_CHANNEL`, `KURA_UPDATE_API_BASE`. Der Zeitplan startet nur im echten Dienst (`index.ts`, Hook `onReady`); ein in Tests gebauter App-Aufruf ohne `update`-Konfiguration ist "deaktiviert" und sendet nie eine Anfrage.
4. Migration `migrations/0069_version_check.sql` (nur additiv): `update_check_state` (eine Zeile) und `update_notice_dismissals` (je Benutzer die zuletzt ausgeblendete Version). Rückweg: Tabellen löschen (kein anderer Code hängt daran) und die Datei entfernen; die Version bleibt in `schema_migrations` und müsste dort mit gelöscht werden.
5. Web: Seitenleisten-Fuß "Kura 0.2.0" (Schaltfläche, öffnet "Über Kura") mit Text-Markierung "Neue Version 0.3.0", Streifen für Administratoren ("Kura 0.3.0 ist verfügbar. Du nutzt 0.2.0.", "Details", "Ausblenden"), Seite "Über Kura" (Version, Commit, Status, letzte Prüfung, Quelle, "Jetzt prüfen", Release-Hinweise als reiner Text, Anleitung, Hinweis auf kein Selbst-Update und auf die Datenschutzfolge), Zugang auch über die Kontoseite. Nur vorhandene Bausteine und Tokens (`Banner`, `Button`, `Chip`, `PageHeader`, `status-list`), eigene Klassen in `styles/version.css`, beide Farbschemata, unter 1024 px im Menü der Kopfleiste. Kein Gedankenstrich, kein Emoji (Test).
6. Doku: `docs/vm-setup.md` Abschnitt "Version und Update" (Tags, Anzeige, Prüfung, Umgebungsvariablen, Datenschutz, Upgrade, Rückrollen, Abschalten), `README.md` (Englisch, kurz), `deploy/README.md`, `.env.example`.

## Prüfung (ausgeführt)

- `corepack pnpm check` zweimal grün (typecheck, eslint mit `--max-warnings=0`, vitest mit echter PostgreSQL, Build aller Pakete). Vorher: 58 Dateien, 1292 bestanden, 1 übersprungen. Nachher: **64 Dateien, 1401 bestanden, 1 übersprungen** (+6 Dateien, +109 Tests unter `tests/version/`), beide Läufe identisch.
- Web-Tests (`apps/web`, laufen nicht im Prüftor: Wurzel-`vitest` nimmt nur `tests/**/*.test.ts`; Aufruf `cd apps/web && npx vitest run`): vorher 13 Dateien / 92 Tests, nachher **14 Dateien / 111 Tests**, grün. `tests/ui-shots/contrast.test.ts` grün (75).
- Ein erster Lauf des Prüftors war rot: `tests/integration/status.test.ts` legt `/api/v1/status` auf genau die Schlüssel `database`, `migrations`, `version` fest. Ich habe den Test nicht angefasst (nicht meine Datei) und den Commit aus `/status` herausgenommen; er steht nur in `GET /api/v1/version` (angemeldet).
- Semver: v-Präfix, Pre-Releases (Rangfolge nach Spezifikation), Build-Metadaten, 21 ungültige Eingaben, Meilenstein-Tags (`m3`, `platforms-1`) und Tags ohne `v` werden ignoriert, Kanal `stable` und `prerelease`.
- GitHub-Client gegen einen lokalen HTTP-Server (`tests/version/fake-github.ts`): Tags, Seitenfolge, Release 404, ETag 304 (bedingte Anfrage nur auf Seite 1), 403 mit Reset-Zeit, 429 mit `Retry-After`, Grenzen 1 min bis 24 h, Zeitüberschreitung (auch bei hängendem Rumpf), zu große Antwort (deklariert und gestreamt), Weiterleitung, kaputtes JSON, nicht erreichbar, kein `Authorization`-Header.
- Zeitplan mit künstlicher Uhr (`FakeTime`, keine echten Timer): erste Prüfung nach genau 60 s, dann 12 h, nach Fehlschlag 1 h, ETag wird mitgesendet, Rückstau hält auch Abruf per Hand und Neustart zurück, `stop()`, doppelter `start()`, gleichzeitige Abrufe teilen eine Anfrage, Neustart kennt das Ergebnis ohne Anfrage, Ergebnis eines anderen Repositorys oder Kanals wird ignoriert, Fehler in Abruf/Speichern/Laden brechen nichts. Deaktiviert: keine Anfrage, kein Timer, nichts gespeichert, Abruf per Hand 409.
- API mit echter PostgreSQL und lokalem GitHub-Server: Anmeldung nötig (401), `POST /version/check` und `/dismiss` nur Administrator (403 für Benutzer und ohne Sitzung), Speicherung in `update_check_state`, Audit-Eintrag, Ausblenden je Benutzer und je angebotener Version (neuere Version zeigt es wieder), es gibt keine Route zum Installieren (404).
- Deploy-Skript wirklich mit `sh` (hier `dash`) ausgeführt, gegen ein Wegwerf-Git-Repository (bare Remote, Branch, annotierter Tag) und falsche `podman`/`curl`/`sleep`/`hostname` im PATH: Build-Argumente `KURA_VERSION=0.2.0` und `KURA_COMMIT=<kurzer Hash>` kommen an, ein Tag wird ausgecheckt, Wechsel Tag zu Branch, zweimal derselbe Lauf gleicher Build, Warnungen (Tag passt nicht zu `package.json`, keine gültige Version), unbekannter Ref bricht ab ohne `podman`-Aufruf, `sh -n`.
- Echte gebaute API als Prozess mit `KURA_VERSION=0.2.0 KURA_COMMIT=abc1234` und lokalem Fake-GitHub: `/api/v1/status` zeigt `0.2.0`, die Migration 0069 wird angewendet, die Prüfung findet `v0.3.0`.
- Oberfläche in echtem Chromium (Playwright, Wegwerf-Datenbank): Streifen, Seitenleiste, Seite "Über Kura" in hell 1440, dunkel 1440 und mobil 390; keine überlaufenden Elemente, Befehle scrollen waagerecht.

## Nicht geprüft (und warum)

- **Podman-Build** des Images mit den neuen `ARG`/`ENV`: kein Podman in der Sandbox. Der Orchestrator führt ihn auf der VM aus (`kura-deploy.sh`). Geprüft ist nur, dass die Containerfile-Zeilen vorhanden sind und das Skript die Argumente übergibt.
- **Echte GitHub-API**: kein Netz in Tests. Form der Antworten (Tag-Liste, `releases/latest`, ETag, Rate-Limit-Köpfe) stammt aus meinem Wissen über die Dokumentation und nicht aus einem Lauf. Ob die Tag-Liste in der Reihenfolge der Seiten liefert, ist unerheblich, weil der höchste Tag über alle gelesenen Seiten (bis 500 Tags) gesucht wird.
- **`/releases/tag/<tag>`** für Tags ohne Release: ich verwende dafür bewusst `https://github.com/<repo>/tree/<tag>`.
- **`pg_dump`/`psql`-Befehle** in der Anleitung (Sicherung und Rückspielen): `pg_dump`, `psql`, `dropdb` sind in der Sandbox nicht installiert; die Befehle sind Standard, wurden aber nicht ausgeführt. Dasselbe für `git -C ... checkout <tag>` + `cp` auf der VM.
- Arch-`/bin/sh` (bash im sh-Modus) statt `dash`: nur POSIX-Konstrukte verwendet, aber nicht dort gelaufen.
- Bildschirmleser, Tastaturpfad der neuen Elemente und Browser außer Chromium.
- Ausgehender Zugriff der VM auf `api.github.com`: unbekannt (Firewall).

## Betrieb auf der VM (was der Orchestrator tun muss)

1. Branch `lane/version` nach `main` mergen (Migration 0069 bleibt 0069; D3/F2 dürfen 0061 bis 0068 nutzen, der Migrator wendet unangewendete Dateien unabhängig von der Reihenfolge an).
2. In `main` die Wurzel-`package.json` auf `0.2.0` anheben (nicht Teil dieser Karte), committen, annotierten Tag setzen und pushen: `git tag -a v0.2.0 -m "Kura 0.2.0"`, dann `git push origin main v0.2.0`. Der Tag muss auf den Commit zeigen, dessen `package.json` `0.2.0` sagt; das Skript warnt sonst.
3. Auf der VM das neue Skript holen (das alte kann keinen Tag deployen, D-024): `git -C ~/work/Kura fetch --tags && git -C ~/work/Kura checkout v0.2.0 && cp ~/work/Kura/deploy/kura-deploy.sh ~/bin/`.
4. Datenbank sichern (Volume `kura-pgdata`, `~/.config/kura/kura.env` samt `KURA_SECRET_KEY`), Befehl siehe `docs/vm-setup.md`.
5. Optionale Probe der Veraltet-Anzeige: Ist `v0.2.0` schon auf GitHub, aber die VM läuft noch auf dem neuen Code mit Version `0.1.0` (Deploy des Branches vor dem Anheben von `package.json`), zeigt sie "Veraltet" und den Streifen. Danach das Deploy von `v0.2.0` in Schritt 6.
6. `~/bin/kura-deploy.sh v0.2.0` ausführen. Erwartung: Ausgabe `kura <commit> (version 0.2.0) is up`, `curl http://127.0.0.1:8080/api/v1/status` zeigt `"version":"0.2.0"`, "Über Kura" zeigt Version, Commit und nach "Jetzt prüfen" (oder spätestens 60 s nach dem Start) den Status "Aktuell". In `kura.env` darf `KURA_VERSION` nicht gesetzt sein.
7. Prüfen, dass die VM `api.github.com` erreicht; sonst bleibt der Status "Unbekannt" mit dem Grund "GitHub ist nicht erreichbar" (kein Fehler der Anwendung). Abschalten: `KURA_UPDATE_CHECK=false` in `kura.env`.
8. Danach für jede Veröffentlichung: `package.json` anheben, annotierter Tag `vX.Y.Z`, push, optional ein GitHub-Release mit Text (Hinweis, wenn sich `deploy/kura-deploy.sh` ändert), dann `kura-deploy.sh vX.Y.Z`.

## Annahmen

- Ausblenden wird auf dem Server gespeichert (Tabelle `update_notice_dismissals`, je Benutzer die zuletzt ausgeblendete Version) statt im Browser: gilt dann auf jedem Gerät, und die Benutzer-ID steckt serverseitig in der Sitzung (`/auth/state` hat keine). Eine neuere Version zeigt den Streifen wieder, weil sie nicht der gespeicherten entspricht.
- Release-Hinweise kommen aus `/releases/latest` und werden nur gezeigt und als "Release" verlinkt, wenn dessen `tag_name` der höchste Tag ist. Sonst: Link auf `tree/<tag>`.
- Eine fehlgeschlagene spätere Prüfung behält das zuletzt erfolgreiche Ergebnis (Status daraus) und zeigt den Grund an; "unbekannt" gilt, solange noch nie eine Prüfung gelang. (Die Aufgabe nennt nur "unbekannt mit Grund"; mit der Rückfall-Regel würde ein kurzer Netzfehler sonst die Veraltet-Anzeige löschen.)
- Nach einem Fehlschlag wird nach 1 h erneut versucht (statt erst nach 12 h).
- Tags brauchen das Präfix `v` (`0.3.0` ohne `v` wird ignoriert); die eigene Version darf mit oder ohne `v` angegeben werden.
- Der Commit steht nicht in `/api/v1/status` (öffentlich, durch einen bestehenden Test auf drei Schlüssel festgelegt), sondern in `/api/v1/version`.
- Zusätzliche Variable `KURA_UPDATE_API_BASE` (nötig für den lokalen Testserver, nützlich für GitHub Enterprise). Ungültige `KURA_UPDATE_*`-Werte brechen den Start mit klarer Meldung ab, wie die übrigen Variablen.
- Umgebungsvariablen statt einer Datei `build-info.json` im Image: einfacher und testbar. Nachteil: eine `--env-file`-Angabe überschreibt das Image (steht in `.env.example` und Doku).
- Die Anleitung in der Oberfläche gilt für die VM-Einrichtung (Podman, `~/bin`, `~/work/Kura`, wie in der Aufgabe) und sagt das.
- Der Zeitplan läuft nur im API-Prozess, nicht im Worker.

## Risiken

- **`pnpm audit` nicht sauber, nicht durch diese Karte verursacht und in verbotenen Dateien:** (1) `@fastify/static` `<=10.1.1`, moderat, GHSA-8pvw-jcv7-9cmj (Autorisierungsumgehung über nicht kanonische URL-Pfade), behoben in `>=10.1.2`; Pfad `apps/api`, dessen `package.json` ich nicht ändern darf. (2) `esbuild` `>=0.27.3 <0.28.1`, niedrig, GHSA-g7r4-m6w7-qqqr (nur Entwicklungsserver unter Windows), über `vitest`/`vite`, nur Entwicklung. Ich habe keine Abhängigkeit hinzugefügt oder geändert.
- Die unauthentifizierte GitHub-API erlaubt 60 Anfragen je Stunde und IP; hinter gemeinsamer NAT kann das knapp werden. Abgefedert durch ETag (304 zählt nicht), 12-Stunden-Takt, Rückstau.
- Tags sind auf GitHub veränderbar. Ein verschobener Tag ändert, was ein späteres `kura-deploy.sh vX.Y.Z` baut; das Skript holt Tags nur dazu (`fetch --tags` überschreibt keine vorhandenen lokalen Tags).
- Rückrollen nach einer Migration braucht die Sicherung (es gibt keine Down-Migrationen); die Anleitung sagt das und kennzeichnet das Zurückspielen als zerstörend.
- Das Ergebnis der Prüfung ist Text aus dem Internet: Release-Hinweise werden bereinigt (Steuer- und Bidi-Zeichen, 4000 Zeichen) und nur als Text gerendert (Test mit `<img onerror>`/`<script>`); Links nur mit Präfix `https://github.com/`; Tags erscheinen nur in Befehlen, wenn sie `vX.Y.Z` entsprechen.
- Beobachtung am Rande, nicht geändert: `App.tsx` nimmt `users[0]` als angemeldeten Benutzer; für einen Administrator, der nicht der älteste Benutzer ist, zeigt die Seitenleiste dann einen fremden Namen.
- Hotspot-Hinweis: keiner neu; `apps/api/src/app.ts` ist weiterhin eine Datei mit sehr langen Zeilen, ich habe dort nur wenige Zeilen ergänzt.

## Offene Fragen

- Soll `@fastify/static` auf `10.1.2` angehoben werden (Änderung in `apps/api/package.json` und `pnpm-lock.yaml`, nur der Orchestrator)?
- Sollen die Web-Tests (`apps/web`) in das Prüftor aufgenommen werden? Sie laufen heute nicht in `pnpm check` (Wurzel-`vitest` erfasst nur `tests/**/*.test.ts`); gehört zu `package.json`/Vitest-Konfiguration, also dem Orchestrator.
- Dürfen Release-Hinweise später auch Markdown darstellen? Heute reiner Text.

## Nächster Schritt

Review durch den Reviewer, danach Merge, Versionsanhebung auf `0.2.0`, Tag `v0.2.0` und Deploy auf der VM wie unter "Betrieb auf der VM". Dem Auftraggeber melden, dass die Versionsprüfung fertig ist (so verlangt es der Auftrag).
