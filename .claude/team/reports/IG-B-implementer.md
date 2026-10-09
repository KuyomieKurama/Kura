# IG-B Instagram-Cookies je Benutzer: verschlüsselt speichern, API, Oberfläche, Worker-Übergabe — Bericht Implementer

Task t_b921d581 · req REQ-DL-004 `e852201230c9a860` (Kontext REQ-DL-002 `5d6398de6dbb5063`, REQ-DL-003 `b83be904af3eded5`) · Worktree `/work/wt/ig`, Branch `lane/instagram` (Basis IG-A, `fb874f9`) · Iteration 1 · nichts gepusht

## Aufgabe

Slice B von REQ-DL-004: Jeder Benutzer kann die Instagram-Sitzung (cookies.txt) seines eigenen Kontos hochladen. Kura speichert sie verschlüsselt, der Worker gibt sie pro Lauf als Datei an gallery-dl weiter, die Oberfläche zeigt Status, Upload und Löschen.

## Status

**Fertig, braucht Review.** `corepack pnpm check` grün (Ausgabe vollständig gelesen, Exit 0): vorher 45 Dateien / 907 bestanden / 1 übersprungen (Messung aus dem IG-A-Bericht am Stand `fb874f9`, von mir nicht erneut gemessen), nachher **47 Dateien / 943 bestanden / 1 übersprungen**. `pnpm audit --audit-level=high`: Exit 0 (1 low, 1 moderate, nichts High). Web-Suite zusätzlich (`pnpm --filter @kura/web exec vitest run`, nicht Teil von `check`): 11 Dateien / 58 Tests grün (vorher 10 / 50). Baum sauber, alles committet. **Nicht geprüft: jeder echte Instagram-Abruf** (Liste unten).

## Artefakte

Commits (nur Englisch, alle grün zum Zeitpunkt des Commits):

1. `16a7ba8` Migration, Cookie-Prüfung, API-Routen, API-Tests
2. `06bf5c7` Worker: Datei 0600, Löschen im `finally`, Ergebnis festhalten, Worker-Tests
3. `8d8924f` Adressprüfung kennt gespeicherte Cookies; präzise Sätze für privat/Checkpoint bleiben
4. `49d5ac4` Weboberfläche
5. Dokumentation (`.env.example`, `docs/vm-setup.md`) und dieser Bericht

Neue Dateien:

- `migrations/0052_platform_credentials.sql`
- `apps/api/src/instagram-cookies.ts` (Prüfung/Filter des Uploads), `apps/api/src/instagram-routes.ts` (GET/PUT/DELETE `/api/v1/credentials/instagram`)
- `apps/worker/src/credentials.ts` (Laden/Entschlüsseln, Datei schreiben, Ergebnis festhalten, deutsche Texte)
- `apps/web/src/Instagram.tsx`, `apps/web/src/Instagram.test.tsx`
- `tests/instagram/credentials-api.test.ts`, `credentials-worker.test.ts`, `credentials-fixture.ts`, `cookie-samples.ts`, `cookie-probe-tool.ts`

## Zusammenfassung

**Speicher.** Tabelle `platform_credentials`: `id`, `user_id` (FK auf `users`, `ON DELETE RESTRICT`), `platform` (nur `'instagram'`), `cookies_ciphertext`, `cookies_nonce` (12 Byte), `cookie_count`, `earliest_expiry`, `created_at`, `updated_at`, `last_used_at`, `last_result` (`ok | auth_required | unknown`). `UNIQUE (user_id, platform)` und `UNIQUE (id, user_id)`; Letzteres ist die OWN-01-Vorbereitung: spätere Kindtabellen referenzieren `(id, user_id)`. Es gibt keine Klartext-Spalte. Löschen entfernt die Zeile. `cookie_count` und `earliest_expiry` sind Metadaten, kein Inhalt.

**Verschlüsselung (kein zweiter Krypto-Pfad).** Es sind dieselben Funktionen und derselbe Schlüssel (`KURA_SECRET_KEY`) wie bei den Immich-Schlüsseln: `encryptSecret`/`decryptSecret` (AES-256-GCM, 12-Byte-Nonce, Tag angehängt). Ich habe beide nur um einen **optionalen** vierten Parameter `aad` ergänzt (Plan 06: Benutzer-ID als Additional Authenticated Data) und die Funktionen exportiert; Immich ruft sie unverändert ohne `aad` auf. Für Cookies ist `aad = kura:credential:instagram:<userId>`; ein in eine fremde Zeile kopierter Blob lässt sich nicht öffnen (getestet).

