# IG-A Instagram im gallery-dl-Adapter: Profile, Reels, Fotos, Karussell, Fehlerabbildung — Bericht Implementer

Task t_6b7d9316 · req REQ-DL-004 `e852201230c9a860` (Hash des Textes in `docs/requirements/REQ-DL-004.md` nachgerechnet: stimmt), Kontext REQ-DL-002 `5d6398de6dbb5063`, REQ-DL-003 `b83be904af3eded5` · Worktree `/work/wt/ig`, Branch `lane/instagram` (Basis `0a7065f`) · Iteration 1 · nichts gepusht

## Aufgabe

Slice A von REQ-DL-004: Der gallery-dl-Adapter soll alles erledigen, was der Auftraggeber von Instagram will: Profile, einzelne Reels, einzelne Fotobeiträge (auch Karussells). Slice B (Cookies je Benutzer in API/UI/Worker) folgt separat; hier nur die Adapterschnittstelle dafür.

## Status

**Fertig, braucht Review.** `corepack pnpm check` grün: vorher 38 Dateien / 738 bestanden / 1 übersprungen, nachher 45 Dateien / 907 bestanden / 1 übersprungen. Baum sauber, alles committet. **Nicht geprüft: jeder echte Instagram-Abruf** (Liste unten).

## Artefakte

Commits auf `lane/instagram` (englische Meldungen, neueste zuletzt):

- `ce2610b` Fehlercodes AUTH_REQUIRED, RATE_LIMITED, TARGET_NOT_FOUND und Worker-Zuordnung; Credentials-/Kontext-Typen
- `ee269e2` Instagram im gallery-dl-Adapter (Zielgrammatik, Profil-Discovery, Parser, Cookies-Schnittstelle, Fähigkeiten je Plattform, API/Web)
- `602f711` Worker-Einstellung `KURA_INSTAGRAM_MAX_POSTS_PER_RUN`, Teil-Discovery im Executor, erste Instagram-Tests
- `009e416` `--sleep-extractor`, restliche Tests (Fehler, Cookies, Pipeline, API, Web)
- dieser Bericht (eigener Commit)

Neue Dateien: `packages/adapters/src/instagram-target.ts`, `packages/adapters/src/gallery-dl-output.ts`, `tests/instagram/*` (7 Testdateien, Fake-Tool, 6 Fixtures, `generate-fixtures.py`), `apps/web/src/AdapterCapabilitiesPerPlatform.test.tsx`.

## Zusammenfassung

[Iroha] Kurz gesagt: Profile laufen jetzt über gallery-dl, jeder Beitrag eines Profils wird danach wie ein Einzelbeitrag behandelt. Das kostet Anfragen (je Beitrag ein Listing, je Asset noch eins), aber es ist der einfachste Weg, der Worker, History und Teilfertig-Logik unverändert nutzt.

[Yui] Wichtigster Fund, den ich selbst im Quelltext von gallery-dl 1.32.16 gelesen und mit dem echten Extraktor nachgestellt habe: Mit `--dump-json` ist der Exitcode **immer 0**, ein Fehler steht nur als Eintrag `[-1, {"error": "AuthRequired", ...}]` in der Ausgabe. Der bisherige Parser hätte daraus „Quelle nicht mehr vorhanden“ (SOURCE_GONE) gemacht, auch für Pixiv und Patreon. Das ist jetzt behoben (alle gallery-dl-Quellen), und ein Profil ohne Beitrag zählt nie als „keine neuen Beiträge“.

### Ziele (Deliverable 1)

