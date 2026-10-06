Aufgabe
M1-B OIDC-Anmeldung als Bibliothek in packages/identity für REQ-DL-003, Hash b83be904af3eded5.

Status
blockiert

Artefakte
- packages/identity/src/index.ts: OIDC-Client mit Discovery-Cache, Authorization-Code + PKCE S256, State/Nonce, JWKS-/JWT-Prüfung mit jose, Claim-/Gruppenprüfung, RP-Logout-URL, Back-Channel-Logout-Prüfung, Ports und Postgres-Repository.
- packages/identity/package.json und pnpm-lock.yaml: jose 6.1.3 (MIT), pg 8.23.1 (MIT) als Paketabhängigkeiten.
- migrations/0010_oidc_identity.sql: users.role_source (local|idp) und Identity-Index.
- tests/identity/oidc.test.ts: signierte lokale JWT-Fixtures mit Fehlerfällen und Zuordnungs-/Rollenfällen.

Zusammenfassung
Die Bibliothek bindet eine Providerkonfiguration an ihren HTTPS-Issuer, verweigert untrusted Discovery-Endpunkte und verarbeitet keine Klartextsecrets; Secrets kommen ausschließlich über SecretResolver. Die stabile Zuordnung lautet issuer+subject. Gleiche E-Mail-Adressen werden nicht für Zuordnungen abgefragt. IdP-Rollen werden nur bei role_source=idp aktualisiert; status=blocked verhindert die Anmeldung vor dem Rollenwechsel.

Einbindung
1. OidcClient mit einem administrativ gebundenen HttpClient, SecretResolver und optionaler Clock instanziieren.
2. PostgresIdentityRepository mit dem API-Pool instanziieren.
3. Beim Anmeldestart begin(config) aufrufen und LoginTransaction serverseitig/browsergebunden maximal zehn Minuten speichern.
4. Beim Callback finish(config, transaction, { code, state }, repository) aufrufen; aus dem Ergebnis { userId, isNewUser, roles, idTokenHint } erzeugt die API ihre bestehende Sitzung.
5. Für Logout logoutUrl verwenden; Back-Channel-Logout mit validateBackchannelLogout prüfen und das Mapping/Sitzungswiderrufen in der API ausführen.
6. Migration 0010_oidc_identity.sql über den vorhandenen Runner anwenden. Der Orchestrator muss die Erwartungswerte der fremden Migration-/Status-Tests auf vier Migrationen aktualisieren, weil diese Lane laut Dateihoheit tests/integration/** und apps/** nicht ändern darf.

Prüfung
- Vorher: corepack pnpm check: 16 Tests bestanden.
- Ausgeführt: corepack pnpm --filter @kura/identity typecheck: erfolgreich.
- Ausgeführt: corepack pnpm exec vitest run tests/identity/oidc.test.ts: 3 Tests bestanden.
- Ausgeführt: corepack pnpm audit --audit-level=high: 2 Befunde, 1 low und 1 moderate; keine High/Critical.
- Ausgeführt: corepack pnpm check: fehlgeschlagen, 3 fehlgeschlagene bestehende Fremdtests. tests/integration/migrations.test.ts erwartet weiterhin exakt 0001–0003; tests/integration/status.test.ts erwartet weiterhin drei Migrationen. Tatsächlich ist 0010_oidc_identity korrekt angewendet.
- Unbekannt: Verträge gegen konkrete Authentik- und Keycloak-Versionen; D-011 verbietet deren Testinstanzen.
- Unbekannt: geforderter Node-http-Fake-Anbieter und vollständige Fehlermodi (abgelaufen, Audience, Schlüsselrotation) sind nicht vollständig umgesetzt.

Annahmen
- jose 6.1.3 ist als kleine JWT/JWKS-Bibliothek der geringere Angriffsflächenumfang gegenüber einem vollständigen OIDC-Client; Lizenz MIT. Pflegezustand über den lokalen Lockfile hinaus unbekannt.
- pg 8.23.1 ist MIT; sie wurde für den PostgreSQL-Repository-Adapter deklariert.
- Zeitbezug wird ausschließlich durch die injizierbare Clock bestimmt.

Risiken
- Die aktuelle JWKS-Prüfung delegiert Schlüsselrotation an jose RemoteJWKSet; ein separater Rotationstest fehlt.
- Die API-Einbindung, Sitzungswiderruf durch Back-Channel-Logout und die M1b-Lifecycle-Sperrsynchronisation liegen ausdrücklich außerhalb dieser Paket-Lane.
- Keine echten Authentik-/Keycloak-Instanzen getestet (D-011).

Offene Fragen
- Der Orchestrator muss entscheiden, ob die zwei erlaubten Fremdtest-Anpassungen selbst erfolgen oder diese Lane dafür eine explizite Ausnahme von der Dateihoheit erhält. Ohne diese Änderung kann corepack pnpm check wegen der korrekten neuen Migration nicht grün sein.

Nächster Schritt
Explizite Dateihoheits-Ausnahme oder Orchestrator-Änderung für tests/integration/migrations.test.ts und tests/integration/status.test.ts; anschließend fehlende Node-http-Fake-/Rotations-/Datenbanktests ergänzen und erneut vollständig prüfen.