**API** (angemeldet, CSRF wie alle Schreibrouten, nur eigene Zeile, nie Inhalt in der Antwort):

- `PUT` Body `text/plain` (die cookies.txt). Grenze 256 KiB (genau 262144 Byte geht, ein Byte mehr gibt 413 `FILE_TOO_LARGE`). Prüfung: jede Nicht-Kommentarzeile muss sieben tabgetrennte Felder haben (`#HttpOnly_` erlaubt), sonst 400 `COOKIES_INVALID` mit deutschem Text. Behalten werden nur Cookies mit Domain `instagram.com` oder `*.instagram.com` (Lookalikes wie `notinstagram.com`, `instagram.com.example.org` fliegen raus). Ohne `sessionid` für `instagram.com` (nicht leer, nicht abgelaufen) wird abgelehnt. Gespeichert wird **nicht** die Originaldatei, sondern ein neu aufgebauter Netscape-Text der behaltenen Cookies (mit Kopfzeile, damit auch Pythons MozillaCookieJar ihn akzeptiert). Antwort: `{ present, cookieCount, droppedCount, earliestExpiry }`.
- `GET` Status: `{ present, secretKeyConfigured, cookieCount, earliestExpiry, expired, updatedAt, lastUsedAt, lastResult }`.
- `DELETE` (204, auch wenn nichts da ist).
- Ohne `KURA_SECRET_KEY`: `PUT` gibt 503 `SECRET_KEY_REQUIRED` (wie bei Immich); GET/DELETE gehen.
- Audit: `credential.instagram_save` und `credential.instagram_delete` (Ziel = Benutzer-ID); abgelehnte Schreibzugriffe schreibt der bestehende Hook als `put.rejected`. Kein Inhalt.
- `POST /api/v1/sources/validate` und `/subscriptions/:id/validate` liefern für Instagram zusätzlich `credentials: { platform, stored, loginNeeded }` (`loginNeeded` nur für Profile ohne gespeicherte Cookies). Die zwei Sätze „Cookies können in dieser Version noch nicht hinterlegt werden“ sind ersetzt (verlangt von IG-A).

**Worker.** Bei Instagram-Zielen lädt der Executor die Cookies des Besitzers des Laufs (`lease.userId`), entschlüsselt sie im Speicher, legt ein eigenes privates Laufverzeichnis (0700, `createRunWorkspace`) unter `KURA_WORK_DIR` an und schreibt darin `instagram-cookies.txt` mit `O_EXCL` und Modus 0600. Der Pfad geht als `credentials.cookiesFilePath` in den `jobContext` (probe, discover), in den dritten Parameter von `resolveAssets` und in den `context` von `storeAsset` (genau die Stellen aus „Einbindung für IG-B“). Im `finally` von `syncTarget` werden Datei und Verzeichnis gelöscht (Fehler, Abbruch, Timeout, Lease-Verlust laufen alle durch dieses `finally`). `last_used_at` wird beim Schreiben der Datei gesetzt.

- Meldet der Adapter `AUTH_REQUIRED`, obwohl Cookies benutzt wurden: `last_result = auth_required`, Text „Instagram-Anmeldung abgelaufen: bitte Cookies neu hochladen. Das Abonnement wurde pausiert.“, Zustand `waiting_auth`, Abo pausiert (wie bisher).
- Ohne gespeicherte Cookies und `AUTH_REQUIRED`: `waiting_auth` mit „Instagram verlangt eine Anmeldung: bitte lade unter Konto, Instagram, deine Cookies hoch und setze das Abonnement danach fort. …“.
- Lauf ohne Befund mit Cookies: `last_result = ok`. Andere Fehler (Netz, Prozess) lassen `last_result` unverändert.
- Cookies nicht lesbar (falscher oder fehlender Schlüssel im Worker, Blob manipuliert): neuer Code `CREDENTIALS_UNREADABLE`, `waiting_auth`, Abo pausiert, gallery-dl wird gar nicht gestartet, `last_result = auth_required`.
- Nie ins Log: weder Inhalt noch Dateipfad (getestet gegen Worker-Log, `download_runs` und API-Log).

