# 08 – Umsetzung, Aufwand und Abnahme

## 1. Vorgehen

Zuerst wird die riskanteste Kette mit eigenen Testmedien bewiesen: Download → beide Speicherarten → Immich → Originalprüfung → lokale Entfernung → erhaltene History. Danach werden zusätzliche Webseiten auf denselben Kern aufgesetzt. So fällt eine Einschränkung der Immich-API oder der Lizenzvorgaben auf, bevor viele Adapter gebaut werden.

Dies ist ein Entwicklungsplan. Die folgenden Tests sind noch durchzuführen; die vorliegenden Markdown-Dateien sind keine erfolgreich getestete Anwendung.

## 2. Meilensteine

Aufwände sind grobe Schätzungen für eine erfahrene Vollzeitkraft bei Nutzung akzeptierter externer Downloader und vorhandener Immich-Testinstanz. Ein Personentag entspricht einem Arbeitstag. Plattformänderungen, Beschaffung von Testkonten, formelle Rechtsprüfung und langfristige Wartung sind nicht eingepreist.

| Meilenstein | Arbeitspakete | Abhängigkeit | Schätzung | Abnahmetor |
| --- | --- | --- | --- | --- |
| M0 – Machbarkeit | Quellen/Lastprofil/Lizenzen; Versionen pinnen; Immich-Originalprüfung; OIDC-Providerfähigkeiten und MFA/Logout klären | Keine | 6–10 PT | Kritische Verträge und Betriebsprofile entschieden |
| M1 – Kern und Identität | Repository, CI, Schema; lokale Benutzer-IDs; OIDC/PKCE mit Authentik und Keycloak; Gruppen/Rollen; lokales Profil; Secrets und zuständige Kontomails | M0 | 12–18 PT | SSO sicher, keine E-Mail-Kontenübernahme; zwei Benutzer getrennt; lokaler Modus und Opt-in korrekt |
| M1b – Automatische Kontosperren | Generischer Lifecycle-Vertrag; SCIM; Authentik- und Keycloak-Statusconnector; Frischeprüfung, Reconciliation und Sperrrennen | M1 | 14–24 PT | Externe Sperre wirkt ohne Login, inklusive Ausfalltests und lokaler Sperrvorrangregel |
| M2 – Speicherung | Katalog, History, Template-/CAS-Dateisystem, DB-Chunks, Direct-HTTP, Fetch-/Ingest-Vertrag, Vorlagen, Quoten | M1 | 12–18 PT | Große Datei in allen Layouts; geprüfte Originalbytes und Copy-Referenzen |
| M3 – Immich | Verbindungen, Transfers, Prüfbelege, Wiederabgleich, Karenz, Cleanup-Intents, Referenzschutz | M2 | 10–16 PT | Gesamte kritische Kette einschließlich Crashfällen bestanden |
| M4 – Zeitpläne | Abonnements, Outbox/Queue, Leases, Retry, Cron, DST, Inkrementalität, Pausen und konfigurierbare Budgets/Fairness für 100 Benutzer | M2 | 10–16 PT | Keine doppelten logischen Termine; Wiederanlauf korrekt |
| M5 – Plattformen | Adapter-SDK; YouTube/Pixiv zuerst, danach Instagram einschließlich Reels, Patreon und Pornhub; HTML-Snapshots; Kontofehler | M0, M2, M4 | 12–22 PT | Jede freigegebene Fähigkeit besitzt dokumentierte Testfälle |
| M6 – Produkt und Pakete | UI mit SSO-Zuständigkeiten, Historysuche/Vorschauen, Exporte, native Dienste, Storage-Migration und Einrichtungsprofile | M1–M5 | 10–16 PT | Endabläufe und klare Rechteherkunft auf allen drei Betriebssystemen |
| M7 – Freigabe | Lokale/IdP-MFA, automatische Sperren, Proxy-Härtung, Lasttests bis 100 Benutzer, Crash/Restore, Provider-Migration, SBOM und Betriebsdokumentation | M1–M6 einschließlich M1b | 14–24 PT | Alle P0-Gates und 50 kritischen Tests erfüllt |