- Profil `/<name>/`, auch ohne `www`, ohne Schrägstrich am Ende, Query/Fragment (`igsh`, `utm_*`, `img_index`) werden verworfen; Benutzername 1–30 Zeichen `[A-Za-z0-9._]`, mindestens ein Zeichen außer Punkten, kanonisch kleingeschrieben.
- Reels-Tab `/<name>/reels/`: **Entscheidung:** gleiche Quelle (`kind: creator_feed`, `platformId` = Benutzername), aber eigene kanonische URL `…/<name>/reels/` und damit eigener Abonnement-Hash und eigener Sync-Stand („nur Reels“). Dokumentiert in `instagram-target.ts`.
- Einzelbeitrag `/p/<code>/`, Reel `/reel/<code>/` und `/reels/<code>/` (kanonisch `/reel/`), auch `/<name>/p/<code>/` und `/<name>/reel/<code>/` (kanonisch ohne Namen). Shortcode 5–28 Zeichen `[A-Za-z0-9_-]` (gallery-dl schneidet alles über 28 Zeichen ab, ein längerer würde einen anderen Beitrag liefern).
- Reservierte Pfade (`p, reel, reels, tv, explore, accounts, stories, direct, about, legal, developer, …`, Liste in `INSTAGRAM_RESERVED_PATHS`) sind nie Profile.
- Alles andere: `TARGET_UNSUPPORTED` mit festem deutschen Satz in `AdapterError.userMessage` (Stories, Highlights, Markierte Beiträge, IGTV, Reels-Feed, Profil-Unterseiten „zurzeit nicht unterstützt“; zusätzliche Pfadteile; Startseite; reservierte Seiten). Ungültige Namen/Kennungen: `TARGET_INVALID` mit deutschem Satz. Die Eingabe steht nie in einem Satz.
- Auswahl: gallery-dl ist zuerst registriert und gewinnt; Profile gehen nie an yt-dlp (`instagram:user` bleibt `TARGET_BROKEN`, aber nur dort, wo gallery-dl nicht im Spiel ist). yt-dlp bleibt Fallback für Einzelbeitrag/Reel. Reservierte Namen nennt yt-dlp nicht mehr „defekt“.

### Fähigkeiten (Deliverable 2)

`capabilities()` von gallery-dl: flach (Vereinigung) `single_post, creator_feed, pagination, images, videos`, `auth_kind = cookies`. Neu: `bySourceType` + `capabilitiesForSourceType()`; Pixiv und Patreon bleiben `creator_feed:false, pagination:false, videos:false, auth_kind:none`. Die Zielprüfung der API zeigt die Fähigkeiten **des Ziels**, die Adapterliste zeigt sie je Plattform, wenn sie sich unterscheiden. Dokumentiert: Cookies sind für Einzelbeiträge optional (Instagram verlangt oft trotzdem eine Anmeldung), für Profile praktisch Pflicht.

### Profil-Discovery (Deliverable 3)

- `discover()` listet `https://www.instagram.com/<name>/posts/` (bei Reels-Tab `…/reels/`) mit `--post-range 1-N`. Das Profil selbst wird bewusst **nicht** übergeben: die Profil-URL ist bei gallery-dl ein Dispatcher, der je nach Konfiguration auch Info, Avatar, Stories, Highlights holt.
- Sortierung neueste zuerst nach Beitragsdatum (gepinnte Beiträge stehen im Tool-Ausgang vorn). Fehlt bei einem Beitrag das Datum, bleibt die Reihenfolge des Tools. Doppelte und Beiträge ohne gültigen Shortcode werden übersprungen.
- Stabile ID = Shortcode (`post_shortcode`), kanonische URL je Beitrag `/p/<code>/` bzw. `/reel/<code>/`; danach läuft jeder Beitrag wie ein Einzelbeitrag (`resolveAssets`, `stage`).
- Karussell: ein Asset je Bild/Video, `assetIndex` = Position, `sourceAssetId = media-<media_id>` (stabil bei Umsortierung), Name `<shortcode>_<n>.<ext>`. Reel: ein Video-Asset, kein Vorschaubild (`previews` ist in gallery-dl aus, `audio` ebenfalls).
- Begrenzung: Der Executor hat nur eine feste Obergrenze von 500 Beiträgen. Unter den Admin-Limits (Laufzeitrichtlinie, Migration 0044) gibt es kein Limit „Beiträge je Lauf“. Die vorhandenen Budgets `maxDownloadsPerDayPerUser`, `maxBytesPerDayPerUser`, `bandwidthBytesPerSecond` werden gespeichert und in der Oberfläche gepflegt, **aber im Worker und im Executor nirgends durchgesetzt** (Suche in `apps/` und `packages/`: nur `maxConcurrent*` greift, in der Warteschlange). Der erste Lauf ist also von den Admin-Budgets nicht begrenzt. Deshalb Adapter-Vorgabe **50 Beiträge je Lauf**, einstellbar mit `KURA_INSTAGRAM_MAX_POSTS_PER_RUN` (1–500), in `.env.example` dokumentiert. Ältere Beiträge werden danach nicht nachgeladen (siehe Risiken).
- Inkrementell: Der Executor überspringt bereits gespeicherte Beiträge anhand der History; der zweite Lauf lädt nur den neuen Beitrag (Test mit Pipeline und echter Datenbank: 1 Download, 3 Listings statt 7+).
- Probe eines Profils listet nur 1 Beitrag (`--post-range 1-1`): Anmeldeprobleme fallen nach wenigen Anfragen auf.

