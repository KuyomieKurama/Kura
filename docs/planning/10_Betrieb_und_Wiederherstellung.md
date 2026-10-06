# 10 – Installation, Betrieb und Wiederherstellung

## 1. Bereitstellungsvarianten

| System | Dienstbetrieb | Besonderheiten |
| --- | --- | --- |
| Linux | systemd; alternativ gepinnte Container | Dedizierte Benutzer, restriktive Dateirechte, Netzwerkisolation für Adapter |
| Windows | WinSW als Dienstwrapper für Node-Prozesse | Dediziertes Dienstkonto, NTFS-ACLs, Firewall, Prozesslimits; keine gemappten Benutzerlaufwerke |
| macOS | launchd/LaunchDaemon | Dienstkonto, fest konfigurierte Pfade, APFS-Namensregeln und passende Laufzeitarchitektur |

Native Installation ist der verbindliche plattformübergreifende Weg. Docker Desktop ist keine Voraussetzung für Windows/macOS. Ein laufender Dienst kann auf einem schlafenden oder ausgeschalteten Host nicht arbeiten; Zeitpläne werden danach gemäß Nachholregel bearbeitet. Die genauen OS-Versionen/CPU-Architekturen werden in M0 festgelegt und in CI bzw. Testsystemen nachgewiesen.

PostgreSQL kann auf demselben Host oder getrennt betrieben werden. Für Version 1 liegen Worker und verwaltetes Dateisystem auf demselben Host. Mehrere Hosts mit Filesystem-Backend benötigen später ein bewusst entworfenes gemeinsames Storage oder Host-Affinität; eine identische Pfadzeichenfolge allein genügt nicht.

## 2. Dienstrechte und Netzwerk

API, vertrauenswürdige Worker und externe Adapter erhalten getrennte Rollen bzw. geeignete Prozessgrenzen. Adapter dürfen nicht auf Datenbank-Credentials, den Masterkey oder fremde Jobs zugreifen. Sie erhalten nur ihren Arbeitsbereich und benötigte Quellsecrets. Für den öffentlichen Betrieb muss auf jedem unterstützten OS eine wirksame Egress- und Dateisystembegrenzung nachgewiesen sein. Wo native Isolation nicht verlässlich umgesetzt ist, bleibt das entsprechende öffentliche Betriebsprofil bis zur Härtung gesperrt; ein Kindprozess allein reicht nicht.

Nur die vorgesehenen HTTPS-Einstiege sind von außen erreichbar. Im SSO-Profil gehören dazu die öffentliche IdP-Anmeldung und gegebenenfalls der signaturgeprüfte Logout-Callback; IdP-Adminzugriff erhält eine eigene Betriebsregel. Datenbank, interne Jobkommunikation und Admin-Diagnostik werden nicht öffentlich exponiert. Der Reverse-Proxy terminiert TLS; die API vertraut Forwarded-Headern nur vom konfigurierten Proxy. Unnötige Upload-/Body-Limits nicht global erhöhen: Ein Medienstream und ein Login-Request benötigen unterschiedliche Grenzen.

Im lokalen Entwicklungsmodus kann die API an Loopback gebunden werden. Die UI darf diese Konfiguration nicht still in eine öffentliche Bindung ändern. Ein Adminschritt aktiviert die öffentliche URL und Sicherheitsprüfung.

## 3. Konfiguration

