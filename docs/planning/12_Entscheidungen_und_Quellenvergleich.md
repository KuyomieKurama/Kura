# 12 – Zusammenführung und begründete Entscheidungen

## 1. Ausgangsmaterial und Ergebnis

**Quelle A:** `Downloader_Planung(1).zip`, elf Dokumente unter `downloader-plan/`. Die Dateien sind bytegleich mit dem zuvor in dieser Unterhaltung erstellten ausführlichen Plan. Maßgeblich für die Zusammenführung waren die tatsächlich angehängten Dateien.

**Quelle B:** `files.zip`, elf Dokumente zum Arbeitstitel „Hoard“. Dieser Entwurf setzt auf Python/FastAPI und Vue, konkrete SQL-Tabellen, klar benannte Fetch-/Core-Rollen und zwei Dateisystemlayouts.

Alle 22 Markdown-Dateien wurden gelesen bzw. mit dem bereits vollständig bekannten identischen Text abgeglichen. Ergebnis ist **ein gemeinsamer Projektplan**, nicht die Ablage beider widersprüchlicher Varianten nebeneinander. Der bisherige Projektname „Downloader Project“ bleibt bestehen; „Hoard“ wird nicht ohne weitere Entscheidung als Produktname eingeführt.

## 2. Wichtigste Übernahmen

| Thema | Starke Grundlage aus A | Starke Grundlage aus B | Konsolidiertes Ergebnis |
| --- | --- | --- | --- |
| Kernarchitektur | Module, Verträge und wiederholbare Nebenwirkungen | Klare Fetch-/Core-Grenze und Staging-Übergabe | Modularer Kern mit API, Scheduler, vertrauenswürdigen Workern und isoliertem Fetch-Runner |
| Technik | Gemeinsamer TypeScript-Stack, pg-boss | Konkrete Verantwortlichkeiten unabhängig von Sprache | Node/Fastify/React bleibt einheitlich; Python-Engines separat |
| Speicher | Staging, Chunks, Generationen und Copy-Modell | Lesbares Template-Layout und optionaler CAS | Zwei explizite Dateisystemlayouts plus vollwertiger DB-Modus |
| Datenmodell | Benutzertrennung, Revisionen, Blob/Kopie/Transfer getrennt | SQL-Ausschnitte, Suchindizes und Mini-Vorschauen | Tabellenmodell plus ausgewählte SQL-Constraints; keine naive Übernahme globaler Hashschlüssel |
| Downloader | Fähigkeiten, Revisionen, Fehlerklassen | Manifest, vordefinierte Presets und Engine-Archiv | Normalisierter, untrusted Runner-Vertrag; committed History bleibt maßgeblich |
| Zeitpläne | Sommerzeit, Nachholregeln, Idempotenz und Leases | Praktische Lastverteilung und Kontolimits | Gespeicherter Jitter ergänzt die deterministische Planung |
| Immich | Vollständiger Original-Readback, Cleanup-Intent und Crashfälle | Manuelle/automatische Auslöser, Herkunft und Zeitangaben | Sicheres Transferprotokoll mit optionalen Metadaten, ohne fremde Dubletten zu überschreiben |
| History | Unabhängig von Nutzdaten, klare Datenschutzgrenze | Suche, kleine Vorschauen und intuitive Statusanzeige | Dauerhafter fachlicher Verlauf mit optionaler visueller Hilfe |
| Benutzer/E-Mail | Sichere Kontovorgänge und erneute Opt-in-Prüfung | Digest, Quotenhinweise und sichtbare Zuständigkeiten | Lokales oder SSO-Profil, App-Benachrichtigungen weiterhin freiwillig |
| Betrieb | Konsistenter Restore, ausgeschaltetes Cleanup nach Wiederherstellung | Konkrete native Dienstrollen und Paketziele | Native Linux-/Windows-/macOS-Pakete plus optional Linux-Container; pro Profil geprüfte Isolation |
| Planung | Risikogesteuerte Reihenfolge und Fehlerfalltests | Gut verständliche Meilenstein-Ergebnisse | Zuerst Integrität/Identität beweisen, dann Quellenbreite; 26 Anforderungen und 50 kritische Tests |
| Neu: Identitätsdienste | Noch kein vollständiger SSO-Entwurf | OIDC bisher nur späterer Komfortpunkt | Reguläre OIDC-Anbindung ab M1, automatische Sperrsynchronisation ab M1b, Authentik-Referenz und alternative Anbieter |

## 3. Konflikte, die bewusst aufgelöst wurden

### D01 – Ein Backend und ein Frontend

Gewählt: Node.js/TypeScript, Fastify, React und PostgreSQL. Das ermöglicht gemeinsame Vertragsmodelle und die bereits vorgesehene pg-boss-Queue. Die CLI-Engines können weiter in Python laufen; ihre Sprache schreibt die Sprache des API-Servers nicht vor. FastAPI/Vue wäre eine mögliche Alternative bei vorhandener Teamerfahrung, wird aber nicht parallel implementiert. Diese Entscheidung muss nur geändert werden, wenn das spätere Entwicklungsteam dafür konkrete Gründe hat.