### Parser (Deliverable 4)

`gallery-dl-output.ts`: `parseDumpJson` liest `[2, …]` (Beitrag), `[3, url, …]` (Datei), `[-1, {error, message}]` (Fehler). Unbekannte Formen werden übersprungen, optionale Felder dürfen fehlen. Nichts aus den Metadaten wird Argument (D-007); Tests mit feindlichen Werten (`--exec=…`, `file:///…`, Steuerzeichen). Die URL steht immer hinter `--`.

### Fehlerabbildung (Deliverable 5)

| Anlass (Quelle) | Adapterfehler | Worker |
| --- | --- | --- |
| Fehlereintrag `AuthRequired`, `AuthorizationError`, `AuthenticationError` (exception.py) | `AUTH_REQUIRED` | `waiting_auth`, Abo pausiert |
| HTTP `401`/`403` (`'403 Forbidden' for '<url>'`, common.py) | `AUTH_REQUIRED` | wie oben |
| `HTTP redirect to login page` / `home page` (instagram.py `request()`) | `AUTH_REQUIRED` | wie oben |
| `HTTP redirect to challenge page`, `ChallengeError`, `checkpoint_required`, `challenge_required` (Letztere Heuristik) | `AUTH_REQUIRED` mit Satz „Sicherheitsprüfung (Checkpoint)“ | wie oben |
| `JSONDecodeError` bei Instagram (HTML-Anmeldeseite mit 200; Heuristik) | `AUTH_REQUIRED` | wie oben |
| stderr „…'s posts are private“ (instagram.py, nur eine Warnung) bei leerer Liste | `AUTH_REQUIRED` mit Satz „Profil ist privat, kein Zugriff“ | wie oben |
| Profil-Liste leer ohne Fehler (instagram.py bricht Paginierung stumm ab) | `AUTH_REQUIRED` (Satz je nach Cookies vorhanden/nicht) | wie oben |
| HTTP `429`, „Too Many Requests“, „Please wait a few minutes“ (die letzten beiden Heuristik), „rate limit“ | `RATE_LIMITED` | `waiting_rate_limit`, Wiederholung nach 15 min |
| `NotFoundError`, HTTP `404`/`410`, „could not be found“ | `TARGET_NOT_FOUND` (Satz Profil bzw. Beitrag) | `failed`, endgültig, Archiv bleibt |
| HTTP `5xx` | `NETWORK_FAILED` | `retry_wait` |
| Download-Lauf (kein JSON): dieselben Muster auf stderr, dann Exitcode-Bits 16 (Auth) und 8 (Challenge) | wie oben | wie oben |
| alles andere | `PROCESS_FAILED` (stderr nur als `untrustedDiagnostics`) | `retry_wait` |

Wichtig: Nach einem Fehler **mitten im Profil** liefert `discover()` zuerst die bis dahin gelisteten Beiträge und wirft danach den Fehler. Der Executor archiviert diese Beiträge, beendet den Lauf mit `waiting_*` und setzt den „geprüft bis“-Stand nicht weiter (Test, mit Gegenprobe durch Mutation geprüft). Ein Login- oder Ratenlimit-Fehler beim **Auflösen** eines Beitrags stoppt den ganzen Lauf, statt die nächsten 49 Beiträge zu probieren.

### Taktung (Deliverable 6)

