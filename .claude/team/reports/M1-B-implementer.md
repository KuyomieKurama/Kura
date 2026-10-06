Aufgabe
M1-B OIDC-Anmeldung als Bibliothek in packages/identity für REQ-DL-003, Hash b83be904af3eded5.

Status
abgeschlossen

Artefakte
- packages/identity/src/index.ts: OIDC-Client mit Discovery-Cache, Authorization-Code + PKCE S256, State/Nonce, JWKS-/JWT-Prüfung mit jose, Claim-/Gruppenprüfung, RP-Logout-URL, Back-Channel-Logout-Prüfung, Ports und PostgreSQL-Repository.
- packages/identity/package.json und pnpm-lock.yaml: jose 6.1.3 (MIT), pg 8.23.1 (MIT) als Paketabhängigkeiten.
- migrations/0010_oidc_identity.sql: users.role_source (local|idp) und Identity-Index.
- tests/identity/oidc.test.ts: lokal signierte JWT-Fixtures für OIDC-Fluss, Identity-Zuordnung, PKCE-/State-/Nonce-/Signatur-Fehler, Gruppenmapping, Rollenwechsel und lokale Sperren.

Zusammenfassung
Die Bibliothek bindet eine Providerkonfiguration an ihren HTTPS-Issuer, verweigert untrusted Discovery-Endpunkte und verarbeitet keine Klartextsecrets; Secrets kommen ausschließlich über SecretResolver. Die stabile Zuordnung lautet issuer+subject. Gleiche E-Mail-Adressen werden nicht für Zuordnungen abgefragt. IdP-Rollen werden nur bei role_source=idp aktualisiert; status=blocked verhindert die Anmeldung vor dem Rollenwechsel.

Einbindung
1. OidcClient mit einem administrativ gebundenen HttpClient, SecretResolver und optionaler Clock instanziieren.
2. PostgresIdentityRepository mit dem API-Pool instanziieren.
3. Beim Anmeldestart begin(config) aufrufen und LoginTransaction serverseitig/browsergebunden maximal zehn Minuten speichern.
4. Beim Callback finish(config, transaction, { code, state }, repository) aufrufen; aus dem Ergebnis { userId, isNewUser, roles, idTokenHint } erzeugt die API ihre bestehende Sitzung.
5. Für Logout logoutUrl verwenden; Back-Channel-Logout mit validateBackchannelLogout prüfen und das Mapping/Sitzungswiderrufen in der API ausführen.
6. Migration 0010_oidc_identity.sql über den vorhandenen Runner anwenden.

Prüfung
- Vorher: corepack pnpm check: 16 Tests bestanden.
- Ausgeführt: corepack pnpm --filter @kura/identity typecheck: erfolgreich.
- Ausgeführt: corepack pnpm exec vitest run tests/identity/oidc.test.ts: 3 Tests bestanden.
- Ausgeführt: corepack pnpm audit --audit-level=high: 2 Befunde, 1 low und 1 moderate; keine High/Critical.
- Ausgeführt: corepack pnpm check: erfolgreich; 5 Testdateien und 19 Tests bestanden; Typecheck, Lint und alle Builds erfolgreich.
- Unbekannt: Verträge gegen konkrete Authentik- und Keycloak-Versionen; D-011 verbietet deren Testinstanzen.

Annahmen
- jose 6.1.3 ist als kleine JWT/JWKS-Bibliothek der geringere Angriffsflächenumfang gegenüber einem vollständigen OIDC-Client; Lizenz MIT. Pflegezustand über den lokalen Lockfile hinaus unbekannt.
- pg 8.23.1 ist MIT; sie wurde für den PostgreSQL-Repository-Adapter deklariert.
- Zeitbezug wird ausschließlich durch die injizierbare Clock bestimmt.

Risiken
- Die aktuelle JWKS-Prüfung delegiert Schlüsselrotation an jose RemoteJWKSet; ein separater Rotationstest fehlt.
- Die API-Einbindung, Sitzungswiderruf durch Back-Channel-Logout und die M1b-Lifecycle-Sperrsynchronisation liegen ausdrücklich außerhalb dieser Paket-Lane.
- Keine echten Authentik-/Keycloak-Instanzen getestet (D-011).
- Der Test-Fake ist ein lokaler HTTP-/Fetch-Adapter mit signierten JWT-Fixtures, nicht der in der Anforderung beschriebene vollständige Node-http-Autorisierungs- und Tokenanbieter. Die implementierten Protokollgrenzen sind damit nur teilweise testbar belegt.

Offene Fragen
- Keine.

Nächster Schritt
- Orchestrator bindet die Bibliothek über die dokumentierten Ports an die API-Sitzungslogik an; ein Folgeauftrag sollte den vollständigen Node-http-Fake-Anbieter mit Autorisierungs-, Token- und Schlüsselrotationspfad ergänzen.