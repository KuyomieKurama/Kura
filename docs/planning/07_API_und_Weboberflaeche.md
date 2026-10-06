# 07 – Weboberfläche und API-Verträge

## 1. Hauptansichten

| Ansicht | Wesentliche Funktionen |
| --- | --- |
| Dashboard | Aktive Jobs, nächste Termine, Speicherbelegung, pausierte Quellkonten und offene Immich-Prüfungen |
| Neuer Download | URL, Quellenprüfung, Qualitätsprofil, Speicher-/Pfadvorschau, sofort oder geplant |
| Quellen | Quellkonten, Creator/Feeds, letzte erfolgreiche Prüfung, unterstützte Adapterfähigkeiten |
| Sammlung | Plattform → Creator → Post → Asset oder eigene virtuelle Struktur; Filter und Suche |
| Assetdetail | Originaldaten, Qualitätsparameter, Herkunft, lokale Kopien, Immich-Status und Ereignisse |
| Zeitpläne | Tages-/Wocheneditor, Cron-Option, Zeitzone, nächste fünf Termine, Pause |
| Transfers | Zielkonto, Fortschritt, Prüfschritt, Karenz, blockierte Löschungen und Wiederholung |
| History | Durchsuchbarer Verlauf einschließlich lokal entfernter Medien; Export als JSON/CSV |
| Einstellungen | Anmeldeart, lokale Passwort/MFA-Funktionen oder IdP-Link, Sitzungen, E-Mail-Präferenzen, Quellkonten, Immich und Pfadvorlagen |
| Administration | Benutzer, Rechteherkunft, lokale Sperren, Quoten, OIDC-Provider, Speicherprofile/Layout, SMTP, erlaubte Ziele und Betriebsstatus |

Lokal entfernte Medien bleiben im normalen Verlauf sichtbar, mit Platzhalter statt kaputtem Bild. Ein Remote-Link öffnet Immich ohne API-Key in der URL. Der Browser bekommt keine Immich-Secrets; ein Link allein gewährt keinen fremden Zugriff.

## 2. Entscheidende Dialoge

### Downloadvorschau

Zeigt Quelle, authentifiziertes Quellkonto, bekannte Dateianzahl, bekannte/geschätzte Größe, gewünschte Qualität und aufgelöste Struktur. „Unbekannt“ ist besser als eine erfundene Null. Der Benutzer sieht, ob der Adapter Einzelposts, ganze Creator oder nur bestimmte Medientypen unterstützt.

### Übertragen und lokal entfernen

Zeigt genaue Zielinstanz und Zielkonto, unterstützte Medien, verbleibende Anhänge, Karenzzeit und bestehende lokale Behalteverweise. Kopieren und Entfernen sind getrennte Optionen. Die Freigabe ist an eine serverseitige Auswahl-/Policy-Version gebunden; bei wesentlichen Änderungen wird eine neue Vorschau verlangt.

Bei gemischten Posts beispielsweise: „3 Bilder übertragbar; 1 ZIP bleibt im Archiv“. Bei gemeinsamer lokaler Kopie: „Dieser Inhalt wird noch von einem anderen Eintrag benötigt“. Fortschritt unterscheidet „hochgeladen“, „Original geprüft“ und „lokal entfernt“.

### Speicherwechsel

Admin kann ein neues Standardprofil für zukünftige Jobs aktivieren. Die Migration bestehender Daten ist eine zweite Aktion mit Größe, Platzbedarf, Prüfschritten und Status. Eine Einstellungsänderung darf keine stillschweigende Massenlöschung auslösen.

## 3. Geplante REST-API

Eigene API unter `/api/v1`. Die Pfade in dieser Tabelle gehören **zum Downloader**, nicht zur Immich-API. Authentifizierte schreibende Browseraufrufe benötigen Sitzung, CSRF-Schutz und Objektberechtigung. Öffentliche Login-/Reset-Endpunkte erhalten eigene Origin-, Missbrauchs- und Tokenprüfungen; sie verlangen keine bereits bestehende Benutzersitzung. Der OIDC-Callback hat stattdessen seinen einmaligen Loginzustand; Back-Channel-Logout ist ein separat signaturgeprüfter Serveraufruf ohne Browser-CSRF-Token. Asynchrone Aktionen liefern `202` mit fachlicher Auftrags-ID und Status-URL.

