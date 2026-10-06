# 06 – Sicherheit, Benutzerverwaltung und SMTP

## 1. Schutzziele und Vertrauensgrenzen

Zu schützen sind Benutzerkonten, fremde Medien, Quellcookies, Immich-API-Keys, OIDC-Client-Secrets, SMTP-Geheimnisse, Serverdateien und die Integrität von History und Löschfreigaben. Angreifer können sowohl unangemeldet als auch angemeldete Benutzer sein. Webseiten, Medienmetadaten, Dateinamen, Redirects und Downloader-Ausgaben gelten als nicht vertrauenswürdig.

Wichtigste Grenzen: Browser → API; API → Datenbank; Worker → Adapterprozess; Adapter → Internet; Transfer-Worker → freigegebene Immich-Instanz. Öffentliche Quellen dürfen nicht die Berechtigungen interner Dienste erben.

## 2. Maßnahmen und Nachweise

| Risiko | Verbindliche Maßnahme | Nachweis vor Freigabe |
| --- | --- | --- |
| Fremde Assets über erratene ID | Eigentümerprüfung für jede Objektoperation und Medienausgabe | Benutzer A kann IDs von B weder lesen noch bearbeiten |
| SSRF ins Heim-/Servernetz | Zentrale Netzwerkpolicy und eingeschränkter Adapter-Egress | IPv4/IPv6, Redirect, DNS-Wechsel und Metadatenadressen getestet |
| Path Traversal | Eingeschränkte Vorlagen, Root-Prüfung und sichere Dateioperationen | `..`, UNC, Junctions, Symlinks und Kollisionen getestet |
| Command Injection | Argumentlisten ohne Shell; keine freien CLI-Optionen | Metazeichen und mit `-` beginnende Eingaben bleiben Daten |
| XSS über archivierte Seiten/Titel | Escaping, isolierte Vorschau, keine aktiven Inhalte auf App-Origin | Bösartige HTML-/SVG-Metadaten führen keinen Code aus |
| SQL Injection | Parameterisierte Abfragen; keine frei wählbaren SQL-Fragmente | Filter, Sortierung und IDs validiert |
| CSRF / Sessiondiebstahl | Sichere Cookies, CSRF-Schutz und Origin-Prüfung | Cross-Origin-Schreibversuche werden verworfen |
| Geheimnisabfluss | Verschlüsselter Secret-Speicher, Redaction, minimale Prozessrechte | Logs, Fehlerantworten und Exporte enthalten keine Testsecrets |
| Ressourcenerschöpfung | Quoten, Streamlimits, Zeitouts, Decoder-/Archivlimits | Überlange Streams und komprimierte Bomben werden beendet |
| Falsche Bereinigung | Generationen, Referenzprüfung und Integritätsbeleg | Fehler- und Konkurrenztests aus 05/08 bestehen |

## 3. Netzwerkregeln für Downloads

An OWASP orientierte Grundregeln: Nur benötigte Protokolle erlauben, Zieladressen prüfen, Redirects kontrollieren und Netzwerkzugriff zusätzlich außerhalb der URL-Validierung beschränken. Quelle: [OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).

Konkrete Projektpolicy:

1. Standardmäßig HTTPS; HTTP nur als explizite Admin-Ausnahme für einen geprüften Adapter. `file:`, `ftp:`, `gopher:`, `data:` und benutzerdefinierte Protokolle sind keine Downloadziele.
2. URL parserbasiert normalisieren; Userinfo, unerwartete Ports und uneindeutige Hostdarstellungen ablehnen.
3. Loopback, private, Link-Local-, Multicast-, reservierte und Cloud-Metadatenbereiche sperren; IPv4, IPv6 und eingebettete IPv4 berücksichtigen.
4. DNS-Ergebnis und tatsächlich verbundene IP prüfen; DNS-Rebinding darf einen zuvor geprüften Host nicht ins interne Netz umleiten.
5. Jeden Redirect neu validieren. Cookies und Authorization nicht pauschal auf einen anderen Host übertragen.
6. Plattform- und CDN-Ziele als gepflegte Adapterpolicy führen. Externe Prozesse müssen denselben Schutz durch Firewall/Sandbox oder kontrollierten Egress erhalten.
7. HTML-Ressourcen, HLS-Segmente, Untertitel und eingebettete URLs sind ebenso Downloads und unterliegen denselben Regeln.