### D02 – Bestehende Queue plus eigene Fachzustände

Gewählt: pg-boss für Vermittlung und Wiederholung; eigene `job_runs`, Outbox, Leases und Fencing-Generationen für Fachzustände. Ein vollständig selbstgebauter Queue-Unterbau erhöht den Aufwand für Zeitlimits, Wiederanlauf und Wartung. Weder `SKIP LOCKED` noch eine Queue-Bibliothek garantieren genau-einmalige externe Uploads; die Integration bleibt idempotent und abgleichbar.

### D03 – Ordnerstruktur und physische Deduplizierung ehrlich trennen

Gewählt: `template` stellt jeden Wunschpfad tatsächlich bereit, `cas` optimiert identische Bytefolgen durch gemeinsame Objekte und virtuelle Pfade. Der DB-Modus verhält sich logisch wie CAS. Ungeprüfte Hardlinks sind keine plattformübergreifende Basis. In `template` können doppelte Bytes an verschiedenen Pfaden Platz kosten; die Benutzeroberfläche zeigt diesen Trade-off. Das präzisiert sowohl die Aliasdarstellung aus A als auch das zu pauschale Hardlinkversprechen aus B.

### D04 – Deduplizierung innerhalb eines Benutzers

Gewählt: Unique(owner, hash, size), keine globale gemeinsame Blobidentität für alle Konten. Das reduziert Informationen über fremde Dateien und vereinfacht Aufbewahrung, Quoten und Löschfreigaben. Ein globaler Hash-Primärschlüssel aus B wird nicht übernommen. Benutzerübergreifende Deduplizierung wäre ein später separat zu prüfendes Feature.

### D05 – Hashen und Uploadstatus ersetzen keine sichere Bereinigung

Gewählt: Original aus Immich vollständig streamend zurücklesen, SHA-256 und Bytezahl vergleichen, Beleg committen, nach Karenz aktuelle Bedingungen erneut prüfen. Ein Assetdatensatz mit passendem SHA-1 oder eine Uploadantwort genügt nicht. `LOCAL_REMOVED` wird erst nach tatsächlicher Entfernung geschrieben; eine vorab geplante Löschung heißt `LOCAL_DELETE_REQUESTED`. Die Unterscheidung verhindert falsche Historieneinträge nach einem Crash.

### D06 – Metadaten normalisieren

Gewählt: begrenzte Allowlist relevanter Herkunfts- und Qualitätsdaten. Vollständige Engine-Metadaten können signierte URLs, Cookies oder andere sensitive Informationen enthalten und werden nicht pauschal auf Dauer gespeichert. Für Fehleranalysen gibt es redigierte, befristete Diagnostik. Auch eine gespeicherte HTML-Seite wird nicht unter der App-Origin aktiv ausgeführt.

### D07 – Originale nicht still optimieren

Gewählt: Originalbytes bzw. bewusst gewähltes verlustfreies Remux-Ergebnis archivieren und eindeutig kennzeichnen. PNG-/JPEG-Neuschreiben, auch mit gleichbleibenden Pixeln, ist kein bitidentisches Original. Solche Optimierungen dürfen höchstens separate Ableitungen sein. Für Textkompression und Dublettenersparnis werden keine unbelegten festen Prozentwerte versprochen.

### D08 – Prozessgrenze ist keine Lizenzgarantie

Gewählt: MIT-orientierter eigener Code, präzises Artefaktinventar und ausdrücklich bewertete Ausnahmen. Aussagen wie „Subprozess hält den eigenen Code automatisch rechtlich sauber“ oder „alle permissiven Lizenzen sind gleich problemlos“ werden nicht übernommen. Packaging, konkrete Binärdateien und Distribution werden separat geprüft. Die alternative Bibliotheksliste aus B ist kein pauschal genehmigter Einkaufskorb.

### D09 – Sicherheit vor öffentlichem Betrieb

Gewählt: Fetch-/Ingest-Vertrag von Anfang an; wirksame Netzwerk-/Dateirechte spätestens vor der ersten öffentlichen Freigabe. Ein Sammelprozess ohne die vorgesehenen Grenzen ist kein gleichwertiges Produktionsprofil. Eine Compose-Netzbezeichnung, ein `X-Requested-With`-Header oder ein einzelner Pfad-`resolve()`-Check ersetzt kein vollständiges Sicherheitskonzept.

### D10 – Native Dienste bleiben ein Ziel

Gewählt: systemd, WinSW und launchd; optional Container unter Linux. Docker Desktop wird nicht zur Pflicht für Windows/macOS erklärt. Beispiel-Images mit `latest`, ungeprüfte Port-/Firewallregeln und automatische Migrationen ohne Exklusivsperre werden nicht als fertige Installation übernommen. Konkrete Betriebspakete entstehen nach Implementierung und werden wirklich getestet.

### D11 – SSO früh, ohne Medienrechte auszulagern

