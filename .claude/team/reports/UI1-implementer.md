# UI1 Weboberfläche neu gestalten (Design-System, App-Shell, Verlauf als Ledger, Zustände, Barrierefreiheit) - Bericht Implementer

Task t_fe378b05 · req REQ-DL-003 `b83be904af3eded5`, REQ-DL-002 `5d6398de6dbb5063`, REQ-DL-001 `9fd10d9e84b53fb8` · Worktree `/work/wt/ui`, Branch `ui/redesign` (Basis c434f5e)

## Aufgabe

Aussehen und Layout von `apps/web` neu gestalten: Token-System (hell/dunkel), App-Shell mit Sidebar bzw. Top-Bar, Login/Setup als schmales Panel, Dashboard als Statusliste, Tabellen und Statuschips, der Verlauf als Ledger, Zustände (laden, leer, Fehler), Barrierefreiheit. Alle Routen, API-Aufrufe und das deutsche Wording bleiben erhalten, keine neuen Features, keine API-Änderung.

## Status

**Fertig, braucht Review.** `corepack pnpm check` grün, `pnpm audit --audit-level=high` ohne high/critical. Nicht geprüft: andere Browser-Engines, Screenreader, echte CJK-Schrift (siehe "Unbekannt"). Baum sauber bis auf `shots-out/` (bewusst nicht committet).

## Artefakte

Commits auf `ui/redesign` (englische Meldungen, neueste zuletzt):

- `816d340` Design-Tokens, App-Shell, Login/Setup, Dashboard, gemeinsame UI-Bausteine, Kontrasttest
- `90ed744` Tabellen, Chips, Formulare, Verlauf als Ledger
- `02409e2` Tastaturtests, Zustände, Chip-Ausrichtung
- `4cff26c` Zeilenaktionen auf kleinen Bildschirmen, README der Screenshot-Werkzeuge
- dieser Bericht (eigener Commit)

Wichtigste Dateien:

- `apps/web/src/styles/{tokens,base,shell,components,pages,ledger}.css`: alle Farben nur in `tokens.css`, hell und dunkel vollständig.
- `apps/web/src/status.ts`: die **eine** Stelle, die Zustand auf Ton (ok/warn/danger/neutral/accent) und Icon abbildet. Texte kommen aus `labels.ts`, `history-labels.ts` und `schedule-format.ts`, keine duplizierten Strings.
- `apps/web/src/ui/`: `Button`, `Chip`, `StatusChip`, `Banner`, `EmptyState`, `Skeleton`, `Field`, `Dialog`, `DataTable`, `Collapse`, `PageHeader`, `Glyph`.
- `apps/web/src/{AppShell,AuthScreens,Dashboard,Users,Immich,Account,Ledger}.tsx`; `App.tsx` aufgeteilt und in mehrzeilige Form gebracht, `error-message.ts` ersetzt vier duplizierte `errorMessage`-Funktionen.
- `apps/web/public/favicon.svg` (geometrisch, folgt dem Farbschema), `index.html` (lang=de, Titel "Kura", Favicon, color-scheme).
- `apps/web/package.json`, `pnpm-lock.yaml`: drei Abhängigkeiten (siehe Schrift und Icons).
- `tests/ui-shots/`: `contrast.test.ts` (läuft in `pnpm check`), `capture.mjs`, `keyboard.mjs`, `stack.mjs`, `fixtures.mjs`, `README.md`.
- `apps/web/src/Keyboard.test.tsx`: 6 neue jsdom-Tests.

### Schrift und Icons

| Paket | Version | Lizenz | Verwendung |
|---|---|---|---|
| `@fontsource-variable/geist` | 5.3.0 | SIL OFL 1.1 | UI-Schrift |
| `@fontsource-variable/geist-mono` | 5.3.0 | SIL OFL 1.1 | IDs, Hashes, Cron, Zahlen |
| `@phosphor-icons/react` | 2.1.10 | MIT | Icons, eine Familie, Gewicht "regular" |

Installation hat funktioniert, kein Fallback nötig. Die Schriften sind als eigene `.woff2`-Dateien im Build (11 Dateien, 5,8 bis 29,4 kB), kein CDN. `assetsInlineLimit: 0` in `vite.config.ts`, weil die API `Content-Security-Policy: default-src 'self'` sendet und `data:`-URIs sperren würde. Im Browserlauf: keine CSP-Verstöße.