| Konfiguration | Ablage / Umgang |
| --- | --- |
| Öffentliche Basis-URL, Bind-Adresse, Log-Level | Versionierte Dienstkonfiguration ohne Secrets |
| DB-Verbindung | Geschützte Secret-Konfiguration; TLS bei getrenntem Host |
| OIDC-Modus, Issuer, Client-ID, Claims und Callback-URLs | Versionierte Admin-Konfiguration; Änderungen an Identitätsparametern nur kontrolliert |
| OIDC-Client-Secret | Verschlüsselte Secret-Referenz; Rotation und vorherige Generation kontrolliert behandeln |
| Masterkey/Keyring | Außerhalb der Datenbank, nur Dienstkonto lesbar; getrennt sichern |
| Medien-/Temp-Roots | Adminseitig fest, absoluten Pfad und Rechte beim Start prüfen |
| SMTP-/Immich-/Quellsecrets | Verschlüsselte Datenbankeinträge |
| Adapterprogramme | Admininstallierte Pfade, Versionen und Artefakt-Hashes |
| Speicher-, Thread- und Parallelitätsgrenzen | Konfigurierbare Startwerte; gemessene Ressourcen als Grundlage |

Beim Start werden Schema-Version, Schlüsselzugriff, Speicherprofil und benötigte Programme geprüft. Eine nicht verfügbare Komponente deaktiviert betroffene Aufträge mit nachvollziehbarem Status. Die Anwendung darf bei fehlendem Medienlaufwerk nicht ersatzweise in ein gleichnamiges leeres lokales Verzeichnis schreiben.

## 4. Updates und Rollback

1. Release-Lizenzen, SBOM, Sicherheitsmeldungen und Datenbankmigrationen prüfen.
2. Neue Aufträge pausieren, aktive Jobs kontrolliert abschließen oder resumierbar stoppen.
3. Wiederherstellbare Sicherung erstellen; Versions- und Konfigurationsmanifest sichern.
4. Release installieren, Migrationen einmalig unter exklusiver Migrationssperre ausführen.
5. Healthcheck, Anmeldung, Testdownload und Immich-Vertragstest durchführen; Cleanup zunächst deaktiviert.
6. Erst danach Scheduler und gegebenenfalls Cleanup wieder aktivieren.

Schemaänderungen bevorzugt additiv und in mehreren Schritten. Ein älteres Binary darf nicht automatisch gegen ein inkompatibel migriertes Schema starten. Bei erforderlichem DB-Restore sind zwischenzeitliche Schreibvorgänge zu berücksichtigen; „Binary zurückkopieren“ ist kein vollständiger Rollbackplan. Externe Downloader werden gepinnt und über denselben kontrollierten Releaseweg aktualisiert, ohne Selbstupdate aus Benutzerjobs.

## 5. Backupkonzept

Zu sichern sind Katalog, History, Policies, Secrets, Queue-/Intentzustände, Nutzdaten, Konfiguration, Adapter-/Kernversionsmanifest und **der getrennte Keyring**. Ein Datenbankbackup ohne Entschlüsselungsschlüssel kann Quellkonten und Immich-Verbindungen unbrauchbar machen. Keys nicht ungeschützt in dasselbe Archiv legen.

| Modus | Zu sichernde Nutzdaten |
| --- | --- |
| Dateisystem | PostgreSQL plus alle referenzierten verwalteten Mediendateien und Manifest |
| Datenbank | PostgreSQL einschließlich Chunk-Tabellen; Größe/WAL/Restorezeit einplanen |
| Gemischte Migration | Beide noch referenzierten Profile, bis die Migration abgeschlossen ist |

Für Version 1 wird eine einfache konsistente Sicherung mit Wartungsfenster vorgesehen: fachliche Schreibzugriffe und Worker stoppen, aktive Transaktionen auslaufen lassen, DB-Sicherung und Dateisystemkopie/Volumesnapshot mit gemeinsamem Manifest erstellen, dann wieder freigeben. Später können immutable Speicherobjekte, Backup-Epochen und kontinuierliche WAL-Sicherung kürzere Unterbrechungen ermöglichen.

Bestätigte Betriebsziele: tägliche verschlüsselte Sicherung, mindestens eine unabhängige Kopie außerhalb des primären Hosts, RPO maximal 24 Stunden und RTO maximal 8 Stunden. Die Ziele müssen anhand echter Datenmengen gemessen werden; für kleinere Metadatenverluste ist häufigere/fortlaufende DB-Sicherung nötig. Ein Backup, das nie testweise zurückgespielt wurde, gilt nicht als Abnahmenachweis.