**Oberfläche** (Konto, Abschnitt „Instagram“, keine neue Navigation): Risikohinweis als Banner (Wortlaut aus der Karte), Export-Anleitung (Wortlaut aus der Karte), Statusfeld (Chip „Cookies hinterlegt“ / „Anmeldung abgelaufen“ / „Cookies abgelaufen“, Anzahl, früheste Ablaufzeit, zuletzt benutzt, Ergebnis), Dateiauswahl (`accept=".txt,text/plain"`, 256-KiB-Prüfung im Browser), „Cookies löschen“ mit Bestätigungsdialog, Hinweis bei fehlendem `KURA_SECRET_KEY` (Upload gesperrt). In der Adressprüfung (Abo-Formular und Detail) erscheint der Chip „Anmeldung nötig“ für Instagram-Profile ohne gespeicherte Cookies. Keine Gedankenstriche, keine Emojis (Test prüft Striche). Neue Statusbegriffe stehen in `status.ts` (die eine Stelle für Chips). Bildschirmfoto mit dem echten API-Stack (`tests/ui-shots/capture.mjs --only=account`, 1440 hell/dunkel und 390 breit): Abschnitt passt zur übrigen Seite, kein Überlauf.

## Änderungen außerhalb der Neudateien (jede einzeln, mit Rückweg)

| Datei | Was | Warum | Rückweg |
| --- | --- | --- | --- |
| `apps/api/src/immich-routes.ts` | `encryptSecret`/`decryptSecret` exportiert, optionaler Parameter `aad` | ein Krypto-Pfad; Plan 06 verlangt AAD | `git revert 16a7ba8` (Immich-Verhalten ohne `aad` unverändert) |
| `apps/worker/src/handover.ts` | `decryptSecret` exportiert, optionaler `aad` | wie oben, Worker-Seite | wie oben |
| `apps/api/src/app.ts` | Route registriert | | wie oben |
| `apps/api/src/source-routes.ts` | `validate(url, userId)`, Hinweise, Feld `credentials` | „Anmeldung nötig“, alte Sätze streichen | `git revert 8d8924f` |
| `apps/worker/src/executor.ts`, `worker.ts` | Zugangsdaten bereitstellen, im `finally` entfernen, Ergebnis festhalten; `secretKey` in den Executor | Kern von Lieferung 3 | `git revert 06bf5c7` |
| `apps/web/src/api.ts` | `Content-Type` nur setzen, wenn nicht schon gesetzt; drei neue Aufrufe; zwei Typen | Upload als `text/plain` | `git revert 49d5ac4` |
| `apps/web/src/App.tsx`, `SourceCheck.tsx`, `status.ts` | Abschnitt einbinden, Chip, Status „credential“ | | wie oben |
| `.env.example`, `docs/vm-setup.md` | Schlüssel auch für Cookies; neuer Abschnitt „Instagram access“ | | `git revert` des Doku-Commits |

`packages/adapters`: **nicht angefasst.** Keine bestehende Migration, kein bestehender Test geändert, keine neue Abhängigkeit, keine verbotene Datei berührt (geprüft mit `git diff fb874f9 --stat`: nur Pfade aus der Liste „darf ändern“).

## Prüfung

Ausgeführt:

