# 09 – Lizenzentscheidungen und Quellen

Stand der Aktualisierung: 6. Oktober 2026; bisheriges Lizenzinventar übernommen, neue Release-/Lifecycle-Quellen ergänzt. Lizenzangaben beziehen sich auf die eingesehenen Projektquellen; die spätere Freigabe muss exakt gepinnte Versionen und Distributionsartefakte betreffen. Dieses Dokument ist ein technisches Lizenzinventar und keine pauschale rechtliche Unbedenklichkeitsgarantie.

## 1. Ergebnis für das Projekt

Der eigene Anwendungscode kann unter MIT veröffentlicht werden. Für direkte Bibliotheken werden MIT-Komponenten bevorzugt. **Das gesamte beschriebene System ist damit nicht ausschließlich MIT-lizenziert.** Die Datenbank, der Compiler, Teile der Laufzeit und besonders die reichweitenstarken Downloader haben andere Lizenzen.

Die Planung ersetzt diesen Konflikt nicht durch eine unbewiesene „alles erlaubt“-Behauptung. Sie sieht drei Ebenen vor:

1. Eigener Kern und eigene Adapter: MIT als bestätigte Projektlizenz.
2. Infrastruktur und Bibliotheken: einzeln bewertete permissive Lizenzen; Ausnahmen im Inventar.
3. Externe Downloader und Immich: eigenständige Werkzeuge/Dienste mit eigenen Lizenzpflichten; Nutzung im erweiterten Profil angenommen, vor einer späteren Mitlieferung separat bewertet.

Der Benutzer hat diese MIT-orientierte Strategie einschließlich der dokumentierten Nicht-MIT-Ausnahmen angenommen. Gewählt sind MIT für eigenen Code, bevorzugt MIT für direkte Bibliotheken und die in der Matrix begründeten abweichenden Komponenten. Externe Downloader und FFmpeg werden zunächst separat installiert, Immich und IdP als unabhängige Dienste angebunden. Eine vollständig MIT-only lizenzierte Distribution ist kein Projektziel; konkrete Versions-/Artefaktprüfungen und Lizenzpflichten bleiben Teil jedes Releases.

## 2. Komponentenmatrix