| Methode / Pfad | Zweck |
| --- | --- |
| `GET /auth/methods` | Freigegebene Loginwege ohne Secrets anzeigen |
| `POST /auth/login`, `POST /auth/logout` | Lokale Anmeldung, sofern erlaubt; lokale Sitzung in allen Modi beenden |
| `GET /auth/oidc/{provider}/start` | Kurzlebigen Authorization-Code-/PKCE-Vorgang starten |
| `GET /auth/oidc/{provider}/callback` | Browsergebundenen Code einmalig prüfen und Sitzung erzeugen |
| `POST /auth/oidc/{provider}/backchannel-logout` | Verifiziertes Logout-Token verarbeiten; nur wenn unterstützt |
| `POST /auth/identities/link` | Verknüpfung aus frischer bestehender Sitzung starten; keine E-Mail-Automatik |
| `POST /auth/password-reset/request` | Gleichförmige Antwort; Versand nur für lokale Konten, SSO-Reset beim IdP |
| `POST /auth/password-reset/confirm` | Token atomar verbrauchen und Passwort setzen |
| `GET /me`, `PATCH /me` | Eigenes Profil mit Feld-Allowlist |
| `GET /me/sessions`, `DELETE /me/sessions/{id}` | Sitzungen verwalten |
| `GET /me/notifications`, `PUT /me/notifications` | Benachrichtigungspräferenzen |
| `GET /adapters` | Fähigkeiten, Versionen und aktuelle Freigabe |
| `POST /sources/probe` | Validierte Quelle asynchron prüfen |
| `GET/POST /source-accounts` | Eigene Quellkonten listen/anlegen; nur maskierte Daten zurückgeben |
| `GET/POST /subscriptions` | Wiederkehrend beobachtete Ziele verwalten |
| `POST /download-runs` | Einzelauftrag oder expliziten erneuten Download erzeugen |
| `GET /download-runs/{id}` | Fortschritt, Assetergebnisse, sichere Fehlerdetails |
| `POST /download-runs/{id}/cancel` | Abbruchwunsch speichern; keine willkürliche Prozesssteuerung |
| `POST /download-runs/{id}/retry` | Wiederholung unter aktuellen Berechtigungen |
| `GET/POST /schedules`, `PATCH /schedules/{id}` | Zeitpläne verwalten |
| `POST /schedules/preview` | Nächste Ausführungszeiten mit DST-Hinweisen |
| `GET /creators`, `GET /posts`, `GET /assets` | Eigentümerbegrenzter Katalog mit Cursor-Pagination |
| `GET /assets/{id}/content` | Autorisierter Originalstream einschließlich Range-Unterstützung |
| `POST /path-templates/preview` | Sichere Pfadprüfung anhand von Beispieldaten |
| `POST /immich-connections` | Zielkonto und Secret sicher hinterlegen |
| `POST /immich-connections/{id}/test` | Identität, Version und Fähigkeiten prüfen |
| `POST /transfers/preview` | Auswahl, Ziel, verbleibende Inhalte und Löschwirkung berechnen |
| `POST /transfers` | Bindenden Transfer aus gültiger Vorschau erzeugen |
| `GET /transfers/{id}` | Upload, Prüfergebnis und Cleanup getrennt anzeigen |
| `POST /transfers/{id}/revoke-cleanup` | Noch nicht ausgeführte lokale Bereinigung widerrufen |
| `GET /history`, `POST /history/exports` | Verlauf bzw. asynchroner Export eigener Daten |
| `GET /events` | Sitzungsgebundene Server-Sent Events mit Eigentümerfilter |
| `POST /admin/users/invitations` | Benutzer einladen |
| `PATCH /admin/users/{id}` | Lokale Sperren/Quoten; Rollenänderung nur bei lokaler Rechteherkunft |
| `GET/POST /admin/identity-providers` | Provider inventarisieren bzw. zunächst deaktiviert anlegen |
| `POST /admin/identity-providers/{id}/test` | Issuer, Discovery und Fähigkeiten prüfen |
| `POST /admin/identity-providers/{id}/activate` | Getestete Version mit frischer Adminauthentifizierung aktivieren |
| `POST /admin/identity-migrations` | Kontrollierte Identitätsmigration, keine Umschreibung von Medienbesitz |
| `GET/PUT /admin/runtime-policy` | Download-/Worker-/Ratenbudgets mit Revision validieren und aktivieren |
| `GET /admin/identity-providers/{id}/lifecycle-status` | Statusfrische, Sperrverzögerung und Connectorfehler anzeigen |
| `POST /admin/identity-providers/{id}/reconcile` | Begrenzten erneuten Statusabgleich anfordern |
| `GET/POST /admin/storage-profiles` | Speicherprofile verwalten |
| `POST /admin/storage-migrations` | Explizite, fortsetzbare Migration |
| `PUT /admin/smtp`, `POST /admin/smtp/test` | SMTP setzen und kontrolliert testen |

