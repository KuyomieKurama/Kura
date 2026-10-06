Aufgabe
M2 Speicherkern als Bibliothek in packages/blobstore (REQ-DL-003, Hash b83be904af3eded5).

Status
umgesetzt und verifiziert

Artefakte
- packages/blobstore/src/index.ts: etablierter Storage-Vertrag, Dateisystem-CAS/Template und PostgreSQL-Chunk-Backend mit SHA-256-Streaming, Staging, Owner-Prüfung, Quoten, Leser-Leases, zweiphasigem Entfernen sowie Migrations- und Direct-HTTP-Ports.
- packages/blobstore/package.json: direkte Laufzeitabhängigkeit pg 8.23.1 (PostgreSQL License, MIT-ähnlich).
- migrations/0020_blobstore.sql: Staging-, Chunk- und Objekt-Tabellen mit Owner-FK, Staging-Ablauf und maximal 4-MiB-Chunk.
- tests/blobstore/blobstore.test.ts: 10 Blobstore-Tests (9 aktiv, 1 optional übersprungen).
- Commits: a4be30c, ffee951, bfb1d8e, b1ef655 und 56652a6.

Zusammenfassung
Die Bibliothek schreibt über private Staging-Objekte, berechnet SHA-256 inkrementell und finalisiert atomar per Rename beziehungsweise Datenbanktransaktion. DB-Finalisierung und DB-Lesen paginieren je Chunk und halten keine Gesamtdatei im RAM. Der Dateisystemmodus nutzt restriktive Berechtigungen, CAS oder bereinigte Template-Namen; Traversal, Kontrollzeichen, Windows-reservierte Namen sowie Symlink-Flucht werden verweigert. DB-Quoten werden unter einem Owner-Advisory-Lock gegen persistierte Objekte und offene Staging-Writes geprüft. Das DirectHttpFetchPort bleibt absichtlich nur ein Port; ein lokaler Fake-HTTP-Test belegt die Integration, während der spätere Adapter davor die zentrale Egress-/SSRF-Policy anwenden muss.

Prüfung
- Ausgeführt: sha256sum docs/requirements/REQ-DL-003.md -> b83be904af3eded58ba81ec92ec4e28a4cde2939609e18b617f15adc27411b08.
- Ausgeführt: corepack pnpm exec vitest run tests/blobstore/blobstore.test.ts -> 9 bestanden, 1 per fehlender KURA_BIG_FILE_GIB übersprungen.
- Enthalten: Roundtrip beider Layouts, SHA-256, unsichtbares DB-Staging und Abbruch, Owner-Isolation, CAS-Duplikat, Quota, Lease/Markieren/zweiter Löschschritt (Crash-Simulation), Traversal/Windows-Namen/Symlink sowie lokaler Direct-HTTP-Fake.
- Enthalten: beide 256-MiB-Synthesestreams mit 1-MiB-Chunks; Lese-/Schreibpfade prüfen Heap kleiner 128 MiB. Kein Inhalt wird als Gesamtbuffer erzeugt.
- Ausgeführt: corepack pnpm check -> grün; Typecheck, Lint, Web-Build, Vitest (5 Dateien, 25 bestanden; 1 optional übersprungen) und Paket-Build erfolgreich.
- Ausgeführt: pnpm audit --audit-level=high -> kein High/Critical; 2 Befunde (1 low, 1 moderate).
- Nicht ausgeführt: optionaler KURA_BIG_FILE_GIB-GiB-Lauf, weil die Variable nicht gesetzt war; der Test ist standardmäßig übersprungen.

Annahmen
- Der bestehende Storage-Port enthält beim Lesen keinen Owner. Die Bibliothek verwendet deshalb strukturell kompatible ObjectRefs mit zusätzlichem ownerUserId und verweigert Zugriffe ohne passende Owner-ID.
- Die Owner-Quota zählt eindeutige persistierte Objektbytes sowie offene DB-Staging-Bytes. Duplikate erhöhen die Referenzzahl, nicht den physischen Verbrauch.

Risiken
- Der Filesystem-Lease-/Referenzindex lebt im Prozess; der PostgreSQL-Modus persistiert Leases/Referenzzähler. Mehrprozess-Referenzschutz für das reine Filesystem-Backend erfordert einen gemeinsamen Metadatenspeicher und ist nicht Teil der aktuellen Schnittstelle.
- Der DirectHttpFetchPort erzwingt absichtlich keine Egress-/SSRF-Regel; die Einbindung muss diese davor ausführen.

Offene Fragen
- Keine Rückfrage gemäß Auftrag.

Einbindung
1. migrations/0020_blobstore.sql über den bestehenden Storage-Migrationsrunner ausführen.
2. FilesystemBlobStore(root, 'cas' | 'template', { quotaBytes, chunkSize? }) oder DatabaseBlobStore(pool, { quotaBytes, chunkSize? }) erzeugen.
3. beginWrite({ ownerUserId }), chunkweise append und finalize(sha256Digest(...)) aufrufen; für Lesen/Löschen den gelieferten ObjectRef mit ownerUserId verwenden.
4. Vor DirectHttpFetchPort.fetch im späteren Adapter die zentrale Egress-/SSRF-Policy ausführen.

Nächster Schritt
Der Orchestrator kann die Bibliothek nach Migration 0020 in den API-Adapter einbinden. Für eine reine Mehrprozess-Dateisystembereitstellung ist als separate Erweiterung ein gemeinsamer Metadatenkatalog für Leases/Referenzen vorzusehen.
