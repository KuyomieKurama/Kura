# UI2-H Medienansicht hält Browsergrenzen nicht ein: Bericht

req_id REQ-DL-008 (b838cb501c2e1aa5), betrifft auch REQ-DL-006. Branch ui/next, Ausgangsstand 881c39c.
Nutzerbefund: "Es ragt über den Bildschirm hinaus. Und ich muss raus zoomen."
Screenshots: /work/shots-ui2h (180 Dateien: 94 der Ansichten wie bisher, dazu je Größe und Datei die Betrachter-Fälle und die Galerie mit den großen Fixtures). Vorher-Stand: /work/shots-ui2h-before.
Messprotokolle: /work/shots-ui2h-before/messung-vorher.txt und /work/shots-ui2h/messung-nachher.txt.
Prüfungen: corepack pnpm check grün (Exit 0), Vitest 76 Dateien, 1603 grün bei 1 übersprungenem Test. Kein Push.

## 1 Reproduktion

Die bisherigen Fixtures waren 160x160-SVGs oder 1200x800-Bilder. Neu: tests/ui-shots/media-seed.mjs, Option `large`, Beitrag "Grosse Formate" mit echten Dateien (über HistoryRepository und DatabaseBlobStore gespeichert):
portrait_4000x6000.jpg, panorama_6000x1000.jpg, streifen_1000x6000.jpg, ohne_masse_5000x3000.jpg (die API liefert weder Maße noch Vorschau noch Farbe, geprüft im Test), handy_1080x1920.webm, kino_3840x2160.webm (echte Frames über MediaRecorder, nicht die auf Bildschirmgröße begrenzte Playwright-Aufnahme).

Test: tests/ui-shots/media-limits.mjs. Größen 390x844, 768x1024, 1024x768, 1440x900, 1920x1080, 1440x700, 844x390. Je Größe: Übersicht und Medien-Seite ohne seitliches Scrollen (scrollWidth <= clientWidth, keine Kachel rechts über dem Viewport), Betrachter für alle sechs Dateien und eine normale, mit und ohne Info-Spalte: BoundingBox von .viewer-media innerhalb von innerWidth x innerHeight, nutzbare Größe (mindestens 60x60), Filmstreifen behält die Kachelhöhe und wird nicht von der Info-Spalte verdeckt, Betrachter scrollt nicht seitlich.

Vorher (Commit dd417fc, altes CSS): 459 ok, 53 FAIL. 46 davon: Medium liegt nicht im Viewport. 7: Filmstreifen auf 24px gedrückt. Seitliches Scrollen der Seite: keines (Medien-Seite und Galerie sind in Ordnung).

Gemessene Werte vorher (Box des Mediums gegen Fenster):
- 1440x900, Portrait 4000x6000, Info aus: 1296x1944 (Fenster 900 hoch), Info an: 936x1404
- 1440x900, Streifen 1000x6000: 1000x6000 bei Info aus, 936x5616 bei Info an
- 1920x1080, Video 1080x1920: 1776x3157 (Info an: 1416x2517)
- 1024x768, Portrait: 880x1320, Streifen 880x5280
- 768x1024, Video hoch: 624x1109, Streifen 624x3744
- 390x844, Streifen: 374x2244
- 844x390 (Handy quer), Portrait: 700x1050, Video hoch 700x1244, Panorama in Ordnung, Querformat-Bild 700x420
- 1440x700, normales Bild 1200x800: 800 hoch bei 700 Fensterhöhe, auch ein ganz normales Foto ragte hinaus
Das Medium nahm also seine natürliche Seitenverhältnis-Höhe an und wurde unten abgeschnitten, Filmstreifen und Fuß lagen außerhalb. Belege: /work/shots-ui2h-before/media-viewer-portrait-info-on-dark-1440.png, media-viewer-video-hoch-info-off-dark-844x390.png.

## 2 Ursachen

1. apps/web/src/styles/media.css (vorher Zeilen 264-290, jetzt 271-300): .viewer-stage war ein Grid ohne definierte Zeilen, die Zeile war implizit auto. Darin kann `max-height: 100%` des Bildes und `height: 100%` des Rahmens nicht gegen die Bühnenhöhe auflösen, das Medium nahm seine Inhaltshöhe an. Bei Video kam `video.viewer-media { width: 100%; height: 100% }` mit derselben zyklischen Prozentangabe dazu.
2. media.css, `.viewer-stage { min-height: 60dvh }` im Block unter 1280px (vorher Zeile 456): ein Mindestmaß an der Stelle, an der die Zeile die Höhe bestimmen sollte. Zusammen mit `overflow-y: auto` am Bildschirm entstand ein Bild, das die Seite nach unten sprengte.
3. media.css, `.viewer-screen` Zeilen 166 und 464: die Filmstreifen-Zeile war `auto`. Der Streifen ist ein Scroll-Container (overflow-x: auto), sein automatisches Minimum ist 0, deshalb schrumpfte die Zeile bei zu wenig Platz auf ihr Padding (24px statt 80px) und die 56px-Kacheln wurden abgeschnitten.

