# P1 Implementer: Patreon, Pixiv, YouTube-Cookies

Stand: Branch/Worktree `/work/wt/ig`, 6 Commits nach `2784bf5`. Gesamt-`pnpm check` grün (typecheck, lint, 50 Testdateien, 994 Tests, 1 übersprungen, build). Vorher: 47 Dateien, 943 Tests.

## Was geändert wurde (und warum)

1. Zugangsdaten für vier Plattformen (`platform_credentials`, Migration 0053, neu; 0052 unverändert).
   - `packages/adapters/src/credential-platforms.ts`: eine gemeinsame Plattformliste (instagram, patreon, pixiv, youtube), Art (`cookies` / `token`) und `credentialAad`.
   - `apps/api/src/credential-validators.ts`, `credential-routes.ts`: `/api/v1/credentials[/:platform]`. Cookies: nur Cookies der Plattform-Domains bleiben, Pflicht-Cookie je Plattform. Pixiv: ein Token (max. 1 KiB). Antworten enthalten nie den Inhalt.
   - `instagram-cookies.ts`, `instagram-routes.ts` sind dünne Shims, die IG-B-Tests laufen unverändert.
   - Rückgängig: Commit `b0517a9` zurücknehmen. Migration 0053 ist additiv (neuer CHECK, neue Spalte `kind`); ein Rückbau braucht ein Gegen-Skript, es gibt keins.
2. gallery-dl-Adapter (`gallery-dl-adapter.ts` neu geschrieben, `gallery-dl-listing.ts`, `patreon-target.ts`, `pixiv-target.ts` neu, `gallery-dl-output.ts`, `staging.ts`).
   - Patreon: Creator (`/name`, `/c/`, `/cw/`) und Einzelbeiträge. Pixiv: Künstler (artworks, illustrations, manga) und Werke. Kanonische Adresse wird aus geparsten Teilen gebaut, Query verworfen.
   - Zugangsdaten nie als Argument: Cookies per `-C <Datei>` (+ `cookies-update=false`), Pixiv-Token nur in der Config-Datei (`-c`), dort auch `cache.file` ins Run-Verzeichnis. YouTube: `yt-dlp --cookies <Datei>`.
   - Taktung: Patreon 3-6 s Anfrage/Prozess, 2-5 s je Datei; Pixiv 2-4 s / 1-3 s; `--retries 0`. `KURA_PATREON_MAX_POSTS_PER_RUN`, `KURA_PIXIV_MAX_POSTS_PER_RUN` (Standard 50).
   - Nicht abrufbare Dateien (eingebettetes Video anderer Seite, Patreon-HLS `ytdl:`, gesperrter Beitrag, Dateityp außerhalb der Erlaubnisliste) werden als `unavailable` mit festem deutschem Grund ausgewiesen und nie an das Tool übergeben. `ytdl:`-Adressen werden nicht geladen (D-007: gallery-dl würde ein eigenes ungeprüftes yt-dlp-Modul laden).
   - Ugoira: Original-Zip bleibt, daneben eine von Kura erzeugte JSON-Datei mit Frame-Zeiten (`kura-ugoira-timing-1`). Keine Umwandlung. Die JSON-Datei geht nicht an Immich.
   - Tool-Ausgabe gilt als nicht vertrauenswürdig: Grenzen (1000 Dateien je Beitrag, 5000 Frames, max. Delay), numerische IDs, Eintrag `-1` ist fatal.
