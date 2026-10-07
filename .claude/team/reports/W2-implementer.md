Aufgabe
W2 Speicherkern und Immich in API und Weboberfläche einhängen, REQ-DL-003 (Hash b83be904af3eded5).

Status
braucht Review

Artefakte
- apps/api/src/app.ts und apps/api/src/immich-routes.ts: konfigurierbarer Filesystem-/PostgreSQL-Blobstore; lesbar ausgelagerte, authentifizierte Immich-Routen für Verbindung, Verbindungstest, Testtransfer und Transferstatus.
- apps/api/src/config.ts und .env.example: Storage-Konfiguration sowie dokumentierter, base64-kodierter 32-Byte-Schlüssel KURA_SECRET_KEY für AES-256-GCM.
- migrations/0032_immich_connections.sql: pro Benutzer verschlüsselte Immich-Verbindung.
- apps/web/src/App.tsx und api.ts: Immich-Seite mit Verbindungsformular, Verbindungstest, Testdatei-Auswahl/-upload sowie Status und Originalnachweis der letzten Übertragung.
- tests/wiring/immich-wiring.test.ts: Zwei-Benutzer-Isolation der Verbindung, kein API-Key in API-Antworten, verschlüsselter DB-Ruhewert und unbekannte Version.
- tests/wiring/immich-transfer.test.ts: Testtransfer gegen Fake-Immich, gespeicherter Originalnachweis, blockierte unsichere Übertragung, kein lokales Löschen und fremder Transferstatus nicht lesbar.
- Neue Commits dieser Fortsetzung: c2ae50d, 0cbdafe, 52d38b9 und 590127a.

Zusammenfassung
Der Testtransfer schreibt die Datei zuerst in den für den angemeldeten Benutzer konfigurierten Blobstore und übergibt sie danach an packages/immich-client. Der erfolgreiche Fake-Immich-Lauf persistiert Version, Bytezahl und Albumstatus; bei abgerissener Uploadantwort bleibt der Transfer reconciling und die lokale Blob-Kopie vorhanden. Der Endpoint gibt für jeden Transfer localOriginalRetained: true zurück und enthält keinen Lösch- oder Cleanup-Aufruf.

API-Schlüssel werden ausschließlich als AES-256-GCM-Ciphertext plus Nonce gespeichert, nie ausgelesen oder zurückgegeben. Ohne KURA_SECRET_KEY verweigert die API das Speichern. Fastify-Auditdaten erfassen nur Quelle, Aktion und Ziel-ID; die Testrequests enthalten keinen API-Key in ihren geloggten Request-Metadaten.

Prüfung
- Ausgeführt: corepack pnpm exec vitest run tests/wiring/immich-transfer.test.ts -> Test Files 1 passed (1); Tests 2 passed (2).
- Ausgeführt: corepack pnpm exec vitest run tests/wiring/immich-wiring.test.ts tests/wiring/immich-transfer.test.ts -> Test Files 2 passed (2); Tests 3 passed (3).
- Ausgeführt: export DATABASE_URL=postgres://kura_dev:kura_dev@127.0.0.1:5432/kura_dev; corepack pnpm check -> erfolgreich; literal result: Test Files 10 passed (10); Tests 45 passed | 1 skipped (46). Typecheck, ESLint, Web-Build und alle Paket-Builds erfolgreich.
- Vorher: aus W1-Handoff corepack pnpm check -> Test Files 9 passed (9); Tests 42 passed | 1 skipped (43). Vor der W2-Fortsetzung: 43 bestanden, 1 übersprungen.
- Ausgeführt: corepack pnpm audit --audit-level=high -> Exit 0; literal result: 2 vulnerabilities found, Severity: 1 low | 1 moderate; keine High/Critical.
- Ausgeführt: git diff --check -> erfolgreich.
- Nicht separat ausgeführt: apps/web/src/App.test.tsx, weil vitest.config.mts nur tests/**/*.test.ts einbezieht. Der Web-Build lief im Prüftor erfolgreich.

Annahmen
- KURA_SECRET_KEY ist zur Laufzeit ein base64-kodierter 32-Byte-Schlüssel; der Wert gehört ausschließlich in die unversionierte Laufzeitumgebung.
- Die unterstützten realen Immich-Versionen sind weiterhin unbekannt. Der Verbindungstest meldet deshalb supported: false; unbekannte oder nicht erreichbare Versionen werden nie als unterstützt angenommen.
- Der Base64-JSON-Testupload ist bewusst auf 4 MiB begrenzt und nur ein manueller Prüfpfad, kein allgemeiner Produktions-Upload.

Risiken
- R-05/R-12 bleiben offen: Der echte Immich-Vertragstest und Versions-Pinning gegen eine freigegebene Instanz stehen aus.
- Die lokale Bereinigung ist ausdrücklich nicht in W2 verdrahtet. Rückweg: git revert 590127a 52d38b9 0cbdafe c2ae50d (bei Bedarf zusätzlich die früheren W2-Commits 9d7ede3 und 0bb22bf); die datenwahrende Migration 0032 wird dabei nicht gelöscht.

Offene Fragen
- Keine Rückfrage gemäß Auftrag. Der echte Immich-Vertragstest bleibt als bekannter Risikopunkt offen.

Nächster Schritt
Review der W2-Verdrahtung; vor jeder späteren lokalen Bereinigung muss der Verifier R-05/R-12 gegen echte Immich-Daten abnehmen.
