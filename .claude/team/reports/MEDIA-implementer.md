# MEDIA Medienansicht je Abo und Live-Ansicht während des Downloads - Bericht Implementer

Task t_3d558af1 · req REQ-DL-006 `41a71ca708d3fc58` (Kontext REQ-DL-003 `b83be904af3eded5`, REQ-DL-005 `66b20a66d9133e08`) · Worktree `/work/wt/media`, Branch `lane/media` (Basis eb1a97f)

## Aufgabe

Der Auftraggeber will sehen, was heruntergeladen wurde: im Abonnement und schon während des Downloads. Gebaut: eine eigentümergebundene Medien-API (Liste je Abonnement, Assets eines Laufs inklusive laufender, Inhaltsstrom mit Range), die Oberfläche (Medien-Bereich mit Raster, Viewer, Live-Ansicht mit Polling), Tests auf echter PostgreSQL und Screenshots.

## Status

**Fertig, braucht Review.** `corepack pnpm check` grün (Zahlen unten), `pnpm audit --audit-level=high` ohne high/critical (Exit 0; gemeldet werden 1 low und 1 moderate; ich habe keine Abhängigkeit hinzugefügt, `package.json` und `pnpm-lock.yaml` sind gegenüber der Basis unverändert). Baum sauber, nichts gepusht.

## Artefakte

Commits auf `lane/media` (englische Meldungen, neueste zuletzt):

- `ccb5d9e` Medien-API, `openReadRange` im Blobstore, Migration 0060, API-Tests
- `172fe5d` Weboberfläche: Medien-Bereich, Viewer, Live-Ansicht, Web-Tests
- `54d8eb9` Screenshot-Erweiterung (Raster, Viewer, leer, Live), Befunde aus den Bildern behoben
- `a7e0845` Echtbrowser-Prüfung `media-check.mjs` (Inhaltsroute und Viewer-Tastatur)
- `041c381` Lint-Globals der Screenshot-Skripte
- dieser Bericht (eigener Commit)

Neue Dateien:

- `apps/api/src/media-routes.ts` (drei Routen), `apps/api/src/media-content.ts` (reine Hilfen: Inline-Allowlist, Range, ETag, Content-Disposition)
- `apps/web/src/{MediaThumb,MediaGrid,MediaViewer,SubscriptionMedia,RunLive,useRunAssets,media}.ts(x)`, `apps/web/src/styles/media.css`, `apps/web/src/Media.test.tsx`
- `migrations/0060_media_listing_indexes.sql`
- `tests/media/{fixture.ts,content-helpers.test.ts,blobstore-range.test.ts,media-api.test.ts}`
- `tests/ui-shots/{media-seed.mjs,media-check.mjs}`

Geänderte Dateien (jede Änderung: was, warum, Wirkung, Rückweg):

| Datei | Was | Warum | Rückweg |
|---|---|---|---|
| `apps/api/src/app.ts` | Route registriert; `onSend`-Hook setzt `Content-Security-Policy: default-src 'self'` nur noch, wenn die Route keine eigene gesetzt hat; `HEAD` wie `GET` ohne CSRF-Prüfung; Typ des Blobstores `RangeReadBackend` | Der Hook hätte die Sandbox-Richtlinie der Inhaltsroute überschrieben. HEAD ist eine sichere Methode | Commit `ccb5d9e` zurücknehmen |
| `packages/blobstore/src/index.ts` | **Additiv**: Schnittstelle `RangeReadBackend` und Methode `openReadRange(object, start, endInclusive)` in `DatabaseBlobStore` und `FilesystemBlobStore` (+70 Zeilen, kein bestehender Code geändert außer `implements`) | Ohne sie müsste jeder Seek in einem Video alle Chunks davor aus der Datenbank lesen. Die Methode liest nur die überlappenden Chunks (Chunk-Größen vorab ohne Nutzdaten) | Methode und Schnittstelle entfernen, API liest dann per `openRead` und überspringt |
| `apps/web/src/Subscriptions.tsx` | Knopf "Medien", Live-Bereich nach "Jetzt ausführen", Hinweistext ("Fortschritt unten live") | Wunsch aus der Aufgabe | Commit `172fe5d` |
| `apps/web/src/History.tsx` | Bereich "Läuft gerade" mit Live-Ansicht je laufendem Lauf (höchstens 3) | Wunsch aus der Aufgabe | wie oben |
| `apps/web/src/styles/components.css` | `.skeleton-tile` in zwei bestehende Selektoren (Schimmer, weiterhin genau ein Verlauf) | Skeleton-Kacheln | wie oben |
| `apps/web/src/Sources.test.tsx` | Test für "Jetzt ausführen" erweitert; zwei neue Tests | Live-Bereich, Medien-Knopf | wie oben |
| `tests/ui-shots/{capture,fixtures,stack}.mjs`, `README.md` | neue Ansichten, `databaseUrl` aus `stack.mjs`, Mock für `run-4` | Screenshots | Commit `54d8eb9` |