Summe: **100–164 PT**, mit 25 % Planungsreserve etwa **125–205 PT**, also ungefähr **25–41 Arbeitswochen** bei einer Vollzeitkraft. Nach M0 und M3 neu schätzen. Eine vollständig selbst entwickelte MIT-Extraktion für alle genannten Plattformen ist ein eigener, deutlich unsicherer Umfang und nicht in dieser Summe enthalten. Instagram Reels ist im Instagram-Paket enthalten; zusätzliche ähnliche Videoportale werden nach konkreter Auswahl separat geschätzt. Die gegenüber Version 2.0 zusätzlichen 18–32 PT enthalten verpflichtende Sperrsynchronisation, Admin-Budgets und erweiterte Last-/Abnahmetests.

Ein früher Prototyp nach M3 hat bereits Immich und beide Speicherarten, aber noch nicht die gesamte Plattformabdeckung, öffentliche Betriebsfreigabe oder alle Installationspakete. Er darf nicht als fertige Erfüllung aller Anforderungen bezeichnet werden.

## 3. Priorisierte Arbeitspakete

### P0 – Datenintegrität und Zugriff

- SSO-01: OIDC/PKCE, stabile Issuer-/Subject-Zuordnung, kein E-Mail-Autolinking.
- SSO-02: Rollenherkunft, Step-up, lokale Sperren und automatisches Offboarding.
- SSO-03: Pflicht-SCIM/Statusconnectoren, Frischegrenze, Reconciliation und kontrollierte Reaktivierung vor Produktivbetrieb.
- OWN-01: Eigentümerfilter und zusammengesetzte Fremdschlüssel auf allen fachlichen Objekten.
- SEC-01: Secret-Verschlüsselung, Schlüsselrotation, Logging-Redaction.
- STO-01: Gemeinsamer Storage-Vertrag mit Finalisierung und Leser-Leases.
- STO-02: DB-Chunking mit unsichtbarem Staging und begrenztem RAM.
- HIS-01: Dauerhafte History unabhängig von Nutzdaten und Queue-Aufbewahrung.
- IMM-01: Zielkonto-/Versionsprüfung und Original-Readback.
- IMM-02: Wiederabgleich bei unklarer Uploadantwort.
- DEL-01: Persistenter Cleanup-Intent, Generationen und Referenzschutz.
- NET-01: Durchgesetzte SSRF-/Egress-Grenze auch für externe Prozesse.
- OPS-01: Konsistentes Backup und verifizierter Restore.

### P1 – Vollständiger Nutzungsumfang

- AUTH-02: Lokale Einladungen/Reset/MFA oder IdP-Kontofunktionen; eindeutige Zuständigkeit und Sitzungsverwaltung.
- MAIL-01: SMTP, Opt-in/Digest, Widerruf vor Versand.
- JOB-01: Fällige Termine, DST-Regeln, Outbox, Retry und Fairness.
- SRC-01: Adaptermanifest, Fähigkeiten und versionierte Quelltests.
- PATH-01: Sichere Vorlagen, physische Dateisystemstruktur und Migration.
- UI-01: Sammlung, Transferdialog, differenzierte Statusanzeigen und History.
- PKG-01: Linux/systemd, Windows/WinSW und macOS/launchd.

### P2 – Nach stabiler Version

Zusätzliche Quellen, Objektstorage, zusätzliche Workerhosts, weitere Lifecycle-Anbieter, erweiterte Browserarchivierung, Reflink-Exporte und feinere Albumregeln. Diese Erweiterungen dürfen die erste Freigabe nicht verschieben, solange kein verbindliches Nutzerziel von ihnen abhängt.

## 4. Teststrategie

Tests folgen den tatsächlichen Risiken. Reine Getter/Setter und UI-Textänderungen benötigen keine künstlichen Testmengen. Entscheidend sind Speicherintegrität, Berechtigungen, Wiederanlauf und fremde Dienste.

