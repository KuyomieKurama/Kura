Aufgabe
M3 Immich-Client mit Originalnachweis für REQ-DL-003 (Hash b83be904af3eded5), einmalige Reviewrunde 4 für den bestätigten Crash-Wiederanlaufbefund.

Status
braucht Review: Der v3.2.1-Upload-/Dublettenvertrag und der einmalig nachbearbeitete Crash-Wiederanlaufpfad sind geprüft.

Artefakte
- packages/immich-client/src/index.ts: fetch-basierter, typisierter Client; SecretResolver-Port für secret://immich/<verbindung>; begrenzt gestreamter Multipart-Upload mit Node-duplex=half, dokumentierter v3.2.1-`status`-Auswertung (`created|duplicate`), Verbindungstest, Dublettenabgleich, Asset-Metadaten/Original-Readback, Album- und Bulk-Delete-Operationen; persistierte Transfer-Zustandsmaschine und Cleanup-Entscheidung.
- migrations/0030_immich_transfers.sql: immich_transfers einschließlich atomar geschriebenem Prüfbeleg (Serverversion, Zielkonto, Verbindungsgeneration) sowie immich_cleanup_intents.
- tests/immich/client.test.ts: lokaler Node-HTTP-Fake und neun Tests für Streaming, Erfolg/Beleg, Mismatch/falsches Konto, unklare Antwort, explizite Dublette, abgeschnittenen Upload, langsame Antwort, Crash nach Remote-Erfolg vor dem lokalen Checkpoint, Transfer-Dublette ohne Vorabupload, Cleanup und Geheimnisfreiheit.
- Commits: 71a421b feat: add immich transfer client; f4c338c fix: satisfy immich client lint; 702a3f3 fix: stream immich uploads and persist evidence; 6d55f49 fix: reconcile uncertain immich uploads; a5a1c1d fix: keep reconciliation asset identifier defined.

Zusammenfassung
Der Upload verwendet keinen Blob und keine Vollpufferung mehr: ein ReadableStream erzeugt Multipart-Präambel, Originalbytes und Abschluss sequenziell; Node fetch erhält dafür duplex=half. Der Streaming-Test hält den zweiten Quellchunk zurück, bis der Fake den ersten Netzchunk empfangen hat; damit wäre das vorherige vollständige collect()-Verhalten blockiert. Der belegte `AssetMediaResponseDto` wird strikt als `{ id, status }` gelesen; nur `status: created|duplicate` ist gültig, und `duplicate` ergibt sich ausschließlich aus `status === 'duplicate'`.

Vor jedem Neu-Upload aus `uploading` oder `reconciling` ohne Asset-ID fragt der Transferdienst jetzt zuerst den SHA-1-Dublettenfund ab. Ein Fund wird im regulären Original-Readback (SHA-256 und Bytezahl) verifiziert und erst danach als `uploaded_unverified` persistiert; nur ohne Fund beginnt ein neuer Upload. Der Crash-Test simuliert einen erfolgreichen Remote-Empfang nach bereits persistiertem Status `uploading`, aber vor dem Asset-ID-Checkpoint; der Wiederanlauf endet `verified` bei genau einem Upload. Der separate Transfer-Dubletten-Test setzt nur ein Remote-Asset im Fake vor und belegt `uploads === 0`.

`deviceId` und `deviceAssetId` sind in der v3.2.1-OpenAPI nicht Teil von `AssetMediaCreateDto`. Sie werden daher trotz der allgemeinen REQ-Nennung nicht mehr gesendet und sind im Code als ungesichert bis zum echten Vertragstest markiert. Der Fake simuliert ausschließlich den belegten DTO-Vertrag.

Vor Upload und Verifikation liest der Client die Zielidentität und Serverversion. Nach vollständigem Original-Readback schreibt der einzige UPDATE-Übergang zu verified Status, Prüfzeit, Version, Konto und Verbindungsgeneration gemeinsam. Ein Kontowechsel endet in mismatch; ein Wechsel der Verbindungsgeneration wird durch die Cleanup-Entscheidung verweigert. Ohne abgefragtes ownerId bleibt die Kontozuordnung weiterhin nicht belegbar und Cleanup muss gesperrt bleiben.

