# 01 – Produktumfang und Anforderungen

## 1. Ziel

Die Anwendung archiviert berechtigt zugängliche Inhalte mehrerer Webseiten, führt wiederkehrende Downloads aus und verwaltet Herkunft, Qualität, Speicherort und Verlauf. Benutzer können geeignete Medien in ihre Immich-Instanz übertragen und die lokalen Nutzdaten anschließend kontrolliert entfernen. Der Verlauf bleibt sichtbar und verhindert ungewollte erneute Downloads.

„Datenbank“ bedeutet zwei getrennte Aufgaben: Der Katalog ist immer datenbankgestützt; für die eigentlichen Datei-Bytes wählt der Admin zwischen Datenbank und Dateisystem. Die Weboberfläche erhält keine Datenbankzugangsdaten.

## 2. Rollen

| Rolle | Befugnisse |
| --- | --- |
| Admin | Benutzer einladen/sperren, Rollen und Quoten setzen, Speicherprofile und SMTP konfigurieren, erlaubte Adapter und Immich-Ziele freigeben, Betriebsstatus sehen |
| Benutzer | Eigene Quellen, Zugangsdaten, Downloads, Zeitpläne, Vorlagen, Benachrichtigungen und Immich-Verbindungen verwalten |
| Systemdienst | Nur die für seine Aufgabe nötigen Daten und Geheimnisse verarbeiten; keine interaktive Anmeldung |
| Identity Provider | Im SSO-Modus Anmeldung, MFA und Passwort-/Kontowiederherstellung; kein unmittelbarer Zugriff auf Medien, Download-Cookies oder Immich-Keys |

Ein Anwendungsadmin erhält nicht automatisch eine Oberfläche zum Lesen fremder Medien oder Entschlüsseln fremder Quellkonten. Betriebssystem-/Datenbankadministratoren sind technisch privilegiert; der Plan verspricht keinen Schutz vor einem vollständig kompromittierten Host. Optionaler Supportzugriff auf Benutzerdaten ist separat, zeitlich begrenzt und auditierbar.

## 3. Verbindliche Zielanforderungen

| ID | Anforderung | Abnahme |
| --- | --- | --- |
| F01 | Browseroberfläche und dauerhafter Serverdienst | Downloads laufen nach Schließen des Browsers weiter |
| F02 | Linux, Windows und macOS | Installation, Neustart und Dienstwiederanlauf auf allen drei Systemen getestet |
| F03 | Erweiterbare Plattformadapter | Ein Adapter kann ohne Änderung an Speicher- und Immich-Logik ergänzt werden |
| F04 | Bilder, Videos, Seiten und Anhänge | Typ und Originalrepräsentation bleiben im Katalog erkennbar |
| F05 | Beste verfügbare Qualität | Keine heimliche Auflösungsreduktion, verlustbehaftete Konvertierung oder Metadatenbereinigung |
| F06 | Datenbank- oder Dateisystem-Nutzdaten | Derselbe Download-/Transfer-Test besteht in beiden Modi |
| F07 | Frei konfigurierbare Hierarchie | Pixiv → Creator → Post → Bild und alternative Vorlagen funktionieren |
| F08 | Geplante Downloads | Einmaltermine, Wiederholungen, Zeitzonen, Pause und Wiederanlauf |
| F09 | Benutzerverwaltung | Lokaler oder OIDC-Modus; Anmeldung, Sperre, Rollen, Sitzungen und sichere Wiederherstellung beim zuständigen System |
| F10 | SMTP | TLS-gesicherter Versand, Testfunktion und verständlicher Fehlerstatus |
| F11 | E-Mail-Wahlrecht | Ergebnis-E-Mails nur nach Zustimmung; spätere Abwahl greift auch vor Versand |
| F12 | Immich-Transfer | Benutzer wählt Medien, Ziel und gegebenenfalls Album; Verträge gegen die jeweils neueste stabile Zielversion prüfen |
| F13 | Lokales Entfernen nach Immich | Nur nach Originalprüfung und gültiger Freigabe; alle Zwischenfehler behalten die Quelle |
| F14 | Dauerhafte History | Herkunft, Dateiidentität, Jobs, Immich-Ziel und Löschereignis bleiben auffindbar |
| F15 | Dublettenvermeidung | Bereits abgeschlossene Versionen werden bei Wiederholung übersprungen, auch nach lokaler Löschung |
| F16 | Wiederaufnahme | Unterbrechung führt weder zu falschem Erfolg noch zum Verlust der einzigen Kopie |
| F17 | Sichere Internetnutzung hinter Reverse-Proxy | TLS, eingeschränkter Backendzugriff und Maßnahmen aus 06 vor öffentlicher Freigabe erfüllt |
| F18 | Lizenztransparenz | Exakte ausgelieferte Artefakte besitzen SBOM, Lizenznachweise und freigegebene Ausnahmen |
| F19 | Externes SSO | Authentik und ein zweiter geprüfter OIDC-Anbieter ohne Änderung an Katalog oder Workern nutzbar |
| F20 | Stabile Identitäten | Zuordnung über Issuer und Subject; keine automatische Kontenverschmelzung über E-Mail |
| F21 | Automatische externe Kontosperre | IdP-Deaktivierung sperrt App-Zugriff, Sitzungen, Jobs und Cleanup ohne erneuten Login; maximale Synchronisationsverzögerung und Ausfallverhalten aus 11 nachgewiesen |
| F22 | Getrennte Kontomails | SSO-Passwort-Reset beim IdP; Ergebnis-E-Mails und deren Opt-in bleiben in der Anwendung |
| F23 | Zwei Dateisystemlayouts | Physische Wunschstruktur oder platzsparende CAS-Ablage mit virtuellen Pfaden; Unterschied in UI erkennbar |
| F24 | Skalierung für 1–100 Benutzer | Lastprofil mit 100 Konten, fairer Vermittlung und korrekt getrennten Daten nachgewiesen; kein hartes 100-Konten-Produktlimit |
| F25 | Admin bestimmt Download-Limits | Parallelität, Raten, Worker und optionale Quoten konfigurierbar; keine feste Downloadanzahl pro Benutzer |
| F26 | Wiederherstellungsziele | RPO ≤ 24 h und RTO ≤ 8 h durch Backup-/Restore-Abnahme auf Zielhardware nachgewiesen |

