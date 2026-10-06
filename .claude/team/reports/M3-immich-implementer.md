Aufgabe
M3 Immich-Client mit Originalnachweis für REQ-DL-003 (Hash b83be904af3eded5).

Status
blockiert: Der eigene Paket- und Fake-Immich-Teststand ist grün, aber das verpflichtende Gesamttor scheitert ausschließlich an bestehenden, nicht für diese Lane freigegebenen Erwartungen zur Anzahl/letzten Migration.

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
- `corepack pnpm check`: fehlgeschlagen; Typecheck und ESLint waren erfolgreich, Vitest lief 21 Tests, davon 18 erfolgreich und 3 fehlgeschlagen. Ursache: tests/integration/migrations.test.ts erwartet exakt die drei bisherigen Migrationen; tests/integration/status.test.ts erwartet appliedCount 3 / 0003_auth_hardening. Die neue verbindliche Migration 0030 erzeugt korrekt vier angewandte Migrationen und 0030_immich_transfers. Diese beiden Testdateien liegen außerhalb meiner erlaubten Dateiherrschaft und wurden nicht verändert.
- Keine neue Abhängigkeit, daher keine Versions-/Lizenzergänzung.

Annahmen
- Die lokalen Route- und DTO-Formen sind als ungesicherter Vertrag markiert. Planung 05 belegt Controller-Operationen, aber keine release-geprüften URL-/DTO-Details. Die Fake-Tests ersetzen keinen Test gegen eine echte Immich-Instanz (R-05); Version-Pinning bleibt bis dahin verboten (D-004).
- Der Fake deckt Erfolg, verlorene Antwort nach Empfang, Readback-Mismatch, falsches Konto und 5xx ab. Abgeschnittener Upload und langsame Antwort sind nicht separat automatisiert: unbekannt/unvollständig.

Risiken
- `upload` puffert das Multipart-Objekt derzeit über Blob im Speicher und erfüllt damit noch nicht die gewünschte Streaming-Upload-Eigenschaft für große Dateien.
- Richtige Kontozuordnung wird nur geprüft, wenn die reale API `ownerId` liefert; sonst muss automatische Löschfreigabe konservativ gesperrt werden.
- API-Routen und Payloads sind bis zum Test gegen eine konkrete offizielle Immich-Release-Version ungesichert.

Offene Fragen
- Orchestrator soll die außerhalb dieser Lane liegenden Migration-/Status-Testexpectations auf die neue Migration aktualisieren oder deren Eigentümer beauftragen.
- Echter Vertragstest und Version-Pinning gegen eine freigegebene Immich-Instanz stehen aus.

Nächster Schritt
Nach Korrektur der zentralen Migrationserwartungen `corepack pnpm check` erneut ausführen. Einbindung: Migration 0030 mit dem bestehenden storage-Migrator ausführen; `ImmichClient` aus @kura/immich-client mit einer Basis-URL, `secret://immich/<verbindung>` und einem SecretResolver konstruieren; TransferRepository und TransferService im Transfer-Worker injizieren; lokale Datei nur bei `decideLocalDeletion(...).allowed === true` und in der Storage-Lane entfernen.