Immich, SMTP und OIDC-Endpunkte bekommen separate administrativ freigegebene Ziele einschließlich Port und TLS-Policy. OIDC-Discovery ist kein durch Benutzer frei wählbarer URL-Abruf; Issuer und daraus geladene Endpunkte werden geprüft und an die Providerkonfiguration gebunden. Ein Benutzer darf daraus keinen allgemeinen internen HTTP-Proxy machen. Die zugehörigen Worker dürfen nur die benötigten internen Endpunkte erreichen; Adapterprozesse erhalten keine entsprechende Freigabe.

## 4. Login, Sitzungen und Rollen

### Betriebsprofile

- `oidc`: Anmeldung und MFA beim eingerichteten Anbieter, Authentik als Referenz. Kein lokales Passwort und kein lokaler Passwort-Reset für externe Identitäten.
- `local`: Eigenständiger Betrieb mit lokaler Benutzerverwaltung und den folgenden Passwortregeln.
- `hybrid`: Nur für bewusst freigegebene lokale Konten oder Migration. Ein IdP-Ausfall schaltet diesen Modus niemals automatisch ein.

Der vollständige OIDC-Vertrag einschließlich Gruppen, Sitzungsende und Offboarding steht in [11_SSO_Authentik_und_OIDC.md](11_SSO_Authentik_und_OIDC.md). Für alle Profile bleibt die Rechteprüfung im Backend verbindlich. Externe Gruppen dürfen Rechte kontrolliert zuordnen; sie ersetzen keine Eigentümerprüfung und keine lokale Kontosperre.

### Gemeinsame und lokale Regeln


