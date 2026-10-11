# UI2-B2 Redesign Teil 2: Bericht (Implementer)

req_id REQ-DL-008, req_hash b838cb501c2e1aa5, Branch ui/next, Worktree /work/wt/ui2. Nichts gepusht.
Commits auf ui/next: d6c0a75 (Sichtprüfung UI2-B1, Punkte 1 bis 11), 0dab471 (AC25 bis AC28) und der Abschluss-Commit mit AC16-Rest, AC30-Test und diesem Bericht (siehe git log).

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

## Weitere Schließungen aus dem UI2B1-Bericht

- AC16 Rest: "Freigabe entziehen" (Immich) und "Benutzer sperren/entsperren" öffnen jetzt einen Bestätigungsdialog, der das Objekt beim Namen nennt (Endpunkt bzw. Anzeigename und Benutzername), Fokus auf Abbrechen. Die Knöpfe in den Tabellenzeilen tragen aria-label mit dem Objekt. Tests: App.test.tsx.
- AC30: styles/motion.test.ts prüft, dass keine Endlosanimation existiert und dass prefers-reduced-motion Animationen, Übergänge und die Dauer-Tokens abschaltet.

## AC-Liste AC1 bis AC40

- AC1 bis AC5, AC7 bis AC9: erfüllt wie im UI2B1-Bericht (unverändert; contrast.test.ts grün, keine Farbliterale außerhalb tokens.css, Schrift selbst gehostet). Neue CSS in settings.css, ledger.css, media.css nutzt nur Tokens.
- AC6: teilweise. tabular-nums an den Zahlenbausteinen, neue Zähler (Satz der Live-Ansicht, Segmentzeile, Kopf der Verlaufszeile) tragen die Klasse num. Nicht jede Seite einzeln vermessen.
- AC10: erfüllt für alle in dieser Karte gebauten Seiten (390 px Screenshots live-run, history, immich, limits, account); keyboard.mjs grün. Kein horizontales Scrollen in den Aufnahmen gesehen, aber keine automatische Messung.
- AC11 bis AC15: erfüllt (UI2B1) und durch die Sichtprüfungspunkte 1 bis 11 nachgebessert.
- AC16: erfüllt (Abo löschen, Zeitplan löschen, Freigabe entziehen, Benutzer sperren, Zugänge löschen: alle mit Dialog, Objektname, Fokus auf Abbrechen).
- AC17, AC18, AC20, AC24: erfüllt (UI2B1; media-check.mjs und keyboard.mjs grün).
- AC23: erfüllt seit Runde 2. Vollbild, Info-Spalte, Filmstreifen, Pfeile, Escape, Fokusrückkehr wie bisher (media-check.mjs, Media.test.tsx). Neu: viewTransition.ts (openViewer) öffnet den Betrachter in document.startViewTransition, wenn der Browser sie kennt und prefers-reduced-motion nicht gesetzt ist; das Bild der Kachel bekommt view-transition-name viewer-media, .viewer-frame trägt denselben Namen, Dauer 240 ms über --dur-viewer-morph. Ohne API oder bei reduzierter Bewegung öffnet er sofort und blendet 160 ms ein (data-enter=fade, --dur-viewer-fade, keyframes viewer-fade-in). Beide Tokens sind unter reduced-motion 0.01ms. Beleg: Gallery.test.tsx (öffnet ohne API sofort; öffnet in startViewTransition und benennt das Kachelbild, entfernt den Namen danach; überspringt bei reduced-motion), motion.test.ts (Tokens, Keyframes, Namen, Dauer). Grenze: der Morph selbst ist nicht als Video oder Bildfolge geprüft, nur dass er ausgelöst wird und die Browserläufe (keyboard.mjs, media-check.mjs, capture.mjs) in Chromium ohne Fehler durchlaufen.
- AC19: erfüllt für Gruppierung je Beitrag und Tag; relative Zeit im Beitragskopf der Medienansicht nicht erneut geprüft.
- AC21: erfüllt. MediaTile (Vorschau, Original, Glyph und Text) und neue Zustandskacheln für wartet, lädt, fehlgeschlagen. Platzhalter aus averageColor, sonst surface-sunken. Test: Media.test.tsx.
- AC22: teilweise. Fokus und Pfeiltasten wie bisher; Hover-Caption nicht per Screenshot belegt.
- AC25: erfüllt (Satz, Balken role=progressbar, Kachelreihe über Gallery, Zustandskacheln, Ansage höchstens alle 5 s per useThrottledText). Die 5-Sekunden-Drosselung ist seit Runde 2 per Fake-Timer getestet (Gallery.test.tsx, useThrottledText: erste Änderung sofort, dann nur der jeweils letzte Text nach Ablauf von 5 s).
- AC26: erfüllt (Tagesgruppen, 56px-Bild, Segmentbalken, Chips nur bei Abweichung, Prüfsumme unter Technische Details). Test: Sources.test.tsx.
- AC27: erfüllt für Immich, Limits, Konto; auch Zugänge und Über Kura. Benutzer (Tabelle) und Version haben keine Formularspalte und nutzen das Seitenlayout ohne SettingsSection.
- AC28: erfüllt. Test: Credentials.test.tsx (vier Zeilen, Dialog, Risikohinweis genau einmal je Dialog).
- AC29: erfüllt (UI2B1).
- AC30: erfüllt (motion.test.ts). View Transitions werden seit Runde 2 eingesetzt (siehe AC23); die Regel für reduced-motion (::view-transition-* ohne Animation, Dauer-Tokens 0.01ms) steht in media.css und tokens.css und ist durch motion.test.ts und Gallery.test.tsx belegt.
- AC31: erfüllt. grep über Quellen ohne Treffer, zusätzlich prüft capture.mjs jeden Screenshot gegen alle gerenderten Texte und Attribute (Gedankenstrich, Emoji, Mittelpunkt, Sie-Form).
- AC32: erfüllt (UI2B1).
- AC33: erfüllt für Zugänge (Erfolg als Toast, Fehler als Banner im Dialog); Verhalten des Toast-Bausteins (6 s, Pause bei Hover und Fokus) unverändert, nicht neu getestet.
- AC34: teilweise. Zustände laden, leer, Fehler für Zugänge, Live-Ansicht und Verlauf vorhanden; Immich und Limits haben nur die vorhandenen Zustände.
- AC35: erfüllt (UI2B1).
- AC36: erfüllt nach Beobachtung. Keine CSP-Meldungen; die drei Konsolenmeldungen sind 401 (absichtlich falsche Anmeldung), 500 (gemockter Fehler) und 404 (Vorschau fehlt, Rückfall auf Original). Daher endet capture.mjs mit Exit 2, das ist die vorhandene Regel bei Konsolenmeldungen.
- AC37: teilweise (unverändert: Vorschaubilder, lazy, decoding=async, aspect-ratio; Tagesgruppen ohne content-visibility, weil der sticky Kopf sonst nicht haftet). Das 56px-Bild im Verlauf lädt lazy und async.
- AC38: erfüllt (dunkle Screenshots von live-run und history gesichtet).
- AC39: erfüllt (siehe unten).
- AC40: erfüllt (keine neue Abhängigkeit).

