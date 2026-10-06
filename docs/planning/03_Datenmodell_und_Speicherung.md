# 03 – Datenmodell, Speicher und Qualität

## 1. Grundprinzip

Ein **Asset** beschreibt einen fachlichen Inhalt, ein **Blob** eine bestimmte Bytefolge, eine **Speicherkopie** deren lokale Ablage und ein **Transferbeleg** die Übertragung nach Immich. Diese Objekte werden nicht gleichgesetzt. Wird die lokale Speicherkopie entfernt, bleiben Asset, Prüfsumme, Quellbezug und History erhalten.

Alle benutzerbezogenen Tabellen tragen `owner_id`. Referenzen zwischen ihnen werden durch zusammengesetzte Fremdschlüssel mit `owner_id` abgesichert. Eindeutigkeit und Dublettenerkennung gelten zunächst innerhalb eines Benutzers. Dadurch entstehen keine kontoübergreifenden Existenz- oder Inhaltslecks durch gemeinsame Hashes.

## 2. Logisches Schema

| Tabelle | Wesentliche Felder | Regeln |
| --- | --- | --- |
| `users` | id, display_name, contact_email, contact_email_verified, role, role_source, status, authz_generation, created_at | Stabile interne Identität; E-Mail ist kein globaler Identitätsschlüssel |
| `local_credentials` | user_id, login_email_normalized, password_hash, enabled, mfa_secret_id | Nur lokale Konten; Login-E-Mail hier eindeutig; SSO erzeugt keinen Passwortdatensatz |
| `oidc_providers` | id, issuer, client_id, secret_id, config_generation, enabled, claim_mapping, capabilities | Adminverwaltet; genaue Issuer-/Redirect- und Algorithmusbindung |
| `external_identities` | id, user_id, provider_id, issuer, subject, last_login_at, last_claims_at | Unique(issuer, subject); kein automatisches E-Mail-Linking |
| `identity_lifecycle` | identity_id, provider_id, upstream_id, external_id, provider_state, app_assignment, verified_at, generation | Lokale Sperre und externe Freigabe getrennt; frischer Status aus autoritativer Prüfung |
| `provisioning_credentials` | provider_id, token_hash, scopes, rotated_at, revoked_at | Nur Identity-/SCIM-Rechte; kein Zugriff auf Medien oder Benutzersecrets |
| `provisioning_operations` | provider_id, resource_id, operation_hash, received_at, result, sync_generation | Wiederholungen und Reihenfolge nachvollziehbar; keine kompletten Tokens/Claims |
| `runtime_policies` | id, generation, limits_json, changed_by, changed_at | Validierte Admin-Limits; Revision atomar aktivieren |
| `oidc_login_attempts` | id, state_hash, nonce_hash, verifier_secret, provider_generation, expires_at, consumed_at | Kurzlebiger browsergebundener Code-/PKCE-Vorgang; keine Tokens in Logs |
| `sessions` | id_hash, user_id, identity_id, remote_sid, auth_time, authz_generation, expires_at, revoked_at | Serverseitige Sitzung; lokale und externe Herkunft erkennbar |
| `logout_receipts` | provider_id, token_jti, expires_at | Verifiziertes Back-Channel-Logout gegen Wiederholung absichern |
| `auth_tokens` | token_hash, user_id, purpose, expires_at, consumed_at | Einmalige Einladung, E-Mail-Verifikation oder Reset |
| `notification_preferences` | user_id, category, enabled, digest_mode, updated_at | Kategoriebezogen; bei Versand erneut prüfen |
| `secrets` | id, owner_id, kind, ciphertext, nonce, key_version | Kein Klartext; kein Benutzer-Leseendpunkt |
| `source_accounts` | id, owner_id, adapter_id, secret_id, status | Ein Konto gehört genau einem Benutzer |
| `creators` | id, owner_id, platform, external_id, display_name | Unique(owner, platform, external_id) |
| `posts` | id, owner_id, platform, external_id, creator_id, canonical_url | Stabiler Quellschlüssel; URL ohne Auth-Parameter |
| `post_revisions` | id, owner_id, post_id, revision_key, title, text, source_time, discovered_at, metadata_json | Historische Snapshots; begrenztes, bereinigtes JSON |
| `assets` | id, owner_id, revision_id, source_asset_key, variant_key, kind, role, blob_id, logical_path, template_version | Unique(owner, revision, source_asset_key, variant_key); IDs wichtiger als Dateinamen |
| `blobs` | id, owner_id, sha256, byte_size, detected_mime, state | Unique(owner, sha256, byte_size); Datensatz bleibt nach lokaler Entfernung |
| `storage_profiles` | id, backend, layout, root_config, generation, status, user_selectable | Adminverwaltet; nur freigegebene Profile für Benutzer auswählbar |
| `storage_copies` | id, owner_id, blob_id, profile_id, storage_key, generation, state, size_verified_at | CAS/DB teilen Kopien; Template-Layout darf je physischem Pfad eine eigene Kopie führen |
| `asset_storage_refs` | owner_id, asset_id, copy_id, retain_local | Referenzen und Behaltewünsche unabhängig vom Blob |
| `blob_chunks` | copy_id, sequence_no, payload, chunk_sha256 | Nur DB-Modus; PK(copy_id, sequence_no) |
| `storage_writes` | id, owner_id, copy_id, job_id, lease_generation, bytes_written, expires_at | Noch nicht sichtbare Teilobjekte |
| `path_templates` | id, owner_id, name, template, version | Versionierte eingeschränkte Grammatik |
| `subscriptions` | id, owner_id, source_account_id, canonical_target, policy_version, enabled | Creator/Feed/Playlist oder einzelner Zieltyp |
| `schedules` | id, owner_id, subscription_id, cron, timezone, next_run_at, misfire_policy, version | UTC-Ausführungszeit plus IANA-Zeitzone |
| `job_runs` | id, owner_id, schedule_id, scheduled_for, idempotency_key, state, lease_generation, cancel_requested_at | Logischer Auftrag, unabhängig von Queue-Aufbewahrung |
| `job_attempts` | id, run_id, started_at, ended_at, adapter_version, error_code, safe_detail | Fehlerdetail ohne Tokens/HTML-Dumps |
| `outbox_events` | id, event_type, aggregate_id, payload, dispatched_at | Fachänderung und Outbox in einer Transaktion |
| `immich_connections` | id, owner_id, endpoint_id, secret_id, remote_user_id, server_version, config_generation | Konto-/Zielwechsel erhöhen Generation |
| `immich_transfers` | id, owner_id, blob_id, connection_id, config_generation, state, idempotency_key, remote_asset_id | Ein eindeutiger Transfer je Inhalt/Zielgeneration |
| `transfer_verifications` | transfer_id, method, local_sha256, remote_sha256, byte_size, checked_at, result | Unveränderlicher Prüfbeleg |
| `cleanup_intents` | id, owner_id, copy_id, expected_generation, expected_authz_generation, transfer_id, policy_version, not_before, state | Vor physischer Entfernung persistiert; Kontosperre invalidiert Freigabe |
| `history_events` | id, owner_id, subject_id, event_type, occurred_at, correlation_id, snapshot_json | Normalbetrieb append-only; kein Cascade von Speicherkopien |
| `audit_events` | id, actor_id, action, target_id, occurred_at, outcome | Sicherheits-/Adminereignisse getrennt von Benutzer-History |