Die HTTP-Route/DTO-Formen sind jetzt gegen die offizielle OpenAPI-Spezifikation des Release-Tags v3.2.1 belegt: https://raw.githubusercontent.com/immich-app/immich/v3.2.1/open-api/immich-openapi-specs.json (abgerufen 2026-10-06). Belegt sind GET /server/ping, GET /server/version, GET /users/me, POST /assets (multipart AssetMediaCreateDto), POST /assets/bulk-upload-check (AssetBulkUploadCheckDto), GET /assets/{id}, GET /assets/{id}/original, POST /albums, PUT /albums/{id}/assets und DELETE /assets mit AssetBulkDeleteDto. Die frühere unbelegte einzelne Delete-Route wurde auf den belegten Bulk-Delete-Vertrag umgestellt. Dies ist keine reale Kompatibilitätsabnahme und kein Versions-Pinning: D-004 verlangt dafür noch einen Test gegen eine echte Instanz.

Prüfung
- `corepack pnpm typecheck`: erfolgreich.
- `corepack pnpm exec vitest run tests/immich/client.test.ts`: Exit 0; literal result: `Test Files  1 passed (1)` / `Tests  9 passed (9)` (vorher: `Tests  7 passed (7)`).
- `git diff --check`: Exit 0 vor Commit.
- `corepack pnpm audit --audit-level=high`: Exit 0; literal result: `2 vulnerabilities found` und `Severity: 1 low | 1 moderate`; keine High/Critical. Keine neue Abhängigkeit hinzugefügt.
- `corepack pnpm check`: Exit 0; literal Resultat: `Test Files  5 passed (5)` / `Tests  25 passed (25)` (vorher: `Tests  23 passed (23)`); Typecheck, ESLint, Web-Build und alle Paket-Builds erfolgreich.

Annahmen
- Die OpenAPI des offiziellen Release-Tags v3.2.1 ist ein belastbarer API-Beleg für die hier verwendeten Routen und DTOs, ersetzt aber keinen Test gegen die tatsächlich eingesetzte Instanz.
- Der Fake ist absichtlich kein Ersatz für eine echte Immich-Instanz (R-05). Seine Fehlermodi validieren ausschließlich Kura-Verhalten ohne externe Laufzeitquelle.
- Der API-Key bleibt nur im Resolver-Port und wird weder im Transferdatensatz noch in Fehlertexten gespeichert.

Risiken
- Keine reale Immich-Version ist gegen Kura getestet oder gepinnt (D-004); unbekannte/geänderte Versionen müssen automatisches Cleanup blockieren (T49).
- Der Fake prüft keine echte Multipart-Parser-Kompatibilität und keine Immich-Berechtigungen; dies bleibt für den realen Vertragstest offen.
- Eine Down-Migration für 0030 wird nicht mitgeliefert: das Löschen bereits persistierter Transfer-/Intent-Belege wäre destruktiv. Rückweg für nicht ausgerollte Stände: Commits `a5a1c1d` und `6d55f49` (sowie die vorigen M3-Commits bei vollständigem Rückbau) revertieren. Für ausgerollte Datenbankstände ist eine separat geprüfte, datenwahrende Migration erforderlich.

Offene Fragen
- Echter Vertragstest und Versions-Pinning gegen eine freigegebene Immich-Instanz stehen aus.

Nächster Schritt
Einbindung: Migration 0030 mit dem bestehenden storage-Migrator ausführen; ImmichClient aus @kura/immich-client mit Basis-URL, secret://immich/<verbindung> und SecretResolver konstruieren; TransferRepository und TransferService im Transfer-Worker injizieren; TransferService.run die erwartete Konto-ID und aktuelle Verbindungsgeneration übergeben; lokale Datei nur bei decideLocalDeletion(...).allowed === true und in der Storage-Lane entfernen.