- Geschlossene Registrierung; initiale Adminanlage ausschließlich über lokal erzeugtes Einmalgeheimnis.
- Lokale Einladung und Adressänderung erfordern E-Mail-Bestätigung. Im OIDC-Modus werden nur explizit vertrauenswürdige Verifikationsclaims akzeptiert; sonst bestätigt die App ihre Benachrichtigungsadresse separat. Rollenänderung nie aus Profil-Payload übernehmen.
- Für lokale Passwörter: Argon2id, zunächst z. B. 64 MiB, 3 Iterationen, Parallelität 1; auf Zielhardware kalibrieren und parallele Hashvorgänge begrenzen. Mindestniveau nicht unter die aktuelle OWASP-Empfehlung senken. Quelle: [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
- Serverseitige, widerrufbare Sitzungen statt langlebiger Tokens im Browser-LocalStorage. Cookie `__Host-downloader_session` mit `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/` und ohne Domain-Attribut; Sessionwechsel nach Login und Rechteänderungen.
- CSRF-Token für schreibende Browseraufrufe; restriktive CORS- und Origin-Policy.
- Ratenbegrenzung pro Account und Netzwerkbereich bei Login, Reset und Einladung; keine dauerhafte Kontosperre allein durch fremde Fehlversuche.
- Admin-MFA ist Voraussetzung für öffentlichen Produktionsbetrieb. Im OIDC-Modus gilt eine getestete IdP-Policy; ein beliebiges Token ohne belastbaren MFA-Nachweis genügt nicht. Im lokalen Modus werden eine geeignete Bibliothek, TOTP/WebAuthn und gehashte Einmal-Recoverycodes vor M7 ausgewählt und geprüft; keine eigene Kryptografieimplementierung.
- Lokale Benutzersperre erhöht `authz_generation`, widerruft Sitzungen, stoppt neue Jobs und invalidiert ungestartete Cleanup-Aufträge. Laufende Jobs stoppen an sicheren Grenzen. IdP-Sperren werden verbindlich über den geprüften Lifecycle-Weg übernommen; normales Logout ist keine Kontosperre. Veralteter externer Status sperrt Zugriff und Arbeit automatisch gemäß 11, statt bis zum nächsten Login zu warten.
- Letzten aktiven Admin nicht versehentlich entfernen; lokal dokumentiertes, auditierbares Wiederherstellungsverfahren.

## 5. Passwort vergessen

**SSO-Benutzer:** Die Oberfläche verweist auf den fest hinterlegten Wiederherstellungsweg des Identity Providers. Der Downloader speichert oder ersetzt kein IdP-Passwort. Lokale Resetendpunkte antworten auch für externe Konten neutral und erzeugen dafür keinen lokalen Credential-Datensatz. **Nur für lokale Konten** gilt der folgende Ablauf.


OWASP-Grundlage: gleichförmige Antworten, sichere Zufallstokens, begrenzte Gültigkeit, Einmalverwendung und vertrauenswürdige Reset-URL. Quelle: [OWASP Forgot Password](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).

Geplanter Ablauf:

1. E-Mail entgegennehmen; immer dieselbe externe Antwort, ohne Kontoverfügbarkeit offenzulegen.
2. Für ein zulässiges Konto 32 kryptografisch zufällige Bytes erzeugen. In `auth_tokens` nur den Hash mit Zweck und 20 Minuten Ablaufzeit speichern.
3. Versandauftrag kurzlebig und verschlüsselt ablegen, damit SMTP asynchron arbeitet. Den Klartexttoken nicht in die normale Job-/History-Tabelle schreiben; nach Versand bzw. Ablauf den geschützten Payload entfernen.
4. Link ausschließlich aus der konfigurierten öffentlichen Basis-URL bilden, nicht aus ungeprüften Host-/Forwarded-Headern.
5. Reset-Seite ohne Drittanbieterressourcen und mit `Referrer-Policy: no-referrer`; Query-Parameter nicht loggen.
6. GET zeigt nur das Formular. Erst bestätigter POST setzt das Passwort und verbraucht den Token atomar. So lösen E-Mail-Linkscanner keinen Passwortwechsel aus.
7. Bestehende Sitzungen widerrufen und eine Sicherheitsbestätigung senden. Kein automatischer Login nach Reset; MFA wird nicht umgangen.

Bei SMTP-Ausfall darf der Admin kein Passwort im Klartext auslesen oder verschicken. Ein lokales, auditierbares Wiederherstellungswerkzeug bzw. erneute Einladung ist der Betriebsweg.

## 6. SMTP und E-Mail-Präferenzen

Admin-Einstellungen: Host, Port, TLS-Modus, Benutzername, Secret-Referenz, Absendername/-adresse und öffentliche App-URL. TLS mit Zertifikatsprüfung ist verbindlich: implizites TLS oder erzwungenes STARTTLS. Kein stiller Fallback auf Klartext und kein globales Abschalten der Zertifikatsprüfung. Verbindungstest nur an eine ausdrücklich ausgewählte verifizierte Admin-Adresse; kein beliebiger Mail-Relay-Endpunkt.

| E-Mail-Kategorie | Wahlrecht / Auslöser |
| --- | --- |
| Download abgeschlossen | Freiwillig, standardmäßig aus; einzeln oder als Digest |
| Download fehlgeschlagen / Konto abgelaufen | Freiwillig einstellbar; zusätzlich immer in der Weboberfläche sichtbar |
| Immich-Transfer / lokale Entfernung | Freiwillig einstellbar, mit neutralen Texten ohne Medienanhänge |
| Passwort-Reset | Lokal durch die App auf Anforderung; bei SSO durch den IdP, unabhängig von Ergebnis-E-Mail-Präferenzen |
| Einladung / Adressverifikation | Lokales Konto durch die App; IdP-Konto durch den IdP; eigene Benachrichtigungsadresse gegebenenfalls in der App prüfen |
| Sicherheitsänderung | Meldung durch das für die Änderung zuständige System; keine doppelte Passwort-/MFA-Verwaltung |

Präferenzen werden sowohl beim Erstellen als auch unmittelbar vor dem Versand eines Benachrichtigungsjobs geprüft. Ein bereits vorgemerkter Digest darf nach Abwahl nicht mehr gesendet werden. Adressänderungen dürfen alte Outbox-Einträge nicht unbesehen an die neue Adresse schicken. Empfänger und Vorlagen kommen aus serverseitigen Daten, keine freien Mail-Header aus Nutzereingaben.

Nodemailer ist für SMTP vorgesehen; die Projektlizenz ist MIT-0, nicht wörtlich MIT. Quelle: [Nodemailer License](https://nodemailer.com/license). Versand hat eigene Retries und Prioritäten; Reset-Mails dürfen nicht hinter tausenden Ergebnisbenachrichtigungen warten. SMTP kann nach unklarer Zustellantwort doppelte Mails verursachen; stabile Nachrichten-ID und Versandstatus reduzieren dies, garantieren aber keine genau-einmalige E-Mail-Zustellung.

## 7. Geheimnisse und Inhaltsausgabe

Secrets mit authentisierter Verschlüsselung, beispielsweise AES-256-GCM, verschlüsseln. Eindeutige Nonces, zugeordnete Benutzer-/Secret-ID als Additional Authenticated Data und versionierte Schlüssel verwenden. Masterkey außerhalb der Datenbank in einer geschützten Dienstdatei oder geeignetem Secret-Store halten. Schlüsselrotation und getrennte Schlüsselsicherung gehören zum Restore-Test.

HTTP-TLS schützt Übertragung, nicht Datenbank-Backups oder Festplatten. Für Daten im Ruhezustand sind verschlüsselte Volumes und verschlüsselte Backups vorgesehen. Die Speichereinsparung durch Deduplizierung wird vor einer eventuellen anwendungseigenen Inhaltsverschlüsselung berechnet; zusätzliche Medienverschlüsselung wäre ein separat zu entwerfendes Feature.

Archiviertes HTML wird standardmäßig als Download angeboten. Eine Vorschau muss auf einer getrennten Origin ohne Sitzungscookies und mit stark eingeschränkter Sandbox/CSP laufen. SVG und aktive Formate werden nicht ungeprüft in die App eingebettet. Medienstreams benötigen dieselbe Eigentümerprüfung wie Metadaten; öffentliche Verzeichnislisten und ungeschützte statische Original-URLs sind ausgeschlossen.

## 8. Wartung und Datenminimierung

Abhängigkeiten und Adapter werden gepinnt, auf bekannte Schwachstellen geprüft und kontrolliert aktualisiert. Sicherheitsereignisse, privilegierte Änderungen und Löschfreigaben sind auditierbar; Secrets und signierte URLs werden bereits vor dem Logger entfernt. Historiemetadaten, Betriebslogs, Queue-Daten und Backups erhalten getrennte Aufbewahrungsregeln. Rechtliche Aufbewahrungs-/Löschpflichten werden für den konkreten Betrieb bewertet; dieser technische Entwurf legt keine pauschale personenbezogene Daueraufbewahrung fest.


## 9. E-Mail-Betrieb mit Identity Provider

IdP-SMTP und Downloader-SMTP sind getrennte Konfigurationen. Beide können denselben Mailserver mit passenden Absendern verwenden; keiner liest die SMTP-Geheimnisse des anderen. Bei SSO sendet der IdP Konto-, Passwort- und MFA-Mails. Die App versendet weiter freiwillige Download-/Transfer-/Quotenmeldungen. Dadurch vereinfacht SSO das Kontomanagement, ohne Benachrichtigungen an die Verfügbarkeit eines lokalen Passwortkontos zu koppeln.

Aus Quelle B werden neutrale HTML- und Nur-Text-Mails, optionale tägliche Zusammenfassungen und ein kategorienbezogener Abmeldeweg übernommen. Ein GET-Link zeigt zunächst eine Bestätigungsseite; automatisierte Linkscanner dürfen keine Kontoeinstellung ändern. Ein späterer One-Click-Unsubscribe-Endpunkt wird separat nach dem passenden Mailstandard umgesetzt. Die UI enthält dieselben Ereignisse unabhängig davon, ob E-Mail aktiv ist. Verifizierte Empfänger, SPF/DKIM/DMARC-Konfiguration und Zustellbarkeit gehören zum Betriebsabnahmetest, nicht zu einem pauschalen Zustellversprechen.

## 10. Kontenverknüpfung und Widerruf als Sicherheitsgrenze

Ein externer Login wird anhand von `(issuer, sub)` zugeordnet. Gleiche E-Mail-Adressen, gleiche Anzeigenamen oder eine bekannte Domain reichen nicht zur Kontoübernahme. Bestehende lokale Konten werden nur nach erneuter Authentifizierung beider Identitäten oder einer kontrollierten, auditierbaren Administratormigration verknüpft. Eine neue Providerkonfiguration wird zunächst deaktiviert angelegt und erst nach einem erfolgreichen Test freigegeben.

Logout-Callbacks, Claims und Gruppenlisten sind Eingaben mit Schemaprüfung und Größenlimit. Signatur, Audience und Issuer werden über vertrauenswürdig geladene Schlüssel geprüft; untrusted `jku`-/`x5u`-URLs werden nicht als Schlüsselquelle benutzt. Sicherheitsänderungen invalidieren gecachte Berechtigungen. Privilegierte Aktionen verlangen eine ausreichend frische Authentifizierung; ein kopiertes altes Cookie reicht dafür nicht.


## 11. Verbindlicher Proxy- und Lifecycle-Schutz

Produktionsbetrieb erfolgt ausschließlich hinter dem administrierten TLS-Reverse-Proxy. Der Dienst bindet an Loopback oder ein beschränktes internes Netz; Firewall/Netzpolicy erlaubt direkten Backendzugriff nur vom Proxy und benötigten internen Diensten. `trust proxy` akzeptiert ausschließlich konfigurierte Proxyadressen/-netze. Der Proxy entfernt vom Client gelieferte Forwarded-/Identitätsheader und setzt die freigegebenen Werte selbst. App-Origin, OIDC-Callbacks, E-Mail-Links und Logoutziele werden aus festen öffentlichen URLs gebildet. Der Proxy ersetzt nicht OIDC und Objektberechtigungen.

SCIM empfängt einen eigenen providergebundenen Bearer-Token über TLS; die Anwendung speichert dessen Prüfreferenz und erlaubt nur Identity-Operationen. Tokens werden rotiert und nicht geloggt. Back-Channel-Logout wird separat per JWT geprüft. Beide Serverkanäle besitzen Schema-/Body-/Ratenlimits, eigene Fehlerbudgets und dürfen nicht von einer interaktiven Proxy-Loginseite blockiert werden. Netzwerkfreigaben ergänzen diese Authentifizierung, ersetzen sie aber nicht.

Der lesende Lifecycle-Connector verwendet separate IdP-Credentials mit minimalen Rechten auf benötigte Benutzer-/Gruppenstatus. Wo eine Anbieter-API nur gröbere Leserechte anbietet, wird der tatsächlich notwendige Umfang ausdrücklich dokumentiert; keine Schreib-, Impersonation-, Passwortreset- oder Superadminrechte als Standard. Der Fetch-Runner erhält weder diese Credentials noch Netzfreigabe zum IdP. Jede wirksame externe Sperre wird auditiert und ohne Offenlegung fremder Benutzerdaten angezeigt.
