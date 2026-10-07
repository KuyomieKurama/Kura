Aufgabe
W3 Befunde aus V1 beheben (Log-Redaktion, Immich-Zielprüfung, Base64) – Neuanlauf. Kanban t_5eb6cd39, REQ-DL-003 (Hash b83be904af3eded5), REQ-DL-002 (Hash 5d6398de6dbb5063). Worktree /work/wt/wiring, Branch wiring/m3, Ausgangs-HEAD 9461b34.

Status
braucht Review

Artefakte
Commits (alle auf wiring/m3, nicht gepusht):
- 4b4f3f0 fix: validate test-transfer base64 strictly (Befund 3)
- c866bb4 fix: keep OIDC code and state out of request logs (Befund 1)
- 841c91e feat: add address-verifying fetch for Immich connections (Befund 2, Baustein)
- aeb9563 fix: block private and metadata Immich targets unless an admin approved them (Befund 2, API/Migration)
- c1bfad2 feat: add admin control for approving private Immich endpoints (Befund 2, Weboberfläche)
- dieser Bericht (eigener Commit)

Geänderte Dateien
Befund 3:
- apps/api/src/base64.ts (neu): decodeStrictBase64 – kanonisches, gepolstertes Base64, Round-Trip-Prüfung, Länge > 0, Obergrenze 4 MiB auf der dekodierten Länge. Der Regex ist bewusst linear (eine Gruppen-Variante lief bei 5 MB in "Maximum call stack size exceeded").
- apps/api/src/immich-routes.ts: Route test-transfer nutzt die Funktion.
- tests/wiring/immich-base64.test.ts (neu): 16 Tests (gültig, 10 ungültige Eingaben, leer/"====", Größengrenze, API: ungültig -> 400 und nichts im Blobstore, gültig -> weiter bis 404 "keine Verbindung").
Befund 1:
- apps/api/src/logging.ts (neu): Request-Serializer protokolliert nur Methode, Pfad ohne Query/Fragment, Host, Adresse; Response nur Statuscode.
- apps/api/src/app.ts: logger: loggerOptions(dependencies.logStream); neue optionale Abhängigkeit logStream (Test-Naht).
- tests/api-oidc/oidc.test.ts: fixture() um logStream und loginSecrets() erweitert; neuer Test "never writes the authorization code, state, nonce, tokens or secrets to the request log" (vollständiger OIDC-Login plus fehlgeschlagener Callback; prüft code, state, nonce, ID-Token, Session-Cookie, Transaktions-Cookie, Client-Secret, code_challenge, abgelehnte code/state-Werte; Log muss den Callback-Pfad enthalten).
Befund 2:
- packages/immich-client/src/network-guard.ts (neu, freigegeben durch Orchestrator-Zusatz): classifyAddress, normalizeEndpoint, endpointOf, ImmichTargetBlockedError, EndpointApprovals, createGuardedFetch. Host wird einmal aufgelöst, jede aufgelöste Adresse geprüft, Socket wird genau zu der geprüften Adresse geöffnet (lookup-Option); Redirects werden nicht verfolgt (3xx wird zurückgegeben, der Client wirft bei !ok); keine Verbindungswiederverwendung (agent:false), jede Anfrage prüft die aktuelle Freigabe neu.
- packages/immich-client/src/index.ts: eine Zeile, die network-guard.js re-exportiert. ImmichClient selbst ist unverändert (nutzt den bestehenden injizierbaren fetcher-Parameter).
- migrations/0033_immich_endpoint_approvals.sql (neu): Tabelle immich_endpoint_approvals (host, port, approved_by, approved_at; PK host+port).
- apps/api/src/immich-endpoint-approvals.ts (neu): PostgresEndpointApprovals.
- apps/api/src/immich-routes.ts: Client wird mit dem geschützten fetch erzeugt; isSafeImmichUrl lehnt jetzt zusätzlich URLs mit Zugangsdaten und Literal-IPs in gesperrten Bereichen ab; Verbindungstest liefert bei Sperre error/target (nur dann); test-transfer prüft die Verbindung vor dem Schreiben in den Blobstore und antwortet bei Sperre 403; neue Admin-Routen GET/POST /api/v1/admin/immich/endpoint-approvals und DELETE /api/v1/admin/immich/endpoint-approvals/:host/:port (nur Administrator, mit Audit); ImmichSession enthält jetzt role.
- apps/api/src/app.ts: optionale Abhängigkeit resolveImmichHost (Test-Naht für DNS) und Weitergabe an die Routen.
- apps/web/src/App.tsx, api.ts: Admin-Kontrolle auf der Immich-Seite (Liste, Freigeben, Entziehen); Verbindungstest zeigt die Sperrmeldung samt Host:Port.
- tests/immich/network-guard.test.ts (neu, 42 Tests), tests/wiring/immich-target-policy.test.ts (neu, 6 Tests), apps/web/src/App.test.tsx (+2 Tests).
- Angepasste bestehende Tests: tests/wiring/immich-transfer.test.ts (Fake-Immich auf 127.0.0.1 wird vorher vom Admin freigegeben), tests/wiring/immich-wiring.test.ts (toEqual -> toMatchObject, weil die Antwort bei gesperrtem Loopback-Ziel zusätzliche Felder enthält).
- Nicht geändert: root package.json, Lockfile, tsconfig*, .github, docs/planning, docs/requirements, CLAUDE.md, .claude/team/*.md, bestehende Migrationen, .env.example. Keine neuen Abhängigkeiten (Guard nutzt node:http/https/dns/net/stream).

Zusammenfassung
Befund 3 (MEDIUM): Ungültiges oder leer dekodierendes Base64 wird mit 400 abgelehnt, bevor etwas im Blobstore landet; die 4-MiB-Grenze bleibt.
Befund 1 (CRITICAL): Fastify protokolliert keine Query-Strings mehr. Entschieden wurde "nur Pfad für alle Anfragen" statt einer Parameter-Allowlist, weil das nicht an Parameternamen hängt (code/state/token/secret/andere).
Befund 2 (HIGH): Standard ist gesperrt für Loopback, RFC1918, CGNAT (100.64/10) und ULA (fc00::/7); diese Ziele gehen nur nach Admin-Freigabe exakt dieses Host+Port-Paars. Immer gesperrt (auch freigegeben): 169.254/16 inkl. 169.254.169.254, fe80::/10, fd00:ec2::254, 100.100.100.200, 0.0.0.0/8, Multicast, Reserved/Broadcast, NAT64/6to4/Teredo, IPv4-mapped IPv6 wird auf IPv4 zurückgeführt. Gilt für Verbindungstest und Transfer (alle Requests des ImmichClient). Admin-Freigaben liegen in der DB (Migration 0033); Nicht-Admins erhalten 403.

Prüfung
Ausgeführt (export DATABASE_URL=postgres://kura_dev:***@127.0.0.1:5432/kura_dev):
- Vorher (Ausgangs-HEAD 9461b34): corepack pnpm check -> Test Files 10 passed (10); Tests 45 passed | 1 skipped (46).
- Nach Befund 3: Tests 61 passed | 1 skipped (62). Nach Befund 1: 62 | 1 (63). Nach Guard: 104 | 1 (105). Nach API/Migration: 110 | 1 (111).
- Nachher (Endstand): corepack pnpm check -> eslint ohne Warnungen; Test Files 13 passed (13); Tests 110 passed | 1 skipped (111); danach pnpm -r build erfolgreich (api, web, worker, alle Pakete).
- Web-Tests laufen laut vitest.config.mts nicht im Root-Gate: corepack pnpm --filter @kura/web test -> vorher Test Files 2 passed (2), Tests 12 passed (12); nachher Test Files 2 passed (2), Tests 14 passed (14).
- Test scheitert ohne Fix (jeweils ausgeführt):
  - Befund 3: Quelländerung in immich-routes.ts zurückgestellt -> "rejects non-empty invalid base64 and base64 that decodes to zero bytes, and stores nothing" schlägt fehl (1 failed, 15 passed; die 15 anderen testen die neue Funktion).
  - Befund 1: Logger auf `{ stream }` ohne Serializer -> "never writes the authorization code, state, nonce, tokens or secrets to the request log" schlägt fehl ("code leaked into the log").
  - Befund 2: app.ts/immich-routes.ts zurückgestellt -> alle 6 Tests in immich-target-policy.test.ts schlagen fehl (6 failed). Hinweis: Ein Teil dieser Fehlschläge folgt schon daraus, dass die Admin-Endpunkte fehlen; das Verhalten "Standard gesperrt" und "Redirect nicht verfolgt" ist zusätzlich in tests/immich/network-guard.test.ts auf Ebene des Guards belegt (Listener-Zähler = 0).
- Abgedeckt für Befund 2: gesperrt per Default; erlaubt nach Admin-Freigabe (und nur für genau diesen Port); Entzug sperrt wieder; Nicht-Admin kann weder freigeben, listen noch entziehen; Metadaten/Link-Local (inkl. IPv4-mapped, Hostname der auf Metadaten auflöst, gemischte Antworten) immer gesperrt, auch bei Freigabe; Freigabe von Link-Local/Metadaten wird mit 400 abgelehnt; DNS-Rebinding: genau eine Auflösung pro Anfrage, Verbindung zur geprüften Adresse, zweite (umgebogene) Antwort wird bei der nächsten Anfrage gesperrt; Redirect auf private/Metadaten-Adresse wird nicht verfolgt (Zielserver erhält 0 Treffer).

Nicht geprüft
- Auflösung über den echten System-Resolver (dns.lookup) – Tests injizieren resolveHost; der Standardpfad ist nur gelesen/typgeprüft, nicht gegen echtes DNS gelaufen. Unbekannt.
- HTTPS-Pfad des Guards (https.request mit lookup, SNI/Zertifikatsprüfung) – nicht getestet, nur Typprüfung; Verhalten gegen ein echtes TLS-Ziel unbekannt.
- pnpm audit und Lasttests nicht ausgeführt. Kein Test gegen eine echte Immich-Instanz (R-05/R-12 bleiben offen).

Annahmen
- "Nur Pfad loggen" für alle Anfragen ist akzeptiert (kein Parametername-spezifisches Schwärzen).
- CGNAT (100.64.0.0/10) zählt als "Freigabe nötig", nicht als dauerhaft gesperrt (Tailscale-Setups); 100.100.100.200 (Alibaba-Metadaten) ist davon ausgenommen und immer gesperrt.
- Freigabe gilt für den Host-String (bei Hostnamen) bzw. die Literal-IP plus Port; wird ein freigegebener Hostname später auf eine andere nicht gesperrte private Adresse umgebogen, bleibt die Verbindung erlaubt (die Freigabe bezieht sich auf host+port, nicht auf die Adresse). Immer gesperrte Adressen bleiben davon unberührt.
- Der Entzug einer Freigabe (DELETE) ist ein minimaler Bestandteil der Allowlist-Verwaltung, kein Zusatzfeature im Sinne von D-019; er lässt sich ohne Wirkung auf den Rest entfernen.
- Bestehende gespeicherte Verbindungen auf private Ziele sind nach dem Update gesperrt, bis ein Administrator freigibt (gewolltes Verhalten laut Plan 05 §2).
- Speichern einer Verbindung validiert nur Syntax, Zugangsdaten und Literal-IPs; die maßgebliche Prüfung geschieht bei jeder Verbindung nach der Auflösung.
- Plan 05 §2 sagt, die Ausnahme für private Netze gelte nicht für Download-URLs: Der geschützte fetch wird nur vom ImmichClient benutzt, Download-URLs sind davon nicht berührt.

Risiken
- Der Standard-ImmichClient (ohne fetcher-Parameter) nutzt weiterhin das globale fetch ohne Prüfung; die API übergibt den geschützten fetch immer. Ein künftiger Worker muss denselben fetch verwenden (kein weiterer Aufrufer im Repo außer Tests, geprüft per grep).
- Rückgabe von 3xx statt Verfolgen: ein Immich hinter einem Redirect (z. B. http->https) schlägt jetzt mit "Immich request failed (30x)" fehl; die Server-URL muss direkt stimmen.
- Der Guard setzt keine eigenen Timeouts (wie vorher bei fetch); ein Blackhole-Ziel hängt bis zum OS-Timeout.
- Fastify-Standard bodyLimit (1 MiB, laut Fastify-Dokumentation, nicht im Repo gesetzt) begrenzt das Base64-JSON faktisch unterhalb der 4-MiB-Grenze; nicht im Umfang dieser Aufgabe, nur beobachtet; nicht per Test verifiziert.
- Rückweg: git revert c1bfad2 aeb9563 841c91e c866bb4 4b4f3f0 (in dieser Reihenfolge). Migration 0033 legt nur eine neue Tabelle an; ein Zurücknehmen der Commits löscht sie nicht (DROP TABLE immich_endpoint_approvals nur manuell nach Ankündigung).

Offene Fragen
- Soll die Freigabe zusätzlich an die aufgelöste Adresse gebunden werden (strenger, aber DHCP-/DNS-Wechsel führen dann zu erneuter Freigabe)? Aktuell nicht.
- Soll der Standard-ImmichClient künftig keinen ungeschützten Fallback mehr haben? Das wäre eine Änderung am Paket-Vertrag (Orchestrator-Entscheidung).

Nächster Schritt
Review und Verifier-Lauf der drei Befunde; danach entscheidet der Orchestrator über Merge und die offenen Fragen.