| Ebene | Nachweis |
| --- | --- |
| Domänen-/Property-Tests | Pfadnormalisierung, Idempotenzschlüssel, erlaubte Zustandsübergänge und DST-Regeln |
| PostgreSQL-Integration | Transaktionen, Outbox, Referenzsperren, Unique-Constraints und Chunk-Streams |
| Adapter-Verträge | Bereinigte Fixtures für Pagination, Authfehler, Qualitätswahl und unvollständige Posts |
| Immich-Verträge | Echte ausgewählte Immich-Version plus Fehlerproxy; Upload/Dublette/Originalabruf/Kontoidentität |
| Identitätsverträge | Authentik und Keycloak: Code/PKCE, Claims, MFA-Policy, Sitzungsende, unbekannte Fähigkeiten und IdP-Ausfall |
| End-to-End | Zwei Benutzer; lokaler und OIDC-Modus; Download bis Cleanup in Template-/CAS-/DB-Speicher |
| Betriebssysteme | NTFS, Linux-Dateisystem und APFS; Dienste, Pfade, Prozessstopps und Rechte |
| Last und Ressourcen | 1/20/100 Konten, variierende Workerzahlen und Null-/Admin-Limits, faire Queue, API-/Lifecycle-Latenz, Temp/WAL und optionale Quoten |
| Restore | Wiederherstellung auf leerem Host mit deaktiviertem Cleanup und Hashprüfung |

Externe Plattformtests verwenden eigene oder ausdrücklich freigegebene Inhalte und berechtigte Testkonten. Credentials gelangen nicht in CI-Logs oder Fixtures. Kontrollierte Vertragsfixtures laufen bei jedem Build; wenige Live-Canaries laufen getrennt und unter Rate-Limits. Ausfall eines Live-Anbieters ist von einem reproduzierbaren Kernfehler zu unterscheiden.

## 5. Verbindliche kritische Testfälle