3. Worker (`credentials.ts`, `executor.ts`, `history.ts`, `config.ts`, `catalog.ts`, `worker.ts`): `PlatformCredentials` ersetzt `InstagramCredentials`; Datei 0600 im Verzeichnis 0700, am Laufende gelöscht. Meldungen je Plattform (`CREDENTIAL_MESSAGES`). `unavailable`-Assets werden einmal als `failed` mit Grund gespeichert und nicht erneut versucht.
4. API Quellenprüfung (`source-routes.ts`): Hinweise und `loginNeeded` je Plattform (Pixiv immer, Instagram/Patreon bei Feeds, YouTube nie).
5. Web: `Credentials.tsx` ersetzt `Instagram.tsx` (Abschnitt „Zugänge", vier Zeilen, Pixiv-Anleitung für `gallery-dl oauth:pixiv`, YouTube als optional gekennzeichnet).
6. `docs/vm-setup.md`: Abschnitt „Patreon, Pixiv and YouTube access".

## Tests

- `tests/platforms/`: `credentials-api.test.ts` (API), `adapter.test.ts` (30 Tests gegen Fixtures), `credentials-worker.test.ts` (Handover, Berechtigungen, Löschen, Texte, nicht abrufbare Assets, Wiederholung ohne erneuten Download), `apps/web/src/Credentials.test.tsx` (15), zwei Tests in `tests/adapters/yt-dlp-adapter.test.ts`.
- Bestehende Tests angepasst, weil ihre Annahme nicht mehr stimmt: Pixiv/Patreon sind nicht mehr „nur Einzelbeitrag" (`gallery-dl-adapter.test.ts`, `config-and-api.test.ts`, `listing.test.ts`, `source-selection.test.ts`, `source-api.test.ts`); `no-deletion.test.ts` erlaubt `DROP CONSTRAINT` (Migration 0053 ersetzt einen CHECK, löscht keine Daten).
- Fixtures: `tests/platforms/fixtures/*.json` stammen aus den echten Extraktoren von gallery-dl 1.32.16 mit synthetischer HTTP-Schicht (`generate-fixtures.py`, wird von den Tests nicht ausgeführt). Keine echten Cookies oder Tokens im Repo; Werte tragen `FAKE-`.

## Belege: gallery-dl und yt-dlp

- gallery-dl 1.32.16, sdist sha256 `bacd7d63423ad45db98704fedafa1302343db6f250f9e9f69a9e142754ed9e37`: `extractor/patreon.py`, `pixiv.py` (`PixivAppAPI`, `ugoira_metadata`), `oauth.py`, `common.py`, `util.py` (`cookiestxt_load`), `job.py`, `option.py`, `docs/configuration.rst` gelesen.
- yt-dlp 2026.8.19 (`extractor/youtube/_base.py`, `options.py`): Cookies `LOGIN_INFO`, `*APISID`, Option `--cookies`.

## Annahmen (nicht verifiziert)

- Es lief kein echtes gallery-dl gegen echte Patreon- oder Pixiv-Server. Das Verhalten dort (Cloudflare-Prüfung bei Patreon, Rate-Limits, Textform von Fehlermeldungen auf stderr) stammt aus dem Quellcode und aus synthetischen Antworten. Die Muster in `gallery-dl-output.ts` für `posts are private` / `redirect to challenge page` sind teils Heuristik.
- Dass die Aufgabe `t_07de123b` dem Block P1 entspricht, ist eine Annahme.
- Das Pixiv-Token wird nur formal geprüft (Länge/Zeichen), nicht gegen Pixiv.
- Pixiv wartet bei Rate-Limit selbst fünf Minuten (`extractor/pixiv.py`); Kura erkennt das über das Timeout plus Logzeile.

## Offene Fragen

- [Yui] Sprachform: Die Adapter-Meldungen aus IG-A (und die neuen für Patreon/Pixiv in `gallery-dl-output.ts`) verwenden „Sie", die Worker- und Web-Texte aus IG-B/P1 „du". Ich habe jede Schicht in ihrer Form gelassen. Soll das vereinheitlicht werden?
- [Yui] Migration 0053 hat kein Rückwärtsskript. Reicht das für den Betrieb auf der VM?
- [Iroha] Es gibt keinen Test mit einem echten Pixiv-Konto. Das muss der Betreiber auf der VM machen, bevor man dem Token traut.

## Betrieb auf der VM (Kurzfassung)

1. Neue Version deployen (Migration 0053 läuft beim Start).
2. Konto, Zugänge: Patreon-cookies.txt hochladen (Cookie `session_id`), Pixiv-Token einfügen (Token vorher auf dem eigenen Rechner mit `gallery-dl oauth:pixiv` erzeugen).
3. Quelle `patreon.com/<creator>` bzw. `pixiv.net/users/<id>` prüfen („Anmeldung nötig" sollte verschwinden), Abo anlegen, einen Lauf auslösen und im Verlauf ansehen. Nicht abrufbare Dateien erscheinen mit Grund.