Alle Werte nur für Instagram: `--sleep-request 8-15` (gallery-dl-Vorgabe für Instagram ist 6–12), `--sleep-extractor 8-15` (jede Datei, jeder Beitrag, jedes Listing ist ein eigener Prozess, und der Anfrage-Zeitgeber von gallery-dl gilt je Prozess, der erste Request geht sofort raus; ohne diese Option gäbe es zwischen den Prozessen keinen Abstand), `--sleep 2-5` vor jedem Download, `--retries 0` (kein gallery-dl-internes Warten nach 429, die Warteschlange macht den Rückzug).

### Cookies (Deliverable 7)

Siehe „Einbindung für IG-B“.

## Optionen von gallery-dl mit Beleg

Beleg: sdist `gallery_dl-1.32.16.tar.gz` von PyPI (sha256 `bacd7d63423ad45db98704fedafa1302343db6f250f9e9f69a9e142754ed9e37`, geprüft), davon `python3 -m gallery_dl --help` ausgeführt und `option.py`, `job.py`, `exception.py`, `extractor/instagram.py`, `extractor/common.py` gelesen; Konfigurationsdokument `docs/configuration.rst` vom Tag `v1.32.16` (GitHub). Zusätzlich lief der **echte Extraktor-Code** (API-Schicht durch synthetische Daten ersetzt, kein Netz zu Instagram) mit genau den hier benutzten Argumenten, einmal als Listing, zweimal als Download gegen einen lokalen HTTP-Server.

| Option | Verwendung | Beleg |
| --- | --- | --- |
| `--config-ignore` | immer | `--help`; (schon aus M5-A) |
| `--dump-json` | Listing | `--help` (`-j`), `job.py` DataJob |
| `-D`, `-f asset.{extension}`, `--range N`, `--filesize-max` | Download | `--help`; (schon aus M5-A); `--range 3` lieferte im lokalen Lauf `asset.mp4` des Karussells |
| `--post-range 1-N` | Profil-Listing | `--help` („Like '--range', but for posts“), `job.py` Zeile 405 (`target + "-range"`), `util.predicate_range` bricht nach der Obergrenze mit `StopExtraction` ab; lokal: 2 von 5 Beiträgen |
| `--sleep-request`, `--sleep-extractor`, `--sleep` mit Bereich `8-15`, `2-5` | Taktung | `--help` („constant value or a range“), `common.py` (`build_duration_func`); `sleep-extractor` wird in `Job.run` und `DataJob.run` gelesen |
| `--retries 0` | Instagram | `--help`; `common.py request()`: bei `retries=0` kein zweiter Versuch |
| `-o extractor.instagram.videos=merged` | Instagram | `configuration.rst` („merged: Download pre-merged video formats“), `instagram.py`; Grund: der Standard `dash` importiert ein yt-dlp-Modul **innerhalb** von gallery-dl und umginge Hash und Versionsuntergrenze, die Kura für yt-dlp erzwingt (D-007) |
| `-C <Datei>` | Cookies | `--help`, `configuration.rst` (`extractor.*.cookies`) |
| `-o extractor.instagram.cookies-update=false` | mit Cookies | `configuration.rst` (`extractor.*.cookies-update`, Standard `true` schreibt die Datei zurück) |

Nicht benutzt, obwohl vorhanden: `extractor.instagram.max-posts`, `include`, `order-*`, `-A`. **Unbekannt:** ob die auf der VM installierte `gallery-dl.bin` (Codeberg, sha256 `e8d6a8ea…`, D-026) dasselbe verhält wie die PyPI-Quellen derselben Version; nicht ausgeführt.

## Einbindung für IG-B

**Kontextfeld:** `credentials?: { cookiesFilePath?: string }` (Typ `RunCredentials` in `packages/adapters/src/types.ts`).