| ID | Fall | Erwartetes Ergebnis |
| --- | --- | --- |
| T01 | 20-GiB-Datei in Filesystem und DB speichern/lesen | SHA-256 und Größe stimmen; RAM wächst nicht mit Dateigröße |
| T02 | Teil-Download und Prozessabsturz | Teilobjekt unsichtbar; Resume/Neustart kontrolliert |
| T03 | Gleiche Quelle zweimal nach erfolgreichem Cleanup | Kein erneuter Download ohne expliziten Auftrag |
| T04 | Geänderte Quellrevision | Neue Version; frühere History unverändert |
| T05 | Immich speichert, Antwort wird verworfen | Abgleich statt falscher Löschung; kein unkontrollierter Uploadloop |
| T06 | Remote liefert kürzere oder veränderte Originalbytes | Prüfung scheitert; lokale Kopie bleibt |
| T07 | Remote liefert Thumbnail mit HTTP 200 | Kein Originalnachweis; lokale Kopie bleibt |
| T08 | DB-Commit des Prüfbelegs schlägt fehl | Cleanup startet nicht |
| T09 | Crash nach Dateilöschung vor Abschluss-Commit | Intent ermöglicht konsistente nachträgliche History |
| T10 | Crash während DB-Chunk-Löschung | Unvollständige Bereinigung wird fortgesetzt, History bleibt |
| T11 | Zwei Assets teilen dieselbe CAS-/DB-Kopie, eines will lokal behalten | Physische Kopie wird nicht entfernt |
| T12 | Neue Referenz/Leser/Migration konkurriert mit Cleanup | Gemeinsame Sperrregeln verhindern Race und Datenverlust |
| T13 | Zielkonto oder Verbindung ändert sich | Alte Belege/Freigaben gelten nicht weiter |
| T14 | Immich-Dublette aus externer Bibliothek auf Downloader-Pfad | Keine lokale Entfernung |
| T15 | Benutzer widerruft während Karenz | Quelle bleibt vorhanden |
| T16 | Gemischter Post: JPG, MP4, HTML, Ugoira-ZIP | Nur exakt geprüfte geeignete Medien löschbar |
| T17 | Sommer-/Winterzeit und Serverausfall | Definierte Skip-/Einmal-/Nachholregeln ohne Doppeljob |
| T18 | Zweiter Scheduler und alter Worker nach Leaseverlust | Ein logischer Lauf; veraltete Generation kann nicht committen |
| T19 | Benutzer A fragt Medien/Jobs/Exports von B ab | Kein Inhalt und keine fremden Ereignisse |
| T20 | DNS-Rebinding, Redirect auf Loopback, IPv6-Privatadresse | Netzwerkzugriff abgelehnt, auch durch CLI-Adapter |
| T21 | Pfadtraversal, Windows-ADS/Junction, Unicode-/Case-Kollision | Kein Schreiben außerhalb Root und kein Überschreiben |
| T22 | Passwort-Reset abgelaufen, wiederverwendet, von Linkscanner geöffnet | Nur gültiger bestätigter POST verbraucht Token genau einmal |
| T23 | Ergebnis-Mail vorgemerkt, Opt-in dann widerrufen | Keine Ergebnis-Mail; angeforderter Reset weiter möglich |
| T24 | SMTP nicht erreichbar | Download/Transfer bleiben korrekt; Mail separat wiederholbar |
| T25 | DB-/Temp-Volume voll während Schreiben | Kein falscher Abschluss; Quoten und Teilobjekte konsistent |
| T26 | Restore eines älteren Backups mit früherer Löschfreigabe | Cleanup bleibt aus, bis lokal/remote neu abgeglichen und freigegeben |
| T27 | Dateisystem→DB→Dateisystem migrieren, Unterbrechung in jeder Phase | Mindestens eine geprüfte Kopie; kein Metadatenverlust |
| T28 | Remote nach lokalem Cleanup verschwunden | History bleibt; Alarmstatus, kein stiller Lösch-/Downloadkreislauf |
| T29 | Erster erlaubter OIDC-Login, danach erneuter Login | Gleiche lokale Benutzer-ID; kein lokaler Passwortdatensatz |
| T30 | Gleiche E-Mail bei anderem Subject/Issuer | Keine Kontenverschmelzung und kein fremder Medienzugriff |
| T31 | Passwort-Reset für SSO-Konto | Neutraler App-Endpunkt; Reset beim IdP; kein Passwort-Fallback |
| T32 | Falscher State/Nonce/PKCE/Issuer/Audience, abgelaufener oder wiederholter Code | Keine Sitzung; sicherer Fehler ohne Tokenleck |
| T33 | Fehlende Gruppe, falscher Claimtyp, Rollenentzug | Keine unzulässige Standardrolle; neue Anmeldung/Step-up bewertet neu |
| T34 | Lokale Sperre während geplantem Job oder Karenz | Sessions widerrufen, neue Jobs gestoppt, alte Cleanup-Generation ungültig |
| T35 | Echtes/gefälschtes/wiederholtes Back-Channel-Logout | Nur gültiges Token wirkt, Wiederholung idempotent; kein Kontolöschen |
| T36 | IdP ausgefallen | Kein automatischer lokaler Login; Sitzungslimits und Step-up-Regeln greifen |
| T37 | Kontrollierter Wechsel von lokal zu SSO bzw. anderem IdP | Eigentümer-ID/History erhalten; E-Mail allein genügt nicht |
| T38 | JWKS-Rotation oder unbekannter Signaturschlüssel | Kontrolliertes Nachladen; keine ungeprüfte Tokenannahme |
| T39 | Adminaktion ohne frische Authentifizierung/MFA-Nachweis | Step-up bzw. Ablehnung gemäß getestetem Providerprofil |
| T40 | Manipulierte Discovery-/Logout-/Rücksprung-URL | Kein SSRF, offener Redirect oder untrusted Key-Download |
| T41 | Gleiche Bytes an zwei Template-Pfaden und in geteilter CAS-Kopie | Genau freigegebene Kopie entfernt; übrige Referenzen und Pfade bleiben korrekt |
| T42 | Konto im IdP deaktivieren, Browser und Jobs bleiben offen | Automatische App-Sperre ohne erneuten Login; Status/Jobs/Cleanup innerhalb der Fristen aus 11 blockiert |
| T43 | SCIM-Ereignis verlieren; Polling bei hoher Downloadlast | Autoritativer Abgleich erkennt Sperre; End-to-End-Zeitbudget eingehalten |
| T44 | Status-API ausgefallen, Token ungültig oder Pagination unvollständig | Keine erneuerte Frische; nach spätestens 120 s effektive Sperre und kontrollierter Job-Stopp |
| T45 | Verspätetes active=true, alte Pollantwort, lokale Sperre und externe Reaktivierung | Alte Antwort hebt Sperre nicht auf; lokale Sperre bleibt; keine Wiederverwendung alter Cleanup-Freigaben |
| T46 | Falsche SCIM-/OIDC-Korrelation oder fremdes Provisionierungs-Credential | Keine Verknüpfung/Übernahme fremder Konten; nur freigegebene Identity-Operationen |
| T47 | 100 Konten, beliebige gültige Admin-Limits, null-Budgets und Änderung unter Last | Keine hardcodierte Downloadquote; faire Vermittlung, begrenzte Ressourcen und korrekte Policy-Revisionen |
| T48 | Direkter Backendzugriff, gefälschte Proxyheader und geschützte Maschinen-Callbacks | Backend abgeschirmt; öffentliche URLs korrekt; SCIM/OIDC erreichbar und unabhängig authentifiziert |
| T49 | Neueste stabile Immich-Zielversion und späterer Versionswechsel | Vertragstests dokumentiert; unbekannte Version blockiert Cleanup bis erneuter Freigabe |
| T50 | Vollständiger Restore bei repräsentativer Datenmenge und IdP-Status unbekannt | RPO ≤ 24 h, RTO ≤ 8 h nachgewiesen; keine Jobs/Cleanup vor vorgeschriebenen Neuprüfungen |