Keine Datei aus der Verbotsliste berührt (kein `package.json`, keine `tsconfig*.json`, nichts unter `.github`, `docs`, `deploy`, `packages/adapters`, `packages/immich-client`, keine bestehende Migration, kein `.env.example`).

## Zusammenfassung

[Iroha] Drei Routen, eine Migration mit zwei Indizes, eine additive Methode im Blobstore. Was es kostet: die API kennt jetzt das Lesen ganzer Medien, deshalb sind Eigentümerprüfung und Header der Teil, der zählt, und beides ist getestet.

[Yui] Ich habe genau auf die Stelle geachtet, an der etwas schiefgehen kann: ein fremder Benutzer, ein SVG mit Skript, ein abgebrochener Download, der die Lesesperre festhält. Alle drei sind abgedeckt und gemessen, nicht nur gelesen.

### Medien-API (alle drei nur mit Sitzung, 401 sonst)

- `GET /api/v1/subscriptions/:id/media?type=all|image|video&limit=&cursor=` : gespeicherte Dateien, neueste zuerst (Keyset-Seiten über `(stored_at, id)`, Zeitstempel in Mikrosekunden aus PostgreSQL, damit keine Datei doppelt oder übersehen wird), Standard 48, höchstens 100. Je Datei: `id`, `postId`, `platformPostId`, `postTitle`, `postUrl` (nur Adresse ohne Query, wie die History sie speichert), `creatorName`, `runId`, `originalName`, `mediaKind`, `mimeType`, `byteSize`, `storedAt`, `assetIndex`, `immich {state, verified, verifiedAt}`. Auf der ersten Seite zusätzlich `counts {all, image, video}`. Es wird nichts gescrapt; der Titel kommt aus `download_posts.title`. `blob_object_id` und Pfade verlassen die API nicht.
- `GET /api/v1/runs/:id/assets` : `:id` ist die Id eines History-Laufs **oder** die Id des Queue-Laufs, die "Jetzt ausführen" liefert. Antwort: `run` (null, solange kein Worker den Lauf genommen hat), `queue {state}`, `active`, `counts` je Zustand, `assets` (alle Zustände, die zuletzt bearbeiteten 200, `truncated` sagt, ob es mehr gibt). Ein Beitrag gehört dem Lauf, der ihn zuerst fand; Dateien, die ein späterer Versuch oder Lauf für einen älteren Beitrag nachlädt, werden über Abonnement und Zeitfenster des Laufs zugeordnet (Test dafür vorhanden).
- `GET|HEAD /api/v1/assets/:id/content[?download=1]` : Strom aus dem Blobstore über die Lesesperre, `Content-Length`, `Accept-Ranges: bytes`, Range (206, 416 mit `Content-Range: bytes */size`), `If-Range`, `ETag` = `"<sha256>"`, `If-None-Match` (304), `Cache-Control: private, no-cache`. Eigentümerprüfung zweifach: SQL (`user_id`) und der Blobstore (`ownerUserId` in der Referenz).
- Fremde und unbekannte Ids (auch kaputte) liefern **dieselbe** 404-Antwort, nie 403. Eine fehlende lokale Kopie liefert 410 `CONTENT_UNAVAILABLE`. Keine neue Löschroute (Test: DELETE/PUT/PATCH/POST auf die Route geben 404 und ändern nichts).

### Sicherheitsheader je Antworttyp (gemessen, `tests/media`)