## Zusammenfassung

Zuerst die Befunde, dann das Gebaute.

**Befund 1 (für den Orchestrator): `pnpm check` führt die Web-Tests nicht aus.** Der Root-Vitest nimmt nur `tests/**/*.test.ts`, `pnpm -r` ruft nur `typecheck` und `build` auf. Die `*.test.tsx` in `apps/web/src` laufen nur über `pnpm --filter @kura/web test`. Die "34 files / 633 tests incl. web" aus dem Auftrag stimmen für den heutigen Stand nicht: Baseline gemessen waren 37 Dateien / 663 Tests (+1 skipped) ohne Web, dazu 7 Dateien / 41 Web-Tests separat. Ich habe daran nichts geändert (Root-`package.json` und Root-Vitest sind verboten). Empfehlung: Web-Tests in `pnpm test` aufnehmen. Den Kontrasttest habe ich deshalb unter `tests/ui-shots/` abgelegt, damit er in `pnpm check` läuft.

**Befund 2: Phosphor und `moduleResolution: NodeNext`.** Die `.d.ts` von `@phosphor-icons/react` importieren ohne Dateiendung; unter NodeNext gibt es dann keine Exporte. Ich habe `apps/web/tsconfig.json` auf `module: ESNext`, `moduleResolution: Bundler` gestellt (für eine Vite-App ohnehin die passende Einstellung). Das ist die einzige tsconfig, die ich angefasst habe; die Wurzel-`tsconfig*.json` sind unberührt. Falls `apps/web/tsconfig.json` unter dem Verbot "tsconfig*.json" gemeint war: die Datei ist in einem Commit isoliert änderbar (`816d340`).

Gebaut:

- **Tokens** exakt wie im Auftrag, dazu zwei ergänzte: `--line-strong` (Rand von Eingabefeldern, 3:1 nötig, `--line` hat nur 1,4:1) und `--accent-hover`. Radius-Regel 6/10/999, Schatten nur am Dialog, Spacing 4/8/12/16/24/32/48, Prosa max. 68ch.
- **Shell**: feste Sidebar 232 px, aktiver Eintrag mit accent-soft, Akzentfarbe und 2-px-Balken, Konto und Abmelden unten. Unter 1024 px wird sie zur Top-Bar mit Menü-Button (`aria-expanded`, `aria-controls`, Escape schließt und gibt den Fokus zurück). Es gibt genau eine Navigation im DOM. Skip-Link, `header`/`nav`/`main`, `aria-current`, Fokus geht nach dem Navigieren auf `main`, `document.title` je Seite ("Verlauf | Kura").
- **Testhinweis** als schmaler Streifen oben im Hauptbereich (warn-soft, 1 px warn, 13 px, Icon), Doppelpunkt statt Gedankenstrich, `role` nicht alert.
- **Wortmarke**: wegen Hinweis des Orchestrators **kein Kanji**, sondern eine rein geometrische Marke aus CSS-Boxen (Kachel mit drei Linien) plus Text "Kura". Das Kanji hing an einer CJK-Schrift, die in der Screenshot-Umgebung fehlt (Kästchen). Abweichung vom Auftragstext "蔵 Kura", auf Anweisung.
- **Dashboard**: Statusliste als `dl` in zwei Spalten (Dienst, Version, Datenbank erreichbar, Angewendete Migrationen, Letzte Version, Letzter Abruf), nichts abgeschnitten, keine leere Zelle, lange Werte brechen um und haben `title`. Schnellzugriff als eine Liste in einem Panel (nicht drei Kacheln). Nur vorhandene API-Daten; Worker-/Scheduler-Zustand liefert die API nicht, also nicht angezeigt. Die frühere Platzhalterliste (`labels.areas`) ist entfernt.
- **Tabellen** (`DataTable`): sticky Kopf, 40-px-Zeilen, Hover, Zahlen rechts mit tabular-nums, Hashes und IDs in Geist Mono mit `title`, `th scope="col"`. Unter 640 px gestapelte Label/Wert-Zeilen (`data-label`). Zeilenaktionen sind Ghost-Buttons mit Icon und Text.
- **Chips**: 14 geforderte Zustände plus die tatsächlich vorkommenden (leased, succeeded, discovered, pending, reconciling, uploading, mismatch, active, blocked, Ziel- und Adapter-Verfügbarkeit). Immer Icon + Text.
- **Verlauf als Ledger**: je Beitrag eine Zeilengruppe. Links Quelle und Zeit, Mitte ein segmentierter Balken (ein Segment je Datei, Farbe nach Zustand, nicht gestartete Dateien hohl) mit Textzusammenfassung "3 von 5 gespeichert, 1 fehlgeschlagen", rechts Zustandschip und Stempel. Stempel: "Original verifiziert" (ok, Haken-Icon, durchgezogen) wenn **alle** gespeicherten Dateien einen Prüfbeleg von Immich haben, "Teilweise verifiziert" (gestrichelt) bei einem Teil, "Nicht verifiziert" (neutral, gestrichelt) sonst. Aufklappen per Button mit `aria-expanded`/`aria-controls`, Höhenübergang 150 ms, bei `prefers-reduced-motion` ohne Animation. Zugeklappter Inhalt ist per `visibility` aus Tab-Reihenfolge und Screenreader genommen. Darunter die Läufe als Tabelle.
- **Formulare**: `Field` mit Label oben, Hinweis darunter, Fehlertext mit Icon (`aria-describedby`, `aria-invalid`), 36 px hoch (mobil 40), 2-Spalten-Raster ab 768 px, Fokusring 2 px mit 2 px Abstand. Ein primärer Button je Ansicht.
- **Dialog**: gleiche Fokus- und Escape-Logik wie vorher (nur ausgelagert nach `ui/Dialog.tsx`), neu gestaltet. Löschen eines Abonnements nutzt jetzt den Dialog (vorher ein Inline-Block); gefüllt-rote Buttons gibt es nur dort.
- **Zustände**: Laden als Skeleton-Zeilen (Shimmer nur ohne `prefers-reduced-motion`), leer als ein Satz plus Aktion (primärer Button), Fehler als Banner über dem Inhalt mit Handlungshinweis und "Erneut laden" bzw. "Aktualisieren".

