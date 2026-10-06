# Downloader Project – konsolidierter Projektplan

Stand: 6. Oktober 2026 · Version: 2.1 · Status: zusammengeführter Entwicklungsplan, noch keine Implementierung

Grundlage sind alle 22 Markdown-Dokumente aus `Downloader_Planung(1).zip` und `files.zip`. Dieser Stand löst widersprüchliche Empfehlungen auf und ergänzt Authentik bzw. andere OpenID-Connect-Anbieter als reguläre Anmeldeoption. Die Ausgangsarchive bleiben unverändert. [12_Entscheidungen_und_Quellenvergleich.md](12_Entscheidungen_und_Quellenvergleich.md) dokumentiert, was übernommen, angepasst oder verworfen wurde.

## Empfehlung

Eine selbst gehostete Webanwendung mit einem dauerhaft laufenden Hintergrunddienst. Der Browser bedient eine API; ausschließlich die Serverprozesse sprechen die Datenbank an und führen Downloads, Zeitpläne, E-Mail-Versand und Immich-Transfers aus. Als Ausgangspunkt dienen Node.js/TypeScript, React, Fastify und PostgreSQL. Ein modularer Anwendungskern und getrennte Worker-Prozesse reichen zunächst aus; Kubernetes und ein zusätzlicher Redis-Server sind nicht erforderlich.

Metadaten und History liegen immer in PostgreSQL. Der Admin entscheidet, ob auch die Mediendateien dort als Binärdaten oder in einem verwalteten Dateiverzeichnis liegen. Eine einheitliche Speicherschnittstelle macht beide Varianten für Downloader und Immich gleich nutzbar.

**Benutzerverwaltung:** Bei vorhandenem Identity Provider empfehlen wir SSO über OpenID Connect, mit Authentik als erstem Referenzanbieter. Er übernimmt Anmeldung, MFA und Passwortwiederherstellung. Die Anwendung verwaltet weiterhin eine stabile lokale Benutzer-ID, Medienrechte, Quoten und Benachrichtigungspräferenzen. Ohne externen Dienst ist ein lokaler Modus möglich. Die automatische Übernahme externer Kontosperren gehört verbindlich zum ersten Produktivrelease. OIDC wird dafür durch SCIM und geprüfte Lifecycle-Connectoren ergänzt; Authentik ist vorgesehen, die Schnittstellen bleiben anbieterunabhängig. Details in [11](11_SSO_Authentik_und_OIDC.md).

**Wichtigste Zusicherung des Entwurfs:** Lokale Originale werden nach einem Immich-Transfer nur entfernt, wenn genau dieses Original im richtigen Immich-Konto überprüft wurde, die History dauerhaft gespeichert ist und eine gültige Löschfreigabe vorliegt. Ein erfolgreicher Upload-HTTP-Status allein reicht nicht.

## Dokumente

| Datei | Inhalt |
| --- | --- |
| [01_Anforderungen.md](01_Anforderungen.md) | Produktumfang, Rollen, Nutzerabläufe und messbare Anforderungen |
| [02_Architektur.md](02_Architektur.md) | Komponenten, Technologieentscheidungen, Prozess- und Transaktionsgrenzen |
| [03_Datenmodell_und_Speicherung.md](03_Datenmodell_und_Speicherung.md) | Tabellen, Originalqualität, Datenbank-Binärspeicher, Verzeichnisvorlagen und Migration |
| [04_Downloader_und_Zeitplaene.md](04_Downloader_und_Zeitplaene.md) | Plattformadapter, Unterstützungsmatrix, Wiederholungen, Cron und Sommerzeit |
| [05_Immich_und_History.md](05_Immich_und_History.md) | Übertragung, Integritätsprüfung, Löschfreigabe, Wiederanlauf und Historie |
| [06_Sicherheit_Benutzer_SMTP.md](06_Sicherheit_Benutzer_SMTP.md) | Internetbetrieb, Rechte, SSRF, Geheimnisse, Passwort-Reset und Benachrichtigungen |
| [07_API_und_Weboberflaeche.md](07_API_und_Weboberflaeche.md) | Ansichten, API-Verträge, Fehlercodes und Einstellungsmodell |
| [08_Umsetzungsplan_und_Abnahme.md](08_Umsetzungsplan_und_Abnahme.md) | Arbeitspakete, Reihenfolge, Aufwandsspannen, Testfälle und Freigabekriterien |
| [09_Lizenzen_und_Quellen.md](09_Lizenzen_und_Quellen.md) | MIT-Komponenten, ausdrücklich abweichende Lizenzen und Primärquellen |
| [10_Betrieb_und_Wiederherstellung.md](10_Betrieb_und_Wiederherstellung.md) | Linux/Windows/macOS, Installation, Backups, Monitoring und Betriebsabläufe |
| [11_SSO_Authentik_und_OIDC.md](11_SSO_Authentik_und_OIDC.md) | SSO-Architektur, Authentik-Einrichtung, Alternativen, Gruppen, Identitäten und Offboarding |
| [12_Entscheidungen_und_Quellenvergleich.md](12_Entscheidungen_und_Quellenvergleich.md) | Vergleich beider Archive, begründete Architekturentscheidungen und übernommene Stärken |

