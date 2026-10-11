# UI2-F Nacharbeit Redesign: Bericht

req_id REQ-DL-008, req_hash b838cb501c2e1aa5. Branch ui/next, Ausgangsstand bc8838e.
Screenshots des neuen Stands: /work/shots-ui2f (94 Dateien, Vision-Sichtprüfung der genannten Ansichten).
Prüfungen: Vitest apps/web 146 grün, Root-Vitest (inkl. tests/ui-shots/contrast.test.ts) 1597 grün, pnpm check.

Befund, Status, Beleg

1 Betrachter Pfeile: erledigt. Pfeile neben dem Bild (Bühne mit 56px Innenabstand), Kante und Glyph mit Kontrast, Token viewer-arrow-bg. apps/web/src/styles/media.css, tokens.css, contrast.test.ts (Test "keeps the viewer arrows visible"). Beleg: media-viewer-image-light-1440.png.
2 Betrachter mobil: erledigt. Icon-Buttons 44px mit aria-label, Titel bricht um, Seite dahinter nicht sichtbar. MediaViewer.tsx, media.css. capture.mjs prüft Deckkraft und Ecken (settle). Beleg: media-viewer-image/-video-light-390.png.
3 Verlauf Läufe: erledigt. Liste statt Tabelle, ein Zustand je Zeile, Chip nur bei Abweichung, kein Jahr im laufenden Jahr, Lede ein Satz. History.tsx, Ledger.tsx, ledger.css, schedule-format.ts. Beleg: history-light-1440.png, -390.png. Tests in Sources.test.tsx.
4 AC19 Beitragskopf: erledigt. Zeit, Quelllink, "Ohne Titel vom TT.MM." statt roher ID. media.ts, MediaGrid.tsx. Test in Media.test.tsx. Beleg: media-grid-light-1440.png.
5 Nur 9 von 14 Dateien: erledigt. content-visibility nur noch für große Gruppen, Harness schaltet sie für Aufnahmen ab. media.css, capture.mjs.
6 Übersicht: erledigt. nowrap-Gruppe für "Nächster Lauf", 7/5-Raster, Zuletzt gelaufen volle Breite. Dashboard.tsx, overview.css. Beleg: dashboard-light-1440.png.
7 Immich unter Verwaltung: erledigt. App.tsx (group admin).
8 Sidebar nur ein Signal: erledigt. Die graue Fläche war der Hover (Mauszeiger im Screenshot). Aktiv hat nur den Balken. Harness parkt die Maus am Rand (settle in capture.mjs).
9 Testleiste mobil: erledigt. Kurztext mit "HTTP" (labels.insecureShort, AppShell.tsx).
10 Filterzeile: erledigt. In der Titelzeile, Select mit eigenem Caret, mobil volle Breite. MediaPage.tsx, media.css.
11 Live-Block: erledigt. Nur Haarlinien oben und unten (media.css .run-live), Jahr nur bei anderem Jahr (formatInstant).
12 Abo-Zeile: erledigt. PlatformSeal, Platzhalter ohne Bild mit Monogramm, 24px Spaltenabstand, Track-Token mit Kontrasttest. Subscriptions.tsx, subscriptions.css, ui.css, tokens.css (track). Beleg: subscriptions-light-1440.png, -390.png.
13 Beitragsliste: erledigt. Haarlinien statt Karte, Tagesüberschrift 30px, ein Zustand je Zeile. Ledger.tsx, ledger.css. Beleg: history-light-1440.png.
14 Einstellungen: erledigt. Neue Lede und Zustandssatz (Immich), Einheiten als Suffix, Platzhalter "Kein Limit", ein Hinweis je Gruppe, Dirty-Leiste sticky, Zeitstempel ohne Sekunden (absoluteMinute), Begriffe ersetzt. AdminLimits.tsx, Immich.tsx, Credentials.tsx, settings.css. Tests in AdminLimits.test.tsx, App.test.tsx. Beleg: limits-light-1440.png, limits-dirty-light-1440.png/-390.png, immich-light-1440.png.
15 Benutzer: erledigt. Liste mit Avatar, "Du", Chip nur bei Sperre. Users.tsx, settings.css. Tests in App.test.tsx, Keyboard.test.tsx. Beleg: users-light-1440.png, -390.png.
16 Kontaktbogen: erledigt. Drei Töne, im Dunkelmodus hellere Kante; Fehlertext mit fettem ersten Satz; feste Position der Spalte, damit das Banner nichts verschiebt. auth.css, AuthScreens.tsx. Beleg: login-error-light-1440.png, login-dark-1440.png.
17 Mono-Schrift: erledigt, Ursache war nicht reproduzierbar als Fehler. Das Harness wartet auf Schriften und meldet, wenn Geist Mono sichtbar benutzt, aber nicht geladen ist (capture.mjs). Der Lauf meldet nichts. Die Serifen sind das r und a von Geist Mono. Beleg: users-light-1440.png.
18 Betrachter Herunterladen: erledigt. Akzent-Primär (Tokens viewer-accent*, Kontrasttest 4,5:1). "Schließen" bleibt mit Text auf breiten Ansichten, mobil nur X-Icon. Beleg: media-viewer-image-light-1440.png.
V9 Betrachter deckend über allem, Filmstreifen kollidiert nicht mit der Navigation: erledigt, siehe Befund 2. Der Harness-Check schlägt fehl, wenn an Ecken und unterem Rand Inhalt der Seite dahinter getroffen wird.

Offene Punkte
- Die Konsolenmeldungen 401 und 500 im Capture-Lauf stammen aus dem absichtlichen Fehlerzustand (Login-Fehler, 500-Fixture).
- In den Full-Page-Shots schwebt die Bottom-Navigation und die Dirty-Leiste mitten im Bild. Das ist ein Artefakt der Vollseitenaufnahme, nicht der Seite.