## 4. Vertragsregeln

- OpenAPI für die eigene API; Request-/Response-Schemata mit festen Größenlimits.
- `Idempotency-Key` für Jobanlage, Transfer und Migration. Gültigkeit pro Benutzer und Operation; derselbe Schlüssel mit anderer Payload liefert `409`.
- Optimistische Sperre über Versionsnummer/ETag für Einstellungen, Zeitpläne, Vorlagen und Transferfreigaben.
- Keine DB- oder Dateisystempfade in ungefilterten Fehlermeldungen. Frontend erhält fachliche IDs.
- `404` oder einheitliches Ablehnen für nicht zugängliche fremde Objekte; keine Existenzbestätigung fremder Assets.
- Lokale Inhalte mit Status `removed` liefern einen verständlichen fachlichen Verfügbarkeitsstatus, beispielsweise HTTP `410`, plus erlaubte History-/Immich-Verweise.
- Ereigniskanäle sind Hinweise. Nach Wiederverbindung liest die UI den maßgeblichen Zustand erneut aus der API.
- Assetselektion für Massenaktionen wird serverseitig eingefroren; eine dynamisch veränderte Filterliste ist keine Löschfreigabe.

## 5. Fachliche Fehlercodes

| Code | Benutzeraktion |
| --- | --- |
| `UNSUPPORTED_SOURCE` | Unterstützte URL bzw. Plattform wählen |
| `SOURCE_AUTH_REQUIRED` | Quellkonto erneuern |
| `SOURCE_RATE_LIMITED` | Automatische Wartezeit abwarten |
| `QUALITY_UNAVAILABLE` | Andere Qualität ausdrücklich wählen oder später erneut prüfen |
| `QUOTA_EXCEEDED` | Platz freigeben oder Admin kontaktieren |
| `UNSAFE_TARGET` | Zulässiges Ziel verwenden; keine globale Schutzabschaltung anbieten |
| `IMMICH_FORMAT_UNSUPPORTED` | Original im Archiv behalten |
| `IMMICH_COMPATIBILITY_UNKNOWN` | Zielversion prüfen; Auto-Cleanup bleibt aus |
| `REMOTE_OUTCOME_UNKNOWN` | Abgleich abwarten; Quelle bleibt vorhanden |
| `INTEGRITY_MISMATCH` | Fehler untersuchen; Quelle behalten |
| `CLEANUP_BLOCKED_BY_REFERENCE` | Weiteren lokalen Behaltewunsch auflösen oder Kopie behalten |
| `ACCOUNT_DISABLED` | Zuständigen Admin/IdP kontaktieren; erneuter Login hebt Sperre nicht auf |
| `IDENTITY_STATUS_STALE` | Automatischen Statusabgleich abwarten; keine Arbeit mit ungeprüfter Freigabe |
| `CAPACITY_WAIT` | Auf freie konfigurierte Slots warten; kein Downloadfehler |
| `STORAGE_UNAVAILABLE` | Speicherung reparieren; keine Inhalte als gelöscht markieren |