| Antwort | Content-Type | Content-Disposition | CSP | nosniff | Weitere |
|---|---|---|---|---|---|
| Inhalt 200/206, Allowlist-Typ (jpeg, png, gif, webp, avif, bmp, mp4, webm, ogg, quicktime, mpeg, aac, flac, wav, audio/mp4, audio/ogg, audio/webm) | gespeicherter Typ | `inline; filename="…"; filename*=UTF-8''…` | `default-src 'none'; sandbox` | ja | `ETag`, `Accept-Ranges`, `Cache-Control: private, no-cache`, `Vary: Cookie`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`; 206 mit `Content-Range` |
| Inhalt 200, **alles andere** (svg, html, xml, pdf, zip, mkv, …) und jeder Inhalt mit `?download=1` | Allowlist-Typ bei `?download=1`, sonst `application/octet-stream` | `attachment; …` | `default-src 'none'; sandbox` | ja | wie oben |
| 304 | (keiner) | (keiner) | `default-src 'none'; sandbox` | ja | `ETag`, `Cache-Control`, `Accept-Ranges` |
| 416 | `application/json` | (keiner) | `default-src 'none'; sandbox` | ja | `Content-Range: bytes */size`, `ETag` |
| 401, 404, 410 und alle JSON-Antworten (auch die Listen) | `application/json` | (keiner) | `default-src 'self'` (App-Standard) | ja | `Referrer-Policy: no-referrer` |

Filename: Steuerzeichen und `/` `\` entfernt, ASCII-Rückfall (`[A-Za-z0-9._ -]`, Rest `_`), voller Name als RFC-8187-`filename*` (zusätzlich `' ( ) *` kodiert), höchstens 200 Zeichen, Leername oder `..` wird `download`. Der Test prüft Anführungszeichen, Umlaute, Symbole, CRLF-Einschleusung und Pfadtrenner.

Range-Regeln (RFC 9110): ein Bereich wird bedient; ungültig, umgekehrt, `-0` oder hinter dem Ende gibt 416; eine andere Einheit als `bytes` oder mehrere Bereiche in einem Header werden ignoriert und die ganze Datei geschickt (erlaubt, Browser senden das für Medien nicht); `If-Range` ohne passenden Validator gibt die ganze Datei.

### Weboberfläche (deutsch, Tokens, hell/dunkel, mobil)

- **Medien** (Knopf in der Abo-Zeile, `aria-expanded`): responsives Raster, nach Beitrag gruppiert, Beiträge mit mehreren Dateien zeigen "3 Dateien"; Filter Alle/Bilder/Videos mit Anzahl (`aria-pressed`); "Weitere laden" (Seiten); Skeletons; Leerzustand "Noch nichts geladen. Starte einen Lauf mit Jetzt ausführen."; Fehlerbanner mit "Erneut laden". Bilder: Original, per CSS skaliert, `loading="lazy"`, `alt="Bild: <Dateiname>"`. Videos: `<video preload="metadata" muted>` mit Spielmarke. Das Raster ist per Pfeiltasten, Pos1 und Ende bedienbar, Tab erreicht jede Zelle.
- **Viewer** (Dialog): Bild in voller Größe oder Video/Audio mit nativen Bedienelementen, Vorherige/Nächste (Tasten ← →, nicht auf einem fokussierten Video, dort gehören sie dem Player), Escape schließt, Fokusfalle (auch bei Klick hinter den Dialog), Fokus kehrt zur Zelle der zuletzt gezeigten Datei zurück, Metadaten (Dateiname, Größe, Typ, gespeichert am, Beitrag und Ersteller, Quelle als externer Link mit `rel="noopener noreferrer"` nur für http(s)-Adressen, Immich-Stand; "geprüft" nur mit Prüfbeleg), "Herunterladen" (`?download=1`, Attachment). Lädt nach, wenn das Ende der geladenen Seite erreicht ist.
- **Live**: Nach "Jetzt ausführen" erscheint unter der Zeile "Lauf live" (auch bei einem schon offenen Lauf), im Verlauf der Bereich "Läuft gerade". Je Datei der Zustandschip, gespeicherte Dateien erscheinen als Bild, sobald sie gespeichert sind. Polling alle 3 s solange `active`, Stopp mit dem ersten Beendet-Ergebnis (und bei 404), Pause bei `document.visibilityState === 'hidden'`, sofortige Abfrage beim Zurückkehren, keine Timer nach dem Ausblenden. Nach Ende: "Medien ansehen" und "Ausblenden".
- Barrierefreiheit: Bildtexte aus Typ und Dateiname, alle Knöpfe benannt, Statusmeldung `aria-live="polite"`, Schimmer nur ohne `prefers-reduced-motion`, keine neue Animation, nur Tokens (der Kontrasttest läuft grün).