## Befehle und Ergebnisse

- corepack pnpm check: exit 0 (76 Testdateien, 1593 Tests, 1 übersprungen). Hinweis: Dieses Root-Vitest enthält die Tests unter apps/web nicht.
- cd apps/web und vitest run: 19 Dateien, 134 Tests grün. Davon neu oder umgebaut: Credentials.test.tsx (15), Media.test.tsx (AC25), Sources.test.tsx (AC26), Subscriptions.test.tsx, App.test.tsx (Freigabe, Benutzer sperren), styles/motion.test.ts.
- node tests/ui-shots/capture.mjs --skip-build --out=/work/shots-ui2: 91 Screenshots (Runde 2: neu version-light-1440, version-dark-1440, version-light-390, gesichtet; im 390er Vollbild-Bild liegt die fixierte untere Navigation über dem Text, das ist ein Effekt des Vollbild-Screenshots, nicht der Seite). Vorher 88 Screenshots (hell 1440, dunkel 1440, hell 390), Exit 2 wegen der drei erklärten Konsolenmeldungen. Neue Aufnahme account-dialog.
- node tests/ui-shots/keyboard.mjs --skip-build: alle Prüfungen grün. node tests/ui-shots/media-check.mjs --skip-build: alle Prüfungen grün.
- Gesichtet und korrigiert: live-run, history, history-live, immich, limits, account, account-dialog (hell, dunkel, 390). Nicht jede der 88 Aufnahmen einzeln angesehen.

## Hinweise und offen

- Aufnahmen der Vollseite: bei 390 px liegt die fixe Bottom-Navigation mitten im Bild, bei Dialogen endet das Overlay auf Viewport-Höhe. Artefakt der Vollseiten-Aufnahme.
- In der dunklen Aufnahme des Abo-Details zeigen einige Kacheln unterhalb des Falzes nur die Platzhalterfarbe (averageColor), weil die Bilder lazy laden und der Screenshot vor dem Nachladen entsteht. Kein leerer Kasten, aber die Harness wartet nicht auf alle Bilder.
- Ein Screenshot-Lauf brach einmal mit Timeout beim Laden der Übersicht ab und lief beim Wiederholen durch; Ursache nicht untersucht.
- Die Punkte (1), (5), (6), (10) der Sichtprüfung sind per Screenshot und CSS bestätigt, aber nicht mit eigenen Tests belegt.
- Immich.tsx hat apiKey-Felder; Werte werden nirgends protokolliert.
- Nicht verifiziert: andere Browser als das Chromium der Harness.
- Rückweg: git revert der Commits d6c0a75 bis zum Abschluss-Commit auf ui/next; keine Migration, keine Abhängigkeit, keine Änderung in apps/api.

## Runde 2 (Änderungswünsche des Reviews)

- Betrachter: View Transition mit 160-ms-Rückfall (AC23, siehe oben).
- Neue Tests (Gallery.test.tsx, 7 Tests): aspectRatio (Verhältnis, Klammer 0.6 bis 2.4, 1 bei unbekannter Größe), Gallery setzt --ar je Kachel, Zustandskacheln für nicht gespeicherte Dateien, Drosselung der Ansage, openViewer (3 Fälle); motion.test.ts um einen Test erweitert.
- capture.mjs nimmt die Ansicht version auf (README ergänzt).