- `corepack pnpm check` (eslint, Typprüfung aller Pakete, vitest auf echter PostgreSQL, Build): grün, Zahlen oben. `pnpm audit --audit-level=high`: Exit 0.
- Web-Suite einzeln: 58 Tests grün. Bildschirmfotos der Kontoseite (Stack aus `tests/ui-shots`, echte API, gebaute Weboberfläche).
- API-Tests (24, `tests/instagram/credentials-api.test.ts`, echte PostgreSQL, echte App via `inject`): Verschlüsselung im Ruhezustand (Chiffrat und Nonce enthalten weder `sessionid`, `csrftoken`, `instagram`, `Netscape` noch einen der Fake-Werte; sonst keine Spalte mit Inhalt; Entschlüsselung nur mit richtigem Benutzer-AAD und Schlüssel), zwei Benutzer getrennt (Status, Löschen, Überschreiben), 401/403 ohne Sitzung/CSRF, Größengrenze exakt, Formatfehler (leer, nicht Netscape, JSON, Leerzeichen statt Tabs, falsche Flags/Ablaufzeit, Binärdaten), Fremddomains und Lookalikes entfernt, ohne `sessionid` abgelehnt (auch leer, abgelaufen, falsche Domain), frisches Nonce je Upload, `last_result` wird beim neuen Upload `unknown`, Löschen entfernt die Zeile, 503 ohne Schlüssel, Audit ohne Inhalt, **kein Inhalt in irgendeiner Antwort, im Audit oder im mitgeschnittenen API-Log** (auch nicht für abgelehnte Uploads), Adressprüfung (`loginNeeded`).
- Worker-Tests (12, `credentials-worker.test.ts`, echte PostgreSQL, Fake-gallery-dl mit Beobachter): gallery-dl sieht `-C <Datei>` mit Modus 600 im Verzeichnis 700 und dem erwarteten Inhalt, bei jedem Aufruf (Listing und Downloads); danach existiert weder Datei noch `run-*`-Verzeichnis; **auch wenn das Werkzeug mit Fehler endet** und **auch bei Abbruch mitten im Lauf** (die Datei existiert nachweislich, solange das Werkzeug läuft); `auth_required` und der Text „Anmeldung abgelaufen“; ohne Cookies Lauf ohne `-C` mit dem Upload-Hinweis (Profil und Einzelbeitrag); Cookies eines anderen Benutzers werden nie benutzt; falscher Schlüssel und fehlender Schlüssel im Worker starten das Werkzeug nicht; andere Plattformen berühren die Cookies nicht; private-Profil- und Checkpoint-Satz bleiben; kein Inhalt und kein Dateipfad in Worker-Log und Verlauf.
- Mutationsproben: (1) `credentials.dispose()` im `finally` entfernt: 4 Tests scheitern. (2) Dateimodus 0644 statt 0600: 3 Tests scheitern. (3) `recordResult('auth_required')` entfernt: 1 Test scheitert. Danach jeweils wiederhergestellt (Datei per `diff` gegen die Sicherung geprüft).

Nicht geprüft:

- **Echter Instagram-Abruf.** Kein einziger Request an Instagram, kein echtes Konto, keine echten Cookies. Ob gallery-dl mit einer echten Browser-Exportdatei (Cookie-Format verschiedener Erweiterungen) tatsächlich angemeldet ist, ob die Sitzung Instagram akzeptiert und wie lange sie hält, ist offen. Alle Tests nutzen Fake-Werte und den Fake-gallery-dl aus IG-A.
- Ob die installierte `gallery-dl.bin` der VM `-C` und `cookies-update=false` wie die PyPI-Quellen behandelt (aus IG-A übernommen, weiterhin nicht ausgeführt).
- Abbruch durch **Zeitüberschreitung** des Werkzeugs als eigener Test: der Weg ist derselbe `finally` wie beim getesteten Abbruch und beim Fehler; ein Test mit echtem Timeout fehlt.
- Absturz des Worker-Prozesses (SIGKILL) mitten im Lauf: nicht getestet; dort greift nur die bestehende Bereinigung verwaister `run-*`-Verzeichnisse (älter als 24 Stunden, siehe Risiken).
- Zustand „Cookies hinterlegt“ im echten Browser: nur im jsdom-Test (die Bildschirmfotos zeigen den Zustand „keine Cookies“).
- Dateiauswahl über echten Browser-Dateidialog nicht ausgeführt (jsdom setzt die Datei direkt).
- Schlüsselrotation: nicht umgesetzt (siehe Risiken).

## Annahmen