## 4. Nutzerabläufe

### 4.1 Einrichtung

1. Betreiber installiert Datenbank und Dienst unter eingeschränkten Dienstkonten.
2. Ein lokal erzeugtes Einmal-Setup-Geheimnis erlaubt die geschützte Ersteinrichtung. Keine öffentlich offene Erstregistrierung. Im SSO-Modus wird der erste Admin explizit an eine verifizierte externe Identität gebunden, nicht an den ersten beliebigen Login.
3. Admin legt Reverse-Proxy/Basis-URL, Anmeldemodus, verpflichtende Sperrsynchronisation im SSO-Profil, Speicherprofil/Layout, Download-Limits, optionale Quoten, SMTP und zugelassene Verbindungsziele fest.
4. Im lokalen Modus setzt der eingeladene Benutzer sein Passwort. Im SSO-Modus erhält er Zugriff auf die IdP-Anwendung und meldet sich dort an; ein lokaler Kontodatensatz wird durch vertrauenswürdige Provisionierung oder nach erfolgreicher Identitäts-, Lifecycle- und Zugriffsprüfung angelegt. Provisionierung allein erzeugt keine Browsersitzung.
5. Benutzer hinterlegt ein Quellkonto und optional einen Immich-API-Key. Geheimnisse werden nach Speicherung nie vollständig zurückgegeben.

### 4.2 Download

1. URL einfügen; Adapter und unterstützte Inhaltsarten werden angezeigt.
2. Vorschau zeigt Creator, Post, erwartete Dateien, Qualität und aufgelöste Pfade, soweit die Quelle diese Informationen liefert.
3. Einmalig starten oder Zeitplan anlegen. Unbekannte Gesamtgrößen werden als unbekannt angezeigt.
4. Nach erfolgreicher Prüfung erscheinen Dateien und Metadaten in der Sammlung. Teilfehler einzelner Post-Dateien bleiben sichtbar.

### 4.3 Immich

1. Benutzer prüft seine Verbindung und das zugeordnete Immich-Konto.
2. Auswahl „Nur übertragen“ oder „Übertragen und lokale Originale nach Prüfung entfernen“.
3. Vorschau nennt übertragbare Medien, nicht unterstützte Anhänge, Ziel und Löschfrist.
4. Upload, Prüfung und lokales Entfernen erscheinen als getrennte Fortschrittsstufen.
5. History zeigt anschließend „In Immich vorhanden; lokal entfernt“. „Remote unbekannt“ und „Remote nicht auffindbar“ sind eigene Zustände.

### 4.4 Struktur ändern

Ein Vorlageneditor zeigt Beispieldaten und Kollisionen. Neue Vorlagen gelten standardmäßig für zukünftige Downloads. Bestehende Einträge werden nur über eine explizite, fortsetzbare Migration umgeordnet. Im Dateisystemlayout `template` wird die Vorlage physisch angewandt. Im Layout `cas` sowie im DB-Modus ist die Struktur virtuell und bei Bedarf exportierbar.

### 4.5 SSO und Kontoverwaltung