- `JobContext.credentials` und damit in `ProbeContext`, `DiscoveryContext`, `DownloadContext`, `StageContext`.
- `resolveAssets(post, policy, context?: ResolveContext)` hat keinen Job; deshalb dritter Parameter `{ signal?, credentials? }`. Der Executor übergibt heute nur `{ signal }`.
- IG-B muss im Executor: Datei mit Modus 0600 im privaten Laufverzeichnis anlegen (Format Netscape `cookies.txt`, Cookie `sessionid` für `.instagram.com` ist das, was gallery-dl prüft), `credentials` in `jobContext` (probe, discover), in den `context` von `storeAsset` und in den dritten Parameter von `resolveAssets` geben und die Datei **im `finally`** löschen.
- Der Adapter fasst die Datei nie an: kein `stat`, kein `read`, kein Kopieren. Er prüft nur die Form (absolut, ohne Steuerzeichen, höchstens 4096 Zeichen; sonst `PROCESS_SPAWN_FAILED`, kein Prozess) und reicht den Pfad als Wert von `-C` weiter. Nur für Instagram-Ziele; für Pixiv/Patreon wird der Pfad ignoriert. Der Pfad steht nicht in der Prozessumgebung (Test) und nicht in Ergebnissen/Fehlern (Test). Der Adapter ist für alle Benutzer derselbe Prozess-Singleton, hält aber keinen Zustand je Benutzer: Zugangsdaten gelten je Aufruf.
- Fehlt die Datei oder ist sie ungültig, schreibt gallery-dl „cookies: Failed to load …“ und läuft anonym weiter: Ergebnis ist der normale `AUTH_REQUIRED`-Weg.
- **Erwartete Fehlercodes** (`AdapterError.code` → Disposition): `AUTH_REQUIRED` → `waiting_auth`, Abo pausiert (vier Sätze: ohne Cookies, Cookies abgelehnt, privat, Checkpoint); `RATE_LIMITED` → `waiting_rate_limit`; `TARGET_NOT_FOUND` → `failed`; `NETWORK_FAILED`, `PROCESS_FAILED` → `retry_wait`; `PROCESS_SPAWN_FAILED` bei falschem Pfad. Die deutschen Sätze nennen „Instagram-Cookies hinterlegen“, solange IG-B die Eingabestelle nicht liefert, verweisen sie ins Leere.
- IG-B muss in `apps/api/src/source-routes.ts` die zwei Hinweise streichen, die sagen, Cookies könnten „noch nicht hinterlegt werden“ (Suche nach „noch nicht hinterlegt werden“).

## Änderungen außerhalb von `packages/adapters` (jede einzeln)

Worker (`apps/worker/src`), nur wo neue Codes oder das Limit es brauchen:

- `failure.ts`: Einträge für `AUTH_REQUIRED`, `RATE_LIMITED`, `TARGET_NOT_FOUND`; `userMessage` des Adapters ersetzt nur den Text (nicht das Verhalten) für Auth, Ratenlimit, nicht gefunden, nicht unterstützt, ungültig; neue Funktion `stopsWholeRun()`.
- `executor.ts`: (1) Fehler beim Auflösen eines Beitrags stoppt den Lauf bei Login/Ratenlimit/Pause (`stopsWholeRun`); (2) Teil-Discovery (siehe oben); (3) `TARGET_BROKEN` führt wie `TARGET_UNSUPPORTED` zur Prüfung „Werkzeug nicht installiert“ (gallery-dl fehlt, nicht „defekt“); (4) `resolveAssets` bekommt `{ signal }`.
- `config.ts`, `catalog.ts`, `worker.ts`: `KURA_INSTAGRAM_MAX_POSTS_PER_RUN` bis in `GalleryDlAdapter.create()`.

API (`apps/api/src/source-routes.ts`): Fähigkeiten und Hinweise je Ziel (Beitrag/Profil/Cookies), Text von `error.userMessage` für Ablehnungen, `capabilities` je Quellentyp in `/api/v1/adapters`, zwei Standardtexte angepasst (Instagram-Profile sind nicht mehr „defekt“).

Web (`apps/web/src/Adapters.tsx`, `api.ts`): Fähigkeiten je Plattform, wenn sie sich unterscheiden. Neuer Test dazu.

`.env.example`: `KURA_INSTAGRAM_MAX_POSTS_PER_RUN`. **Nicht angefasst:** `docs/vm-setup.md` (nicht in der Dateiliste dieser Karte), dort fehlt die neue Variable.

**Abweichung von der Dateiliste:** Drei bestehende Tests in `tests/m5b/` kodierten das alte Verhalten „Instagram-Profil = `TARGET_BROKEN`“ und mussten angepasst werden (`source-selection.test.ts`, `source-api.test.ts`, `pipeline-tools.test.ts`). `tests/m5b` steht nicht unter „darf ändern“; die Änderung ist zwingend und klein (Erwartungen angepasst, keine Prüfung gelöscht; „TARGET_BROKEN“ bleibt dort getestet, wo nur yt-dlp schaut). Bitte als Befund prüfen.