Die Tabelle `assets` referenziert optional einen Vorgänger bzw. `derived_from_asset_id`, um Vorschauen und Konvertierungen vom Original zu unterscheiden. Ein Post kann viele Assets und Revisionen haben. Ein Transfer darf deshalb nicht pauschal den ganzen Post als lokal entfernbar markieren.

Im Schreib-Staging darf `storage_copies.blob_id` noch leer sein. `storage_writes` und Chunks referenzieren dann nur die provisorische Kopie. Erst nach vollständiger Hashberechnung wird ein fertiges Blob angelegt oder gefunden und die Kopie zugeordnet. Eine Check-Constraint verlangt für `available` eine Blob-ID und vollständige Größen-/Integritätsdaten. Ein bereits bekanntes Blob kann trotzdem eine neue Kopie benötigen, wenn das gewünschte Speicherprofil oder ein zusätzlicher Template-Pfad noch nicht existiert. So müssen noch unbekannte Hashes nicht als erfundene endgültige Identitäten gespeichert werden.

### Indizes und Löschregeln

- `history_events(owner_id, occurred_at DESC, id)` für Cursor-Pagination.
- `assets(owner_id, revision_id)`, `posts(owner_id, platform, creator_id)` sowie fachliche Unique-Indizes.
- `job_runs(state, next_attempt_at)` und `schedules(enabled, next_run_at)` für fällige Arbeit; entsprechende zusätzliche Spalten sind in den Migrationen anzulegen.
- `storage_copies(state, profile_id)`, `cleanup_intents(state, not_before)` und `immich_transfers(owner_id, state)`.
- `ON DELETE RESTRICT` zwischen History-relevanten Identitäten und Speichermetadaten. Nur Chunk-Nutzdaten dürfen beim endgültigen Entfernen ihrer Kopie gezielt mitgelöscht werden.
- Referenzzähler dürfen als Cache dienen. Vor Löschung werden tatsächliche Referenzen unter Sperre erneut geprüft.