Gewählt: Standard-OIDC im Backend ab M1, lokaler Modus als eigenständige Alternative. Authentik oder ein vorhandener geeigneter Anbieter reduziert Passwort-/MFA-Aufwand. Lokale Benutzer-ID, Quoten, Rechteprüfung und History bleiben erhalten. SSO- und lokale Konten werden nicht anhand gleicher E-Mail-Adressen automatisch verbunden.

### D12 – Login, Logout und Deprovisionierung unterscheiden

Gewählt: OIDC für Identität, unterstützte Logout-Erweiterungen für Sitzungen und verpflichtendes SCIM/Status-Connector-Modul für automatische Kontosperrung. Die Nutzervorgabe aus Version 2.1 zieht diese Funktion in den Erstumfang M1b. Manuelles zweites Offboarding ist nur ein Notfallwerkzeug. Sperrlatenz und Statusfrische werden getestet; normales Logout beendet weiterhin keine geplanten Downloads und löscht keine Medien.

## 4. Vollständige Zuordnung der Ausgangsdokumente

| Thema | Dokument aus Quelle A | Dokument aus Quelle B | Ziel in Version 2 |
| --- | --- | --- | --- |
| Überblick | `README.md` | `README.md` | README und 12 |
| Anforderungen | `01_Anforderungen.md` | Anforderungen über README/Roadmap verteilt | 01 und Abnahmezuordnung in 08 |
| Architektur | `02_Architektur.md` | `01-architektur.md` | 02 und 04 |
| Datenmodell | `03_Datenmodell_und_Speicherung.md` | `03-datenmodell.md` | 03; Identitätsvertrag zusätzlich 11 |
| Engine/Zeitpläne | `04_Downloader_und_Zeitplaene.md` | `04-downloader-engine.md` | 04; sichere Templates in 03 |
| Speicher | Teil von `03_Datenmodell_und_Speicherung.md` | `05-speicher.md` | 03 |
| Immich | `05_Immich_und_History.md` | `06-immich-integration.md` | 05 |
| Benutzer/E-Mail | `06_Sicherheit_Benutzer_SMTP.md` | `07-benutzer-email.md` | 06 und neue 11 |
| Sicherheit | Teil von `06_Sicherheit_Benutzer_SMTP.md` | `08-sicherheit.md` | 06; Identitäts-/Lifecycle-Grenzen in 11 |
| UI/API | `07_API_und_Weboberflaeche.md` | Oberfläche in Architektur/History beschrieben | 07 |
| Roadmap | `08_Umsetzungsplan_und_Abnahme.md` | `10-roadmap.md` | 08 |
| Lizenzen | `09_Lizenzen_und_Quellen.md` | `02-tech-stack-lizenzen.md` | 09 |
| Betrieb | `10_Betrieb_und_Wiederherstellung.md` | `09-deployment.md` | 10 |

Die Roadmap verwendet Personentage mit expliziten Annahmen. Teilzeitwochen aus B werden ohne bekannte Wochenstunden nicht in einen scheinbar präzisen Liefertermin umgerechnet. Der erweiterte Umfang umfasst reguläres SSO, automatische Sperrsynchronisation, beide Dateisystemlayouts und Lasttests bis 100 Benutzer. „Feels“ ist als Instagram Reels geklärt; Pornhub ist bestätigt. Weitere ähnliche Videoportale werden nach konkreter Auswahl ergänzt.

## 5. Was diese Zusammenführung geprüft hat

- Beide Archive und sämtliche enthaltenen Markdown-Dokumente inventarisiert und gelesen/inhaltlich abgeglichen.
- Sicherheits- und Speicherwidersprüche entschieden und in den jeweils betroffenen Plänen angepasst.
- Authentik/OIDC und Alternativen anhand offizieller Projekt- und Standardquellen recherchiert; Links in 09 und 11.
- Querverweise, Dateizahl, Beispiele, Anforderungs-/Testzuordnung und Archivintegrität vor Übergabe geprüft.

Nicht durchgeführt wurden eine Softwareimplementierung, eine Live-Verbindung zum IdP/Immich, echte Plattformdownloads oder die im Plan vorgesehenen Integrationstests. Das Ergebnis ist ein konsistenter, zur Umsetzung geeigneter Planungsstand.


## 6. Fortschreibung durch bestätigte Nutzervorgaben

Version 2.1 vom 6. Oktober 2026 übernimmt alle acht Entscheidungen: Instagram Reels/Pornhub, die vorgeschlagene Nicht-MIT-Strategie, 1–100 Benutzer mit administrativ konfigurierbaren Downloads, neueste stabile Immich-Version, verbindlicher Reverse-Proxy, allgemeine OIDC-Anbindung mit Authentik als Referenz, automatische IdP-Kontosperre und die vorgeschlagenen Backupziele RPO 24 h/RTO 8 h.

Dabei bleibt die geprüfte Originalübertragung nach Immich mit erhaltener History die zentrale Integritätsregel. Die Quellenarchive bleiben unverändert; aktualisiert wird der gemeinsame Plan. „Neueste Version“ ist eine fortlaufende Auswahlregel für Entwicklung und Abnahme; die aktuell ermittelte Referenz v3.2.4 ersetzt weder Vertragstests noch reproduzierbare Versionsbindung im Betrieb.
