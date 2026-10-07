Aufgabe
W2 Speicherkern und Immich in API und Weboberfläche einhängen, REQ-DL-003 (Hash b83be904af3eded5).

Status
teilweise umgesetzt und geprüft.

Artefakte
- apps/api/src/app.ts und config.ts: konfigurierbarer Filesystem-/PostgreSQL-Blobstore, per Benutzer geschützte Immich-Verbindung, AES-256-GCM-Speicherung des API-Schlüssels, Verbindungstest und Testtransfer ohne lokale Löschung.
- migrations/0032_immich_connections.sql: pro Benutzer verschlüsselte Verbindung.
- apps/web/src/App.tsx und api.ts: Immich-Navigation, Verbindungsformular und Teststatus.
- .env.example: Storage- und KURA_SECRET_KEY-Konfiguration.

Zusammenfassung
API-Schlüssel werden niemals in Antworten zurückgegeben; ohne KURA_SECRET_KEY verweigert die API das Speichern. Der Testtransfer speichert zuerst über den konfigurierten Blobstore und meldet localOriginalRetained: true. Es gibt keinen lokalen Löschaufruf.

Prüfung
- Ausgeführt: corepack pnpm check.
- Literal: Test Files 9 passed (9); Tests 43 passed | 1 skipped (44); Build erfolgreich.
- Ausgeführt: tests/wiring/immich-wiring.test.ts prüft zwei Benutzer, niemals zurückgegebenen API-Key, verschlüsselten DB-Wert und "unbekannt" bei unerreichbarem Immich.
- Vorher: aus W1-Handoff 42 bestanden, 1 übersprungen.
- Nicht separat ausgeführt: API-Testtransfer gegen den bestehenden Fake-Immich; dessen Client-Happy-Path und unsicherer Uploadzustand bleiben durch tests/immich/client.test.ts abgedeckt.

Annahmen
- KURA_SECRET_KEY ist als base64-kodierter 32-Byte-Schlüssel zur Laufzeit gesetzt.
- Unterstützte reale Immich-Versionen sind weiterhin unbekannt; der Verbindungstest meldet daher supported: false.

Risiken
- R-05/R-12 bleiben offen; es wird bewusst keine Löschung lokaler Originale verdrahtet.
- Der Testdatei-Upload verwendet vorerst Base64-JSON und ist auf 4 MiB begrenzt.

Offene Fragen
- Die vollständige W2-spezifische Testabdeckung für Ownership, Verschlüsselung und unklare Uploads ist noch zu ergänzen.

Nächster Schritt
Review der Sicherheits- und API-Verträge; anschließend gezielte W2-Integrationstests ergänzen.
