# UI2-B2 Redesign Teil 2: Bericht (Implementer)

req_id REQ-DL-008, req_hash b838cb501c2e1aa5, Branch ui/next, Worktree /work/wt/ui2. Nichts gepusht.
Zwei Commits: d6c0a75 (Sichtprüfung UI2-B1, Punkte 1 bis 11) und der Commit mit AC25 bis AC28 (siehe git log).

## Sichtprüfung UI2-B1 (Orchestrator asuna), abgehakt

- [x] (1) Mosaik-Captions: Caption-Layout der Kacheln vereinheitlicht, nichts mehr abgeschnitten oder anders gesetzt.
- [x] (2) Video-Kachel nie leer (AC21): MediaTile zeigt Vorschaubild, fällt auf das Original zurück, danach Glyph und Text. Die Fixtures der Screenshots liefern jetzt echte Vorschauen (480 px WebP) und Durchschnittsfarbe wie der Worker.
- [x] (3) Fortschritt aus einer Quelle: run-progress.ts (gespeicherte Dateien von allen Dateien). Satz, Prozent und Balken lesen dieselben zwei Zahlen. Die Angabe "1 B gespeichert" ist entfernt.
- [x] (4) "Jetzt ausführen" ist bei laufendem Lauf deaktiviert, Hinweis "Es läuft bereits ein Lauf". Test und Screenshot-Lauf prüfen das.
- [x] (5) Spaltenkopf "Medien" und Zahlen gleich ausgerichtet.
- [x] (6) Zeilenhöhe stabil (min-height 96px, laufende Zeile nicht höher).
- [x] (7) Abgeschnittene Abo-Namen haben title.
- [x] (8) "Pausiert" nur einmal (Chip); die Spalte Nächster Lauf sagt "Kein Lauf geplant", der letzte Lauf bleibt sichtbar.
- [x] (9) Überlaufmenü-Knopf hat aria-label "Weitere Aktionen für <Name>" (Test).
- [x] (10) Untertitel ohne verwaistes "Min." (nowrap für die Zeitangabe), Sidebar-Trennlinie läuft bis zum Seitenende (sticky nur der Inhalt), Leerfläche unter "Als Nächstes" verkleinert.
- [x] (11) Kein Gedankenstrich in der Zuletzt-Zeile; capture.mjs prüft jetzt bei jedem Screenshot alle gerenderten Texte (Textknoten sowie title, aria-label, placeholder, alt) auf Gedankenstrich, Emoji, Mittelpunkt und Sie-Form (AC31). Das Quellcode-grep bleibt zusätzlich.

## AC25 bis AC28

- AC25 Live-Ansicht: ein Satz mit Zählern, ein Gesamtbalken (role=progressbar, gleiche Zahlen), Kachelreihe über Gallery. Nicht gespeicherte Dateien haben Zustandskacheln (Wartet, Wird geladen mit 3px-Linie, Fehlgeschlagen mit Grund als title), keine gestrichelten Kästen. Ansage für Screenreader als eigene Region, höchstens alle 5 Sekunden.
- AC26 Verlauf: Gruppen nach Tag, Beitragszeile mit 56px-Vorschaubild (Glyph darunter, Bild blendet ein), Segmentbalken unter dem Titel, nur Abweichungen als Chip (Teilweise gespeichert, Nicht zugänglich, Teilweise verifiziert), Prüfsumme nur unter "Technische Details".
- AC27 Einstellungen: neue Bausteine SettingsSection (280px Erklärung, Formular höchstens 640px, unter 1280px untereinander) und FileField (deutscher Knopf "Datei wählen", "Keine Datei gewählt"). Angewendet auf Immich, Limits, Konto (Passwort, Über Kura) und Zugänge.
- AC28 Zugänge: eine Liste mit vier Zeilen (Name, Chip, Fakten, Aktion). Hinterlegen, Ersetzen und Löschen im Dialog; der Risikohinweis steht genau einmal je Dialog. Erfolg als Toast.

## Tests und Prüfung

- corepack pnpm check: exit 0 (76 Testdateien, 1593 Tests, 1 übersprungen).
- Neue oder umgebaute Tests: Credentials.test.tsx (Liste, Dialoge, Pixiv, Löschen, fehlender Schlüssel), Media.test.tsx (AC25), Sources.test.tsx (AC26), Subscriptions.test.tsx (Punkte 4, 8, 9).
- Screenshots geprüft: live-run, history, history-live, immich, limits, account, account-dialog (hell 1440, dunkel, hell 390).

## Hinweise und offen

- Die Screenshots der Vollseite zeigen bei 390 px die fixe Bottom-Navigation mitten im Bild und bei Dialogen ein Overlay nur bis zur Viewport-Höhe. Das ist ein Artefakt der Vollseiten-Aufnahme, nicht der Oberfläche.
- Der Screenshot-Lauf brach einmal mit einem Timeout beim Laden der Übersicht ab und lief beim Wiederholen durch. Ursache nicht untersucht.
- Die Konsolenmeldungen 401, 500 und 404 im Screenshot-Lauf stammen aus den absichtlichen Fehlerfällen der Harness (Login-Fehler und andere), nicht überprüft je Eintrag.
- Immich.tsx hat apiKey-Felder; Werte werden nirgends protokolliert.
- Nicht verifiziert: Browser außer dem Chromium der Harness.
