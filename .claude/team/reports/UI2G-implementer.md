# UI2-G Feinschliff Redesign: Bericht

req_id REQ-DL-008, req_hash b838cb501c2e1aa5. Branch ui/next, Ausgangsstand 624038f.
Screenshots des neuen Stands: /work/shots-ui2g (94 Dateien, die genannten Ansichten selbst angesehen).
Prüfungen: corepack pnpm check grün (Exit 0), Vitest gesamt 1603 grün bei 1 übersprungenem Test, davon apps/web mit neuen Tests.

Punkt, Status, Beleg

1 Fixtures neueste zuerst: erledigt. Läufe nach startedAt, Beiträge nach discoveredAt absteigend wie GET /api/v1/history. App unverändert. tests/ui-shots/fixtures.mjs. Beleg: history-light-1440.png.
2 Anmeldung mobil: erledigt. Ursache: das Grid hatte keine expliziten Zeilen, die Resthöhe der Seite verteilte sich auf den 96px-Streifen und das Formular. Jetzt grid-template-rows: auto minmax(0, 1fr). auth.css. Beleg: login-light-390.png (Streifen 96px, Marke direkt darunter).
3 Limits: erledigt. Datenmenge und Bandbreite werden in MiB bzw. MiB pro Sekunde angezeigt und eingegeben, beim Speichern in Bytes umgerechnet (scale, Rundung auf ganze Bytes). Der Satz zu leer und 0 steht nur noch einmal in der Gruppenerklärung statt zweimal unter Feldern. AdminLimits.tsx. Tests in AdminLimits.test.tsx. Beleg: limits-light-1440.png.
4 Verlauf: erledigt. Tageskopf 15px und gedämpft (vorher gleich groß wie die Abschnittsüberschrift, 24px), Quelle der Beitragszeile als Uhrzeit, Siegel, Abo-Name (Plattform, Urheber und Abo als title), Live-Block sagt bei gefundenem Beitrag ohne Dateien "1 Beitrag gefunden, die Dateien werden erfasst." und "keine Dateien gefunden" nur bei postsFound 0. Ledger.tsx, ledger.css, RunLive.tsx. Tests in Sources.test.tsx. Beleg: history-light-1440.png.
5 Abo-Titel und Adressen: erledigt. Adresse in der Liste hat title "Plattform: voller Link" direkt am gekürzten Text (Titel und Detailseite hatten ihn schon). Aktionsbutton in Liste und Detail mit Klasse btn-action, min-width 168px. Subscriptions.tsx, SubscriptionDetail.tsx, subscriptions.css. Beleg: subscriptions-light-1440.png (Jetzt ausführen und Fortsetzen gleich breit).
6 Mobile Filterzeile und Abo-Detail: geprüft, keine Änderung nötig. Medien-Seite: Select volle Breite, Segmentwahl linksbündig. Abo-Detail: Aktionsbutton füllt die Breite neben dem Menü, Adresse linksbündig. Beleg: media-page-light-390.png, subscription-detail-light-390.png (Ausschnitt oben).
7 Vorschaubilder der Fixtures: erledigt. Lokal erzeugte SVGs aus Palette, Sonne und Silhouette je Beitrag und Datei, drei Beiträge sehen verschieden aus. fixtures.mjs. Beleg: history-light-1440.png.

Offene Punkte
- Die Konsolenmeldungen 401 und 500 im Capture-Lauf stammen aus den absichtlichen Fehlerzuständen (Login-Fehler, 500-Fixture). Der Capture-Lauf endet deshalb mit Exit 2, wie zuvor.
- Zwischenstand: Ein Commit ging mit einem roten Test durch (Befehlskette mit grep), der nächste Commit hat ihn behoben. Der Endstand ist grün.