### Thumbnails: bewusst nicht gebaut

Raster zeigt das Original skaliert (Bilder) bzw. den ersten Frame per `preload="metadata"` (Videos). Ein Worker-Thumbnail-Mechanismus bräuchte eine Migration, einen Worker-Schritt mit ffmpeg über `KURA_TOOL_PATH` und eine zweite Blobsorte; die Aufgabe nennt ihn optional. Kosten des Verzichts: große Originale werden im Raster vollständig geladen (lazy, nur sichtbare). Das ist der wichtigste Ausbau, falls Raster mit sehr großen Bildern oder Videos langsam wirken.

## Prüfung

Ausgeführt:

- `corepack pnpm check` (typecheck, lint, Tests, Build): **vorher 55 Dateien / 1208 bestanden / 1 übersprungen, nachher 58 Dateien / 1291 bestanden / 1 übersprungen** (+3 Dateien, +83 Tests). Gemessen mit `DATABASE_URL=postgres://kura_dev:…@127.0.0.1:5432/kura_dev`.
- Web-Tests laufen **nicht** in `pnpm check** (siehe Befund). Einzeln: `corepack pnpm --filter @kura/web test` bzw. `cd apps/web && npx vitest run`: **vorher 12 Dateien / 69 Tests, nachher 13 Dateien / 92 Tests**, alle bestanden (23 neue: Raster, Gruppen, Filter, Seiten, Skeleton, leer, Fehler, Pfeiltasten im Raster, Viewer-Tasten, Fokusfalle, Fokus zurück, Quelle nur für http(s), Immich-Beleg, Live-Anzeige, Polling alle 3 s, Ende, Pause bei verstecktem Tab, Abbruch beim Entfernen, Fehler mit Weiterpollen).
- `pnpm audit --audit-level=high`: Exit 0, 1 low und 1 moderate (keine Abhängigkeit von mir geändert; ob die beiden Meldungen schon in der Basis bestanden, habe ich nicht verglichen).
- `tests/media` auf echter PostgreSQL: Eigentümerisolation (zwei Benutzer: Liste, Inhalt, Läufe nach History-Id und Queue-Id, Konditionalanfrage, untergeschobene Blob-Referenz), Range (206 mit exakten Bytes, offenes Ende, Suffix, 416, `If-Range`, ignorierte Einheit), ETag/304, Allowlist gegen Attachment (SVG, HTML), Dateinamenkodierung, Mehr-Chunk-Strom (300 KiB in 64-KiB-Chunks, Bytes exakt, kommt in mehreren Stücken an, Lesesperre geht nach Ende **und nach Abbruch des Clients** auf 0), Lauf-Assets mit laufenden und gespeicherten Dateien, Queue-Lauf vor und nach dem Worker, späterer Lauf für älteren Beitrag, `openReadRange` in beiden Backends (inklusive: ein Seek ans Ende liest genau einen Chunk-Payload).
- `node tests/ui-shots/media-check.mjs` (Chromium): Bild in der Inhaltsroute angezeigt, SVG und HTML werden heruntergeladen statt gerendert, kein Skript läuft, Header stimmen; Viewer: Enter öffnet, Pfeile wechseln, Tab/Shift+Tab bleiben im Dialog, Escape schließt, Fokus kehrt zur Zelle der zuletzt gezeigten Datei zurück, Video im Viewer dekodiert und spult (Range-Anfragen gesehen), Pfeiltaste auf fokussiertem Video bleibt beim Player. 22 Prüfpunkte, alle bestanden.
- Screenshots: gesehen und danach behoben: Bild ragte im Viewer aus seinem Rahmen (Flex-Schrumpfung, Bildhöhe zu groß), Überschriftenabstand der Beitragsgruppen (h5 ohne Reset), Dialog-Screenshots waren als Vollseite abgeschnitten (jetzt Viewport-Aufnahme). Konsole im Lauf: nur die zwei bekannten Meldungen (401 des Fehl-Logins, 500 des Fehler-Mocks).

### Screenshot-Index

82 Bilder mit `node tests/ui-shots/capture.mjs` (Ordner `/work/shots-media/`, nicht im Repo; die Skripte erzeugen sie neu). Neue Ansichten, je hell 1440, dunkel 1440, hell 390 (`<name>-<hell|dunkel>-<breite>.png`, Dateinamen `light`/`dark`):

| Ansicht | Inhalt |
|---|---|
| `media-grid` | Medien-Bereich von "Atelier Mori": 14 Dateien in 6 Beiträgen, Filter, Gruppenköpfe |
| `media-grid-videos` | Filter "Videos (1)" |
| `media-viewer-image` | Viewer mit Bild, Metadaten, Immich "geprüft" (Viewport) |
| `media-viewer-video` | Viewer mit WebM-Video und nativen Bedienelementen (Viewport) |
| `media-empty` | Leerzustand "Noch nichts geladen. Starte einen Lauf mit Jetzt ausführen." |
| `live-run` | "Lauf live" unter der Abo-Zeile: 2 gespeichert als Bild, 1 wird geladen, 1 wartet, 1 fehlgeschlagen |
| `history-live` | Verlauf mit "Läuft gerade" und echten Daten |

Die übrigen 61 Bilder sind die vorhandenen Ansichten (unverändert, `history` zeigt jetzt zusätzlich den gemockten laufenden Lauf).

Die Bilder und das Video sind echt: sechzehn im Browser gezeichnete PNG/JPEG und ein von Playwright aufgenommenes WebM (kein ffmpeg in der Sandbox), gespeichert über `HistoryRepository` und `DatabaseBlobStore` aus den gebauten Paketen (nicht über einen Worker-Lauf, siehe nicht geprüft).

Nicht geprüft (mit Grund):

- **Anderer Browser als Chromium** (Firefox, Safari: Medienverhalten, `#t=0.1` als Vorschaubild, Fokus bei Klick auf Knöpfe). Nicht installiert.
- **Screenreader.** Rollen, Namen und Fokusführung sind getestet, die Ansage selbst nicht.
- **Echter Worker-Prozess gegen die laufende API.** Die Live-Ansicht ist gegen Zustände geprüft, die `HistoryRepository` schreibt (dieselben Methoden wie der Worker), und Polling gegen eine Mock-API. Ein Lauf mit Worker, Adapter und echter Plattform fand nicht statt (keine Plattformzugriffe erlaubt).
- **Dateisystem-Backend über die API.** `openReadRange` ist für beide Backends getestet; die API-Tests laufen mit dem Datenbank-Backend, das der Teststand nutzt (D-023: Dateisystem zwischen API und Worker nicht belegt).
- **Last und große Mengen.** Keine Messung mit tausenden Dateien, großen Videos oder vielen gleichzeitigen Seeks; die Indizes aus 0060 sind nicht per `EXPLAIN` unter Last belegt.
- **Video direkt im Tab geöffnet.** Chromium lehnt es ab: `media-src` fällt auf `default-src 'none'` zurück (gemessen). Die App bettet Videos im Viewer ein und bietet den Download; ein Link "in neuem Tab öffnen" existiert nicht. Wer das will: `media-src 'self'` zur Richtlinie ergänzen. Das weicht vom vorgegebenen Wortlaut ab und ist deshalb Sache des Auftraggebers.
- **Mehrere Bereiche in einem Range-Header** (`multipart/byteranges`): bewusst nicht gebaut.
- **Entfernte lokale Kopie in der Oberfläche:** Kura hat keinen Löschpfad, die API antwortet bei fehlender Kopie mit 410, getestet ist das nur auf API-Ebene. Die Oberfläche zeigt dann im Raster das Dateisymbol (Bild-Fehlerfall) und im Viewer ein nicht ladbares Bild; einen eigenen Platzhaltertext nach Plan 07 gibt es nicht. Nötig erst, wenn ein Cleanup nach Immich-Verifikation gebaut wird.