1. Hochgeladen wird die cookies.txt als `text/plain`-Body, nicht als JSON oder multipart (keine neue Abhängigkeit nötig, 256 KiB passen in den Fastify-Standard).
2. „Nur Cookies für instagram.com / .instagram.com“ lese ich als: der Domain-Name selbst oder ein echtes Subdomain davon (z. B. `www.instagram.com`). Cookies ganz anderer Seiten und Lookalikes werden verworfen. Das `sessionid`-Cookie muss exakt für `instagram.com` (mit oder ohne führenden Punkt) sein, nicht nur für ein Subdomain.
3. Ein bereits abgelaufenes `sessionid` ist wie ein fehlendes zu behandeln (Ablehnung mit eigenem Text). Das steht nicht in der Karte, ist aber derselbe Zweck.
4. „Früheste Ablaufzeit“ gilt für alle behaltenen Cookies mit Ablaufzeit; Sitzungs-Cookies (Ablauf 0) zählen nicht. Sind alle Sitzungs-Cookies, ist sie leer (`null`).
5. Die Originaldatei wird nicht gespeichert, sondern aus den behaltenen Cookies neu geschrieben. Das ist die kleinste sichere Lösung, damit Fremdzeilen und Kommentare nie in die Datenbank gelangen.
6. Der neue Upload ersetzt die Zeile (gleiche `id` und `created_at`, neues Nonce, `last_result` wird `unknown`, `last_used_at` bleibt).
7. Bei `AUTH_REQUIRED` ohne Cookies wird das Werkzeug trotzdem einmal gestartet (kein Kurzschluss vor dem Start). Grund: Die bestehenden IG-A-Tests und das Verhalten „Beitrag ohne Anmeldung kann gehen“ setzen das voraus; der Hinweistext kommt aus dem Ergebnis.
8. Die Texte der Weboberfläche folgen dem Wortlaut der Karte (Du-Form). Die übrige Oberfläche und die IG-A-Sätze im Adapter sprechen noch mit „Sie“; das habe ich nicht vereinheitlicht.
9. Bei `CREDENTIALS_UNREADABLE` setze ich `last_result = auth_required`, damit die Oberfläche „Anmeldung abgelaufen“ zeigt; die Handlung (neu hochladen) ist dieselbe.
10. gallery-dl liest die von uns geschriebene Datei, wie `-C` es laut IG-A-Quelltextbeleg vorsieht (Python-`MozillaCookieJar`-kompatibel, `#HttpOnly_`-Zeilen und Kopfzeile bleiben erhalten); nicht gegen die echte Binary geprüft.

## Risiken

- **Abweichung von der Karte (bitte prüfen):** Für zwei Instagram-Fälle bleibt der genauere Satz des Adapters, statt „Anmeldung abgelaufen“: privates Profil und Checkpoint (Sicherheitsprüfung). Dort sind die Cookies meist gültig, und „abgelaufen“ wäre falsch; ein bestehender IG-A-Test verlangt außerdem „Profil ist privat“. `last_result` wird in diesen Fällen trotzdem `auth_required` (Wortlaut der Karte: `AUTH_REQUIRED` mit Cookies). Die Erkennung läuft über die zwei deutschen Schlüsselwörter („privat“, „Sicherheitsprüfung“), ein Test pinnt sie gegen den Adaptertext. Alle anderen `AUTH_REQUIRED`-Texte sind ersetzt.
- **Absturz im Lauf:** Bei SIGKILL des Workers bleibt die 0600-Datei im 0700-Verzeichnis liegen, bis die vorhandene Bereinigung (24 Stunden) sie entfernt. `KURA_WORK_DIR` ist im Container nicht persistent und nicht geteilt. Das ist der Weg „Absturzpfad durch Laufverzeichnis-Bereinigung“ aus der Karte, aber 24 Stunden sind länger als „kurzer Lebenszyklus“ idealerweise. Eine kürzere Frist für die Zugangsdaten-Verzeichnisse wäre ein kleiner Folgeauftrag.
- **Schlüsselrotation fehlt** (Plan 06 verlangt sie, auch für Immich noch nicht vorhanden): ein Schlüsselwechsel macht gespeicherte Cookies unlesbar; Benutzer müssen neu hochladen. Das Chiffrat hat keine Schlüsselversion.
- **Metadaten im Klartext:** Anzahl und früheste Ablaufzeit stehen unverschlüsselt in der Zeile (kein Inhalt, aber sichtbar für jeden mit Datenbankzugriff).
- **Kontorisiko bei Instagram:** Die Sitzung gehört dem Benutzer; Sperren durch Instagram sind möglich (steht im Hinweis in der Oberfläche). Die Taktung kommt aus IG-A.
- Die Cookie-Datei liegt für die Dauer des Laufs (bis zu mehrere Minuten bis Stunde) im Dateisystem des Worker-Containers; jeder Prozess im Container mit gleichem Benutzer kann sie lesen (gallery-dl selbst eingeschlossen, das ist der Zweck). Ein geschützter Kanal ohne Datei (Plan 04 „bevorzugt“) steht mit `-C` nicht zur Verfügung; der Adapter von IG-A gibt nur einen Dateipfad weiter.
- Die Statusanzeige „Zuletzt benutzt“ ändert sich mit jedem Lauf, auch einem abgebrochenen (gesetzt, sobald die Datei geschrieben wird).

## Offene Fragen

- Soll ein Hochladen neuer Cookies ein wegen `waiting_auth` pausiertes Abonnement automatisch fortsetzen? Heute nicht: Der Hinweis sagt „setze das Abonnement danach fort“. (Nicht Teil der Karte.)
- Kürzere Bereinigungsfrist für die Zugangsdaten-Verzeichnisse (z. B. beim Worker-Start sofort alle entfernen)? Folgeauftrag, falls gewünscht.
- Soll die Text-Form („du“ in diesem Abschnitt, „Sie“ sonst) vereinheitlicht werden? Entscheidung beim Auftraggeber.