Immich braucht ein eigenes Backup seiner Originale und Datenbank. Die Downloader-Sicherung kann Medien, die bereits lokal entfernt wurden, nur enthalten, wenn ältere Sicherungsgenerationen sie noch führen. Die History allein rekonstruiert keine verlorenen Bild-/Videobytes.

## 6. Wiederherstellung

1. Leeren Host bereitstellen, kompatible Programm-/DB-Version installieren und Netzwerkzugriff auf neue Jobs zunächst sperren.
2. Keyring, DB, Medien und Konfiguration aus derselben konsistenten Sicherungsgeneration wiederherstellen.
3. **Scheduler, E-Mail-Versand und automatische Bereinigung bleiben deaktiviert.** Alte Reset-/Einladungstokens, OIDC-Loginversuche und Sitzungen widerrufen; keine alten Mails erneut senden.
4. Referenzmanifest gegen Speicherkopien prüfen. Stichproben plus priorisierte vollständige Hashprüfungen je Wiederherstellungsziel durchführen.
5. Offene Writes, Leases, Transfers und Cleanup-Intents mit lokalem und remote Zustand abgleichen.
6. Alte verifizierte Transfers berechtigen nach Restore nicht automatisch zur Löschung. Neue Remote-Prüfung und erneute betriebliche Freigabe sind erforderlich.
7. Anmeldung, Beispielmedien, History und einen neuen Testtransfer prüfen; danach Jobs schrittweise freigeben.

Ein alter DB-Stand kann bereits entfernte Dateien wieder als lokal vorhanden aufführen. Dies ist ein Wiederabgleichsfall, kein Anlass, fehlende Dateien oder alte Löschbefehle blind weiterzuverarbeiten.

## 7. Monitoring und Aufbewahrung

| Signal | Reaktion |
| --- | --- |
| Jobalter / Queue wächst | Neue Discovery begrenzen; aktive Ursache anzeigen |
| Hohe 429-/Authfehlerrate | Quellkonto drosseln oder pausieren |
| Freier Medien-/Temp-/DB-Platz unter Reserve | Neue Schreibjobs stoppen, lesende UI verfügbar halten |
| Prüfsummenfehler | Quarantäne, Cleanup blockieren, kritischen Betriebsalarm erzeugen |
| Immich unklar/nicht erreichbar | Quelle behalten; Transfer separat wiederholen |
| Viele `delete_pending`-Intents | Reconciler prüfen; keine pauschale Massenbereinigung |
| SMTP-Outbox alt | Adminhinweis, Reset-Versandstatus prüfen |
| Backup-/Restoreprüfung überfällig | Sichtbarer Adminstatus |
| Schlüssel-/Zertifikatsprobleme | Betroffene Verbindung stoppen, kein unsicherer Fallback |

Startwerte: technische Logs 14 Tage, detaillierte Jobdiagnostik 30 Tage, Sicherheits-Audit 90 Tage. Diese Werte sind Betriebsvorschläge und konfigurierbar. Fachliche History hat eine eigene Policy und wird niemals nur deshalb gelöscht, weil pg-boss alte Queue-Einträge bereinigt. Temp-Dateien werden nur ohne gültige Lease und nach geprüftem Ablauf entfernt.

## 8. Runbooks

**Speicher voll:** Neue Downloads pausieren; Staging und Referenzen inventarisieren; nur eindeutig verwaiste Teilobjekte bereinigen; Quoten/Volume erweitern. Keine Originale aus pauschalen Größenregeln löschen.

**Quelladapter defekt:** Betroffene Adapterversion deaktivieren, Logs redigiert sichern, Fixture ergänzen, geprüfte neue Version ausrollen. Andere Plattformen weiter betreiben.

**Immich nicht erreichbar:** Transfers pausieren, Originale behalten, Zielverbindung prüfen. Kein Cleanup aus früheren Uploadmeldungen ableiten.

