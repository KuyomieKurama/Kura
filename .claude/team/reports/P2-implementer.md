# P2 Implementer: YouTube (Kanäle, Playlists), Pornhub (Videolisten, Fotoalben)

- Aufgabe: `t_b1b560a5` P2 YouTube-Playlists und Kanäle, Pornhub (yt-dlp). Anforderung REQ-DL-005, req_hash `66b20a66d9133e08`.
- Status: braucht Review (Umsetzung vollständig, echter Abruf nicht geprüft).
- Artefakte: Branch `lane/instagram`, Worktree `/work/wt/ig`, 11 Commits nach `1c4d159` (Stand P1), Baum sauber, nichts gepusht. Dieser Bericht.
- Zusammenfassung: siehe „Was geändert wurde".
- Prüfung: `corepack pnpm check` grün: vorher 50 Dateien / 996 bestanden / 1 übersprungen, nachher 55 Dateien / 1208 bestanden / 1 übersprungen (typecheck, lint, Tests mit PostgreSQL, Build). Darin die Web-Tests (12 Dateien, 69 Tests, davon 4 neu in `Platforms.test.tsx`). `pnpm audit --audit-level=high`: keine Funde ab „high" (1 low, 1 moderate, unverändert gegenüber P1, keine neue Abhängigkeit).

## Was geändert wurde (und warum)

1. Adressen (streng, kanonische Adresse nur aus geparsten Teilen, Query und Fragment verworfen).
   - `packages/adapters/src/youtube-target.ts` neu: Video (`/watch?v=`, `youtu.be/`, `/shorts/`, `/live/`), Playlist (`/playlist?list=`), Kanal (`/@name`, `/channel/UC…`, `/c/`, `/user/`) mit Reiter `/videos`, `/shorts`, `/streams`. Ein Kanal ohne Reiter wird `/videos`. `watch?v=…&list=…` ist das Video. Automatische Listen (`RD`, `WL`, `LL`, `LM`, `TL`, `UL`, `PU`, `EC`) werden immer abgelehnt, weil ihr Inhalt vom Moment oder Konto abhängt.
   - `packages/adapters/src/pornhub-target.ts` neu: Video (`view_video.php?viewkey=`), Videos eines Models, Pornstars, Kanals oder Benutzers (auch `/videos`, `/videos/upload`), Playlist, Fotoalbum (`/album/<n>`). Pornhub Premium, Einzelfotos, `/photos` und Kategorien werden mit eigenem deutschem Satz abgelehnt.
2. yt-dlp-Adapter (`yt-dlp-adapter.ts` neu geschrieben, `yt-dlp-output.ts` neu): YouTube, Pornhub, Instagram-Rückfall.
   - Liste: `--flat-playlist --dump-single-json --playlist-items 1:N`, N je Plattform begrenzt (Standard 50). Kura schneidet zusätzlich selbst auf N, falls das Werkzeug mehr liefert. Einträge ohne gültige Kennung, mit fremder Erweiterung (`ie_key`) oder mit Optionsähnlichem werden übersprungen und nie als Argument verwendet.
   - Einzelvideo: `-f bestvideo*+bestaudio/best --merge-output-format mp4/webm/mkv` in Metadaten- und Downloadaufruf; die Endung nennt yt-dlp (`ext`), die Medienart folgt daraus.
   - Zustände je Eintrag: laufender Livestream, Premiere, angekündigtes Live-Event → neuer Code `ASSET_NOT_YET_AVAILABLE` (kein Fehler des Laufs, nächster Lauf prüft erneut). Privat, entfernt, Regionssperre, Pornhub entfernt/Weiterleitung → `ASSET_NOT_ACCESSIBLE` mit festem deutschem Grund. Altersbeschränkt und Mitglieder: ohne Cookies `AUTH_REQUIRED`, mit Cookies Zustand des Eintrags.
   - Fehlerklassifikation (`classifyYtDlpFailure`) nur auf Zeilen `ERROR:`; `WARNING:` entscheidet nichts. Bot-Prüfung → `AUTH_REQUIRED` mit Cookie-Hinweis (anderer Satz, wenn schon Cookies hinterlegt sind). 429 und „try again later" → `RATE_LIMITED`. Fehlender Kanal, Reiter oder Playlist → `TARGET_NOT_FOUND`. Fehlendes ffmpeg → `BINARY_NOT_CONFIGURED` (Worker: „Werkzeug nicht installiert"). Tool-Text steht nur in `untrustedDiagnostics`, nie in `message` oder `userMessage`.
   - Cookies: nur YouTube, nur als `--cookies <Datei>`. Nie für Pornhub oder Instagram über diesen Adapter.