## Annahmen

- `download_assets.media_type` ist der geprüfte MIME-Typ (die Staging-Schicht lässt nur Typen der Allowlist zu und gleicht Magic Bytes ab); es gibt keine zweite Spalte "detected_mime". Die Allowlist für Inline-Auslieferung wird trotzdem noch einmal auf der Inhaltsroute angewandt.
- "Medientyp" der API ist die Kategorie (`image|video|audio|other`) aus dem MIME-Typ, "MIME-Typ" der Typ selbst.
- Der Beitrag gehört dem Lauf, der ihn zuerst fand (Schema aus Migration 0050); `runId` in der Liste ist deshalb der Lauf des Beitrags, nicht zwingend der, der die Datei gespeichert hat.
- Ein gelöschtes Abonnement behält seine Medien in der API sichtbar (History bleibt, Plan 05); als Besitznachweis zählt Abonnement **oder** History-Lauf.
- Der Leerzustand folgt dem Wortlaut der Aufgabe ("Starte einen Lauf …", Du-Form). Die übrige Oberfläche siezt; ich habe den vorgegebenen Satz wörtlich übernommen.
- Der Viewer nutzt die Oberflächen-Tokens (heller bzw. dunkler Dialog), keine schwarze Vollbild-Lightbox: die Token-Regeln (Kontrasttest, keine Farbliterale) erlauben keine eigene Overlay-Farbe.
- `Cache-Control: private, no-cache` mit ETag: jede Anzeige fragt kurz nach (304), damit ein entzogener Zugriff nicht aus dem Browser-Cache weiterlebt.
- Migration `0060` liegt im mir zugewiesenen Bereich 0060 bis 0069; die endgültige Reihenfolge der Migrationen bestimmt der Orchestrator. Sie enthält nur zwei `CREATE INDEX`, keine Daten- oder Constraint-Änderung.

