# UI2-J Abo-Auswahl der Medien-Seite (REQ-DL-008, b838cb501c2e1aa5)

Stand: Branch ui/next, Basis e2d28ee. Kein Push.

## Ursache
Die Auswahl war ein natives select. Die Liste zeichnet der Browser selbst; Lage, Rand, Schatten und Hervorhebung
(System-Hellblau) sind per CSS nicht steuerbar. Die Messung der Vorfahren (Pruefung, Zeile "note") ergibt: kein
transform, will-change, contain, filter, backdrop-filter, content-visibility, view-transition-name, kein sticky oder
fixed, kein overflow-Clip ausser am select selbst. Die Verschiebung kommt also nicht aus dem Seitenbau, sondern aus dem
Systempopup (nach dem Screenshot des Nutzers vermutlich ein Fehler der Plattform beim Zeichnen des Popups auf dem
Handy-Fenster). Ich habe das auf diesem System nicht nachgestellt. Die Abhilfe ist deshalb keine CSS-Korrektur, sondern
eine eigene Liste im DOM.

## Aenderungen
- apps/web/src/ui/Select.tsx (neu): Knopf mit role combobox plus Liste mit role listbox. Fokus bleibt auf dem Knopf,
  aria-activedescendant benennt die Zeile. Pfeile, Pos1, Ende, Enter und Leertaste, Escape (Fokus bleibt am Knopf),
  Tippen springt, Tab und Klick ausserhalb schliessen. Ab 640px Popover direkt unter dem Knopf, gleiche Breite, nach oben
  wenn unten weniger als 200px frei sind und oben mehr Platz ist, max-height folgt dem freien Platz (mindestens 120px).
  Unter 640px Blatt von unten ueber der Bottom-Navigation (Hintergrund abgedunkelt, 44px Zeilen, Titel).
- apps/web/src/ui/Blocks.test.tsx: Unit-Test fuer Tastatur, Auswahl, Escape, Klick ausserhalb.
- apps/web/src/MediaPage.tsx: natives select und Caret durch Select ersetzt.
- apps/web/src/styles/ui.css: Stile der Auswahl (nur Tokens: surface-overlay, line-strong, shadow-popover,
  shadow-dialog, accent-soft, backdrop, ink, ink-muted). Alter Block .select-inline in media.css entfernt.
  Hoher Kontrast: aktive Zeile bekommt eine Kontur. Reduced-motion ueber die Tokens --dur-*.
- tests/ui-shots/select-popup.mjs (neu) und README.

## Alle select der Weboberflaeche (grep)
AdminLimits.tsx:213, ScheduleForm.tsx (5), Adapters.tsx:83, Users.tsx:112, SubscriptionForm.tsx:72 bleiben nativ
(Formulare, erlaubt). MediaPage.tsx:111 ist die einzige Filter-Auswahl, sie ist ersetzt. Andere Filter-Auswahlen mit
gleichem Problem gibt es nicht.

## color-scheme (Punkt 4)
Nichts zu aendern: tokens.css setzt color-scheme light und im dunklen Block dark, index.html hat die Meta-Angabe. Die
Pruefung misst es je Schema am Root und an einem frisch angelegten nativen select: beides stimmt in hell und dunkel.

## Pruefung
- Rot vorher: select-popup.mjs gegen das native select (Lauf mit 390x844 und 1440x900): 16 Fehlschlaege, alle
  "Liste ist nicht im DOM". Mehr ist beim nativen Popup nicht messbar, weil Playwright es nicht sieht. Das ist die
  Begruendung fuer die Einschraenkung auf diesen Befund.
- Gruen nachher: 363 Pruefungen ok, 4 Viewports, hell und dunkel, mit und ohne Teststreifen, Scroll 0 und 400, Tastatur,
  Klick ausserhalb.
- corepack pnpm check: Exit 0, Vitest Root 1603 gruen, 1 uebersprungen. Web-Tests im Paket: 153 gruen. Der wacklige Test
  tests/patreon/worker.test.ts ist nicht aufgefallen.
- Screenshots: /work/shots-ui2j (32 Dateien). Angesehen: 1440x900 dunkel (Liste buendig unter dem Knopf, Haken, Akzent),
  390x844 hell nach Scroll (Blatt ueber der Bottom-Navigation, 44px Zeilen), 844x390 (Liste ganz sichtbar, am Knopf).

## Grenzen
- Der Fehler des Nutzers wurde nicht am Original nachgestellt; die Abhilfe beseitigt die Ursache (Systempopup).
- Auf einem echten Handy (Touch, Bildschirmtastatur, Safe-Area) nicht geprueft, nur mit Playwright Emulation (isMobile).
- Bei geoeffnetem Blatt scrollt die Seite dahinter weiter (kein Scroll-Lock).
- Rueckweg: git revert des Commits "UI2-J".