**Secret vermutlich kompromittiert:** Betroffene Jobs stoppen, Token beim Anbieter widerrufen, neues Secret hinterlegen, Generation erhöhen, Audit prüfen. Verschlüsselung allein macht einen gestohlenen aktiven Token nicht ungültig.

**Datenintegritätsfehler:** Objekt sperren, History ergänzen, vorhandene unabhängige Kopien prüfen und kontrolliert wiederherstellen. Hashreferenzen nicht an eine beschädigte Datei „anpassen“.


## 9. SSO-Betrieb und IdP-Sicherung

Der Downloader nutzt einen bestehenden IdP oder eine separat installierte Instanz. Dessen zusätzliche Infrastruktur wird nach dem ausgewählten Release betrieben, ohne veraltete Compose-Vorlage oder ungeprüfte Pflichtkomponenten aus dieser Planung zu übernehmen. IdP- und Downloader-Datenbanken können auf derselben PostgreSQL-Installation liegen, benötigen aber getrennte Datenbanken/Rollen und eigene Migrationen. Ein gemeinsam beschreibbares Schema ist nicht vorgesehen.

| Verbindung | Freigabe |
| --- | --- |
| Browser → Downloader | HTTPS, normale App-Session |
| Browser → IdP | HTTPS für Anmeldung/MFA/Kontoverwaltung |
| API → IdP | Nur geprüfte Discovery-, JWKS-, Token-, UserInfo- und gegebenenfalls Logout-Endpunkte |
| IdP → API | SCIM und benötigter Logout-Callback über Reverse-Proxy; eigene Token-/Signaturprüfung |
| Fetch-Runner → IdP | Verboten |
| Lifecycle-Worker → IdP-Status-API | Verpflichtend für Authentik-/Keycloak-Profil; nur konfigurierte lesende Benutzer-/Gruppenendpunkte mit separaten minimalen Credentials |

Provider-Sicherung umfasst dessen Benutzerbestand, stabile IDs, Signaturschlüssel, Clientkonfiguration, Gruppen und Flows nach dessen Betriebsanleitung. Diese Daten liegen nicht automatisch im Downloader-Backup. Nach IdP-Restore müssen Issuer und Subject-Zuordnung erhalten bleiben bzw. kontrolliert migriert werden. Neue zufällige Subject-IDs werden nicht mittels E-Mail heuristisch dem alten Medienbesitz zugeordnet.

IdP-Verfügbarkeit, Fehlerquote bei Callbacks, JWKS-Fehler und letzte erfolgreiche Providerprüfung sind eigene Betriebsmetriken. Tokens, Authorization-Codes und Claims mit personenbezogenen Details werden nicht vollständig geloggt. Das Alter der letzten autoritativen Statusprüfung wird pro externem Konto überwacht. Überschreitung der Frischegrenze sperrt effektiven Zugriff und Jobs automatisch; ein erfolgreicher Login oder eine erreichbare Discovery-URL setzt diesen Status nicht zurück.

## 10. Auslieferungsmanifest und Installationsabnahme

Die konkreten Betriebsdateien entstehen in M6: systemd-Units, WinSW-Konfigurationen, launchd-Plists und optional Linux-Compose. Dieses Paket enthält ihre Spezifikation, keine vorgetäuscht lauffähigen Services oder Images. Release-Manifeste verwenden feste Versionen bzw. Digests und getrennte Secrets. `latest` ist kein reproduzierbarer Produktionsstand.

Eine Compose-Netzbezeichnung wie `egress` garantiert für sich allein keine Internet-only-Isolation. IPv4/IPv6, DNS, Loopback und Host-/LAN-Routen werden praktisch getestet; Container-Netze und Host-Firewall gehören zusammen. Der Start kurzlebiger Runner darf nicht über einen unbeschränkt in die API gemounteten Docker-Socket erfolgen. Ein notwendiger Supervisor bekommt eine eng definierte Aufgabe und keine von Benutzern frei wählbaren Containerparameter.