## Risiken

- Das Raster lädt Originale (kein Thumbnail). Bei Instagram-/Pixiv-Originalen von mehreren MB sind 14 sichtbare Zellen spürbar; lazy Laden und Seitengröße (48) begrenzen es.
- Der Live-Zustand wird alle 3 s gepollt, je Abfrage rund fünf kleine Anfragen. Das gilt nur, solange ein Tab offen ist und der Lauf aktiv; mehrere offene Tabs vervielfachen es.
- Die Zuordnung "späterer Lauf lädt Datei eines älteren Beitrags" arbeitet mit Zeitfenstern. Überlappen zwei Läufe desselben Abonnements (die Queue lässt das nicht zu), könnten Dateien beiden zugeordnet werden.
- Geändertes `onSend`/`HEAD`-Verhalten in `app.ts` betrifft alle Routen: die App-CSP gilt unverändert, solange keine Route eine eigene setzt; HEAD auf eine schreibende Route ist weiterhin nicht registriert.

## Offene Fragen

1. (Orchestrator) **Befund:** `pnpm check` führt die Web-Tests nicht aus (Root-Vitest nimmt nur `tests/**/*.test.ts`; `pnpm -r` ruft nur `typecheck` und `build`). Meine 23 neuen Web-Tests laufen daher nur über `corepack pnpm --filter @kura/web test`. Wurzel-`package.json` und Root-Vitest sind mir verboten; Empfehlung: Web-Tests in `pnpm test` aufnehmen (derselbe Befund steht schon in `UI1-implementer.md`).
2. (Auftraggeber) Video im eigenen Tab öffnen erlauben? Dann `media-src 'self'` in die Inhalts-CSP.
3. (Auftraggeber) Soll der Leerzustand wie vorgegeben duzen, oder wie der Rest siezen ("Starten Sie einen Lauf mit „Jetzt ausführen“.")?
4. (Orchestrator) Hotspot-Hinweis: `apps/api/src/app.ts` ist eine sehr lange Datei mit Zeilen über 300 Zeichen; meine Änderung dort ist klein, aber jede Spur, die Routen ergänzt, fasst dieselbe Stelle an.

## Nächster Schritt

Review, danach Verifier gegen REQ-DL-006. Beim Verifier sinnvoll: `node tests/ui-shots/media-check.mjs` und die Screenshots erneut erzeugen, dazu ein Lauf mit echtem Worker auf dem Teststand. Optional später: Thumbnails im Worker (ffmpeg über `KURA_TOOL_PATH`, eigene Blobs desselben Besitzers, Fallback ohne ffmpeg).