## Prüfung

Ausgeführt, alles im Worktree `/work/wt/ui`:

| Prüfung | Vorher (Baseline c434f5e) | Nachher (4cff26c + Bericht) |
|---|---|---|
| `corepack pnpm check` | exit 0, 37 Dateien, 663 Tests passed, 1 skipped | exit 0, 38 Dateien, 738 Tests passed, 1 skipped |
| Web-Tests `pnpm --filter @kura/web test` | 7 Dateien, 41 Tests | 8 Dateien, 47 Tests |
| `pnpm audit --audit-level=high` | 1 low, 1 moderate, exit 0 | 1 low, 1 moderate, exit 0 (unverändert, nichts aus den neuen Paketen) |
| `pnpm lint` | grün | grün (`--max-warnings=0`) |
| Web-Bundle | JS 248,89 kB (gzip 76,49), CSS 2,09 kB (gzip 0,86) | JS 380,34 kB (gzip 106,97), CSS 26,94 kB (gzip 5,64), dazu 11 Schriftdateien |

Die +75 Tests im Root sind der Kontrasttest (`tests/ui-shots/contrast.test.ts`), +6 Web-Tests sind `Keyboard.test.tsx`. Die JS-Zunahme (+131 kB, +30 kB gzip) stammt zum größten Teil von den Phosphor-Icons (43 verschiedene Icons im Code, jedes Modul bringt alle Gewichte mit) und den neuen Komponenten; die Aufteilung habe ich nicht einzeln gemessen. Tree-shaking greift (nur die importierten Icons im Bundle, im Build sichtbar an 4609 transformierten Modulen, aber nur einem JS-Chunk von 380 kB); die Zahl wäre nur mit weniger Icons kleiner zu bekommen.

Pre-flight laut Auftrag:

- **Kontrast**: `tests/ui-shots/contrast.test.ts` liest `tokens.css` und prüft 33 Paare je Farbschema, Text 4,5:1, Ränder, Fokusring und Segmente 3:1. Alle grün. Gegenprobe: `--ink-muted` testweise auf `#999999` gesetzt, 3 Tests schlugen fehl, danach zurückgesetzt. Der Test prüft außerdem: kein reines Schwarz/Weiß als Textfarbe, keine Farbliterale außerhalb von `tokens.css`, jeder `border-radius` aus der 3er-Skala, Schatten nur am Dialog, genau ein Verlauf (der Lade-Shimmer).
- **Gedankenstriche, Mittelpunkt, Emoji**: `grep -rn -P "[\x{2013}\x{2014}\x{00B7}]" apps/web/src apps/web/index.html` = 0 Treffer (Tests eingeschlossen); Emoji-Suche (U+1F300 bis 1FAFF, 2600 bis 27BF) = 0 Treffer.
- **Ein Radius, ein Akzent**: 0 `border-radius` ohne `var(--radius-*)`; 0 Hex-Farben außerhalb `tokens.css`; kein `text-transform: uppercase`; `letter-spacing` nur -0,01em an Titeln.
- **Keine handgemalten SVG-Icons**: alle Icons Phosphor; Wortmarke aus CSS-Boxen; Favicon ein geometrisches SVG.
- **Beide Themes per Screenshot geprüft**: 61 PNGs, siehe Index.
- **Tastaturpfad**: `Keyboard.test.tsx` (jsdom) und `node tests/ui-shots/keyboard.mjs` (echter Chromium). Letzterer lief mit 37 Prüfungen, alle "ok" (hell, dunkel, mobil), Ausschnitt: Skip-Link ist erster Tab-Stopp und sichtbar, Enter setzt den Fokus auf `main`, Tab erreicht "Übersicht" und "Abonnements", Enter setzt `aria-current="page"`, Fokusring `solid`, 2 px, Abstand 2 px (hell `rgb(38, 74, 136)`, dunkel `rgb(134, 169, 230)`), Abonnement per Tastatur angelegt (Tab, Shift+Tab, Enter), mobil: Menü per Enter öffnen, Escape schließt, Fokus zurück auf den Menü-Button, Button 40 px hoch.
- **Browserkonsole** im Screenshot-Lauf: keine CSP-Fehler, keine fehlgeschlagenen Ressourcen. Zwei erwartete Meldungen: 401 des absichtlich falschen Logins (`login-error`) und 500 der gemockten Fehleransicht (`subscriptions-error`).

### Defekte, die die Screenshot-Schleife gefunden und behoben hat

1. Kanji als leeres Kästchen (kein CJK-Font): durch geometrische Marke ersetzt (Hinweis Orchestrator), sichtbar in `dashboard-light-1440.png`.
2. Dashboard: "Letzte Version" (`0051_sync_state_and_adapters`) abgeschnitten, zweite Rasterzeile mit leerer Hälfte: Zwei-Spalten-Liste, Umbruch, `title`.
3. Schnellzugriff wirkte wie drei Platzhalter-Kacheln: eine Liste in einem Panel.
4. Verlauf, Läufe-Tabelle: Zeitstempel brach in drei Zeilen um: `nowrap` für numerische Zellen.
5. Mobil gestapelte Tabellen: Chip über die ganze Zeile gestreckt, Zweizeilen-Zellen (Dateiname plus Medientyp) zerfielen in zwei Grid-Zellen: Zellinhalt in ein `.cell`-Element gewickelt.
6. Mobil: leere Aktionszeile beim letzten Administrator, Labels in Mono-Schrift: leere Zelle ausgeblendet, Label in Sans.
7. Chips saßen in Tabellenzellen optisch zu hoch: `vertical-align: middle`.
8. Fehlerbanner: Absätze und Button ohne Abstand: Abstände ergänzt.
9. Skeleton-Zeilen zu niedrig gegenüber echten Zeilen: auf 96 px.
10. Mobil: Zeilenaktionen im Abonnement rechtsbündig und ausgefranst: linksbündig unter 1024 px.
11. Mobil: Evidence-Summary unter 40 px hoch: Mindesthöhe 40 px.
12. Screenshots: Ganzseiten-Aufnahmen zeigten Sticky-Leiste und Skip-Link mitten im Bild (Scroll-Artefakt): Skript scrollt vor jeder Aufnahme nach oben.

### Screenshot-Index (`/work/wt/ui/shots-out/`, nicht committet)

Muster `ansicht-theme-breite.png`; jede Ansicht in `light-1440`, `dark-1440`, `light-390`, außer `menu-open` (nur 390).
`setup`, `login`, `login-error`, `dashboard`, `menu-open`, `subscriptions`, `subscriptions-expanded`, `subscriptions-adapters`, `subscriptions-form`, `subscriptions-empty`, `subscriptions-loading`, `subscriptions-error`, `history`, `history-expanded`, `immich`, `immich-transfer`, `users`, `users-dialog`, `dialog`, `limits`, `account`. Zusammen 61 Dateien.