Die erste öffentliche Freigabe verlangt pro Betriebsprofil einen Nachweis von Dienststart nach Reboot, begrenzten Schreibrechten, Job-Wiederanlauf, Secret-Zugriff, Medien-Range-Requests und wirksamer Egress-Policy. Eine nur unter Linux getestete Firewall wird nicht als Windows-/macOS-Nachweis akzeptiert.

## 11. Automatisches Offboarding und Wiederfreigabe

1. Konto im IdP deaktivieren oder konfigurierte Anwendungsberechtigung entziehen.
2. SCIM/Connector übernimmt die Änderung automatisch; innerhalb des in 11 festgelegten Zeitbudgets müssen Appzugriff, Sitzungen, neue Jobs und Cleanup blockiert sein. Laufende Streams/Runner werden kontrolliert angehalten.
3. Admin prüft den angezeigten Synchronisationsnachweis, Stoppstatus und die ungültig gewordenen Cleanup-Intents. Im Normalfall ist keine zweite manuelle Sperre nötig.
4. Bei ausgefallenem Abgleich greift automatisch die Statusfrische-Sperre. Eine zusätzliche lokale Sperre ist ein Notfallwerkzeug; Fehler alarmieren den Betreiber über die konfigurierte Betriebsüberwachung und werden nicht durch Login-Fallback verdeckt.
5. Daten und History bleiben erhalten. IdP-Reaktivierung erfordert frischen autoritativen Status; lokale Adminsperren bleiben bestehen. Sitzungen werden neu aufgebaut, alte Cleanup-Freigaben nicht reaktiviert. Pausierte Jobs werden ausdrücklich fortgesetzt.

Nach Restore ist Lifecycle-Status zunächst unbekannt. Erst vollständiger Abgleich erlaubt Zugriffe/Jobs externer Konten; Cleanup benötigt zusätzlich die ohnehin verlangte lokale/Immich-Neuprüfung.

## 12. Produktionsprofil und Ressourcen

Der Reverse-Proxy ist gesetzt. Nur er erreicht das Backend aus dem öffentlichen Verkehrsweg; TLS, feste App-URL, korrekte Cookie-/Origin-Einstellungen, geprüfte Proxyheader sowie SSE-/Streaming-Timeouts gehören zur Installationsabnahme. SCIM- und OIDC-Callbacks bleiben unter derselben festgelegten öffentlichen Basis erreichbar. Eine Proxy-Authentifizierung darf diese maschinellen Endpunkte nicht mit einer HTML-Loginseite beantworten.

Der Admin wählt Worker-Slots, Parallelitäts-, Bandbreiten- und optionale Tages-/Speicherbudgets per versionierter Konfiguration. Keine hardcodierte Downloadquote für 1 oder 100 Benutzer. Der Lifecycle-Pool bleibt von Downloadlast getrennt. Im Lasttest werden 1, 20 und 100 Konten sowie verschiedene Slotzahlen und Dateigrößen auf dokumentierter Hardware geprüft; CPU, RAM, DB-Verbindungen, Temp, WAL, Queuezeit und API-Latenz werden gemessen.

RPO 24 h und RTO 8 h sind akzeptierte Abnahmeziele, keine bereits gemessenen Eigenschaften. Backupintervalle berücksichtigen Laufzeit und Fehler, sodass der letzte erfolgreich wiederherstellbare Stand höchstens 24 h zurückliegt. Metadaten, lokale Originale, Schlüssel und notwendige IdP-Konfiguration müssen gemeinsam wiederherstellbar sein. Der Restore-Test umfasst auch die verwendete Datenmenge und Bandbreite. Nach lokalem Immich-Cleanup muss die Immich-Instanz die verbleibenden Originale separat sichern; der Downloader kann diese nicht aus der History rekonstruieren.