## Prüfung

Ausgeführt:

- `corepack pnpm check`: eslint, Typprüfung aller Pakete, vitest mit echter PostgreSQL, Build. Vorher 38 Dateien / 738 + 1 übersprungen (gemessen am unveränderten Stand), nachher 45 Dateien / 907 + 1 übersprungen. Web-Suite zusätzlich (`pnpm --filter @kura/web test`, nicht Teil von `check`): 10 Dateien / 50 Tests grün.
- Tests ohne Netz mit Fake-gallery-dl, dessen Ausgaben aus dem **echten** gallery-dl-1.32.16-Extraktor stammen (API-Schicht durch synthetische Daten ersetzt; `tests/instagram/fixtures/generate-fixtures.py` dokumentiert das). Abgedeckt: Profilvarianten und Ablehnungen, Post-/Reel-Varianten, Karussell → 3 Assets mit Indizes, Reel → 1 Video, Paginierung/Obergrenze, zweiter Lauf nur neue Beiträge, Erstlauf-Grenze 50 bei 60 Beiträgen, Auth/Ratenlimit/nicht gefunden/privat/leer/Checkpoint, Teil-Discovery, Option-Injection in Namen und Shortcodes, Cookies-Argument, Pfad nicht in Umgebung/Ergebnis, Pipeline mit `waiting_auth`/`waiting_rate_limit`/`TARGET_NOT_FOUND`.
- Mutationsprobe: Entfernen der zwei neuen Stopp-Zeilen im Executor lässt genau die zwei zuständigen Pipeline-Tests scheitern; Datei danach wiederhergestellt.
- Der echte gallery-dl-Code (sdist) mit den exakten Argumenten: Listing mit `-C` und `cookies-update=false` (Cookie-Datei danach unverändert), Download `--range 1` und `--range 3` gegen lokalen Server (`asset.jpg`, `asset.mp4`).

### nicht geprüft: echter Instagram-Abruf

- Kein einziger Request an Instagram; kein echtes Konto, keine echten Cookies.
- Ob Instagram heute die erwarteten Statuscodes/Texte liefert (401/403/429, Weiterleitungen, die Heuristiken „Please wait a few minutes“, `checkpoint_required`, `login_required`, `JSONDecodeError` bei Anmeldeseite).
- Ob die echte API genau die in gallery-dl erwarteten Felder liefert (Fixtures sind aus dem echten Code, die Rohdaten sind synthetisch).
- Ob ein Profil ohne Cookies wirklich leer ankommt oder mit Fehler (beides ist abgedeckt, welches eintritt ist unbekannt).
- Reihenfolge und Gesamtumfang eines echten Profils (gepinnte Beiträge, Reels im Raster), Videoqualität und Ton bei `videos=merged`.
- Die installierte `gallery-dl.bin` der VM (nicht ausgeführt); der Lauf im Container des Workers; Egress-Verhalten.
- Wie lange 50 Beiträge wirklich dauern (Schätzung unten), und ob Lease-Verlängerung über 30–40 min trägt.
- Kein Browser-/UI-Lauf der neuen Fähigkeitsanzeige (nur jsdom-Test).

## Annahmen

1. Fixture-Form = Ausgabe des echten Extraktor-Codes; der Rohinhalt (Felder der Instagram-API) ist angenommen.
2. `post_shortcode` ist bei jedem regulären Beitrag gesetzt (Quelltext: `data["post_shortcode"] = post["code"]`). Deshalb ist die Prüfung „Datei gehört zum angefragten Beitrag“ für Instagram jetzt strikt (vorher tolerant).
3. Das Raster „Posts“ enthält auch Reels (der Extraktor `posts` ruft `user_feed`); der Reels-Tab ist eine Teilmenge. Unbelegt gegen echte Konten.
4. Ein leeres Profil-Listing ist ein Anmeldeproblem. Das trifft auch ein echtes, leeres Profil (siehe Fragen).
5. 15 min Wartezeit nach 429 (vorhandene Worker-Vorgabe) ist für Instagram brauchbar.
6. Das Lease des Laufs wird vom bestehenden Herzschlag lange genug verlängert (nicht mit Lauf über 30 min geprüft).
7. `-C` mit Datei und `cookies-update=false` verhalten sich in der Standalone-Binary wie im Quelltext.

