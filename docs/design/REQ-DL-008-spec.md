# YS1 Spezifikation

Nutzerziel: Der Admin sieht beim Öffnen sofort, was Kura geholt hat und ob etwas seine Aufmerksamkeit braucht, und blättert gern durch die Bilder. Design-Lesart: Kura ist ein stilles Archivregal, das beim Öffnen sein Bildmaterial zeigt (Kontaktbogen-Motiv): neutrales Papier und Tinte, ein Pflaumenton als einziges Signal, Bilder als einzige große Farbfläche, Überschriften mit Charakter, alles andere Linien und Raum. Kühnheit nur an einer Stelle: Übersichts-Mosaik, Galerie und Vollbild-Betrachter. Selbstkritik (Standard, den jedes Modell liefern würde, und was ersetzt wird): weiße Karten auf kühlem Grau mit Haarlinie -> Linien und Raum, Karten nur für Popover und Dialoge; Indigo-Akzent -> Pflaume #9A2A66; Geist/Slate-Optik -> Bricolage Grotesque für Überschriften und Zahlen, Geist nur für Fließtext; Systemstatus-Liste und Schnellzugriff-Kacheln -> Aktivität, Mosaik, Fortschritt, Zeitbezug; grüne Pills überall -> Ruhe ist der Normalzustand, nur Abweichungen bekommen Farbe und Chip; sieben Buttons je Zeile -> eine Primäraktion plus Menü; quadratische Platzhalter-Kacheln -> Galerie mit echten Seitenverhältnissen; kleine Radien 6/10/Pille -> eine konzentrische Regel 4/8/16; Schatten nur im Dialog -> zwei getönte Schatten für Popover und Dialog; Shimmer-Skelette -> statische Skelette in Endform. Ehrliche Grenze: Ohne echte Maße, Dauer und Thumbnails vom Server bleibt die Galerie ein Kasten. Die API-Anforderungen unter components/A1 bis A6 sind Voraussetzung für das Ziel, kein Beiwerk.


## layout

GLOBAL
Breiten: Shell ab 1024px mit Sidebar 248px, darunter Top-Leiste plus Bottom-Navigation. Seitenrand 40px (1024 bis 1439: 32px, mobil 20px). Inhaltsbreiten: Listen und Medien bis 1360px (Medien-Seiten bis 1600px), Formularseiten 'Settings-Layout': links Erklärspalte 280px (Überschrift 24px plus 2 bis 3 Zeilen Text), rechts Formular maximal 640px. Der Inhalt ist immer linksbündig an der Sidebar, die Breite hat damit einen Grund. Ersetzt: Inhalt endet bei 1036px ohne Absicht.
Rhythmus: Abschnittsabstand 48px, Seitenkopf zu Inhalt 32px, Zeilenpolster 16px, Galerie-Abstand 6px (mobil 4px). Dichte nach Zweck: Listen kompakt, Galerie eng, Abschnitte großzügig.

SHELL 1440
+--------------------------------------------------------------------------+
| Testbetrieb: Die Verbindung ist unverschlüsselt (HTTP).   (32px, volle Breite über Sidebar und Inhalt)
+-------------+------------------------------------------------------------+
| [K] Kura    |  Übersicht                                                 |
|             |                                                            |
| Übersicht * |  (Inhalt, Seitenrand 40px)                                 |
| Medien      |                                                            |
| Abonnements |                                                            |
| Verlauf     |                                                            |
|             |                                                            |
| Verwaltung  |   (Gruppenname 13px muted, Satzschreibung, kein Versal-Eyebrow)
| Immich      |                                                            |
| Benutzer    |   (nur Admin)                                              |
| Limits      |   (nur Admin)                                              |
|             |                                                            |
| (MA) Mara A.|   Klick öffnet Popover nach oben: Konto, Abmelden          |
| Kura 0.2.0  |   bei Update (nur Admin): Update auf 0.3.0 verfügbar (Akzent)|
+-------------+------------------------------------------------------------+
'*' = aktives Element: 2px Akzent-Balken links am Eintrag, Text bleibt ink, aria-current=page. Genau ein Signal, keine Füllung, keine Farbänderung.

SHELL 390
Top-Leiste 56px: Marke links, Seitentitel entfällt. Bottom-Navigation 64px (plus Safe-Area): Übersicht, Medien, Abos, Verlauf, Mehr. Aktiv = 2px Akzent-Balken oben am Eintrag. Mehr öffnet ein Bottom-Sheet (Dialog): Immich, Benutzer, Limits, Konto, Version, Abmelden. Nur eine Navigation im DOM (bedingtes Rendering per matchMedia). Testbetrieb-Leiste einzeilig über der Top-Leiste. Fallback, falls der Orchestrator die Bottom-Navigation ablehnt: bestehende Disclosure-Navigation mit den neuen Tokens.

ÜBERSICHT 1440 (Inhaltsbreite 1112px)
Übersicht                                           (h1 Bricolage 44)
Vor 3 Min. hat Kura 4 neue Dateien von Atelier Mori gespeichert. Nächster Lauf in 2 Std. 10 Min.   (Lede 17px, Zeitangaben in ink)
[nur bei Problemen] Braucht dich: Fotoblog Hafen: Anmeldung abgelaufen.  [Zugang erneuern]
Zuletzt geladen                                       Alle Medien
+---------------------+------+------+------+
|                     |  B   |  C   |  D   |   6 Spalten, Abstand 6px, Zeilenhöhe = Spaltenbreite (ca. 181px)
|          A          +------+------+------+   A = 2x2, B bis I = 1x1, in Summe 9 Kacheln
|        (2x2)        |  E   |  F   |  G   |   Zuschnitt cover, Begründung: festes Mosaik, im Betrachter vollständig
+---------------------+------+------+------+
Läuft gerade (7 von 12 Spalten)              | Als Nächstes (5 von 12)
(Siegel) Atelier Mori                         | Heute 08:55   Atelier Mori      in 2 Std.
Lädt Datei 3 von 5            62 %            | Mo., 12.10., 02:30  Kanal Nordlicht
[=========-----]  12,4 von 48 MiB             |
Zuletzt gelaufen                                         Verlauf öffnen
Heute 02:09  Atelier Mori   11 Dateien gespeichert
Gestern 00:45  Kanal Nordlicht   Teilweise: 1 Datei fehlgeschlagen   (nur diese Abweichung farbig)
> Technik   (zugeklappt: Dienst, Datenbank, Version, Letzter Abruf. Migrationen und Dateiname entfallen)
Reihenfolge ist Priorität: Probleme, Mosaik, Aktivität, Rückblick, Technik. Problemblock fehlt komplett, wenn nichts anliegt (kein Alles-ok-Chip).

ÜBERSICHT 390: eine Spalte; Mosaik 2 Spalten: A 2x2 plus 4 Kacheln (4 Reihen); danach Läuft gerade, Als Nächstes, Zuletzt gelaufen. Zeilenpolster 16px, Touch-Ziele 44px.

ABONNEMENTS 1440
Abonnements  3                                   [+ Abonnement anlegen] (einziger gefüllter Button der Seite)
Kura beobachtet diese Quellen und lädt neue Beiträge automatisch.
 Abonnement                       Letzter Lauf              Nächster Lauf   Medien
----------------------------------------------------------------------------------------------
[Cover 64] (Px) Atelier Mori      Heute 02:09               in 2 Std.        14        [Jetzt ausführen] [...]
           pixiv.net/users/4411   11 neue Dateien
----------------------------------------------------------------------------------------------
[Cover 64] (YT) Kanal Nordlicht   Gestern 00:45             Mo., 12.10.      212       [Jetzt ausführen] [...]
           youtube.com/@nordlicht Teilweise: 1 fehlgeschlagen   (Chip warn)
----------------------------------------------------------------------------------------------
[Cover grau] (Lk) Fotoblog Hafen  Pausiert (Chip neutral)       Pausiert        8         [Fortsetzen] [...]
Spaltenköpfe 13px muted, einmalig oben (CSS Grid, Container Query, kein table). Zeile: keine Karte, nur Haarlinie, Hover Fläche surface-sunken. Name plus Cover sind ein Button (öffnet Detail), Kontext-Primäraktion ist ein zweiter Button, kein verschachteltes Interaktives.
Läuft ein Lauf: unter dem Letzter-Lauf-Text Akzent-Text 'Lädt 3 von 5' und 4px Balken 120px.
Überlaufmenü [...]: Adresse prüfen, Bearbeiten, Pausieren (oder Fortsetzen), Trennlinie, Abonnement löschen (danger-Text). Löschen immer mit Bestätigungsdialog.
ABONNEMENTS 390: Zeile gestapelt: Cover 72 links, rechts Name (17px/600), Plattform in Klartext, Letzter Lauf, Nächster Lauf plus Medienzahl; darunter Primärbutton in voller Breite 44px; [...] oben rechts. Keine Spaltenköpfe.