Die Anmeldung leitet zum eingerichteten Anbieter weiter. Passwörter und MFA-Geheimnisse externer Benutzer werden nicht im Downloader gespeichert. Anzeige, Kontowiederherstellung und Rollenverwaltung verweisen auf das jeweils zuständige System. Quoten, Medienbesitz, Ergebnis-E-Mail-Präferenzen und Quell-/Immich-Secrets verbleiben im Downloader. Ein IdP-Wechsel erfolgt über eine kontrollierte Identitätsmigration bei unveränderter lokaler Benutzer-ID. Details: [11](11_SSO_Authentik_und_OIDC.md).

## 5. Nichtfunktionale Ziele

Alle Zahlen sind anfängliche Planungsziele und in M0/M7 zu messen, keine bereits belegten Leistungswerte.

| Thema | Ziel |
| --- | --- |
| Arbeitsspeicher | Dateigröße darf den RAM-Verbrauch nicht linear erhöhen; kontrollierte Stream-Puffer |
| Benutzer-/Lastprofil | Anfangs 1, Auslegung bis 100 Benutzer; getrennte Messung von Konten, aktiven Sitzungen, Queue und Streams |
| Download-Konfiguration | Alle Betreiberlimits konfigurierbar; keine feste Grenze von 2 Downloads oder 1 Download pro Quellkonto. Schema und Semantik in 04 |
| Antwortzeit | Katalog-API p95 unter 500 ms bei 100.000 Assets auf dem vereinbarten Testsystem, externe Dienste ausgenommen |
| UI | Tastaturbedienung, klare Statusmeldungen, paginierte/virtualisierte Listen; Deutsch zuerst |
| Große Dateien | Mindestens 20-GiB-Testdatei in beiden Speicherarten; kein einzelner riesiger DB-Wert |
| Zeitplanung | Kein doppelter logischer Lauf desselben geplanten Termins |
| Integrität | Jeder fertige lokale Inhalt besitzt Byteanzahl und SHA-256 |
| Wiederherstellung | Dokumentierter und tatsächlich durchgeführter Restore-Test vor erster stabiler Version |
| Wartbarkeit | Versionierte Adapter, API-Verträge, Datenbankmigrationen und rückverfolgbare Ereignisse |

## 6. Abgrenzung

- Kein universelles Versprechen für jede Webseite oder jede Kontoart.
- Kein Umgehen von DRM, Zugriffssperren, fehlenden Abonnements oder Kontoberechtigungen. Bei interaktiver Anmeldung/Challenge pausiert der Auftrag.
- Kein automatisches Veröffentlichen, Weiterverteilen oder Teilen der heruntergeladenen Inhalte.
- Keine verlustbehaftete Medienoptimierung als Standard. Eine spätere Vorschaukonvertierung ist eine separate Ableitung.
- Kein vollwertiges Browser-Archiv aller dynamischen Webanwendungen im ersten Release. Zunächst HTML-Snapshot mit begrenzten statischen Ressourcen.
- Kein bidirektionaler Immich-Abgleich und kein automatisches Löschen in Immich.
- Kein öffentlicher Plugin-Marktplatz mit beliebigem ausführbarem Benutzercode.
- Kein Hochverfügbarkeitscluster in Version 1; Datenmodell und Jobs dürfen spätere zusätzliche Worker ermöglichen.

## 7. Datenlöschung und History

„Lokale Medien entfernen“, „Quelle nicht mehr verfolgen“ und „Benutzerkonto einschließlich personenbezogener Daten löschen“ sind unterschiedliche Aktionen. Die normale Medienbereinigung erhält die History. Eine ausdrückliche Konto-/Datenschutzlöschung kann auch Verlauf und Geheimnisse entfernen oder minimieren; es gibt keine pauschale Zusage ewiger personenbezogener Speicherung. Die UI erklärt die jeweilige Wirkung vor der Bestätigung.


## 8. Bestätigte Quellen und Betriebsentscheidungen

„Feels“ bezeichnet hier Instagram Reels. Reels werden als Inhaltsart innerhalb des Instagram-Adapters geplant. „PH“ umfasst Pornhub als konkrete erste Quelle und die Erweiterbarkeit auf ähnliche Videoportale; zusätzliche Domains werden einzeln getestet und freigegeben.

Die Nicht-MIT-Ausnahmen aus 09 sind als Projektstrategie angenommen. Immich folgt der neuesten stabilen Veröffentlichung, aktuell als Ziel v3.2.4; es werden keine ungetesteten Updates automatisch installiert. Authentik ist der vorgesehene Anbieter. Allgemeines OIDC plus getrennte Lifecycle-Verträge verhindern eine Bindung des fachlichen Kerns an Authentik.