Für den Einstieg: dieses Dokument, anschließend 12, 11, 05 und 08. Die übrigen Dateien spezifizieren Anforderungen, Architektur, Daten, Sicherheit, API, Lizenzen und Betrieb.

## Festgelegte Planungsannahmen

| Thema | Annahme / Entscheidung |
| --- | --- |
| Betrieb | Selbst gehostete Installation, zunächst 1 Benutzer, Auslegung bis 100 getrennte Konten |
| Betriebssysteme | Native Dienste auf Linux, Windows und macOS; Linux zusätzlich als Container-Installation |
| Erstes Speicherprofil | Dateisystem als Empfehlung; Datenbankmodus gehört ebenfalls zum zugesagten Zielumfang |
| Dateisystemlayout | `template` für eine tatsächlich lesbare Wunschstruktur; alternativ `cas` für deduplizierte Hashablage mit virtueller Struktur |
| Anmeldung | `oidc` bei vorhandenem Anbieter empfohlen; `local` ohne zusätzlichen Identity Provider; `hybrid` nur bewusst aktivieren |
| Externe Benutzer | Geplante Freigabe: Authentik als Referenzanbieter und Keycloak als zweiter OIDC-Vertragstest; weitere Anbieter nach Fähigkeitsprüfung |
| Qualität | Bestmögliche zugängliche Quellversion ohne verlustbehaftete Neukodierung; keine Behauptung, einen vom Anbieter nicht herausgegebenen Upload-Master wiederherstellen zu können |
| Immich | Eigene Verbindung pro Benutzer; Übertragung auf Wunsch manuell oder nach Download automatisch |
| Löschung | Standardmäßig aus; Benutzer kann sie für seine Übertragungen aktivieren, sofern der Admin sie erlaubt |
| Benachrichtigungen | Freiwillige Ergebnis-E-Mails standardmäßig aus; angeforderte Passwort-Reset-Mails bleiben verfügbar |
| „PH“ | Pornhub bestätigt; ähnliche Videoplattformen über einzeln freigegebene Adapter |
| Instagram Reels | Die zuvor „Feels“ genannten Instagram-Kurzvideos gehören zum Instagram-Adapter |
| Lizenzen | MIT für eigenen Code und bevorzugt für direkte Anwendungsbibliotheken; abweichende Infrastruktur- und Werkzeuglizenzen transparent, ohne pauschale Freigabe |

## Grenzen, die die Umsetzung beeinflussen