Nicht die Ursache, geprüft: apps/web/index.html Zeile 5 hat `width=device-width, initial-scale=1.0`, kein user-scalable=no. Im Betrachter gibt es weder width/height-Attribute noch Inline-Style aus API-Maßen (MediaViewer.tsx Zeilen 22-25). Die Kachel (MediaTile.tsx) setzt width/height aus der API als Attribut, CSS (.tile-image, 100 %) überstimmt sie, die Galerie ist in der Messung nirgends breiter als der Viewport. Das Aufblähen kam allein aus dem Layout des Betrachters.

## 3 Korrektur (nur media.css)

- .viewer-stage: eine feste Spur `grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr)`, min-width und min-height 0.
- .viewer-frame: `position: relative`, 100 % der Spur. .viewer-media: `position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain`. Die Box des Mediums kann dadurch nie größer sein als der Rahmen, gleich welche Maße die Datei hat oder ob die API sie kennt. Bild und Video werden vollständig gezeigt, nie beschnitten. Die Regel `video.viewer-media` entfällt.
- Schmal (unter 1280px): `grid-template-rows: auto minmax(60dvh, 1fr) max-content auto`, das min-height an der Bühne entfällt. Der Bildschirm scrollt weiter, die Info-Spalte liegt unter dem Medium, das Medium bleibt am Anfang ganz sichtbar.
- Breit und schmal: Filmstreifen-Zeile `max-content`.
Rückgängig: `git revert d73e6f0 a0de3c1`. Design laut Spezifikation unverändert (Farben, Abstände, Pfeile, Info-Spalte 360px, Morph aus der Kachel), keine Farb-Literale.

## 4 Nachher

512 ok, 0 FAIL (Lauf mit dem endgültigen Test auf dem neuen CSS). Beispiele der gemessenen Werte:
- 1440x900 Portrait, Info an: Box innerhalb 900 Höhe, Filmstreifen darunter sichtbar (media-viewer-portrait-info-on-dark-1440.png)
- 390x844 Video hoch, Info an: Medium in 60dvh, Streifen mindestens 58px hoch (geprüft), Info darunter (media-viewer-video-hoch-info-on-dark-390.png)
- 844x390 Panorama 6:1: ganz sichtbar, Leiste und Streifen nutzbar (media-viewer-panorama-info-off-dark-844x390.png)
Selbst angesehen: diese drei Bilder plus Galerie und die Vorher-Bilder.

Testnamen: es gibt keinen Vitest, sondern das Skript tests/ui-shots/media-limits.mjs (Playwright, wie media-check.mjs). Prüfungen heißen z. B. "1440 viewer portrait info on : medium inside the viewport", "390 media page: no sideways scroll", "390 viewer video-hoch info on : the strip keeps the height of its tiles". Aufruf und Optionen in tests/ui-shots/README.md. Es läuft nicht in `pnpm check`, weil Browser und Datenbank nötig sind, wie capture.mjs und media-check.mjs.

## Offene Punkte und Annahmen

- Absturz des Chromium-Renderers in der Sandbox (Software-GL): trat vor und nach der Korrektur auf, unabhängig vom Layout, erst bei 1920x1080 mit dem 4K-Video, später bei 844x390 mit dem 24-Megapixel-Bild. Mit `--num-raster-threads=1` verschwindet er (mehrere Läufe, keine Wiederholung nötig). Der Test startet Chromium damit und wiederholt einen Absturz einmal in einem frischen Browser, mit Ausgabe "note". Ursache nicht abschließend geklärt, auf einer echten GPU nicht geprüft.
- Mit eingeschalteter View Transition (`--motion`) stürzt der Renderer bei 1920x1080 und dem 4K-Video reproduzierbar ab (zwei Versuche). Die Messung läuft darum standardmäßig mit prefers-reduced-motion, also ohne den Morph beim Öffnen. Ob das auf echter Hardware auftritt, weiß ich nicht. Frage an Coordinator und Reviewer: soll der Morph bei Video ausgelassen werden? Ich habe das nicht geändert, es wäre eine Erweiterung des Umfangs.
- Der Betrachter lädt weiter das Original (24 Megapixel). Auf schwachen Geräten ist das schwer. Vorschau-Stufe 960px zuerst zu laden wäre eine eigene Anforderung.
- Der Vorher-Lauf wurde mit dem endgültigen Test auf dem alten CSS wiederholt (Commit dd417fc für media.css, danach zurückgestellt und neu gebaut). Der erste Vorher-Lauf mit dem Test vom Commit dd417fc ergab 44 FAIL, ohne Streifen- und Überlappungsprüfung.
- Die Medien-Seite prüft das Skript nur für die Seite "Medien" und die Übersicht, nicht für die Abo-Detailseite.

## Änderungen

dd417fc Prüfung der Browsergrenzen mit großen Fixtures (vorher rot), a0de3c1 Betrachter hält den Viewport ein, 3aed4a6 Prüfung stabil, d73e6f0 Filmstreifen behält seine Höhe, 5a9a53d README, b235289 Lint.
Dateien: apps/web/src/styles/media.css, tests/ui-shots/media-seed.mjs, tests/ui-shots/media-limits.mjs, tests/ui-shots/README.md, dieser Bericht.
