Aufgabe
M3 Immich-Client mit Originalnachweis für REQ-DL-003 (Hash b83be904af3eded5).

Status
abgeschlossen: Der Paket- und Fake-Immich-Teststand sowie das verpflichtende Gesamttor sind grün.

Artefakte
- packages/immich-client/src/index.ts: fetch-basierter, typisierter Client; SecretResolver-Port für secret://immich/<verbindung>; Verbindungstest, Upload, Dublettenabgleich, Asset-Metadaten/Original-Readback, Album- und Delete-Operationen; persistierte Transfer-Zustandsmaschine und Cleanup-Entscheidung.
- migrations/0030_immich_transfers.sql: immich_transfers und immich_cleanup_intents einschließlich Generation und Referenzzähler.
- tests/immich/client.test.ts: lokaler Node-HTTP-Fake und fünf Tests.
- Commits: 71a421b feat: add immich transfer client; f4c338c fix: satisfy immich client lint.

Zusammenfassung
Nach Upload wird ausschließlich ein vollständiger Original-Stream mit eigenem SHA-256 und Bytezahl verglichen. Ein HTTP-Erfolg erlaubt keine Löschfreigabe. Bei verlorener Uploadantwort wird über den SHA-1-Dublettenabgleich wieder abgeglichen, nicht erneut hochgeladen. Die Löschentscheidung führt keine Dateilöschung aus und verweigert sie bei jeder fehlenden Bedingung.

Prüfung
- `corepack pnpm typecheck`: erfolgreich.
- `corepack pnpm exec vitest run tests/immich/client.test.ts`: 5 Tests erfolgreich (vor der nur lintbezogenen Letztkorrektur).
- `corepack pnpm audit --audit-level=high`: Exit 0, 2 Vulnerabilities (1 low, 1 moderate), keine High/Critical.
- `corepack pnpm check`: erfolgreich. Typecheck, ESLint, Web-Build, Vitest (5 Testdateien / 21 Tests) und alle Paket-Builds erfolgreich.
- Keine neue Abhängigkeit, daher keine Versions-/Lizenzergänzung.

Annahmen
- Die lokalen Route- und DTO-Formen sind als ungesicherter Vertrag markiert. Planung 05 belegt Controller-Operationen, aber keine release-geprüften URL-/DTO-Details. Die Fake-Tests ersetzen keinen Test gegen eine echte Immich-Instanz (R-05); Version-Pinning bleibt bis dahin verboten (D-004).
- Der Fake deckt Erfolg, verlorene Antwort nach Empfang, Readback-Mismatch, falsches Konto und 5xx ab. Abgeschnittener Upload und langsame Antwort sind nicht separat automatisiert: unbekannt/unvollständig.

Risiken
- `upload` puffert das Multipart-Objekt derzeit über Blob im Speicher und erfüllt damit noch nicht die gewünschte Streaming-Upload-Eigenschaft für große Dateien.
- Richtige Kontozuordnung wird nur geprüft, wenn die reale API `ownerId` liefert; sonst muss automatische Löschfreigabe konservativ gesperrt werden.
- API-Routen und Payloads sind bis zum Test gegen eine konkrete offizielle Immich-Release-Version ungesichert.

Offene Fragen
- Echter Vertragstest und Version-Pinning gegen eine freigegebene Immich-Instanz stehen aus.

Nächster Schritt
Einbindung: Migration 0030 mit dem bestehenden storage-Migrator ausführen; `ImmichClient` aus @kura/immich-client mit einer Basis-URL, `secret://immich/<verbindung>` und einem SecretResolver konstruieren; TransferRepository und TransferService im Transfer-Worker injizieren; lokale Datei nur bei `decideLocalDeletion(...).allowed === true` und in der Storage-Lane entfernen.