## 6. Freigabekriterien

1. Alle verbindlichen Anforderungen F01–F26 sind einem nachgewiesenen Test oder einer dokumentierten Prüfung zugeordnet.
2. T01–T50 bestehen für die betroffenen Komponenten; P0-Fehler verhindern Freigabe.
3. Jede beworbene Plattformfähigkeit ist mit Version, Datum, Kontotyp und Testumfang dokumentiert. Ungeklärte Quellen werden nicht als unterstützt angezeigt.
4. Der öffentliche Betrieb besitzt TLS, Admin-MFA, geschlossene Registrierung und getesteten Netzwerk-/Rechteschutz.
5. Beide Speichermodi einschließlich beider Dateisystemlayouts, alle drei nativen Dienstinstallationen und die zum Freigabetest neueste stabile Immich-Zielversion sind freigegeben. OIDC- und Lifecycle-Verträge bestehen gegen konkrete Authentik- und Keycloak-Versionen; zusätzliche Fähigkeiten sind separat gekennzeichnet.
6. Backup plus getrennte Schlüsselwiederherstellung wurden auf einem leeren System durchgeführt.
7. SBOM, Third-Party-Notices und Lizenzentscheidungen passen zu den tatsächlich ausgelieferten Binärdateien und Abhängigkeiten.
8. Keine offene kritische Sicherheitslücke und kein bekannter Pfad zum automatischen Löschen der einzigen ungeprüften Originalkopie.

## 7. Übergabe an die Entwicklung

### Anforderungszuordnung