## Risiken

- **Dauer und Anfragen:** je Beitrag ein Listing-Prozess, je Asset ein weiterer (gallery-dl listet den Beitrag bei jedem `--range N` erneut). Mit 8–15 s Abstand je Prozess dauert ein Erstlauf mit 50 Beiträgen à ~1,5 Assets grob 35–45 min (Schätzung, nicht gemessen) plus zwei Profil-Listings. Gewollt langsam, aber lang. Verbesserung wäre, das Listing zwischen `resolveAssets` und `stage` zwischenzuspeichern (Schnittstelle).
- **Kein Nachladen älterer Beiträge:** Obergrenze 50, danach nie mehr als die neuesten 50 je Lauf; `enumerationComplete` im Sync-Stand ist trotzdem „wahr“, weil der Executor die Kappung des Adapters nicht sieht. Wer ein größeres Archiv will, erhöht die Variable (max. 500), ein Rückscan ist nicht gebaut.
- **Kontorisiko:** Instagram kann Konten bei auffälligem Verhalten sperren. Die Taktung ist konservativ gewählt, aber nicht belegt. Nur eigene/freigegebene Konten (CLAUDE.md).
- **Befund für den Orchestrator (nicht Teil dieser Karte):** Die Tagesbudgets der Admin-Laufzeitrichtlinie werden nicht durchgesetzt. Für Instagram ist das wegen der Kontosperre-Gefahr relevant; bis dahin schützt nur die Adaptergrenze und die Taktung.
- R-09/R-16 unverändert: gallery-dl läuft ohne Egress-Sperre (D-026). `videos=merged` verhindert wenigstens das Nachladen eines ungeprüften yt-dlp-Moduls.
- Heuristische Muster (siehe Tabelle) können falsch positiv oder negativ sein; ein falsch positives `AUTH_REQUIRED` pausiert ein Abo (gewollt konservativ), ein übersehenes Muster endet als `PROCESS_FAILED` mit begrenzten Wiederholungen.
- `bySourceType` ist eine kleine Erweiterung des Adaptervertrags (optionales Feld, optionaler dritter Parameter). Andere Adapter bleiben unverändert.

## Offene Fragen

1. [Iroha] Leeres Profil = `AUTH_REQUIRED` ist einfach und sicher; [Yui] wendet ein: Ein neues, wirklich leeres Profil pausiert damit das Abo und der Benutzer kann nichts beheben. Vorschlag umgesetzt: AUTH_REQUIRED, Satz nennt „leer oder privat“ nur bei vorhandenen Cookies. Soll der Coordinator hier eine Ausnahme wollen (zum Beispiel erst nach zwei leeren Läufen)?
2. [Iroha] 50 Beiträge je Lauf reichen für „neue Beiträge nachziehen“; [Yui] sorgt sich um alles, was älter ist und nie kommt. Soll ein begrenzter Rückscan als eigene Karte folgen?
3. Cookies je Benutzer oder je Abonnement (IG-B)? Der Adapter ist neutral.
4. Soll `docs/vm-setup.md` die Variable bekommen? Datei lag nicht in meiner Liste.
5. Sollen die zwei Standardtexte der API (`TARGET_UNSUPPORTED`, `TARGET_BROKEN`) so bleiben, wie ich sie angepasst habe?

## Nächster Schritt

Review durch den Reviewer, danach IG-B (Cookies speichern, Datei je Lauf anlegen und löschen, Executor-Kontext füllen, die beiden API-Hinweise ändern). Ein echter Abruf mit eigenem Testkonto und eigenen Cookies bleibt Aufgabe des Verifiers.

## Rückweg

Kein Schema, keine Migration, keine Daten geändert. Rückgängig: `git revert` der vier Commits `ce2610b`, `ee269e2`, `602f711`, `009e416` (und dieses Berichts) oder `git reset --hard 0a7065f` auf `lane/instagram` (noch nicht gepusht). Die Umgebungsvariable ist optional.