3. gallery-dl: Pornhub-Fotoalbum (`gallery-dl-adapter.ts`, `gallery-dl-listing.ts`). Ein Album ist ein Beitrag, jedes Foto ein Asset (`photo-<id>`), Download über `--range <Position>`. Keine Cookies. `norights` → `AUTH_REQUIRED` mit Pornhub-Satz, 404 → `TARGET_NOT_FOUND`. Dateien eines anderen Albums → `OUTPUT_INVALID`.
4. Worker: `executor.ts` setzt bei `ASSET_NOT_YET_AVAILABLE` keinen Lauf-Fehler (`markAssetFailed` wird trotzdem aufgerufen, damit der Eintrag im Verlauf steht). `config.ts`: `KURA_YOUTUBE_MAX_POSTS_PER_RUN`, `KURA_PORNHUB_MAX_POSTS_PER_RUN` (1–500, Standard 50). `.env.example` dokumentiert beide.
5. API (`source-routes.ts`): Hinweise je Adressart (Kanal-Reiter, Playlist, „Adresse nennt auch eine Playlist"), Pornhub „ohne Anmeldung", `addressKinds` je Adapter und Quelle in `/api/v1/adapters`, Ablehnungstext nennt die neuen Quellen.
6. Web: Adapterübersicht listet Adressarten je Plattform; ein laufender Livestream erscheint als „Noch nicht verfügbar" (warnend, mit Grund), nicht als Fehler (`Ledger.tsx`, `history-labels.ts`, `Adapters.tsx`, `components.css`).
7. Doku: `docs/vm-setup.md`, Abschnitt „YouTube and Pornhub (yt-dlp)".

Rückgängig: `git revert` der 10 Commits (`git log 1c4d159..HEAD`). Keine Migration, keine Datenänderung. Bereits gespeicherte Einträge mit `ASSET_NOT_YET_AVAILABLE` bleiben als `failed` in der Datenbank und sind für ältere Versionen nur ein unbekannter Code-Text.

Kompatibilität: Der Typ `unavailable.code` wurde um `ASSET_NOT_YET_AVAILABLE` erweitert. Der `PLATFORM_SETTINGS` von gallery-dl ist jetzt `Partial<Record<SourceType, …>>`.

## Tests

- `tests/platforms/youtube-pornhub-targets.test.ts` (113): Adressregeln, Optionsinjektion, Routing, Fähigkeiten je Quelle.
- `tests/platforms/ytdlp-adapter.test.ts` (64): Adapter gegen `fake-ytdlp.ts` mit echten Ausgaben: Argumentlisten, Kappe, Inkrementalität über stabile Kennungen, Livestream, Premiere, Fehlerklassen, Cookies (Datei lesbar, 0600, Inhalt nie in Argumenten, Umgebung oder Fehlern), gefälschte Beiträge.
- `tests/platforms/ytdlp-worker.test.ts` (9): ganze Läufe durch Worker und echtes PostgreSQL: gemischter Kanal, zweiter Lauf lädt nichts doppelt, Stream endet und wird nachgeholt, neues Video, Playlist, Bot-Prüfung (pausiert, `waiting_auth`), Cookie-Datei gelöscht und nicht im Log, 429, fehlender Kanal, privates Einzelvideo, Pornhub-Liste.
- `tests/platforms/pornhub-album.test.ts` (4), `tests/platforms/sources-api.test.ts` (20, inkl. keine Gedankenstriche/Emoji in Texten), `apps/web/src/Platforms.test.tsx` (4).
- Angepasst, weil die Annahme nicht mehr stimmt: `tests/adapters/gallery-dl-adapter.test.ts`, `tests/adapters/yt-dlp-adapter.test.ts`, `tests/m5b/source-api.test.ts` (Fähigkeiten), `tests/m5b/pipeline-tools.test.ts` (Playlists werden unterstützt; ungültige Playlist-ID bleibt `TARGET_INVALID`).
- Fixtures (`tests/platforms/fixtures/`): aus dem echten Code von yt-dlp 2026.8.19 und gallery-dl 1.32.16 mit ersetzter Netzwerkschicht, nur synthetische Daten (`generate-ytdlp-fixtures.py`, `generate-pornhub-album-fixture.py`). Die Skripte laufen nicht in der Test-Suite. `verify-ytdlp-download.py` führt das echte yt-dlp mit Kuras Download-Argumenten gegen einen lokalen Server aus (Ergebnis: Exit 0, genau eine Datei `asset.mp4`).

## Optionen von yt-dlp 2026.8.19 und ihre Quelle

Quelle ist die Quelldistribution `yt_dlp-2026.8.19` (sdist), Datei `yt_dlp/options.py` mit Zeile der Definition. Jede Argumentliste, die der Adapter erzeugt, wurde zusätzlich mit `parseOpts` des echten yt-dlp zerlegt (Ergebnis siehe unten).

| Option | Verwendung | Quelle |
| --- | --- | --- |
| `--ignore-config` | keine Konfigurationsdateien des Hosts | `options.py` Z. 424 |
| `--no-update` | kein Selbst-Update | `options.py` Z. 370 |
| `--no-cache-dir` | kein Cache auf der Platte | `options.py` Z. 1568 |
| `--no-warnings` | Warnungen nicht auf stderr (Fehlerzeilen bleiben) | `options.py` Z. 1234 |
| `--yes-playlist` / `--no-playlist` | Liste lesen / nur das Video | `options.py` Z. 773 / 769 |
| `--flat-playlist` | Einträge nur auflisten (`extract_flat=in_playlist`) | `options.py` Z. 502 |
| `--dump-single-json` | eine JSON-Ausgabe für die ganze Liste | `options.py` Z. 1312 |
| `--playlist-items 1:N` | Kappe je Lauf (`-I`) | `options.py` Z. 691 |
| `--cookies <Datei>` | nur YouTube und nur mit hinterlegtem Zugang | `options.py` Z. 1539 |
| `-f bestvideo*+bestaudio/best` | beste Video- und beste Audiospur, sonst bestes Gesamtformat | `options.py` Z. 879 |
| `--merge-output-format mp4/webm/mkv` | Container nach Reihenfolge; yt-dlp nimmt den ersten, der die Codecs trägt (`get_compatible_ext` in `utils/_utils.py` Z. 3100) | `options.py` Z. 156 |
| `--abort-on-unavailable-fragments` | fehlendes Fragment bricht ab statt unvollständig zu speichern | `options.py` Z. 1053 |
| `--extractor-retries 0` | keine automatische Wiederholung | `options.py` Z. 1905 |
| `--sleep-requests 1` | 1 s zwischen Anfragen | `options.py` Z. 1205 |
| `--sleep-interval 3 --max-sleep-interval 8` | 3 bis 8 s vor jedem Download | `options.py` Z. 1209, 1216 |
| `--no-progress`, `--no-mtime` | ruhige Ausgabe, Dateizeit nicht ändern | `options.py` Z. 1332, 1486 |
| `--max-filesize` | Obergrenze je Datei aus der Kura-Konfiguration | `options.py` Z. 711 |
| `-o asset.%(ext)s` | feste Ausgabedatei im Lauf-Verzeichnis | `options.py` Z. 1412 |

Bewusst nicht gesetzt: `--js-runtimes` (Standard `deno`, Z. 460; yt-dlp sucht deno auf `PATH`, `utils/_jsruntime.py`, und `PATH` ist `KURA_TOOL_PATH`), `--remote-components` (Z. 481, würde Code aus dem Netz laden), `--ffmpeg-location` (ffmpeg wird auf `PATH` gefunden, `postprocessor/ffmpeg.py`), `--exec`, `--proxy`, `--batch-file`, `--config-locations`, `--plugin-dirs`, `--external-downloader`, `--cookies-from-browser`. Keine Option entsteht aus Metadaten (D-007); die Adresse steht immer nach `--`.

Zerlegt mit `parseOpts` (Ergebnis): Liste: `extract_flat=in_playlist`, `playlist_items=1:50`, `noplaylist=False`, `cookies` nur bei YouTube; Einzelvideo: `format=bestvideo*+bestaudio/best`, `merge_output_format=mp4/webm/mkv`, `noplaylist=True`; Download: zusätzlich `sleep_interval=3.0`, `max_sleep_interval=8.0`, `skip_unavailable_fragments=False`.

Extraktoren (zur Erkennung der Adressarten gelesen): `extractor/youtube/_tab.py`, `_video.py`, `_base.py` (u. a. `_PLAYLIST_ID_RE`, Zeile 462), `extractor/pornhub.py` (`PornHubIE`, `PornHubUserIE`, `PornHubPagedVideoListIE`, `PornHubUserVideosUploadIE`, `PornHubPlaylistIE`), gallery-dl 1.32.16 `extractor/pornhub.py` (`PornhubGalleryExtractor`, sdist sha256 `bacd7d63423ad45db98704fedafa1302343db6f250f9e9f69a9e142754ed9e37`).

## Alle unterstützten Adressarten (alle Plattformen)

Status „getestet mit Fake" heißt: Adressregeln und Ablauf getestet, Werkzeug-Ausgabe aus Fixtures. Kein echter Abruf wurde ausgeführt, also steht überall zusätzlich „nicht geprüft: echter Abruf".

| Plattform | Adressart | Adapter | Anmeldung | Status |
| --- | --- | --- | --- | --- |
| YouTube | Einzelvideo (`watch?v=`, `youtu.be/`, `/shorts/`, `/live/`) | yt-dlp | optional (Cookies, für Altersgrenze und Mitglieder; Bot-Prüfung) | getestet mit Fake; nicht geprüft: echter Abruf |
| YouTube | Playlist (`/playlist?list=`) | yt-dlp | optional | getestet mit Fake; nicht geprüft: echter Abruf |
| YouTube | Kanal (`/@name`, `/channel/UC…`, `/c/`, `/user/`) mit Reiter Videos, Shorts, Livestreams | yt-dlp | optional | getestet mit Fake; nicht geprüft: echter Abruf |
| YouTube | `watch?v=…&list=…` | yt-dlp | optional | als Einzelvideo; getestet mit Fake |
| YouTube | `WL`, `LL`, `LM`, `RD…` (Mix, Verlauf, gemerkte Videos), Reiter Playlists/Community, Feeds | keiner | n. a. | abgelehnt mit eigenem Satz; getestet |
| Pornhub | Einzelvideo (`view_video.php?viewkey=`) | yt-dlp | keine | getestet mit Fake; nicht geprüft: echter Abruf |
| Pornhub | Videos von Model, Pornstar, Kanal, Benutzer (auch `/videos`, `/videos/upload`) | yt-dlp | keine | getestet mit Fake; nicht geprüft: echter Abruf |
| Pornhub | Playlist (`/playlist/<n>`) | yt-dlp | keine | getestet mit Fake; nicht geprüft: echter Abruf |
| Pornhub | Fotoalbum (`/album/<n>`) | gallery-dl | keine | getestet mit Fake; nicht geprüft: echter Abruf |
| Pornhub | Einzelfoto, `/photos`, Kategorien, Premium | keiner | n. a. | abgelehnt mit eigenem Satz; getestet |
| Instagram | Profil und Reels-Reiter | gallery-dl | Cookies nötig bei Feeds | unverändert seit IG-A/IG-B, Tests laufen weiter; nicht geprüft: echter Abruf |
| Instagram | Beitrag, Karussell, Reel | gallery-dl (Rückfall yt-dlp für Reel/Beitrag) | Cookies | unverändert; Rückfall bei P2 neu in yt-dlp; nicht geprüft: echter Abruf |
| Patreon | Creator, Einzelbeitrag | gallery-dl | Cookies (`session_id`) | unverändert seit P1; nicht geprüft: echter Abruf |
| Pixiv | Künstler, Einzelwerk | gallery-dl | Token | unverändert seit P1; nicht geprüft: echter Abruf |
| Direkte URL | Bild-, Video-, Audiodatei | direct-url | keine | unverändert; getestet |

## Nicht geprüft (bitte nicht als belegt lesen)

- Kein echter Netzwerkzugriff auf YouTube oder Pornhub. Fixtures zeigen die Form des Werkzeugs, nicht das Verhalten der Seiten. Der Wortlaut echter Fehlertexte kann sich ändern; Erkennung ist nach Muster, unbekannte Fehler bleiben `PROCESS_FAILED`.
- Das Zusammenfügen zweier Streams mit ffmpeg wurde nicht ausgeführt: auf der Entwicklungsmaschine gibt es kein ffmpeg und kein deno. `verify-ytdlp-download.py` prüft nur einen Format-Download mit einem Stream.
- YouTube mit deno und `yt-dlp-ejs`, Pornhub hinter Cloudflare (`curl_cffi`), Altersprüfung, Mitgliedervideos, Kappe auf einem echten langen Kanal.
- Die Standalone-Binärdatei `yt-dlp_linux` (VM) ist nicht die Quelldistribution, gegen die ich gelesen habe (sdist 2026.8.19). Gleiche Version laut D-026, aber nicht byteweise verglichen.

## Betrieb auf der VM (Testschritte, noch nicht ausgeführt)

Voraussetzung: Werkzeuge laut D-026 (yt-dlp, deno 2.9.7, ffmpeg/ffprobe n9.0 in `bin/`, `KURA_TOOL_PATH=/opt/kura-tools/bin`). Neue Variablen sind optional.

1. `ffmpeg -version` und `deno --version` im Worker-Container mit `PATH=/opt/kura-tools/bin` prüfen.
2. Quelle „Adresse prüfen" mit `https://www.youtube.com/@<eigener Kanal>`: erwartet Kanal-Hinweis, kein „Anmeldung nötig".
3. Abonnement mit kleiner Kappe (`KURA_YOUTUBE_MAX_POSTS_PER_RUN=3`), ein Lauf. Erwartet: drei Videos gespeichert, Endung `mp4` oder `webm` laut Streams, Verlauf zeigt sie.
4. Zweiter Lauf: erwartet „übersprungen" für die drei, keine neuen Downloads.
5. Ein eigenes Video auf privat stellen und einen eigenen Livestream starten (falls vorhanden): erwartet „privat" bzw. „Noch nicht verfügbar", Lauf nicht als Fehler.
6. Bot-Prüfung nur beobachten: wenn sie auftritt, erscheint „Anmeldung erforderlich" mit Cookie-Hinweis und das Abonnement ist pausiert. Dann Cookies unter Zugänge hinterlegen und fortsetzen.
7. Pornhub nur mit Inhalten, für die der Betreiber Rechte oder Erlaubnis hat. Videoliste und ein Album je einmal; erwartet: ohne Cookies, 403 wird als „Pornhub hat den Abruf abgelehnt" gemeldet.

## Annahmen (nicht verifiziert)

- Die Fixtures stammen aus dem echten Code von yt-dlp 2026.8.19 (sdist) und gallery-dl 1.32.16 mit ersetzter Netzwerkschicht. Auf der VM läuft die Standalone-Datei `yt-dlp_linux` (D-026), nicht die sdist. Gleiche Version, aber nicht byteweise verglichen.
- Gelesen, nicht gelaufen: Deno-Erkennung (`utils/_jsruntime.py`), ffmpeg-Suche, `curl_cffi`-Impersonation, Verhalten hinter Cloudflare.
- Die Fehlertexte von YouTube und Pornhub (Muster in `yt-dlp-output.ts`) stammen aus dem Quellcode der Extraktoren. Die Seiten können den Wortlaut ändern. Unbekannte Fehler enden als `PROCESS_FAILED`, nicht als falsche Klasse.
- `t_b1b560a5` ist die Phase P2 laut Kartentext; der Vorgänger `t_07de123b` ist P1.
- Ein `watch?v=…&list=…` bleibt das Einzelvideo (Vorgabe der Karte), die Oberfläche weist darauf hin.
- Livestreams und Premieren sind „Noch nicht verfügbar" und werden bei jedem Lauf erneut geprüft. Ein beendeter Livestream (`was_live`) wird wie ein normales Video geladen.
- Dateien: Bestehende Tests unter `tests/` wurden angepasst (nicht nur neue Dateien unter `tests/platforms/`), weil ihre Annahmen nicht mehr stimmen: `tests/adapters/gallery-dl-adapter.test.ts`, `tests/adapters/yt-dlp-adapter.test.ts`, `tests/m5b/source-api.test.ts`, `tests/m5b/source-selection.test.ts`, `tests/m5b/pipeline-tools.test.ts`. Das liegt über dem Wortlaut „new files under tests/platforms/**" der Karte; Vorbild ist das Vorgehen in P1.
- Dateien außerhalb der Liste: `apps/worker/src/worker.ts` (Durchreichen der Kappen) und `apps/worker/src/catalog.ts`, beide unter `apps/worker/**`, also erlaubt. Verbotene Pfade (Root-`package.json`, `tsconfig*.json`, `.github`, `deploy`, Planungsdokumente, `CLAUDE.md`, `.claude/team/*.md`, Migrationen, Immich-Client, Blobstore) wurden nicht geändert.

## Risiken

- YouTube kann Konten oder Adressen einschränken, die viel oder schnell abrufen. Taktung und Kappe sind vorsichtig, aber nicht gegen echte Schranken geprüft.
- Das Zusammenfügen der Streams hängt von ffmpeg auf `PATH` ab. Fehlt es, scheitert jedes Video mit „Werkzeug nicht installiert", nicht nur ein Eintrag.
- Einträge jenseits der Kappe werden nicht nachgeholt (siehe offene Fragen).
- Ein Eintrag mit `ASSET_NOT_YET_AVAILABLE` steht als `failed` in `download_assets`; Auswertungen, die nur `state` ansehen, zählen ihn als Fehler. Die Oberfläche unterscheidet über den Code.

## Offene Fragen

- [Yui] Einträge jenseits der Kappe werden später nicht nachgeholt (wie bei Instagram, Patreon, Pixiv). Für lange Playlists heißt das: Kappe erhöhen oder mehrere Abonnements. Soll es einen Nachlauf geben?
- [Yui] Die Sprachform bleibt wie in P1: Adapter-Meldungen mit „Sie", Worker- und Web-Texte mit „du". Soll das vereinheitlicht werden?
- [Iroha] Pornhub-Videos können Cloudflare auslösen. Falls das auf der VM passiert, braucht es ein yt-dlp mit `curl_cffi`; das ist eine Betriebsfrage, kein Code.

## Nächster Schritt

Review, dann Betrieb auf der VM nach den Schritten oben (zuerst ffmpeg und deno im Worker-Container prüfen, dann ein eigener Kanal mit Kappe 3).
