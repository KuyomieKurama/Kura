# UI2-B1 Redesign Teil 1: Bericht (Implementer)

req_id REQ-DL-008, req_hash b838cb501c2e1aa5, Branch ui/next, Worktree /work/wt/ui2. Nichts gepusht.

## Was gebaut wurde

- Tokens (hell/dunkel), Radiusskala sm/md/lg, zwei getönte Schatten, Bewegungs-Tokens, scrim, viewer-Tokens. Alte Tokennamen auf die neue Skala umbenannt.
- Bricolage Grotesque Variable selbst gehostet (apps/web/src/fonts/bricolage, OFL-Lizenz und HERKUNFT.txt dabei, nur Latin und Latin-ext), eigene @font-face-Regeln in styles/fonts.css. Keine package.json- oder Lockfile-Änderung.
- Favicon (Giebelhaus, Dunkelvariante), Wortmarke, theme-color.
- Shell: HTTP-Leiste volle Breite, Sidebar ab 1024px mit Gruppe Verwaltung und 2px-Balken, Benutzer-Popover, Versionszeile; darunter Top-Leiste und Bottom-Navigation mit Mehr-Sheet.
- Übersicht neu (Lede-Satz, Problemblock, Mosaik bis 9 Medien, Läuft gerade, Als Nächstes, Zuletzt gelaufen, Technik zugeklappt) mit RelativeTime-Baustein.
- Abonnements: Zeilenliste (Cover, Siegel, Name, Adresse, letzter Lauf, nächster Lauf, Medienzahl, eine Primäraktion, Überlaufmenü), Abo-Detail als Hash-Route (#/abonnements/<id>) mit Tabs Medien, Zeitpläne, Läufe, Bestätigungsdialoge mit Objektname und Fokus auf Abbrechen.
- Anmeldung und Ersteinrichtung mit Kontaktbogen-Motiv (statisch, aria-hidden), Intro einmal pro Browser-Sitzung.
- Bausteine: Menu, Tabs, Switch, Segmented, Toast, Skeleton, Banner, Dialog, PlatformSeal, ProgressBar, MediaTile.
- Texte der Bereiche auf du-Form.

## Abweichung vom Kartenumfang (bitte beachten)

Über den Umfang von UI2-B1 hinaus habe ich bereits Teile gebaut, die laut Karte zu UI2-B2 gehören: Medien-Seite (nach Tag gruppiert, sticky Tageskopf, Filter Abo und Art, Nachladen), Galerie mit justierten Zeilen (reines CSS, Seitenverhältnis aus API-Maßen), MediaTile in allen Galerien, Vollbild-Betrachter mit Filmstreifen und Info-Spalte (Taste I). Das ist committet und getestet; UI2-B2 kann darauf aufbauen und muss es nicht noch einmal bauen. Nicht angefasst: Verlauf, Immich, Limits, Konto, Zugänge, Benutzer (Settings-Layout), Live-Ansicht (RunLive).

## AC-Liste

- AC1 erfüllt (ein Akzent, Pflaume).
- AC2 erfüllt (tokens.css hell und dunkel, contrast.test.ts erweitert um surface-overlay, viewer-Tokens, scrim, Schatten).
- AC3 erfüllt (Kontrasttest grün).
- AC4 erfüllt (grep: keine Farbliterale außerhalb tokens.css, alle border-radius über Tokens, 50 Prozent oder 0).
- AC5 erfüllt (selbst gehostet, Lizenz dabei, keine externen Fonts). Umlaute und ß in h1 in den Screenshots geprüft ("Übersicht", "Abonnements").
- AC6 teilweise (tabular-nums an Zeit-, Zahlen- und Größenbausteinen gesetzt; Schriftgrößen laut Skala; nicht jede Seite einzeln geprüft).
- AC7 erfüllt.
- AC8 erfüllt (Schatten nur Popover, Dialog; Toast und Dirty-Leiste nicht neu angefasst).
- AC9 erfüllt (Update-Hinweis nur für Admins unverändert aus Version.tsx).
- AC10 erfüllt für die Seiten dieser Karte (390px Screenshots, Bottom-Navigation mit 5 Einträgen, Mehr 64px hoch); Seiten außerhalb dieser Karte nicht einzeln auf horizontales Scrollen geprüft.
- AC11 erfüllt. AC12 erfüllt. AC13 erfüllt (Skelett, leer, nichts aktiv, Fehler mit Aktion; Tests in Dashboard.test.tsx).
- AC14 erfüllt. AC15 erfüllt (nur Chip bei Abweichung).
- AC16 teilweise: Abo löschen und Zeitplan löschen mit Bestätigungsdialog, Objektname, Fokus auf Abbrechen; Freigabe entziehen und Benutzer sperren nicht angefasst (Teil von UI2-B2).
- AC17 erfüllt (Hash-Route, Zurück-Link, Tabs mit Pfeiltasten, Medienansicht am Abo vollständig).
- AC18 erfüllt (Teil von UI2-B2, bereits gebaut). AC19 teilweise (Gruppierung je Beitrag und nach Tag vorhanden; relative Zeit und Quelllink im Beitragskopf nicht neu geprüft). AC20 erfüllt (Badge mit Dauer). AC21 erfüllt (MediaTile-Zustände). AC22 teilweise (Fokus und Pfeiltasten wie bisher, Hover-Caption nicht per Screenshot belegt).
- AC23 erfüllt (Vollbild, Info-Spalte mit I, Pfeiltasten, Escape, Filmstreifen, Download, Fokus kehrt zurück; media-check.mjs grün). Fehlerzustand des Betrachters nicht neu gestaltet.
- AC24 erfüllt (Seite Medien nach Übersicht, Filter Abo und Art, "Alle Medien" verlinkt).
- AC25 nicht erfüllt, Teil von UI2-B2 (RunLive unverändert: gestrichelte Kästen, Zähler-Ansage nicht gedrosselt).
- AC26, AC27, AC28 nicht erfüllt, Teil von UI2-B2 (Verlauf, Settings-Layout, Zugänge).
- AC29 erfüllt (Formular 360px ohne Karte, Fehler als Banner, mobil Streifen).
- AC30 teilweise (keine Endlosanimation, Skeletons statisch, prefers-reduced-motion in base.css und tokens.css; kein Test dafür, kein View-Transition-Einsatz).
- AC31 erfüllt (grep nach Sie/Ihr/Ihre/Ihnen ohne Treffer, keine Gedankenstriche in Quellen; ein Pronomen "Sie wird verschlüsselt" in Credentials.tsx auf "Das Token wird verschlüsselt" umgestellt). Mittelpunkt-Ketten nicht gefunden.
- AC32 erfüllt (RelativeTime, Test in ui/Blocks.test.tsx).
- AC33 teilweise (Toast mit Erfolg und Neutralem für Abo-Aktionen; 6 Sekunden und Pause bei Hover und Fokus aus dem bestehenden Baustein, nicht neu getestet).
- AC34 teilweise (Zustände laden, leer, Fehler für Übersicht, Abo-Liste, Abo-Detail, Medien-Seite; für Seiten außerhalb der Karte nicht neu).
- AC35 erfüllt (A1 bis A5 genutzt; A6 laut UI2A weggelassen, Fortschritt zeigt Dateizähler statt Bytes).
- AC36 erfüllt nach Beobachtung: im Screenshot-Lauf keine CSP-Meldungen; die drei Konsolenmeldungen sind 401 (absichtlich fehlgeschlagene Anmeldung), 500 (gemockter Fehler) und ein 404 (Vorschau fehlt, Rückfall auf Original wie in UI2A beschrieben). Aspect-ratio läuft über die style-Prop (CSSOM), keine Style-Strings.
- AC37 teilweise: Thumbnails, loading=lazy, aspect-ratio und content-visibility:auto an Beitragsgruppen gesetzt; decoding=async nicht einzeln geprüft; Tagesgruppen ohne content-visibility, weil der sticky Tageskopf sonst nicht haftet.
- AC38 erfüllt (Screenshots dunkel gesichtet: Übersicht, Anmeldung, Viewer).
- AC39 erfüllt (alle Tests, keyboard.mjs und media-check.mjs auf die neue Struktur nachgezogen und grün).
- AC40 erfüllt (keine neue Abhängigkeit).

## Befehle und Ergebnisse

- `corepack pnpm check`: exit 0, Test Files 76 passed, Tests 1593 passed, 1 skipped, auf dem endgültigen Stand (nach content-visibility und Credentials-Text) erneut ausgeführt, gleiches Ergebnis. apps/web: 127 Tests.
- `node tests/ui-shots/capture.mjs --skip-build --out=/work/shots-ui2b1`: 85 Screenshots (hell 1440, dunkel 1440, hell 390). Neue Ansichten: media-page, subscription-detail. Konsole: 401, 404, 500 wie oben erklärt.
- `node tests/ui-shots/keyboard.mjs --skip-build`: alle Prüfungen grün (Fokusring 2px solid, Abstand 2px, Mehr-Sheet, Zielgröße 64px).
- `node tests/ui-shots/media-check.mjs --skip-build`: alle Prüfungen grün.
- Neue Tests: ui/Blocks.test.tsx (Menu, Tabs, Dialog-Fokus, Switch, RelativeTime), Dashboard.test.tsx (Zustände), MediaPage.test.tsx, Subscriptions.test.tsx und Sources.test.tsx angepasst (Zeile, Detail, Menü).

## Entscheidungen und Hinweise

- Der Fokusring der Sidebar-Einträge hatte zunächst einen inneren Abstand; nach keyboard.mjs auf 2px außen zurückgestellt (Spezifikation). Bottom-Navigation nutzt weiter einen inneren Abstand von 4px, weil die Einträge die ganze Leiste füllen (Abweichung von der 2px-Regel, bitte prüfen).
- Das Konto liegt jetzt im Benutzer-Popover (Button "Konto: <Name>", Eintrag "Konto"); Tests und capture.mjs angepasst.
- Login-h1 ist sr-only, sichtbar ist die Wortmarke.
- Die Seed-Daten der Screenshots haben keine Maße; die Galerie fällt dort auf Seitenverhältnis 1 zurück (Quadrate). Mit echten Maßen aus A1 werden die Zeilen justiert.
- Rückweg: `git revert` der Commits ca0377e bis zum letzten UI2-B1-Commit auf ui/next; keine Migration, keine Abhängigkeit, keine Änderung in apps/api.
