# UI2-I Seitenleiste bleibt beim Scrollen nicht stehen: Bericht

req_id REQ-DL-008 (b838cb501c2e1aa5). Branch ui/next, Ausgangsstand 7f0ff0a.
Nutzerbefund: "Wenn ich runter scrolle, verschieben sich links die Sachen auch."
Screenshots: /work/shots-ui2i (12 Dateien, je Seite, mit/ohne Streifen, 1440x900 und 1024x700, Scroll 400px).
Prüfung: tests/ui-shots/sidebar-sticky.mjs, README-Eintrag "Sidebar stays put while scrolling". Kein Push.

## 1 Ursache

Hypothese 1 bestätigt, Hypothese 2 widerlegt, Hypothese 3 teilweise.

- apps/web/src/styles/shell.css:65 (.test-strip, Grid-Zeile 1) ist nicht sticky und scrollt mit weg. apps/web/src/styles/shell.css:115-121 (.sidebar-sticky) hat top: 0 und height: calc(100dvh - var(--testbar-height)). Die Leiste klebt also bei top 0 mit 32px weniger Höhe: sobald der Streifen weggescrollt ist, springt die ganze Leiste um 32px nach oben (Marke 56 auf 24) und unten bleibt eine Lücke von 32px (Unterkante 868 statt 900).
- Kein Vorfahr (html, body, .shell, main) hebelt sticky aus: die Leiste verschiebt sich um genau 32px, nicht um die Scrolltiefe.
- Ohne Streifen (aus dem DOM entfernt) ist die Leiste in Ruhe, aber die Höhe rechnet weiter mit 32px: Unterkante 868 statt 900 schon bei Scroll 0.
- Nebenbefund, gleiche Wurzel: apps/web/src/styles/media.css:752 (.day-heading) klebt bei top: var(--topbar-height, 0) = 56px. Am Desktop gibt es keine Top-Leiste, der Tageskopf der Medien-Seite hing 24px unter dem Streifen statt direkt darunter.

## 2 Fix

- shell.css: .shell bekommt --strip-offset (= --testbar-height, ohne .test-strip als Kind 0px über :has). Ab 1024px ist `.shell > .test-strip` sticky (top 0, z-index 20). .sidebar-sticky nutzt top und height mit --strip-offset.
- media.css: ab 1024px sitzt .day-heading bei top: var(--strip-offset, 0px). Unter 1024px unverändert.
- Mobil (Top-Leiste, Bottom-Navigation) und Betrachter unverändert; AuthScreens nicht berührt (Selektor nur .shell > .test-strip).
- Rückweg: git revert des Fix-Commits (nur zwei CSS-Dateien).

## 3 Messwerte (getBoundingClientRect, Position Marke / erster Eintrag / Fußunterkante / Leistenunterkante / Streifen top)

Vorher, 1440x900 Medien mit Streifen: Scroll 0: 56 / 111.8 / 900 / 900 / 0. Scroll 50, 400, ganz unten: 24 / 79.8 / 868 / 868 / -50, -400, -2794.
Vorher, 1024x700 Abo-Detail mit Streifen: Scroll 0: 56 / 111.8 / 700 / 700 / 0. Scroll 50, 400, ganz unten: 24 / 79.8 / 668 / 668 / -50, -400, -2362.
Vorher, 1440x900 Verlauf ohne Streifen: alle Positionen gleich, aber Unterkante 868 statt 900 (Lücke 32px).
Vorher, Tageskopf Medien bei Scroll 400: top 56 statt 32 (mit Streifen), 56 statt 0 (ohne).
Vorher gesamt: 82 FAIL, 71 ok. Mobil 390x844: 4 ok (unverändert, Basislinie).

Nachher, 1440x900 Medien mit Streifen: 56 / 111.8 / 900 / 900 / 0 bei allen vier Positionen.
Nachher, 1024x700 Abo-Detail mit Streifen: 56 / 111.8 / 700 / 700 / 0 bei allen vier Positionen.
Nachher, 1440x900 Verlauf ohne Streifen: 24 / 79.8 / 900 / 900, ganz unten 23.8 / 79.5 / 899.8 (Teilpixel, innerhalb 0,5px).
Nachher gesamt: 153 ok, 0 FAIL, Exit 0.

## 4 Grenzen der Prüfung

- Bei 1440x900 sind Medien und Verlauf mit den Fixtures nicht lang genug (unter 800px Scrolltiefe); dort hängt der Test einen 2400px-Abstandhalter in .page ein (Ausgabe "[padded]", Scrolltiefe danach 2794 bis 2993px). Alle anderen Fälle laufen ohne Abstandhalter (Scrolltiefe 855 bis 2362px). Die Messung von Leiste und Streifen hängt nicht vom Inhalt ab.
- "Ohne Teststreifen" ist im Test das Entfernen des Elements zur Laufzeit; im Produkt rendert TestStrip derzeit immer (nur der Text wechselt zwischen HTTP und HTTPS). Der :has-Zweig deckt den Fall ab, falls der Streifen später entfällt.
- Nur Chromium geprüft (Playwright der Sandbox). :has wird von aktuellen Chromium, Safari und Firefox unterstützt, nicht gegen diese zwei geprüft.