| Anforderungen | Umsetzungsort | Abnahmenachweis |
| --- | --- | --- |
| F01 Web und Dienst | M1, M6 | UI-Endablauf; Browser schließen, Job läuft weiter |
| F02 Drei Betriebssysteme | M6, M7 | Native Installation, Reboot und Wiederanlauf auf Linux/Windows/macOS |
| F03 Adapter | M5 | Adaptervertrag mit zweitem Anbieter ohne Speicheränderung |
| F04 Inhaltsarten | M2, M5 | T16 und eigene Bild-/Video-/Seiten-/Anhang-Fixtures |
| F05 Qualität | M2, M5 | T01, T06, T07; gewählte Quellvariante und fehlende Neukodierung prüfen |
| F06 Beide Speicherarten | M2 | T01, T02, T10, T25, T27 |
| F07 Struktur | M2, M6 | Vorlagen-/Exportvorschau; T21 und T27 |
| F08 Planung | M4 | T17 und T18 |
| F09 Benutzer | M1, M7 | T19, T22 und T29–T40; lokale/IdP-Zuständigkeit |
| F10 SMTP | M1 | T24 und SMTP-TLS-/Verbindungstest |
| F11 Wahlrecht | M1 | T23 |
| F12 Immich | M3, M7 | T05, T13, T14, T16, T49; erfolgreicher Originaltransfer |
| F13 Lokales Entfernen | M3 | T06–T16 und T26 |
| F14 History | M2, M3 | T03, T04, T09, T10, T28 |
| F15 Dubletten | M2, M4 | T03, T05 und T11 |
| F16 Wiederaufnahme | M2–M4 | T02, T05, T09, T10 und T18 |
| F17 Internet-Sicherheit | M1, M7 | T19–T22 und T48; Maßnahmenmatrix aus 06 und öffentliche Betriebsprüfung |
| F18 Lizenzen | M0, M7 | SBOM-/Artefakt-/Notices-Prüfung aus 09 |
| F19 Externes SSO | M0, M1 | T29, T32, T35, T36, T38 und zwei Anbieter-Vertragstests |
| F20 Stabile Identitäten | M1 | T30, T37 |
| F21 Rollen/Offboarding | M1, M1b, M7 | T33, T34, T39 und T42–T46 |
| F22 Kontomails | M1, M6 | T23, T31; getrennte SMTP-Zuständigkeit |
| F23 Dateisystemlayouts | M2, M6 | T01, T11, T27, T41 |
| F24 Bis 100 Benutzer | M4, M7 | T47; dokumentierter Lastbericht mit Ressourcen und API-p95 |
| F25 Admin-Limits | M4, M6 | T47; Config-/API-Validierung, Revision und laufende Änderungen |
| F26 Wiederherstellung | M7 | T50; RPO-/RTO-Protokoll auf Zielhardware |

### Repository

Repositoryvorschlag: `apps/web`, `apps/api`, `apps/worker`, `packages/domain`, `packages/storage`, `packages/adapters`, `packages/immich-client`, `packages/contracts`, `packages/identity`, `migrations`, `tests/fixtures`, `deploy` und `docs`. Entscheidungen aus diesen Plänen werden als kurze Architecture Decision Records versioniert. Ein Adapter-Release kann häufiger erscheinen als ein Kern-Release, benötigt aber denselben Verträglichkeits- und Lizenzprozess.


## 8. Verbindliche Identitätssynchronisation

M1b ist nach Nutzerentscheidung kein optionaler Ausbau mehr. Der Umfang enthält generischen Lifecycle-Vertrag, SCIM-Teilprofil, Authentik- und Keycloak-Statusconnectoren, Sperrlatenz, Statusfrische, erneute Synchronisation, Rechteabgrenzung und Ausfalltests. Seine 14–24 PT sind bereits in der Gesamtsumme enthalten.

Die erste Freigabe darf nicht mit manuellem Offboarding oder Prüfung erst beim nächsten Login abgenommen werden. Zusätzliche Provider nutzen denselben OIDC-/Lifecycle-Kern, benötigen jedoch eigene Verträge für ihre Statusquelle. Installationen ohne externen IdP dürfen das ausdrücklich lokale Profil verwenden.

Bei der Lastabnahme werden Hardware, Datenmenge, aktive Sitzungen, Queuevolumen, Workerzahlen und Limits festgehalten. Ein Test mit 100 angelegten, aber inaktiven Konten allein erfüllt F24 nicht. Mindestens ein Szenario nutzt 100 aktive simulierte Benutzer für paginierte Katalog-/History-Aufrufe und parallel vermittelte Jobs; erwartete Raten werden in M0 vereinbart. Die p95-API-Zielzeit aus 01 und Sperrfristen gelten unter dem vereinbarten Lastprofil.