## Betrieb auf der VM (was der Auftraggeber tun muss, um es zu testen)

Voraussetzungen: gallery-dl auf der VM installiert und mit Hash eingetragen (`KURA_GALLERYDL_PATH`/`_SHA256`), Egress-Sperre eingerichtet und `KURA_EXTERNAL_TOOLS_EGRESS_CONFIRMED=true` (sonst startet gallery-dl nie; siehe `docs/vm-setup.md`), `KURA_SECRET_KEY` in `~/.config/kura/kura.env` (derselbe Wert für API und Worker; `openssl rand -base64 32`).

1. `kura-deploy.sh` neu ausführen. Die Migration `0052_platform_credentials` läuft beim Start der API. Prüfen: `podman logs --tail 20 kura-app` ohne Fehler, in der Oberfläche unter Übersicht „Angewendete Migrationen“ ist die letzte Version `0052_platform_credentials`.
2. Ein **eigenes** Instagram-Konto verwenden, nicht das Hauptkonto. Im Browser dort anmelden, mit einer Browser-Erweiterung „cookies.txt“ im Netscape-Format für `instagram.com` exportieren. Die Datei muss eine Zeile mit `sessionid` für `.instagram.com` enthalten (nicht an Dritte weitergeben, nicht ins Repository legen).
3. In Kura: Konto, Abschnitt „Instagram“, Datei wählen, „Hochladen“. Erwartet: Meldung „Gespeichert: N Cookies von instagram.com …“, Status „Cookies hinterlegt“, Anzahl und früheste Ablaufzeit; der Inhalt wird nirgends angezeigt. Eine Datei ohne `sessionid` muss abgelehnt werden.
4. Abonnements, „Abonnement anlegen“, Ziel `https://www.instagram.com/<eigenes-oder-freigegebenes-Profil>/`, „Adresse prüfen“. Erwartet: ohne hochgeladene Cookies erscheint „Anmeldung nötig“, mit Cookies nicht. Speichern, „Jetzt ausführen“.
5. Verlauf beobachten. Erwartet bei gültiger Sitzung: Beiträge werden gespeichert (je Datei ein Asset, begrenzter Erstlauf, `KURA_INSTAGRAM_MAX_POSTS_PER_RUN`). Auch einzelne Reels und Fotobeiträge (`/reel/…`, `/p/…`) als eigene Abos ausprobieren.
6. Fehlerweg prüfen: Cookies im Konto löschen (Bestätigungsdialog), Lauf starten. Erwartet: Zustand „wartet auf Anmeldung“ mit dem Hinweis, Cookies hochzuladen, Abo pausiert. Mit einer absichtlich abgelaufenen Datei: „Instagram-Anmeldung abgelaufen: bitte Cookies neu hochladen“.
7. Aufräumen prüfen: nach einem Lauf `podman exec kura-worker ls /var/lib/kura/staging` zeigt kein `run-*`-Verzeichnis; `podman logs kura-worker | grep -ci sessionid` ergibt 0.
8. Danach Testkonto-Sitzung im Browser beenden und die Cookies in Kura löschen.

## Nächster Schritt

Review (Lesart der Abweichungen oben) und Verifier-Lauf; danach echter Test auf der VM mit einem Testkonto (Abschnitt „Betrieb auf der VM“). Der Orchestrator entscheidet über die offenen Fragen (Auto-Fortsetzen, kürzere Bereinigungsfrist, Anrede).

## Stimmen

[Iroha] Zwei Dinge gespart: kein zweiter Krypto-Pfad (nur ein optionaler Parameter) und kein Kurzschluss vor dem Werkzeugstart. Das Zweite kostet einen unnötigen Start ohne Cookies, aber die IG-A-Tests bleiben unangetastet.

[Yui] Ich würde die 24 Stunden für liegengebliebene Cookie-Dateien nach einem Absturz nicht gern so lassen. Das steht deshalb bei den Risiken und den offenen Fragen. Und die Sätze für „privat“ und „Checkpoint“ habe ich bewusst nicht durch „abgelaufen“ ersetzt, weil das Benutzer in die Irre führen würde; das bitte ausdrücklich bestätigen.