| Komponente | Eingesehene Hauptlizenz | Einsatz / Entscheidung | Primärquelle |
| --- | --- | --- | --- |
| Eigener Kern / eigene Adapter | Vorgesehen: MIT | Copyright- und Lizenzdatei anlegen | Projektentscheidung |
| React | MIT | UI-Basis | [LICENSE](https://github.com/react/react/blob/main/LICENSE) |
| Fastify | MIT | HTTP-API | [LICENSE](https://github.com/fastify/fastify/blob/main/LICENSE) |
| node-postgres | MIT | PostgreSQL-Treiber | [LICENSE](https://github.com/brianc/node-postgres/blob/master/LICENSE) |
| Kysely | MIT | Abfragen und Migrationen | [LICENSE](https://github.com/kysely-org/kysely/blob/master/LICENSE) |
| pg-boss | MIT | Persistente Jobqueue | [Projekt](https://github.com/timgit/pg-boss) |
| cron-parser | MIT | Terminberechnung | [Projekt](https://github.com/harrisiirak/cron-parser) |
| openid-client | MIT | Backend-OIDC-Client; genaue transitive Versionen prüfen | [Projekt](https://github.com/panva/openid-client) |
| Authentik | MIT-Kern mit ausdrücklich anders lizenzierten Bereichen und Drittkomponenten | Separater Referenz-IdP; keine pauschale MIT-Einstufung des Gesamtimages | [LICENSE](https://github.com/goauthentik/authentik/blob/main/LICENSE) |
| Authentik Enterprise | Eigenständige Enterprise-Lizenz | Keine Pflichtabhängigkeit der Basis-SSO-Funktion; Feature-/Vertriebsprüfung bei Nutzung | [Enterprise LICENSE](https://github.com/goauthentik/authentik/blob/main/authentik/enterprise/LICENSE) |
| Keycloak | Apache-2.0 | Alternativer separater OIDC-Anbieter | [LICENSE](https://github.com/keycloak/keycloak/blob/main/LICENSE.txt) |
| Authelia | Apache-2.0 | Weiterer OIDC-Kandidat mit eigener Fähigkeitsmatrix | [LICENSE](https://github.com/authelia/authelia/blob/master/LICENSE) |
| node-argon2 | MIT für dieses Projekt | Passwortbibliothek; native/transitive Komponenten ebenfalls prüfen | [LICENSE](https://github.com/ranisalt/node-argon2/blob/master/LICENSE) |
| WinSW | MIT | Windows-Dienstwrapper | [LICENSE](https://github.com/winsw/winsw/blob/v3/LICENSE.txt) |
| Nodemailer | MIT-0 | SMTP; permissiv, aber nicht identischer SPDX-Identifier wie MIT | [Lizenzseite](https://nodemailer.com/license) |
| Node.js | MIT für Node; zusätzliche enthaltene Lizenzen | Laufzeitinventar erforderlich | [LICENSE samt Drittkomponenten](https://github.com/nodejs/node/blob/main/LICENSE) |
| TypeScript | Apache-2.0 | Entwicklungswerkzeug; explizite Nicht-MIT-Ausnahme | [LICENSE](https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt) |
| PostgreSQL | PostgreSQL License | Eigenständiger DB-Dienst; permissiv, nicht MIT | [Lizenz](https://www.postgresql.org/about/licence/) |
| yt-dlp | Unlicense im Quellprojekt | Optionaler Video-Downloader; Artefakt separat prüfen | [Lizenz-/Releasehinweise](https://github.com/yt-dlp/yt-dlp#licensing) |
| gallery-dl | GPLv2 laut Projektkennzeichnung | Nicht Bestandteil eines als MIT-only bezeichneten Bundles; genaue SPDX-Variante des Release prüfen | [Projekt](https://github.com/mikf/gallery-dl) |
| FFmpeg / ffprobe | LGPL-2.1-or-later als Basis; GPL je aktivierten Bestandteilen/Build | Optionaler Muxer/Medienprüfer; kein MIT-Werkzeug | [Offizielle Lizenzhinweise](https://ffmpeg.org/legal.html) |
| Immich | AGPLv3 | Bereits separat betriebene Zielanwendung; eigener HTTP-Client statt ungeprüfter Codeübernahme | [LICENSE](https://github.com/immich-app/immich/blob/main/LICENSE) |

Die Matrix bewertet die ausgewählten Hauptprojekte. Sie ist noch keine vollständige SBOM. Die Python-/Vue-Bibliotheksliste aus Quelle B ist kein zusätzlicher verpflichtender Stack; nicht übernommene Bibliotheken gelten dadurch weder als ausgewählt noch als lizenzgeprüft. Reverse-Proxy, Installer, Container-Basisimages, Medien-/Bilddecoder, MFA-Bibliothek, Testwerkzeuge, Icons und Schriften werden erst nach Auswahl ergänzt. „Noch nicht ausgewählt“ bedeutet nicht „lizenzfrei“.

## 3. Downloader-Fallen

### yt-dlp

Die offizielle Dokumentation unterscheidet Quellcode und Releasepakete ausdrücklich. PyInstaller-Pakete enthalten zusätzliche GPLv3+-Komponenten; andere Archive haben ebenfalls eigene Drittkomponenten. Daher darf ein Quellprojekt-Label nicht ungeprüft auf eine Windows-EXE oder ein macOS-Paket übertragen werden. Quelle: [yt-dlp Licensing](https://github.com/yt-dlp/yt-dlp#licensing).

Empfehlung: genau definierte, vom Betreiber separat installierte Umgebung; Quellpaket, Python, JS-Unterstützung und optionale Module einzeln erfassen. Auch das ist keine wörtliche MIT-only-Lösung. Nur die tatsächlich benötigten Features aktivieren und deren Laufzeitpakete prüfen.

### gallery-dl

GPL ist mit „ausschließlich MIT“ nicht gleichzusetzen. Die separat installierte CLI ist eine mögliche Integrationsvariante; die rechtliche Einordnung von Distribution, Änderungen und Integration muss trotzdem für das konkrete Produkt erfolgen. Keine Codekopie in den MIT-Kern. Das eingesehene GitHub-Projekt verweist für aktive Entwicklung inzwischen auf Codeberg; Releasequelle und Maintainerweg bei der Versionierung berücksichtigen. Quelle: [gallery-dl Projekt](https://github.com/mikf/gallery-dl).

### FFmpeg

Build-Konfiguration und enthaltene Bibliotheken bestimmen die Pflichten. Ein Download von einer beliebigen Binary-Sammlung ist keine Lizenzfreigabe. Für den vorgesehenen Weg möglichst einen reproduzierbaren, nachvollziehbaren Build verwenden; optionale GPL-/nonfree-Bestandteile nicht unbesehen aktivieren. Bei Weitergabe die für genau diesen Build geltenden Lizenz-, Hinweis- und Quellcodepflichten erfüllen. Quelle: [FFmpeg Legal](https://ffmpeg.org/legal.html).

### Immich

Die Planung behandelt Immich als unabhängigen Dienst über dessen öffentliche API. Es wird weder Immich-Code kopiert noch ein SDK ungeprüft in den MIT-Kern aufgenommen. Eine eigene veränderte Immich-Version oder gemeinsame Distribution wäre gesondert zu bewerten. AGPL wird nicht durch Umbenennen, Verpacken oder eine Prozessgrenze zu MIT. Quelle: [Immich LICENSE](https://github.com/immich-app/immich/blob/main/LICENSE).

## 4. Freigabeprozess vor jedem Release

1. Exakte Version, Bezugsquelle und Hash jedes Runtime-Artefakts festhalten; Lockfiles einchecken.
2. Direkte und transitive Pakete sowie mitgelieferte Binaries inventarisieren. Build-/Testwerkzeuge separat erfassen; prüfen, was tatsächlich im Produkt landet.
3. SPDX-Lizenzausdrücke anhand von Original-Lizenzdateien prüfen, nicht nur anhand eines automatisch erkannten Paketlabels.
4. Unbekannte, nichtkommerzielle, unklare oder nicht genehmigte Copyleft-Komponenten blockieren die Distribution, bis sie bewertet/ersetzt sind.
5. Bei MIT die erforderlichen Copyright-/Lizenzhinweise mitgeben. Andere Lizenzen nach ihren eigenen Bedingungen behandeln.
6. `THIRD_PARTY_NOTICES`, Lizenzkopien und eine maschinenlesbare SBOM, z. B. CycloneDX oder SPDX, erzeugen.
7. Verpflichtende Quellen-/Buildinformationen für ausgelieferte Komponenten passend zum Binärstand bereitstellen, soweit erforderlich.
8. Sicherheits- und Lizenzprüfung bei jedem Dependency-Update wiederholen. Externe Toolversionen in der Adminoberfläche ausweisen.

Eine Softwarelizenz regelt die Nutzung der Software, nicht automatisch das Herunterladen fremder Inhalte. Plattformbedingungen, Urheberrechte und Zugriffsberechtigungen sind eine zweite Prüfung. Die Produktfunktion bleibt auf berechtigt zugängliche Inhalte begrenzt; es werden keine Umgehungsfunktionen vorgesehen.

## 5. Technische Primärquellen

Die folgenden Quellen stützen konkrete Eigenschaften bestehender Projekte. Architektur, Tabellen, Statusmodell, Defaults und Aufwandsschätzungen in den übrigen Dateien sind eigene Vorschläge.

| Thema | Quelle | Wofür verwendet |
| --- | --- | --- |
| Downloader-Abdeckung | [yt-dlp Supported Sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) | Kandidaten und bekannte Einschränkungen, keine Live-Funktionsgarantie |
| Bild-/Post-Adapter | [gallery-dl Supported Sites](https://gdl-org.github.io/docs/supportedsites.html) | Plattform-/Inhaltsarten und Authentifizierungswege |
| Download-Laufzeit | [yt-dlp Dependencies](https://github.com/yt-dlp/yt-dlp#dependencies) | Zusätzliche Werkzeuge für gewählte Features |
| Immich Upload/Original | [Asset-Media-Controller](https://github.com/immich-app/immich/blob/main/server/src/controllers/asset-media.controller.ts) | Upload, Originalabruf und Dublettenoperation |
| Immich Assetinformationen | [Asset-Controller](https://github.com/immich-app/immich/blob/main/server/src/controllers/asset.controller.ts) | Abruf eines Assets und Berechtigungsbezug |
| Immich API-Einstieg | [API-Dokumentation](https://api.immich.app/) | Späteres versionsbezogenes Vertragsreview; dynamische Referenz nur eingeschränkt auslesbar |
| Immich Dateiformate | [Supported Media Formats](https://docs.immich.app/features/supported-formats/) | Eignung als Foto-/Videoziel |
| Immich CLI | [CLI-Dokumentation](https://docs.immich.app/features/command-line-interface/) | Vorhandene Uploadfunktion; Abgrenzung der eigenen Cleanup-Logik |
| PostgreSQL große Werte | [TOAST](https://www.postgresql.org/docs/current/storage-toast.html) | Grund für Chunk-Design statt riesigem Einzelwert |
| PostgreSQL Löschen | [Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html) | Logisches Entfernen vs. physische Dateigröße |
| Netzwerkangriffe | [OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) | Mehrschichtiger Schutz ausgehender Requests |
| Passwortspeicherung | [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) | Argon2id und Parameterkalibrierung |
| Passwortwiederherstellung | [OWASP Forgot Password](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html) | Einmaltokens, gleichförmige Antworten, vertrauenswürdige Reset-URLs |

Beim Entwicklungsstart werden bewegliche `main`-/`master`-Links im internen Freigabenachweis durch Release-/Commitbezüge ergänzt. Keine hier genannte Plattform wurde im Rahmen dieser Planung mit Benutzerkonten live heruntergeladen.


## 6. Zusätzliche Quellen für Identitätsdienste

| Thema | Offizielle Quelle | Einsatz |
| --- | --- | --- |
| Authentik OIDC | [OAuth2 Provider](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/) | Issuer-/Subject-Konfiguration, Claims, E-Mail-Verifikation und Protokollfähigkeiten |
| Authentik Einrichtung | [Create provider](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/create-oauth2-provider/) | Einrichtungsvorgaben für den Referenzanbieter |
| Authentik Logout | [Front-/Back-Channel Logout](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/frontchannel_and_backchannel_logout/) | Fähigkeitsabhängiger Sitzungswiderruf; Preview-/Versionsstatus beachten |
| Authentik Provisionierung | [SCIM Provider](https://docs.goauthentik.io/add-secure-apps/providers/scim/) | Verbindliche SCIM-Anbindung für automatische Kontosperren |
| Keycloak OIDC | [Securing applications](https://www.keycloak.org/securing-apps/oidc-layers) | Zweiter Anbieter für Vertragstests |
| Authelia Fähigkeiten | [OIDC Introduction](https://www.authelia.com/integration/openid-connect/introduction/) | Protokollumfang prüfen, keine pauschale Logout-Zusage |
| Identität und Tokens | [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html) | Standardgrundlage für die eigene Clientintegration |
| Aktuelle OAuth-Sicherheit | [RFC 9700](https://datatracker.ietf.org/doc/html/rfc9700) | Sicherheitsprofil des Code-Flows |
| App-initiiertes Logout | [OIDC RP-Initiated Logout](https://openid.net/specs/openid-connect-rpinitiated-1_0.html) | Kontrolliertes Abmelden beim Anbieter |
| Serverinitiiertes Logout | [OIDC Back-Channel Logout](https://openid.net/specs/openid-connect-backchannel-1_0.html) | Signatur-/Claimprüfung des Logout-Tokens |
| Provisionierung | [RFC 7644](https://www.rfc-editor.org/rfc/rfc7644.html) | Verbindlicher abgegrenzter SCIM-Vertrag |

Die Anbieterempfehlung ist eine Architekturentscheidung auf Basis dieser dokumentierten Fähigkeiten. Es wurde keine konkrete Providerinstallation des Benutzers geprüft. Ein bereits vorhandener, geeigneter OIDC-Anbieter kann dieselbe Rolle erfüllen; allein für den Downloader muss nicht zusätzlich Authentik eingeführt werden.


## 7. Quellen der bestätigten Betriebsentscheidungen

| Thema | Primärquelle | Planungsfolge |
| --- | --- | --- |
| Neueste stabile Immich-Version | [Latest](https://github.com/immich-app/immich/releases/latest), [v3.2.4](https://github.com/immich-app/immich/releases/tag/v3.2.4) | Am 6. Oktober 2026 verifiziert; vor M0/Release erneut prüfen |
| Authentik Benutzerstatus | [User retrieve](https://api.goauthentik.io/reference/core-users-retrieve/), [API-Schema](https://api.goauthentik.io/) | Lesender Lifecycle-Connector; Felder und Rechte gegen konkreten Release testen |
| Authentik Provisionierung | [SCIM](https://docs.goauthentik.io/add-secure-apps/providers/scim/) | Änderungsereignisse plus dokumentierter stündlicher Vollabgleich; eigene zeitnahe Reconciliation ergänzt diese Wege |
| Keycloak Statusabgleich | [Admin REST API](https://www.keycloak.org/docs-api/latest/rest-api/index.html) | Zweiter Lifecycle-Connector für Benutzerstatus/Gruppen; kein eingebauter SCIM-Sender vorausgesetzt |

Das SCIM-Basisprofil verwendet bei Authentik einen statischen, rotierbaren Token über TLS. Die dort gesondert gekennzeichnete Enterprise-Option für SCIM-OAuth-Tokens ist keine Pflichtabhängigkeit. Die kurzen Synchronisationsfristen dieses Projekts sind eigene Abnahmeanforderungen, keine unbelegte SLA-Zusage von Authentik oder Keycloak.