## 3. Datenbankmodus: Binärdaten wirklich in der DB

Medien liegen als `bytea`-Chunks von anfänglich **4 MiB** in `blob_chunks`. Kein Base64: Es vergrößert Nutzdaten unnötig. Ein einzelnes `bytea`-Feld für ein ganzes großes Video wird vermieden; PostgreSQL begrenzt TOAST-fähige Einzelwerte. Quelle: [PostgreSQL TOAST](https://www.postgresql.org/docs/current/storage-toast.html).

Schreibprotokoll:

1. `storage_write` und `storage_copy(state=writing)` anlegen, Quote reservieren.
2. Eingehende Bytes in begrenzten Puffern hashen und chunkweise speichern. Ein oder wenige Chunks pro kurzer Transaktion; keine stundenlange Transaktion über den gesamten Download.
3. Backpressure bis zur Netzwerkquelle weitergeben. Nie `Buffer.concat()` über die ganze Datei.
4. Nach Ende Sequenzvollständigkeit, tatsächliche Bytezahl, Hash und Quellstatus prüfen.
5. Bei gleichem Hash unter derselben Benutzer-ID das existierende Blob referenzieren; bei parallelem Konflikt den fertigen Gewinner nutzen und das eigene Staging später entfernen.
6. Finale Zuordnung, `copy=available`, Assetstatus und History in einer Transaktion veröffentlichen. Vorher sind Teilobjekte für Leser unsichtbar.

Lesen erfolgt geordnet und mit begrenzter Vorabladung. Byte-Range-Anfragen ermitteln betroffene Chunks und schneiden nur den ersten/letzten Chunk zu. Immich-Multipart-Uploads lesen denselben Stream; eine Temp-Datei ist dafür nicht grundsätzlich erforderlich.

Wenn ein externer Downloader für Muxing/Resume lokale Dateien benötigt, bleiben diese befristete, quotierte Staging-Daten. Der DB-Modus bedeutet „dauerhafte Nutzdaten in der Datenbank“, nicht „unter allen Umständen null temporäre Dateisystemnutzung“.

**Betriebsfolgen:** Binärdaten erhöhen WAL-, Replikations- und Backupvolumen. Kompression für bereits komprimierte Medienspalten anhand von Messungen begrenzen, nicht pauschal maximale TOAST-Kompression einschalten. Nach `DELETE` ist Speicher für spätere DB-Nutzung wiederverwendbar; die Datenbankdateien schrumpfen nicht zwingend sofort. `VACUUM FULL` ist wegen Sperren kein automatischer Routinejob. Quelle: [Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html).

## 4. Dateisystemmodus und frei wählbare Struktur

Der Admin legt einen verwalteten Root fest. Darunter erhält jeder Benutzer einen unveränderlichen Namespace, beispielsweise `/data/library/u_42/`. Benutzer dürfen nur den Pfad darunter gestalten. Unter Windows wäre der Root beispielsweise `D:\DownloaderData\library`.

Beispielvorlagen:

```text
{platform}/{creator_slug}--{creator_id}/{post_id}/{index:03}--{asset_id}.{ext}
{platform}/{creator_slug}/{post_slug}--{post_id}/{filename_stem}--{asset_id}.{ext}
{year}/{month}/{platform}/{creator_slug}/{post_id}/{index:03}.{ext}
{creator_slug}--{creator_id}/{platform}/{post_id}/{index:03}.{ext}
```

Beispielauflösung: `pixiv/artist-name--12345/98765/001--a_678.jpg`. Die UI kann dies lesbarer als „Pixiv → Artist Name → Post 98765 → Bild 1“ darstellen. Rohnamen bleiben in Metadaten erhalten.

### Regeln des Vorlageneditors

- Erlaubt sind ausschließlich fest definierte Felder und wenige Formatierungen wie `index:03`; kein JavaScript, Shell, Jinja oder frei ausführbarer Ausdruck.
- Fehlende Werte erhalten stabile Fallbacks wie `unknown-creator--<id>`; Zeitzone für Datumsteile ist Teil der Vorlagenversion.
- Titel werden Unicode-normalisiert und von Trennzeichen, Steuerzeichen, `..`, absoluten Pfaden, Laufwerkspräfixen und UNC-Pfaden bereinigt.
- Windows-Gerätenamen, Doppelpunkte/Alternate Data Streams, nachgestellte Punkte/Leerzeichen sowie Kollisionen auf Dateisystemen ohne Groß-/Kleinschreibung werden abgefangen.
- Segment- und Gesamtlängen begrenzen; bei Kürzung stabilen ID-Suffix erhalten. Die effektive Root-Länge zählt mit.
- Zielpfade werden innerhalb des erlaubten Roots aufgelöst. Symlinks, Junctions und Reparse-Points aus unkontrollierten Bereichen werden nicht verfolgt.
- Bei Namenskollision niemals überschreiben; deterministischer Asset-Suffix oder expliziter Konfliktstatus.

### Physische Speicherung und Deduplizierung

Aus Quelle B werden zwei klar unterscheidbare Layouts übernommen. Ein Admin wählt das Layout pro Dateisystemprofil; die UI zeigt die Folgen bereits in der Pfadvorschau.

| Layout | Physische Ablage | Deduplizierung / Konsequenz |
| --- | --- | --- |
| `template` – Standard | Jeder archivierte Assetpfad liegt tatsächlich unter der gewählten Benutzerstruktur | Keine erneute Speicherung desselben Assetlaufs; identische Bytes an unterschiedlichen Pfaden können zusätzliche Kopien benötigen |
| `cas` | Beispielsweise `u_42/objects/ab/cd/<sha256>`; Metadaten liefern Dateiendung und Anzeigenamen | Eine aktive Kopie pro Benutzer, Hash und Profil; gewünschte Struktur existiert in Katalog/UI/Export |
| DB-Backend | Chunks, keine physischen Benutzerordner | Deduplizierung wie CAS, virtuelle Pfade und expliziter Export |

Die fachliche Blobidentität bleibt in beiden Layouts gleich. `storage_copies` beschreibt echte Speicherorte, nicht bloß logische Aliase: mehrere Template-Dateien desselben Blobs erhalten mehrere Copy-IDs. Eine Bereinigung entfernt nur die freigegebene Kopie. CAS-/DB-Kopien können dagegen mehrere `asset_storage_refs` besitzen und bleiben erhalten, solange eine dieser Referenzen sie benötigt.

Pfadidentität ist Unique(profile_id, owner_id, normalized_storage_key); Normalisierung berücksichtigt das Zielfilesystem. Für aktive CAS-/DB-Kopien gibt es zusätzlich eine transaktional abgesicherte Eindeutigkeit je Blob und Profil. Die spätere SQL-Migration muss Layoutinformationen dafür konsistent verfügbar machen; eine CHECK-Constraint darf nicht heimlich andere Tabellen abfragen.

Hardlinks/Reflinks sind **keine V1-Voraussetzung**. Eine spätere Optimierung benötigt Tests je Volume/Dateisystem, unveränderliche verwaltete Dateien und eine eigene Erfassung gemeinsam belegter physischer Bytes. Ungeprüfte Hardlinks über Benutzergrenzen oder beschreibbare Freigaben werden nicht übernommen. Im Template-Modus wird deshalb keine perfekte physische Deduplizierung versprochen. Wer minimale Dublettenspeicherung bevorzugt, wählt CAS oder DB.

Dateien werden zunächst unter einem zufälligen, privaten Staging-Namen auf demselben Volume geschrieben. Nach Hashprüfung und Flush erfolgt ein atomarer Rename auf einen reservierten Zielpfad, soweit das Betriebssystem dies unterstützt. Ein persistierter Schreib-Intent erlaubt den Wiederabgleich nach einem Crash zwischen Rename und DB-Commit. Verwaltete Dateien werden extern nicht geändert; eine Prüfsummenabweichung führt zur Quarantäne.

## 5. Qualitätserhaltung

| Inhalt | Aufbewahrung |
| --- | --- |
| Einzelbild | Zugängliche Originaldatei unverändert einschließlich eingebetteter Metadaten |
| Progressive Videodatei | Unveränderte zugängliche Datei |
| Getrennte Video-/Audiospuren | Beste gewählte Spuren; optional verlustfreies Remuxing in geeigneten Container |
| HLS/DASH | Gewählte Repräsentation und Qualitätsparameter protokollieren; Segmentquellen/Manifest nach Profil erhalten |
| Pixiv Ugoira | Quellarchiv, Einzelbildreihenfolge und Timingdaten als zusammengehörige Originalgruppe |
| HTML-Seite | Antwortinhalt und bereinigte Metadaten, optional begrenzte statische Ressourcen; aktive Skripte nicht ausführen |
| Beschreibung/Metadaten | Text bzw. JSON als Katalogdaten; keine Auth-Header, Cookies oder signierten Download-URLs dauerhaft archivieren |

„Original“ heißt die von der Quelle zugänglich gemachte Repräsentation, nicht zwangsläufig die Datei vor der Plattformkompression. Remuxing erhält codierte Audio-/Videodaten, ändert jedoch die Containerbytes und damit den Dateihash. Für strenge Bytearchivierung ist das Profil `SOURCE_BYTES` vorgesehen; bei `BEST_AVAILABLE` kann ein ohne Neukodierung zusammengesetztes Video das kanonische Ergebnis sein. Qualität und Profil stehen im Manifest. Kein stiller Fallback auf eine niedrigere Qualität: Nutzerentscheidung oder `QUALITY_UNAVAILABLE`.

Vorschaubilder sind ausdrücklich Ableitungen und dürfen stärker komprimiert sein. Ihre Existenz ersetzt niemals das Original. Text/HTML kann verlustfrei komprimiert werden; nach Dekompression muss die gespeicherte Original-Prüfsumme stimmen. Medien werden nicht allein zur Platzersparnis erneut codiert.

## 6. Kapazität, Quoten und Speicherbedarf

Planungsformel für die physische Ablage:

```text
Bedarf ≈ physische Originalkopien + Vorschauen + Staging + Sicherheitsreserve
Originalkopien bei CAS/DB ≈ eindeutige Bytes je Benutzer und Speicherprofil
Originalkopien bei template ≈ Summe der tatsächlich angelegten Dateien
Staging für Remuxing ≈ Eingabespuren + Ausgabedatei je gleichzeitigem Job
```

Beispiel für CAS/DB, kein Benchmark: 100 GB Medien bei 20 % byteidentischen Dubletten ergeben etwa 80 GB Originaldaten plus Metadaten, Vorschauen und Staging. Zwei parallele große Muxing-Aufträge können trotzdem kurzfristig erheblich mehr Platz brauchen. Im Template-Layout können zusätzliche physische Kopien den Dedup-Vorteil reduzieren. Im DB-Modus kommen Tabellen-/Index-Overhead und WAL hinzu; Backups werden separat dimensioniert.

Quoten beziehen sich auf logisch zugeordnete Medien eines Benutzers. Physisch belegte Bytes einschließlich zusätzlicher Template-Kopien werden zusätzlich angezeigt. Vor Aufträgen wird Speicher reserviert; bei unbekannter Größe wächst die Reservierung bis zur Grenze. Bei Erreichen stoppen neue Downloads kontrolliert. Freier Speicher, DB-Volume und Temp-Volume werden getrennt überwacht.

## 7. Backend- und Strukturmigration

Eine Admin-Umschaltung ändert zunächst nur das Ziel **neuer** Downloads. Bereits vorhandene Kopien behalten ihr Profil. Ein separater Migrationsjob erstellt pro Blob ein Manifest der betroffenen Referenzen, Quellkopien und benötigten Zielpfade:

1. Objekt, Referenzen und Generation festhalten, Uploads/Cleanup für dieses Objekt koordinieren. Kapazität für alle Zielkopien vorab reservieren.
2. Benötigte Zielkopien anlegen und jede mit SHA-256 und Bytezahl vollständig prüfen. Template→CAS darf identische Kopien zusammenführen; CAS→Template legt für verschiedene gewünschte Pfade die nötigen physischen Dateien an.
3. Die betroffenen Referenzen transaktional den jeweils geprüften Zielkopien zuordnen; History schreiben. Bis alle für diesen Umschaltvorgang benötigten Zielkopien geprüft sind, bleibt die bisherige Zuordnung gültig.
4. Alte Kopien nach Frist und nur ohne verbleibende Referenz oder aktive Leser entfernen. Eine gemeinsam genutzte Quellkopie bleibt erhalten, solange noch andere Referenzen darauf zeigen.

Unterbrechungen sind fortsetzbar; kein pauschales „Pfad in DB ersetzen“. Strukturmigrationen verwenden dasselbe Muster. Bei identischen Blobs ist die gemeinsame physische Kopie zu berücksichtigen. Netzwerkfreigaben mit unklaren Rename-/Lock-Eigenschaften sind vor Verwendung gesondert zu testen.

## 8. Konkrete Datenverträge für die Entwicklung

Aus Quelle B wird die Konkretisierung durch SQL übernommen, jedoch mit stabilen OIDC-Identitäten und Benutzertrennung. Die folgenden Ausschnitte zeigen **ausgewählte Constraints**, keine vollständige ausführbare Anfangsmigration. Alle Tabellen aus Abschnitt 2, Rollen, Indizes, Zeitstempel und Migrationen sind zusätzlich umzusetzen. UUIDs werden von der Anwendung erzeugt; eine besondere PostgreSQL-Erweiterung wird dafür nicht vorausgesetzt.

```sql
CREATE TABLE oidc_providers (
  id uuid PRIMARY KEY,
  issuer text NOT NULL,
  client_id text NOT NULL,
  config_generation bigint NOT NULL DEFAULT 1,
  enabled boolean NOT NULL DEFAULT false,
  UNIQUE (id, issuer)
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  display_name text NOT NULL,
  contact_email text,
  contact_email_verified boolean NOT NULL DEFAULT false,
  role text NOT NULL CHECK (role IN ('user', 'admin')),
  role_source text NOT NULL CHECK (role_source IN ('local', 'oidc')),
  role_provider_id uuid REFERENCES oidc_providers(id),
  status text NOT NULL CHECK (status IN ('active', 'blocked', 'pending')),
  authz_generation bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((role_source = 'oidc') = (role_provider_id IS NOT NULL))
);

CREATE TABLE local_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  login_email_normalized text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE external_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_id uuid NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  last_login_at timestamptz,
  UNIQUE (issuer, subject),
  FOREIGN KEY (provider_id, issuer)
    REFERENCES oidc_providers(id, issuer) ON DELETE RESTRICT
);

CREATE TABLE blobs (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  detected_mime text NOT NULL,
  UNIQUE (owner_id, id),
  UNIQUE (owner_id, sha256, byte_size)
);

-- Eigentümerbindung; storage_profiles ist hier vorausgesetzt.
CREATE TABLE storage_copies (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  blob_id uuid,
  profile_id uuid NOT NULL REFERENCES storage_profiles(id),
  normalized_storage_key text NOT NULL,
  generation bigint NOT NULL DEFAULT 1,
  state text NOT NULL CHECK
    (state IN ('writing', 'available', 'delete_pending', 'removed', 'quarantined')),
  verified_bytes bigint,
  size_verified_at timestamptz,
  UNIQUE (owner_id, id),
  UNIQUE (profile_id, owner_id, normalized_storage_key),
  FOREIGN KEY (owner_id, blob_id) REFERENCES blobs(owner_id, id),
  CHECK (state <> 'available' OR
    (blob_id IS NOT NULL AND verified_bytes IS NOT NULL
     AND size_verified_at IS NOT NULL))
);

CREATE TABLE blob_chunks (
  copy_id uuid NOT NULL REFERENCES storage_copies(id) ON DELETE RESTRICT,
  sequence_no bigint NOT NULL CHECK (sequence_no >= 0),
  payload bytea NOT NULL CHECK (octet_length(payload) <= 4194304),
  chunk_sha256 bytea NOT NULL CHECK (octet_length(chunk_sha256) = 32),
  PRIMARY KEY (copy_id, sequence_no)
);
```

Issuer und Subject werden exakt und case-sensitive gespeichert und verglichen; eine abweichende DB-Collation darf diese Eigenschaft nicht aufheben. E-Mail-Normalisierung gilt ausschließlich für lokale Loginnamen nach festgelegter Policy, nicht für OIDC-Subjects. Hashes beschreiben unkomprimierte Originalbytes; zusätzliche Speicherungskompression braucht separate `encoding`-/`stored_size`-Metadaten und transparentes Dekomprimieren vor Download/Immich.

`verified_bytes` muss beim Finalisieren mit der Blobgröße verglichen werden. Constraints ersetzen keine Hashkontrolle; ein FK prüft nicht automatisch die aktuelle Sessionberechtigung. DB-Rollen und der zentrale Eigentümerfilter bleiben notwendig. Für entfernte Kopien bleibt ein Tombstone; erneutes Schreiben verwendet eine neue Objektgeneration und einen kontrollierten Übergang.

## 9. Suche, Vorschauen und Speicherprofile

Übernommen werden eine owner-begrenzte Volltextsuche über Creator, Titel und bereinigte Beschreibung sowie optionale Mini-Vorschauen in der History. PostgreSQL-Textsuche mit passenden GIN-Indizes ist als erste Ausbaustufe geplant; Ergebnisfilter bleiben immer benutzerbezogen. Der Umfang der Suchspalten wird an den gemessenen Datenmengen ausgerichtet.

Vorschauen sind eigene Ableitungen mit separater Aufbewahrung. Richtwert: längste Kante höchstens 320 px, Zielbudget 20 KiB; lässt sich das nicht sinnvoll erzeugen, wird ein Platzhalter verwendet. Es besteht keine garantierte Kompressionsquote. Decoder laufen unter Pixel-, Zeit- und RAM-Limits. Benutzer können Vorschauen nach Originalentfernung abschalten; der Admin darf strengere Vorgaben setzen.

Der Admin kann mehrere Speicherprofile freigeben, beispielsweise DB für eine kleine Sammlung und Dateisystem für große Videos. Benutzer wählen nur `user_selectable`-Profile, keine freien Pfade. Automatische größenabhängige Routingregeln sind eine spätere Erweiterung; Version 1 speichert das gewählte Ziel explizit pro Auftrag. Quotenmeldungen bei beispielsweise 80 % und 100 % werden in der UI immer angezeigt und per E-Mail nur nach Opt-in versandt.


## 10. Sperrsynchronisation und Konfigurationsrevisionen

`users.status` bleibt die lokale administrative Entscheidung. `identity_lifecycle.provider_state` bildet `active`, `disabled`, `unassigned`, `deleted` oder `unknown` ab. Effektiv freigegeben ist ein externes Konto nur bei lokaler Freigabe, zulässiger aktueller Anbieterzuordnung und Statusfrische innerhalb der Policy. Eine IdP-Reaktivierung überschreibt niemals eine lokale Adminsperre.

SCIM-`id` ist die vom Downloader vergebene Ressourcen-ID; `externalId` und `upstream_id` beschreiben die ausdrücklich konfigurierte Anbieterzuordnung. Unique(provider_id, external_id) sowie Unique(provider_id, upstream_id) verhindern Mehrdeutigkeit. Eine Zuordnung zu `(issuer, sub)` muss verifiziert sein; keine Suche nach ähnlicher E-Mail. Provider- und Benutzerbezüge erhalten passende Fremdschlüssel.

Eine wirksame Sperre aktualisiert Status und `authz_generation`, widerruft Sitzungen und erzeugt den Job-Stopp-/Audit-Outbox-Eintrag in einer Transaktion. Wiederholte Sperrereignisse sind idempotent. API und Worker prüfen die maßgebliche Generation; der Lifecycle-Worker benutzt einen separaten Pool. Ein ausgefallener Worker darf Statusfrische nicht künstlich verlängern. Cacheeinträge laufen spätestens mit `verified_at + staleAfterSeconds` ab.

Für Jobs wird die konfigurierte Policy-Revision protokolliert. Verschärfte Sicherheits-/Sperrregeln gelten trotzdem sofort; normale Parallelitätsänderungen steuern die nächste Vermittlung. Admin-Limits sind keine Benutzerrechte, mit denen eine Sperre umgangen werden kann. Die SQL-Ausschnitte in Abschnitt 8 sind weiterhin nur ausgewählte Constraints und müssen um diese Tabellen ergänzt werden.
