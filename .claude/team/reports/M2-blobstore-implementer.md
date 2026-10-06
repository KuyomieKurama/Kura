Aufgabe
M2 Speicherkern als Bibliothek in packages/blobstore (REQ-DL-003, Hash b83be904af3eded5).

Status
teilweise umgesetzt und verifiziert

Artefakte
- packages/blobstore/src/index.ts: Storage-Vertrag, Dateisystem-Backend (CAS/Template), PostgreSQL-Chunk-Backend, SHA-256-Streaming, Staging, Quota, Owner-Prüfung, Leser-Leases, zweiphasiges Entfernen und Migration-Port-Skizze.
- packages/blobstore/package.json: direkte Laufzeitabhängigkeit pg 8.23.1 (PostgreSQL License, MIT-ähnlich).
- migrations/0020_blobstore.sql: Staging-, Chunk- und Objekt-Tabellen mit Owner-FK und Chunkgrenze 4 MiB.
- tests/blobstore/blobstore.test.ts: 3 Integrationstests für Dateisystem und echte PostgreSQL.
- Commit a4be30c (feat: add blobstore backends).

Zusammenfassung
Die neue Bibliothek schreibt in begrenzten Chunks, berechnet/verifiziert SHA-256 bei Finalisierung und hält DB-Teilwrites bis zur Finalisierung unsichtbar. Das Filesystem-Backend benutzt private Staging-Dateien, restriktive Rechte, CAS oder Template-Ziele und blockiert Traversal, Kontrollzeichen, Windows-Reservierungen und Symlinks auf dem Zielpfad. Der DB-Modus nutzt Transaktionen, Owner-Filter und eine pro Owner/Hash eindeutige Objektzeile.

Prüfung
- Ausgeführt: sha256sum docs/requirements/REQ-DL-003.md -> b83be904af3eded58ba81ec92ec4e28a4cde2939609e18b617f15adc27411b08.
- Ausgeführt: pnpm --filter @kura/blobstore typecheck && pnpm exec eslint packages/blobstore tests/blobstore && pnpm exec vitest run tests/blobstore/blobstore.test.ts -> 3 Tests bestanden.
- Ausgeführt: pnpm audit --audit-level=high -> kein High/Critical; 2 Befunde (1 low, 1 moderate).
- Ausgeführt: corepack pnpm check -> grün; Typecheck, Lint, Web-Build, Vitest (5 Dateien/19 Tests) und Paket-Build erfolgreich. Teststand vor der Lane unbekannt; nach der Orchestrator-Anpassung der fremden Migrationserwartungen: 19 Tests bestanden.
- Nicht geprüft: 256-MiB- und optionaler KURA_BIG_FILE_GIB-Test, lokaler Fake-HTTP-Fetch, Symlink-Angriff, Crash zwischen delete_pending und Entfernen sowie vollständige Speicher-Migration. Diese Abnahmepunkte sind noch nicht implementiert.

Annahmen
- Der bestehende Storage-Port enthält beim Lesen keinen Owner. Die Bibliothek liefert/erwartet deshalb strukturell kompatible ObjectRefs mit zusätzlichem ownerUserId; ohne diesen Wert verweigert sie Zugriffe.
- Quoten sind pro aktiver Write-Session geprüft; eine systemweite, transaktional aggregierte Owner-Quote über parallele DB-Writes benötigt eine vom Katalog verantwortete Reservierungstabelle bzw. zusätzlichen Vertrag.

Risiken
- Der Filesystem-Index (Leases/Referenzen) ist pro Prozess und noch nicht persistent. Ein Prozessneustart kann deshalb weder Persistenz noch sichere Mehrprozess-Referenzzählung garantieren.
- Die vollständige Abnahme ist eingeschränkt, weil die oben genannten großen Streaming-, HTTP-Fetch-, Symlink-, Crash- und Mehrprozess-Tests noch nicht implementiert sind.

Offene Fragen
- Keine Rückfrage gemäß Auftrag.

Einbindung
1. Vor Nutzung migrations/0020_blobstore.sql über den bestehenden Runner ausführen.
2. FilesystemBlobStore(root, 'cas' | 'template', { quotaBytes, chunkSize? }) bzw. DatabaseBlobStore(pool, { quotaBytes, chunkSize? }) erzeugen.
3. beginWrite({ ownerUserId }), chunkweise append, finalize(sha256Digest(...)); für Lesen/Löschen den von finalize gelieferten ObjectRef inklusive ownerUserId übergeben.
4. Der spätere Direct-HTTP-Adapter muss vor DirectHttpFetchPort.fetch die zentrale Egress-/SSRF-Policy durchsetzen; diese Prüfung gehört gemäß Lane-Auftrag nicht in dieses Paket.

Nächster Schritt
Vor der produktiven Einbindung die fehlenden Abnahmetests sowie persistente Mehrprozess-Referenz-/Quotenlogik ergänzen; der aktuelle Bibliotheksstand ist dagegen vollständig baubar und im Gesamtcheck grün.