ABO-DETAIL (eigene Ansicht, Hash-Route #/abonnements/<id>, Zurück-Link 'Abonnements', Browser-Zurück funktioniert)
(Siegel 40) Atelier Mori                         [Jetzt ausführen] [...]
pixiv.net/users/4411  (mono 13px, externer Link)
14 Medien, 13 Bilder und 1 Video. Letzter Lauf heute 02:09, nächster in 2 Std.   (Satz statt KPI-Kacheln)
[Läuft gerade: nur wenn aktiv]
Medien 14 | Zeitpläne 2 | Läufe        (Tabs, aktiv = 2px Akzent-Unterstrich, Pfeiltasten wechseln)
Tab Medien: Filter Alle 14 | Bilder 13 | Videos 1 (Segmented Control, Track surface-sunken, aktiv surface-overlay), dann je Beitrag: Titel 17px/600, rechts '2 Dateien, vor 3 Tagen' und 'Beitrag auf Pixiv öffnen'; darunter justierte Galerie.
Tab Zeitpläne: Liste. Zeile: 'Täglich um 02:30 Uhr' (15px/600), Meta 'Nächster Lauf Mo., 12.10., 02:30 (Europe/Berlin), Startverzögerung bis 30 s', rechts Schalter 'Aktiv' (role=switch) und [...] (Bearbeiten, Löschen). Darunter [Zeitplan hinzufügen] (sekundär).
Tab Läufe: letzte 10 als Liste: Zeit (tnum), Auslöser, Ergebnis-Satz, Versuche nur wenn mehr als 1, Link 'Alles im Verlauf'.

GALERIE (justierte Zeilen, CSS-only)
Kachel hat --ar = width/height, geklemmt auf 0.6 bis 2.4 (darüber hinaus cover-Zuschnitt, begründet: Panoramen und Streifen würden Zeilen sprengen). Container: display:flex; flex-wrap:wrap; gap:6px; Zielzeilenhöhe 220px (1440), 180px (Tablet), 140px (390). Kachel: flex: calc(var(--ar)*100) 1 calc(var(--ar)*var(--row-h)); aspect-ratio: var(--ar). Abschluss-Pseudoelement ::after mit flex-grow:1000000 verhindert gestreckte Schlusszeile. Beitrag mit einem Bild bleibt klein. Fehlen Maße, ar=1 (Platzhalter, nie kaputt).

MEDIEN-SEITE (neu, Empfehlung: ja)
Navigation: nach Übersicht. Begründung: Medien sind der emotionale Kern und liegen heute drei Ebenen tief (Abo, Zeile aufklappen, Medien); eine Familie will blättern. Die Medienansicht am Abo bleibt vollständig (REQ-DL-006).
Medien                                    [Alle Abonnements v]  [Alle | Bilder | Videos]
Heute  (sticky, Bricolage 24, solide Fläche, kein Glas)   9 Dateien
[justierte Galerie über die ganze Breite, nur Kachel-Caption bei Hover/Fokus]
Gestern ...  /  Mo., 5. Oktober ...
Gruppierung nach Speichertag (storedAt), neueste zuerst; Button 'Weitere 40 laden' mit '40 von 214'. Der Betrachter blättert über alle geladenen Dateien.

BETRACHTER (Vollbild statt kleinem Dialog)
+--------------------------------------------------------------+
| Frühlingsserie, Teil 3                  10 von 14   [Info] [X]|
|                                                              |
| (<)             Bild/Video, contain, max Viewport       (>)  |
|                                                              |
| Filmstreifen: Dateien desselben Beitrags, 56px, aktives gerahmt|
+--------------------------------------------------------------+
Info-Spalte 360px rechts (Taste I, Standard offen ab 1280px, mobil darunter scrollbar): Beitrag, Quelle ('Beitrag auf Pixiv öffnen'), Gespeichert am, Größe/Typ/Maße, Immich-Zustand in einem Satz, Herunterladen (Primär), Dateiname mono 12px. Hintergrund --viewer-bg in beiden Themen dunkel (Fotos auf Dunkel). Prev/Next als 48px-Flächen am Rand, Pfeiltasten, Escape schließt, Fokus kehrt zur Kachel zurück. Öffnen per View Transition (Kachel zu Betrachter, 240ms), Fallback Einblenden 160ms.

LIVE-ANSICHT (überall derselbe Baustein: Übersicht, Abo-Detail, Verlauf)
Siegel, Abo-Name, Chip 'Wird heruntergeladen' (accent), Satz '2 gespeichert, 1 wird geladen, 1 wartet, 1 fehlgeschlagen' (tnum), Gesamtbalken (gespeichert/gesamt), darunter Kachelreihe mit den Kachelzuständen unten. Neue gespeicherte Datei ersetzt ihre Platzhalterkachel mit 200ms Einblenden. Keine gestrichelten Kästen (wirken kaputt).

VERLAUF
Seitenstruktur bleibt (Läuft gerade, Beiträge und Dateien, Läufe), Gruppen nach Tag (Heute, Gestern, Datum). Beitragszeile: 56px-Vorschaubild der ersten gespeicherten Datei, Titel 17px, darunter Abo und relative Zeit, Segmentbalken (eine Zelle je Datei, Höhe 6px, Töne ok/warn/danger/neutral) unter dem Titel statt mittig; rechts nur Abweichungen als Chip, 'Vollständig gespeichert' entfällt (Normalzustand). Aufgeklappt: Dateitabelle (Nr, Datei mono 13px, Größe tnum, Zustand, Immich); Prüfsumme (SHA-256) wandert in 'Technische Details' je Datei (mono 12px, Kopieren). Läufe: Beginn (relativ, absolut im title), Quelle mit Siegel, Auslöser, Ergebnis-Satz; Zustand und Hinweis zu einer Zelle (Chip nur bei Abweichung, Hinweis darunter). Mobil: Zeilen zweizeilig gestapelt.

IMMICH, LIMITS, KONTO (Zugänge), BENUTZER, ÜBER KURA
Immich: Settings-Layout. Verbindung (ein Satz Zustand: 'Verbunden, Server 1.2.3, geprüft vor 5 Min.' oder 'Noch nicht eingerichtet'), Felder, [Verbindung speichern] [Verbindung testen]. Testdatei: eigener Button 'Datei wählen' plus Dateiname (natives englisches 'Choose File / No file chosen' entfällt). Freigaben: Liste (host:port mono, Datum tnum, 'Freigabe entziehen' als Textbutton mit Bestätigung), darunter Host, Port, [Endpunkt freigeben].
Limits: Settings-Layout mit Gruppen Ausführung, Begrenzung je Benutzer, Worker-Kapazität, Aufbewahrung, getrennt durch Haarlinie statt Überschriften-Stapel; Zahlenfelder mit Einheit als Suffix (Bytes pro Sekunde als MiB/s-Eingabe vorschlagen ist offen), Platzhalter 'Kein Limit'; Dirty-Leiste unten (sticky, surface-overlay, Popover-Schatten): 'Ungespeicherte Änderungen' [Verwerfen] [Limits speichern].
Konto: Abschnitt Passwort (Settings-Layout). Zugänge: eine Liste mit 4 Zeilen (Siegel, Plattform, Zustandssatz 'Cookies hinterlegt, seit 3 Tagen' oder 'Anmeldung abgelaufen' warn, Aktion 'Hinterlegen' oder 'Erneuern', Menü 'Entfernen'). Aktion öffnet Dialog mit Anleitung, Dateiwahl oder Token-Feld und dem Risikohinweis genau einmal als warn-Banner. Die vier gleichen Warnboxen entfallen. Über Kura: Zeile mit Version, Zustand, Link 'Version und Update'.
Benutzer: Liste statt Tabelle: Avatar (Initialen, 36px Kreis, surface-sunken), Name 17px plus 'Du' bei eigener Zeile, Benutzername mono 13px, Rolle als Text, 'Gesperrt' als Chip nur bei Sperre, 'seit 11.10.2026', Menü (Sperren/Entsperren). Mobil gestapelt.

ANMELDUNG und ERSTEINRICHTUNG 1440 (erster Eindruck)
+-----------------------------+--------------------------------+
| (Marke) Kura  Bricolage 72  |  Kontaktbogen: 12 leere Rahmen |
|                             |  in Seitenverhältnissen 1:1,   |
| Dein Archiv für Bilder      |  3:4, 4:3, 16:9, flache Töne    |
| und Videos.      (Lede 17)  |  surface-sunken, line und ein   |
|                             |  einziger Rahmen in accent-soft |
| Benutzername [__________]   |  (statisch, kein Bild vom Server)|
| Passwort     [__________]   |                                |
| [Anmelden]  volle Breite    |                                |
+-----------------------------+--------------------------------+
Formular 360px ohne Karte direkt auf bg. Linke Hälfte 50 Prozent, rechte Hälfte nur Motiv (aria-hidden). Einmaliger Einblend-Moment (Rahmen 40ms gestaffelt) nur bei erstem Laden der Sitzung. Ersteinrichtung: gleiche Aufteilung, Formular scrollt links, Titel 'Willkommen bei Kura', Schrittzeile 'Ein Konto für dich als Administrator, dann kann es losgehen.' Mobil: Motiv als 96px hoher Streifen oben, Formular darunter, Marke 40px. Fehler: Banner direkt über dem Formular, Fokus auf das Banner, Felder behalten ihre Werte (Passwort nicht).

## components

[
 "A. API-ANFORDERUNGEN AN DEN IMPLEMENTER (laut apps/web/src/api.ts geprüft: MediaAsset hat keine Maße, Dauer, Thumbnails; Serverseite nicht geprüft)\nA1 MediaAsset erweitern: width, height (px, null bei Nicht-Bild/unbekannt), durationSeconds (Video/Audio, sonst null), averageColor (Hex, beim Speichern aus dem Thumbnail berechnet) und hasThumbnail. Zweck: Seitenverhältnis ohne Layoutsprung, Platzhalterfarbe statt grauer Box, Dauer-Badge.\nA2 GET /api/v1/assets/:id/thumbnail?w=480|960 : serverseitig erzeugte WebP/JPEG-Ableitung (Video: Standbild), gecacht, nur lesbar für den Besitzer wie /content. Zweck: Das Raster lädt heute Originale (mehrere MiB je Kachel); Fallback auf /content, wenn keine Ableitung existiert. Originale werden nie verändert.\nA3 GET /api/v1/media?cursor&limit&kind=all|image|video&subscriptionId : Medien über alle Abos des Benutzers, neueste zuerst nach storedAt, mit counts. Für Seite Medien und Übersicht.\nA4 GET /api/v1/subscriptions um Zusammenfassung ergänzen: platform, lastRun {state, finishedAt, assetsStored, assetsFailed, errorCode}, nextRunAt (frühester aktiver Zeitplan), mediaCount {all,image,video}, coverAssetId (neuestes Bild), activeRunId. Zweck: scanbare Zeile ohne N+1 Abfragen.\nA5 GET /api/v1/overview : recentAssets (9), activeRuns (mit Zählern), upcoming (5 nächste Läufe mit Abo), attention (Abo-Probleme: auth_required, failed, teilweise), lastRuns (5). Eine Anfrage, kein Wasserfall.\nA6 Optional: bytesDone und bytesTotal je ladender Datei in RunAssets. Ohne sie Fortschritt nach Dateizahl.\n\nB. KOMPONENTEN (Neu/Umbau, jeweils mit Zuständen in 'states')\nB1 Wordmark: Marke (SVG) plus 'Kura' in Bricolage 600, 22px.\nB2 PlatformSeal: 28px Kreis (40px im Detail), surface-sunken, Monogramm in Bricolage 600: Ig, Pa, Px, Yt, Ph, Link-Glyph für direkte Adresse. Keine Markenfarben, keine Logos (ein Akzent, Marken- und Lizenzfreiheit). Immer mit Plattformname als Text oder aria-label.\nB3 StatusText: Ruhe ist Normalzustand. Erfolg und Aktiv erscheinen als normaler Text. Chip (Etikett, Radius 4, Icon plus Text) nur für: läuft (accent), pausiert (neutral), Anmeldung nötig (warn), teilweise (warn), fehlgeschlagen (danger). Phosphor bleibt als Icon-Satz, aber 'regular'-Gewicht, 16px, nur in Chips, Buttons und Navigation.\nB4 Button: primary (accent gefüllt, nur ein Primärbutton je Ansicht, Ausnahme Dialog), secondary (1px line-strong, surface), ghost (Text), danger (nur im Bestätigungsdialog gefüllt, sonst danger-Text im Menü). Höhe 36px, mobil 44px, Radius 8.\nB5 Menu (Popover-API, Pfeiltasten, Typeahead, Escape, Fokus zurück): surface-overlay, Radius 8, shadow-popover, Einträge 36px.\nB6 Tabs, Segmented, Switch, Toast, Banner, Dialog (Mobil Bottom-Sheet), Tile (Galerie), JustifiedGallery, MosaicHero, RunRow, SubscriptionRow, ProgressBar (4px, Enden rund, einzige Rundung außerhalb der Regel), RelativeTime (<time datetime>, Anzeige 'vor 3 Min.' bis 24 Std., sonst 'Mo., 12.10., 02:30', absolut im title, Aktualisierung alle 30 s ohne Ansage).\nB7 Dialog: Titel in Bricolage 24px, kein 'Schließen'-Textbutton (X-Icon-Button 'Schließen' oben rechts plus Abbrechen unten), Fokus startet beim sichersten Element (bei Löschen: Abbrechen).\nB8 Banner: Radius 8, soft-Fläche des Tons, 2px Ton-Balken links, Icon, ein fetter Satz plus ein Hilfesatz, optional Aktion. Info-Banner (accent-soft) nur für Hinweise mit Handlung.\nB9 Toast (nur Erfolg und Neutrales, role=status): unten links, 6 Sekunden, Pause bei Hover und Fokus, höchstens 3. Fehler nie als Toast, immer als Banner am Ort des Geschehens.",
 "C. FAVICON UND MARKE\nZeichen: Giebelhaus-Silhouette (Kura, Speicherhaus) mit zwei Regalbrettern. Eine Form, keine Ikone aus Linien, passt zur Typografie. public/favicon.svg ersetzen durch:\n<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><style>.a{fill:#9A2A66}.b{fill:#F3F2EF}@media(prefers-color-scheme:dark){.a{fill:#E3A3C6}.b{fill:#151317}}</style><path class='a' d='M16 2.5 29.5 10.5V29.5H2.5V10.5Z'/><path class='b' d='M9 16h14v3H9zM9 22h9v3H9z'/></svg>\n(Hex-Literale sind hier zulässig, die Datei liegt außerhalb von apps/web/src/styles.) In der Shell als Inline-SVG-Komponente mit currentColor und Tokens statt CSS-Kästchen. theme-color in index.html: hell #F3F2EF, dunkel #151317."
]

## states

KACHEL (Tile, Galerie und Live)
default: Bild auf Platzhalterfläche in averageColor (sonst surface-sunken), Bild blendet nach Laden in 200ms ein, Radius 4, keine Umrandung.
hover (nur pointer:fine): Scrim von unten (Gradient, einziger zulässiger Verlauf der Oberfläche) plus Caption in 12px weiß: Beitragstitel, Dateinummer; Bild scale 1.02 in 240ms. Beides in 120ms.
focus-visible: 2px Akzent-Outline mit 2px Abstand (liegt im 6px-Spalt auf bg, Kontrast 6.47:1 hell, 9.07:1 dunkel) plus dieselbe Caption wie bei hover.
active: Bild scale 0.99, 80ms.
video: Poster-Thumbnail, unten links Badge (Play-Glyph plus Dauer '0:48', 12px, Fläche rgb schwarz 72 Prozent, Radius 4). Ohne bekannte Dauer nur Play-Glyph. Auf Touch immer sichtbar, kein Hover nötig.
audio/other: surface-sunken, Typ-Glyph 28px, Dateiendung 12px. Nie ein leeres Feld.
wartet (pending/queued): surface-sunken, Uhr-Glyph, Mikrotext 'Wartet'.
lädt (downloading): surface-sunken, 3px Akzentbalken am unteren Rand (Fortschritt, sonst Dateizahl), Mikrotext 'Wird geladen'. Keine drehenden Spinner.
fehlgeschlagen: danger-soft, WarningCircle-Glyph, Mikrotext 'Fehlgeschlagen', Klick öffnet Betrachter mit Fehlererklärung.
Bild defekt (onError): surface-sunken, Bild-Glyph, Dateiname 2 Zeilen, Mikrotext 'Vorschau nicht verfügbar'. Ersetzt die heutigen leeren grauen Quadrate (media-grid-light-1440).

ABO-ZEILE: default, hover (surface-sunken), focus (Outline am Namensbutton und am Primärbutton), active, läuft (Akzent-Text plus Balken), pausiert (Cover 60 Prozent entsättigt, Chip 'Pausiert', Primär 'Fortsetzen'), Anmeldung nötig (Chip warn, Primär 'Zugang erneuern', führt nach Konto Zugänge), fehlgeschlagen/teilweise (Chip, Primär bleibt 'Jetzt ausführen'), Primärbutton loading (Label 'Wird gestartet', aria-busy, disabled, kein Spinner), Lauf läuft schon (Primär disabled mit Hinweis 'Es läuft bereits ein Lauf'), laden (Skelett: Cover-Quadrat, zwei Textbalken, Zahlbalken, Buttonform; 3 Zeilen), leer ('Noch nichts im Archiv' mit Ghost-Mosaik aus 6 Rahmen und Button), Fehler (Banner danger plus 'Erneut laden').
TABS: default, hover (Text ink), focus (Outline), selected (Unterstrich accent, Gewicht 600 bei fester Breite, damit nichts springt), disabled entfällt.
SCHALTER (Zeitplan): an, aus, focus, disabled, pending (nach Klick bis Antwort, aria-busy), Fehler (Schalter springt zurück plus Banner).
ÜBERSICHT: laden (Skelett in Endform: Lede 2 Zeilen, 9 Mosaikflächen, 3 Listenzeilen), leer (Ghost-Mosaik, 'Noch nichts im Archiv', Primärbutton), nichts aktiv ('Gerade lädt nichts. Der nächste Lauf startet in 2 Std. 10 Min.'), Fehler (Banner danger 'Die Übersicht konnte nicht geladen werden', Aktion 'Erneut laden'), Erfolg (kein Banner; neue Daten erscheinen leise, kein Hinweis).
MEDIEN-SEITE: laden (Skelett: Tageskopf plus 12 Flächen in gemischten Verhältnissen), leer ('Noch keine Medien. Sobald Kura etwas lädt, erscheint es hier.'), Filter ohne Treffer ('Für diesen Filter gibt es keine Dateien.' plus 'Filter zurücksetzen'), weiterladen (Button 'Weitere 40 laden', loading 'Wird geladen'), Fehler (Banner 'Medien konnten nicht geladen werden').
BETRACHTER: laden (Thumbnail sofort auf averageColor, Original tauscht ein), Fehler ('Die Datei lässt sich nicht anzeigen. Du kannst sie herunterladen.' plus Herunterladen), erste/letzte Datei (Prev/Next disabled, nicht verschwunden), Video (native Controls, kein Autoplay), Audio/Datei (Glyph, Hinweis, Herunterladen).
VERLAUF, IMMICH, LIMITS, KONTO, BENUTZER: jeweils laden (Skelett Endform), leer (einladender Satz plus Aktion), Fehler (Banner mit Handlungsvorschlag), Erfolg (Toast bei Speichern: 'Gespeichert.'; Immich-Test: Banner ok mit Ergebnissatz, bleibt bis zur nächsten Aktion).
DIALOG: default, Absenden loading (Primärbutton 'Wird gespeichert', Felder disabled), Feldfehler (Text unter dem Feld in danger plus Icon, aria-describedby, Fokus auf erstes fehlerhaftes Feld), Dialogfehler (Banner im Dialog).
TOAST: ein, aus (200ms), Pause, Aktion ('Rückgängig' bei Pausieren).

## tokens

{
 "hinweis": "Token-Namen der Datei tokens.css bleiben erhalten (bg, surface, surface-sunken, ink, ink-muted, line, line-strong, accent, accent-hover, accent-ink, accent-soft, ok, warn, danger und -soft), damit contrast.test.ts mit kleinen Änderungen weiterläuft. Neu: surface-overlay, scrim, viewer-bg, shadow-popover, focus. Kontrast aller Paare unten rechnerisch geprüft (WCAG-Formel wie im Test), alle Textpaare mindestens 4.5:1, Linien und Fokus mindestens 3:1.",
 "light": {
  "bg": "#F3F2EF",
  "surface": "#FBFAF8",
  "surface-sunken": "#E9E7E2",
  "surface-overlay": "#FFFFFF",
  "ink": "#1D1B1F",
  "ink-muted": "#5F5A64",
  "line": "#DCD9D3",
  "line-strong": "#827C87",
  "accent": "#9A2A66",
  "accent-hover": "#7C1F51",
  "accent-ink": "#FFFFFF",
  "accent-soft": "#F4E4EC",
  "ok": "#1E6A47",
  "ok-soft": "#DFEFE6",
  "warn": "#85560A",
  "warn-soft": "#F6E9CE",
  "danger": "#B0261C",
  "danger-soft": "#F9E0DC"
 },
 "dark": {
  "bg": "#151317",
  "surface": "#1D1A20",
  "surface-sunken": "#0F0E11",
  "surface-overlay": "#272329",
  "ink": "#ECE8EE",
  "ink-muted": "#A8A2AE",
  "line": "#2E2A33",
  "line-strong": "#8A8491",
  "accent": "#E3A3C6",
  "accent-hover": "#EDBBD4",
  "accent-ink": "#1D0F17",
  "accent-soft": "#3A1F2E",
  "ok": "#6FCB9A",
  "ok-soft": "#14281E",
  "warn": "#E3B25A",
  "warn-soft": "#2B2412",
  "danger": "#F28C82",
  "danger-soft": "#34191A"
 },
 "kontrast_gemessen": "hell: ink auf bg 15.27, ink-muted auf bg 5.99 und auf surface-sunken 5.42, accent auf bg 6.47, accent-ink auf accent 7.25, ok/warn/danger auf soft jeweils mindestens 4.5, line-strong auf surface-sunken 3.28 (Minimum 3). dunkel: ink auf bg 15.25, ink-muted auf overlay 6.21, accent auf bg 9.07, line-strong auf overlay 4.26. Weiß auf Scrim (mindestens 62 Prozent Schwarz am Textort, schlimmster Fall weißes Foto) 5.74. Zusätzlich im Test aufnehmen: accent auf surface-overlay, ink auf surface-overlay, danger auf surface-overlay.",
 "elevation": "Stufen: 0 bg (Seite, Sidebar), 1 surface (Eingabefelder, selten Flächen), 2 surface-overlay (Menüs, Dialoge, Toasts, Dirty-Leiste). In Dunkel wird höher heller (bg #151317, surface #1D1A20, overlay #272329), sunken ist dunkler als bg (Vertiefung für Platzhalter). Hell: Hierarchie durch Linien und Raum, nicht durch Schatten.",
 "linien": "line = Trennlinie (dekorativ). line-strong = Kante von Steuerelementen (3:1). Kein Rahmen um Zeilen, nur Haarlinien dazwischen.",
 "fokus": "--focus: var(--accent). Fokus-Ring überall 2px solid focus, offset 2px, sofort ohne Übergang; auf Kacheln im Spalt (gap 6px).",
 "scrim": "linear-gradient(to top, rgb(0 0 0 / 0.66), rgb(0 0 0 / 0) 60%) als Token --scrim, nur in media.css und mosaic erlaubt; viewer-bg: #0E0D10 in beiden Themes.",
 "typografie": {
  "familien": "Display: Bricolage Grotesque Variable, Paket @fontsource-variable/bricolage-grotesque (SIL OFL, selbst gehostet), nur für h1, h2, Dialogtitel, große Zahlen, Wordmark. UI und Fließtext: Geist Variable bleibt (selbst gehostet, Tabellenziffern, Umlaute, ruhig bei 15px; der Charakter kommt aus der Display-Schrift und der Skala). Mono: Geist Mono nur für technische Werte (URLs, Dateinamen, Hashes, Hosts, Cron), nicht für Labels. Ungeprüft: ob die gelieferte Fontsource-Variante Umlaute/ß, tnum und die opsz-Achse enthält und welche CSS-Datei dafür zu importieren ist; Implementer prüft im Browser. Fallback bei Mangel: Geist 600 mit letter-spacing -0.02em, kein weiterer Wechsel.",
  "skala": {
   "display": "44/48, Bricolage 600, -0.02em (mobil 32/36)",
   "heading": "24/30, Bricolage 600 (mobil 21/27)",
   "title": "17/24, Geist 600 (Zeilentitel, Beitragstitel)",
   "body": "15/24, Geist 400",
   "meta": "13/18, Geist 400, ink-muted",
   "micro": "12/16, Geist 500 (Kachel-Caption, Badges)",
   "figure": "32/36, Bricolage 600, tnum (nur wenn Zahlen allein stehen)",
   "login_hero": "72/72, Bricolage 600 (mobil 40)"
  },
  "regeln": "Alle Zahlen, Uhrzeiten, Größen, Zähler: font-variant-numeric: tabular-nums. Gewichte nur 400, 500, 600. Keine Versal-Eyebrows, keine Mono-Labels, Satzschreibung. Textbreite 68ch."
 },
 "abstand": "Basis 4px: 4, 8, 12, 16, 24, 32, 48, 72. Abschnitt 48, Seitenkopf zu Inhalt 32, Listenzeile 16 oben/unten, Galerie 6px (mobil 4px), Seitenrand 40/32/20.",
 "radius": "Eine konzentrische Regel: --radius-sm 4px (Kacheln, Chips, Badges, Segment innen), --radius-md 8px (Buttons, Felder, Menüs, Banner, Tabs-Track), --radius-lg 16px (Dialoge, Bottom-Sheets, Dirty-Leiste). Innen = außen minus Abstand (nie größer als der Umgebungsradius). Kreis nur für Avatar und PlatformSeal, Balkenenden bei ProgressBar. Chips sind keine Pillen mehr, sondern Etiketten mit Radius 4.",
 "schatten": "Nur zwei, in Plum-Schwarz getönt: --shadow-popover: 0 1px 2px rgb(40 20 40 / 0.08), 0 8px 24px -6px rgb(40 20 40 / 0.18) (dunkel: rgb(0 0 0 / 0.5)); --shadow-dialog: 0 24px 64px -16px rgb(40 20 40 / 0.35) (dunkel: rgb(0 0 0 / 0.7)). Zeilen, Kacheln, Buttons: nie Schatten. Hover hebt nichts an.",
 "bewegung": {
  "tokens": "--dur-fast 120ms, --dur-base 200ms, --dur-slow 360ms; --ease-out cubic-bezier(0.2, 0.8, 0.2, 1); --ease-inout cubic-bezier(0.4, 0, 0.2, 1)",
  "was_und_warum": "Rückmeldung (120ms): Hover-Fläche, Caption, Button-Zustand, Menü ein (Opacity plus 4px, @starting-style). Zustandswechsel (200ms): Zeile aufklappen (grid-template-rows 0fr zu 1fr), Tab-Unterstrich (transform), Toast, Fortschrittsbalken (width 400ms ease-out), Bild blendet nach Laden ein, neue Datei ersetzt Platzhalter. Ein orchestrierter Moment (360ms je Element, 40ms gestaffelt, höchstens 9 Elemente, unter 700ms gesamt): Mosaik der Übersicht erscheint (translateY 12px zu 0 plus Opacity), bzw. Kontaktbogen-Rahmen der Anmeldung; je Sitzung einmal (sessionStorage). Betrachter: View Transition Kachel zu Vollbild 240ms mit Fallback.",
  "verboten": "Endlos-Animationen jeder Art (kein Shimmer, kein Spinner, keine Pulse), Parallax, Scroll-Jacking, Hover-Anheben von Karten. Skelette sind statisch.",
  "reduced_motion": "@media (prefers-reduced-motion: reduce): alle Dauern 0.01ms, keine Staffelung, keine View Transitions, Bilder erscheinen ohne Einblenden, Fortschrittsbalken springen. Fokus und Zustände bleiben sichtbar."
 },
 "layout_tokens": {
  "sidebar": "248px",
  "testleiste": "32px",
  "topbar_mobil": "56px",
  "bottomnav_mobil": "64px",
  "page_pad": "40px / 32px / 20px",
  "page_max": "1360px, Medien 1600px",
  "settings_spalten": "280px plus maximal 640px",
  "row_h_galerie": "220px / 180px / 140px",
  "control_h": "36px, mobil 44px"
 }
}

## copy

[
 {
  "wo": "HTTP-Leiste",
  "alt": "Testoberfläche: Verbindung unverschlüsselt (HTTP), nur Testbetrieb",
  "neu": "Testbetrieb: Die Verbindung ist unverschlüsselt (HTTP)."
 },
 {
  "wo": "Navigation",
  "alt": "Übersicht, Abonnements, Verlauf, Immich, Benutzerverwaltung, Limits, Konto",
  "neu": "Übersicht, Medien (neu), Abonnements, Verlauf; Gruppe 'Verwaltung': Immich, Benutzer, Limits; Konto und Abmelden im Benutzer-Popover. Seitentitel 'Benutzerverwaltung' bleibt als h1."
 },
 {
  "wo": "Version Sidebar",
  "alt": "Neue Version 0.3.0",
  "neu": "Update auf 0.3.0 verfügbar"
 },
 {
  "wo": "Übersicht Lede",
  "alt": "(Systemstatus, Schnellzugriff)",
  "neu": "Vor 3 Min. hat Kura 4 neue Dateien von Atelier Mori gespeichert. Nächster Lauf in 2 Std. 10 Min. | ohne Aktivität: Heute war noch kein Lauf. Nächster Lauf in 2 Std. 10 Min. | leer: Noch nichts im Archiv."
 },
 {
  "wo": "Übersicht Abschnitte",
  "alt": "Systemstatus, Schnellzugriff",
  "neu": "Zuletzt geladen, Läuft gerade, Als Nächstes, Zuletzt gelaufen, Technik; Problemblock 'Braucht dich'"
 },
 {
  "wo": "Übersicht leer",
  "alt": "-",
  "neu": "Noch nichts im Archiv. | Lege dein erstes Abonnement an. Kura holt neue Beiträge dann automatisch. | [Abonnement anlegen]"
 },
 {
  "wo": "Übersicht nichts aktiv",
  "alt": "-",
  "neu": "Gerade lädt nichts. Der nächste Lauf startet in 2 Std. 10 Min."
 },
 {
  "wo": "Übersicht Fehler",
  "alt": "Prüfen Sie, ob der Dienst läuft, und laden Sie die Seite neu.",
  "neu": "Die Übersicht konnte nicht geladen werden. Prüfe, ob der Dienst läuft, und lade die Seite neu. | [Erneut laden]"
 },
 {
  "wo": "Abos Lede",
  "alt": "Ein Abonnement beobachtet ein Ziel wiederkehrend. Zeitpläne und „Jetzt ausführen“ legen Läufe an; ein Worker lädt den Beitrag herunter, speichert ihn und übergibt ihn an Immich, wenn Sie eine Verbindung eingerichtet haben. Das Ergebnis steht unter „Verlauf“.",
  "neu": "Kura beobachtet diese Quellen und lädt neue Beiträge automatisch."
 },
 {
  "wo": "Abos leer",
  "alt": "Noch keine Abonnements. / Legen Sie Ihr erstes Abonnement an.",
  "neu": "Noch keine Abonnements. / Lege dein erstes Abonnement an. Kura holt neue Beiträge dann automatisch."
 },
 {
  "wo": "Abos Fehler",
  "alt": "Prüfen Sie die Verbindung und laden Sie die Abonnements neu.",
  "neu": "Die Abonnements konnten nicht geladen werden. Prüfe die Verbindung und versuche es erneut."
 },
 {
  "wo": "Abo-Zeile",
  "alt": "Ziel: ... Plattform: ... Prüfung: Adresse erkannt und unterstützt Status: Aktiv; Buttons Jetzt ausführen, Adresse prüfen, Medien, Zeitpläne und Läufe, Bearbeiten, Pausieren, Löschen",
  "neu": "Plattform als Siegel plus Klartext, Adresse mono; Primär 'Jetzt ausführen'; Menü: Adresse prüfen, Bearbeiten, Pausieren, Abonnement löschen. 'Prüfung: Adresse erkannt und unterstützt' entfällt als Dauer-Pill und erscheint nur im Formular und im Prüf-Ergebnis. 'Plattform: Keine Angabe' wird 'Direkte Adresse'."
 },
 {
  "wo": "Abo Pause-Hinweis",
  "alt": "Beim Fortsetzen werden verpasste Termine aus der Pause nicht nachgeholt. Ein pausiertes Abonnement kann nicht ausgeführt werden.",
  "neu": "Pausiert. Beim Fortsetzen holt Kura verpasste Termine nicht nach."
 },
 {
  "wo": "Abo-Detail Tabs",
  "alt": "Zeitpläne und Läufe (Aufklapper), Medien (Button), Details ausblenden",
  "neu": "Tabs: Medien, Zeitpläne, Läufe"
 },
 {
  "wo": "Abo Lauf angelegt",
  "alt": "Der Lauf wurde eingereiht. Den Fortschritt sehen Sie unten live; das Ergebnis bleibt unter „Verlauf“.",
  "neu": "Lauf gestartet. Den Fortschritt siehst du hier live, das Ergebnis steht danach im Verlauf. (Toast)"
 },
 {
  "wo": "Abo löschen Dialog",
  "alt": "(Titel Löschen, Standardtext)",
  "neu": "Abonnement „Atelier Mori“ löschen? | Das Abonnement und seine Zeitpläne werden entfernt. Bereits gespeicherte Dateien und der Verlauf bleiben erhalten. | [Abbrechen] [Abonnement löschen]"
 },
 {
  "wo": "Zeitplan löschen Dialog",
  "alt": "Zeitplan löschen",
  "neu": "Zeitplan „Täglich um 02:30 Uhr“ löschen? | Danach startet Kura für dieses Abonnement keine Läufe mehr nach diesem Plan. | [Abbrechen] [Zeitplan löschen]"
 },
 {
  "wo": "Zeitplan leer",
  "alt": "-",
  "neu": "Noch kein Zeitplan. Ohne Zeitplan lädt Kura nur, wenn du „Jetzt ausführen“ wählst."
 },
 {
  "wo": "Zeitplan Schalter",
  "alt": "Ausschalten / Einschalten (Textbutton)",
  "neu": "Schalter mit Label 'Aktiv'"
 },
 {
  "wo": "Zeitplan-Formular",
  "alt": "Bitte geben Sie ein ganzzahliges Intervall ab 1 an. / Bitte geben Sie den Zeitpunkt an. / Bitte geben Sie eine gültige Uhrzeit an.",
  "neu": "Gib ein ganzzahliges Intervall ab 1 an. / Gib den Zeitpunkt an. / Gib eine gültige Uhrzeit an."
 },
 {
  "wo": "Abo-Formular Hinweis",
  "alt": "... Mit „Adresse prüfen“ sehen Sie, welche Plattform erkannt wird ...",
  "neu": "Die Adresse wird unverändert gespeichert. Mit „Adresse prüfen“ siehst du, welche Plattform erkannt wird. (Rest des Satzes sinngemäß auf du umstellen, Quelle Subscriptions.tsx:92)"
 },
 {
  "wo": "Medien Filter leer",
  "alt": "Für diesen Filter gibt es keine Dateien. Wählen Sie „Alle“, ...",
  "neu": "Für diesen Filter gibt es keine Dateien. Wähle „Alle“, um alles zu sehen. | [Filter zurücksetzen]"
 },
 {
  "wo": "Medien-Seite",
  "alt": "-",
  "neu": "Titel 'Medien'; Filter 'Alle Abonnements', 'Alle', 'Bilder', 'Videos'; leer: 'Noch keine Medien. Sobald Kura etwas lädt, erscheint es hier.'; Button 'Weitere 40 laden', Zähler '40 von 214'"
 },
 {
  "wo": "Kachel",
  "alt": "Wird geladen / Wartet / Fehlgeschlagen (Chip)",
  "neu": "Mikrotexte 'Wird geladen', 'Wartet', 'Fehlgeschlagen', 'Vorschau nicht verfügbar'; Video-Badge '0:48'"
 },
 {
  "wo": "Betrachter",
  "alt": "Vorherige / Nächste / Schließen / Datei 10 von 14 / Für diesen Dateityp gibt es keine Vorschau. Sie können die Datei herunterladen.",
  "neu": "Zurück / Weiter (aria-labels 'Vorherige Datei', 'Nächste Datei'), 'Schließen' nur als X mit Label, '10 von 14', 'Für diesen Dateityp gibt es keine Vorschau. Du kannst die Datei herunterladen.', Fehler: 'Die Datei lässt sich nicht anzeigen. Du kannst sie herunterladen.'"
 },
 {
  "wo": "Verlauf",
  "alt": "Fehlerhinweis: Prüfen Sie die Verbindung und wählen Sie „Aktualisieren“. / Legen Sie ein Abonnement an und wählen Sie „Jetzt ausführen“.",
  "neu": "Prüfe die Verbindung und wähle „Aktualisieren“. / Lege ein Abonnement an und wähle „Jetzt ausführen“."
 },
 {
  "wo": "Verlauf Lede",
  "alt": "Hier steht, was Kura wann von welcher Quelle geholt hat, mit dem Zustand jeder einzelnen Datei. Der Verlauf bleibt erhalten, auch wenn ein Abonnement gelöscht wird. Lokale Originale werden von Kura nicht entfernt.",
  "neu": "Hier steht, was Kura wann von welcher Quelle geholt hat. Der Verlauf bleibt erhalten, auch wenn du ein Abonnement löschst. Kura entfernt lokale Originale nie."
 },
 {
  "wo": "Immich",
  "alt": "Keine Freigaben vorhanden. / Geben Sie unten Host und Port Ihres Immich-Servers frei. / Bitte wählen Sie eine Testdatei aus.",
  "neu": "Keine Freigaben vorhanden. / Gib unten Host und Port deines Immich-Servers frei. / Wähle eine Testdatei aus. | Dateiwahl: 'Datei wählen' und 'Keine Datei gewählt'"
 },
 {
  "wo": "Immich Lede",
  "alt": "Lokale Originale werden bei diesem Test niemals gelöscht.",
  "neu": "Kura übergibt gespeicherte Dateien an deine Immich-Bibliothek. Lokale Originale löscht Kura nie."
 },
 {
  "wo": "Limits Lede",
  "alt": "Version 0 (Standardwerte, noch nie gespeichert). Das niedrigste anwendbare Limit gewinnt. Eine abgesenkte Grenze verhindert nur neue Starts.",
  "neu": "Du hast noch keine Limits gespeichert, es gelten die Standardwerte. Gelten mehrere Limits, gewinnt das niedrigste. Eine gesenkte Grenze verhindert nur neue Starts."
 },
 {
  "wo": "Limits Feldhinweis",
  "alt": "Wird gespeichert, aber noch nicht durchgesetzt.",
  "neu": "Wird gespeichert, wirkt aber noch nicht."
 },
 {
  "wo": "Benutzer sperren Dialog",
  "alt": "Sperren / Benutzer wirklich sperren? / [Sperren] [Abbrechen]",
  "neu": "Bob Beispiel sperren? | Bob Beispiel kann sich danach nicht mehr anmelden. Du kannst die Sperre jederzeit aufheben. | [Abbrechen] [Benutzer sperren]"
 },
 {
  "wo": "Konto Zugänge",
  "alt": "vier Warnboxen mit demselben Risikotext",
  "neu": "Ein Satz über der Liste: 'Kura nutzt deine Anmeldungen, um Inhalte zu laden, die du sehen darfst. Viele oder schnelle Abrufe können zu Sperren deines Kontos führen. Nutze ein eigenes Konto.' Plattform-Details im Dialog."
 },
 {
  "wo": "Anmeldung",
  "alt": "Anmelden / Anmeldung fehlgeschlagen. Prüfen Sie Benutzername und Passwort.",
  "neu": "Anmelden | Dein Archiv für Bilder und Videos. | Fehler: Das hat nicht geklappt. Prüfe Benutzername und Passwort und versuche es noch einmal."
 },
 {
  "wo": "SSO",
  "alt": "Die SSO-Anmeldung ist fehlgeschlagen. Bitte versuchen Sie es erneut oder verwenden Sie die lokale Anmeldung.",
  "neu": "Die Anmeldung über SSO ist fehlgeschlagen. Versuche es noch einmal oder melde dich mit Benutzername und Passwort an."
 },
 {
  "wo": "Ersteinrichtung",
  "alt": "Kura einrichten / Legen Sie das erste Administratorkonto an.",
  "neu": "Willkommen bei Kura | Ein Konto für dich als Administrator, dann kann es losgehen."
 },
 {
  "wo": "Passwortänderung",
  "alt": "Ändern Sie Ihr Anfangspasswort, bevor Sie fortfahren.",
  "neu": "Ändere dein Anfangspasswort, bevor du weitermachst."
 },
 {
  "wo": "Du-Form gesamt",
  "alt": "Sie-Formen an: Subscriptions.tsx:92, 243, 366; History.tsx:72, 100; SubscriptionMedia.tsx:104; MediaViewer.tsx:24; Immich.tsx:74, 134; Credentials.tsx:246 (teilweise); labels.ts:19, 34, 45, 47, 53; ScheduleForm.tsx:65, 70, 73",
  "neu": "Alle auf du. Der Implementer sucht zusätzlich per grep nach Sie, Ihr, Ihre, Ihnen und meldet den Rest. Keine Gedankenstriche und keine Mittelpunkt-Ketten in neuen Texten, keine Emojis."
 },
 {
  "wo": "Zeitangaben",
  "alt": "So., 11.10.2026, 00:55 UTC / 02:55:17",
  "neu": "Relativ bis 24 Std. ('vor 3 Min.', 'in 2 Std.'), sonst 'Mo., 12.10., 02:30' in der Zeitzone des Benutzers; absolut im title und in <time datetime>. 'UTC' nur im Verlauf-Detail."
 }
]

## accessibility

[
 "Kontrast: alle Textpaare mindestens 4.5:1, Kanten und Fokus mindestens 3:1, in Hell und Dunkel (Werte in tokens.kontrast_gemessen); Text auf Bildern nur über Scrim, am Textort mindestens 62 Prozent Schwarz (schlimmster Fall 5.74:1).",
 "Fokus: überall sichtbar, 2px Akzent, 2px Abstand; Tab-Reihenfolge folgt der Leserichtung: Seitenkopf, Primäraktion, Inhalt. Skip-Link bleibt. Beim Seitenwechsel Fokus auf main (wie bisher).",
 "Tastatur zuerst: Galerie behält die bestehende Pfeiltasten-Navigation (Keyboard.test.tsx); Tabs mit Pfeiltasten (role=tablist, Home und End); Menü mit Pfeiltasten und Escape; Betrachter: Pfeiltasten, Escape, I für Info; Fokus-Falle im Dialog und Betrachter, Rückkehr zum auslösenden Element.",
 "Farbe nie allein: Chips tragen Icon plus Text; Segmentbalken im Verlauf bekommen Tooltip und Textalternative 'Datei 3: fehlgeschlagen'; Signal der Navigation ist zusätzlich aria-current.",
 "Screenreader: Kachel-Name 'Bild, Frühlingsserie Teil 3, Datei 2 von 5, ansehen' bzw. 'Video, 0:48, ...' (Alt-Text-Regel der Datei media.ts bleibt: Art plus Dateiname); Fortschritt als role=progressbar mit aria-valuenow oder Textsatz; Live-Zähler in aria-live=polite, höchstens alle 5 Sekunden; RelativeTime nutzt <time datetime> ohne Live-Ansage; Platzhalter-Motiv der Anmeldung aria-hidden.",
 "Zielgrößen: mindestens 24px (WCAG 2.2), auf Touch 44px; Menü- und Zeilenbuttons mit ausreichend Abstand.",
 "Bewegung: prefers-reduced-motion schaltet jede Bewegung ab (siehe tokens.bewegung); keine Endlosanimation, nichts blinkt.",
 "Dialoge als <dialog> mit aria-labelledby; Bottom-Sheet auf Mobil gleiche Semantik; Toast role=status, Fehler nie nur als Toast.",
 "Forced-colors und prefers-contrast: Kacheln behalten transparente Outline, Chips echte Rahmen; Verlauf-Segmente haben Form-Unterschiede (ok gefüllt, offen Umriss).",
 "Sprache: lang=de, Datum und Zahlen de-DE, Dateigrößen mit Komma (92,9 KiB)."
]

## acceptance_criteria

- AC1 Primärfarbe ist ein einziger Akzent (Pflaume #9A2A66 hell, #E3A3C6 dunkel); kein Indigo/Blau mehr in Buttons, Links, Navigation, Fokus, Marke. Statusfarben nur für Zustand mit Text oder Icon.
- AC2 tokens.css enthält alle Tokens aus der Spezifikation in Hell und Dunkel; contrast.test.ts ist angepasst (Token-Liste um surface-overlay, Radiusskala sm/md/lg, Schatten-Regel erlaubt shadow-popover und shadow-dialog, Gradient-Regel erlaubt genau einen Scrim in media.css, Shimmer-Ausnahme entfällt) und grün.
- AC3 Alle Textpaare erreichen 4.5:1, Kanten und Fokus 3:1 in Hell und Dunkel (Test).
- AC4 Keine Farb-Literale außerhalb tokens.css; alle border-radius nutzen --radius-sm/md/lg oder 50 Prozent für Avatar/Siegel.
- AC5 Display-Schrift ist selbst gehostet (Paket und Lizenz im PR genannt, Entscheidung des Orchestrators dokumentiert); es werden keine Fonts von externen Servern geladen. Umlaute und ß rendern in h1 korrekt.
- AC6 Alle Zahlen, Uhrzeiten, Größen, Zähler nutzen tabular-nums; Fließtext 15px, Meta mindestens 13px, Mikro mindestens 12px.
- AC7 Favicon ist das Giebelhaus-Zeichen, wechselt im Dunkelmodus die Farbe; Wordmark nutzt dasselbe Zeichen; theme-color-Metas aktualisiert.
- AC8 Es gibt keine Karten mit Rahmen und Schatten um Listenzeilen; Schatten existieren nur an Popover, Dialog, Toast und Dirty-Leiste.
- AC9 Shell: HTTP-Leiste läuft über die volle Breite oberhalb von Sidebar und Inhalt; Sidebar zeigt aktives Element nur mit 2px Akzent-Balken plus aria-current; Benutzerbereich ist ein Popover mit Konto und Abmelden; Versionszeile zeigt Update-Hinweis nur für Admins.
- AC10 Mobil (390px): Bottom-Navigation mit 5 Einträgen und Mehr-Sheet; keine horizontale Scrollleiste auf irgendeiner Seite; alle Touch-Ziele mindestens 44px.
- AC11 Übersicht zeigt, in dieser Reihenfolge: Lede-Satz mit Zeitbezug, Problemblock (nur wenn vorhanden), Mosaik mit bis zu 9 echten Medien, Läuft gerade mit Fortschritt, Als Nächstes, Zuletzt gelaufen, Technik zugeklappt. Migrationen und Migrations-Dateiname erscheinen nicht mehr auf der Übersicht.
- AC12 Übersicht hat keine Schnellzugriff-Kacheln und keinen Pfeil an Navigationszeilen; Mosaik-Kacheln zeigen Caption bei Hover und Fokus.
- AC13 Übersicht-Zustände vorhanden: Skelett in Endform, leer mit Aufforderung, nichts aktiv, Fehler mit Aktion.
- AC14 Abo-Zeile (1440) zeigt in einem Blick Cover, Plattform-Siegel, Name, Adresse, letzten Lauf mit Ergebnis, nächsten Lauf, Medienzahl, genau eine Primäraktion und ein Überlaufmenü.
- AC15 Pro Abo-Zeile ist höchstens eine Farbfläche sichtbar (Chip) und nur bei Abweichung (läuft, pausiert, Anmeldung nötig, teilweise, fehlgeschlagen); es gibt keine dauerhaften grünen Prüf-Pills.
- AC16 Löschen kommt auf der Abo-Seite ausschließlich im Überlaufmenü vor (danger-Text) und öffnet immer einen Bestätigungsdialog, der das Objekt beim Namen nennt, mit Fokus auf Abbrechen; dasselbe gilt für Zeitplan löschen, Freigabe entziehen und Benutzer sperren.
- AC17 Abo-Detail ist eine eigene Ansicht (Hash-Route, Browser-Zurück funktioniert) mit Tabs Medien, Zeitpläne, Läufe; Tabs per Pfeiltasten bedienbar; Medienansicht am Abo bleibt vollständig erhalten (REQ-DL-006).
- AC18 Galerie nutzt justierte Zeilen mit den echten Seitenverhältnissen (Klemme 0.6 bis 2.4), Spalt 6px, Radius 4; die Galerie füllt die Inhaltsbreite; eine einzelne letzte Zeile wird nicht auf volle Breite gestreckt; Layout springt beim Laden der Bilder nicht (Seitenverhältnis kommt aus API-Maßen).
- AC19 Medien sind je Beitrag gruppiert mit Titel, Dateizahl, relativer Zeit und Quelllink; Medien-Seite gruppiert nach Tag mit sticky Tageskopf.
- AC20 Videos sind ohne Hover als Video erkennbar (Badge mit Play-Glyph und Dauer, wenn bekannt).
- AC21 Kachelzustände wartet, lädt, fehlgeschlagen, Vorschau defekt, Audio/Datei zeigen jeweils Glyph und Text; kein Zustand sieht wie eine leere graue Box aus. Platzhalterfarbe stammt aus averageColor, sonst surface-sunken.
- AC22 Hover und Fokus an Kacheln: Scrim plus Caption, Fokus-Ring sichtbar auf Hell und Dunkel; Pfeiltasten-Navigation funktioniert wie bisher.
- AC23 Betrachter ist Vollbild mit dunklem Hintergrund in beiden Themes, Info-Spalte (Taste I), Pfeiltasten, Escape, Filmstreifen des Beitrags, Herunterladen, Fehlerzustand; Fokus kehrt zur Kachel zurück.
- AC24 Es gibt eine Seite Medien (nach Übersicht) über alle Abos mit Filtern Abo und Art; Übersicht verlinkt 'Alle Medien' dorthin. (Falls der Orchestrator die Seite ablehnt: Link führt zur Abo-Liste, restliche Kriterien unverändert.)
- AC25 Live-Ansicht zeigt Satz mit Zählern, Gesamtbalken und Kachelreihe ohne gestrichelte Kästen; neue Datei ersetzt ihre Platzhalterkachel; Balken ist role=progressbar; Zähler-Ansage höchstens alle 5 Sekunden.
- AC26 Verlauf: Gruppen nach Tag, Beitragszeile mit 56px-Vorschaubild, Segmentbalken unter dem Titel, nur Abweichungen als Chip, Prüfsumme nur unter 'Technische Details'.
- AC27 Immich, Limits, Konto nutzen das Settings-Layout (280px Erklärung, Formular maximal 640px); das native englische Dateifeld ist durch 'Datei wählen' und 'Keine Datei gewählt' ersetzt.
- AC28 Zugänge: eine Liste mit vier Zeilen und Aktion im Dialog; der Risikohinweis erscheint genau einmal je Dialog, nicht viermal auf der Seite.
- AC29 Anmeldung und Ersteinrichtung: zweigeteilt mit Kontaktbogen-Motiv (statisch, aria-hidden, keine externen Bilder), Formular 360px ohne Karte, Fehler als Banner über dem Formular, mobil Motiv als Streifen.
- AC30 Bewegung: nur die in tokens.bewegung genannten Übergänge; keine Endlosanimation (kein Shimmer, kein Spinner); mit prefers-reduced-motion verschwinden Staffelung, Einblenden und View Transitions (per Test oder Screenshot nachweisbar).
- AC31 Alle UI-Texte sind du-Form: grep nach Sie/Ihr/Ihre/Ihnen in apps/web/src (ohne Tests) liefert keine UI-Texte; keine Gedankenstriche (– —), keine Emojis, keine Mittelpunkt-Ketten in Texten.
- AC32 Zeitangaben relativ bis 24 Std., sonst absolut gekürzt, absolut im title und <time datetime>; tabular-nums.
- AC33 Toasts: nur Erfolg und Neutrales, role=status, 6 Sekunden, Pause bei Hover und Fokus; Fehler als Banner am Ort des Geschehens.
- AC34 Jede neue Seite und Komponente hat die Zustände laden (Skelett in Endform), leer (sagt, was zu tun ist), Fehler (was passiert ist, was tun), Erfolg.
- AC35 Neue API-Felder und Endpunkte A1 bis A5 existieren oder der Implementer meldet vorab, was fehlt; ohne A1 und A2 gilt die Galerie als nicht abnehmbar (ar=1 Rückfall ist nur Übergang). Thumbnails werden von demselben Ursprung geliefert; Originale werden nie verändert.
- AC36 CSP: keine Verstöße in der Browser-Konsole (default-src 'self': keine data:-URIs, keine style-Attribut-Strings; dynamische Werte nur über React-style-Prop/CSSOM oder Klassen).
- AC37 Performance: Raster lädt Thumbnails (nicht Originale), loading=lazy, decoding=async, width/height oder aspect-ratio gesetzt; Gruppen mit content-visibility:auto.
- AC38 Dunkelmodus ist eigenständig gestaltet (höher gleich heller, sunken dunkler als bg), keine invertierte Hell-Variante; Screenshot beider Themes besteht die Sichtprüfung.
- AC39 Alle bestehenden Tests (Vitest, Keyboard, Locked, App) laufen; geänderte Texte sind in den Tests nachgezogen.
- AC40 Keine neue Abhängigkeit außer dem vom Orchestrator freigegebenen Display-Font; keine Motion-Bibliothek, kein Tailwind.

## findings

- {"severity": "blocker", "text": "Sie-Anrede in zahlreichen UI-Texten widerspricht der Vorgabe 'du-Form' (labels.ts setupIntro, loginFailed, ssoLoginFailed, changePasswordRequiredHint, statusErrorAction; Subscriptions, History, Immich, Viewer, ScheduleForm); setup-light-1440 zeigt 'Legen Sie ...', subscriptions-light-1440 'wenn Sie eine Verbindung ...', Konto-Texte (account-light-1440) sind schon du: gemischte Anrede. Warum: Vorgabe des Auftraggebers und Konsistenz. Ändern: alles auf du (siehe copy)."}
- {"severity": "major", "text": "Übersicht zeigt Systeminterna statt Aktivität (dashboard-light-1440, dashboard-light-390): Migrationen, Dateiname 0069_version_check, Ja/Nein-Felder; unten 30 Prozent leer, kein Bild, kein Zeitbezug. Warum: Nutzerziel ist 'was ist neu'. Ändern: Übersicht neu (Mosaik, Aktivität, Probleme, Technik zugeklappt)."}
- {"severity": "major", "text": "Abo-Zeile trägt sieben gleichgewichtige Aktionen, fünfmal Rot (subscriptions-light-1440, subscriptions-dark-1440), Status als grauer Text 'Status: Aktiv', grüne Prüf-Pill in jeder Zeile ohne Information, Karte in Karte (subscriptions-expanded-light-1440). Warum: keine Hierarchie, Löschen zu leicht erreichbar, Zeile beantwortet nichts. Ändern: scanbare Zeile, Primäraktion plus Menü, Chip nur bei Abweichung."}
- {"severity": "major", "text": "Zugeklappte Zeilen beantworten weder letzter Lauf noch Ergebnis noch nächster Lauf noch Medienzahl; keine Plattform-Identität, kein Vorschaubild (subscriptions-light-390 ebenfalls: Buttonwand). Ändern: Spalten und Siegel, Cover, API A4."}
- {"severity": "major", "text": "Medienraster: gleich große Quadrate, Zuschnitt auf 1:1 (Betrachter zeigt 3:2, media-viewer-image-light-1440), 60 Prozent der Breite leer, Medien zwischen Admin-Buttons und Zeilen eingeklemmt (media-grid-light-1440, media-grid-dark-1440). Warum: Der emotionale Kern wirkt wie ein Anhang. Ändern: justierte Galerie, eigene Seite Medien, Detail-Tabs."}
- {"severity": "major", "text": "Platzhalter sehen kaputt aus: leere graue Quadrate mit Umrandung für nicht ladende Bilder (media-grid-light-1440 Gruppen 'Hafen bei Nacht' und 'Frühlingsserie' ), im Dunkelmodus nur Umrisse (media-grid-dark-1440), gestrichelte leere Kästen in der Live-Ansicht (live-run-light-1440). Ändern: Kachelzustände mit Glyph, Text und averageColor."}
- {"severity": "major", "text": "Video kaum erkennbar: nur kleiner Play-Kreis, keine Dauer, Poster oft abgeschnitten (media-grid-videos-light-1440). Ändern: Badge mit Dauer (A1), Poster-Thumbnail (A2)."}
- {"severity": "major", "text": "Grid lädt Originale als Kachelbild (MediaThumb.tsx nutzt contentUrl); bei echten Fotos und Videos schwer und langsam; Videos laden Metadaten je Kachel. Ändern: Thumbnail-Endpunkt A2."}
- {"severity": "major", "text": "Generischer Admin-Look: weiße Karten mit Haarlinie auf kühlem Grau #f3f5f7, Indigo #264a88, alle Radien 6 bis 10, Schriftgrößen 12 bis 16 mit wenig Kontrast in der Hierarchie; Seitentitel 28px ohne Charakter (alle Screenshots). Ändern: Tokens, Skala, Display-Schrift, eine Rundungsregel."}
- {"severity": "major", "text": "Lange Erklärtexte oben auf Abo-, Verlauf- und Limits-Seite (subscriptions-light-1440, history-light-1440, limits-light-1440) in Systemsprache ('Version 0 (Standardwerte ...)', 'Worker'). Ändern: ein Satz in Nutzersprache."}
- {"severity": "minor", "text": "HTTP-Streifen sitzt nur über dem Inhalt, Sidebar beginnt darüber nicht; Sidebar hat große Leere zwischen Navigation und Benutzer (alle 1440-Screenshots); mobil zweizeilig (dashboard-light-390). Ändern: Leiste über volle Breite, einzeilig."}
- {"severity": "minor", "text": "Inhalt endet bei etwa 1036px, rechts bleiben rund 170px unbenutzt (dashboard-light-1440, immich-light-1440). Ändern: Seitenbreiten und Settings-Layout."}
- {"severity": "minor", "text": "Natives englisches Dateifeld 'Choose File / No file chosen' mitten in deutscher Oberfläche (immich-light-1440, account-light-1440). Ändern: eigener Button."}
- {"severity": "minor", "text": "Konto: vier identische Warnboxen mit demselben Risikotext (account-light-1440). Ändern: einmal erklären, Details im Dialog."}
- {"severity": "minor", "text": "Bestätigungsdialog nennt das Objekt nicht ('Sperren / Benutzer wirklich sperren?', dialog-light-1440) und hat 'Schließen' neben 'Abbrechen'. Ändern: Objekt benennen, X-Icon, ein Abbrechen."}
- {"severity": "minor", "text": "Verlauf: Prüfsummen-Spalte, 'Vollständig gespeichert' und 'Original verifiziert' als Chips an jeder Zeile (history-expanded-light-1440): Normalzustand ist laut. Ändern: nur Abweichungen farbig, Prüfsumme in Technische Details."}
- {"severity": "minor", "text": "Betrachter ist ein 1030px breiter Dialog mit viel Metadaten unter dem Bild; mobil Bild nur 200px hoch (media-viewer-image-light-390). Ändern: Vollbild-Betrachter mit Info-Spalte."}
- {"severity": "minor", "text": "Zeitangaben absolut und teils in UTC im Lauf ('So., 11.10.2026, 00:55 UTC' in subscriptions-expanded-light-1440) während der Zeitplan in Europe/Berlin steht. Ändern: Benutzerzeitzone, relativ."}
- {"severity": "info", "text": "Gelungen und beibehalten: Segmentbalken je Datei im Verlauf (history-expanded-light-1440) ist ein guter Gedanke und wird nur ruhiger gesetzt; Tastaturbedienung der Galerie, Skip-Link, Chips mit Icon plus Text, Fokus sichtbar, Alt-Text-Regel."}