## 6. Konfigurationshierarchie

Globale Admin-Policy setzt Obergrenzen und erlaubte Funktionen. Benutzerpräferenzen gelten innerhalb dieser Grenzen. Eine Quelle kann eigene Vorlage, Qualität und Zeitplan besitzen. Jeder Auftrag speichert einen Snapshot der effektiven Konfiguration. Bei Sicherheitsrechten und Cleanup gelten trotzdem die aktuellen strengeren Regeln; ein alter Snapshot darf eine inzwischen widerrufene Freigabe nicht wiederherstellen.


## 7. SSO-Oberfläche und Zuständigkeiten

Die Loginseite zeigt beispielsweise „Mit Authentik anmelden“. Im reinen OIDC-Modus enthält sie kein funktionsfähiges lokales Passwortformular. Ein vorhandener lokaler Recovery-Zugang ist kein öffentlich beworbener Ausweichlogin; Aktivierung und Zugriff richten sich nach dem Notfallverfahren in 11.

Im Profil steht „Konto verwaltet durch …“. Passwort und MFA öffnen die freigegebene IdP-Kontoseite. Medien, Quoten, Benachrichtigungen und verbundene Quellkonten bleiben in der App. Gruppenbasierte Rollen erscheinen als schreibgeschützt mit Herkunftsangabe. Die Adminoberfläche zeigt lokale Sperre, externen Kontostatus, effektive Freigabe, Zeitpunkt der letzten autoritativen Prüfung und Zustand des verpflichtenden Lifecycle-Connectors. Eine fehlende oder veraltete Statusanbindung verhindert die Freigabe des verwalteten SSO-Profils.

Ein IdP-Ausfall zeigt eine verständliche Fehlermeldung und aktiviert keine lokale Anmeldung. Die SSO-Verknüpfung mit einem vorhandenen Konto hat eine separate Vorschau und verlangt frische Nachweise. Eine Änderung der externen E-Mail übernimmt nie fremde Medien oder ein gleichnamiges lokales Konto.


## 8. SCIM- und Verwaltungsverträge

SCIM liegt separat unter `/scim/v2/{provider}`; der Platzhalter ist die fest konfigurierte Provider-ID, niemals eine frei wählbare Ziel-URL. Vorgesehen sind `ServiceProviderConfig`, `Schemas`, `ResourceTypes`, `Users` und `Groups`. Unterstützte Verfahren werden wahrheitsgemäß annonciert: paginiertes GET, Anlage per POST, Ersetzung per PUT, abgegrenztes PATCH-Profil und DELETE als Deprovisionierung. Der benötigte Filterumfang enthält exakte `externalId`-/`userName`-Vergleiche; Größen, Ergebnisse und Operationen bleiben begrenzt. Bulk wird im ersten Profil nicht beworben.

`active=false` und Deprovisionierung sperren den lokalen Zugang; DELETE entfernt dabei weder Medien noch History. Unbekannte/mehrdeutige Korrelationen erzeugen einen Fehler, keinen E-Mail-basierten Kontenzusammenschluss. Provisionierung ist keine normale Browseraktion und verwendet eigene, eng berechtigte Credentials. Details einschließlich Wiederholungen, Reihenfolge und Aktivierung stehen in 11.

Die Adminseite „Ausführung“ bietet globale Budgets und optionale Überschreibungen je Benutzer/Adapter/Quellkonto, aktuelle Slotbelegung, Warteschlangen und eine Vorschau der wirksamen Grenzen. Werte können über Dienstkonfiguration oder autorisierte Admin-API gepflegt werden; ein Deployment legt eine eindeutige Quelle fest. Versionskonflikte liefern `409`, ungültige Werte werden vor Aktivierung abgelehnt. CLI/Config-Reload benutzen denselben Validierungsvertrag wie die UI.
