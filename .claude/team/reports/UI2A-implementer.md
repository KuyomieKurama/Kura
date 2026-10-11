# UI2-A Server-Grundlage Redesign (Implementer-Bericht)

Task t_b901a8fd, req_id REQ-DL-008, req_hash b838cb501c2e1aa5, Worktree /work/wt/ui2, Branch ui/next.
Kein Push. Baum sauber (D-017).

## Was

- A1: MediaAsset hat jetzt width, height, durationSeconds, averageColor (#RRGGBB) und hasThumbnail. Die Werte kommen aus der neuen Tabelle asset_media_info per LEFT JOIN. Sie sind null/false, bis der Worker sie abgeleitet hat.
- A2: Der Worker leitet nach dem Speichern ab (apps/worker/src/derivatives.ts).
  - ffprobe liefert Maße und Dauer. Gedrehte Videos (90/270 Grad) tauschen Breite und Höhe.
  - ffmpeg erzeugt WebP-Vorschaubilder in 480 und 960 px, ersatzweise JPEG, wenn dieses ffmpeg kein libwebp kann.
  - Bei Videos ist das Standbild bei 10 % der Dauer, höchstens 10 s.
  - Die Durchschnittsfarbe kommt aus einer Skalierung auf 1x1 (PPM). Sie wird aus der 480er-Vorschau berechnet, nicht aus dem Original.
  - Audio bekommt nur die Dauer.
  - Die Ausführung läuft über runExternalProcess (Argument-Array, Timeout, Stdout- und Stderr-Grenze, privates Arbeitsverzeichnis).
  - Der Worker kopiert das Original aus dem Blob-Store in ein privates Arbeitsverzeichnis und arbeitet nur an dieser Kopie. Die Originale werden nie geschrieben.
  - Die Vorschaubilder liegen getrennt in asset_thumbnails (Migration 0070). Sie sind nicht Teil der Quota oder der Referenzzählung des Blob-Stores.
- GET /api/v1/assets/:id/thumbnail?w=480|960 (Standard 480)
  - Gleiche Besitzprüfung wie /content: fremde und unbekannte Id sind nicht unterscheidbar, beide 404.
  - Header: Cache-Control private, max-age=3600, ETag mit 304, nosniff, CSP-Sandbox, Vary: Cookie. HEAD funktioniert.
  - 404, wenn keine Vorschau existiert. Dann fällt die Oberfläche auf /content zurück.
  - Eine andere Breite ergibt 400.
- Backfill: Dieselbe Abfrage (findCandidates) findet neue und bestehende Dateien ohne Ableitung, neueste zuerst.
  - Höchstens 20 pro Durchgang. Danach gibt es 1 s Pause, bei leerer Liste WORKER_DERIVATIVES_POLL_SECONDS (30 s).
  - Der Vorgang ist idempotent und abbrechbar. Die Datei in Arbeit wird nicht geschrieben und im nächsten Durchgang neu aufgenommen.
  - Eine fehlgeschlagene Datei wird höchstens 3-mal versucht, mit mindestens 6 h Abstand.
  - SVG, Nicht-Medien und nicht gespeicherte Dateien werden übersprungen.
- A3: GET /api/v1/media?kind=all|image|video&subscriptionId&cursor&limit
  - Neueste zuerst nach (stored_at, id), Cursor-Paginierung, counts nur auf der ersten Seite, unabhängig vom kind-Filter.
  - Regel wie die bestehende Medienansicht: nur eigene Daten, auch für Admins. Gleiche Dateien (gleiche Prüfsumme) erscheinen einmal.
  - Fremde oder unbekannte subscriptionId ergibt 404.
  - Der Seitenlader wurde aus der Abo-Route herausgezogen (loadMediaPage). Beide Routen nutzen ihn, das Verhalten der bestehenden Route ist unverändert.
- A4: GET /api/v1/subscriptions liefert je Abo platform, lastRun, nextRunAt, mediaCount, coverAssetId und activeRunId.
  - Es sind 5 feste Abfragen für alle Abos zusammen (loadSubscriptionSummaries), also kein N+1.
  - Einzelabfragen (GET /subscriptions/:id) bleiben unverändert.
  - Abos ohne Verlauf bekommen die leere Zusammenfassung.
- A5: GET /api/v1/overview (apps/api/src/overview-routes.ts)
  - Antwort: recentAssets (9), activeRuns mit Zählern, upcoming (5), attention (auth_required | failed | partial) und lastRuns (5).
  - attention zeigt nur aktive Abos, deren letzter beendeter Lauf in waiting_auth, failed oder partially_completed endete. Ein späterer guter Lauf nimmt den Eintrag wieder heraus, ein pausiertes Abo erscheint nicht.
  - activeRuns.runId ist die Id des Queue-Laufs und funktioniert mit GET /runs/:id/assets.
- Web (nur apps/web/src/api.ts): Typen und Client-Funktionen api.media(), api.overview() und thumbnailUrl(), dazu Summary-Felder im Typ Subscription.
- docs/vm-setup.md: Abschnitt "Previews (ffmpeg)" und die neuen Variablen WORKER_DERIVATIVES und WORKER_DERIVATIVES_POLL_SECONDS.

## A6 (bytesDone/bytesTotal): weggelassen

Der bestehende Fortschritt wird nirgends pro Datei festgehalten: download_assets hat keine Byte-Zähler im Lauf, und der Download-Loop schreibt nur Zustände. Für bytesDone müsste der Worker neu mitzählen und regelmäßig in die DB schreiben. Das ist kein kleiner Aufwand mehr. Die Übersicht liefert stattdessen bytesStored je Lauf aus download_runs.

## Wo

Neu:
- migrations/0070_asset_derivatives.sql
- apps/worker/src/derivatives.ts
- apps/api/src/overview-routes.ts
- tests/media/ui2-api.test.ts
- tests/media/derivatives.test.ts
- tests/media/fake-media-tools.ts

Geändert:
- apps/api/src/media-routes.ts
- apps/api/src/schedule-routes.ts
- apps/api/src/app.ts
- apps/worker/src/config.ts
- apps/worker/src/worker.ts
- apps/web/src/api.ts
- docs/vm-setup.md

## Tests

- tests/media/ui2-api.test.ts hat 21 Tests: 401, Rechte (fremd/unbekannt/Admin), Cursor, Filter, counts, Thumbnail (404-Fallback, ETag/304, HEAD, 400), Zusammenfassung, Overview.
- tests/media/derivatives.test.ts hat 26 Tests. Dazu gehört ein gefälschtes ffmpeg/ffprobe (Node-Skripte, tests/media/fake-media-tools.ts).
  - Abgedeckt: Bild, Video, gedrehtes Video, Audio, WebP-Fallback auf JPEG, Farbfehler, Probe-/Encoder-Fehler, Timeout (Probe und Encoder), fehlende Tools, Backfill (Batch, neueste zuerst, idempotent), Wiederholungsgrenze, Abbruch, Schleife und Konfiguration.
  - Geprüft wird auch, dass kein Pfad, keine Werkzeugausgabe und kein Dateiname im Log landen, dass das Arbeitsverzeichnis leer bleibt und dass das Original byteweise unverändert bleibt.

Belegte Befehle (Ergebniszeilen):
- `corepack pnpm exec vitest run tests/media`: "Test Files 5 passed (5) / Tests 130 passed (130)".
- `corepack pnpm check`: "exit 0". Die Ergebniszeilen des Laufs sind "Test Files 76 passed (76)" und "Tests 1550 passed | 1 skipped (1551)". Typecheck, eslint (max-warnings=0) und Build liefen grün.

## Offene Punkte

- **Kein echtes ffmpeg getestet.** Auf dieser Maschine gibt es weder ffmpeg noch ffprobe. Alle Worker-Tests laufen gegen die gefälschten Werkzeuge. Die ffmpeg-Argumente (scale-Filter, libwebp, mjpeg, PPM-Ausgabe) sind aus dem Wissen über die ffmpeg-Optionen geschrieben, aber nicht gegen eine echte Installation ausgeführt. Vor dem Rollout bitte einmal mit echtem ffmpeg auf der VM prüfen. Fällt WebP aus, springt der JPEG-Pfad ein.
- **Werkzeuge werden ohne konfigurierten Hash vertraut.** ffmpeg und ffprobe werden über den Ort gefunden (KURA_TOOL_PATH oder /usr/local/bin:/usr/bin:/bin), nicht über KURA_*_SHA256 wie yt-dlp. Der Hash wird aus der Datei berechnet, damit runExternalProcess ihn akzeptiert. Das prüft also nicht gegen eine Vorgabe des Administrators. Wenn ihr einen festen Hash verlangt, braucht es zwei weitere Variablen.
- **Die Felder in `MediaAsset` (web) sind optional** (`width?` usw.). Pflichtfelder hätten apps/web/src/Media.test.tsx gebrochen, und diese Datei gehört zu UI2-B. Der Server sendet die Felder immer. UI2-B kann sie nach Anpassung der Testdaten zu Pflichtfeldern machen.
- Der Parameter für /api/v1/media heißt `kind` (Task-Text), der bestehende für /subscriptions/:id/media heißt `type`. Das ist unterschiedlich, aber so spezifiziert.
- Die Vorschaubilder liegen als bytea in Postgres (je höchstens 4 MiB, in der Praxis einige KiB bis wenige hundert KiB), außerhalb der Benutzer-Quota. Bei sehr vielen Dateien wächst die DB entsprechend.
- Der Test status.test.ts schlägt ohne gebautes apps/web/dist fehl (vorher schon so). Er läuft innerhalb von `pnpm check` grün, weil `pnpm test` zuerst das Web baut.

## Rückweg

`git revert` der fünf Commits a0384d1..185ac4a. Die Migration 0070 legt nur zwei neue Tabellen und zwei Indizes an. Auf einer bereits migrierten DB lassen sie sich mit DROP TABLE asset_thumbnails, asset_media_info und DROP INDEX download_assets_stored_newest_idx, download_runs_user_finished_idx entfernen. Das berührt keine Originale. Ohne Revert lässt sich die Ableitung mit WORKER_DERIVATIVES=false abschalten.
