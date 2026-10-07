Aufgabe
OIDC-Anmeldung aus packages/identity in API und Weboberfläche einhängen für REQ-DL-003, req_hash b83be904af3eded5.

Status
fertig

Artefakte
- apps/api/src/config.ts und .env.example: optionale OIDC-Umgebungsvariablen (Issuer, Client-ID, Client-Secret, Redirect-URL und Gruppen); alle vier Kernwerte müssen gemeinsam gesetzt sein, sonst bleibt der lokale Modus aktiv.
- apps/api/src/app.ts und apps/api/package.json: öffentliche Konfigurationsroute, Start- und Callback-Routen mit PKCE/State/Nonce via @kura/identity, browsergebundener zehnminütiger Transaktion, eigener Sitzung sowie Erfolg-/Fehler-Audit ohne Token, Secret oder Code.
- apps/web/src/App.tsx, apps/web/src/api.ts und apps/web/src/labels.ts: „Mit SSO anmelden“ nur bei aktivem OIDC und deutsche Fehleranzeige.
- tests/api-oidc/oidc.test.ts: lokaler Fake-OIDC-Anbieter für vollständigen API-Fluss, stabile issuer+subject-Zuordnung, ungültigen State, ungültigen Nonce und lokalen Login ohne OIDC.
- apps/web/src/App.test.tsx: sichtbarer SSO-Link nur bei aktivem API-Flag.
- pnpm-lock.yaml: Lockfile-Aktualisierung für die deklarierte Workspace-Abhängigkeit @kura/identity.

Zusammenfassung
Die API nutzt OidcClient und PostgresIdentityRepository aus der vorhandenen Identity-Lane. Unbekannte Subjects werden ausschließlich über (issuer, subject) als IdP-Benutzer angelegt; eine E-Mail dient nicht zur Verknüpfung. Bei deaktivierter oder unvollständiger OIDC-Konfiguration bleibt die lokale Anmeldung unverändert nutzbar. SSO-Fehler führen kontrolliert zur deutschen Login-Ansicht zurück, und Audit-Einträge enthalten nur Aktion, Ergebnis, Ziel und Quelladresse.

Prüfung
- Vorher laut Kartenfortsetzung: corepack pnpm check: 38 passed, 1 skipped.
- Erstprüfung dieser Fortsetzung: corepack pnpm check schlug fehl: ESLint meldete eine ungenutzte Variable und tests/api-oidc/oidc.test.ts enthielt einen Syntaxfehler.
- Ausgeführt: corepack pnpm exec vitest run tests/api-oidc/oidc.test.ts: Test Files 1 passed (1), Tests 4 passed (4).
- Ausgeführt: export DATABASE_URL=postgres://kura_dev:kura_dev@127.0.0.1:5432/kura_dev; corepack pnpm check: Test Files 8 passed (8), Tests 42 passed | 1 skipped (43); Typecheck, ESLint und alle Builds erfolgreich.
- Ausgeführt: corepack pnpm audit --audit-level=high: 2 vulnerabilities found; Severity: 1 low | 1 moderate; keine High/Critical.

Annahmen
- Die bestehende Migration 0010_oidc_identity.sql aus der Identity-Lane wird beim API-Start über den vorhandenen Migrationsrunner angewandt.
- Der pro Prozess gehaltene Transaktionsspeicher entspricht dem bestehenden Einzelprozess-Teststand; verteilte Instanzen sind nicht verifiziert.
- Verträge gegen konkrete Authentik- und Keycloak-Versionen sind unbekannt und gemäß D-011 nicht ausgeführt.

Risiken
- OIDC-Login-Transaktionen befinden sich im Prozessspeicher und überleben keinen API-Neustart nicht; der Browser erhält dann kontrolliert einen Loginfehler.
- Das vollständige Lifecycle-/SCIM-Sperrprofil aus Plan 11 ist nicht Teil dieses Verdrahtungsumfangs.

Offene Fragen
- unbekannt: Verhalten gegen die konkrete Authentik- und Keycloak-Installation des Auftraggebers (D-011).

Nächster Schritt
Review der Verdrahtung und anschließende Integration durch den Orchestrator.