- **Speicherersparnis ohne Qualitätsverlust:** Bereits komprimierte Videos und Bilder werden durch ZIP oder Datenbankspeicherung normalerweise nicht wesentlich kleiner. Einsparungen entstehen vor allem durch Dublettenvermeidung, kleine Vorschauen und das Entfernen verifizierter lokaler Kopien. Datenbankspeicherung ist eine Betriebsentscheidung, kein Kompressionsverfahren.
- **Immich ist das Ziel für unterstützte Bilder und Videos.** HTML-Seiten, beliebige ZIP-Dateien, Pixiv-Animationsquellen und sonstige Anhänge benötigen weiterhin ein Archiv. Eine in Immich vorhandene Vorschau erlaubt nicht, ihre andersartige Originalquelle zu löschen. Siehe [05](05_Immich_und_History.md).
- **Plattformunterstützung ist wartungsbedürftig.** Ein vorhandener Extractor ist ein Kandidat, keine Funktionsgarantie. Kontoberechtigungen, Sitzungsablauf, Rate-Limits und Plattformänderungen werden als normale Zustände behandelt.
- **MIT-only und maximale Plattformabdeckung sind unterschiedliche Produktvarianten.** gallery-dl ist GPL-lizenziert, yt-dlp ist im Quellprojekt Unlicense, FFmpeg ist abhängig vom Build LGPL/GPL und Immich ist AGPL. Die Basis wird deshalb nicht als vollständig MIT-lizenziertes Gesamtpaket beworben. Einzelheiten und Belege stehen in [09](09_Lizenzen_und_Quellen.md).

## Bestätigte Projektentscheidungen

| Thema | Festlegung vom 6. Oktober 2026 | Umsetzung |
| --- | --- | --- |
| Quellen | Instagram einschließlich Reels; Pornhub und erweiterbare ähnliche Videoportale | Reels innerhalb Instagram; jede weitere Domain mit eigener Fähigkeitsprüfung |
| Nicht-MIT-Ausnahmen | Vorgeschlagene MIT-orientierte Strategie angenommen | Infrastruktur mit dokumentierten Lizenzen; externe Downloader zunächst separat installieren, nicht mitliefern |
| Benutzer und Downloads | Anfangs 1, Auslegung und Lasttests bis 100 Benutzer; keine feste Produktgrenze für Downloads | Admin konfiguriert Parallelität, Worker, Raten und optionale Quoten; 100 Konten bedeuten nicht automatisch 100 parallele Streams |
| Immich | Jeweils neueste stabile Version als Entwicklungsziel; aktuell v3.2.4 | Vor Release erneut ermitteln, konkrete Version/Artefakte testen und pinnen |
| Zugriff | Produktion verbindlich hinter einem TLS-Reverse-Proxy | Backendzugriff einschränken; nur konfigurierte Proxys und öffentliche URLs vertrauen |
| Identity Provider | Authentik geplant, allgemeine OIDC-Anbindung | Keycloak als zweiter Vertragstest; Anbieterfähigkeiten getrennt ausweisen |
| Kontosperren | IdP-Sperre muss automatisch im Downloader wirken | Verbindliche Lifecycle-Anbindung, inklusive Sitzungen, Jobs und Cleanup; kein Warten auf nächsten Login |
| Wiederherstellung | RPO höchstens 24 Stunden, RTO höchstens 8 Stunden | Tägliches verschlüsseltes Backup plus unabhängige Kopie; Ziele vor Freigabe durch Restore nachweisen |

Offen bleiben die konkrete Serverausstattung, administrative Limitwerte und die Liste zusätzlicher Videoportale. Diese Detailwahl blockiert den Projektentwurf nicht. Die aktuelle Immich-Referenz ist anhand der [offiziellen Latest-Release-Seite](https://github.com/immich-app/immich/releases/latest) als [v3.2.4](https://github.com/immich-app/immich/releases/tag/v3.2.4) verifiziert; damit ist noch kein Integrationstest bestanden.

### Änderungen in Version 2.1

Die acht Nutzervorgaben ersetzen die offenen Annahmen aus Version 2.0. Automatisches Offboarding wurde aus dem späteren Ausbau in den Pflichtumfang verschoben. Lastprofil, Konfigurationsvertrag, Roadmap und Abnahmetests wurden entsprechend erweitert.

Enthalten sind 13 Markdown-Dateien, ein Datenmodell mit ausgewählten SQL-Verträgen und eine Roadmap mit 50 kritischen Tests. Beispielkonfigurationen und SQL-Ausschnitte sind Spezifikationen für die Entwicklung, keine bereits lauffähige Anwendung.

Die beiden Archive wurden inhaltlich verglichen; die Authentik-/OIDC-Ergänzungen wurden anhand offizieller Quellen geprüft. Es wurden keine Konten verbunden, Inhalte heruntergeladen, E-Mails versandt oder Integrationen live getestet. API-Schemata und Lizenzdateien sind bei der späteren Versionsfestlegung erneut zu prüfen.