### Echte API gegen Mocks

Echte API (Setup, Login, Benutzer, Abonnements, Zeitpläne, Lauf in die Queue, Pause, Adapterliste, Immich-Freigaben, Limits): so gelaufen. **Per `page.route` gemockt** (in `fixtures.mjs` bzw. `capture.mjs`), weil sie ohne Worker nicht gefüllt werden können: `GET /history` (Läufe und Beiträge), `POST /immich/test-transfer` und `GET /immich/transfers/*`, sowie bewusst leere, verzögerte und fehlerhafte `GET /subscriptions` für die Zustandsansichten.

### Geänderte Tests und Strings

Tests nur dort geändert, wo sich Struktur oder ein Separator ändern musste:

- `App.test.tsx`: "Angewendete Migrationen: 2" ist jetzt `dt` "Angewendete Migrationen" plus `dd` "2" (Definitionsliste).
- `Subscriptions.test.tsx`: Vorschauzeile ` – entfällt:` ist jetzt `, entfällt:` (Gedankenstrich verboten).
- `Sources.test.tsx`: Fähigkeiten stehen als Liste mit einem Eintrag je Fähigkeit statt als Kette mit Mittelpunkten; "Quellen: YouTube" ist jetzt Tabellenzelle "YouTube" unter der Spalte "Quellen".

Geänderte oder neue sichtbare Strings (Auswahl): Testhinweis mit Doppelpunkt; Navigationseintrag "Kura" heißt "Übersicht"; "Datenbank erreichbar: Erreichbar" ist "Datenbank erreichbar" mit "Ja"/"Nein" (sonst wäre "Erreichbar" doppelt); Immich-Status zeigt Chip mit deutschem Kurztext statt Rohwert (`transferStateLabels`, neu); "Aktueller Stand: ... . Das lokale Original bleibt erhalten." statt Mittelpunkt; Zeitplan "ausgeschaltet" als Chip "Ausgeschaltet"; "Noch nicht geprüft" ohne Klammerzusatz (steht als `title`); neue Überschriften und Spaltenköpfe ("Systemstatus", "Schnellzugriff", "Verbindung", "Endpunkt", "Gilt für", "Menü", "Zum Inhalt springen", "Erneut laden", "Zu den Abonnements"). Alle übrigen von Tests geprüften Strings sind unverändert.

## Annahmen

- **Anrede**: Das Beispiel im Auftrag ("Lege dein erstes Abonnement an") ist duzend, die gesamte App siezt ("Legen Sie ..."). Ich habe beim Sie geblieben: "Noch keine Abonnements." / "Legen Sie Ihr erstes Abonnement an."
- **Dritter Stempelzustand** "Teilweise verifiziert" ist meine Ergänzung zu den zwei geforderten. Begründung: "Original verifiziert" nur bei Belegen für alle gespeicherten Dateien, sonst würde der Stempel mehr behaupten, als die Daten belegen (CLAUDE.md: HTTP-Status ist nie Verifikation).
- **Leerer Zustand und Primäraktion**: Auf der Abonnements-Seite sitzt der primäre Button "Abonnement anlegen" im leeren Zustand dort, sonst im Seitenkopf, nie doppelt (eine Primäraktion je Ansicht, und die Tests verlangen genau einen Button).
- **Quellen als Ansicht** gibt es nicht; die Adapter stehen weiter als Aufklappbereich unter den Abonnements.
- **Playwright** liegt nicht im Repo. `stack.mjs` lädt `playwright-core` nur lesend aus `/work/SuperTakt/node_modules/.pnpm/playwright-core@1.62.1/...` (oder `PLAYWRIGHT_CORE_DIR`). Dort wurde nichts verändert.
- **Datenbank**: Das Skript legt eine Wegwerf-Datenbank `kura_shots_<id>` neben `kura_dev` an und löscht sie; es nutzt `postgres://kura_dev:kura_dev@127.0.0.1:5432/kura_dev` (Entwicklungs-Beispielzugang aus dem Auftrag), keine Geheimnisse im Commit. `KURA_SECRET_KEY` wird je Lauf zufällig erzeugt.
- **`.gitignore`** nicht angefasst (nicht in meiner Dateiliste); `shots-out/` ist deshalb untracked und wurde nicht mit `git add` aufgenommen.
- Die Statusliste des Dashboards bleibt bei den bekannten API-Feldern; "Letzter Abruf" ist die Browserzeit des letzten erfolgreichen Abrufs.
- Gelesen, nicht gelaufen: das API-Verhalten für Endpunkte, die ich nicht seede (z. B. OIDC-Start). Der SSO-Link bleibt ein Link mit unverändertem `href`, durch Test abgedeckt, im Browser nicht durchgeklickt.

## Risiken

- **Browser-Features**: `color-mix()` (Chips, Banner) und `:has()` (gestapelte Tabellen, Zellen mit Zweitzeile) brauchen aktuelle Browser (Chrome/Edge ab 111, Safari ab 16.4, Firefox ab 121). Ohne sie bleiben Ränder bzw. Polsterung einfacher, nichts bricht. Nur in Chromium geprüft.
- **Gestapelte Tabellen** setzen `display: block` auf Tabellenelemente; einzelne Screenreader/Browser-Kombinationen verlieren dann die Tabellensemantik. Auf Desktop ist es eine echte Tabelle.
- **Bundle** +131 kB JS (+30 kB gzip); für ein LAN-Tool unkritisch, aber messbar.
- **Wortmarke** weicht vom Auftragstext "蔵 Kura" ab (Anweisung des Orchestrators). Falls das Kanji später doch gewünscht ist, braucht es einen nachgewiesenen Font-Fallback.
- **`apps/web/tsconfig.json`** geändert (siehe Befund 2). Rückweg: Datei auf `816d340^` zurücksetzen und Phosphor-Typen anders lösen.
- **Behaviour-Hinweis**: Das Löschen eines Abonnements läuft jetzt in einem modalen Dialog (vorher Inline-Block), Aufrufe und Texte sind gleich.
- Rückweg insgesamt: `git revert` der vier Commits `816d340..4cff26c` bzw. Branch `ui/redesign` verwerfen; `main` ist unberührt.

## Offene Fragen

- Soll `pnpm test` im Root die Web-Tests einschließen (Befund 1)? Das braucht eine Änderung an der Root-`package.json` oder `vitest.config.mts`, beides außerhalb meiner Freigabe.
- Soll `apps/web/tsconfig.json` als erlaubt gelten (Befund 2)?
- Soll `shots-out/` in die `.gitignore` aufgenommen werden (Orchestrator-Datei oder nicht)?
- Soll es später eine eigene Ansicht "Quellen" geben? Dann wäre die Adapterliste dort besser aufgehoben als in einem Aufklappbereich.

## Unbekannt

- Firefox, WebKit/Safari und mobile Browser: nur Chromium (Playwright 1.62.1, Build 1234, Headless) wurde benutzt.
- Screenreader (NVDA, VoiceOver, TalkBack): Struktur und Namen sind per Test geprüft, das Vorlesen nicht.
- Echte CJK-Schrift: nicht mehr relevant für die Marke, aber `lang="ja"`-Text gibt es nicht mehr.
- Hoher Kontrast (Windows), erzwungene Farben, Zoom 200 % und 400 %, Druckansicht.
- Verlauf mit echten Worker-Daten und sehr vielen Dateien je Beitrag (Segmente werden dann sehr schmal; Mindestbreite 2 px).
- Echte Touch-Bedienung; Zielgrößen per CSS-Mindesthöhe (40 px) und Messung des Menü-Buttons belegt, nicht am Gerät.
- Tastaturverhalten bei geöffnetem Dialog über den Escape-Test hinaus (der Dialog hat weiterhin keine Fokusfalle, wie vor dem Umbau).

## Nächster Schritt

Review durch den Reviewer: Screenshots unter `/work/wt/ui/shots-out/` ansehen (zuerst `history-expanded-*`, `dashboard-*`, `subscriptions-expanded-*`), `corepack pnpm check` und `corepack pnpm --filter @kura/web test` laufen lassen, `node tests/ui-shots/keyboard.mjs`. Danach Orchestrator: Befund 1 (Web-Tests in `pnpm check`) entscheiden, Merge von `ui/redesign` nach `main` und Push macht der Orchestrator.
