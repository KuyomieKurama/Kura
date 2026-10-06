# 04 – Downloader, Plattformen und Zeitpläne

## 1. Integrationsstrategie

Der Kern kennt normalisierte Creator, Posts, Revisionen und Assets. Ein Adapter übersetzt eine Plattform in dieses Format und liefert Downloadreferenzen bzw. Bytes. Plattformcookies, Qualitätswahl und Pagination bleiben Adapteraufgaben. Speicherort, History, Immich und E-Mail-Versand gehören nicht in den Adapter.

Zwei Auslieferungsprofile sind vorgesehen:

| Profil | Inhalt | Auswirkung |
| --- | --- | --- |
| Basis | Eigener MIT-Code, geprüfte Bibliotheken, eigener Direct-HTTP-/HTML-Adapter | Gut kontrollierbar; benannte Plattformen erst nach eigener Adapterentwicklung freigegeben |
| Erweiterte Quellen | Vom Betreiber separat bereitgestellte, ausdrücklich freigegebene externe Downloader | Größere Reichweite; zusätzliche Lizenz- und Laufzeitabhängigkeiten |

Gewählt ist das Profil „Erweiterte Quellen“ mit sauber getrennten Prozessen. Der Benutzer hat die vorgeschlagene Nicht-MIT-Strategie akzeptiert; externe Downloader werden zunächst vom Betreiber separat installiert. Ein externer Prozess ist jedoch kein automatischer Freibrief für Lizenzpflichten. Kein gallery-dl-/FFmpeg-Binary wird stillschweigend Teil eines „MIT-only“-Installers. Einzelheiten: [09](09_Lizenzen_und_Quellen.md).

## 2. Plattformmatrix

Status bedeutet hier **Planungskandidat**, nicht erfolgreich getestete Integration. Dokumentierte Extractor-Unterstützung muss mit berechtigten Testkonten und der ausgewählten Version praktisch nachgewiesen werden.

| Plattform | Geplanter Inhalt | Kandidat im erweiterten Profil | Besonderheiten / Freigabebedingung |
| --- | --- | --- | --- |
| YouTube | Einzelvideo, Playlist, Kanal je Fähigkeit | yt-dlp | Höchste zugängliche Video-/Audiospur; gegebenenfalls JS-Laufzeit und Muxer; keine DRM-Umgehung |
| Instagram einschließlich Reels | Posts, Bilder und Reels; weitere Typen später | gallery-dl; yt-dlp für geeignete Einzelvideos | Zugriff und Sitzung abhängig; Profile getrennt testen, kein pauschaler Vollständigkeitsanspruch |
| Patreon | Zugängliche Creator-Posts, Anhänge, Medien | gallery-dl; yt-dlp für geeignete Videos | Berechtigtes Konto/Abonnement; eingebettete Drittanbieter benötigen eigenen Adapter |
| Pixiv | Illustrationen, mehrseitige Posts, Ugoira-Quellen | gallery-dl | Originalgruppe mit Timingdaten; Vorschaukonvertierung getrennt |
| Pornhub | Videos; Bildgalerien separat | yt-dlp; gallery-dl für gelistete Bildinhalte | Als „PH“ bestätigt; regionale/Konto-Zugriffe und konkrete URL-Typen getrennt testen |
| Weitere ähnliche Videoportale | Videos je freigegebenem Anbieter | Passender getesteter Extractor | Erweiterbarer Zielumfang; keine pauschale Freigabe sämtlicher Domains |
| Direkte Medien-URL | Bilder/Videos/Anhänge über HTTPS | Eigener Adapter | MIME-/Größenprüfung, Redirect- und Netzwerkregeln |
| Allgemeine Webseite | HTML-Snapshot, begrenzte Ressourcen | Eigener Adapter | Anfangs ohne Headless Browser und ohne rekursives Crawling |

Belege für Kandidaten: [gallery-dl Supported Sites](https://gdl-org.github.io/docs/supportedsites.html), [yt-dlp Supported Sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md). Die gelesene yt-dlp-Liste kennzeichnet beispielsweise `instagram:user` als defekt. Deshalb wird Profilunterstützung nicht aus der Existenz eines Instagram-Einzelvideo-Extractors abgeleitet.

Die Laufzeitanforderungen von yt-dlp können zusätzliche Komponenten umfassen; für den ausgewählten YouTube-Weg insbesondere die dokumentierte JavaScript-Unterstützung prüfen. Quelle: [yt-dlp Dependencies](https://github.com/yt-dlp/yt-dlp#dependencies). Jede solche Komponente wird gepinnt und in das Lizenzinventar aufgenommen.

## 3. Adaptervertrag

```typescript
interface SourceAdapter {
  capabilities(): AdapterCapabilities;
  validateTarget(url: string): CanonicalTarget;
  probe(context: ProbeContext): Promise<SourceSummary>;
  discover(context: DiscoveryContext): AsyncIterable<SourcePost>;
  resolveAssets(post: SourcePost, policy: QualityPolicy): Promise<AssetManifest>;
  download(asset: ResolvedAsset, context: DownloadContext): AsyncIterable<Uint8Array>;
}
```

Ein CLI-Adapter darf alternativ kontrollierte Staging-Dateien liefern. Ein vertrauenswürdiger Importer übernimmt deren Prüfung. Das normalisierte Manifest enthält Plattform-ID, Creator-/Post-ID, Quellrevision, Asset-ID/Index, Originalnamen, Medientyp, Variante, Qualitätsparameter und Vollständigkeitsstatus. Flüchtige signierte URLs bleiben nur im kurzfristigen Auftragskontext.

### Fähigkeiten statt impliziter Annahmen

Ein Adapter deklariert beispielsweise `single_post`, `creator_feed`, `pagination`, `resume`, `images`, `videos`, `page_snapshot`, `auth_kind` und `quality_variants`. Die UI blendet nur vorhandene Fähigkeiten ein. Es gibt einen Kill-Switch je Adapterversion und Quelltyp. Ein fehlerhafter Anbieter darf andere Quellen nicht blockieren.

### Externe Prozessausführung

- Feste, administrativ installierte Programme mit geprüftem Hash; keine frei eingebbaren Programmpfade oder Optionen für Benutzer.
- `spawn` mit Argumentliste und ohne Shell. URLs werden als Werte behandelt; Option-Injection und Konfigurationsübernahme vermeiden.
- Eigene minimale Umgebung und privates Arbeitsverzeichnis; keine globalen Browserprofile, Home-Konfigurationen, Plugin-Suchpfade oder selbstständigen Tool-Updates.
- Zugangsdaten bevorzugt per geschütztem Kanal; falls Cookie-Datei erforderlich, restriktive ACL, kurzer Lebenszyklus und garantierte Bereinigung.
- Begrenzte Laufzeit, Ausgabegröße, CPU, RAM, Prozesse und Temp-Platz. Ausgaben gelten als untrusted input.
- Netzwerkgrenzen gelten auch für Redirects, CDN-Aufrufe, Playlists und eingebettete Ressourcen. Ein API-seitiger URL-Check allein genügt nicht.

## 4. Download-Lebenszyklus

Fachliche Zustände: `queued → discovering → downloading → verifying → stored`. Ergänzend `waiting_auth`, `waiting_rate_limit`, `retry_wait`, `paused`, `cancelled`, `failed` und `partially_completed`.

Der Abschluss wird pro Asset geführt. Ein Post mit fünf Medien und einem fehlgeschlagenen Download ist teilweise fertig; vier erfolgreiche Dateien müssen nicht neu geladen werden. Eine Discovery-Markierung bedeutet noch keinen erfolgreichen Download. Ein fehlerhaftes Cookie darf nicht als „Creator ohne neue Posts“ erscheinen.

### Inkrementelle Synchronisierung

1. Stabile externe IDs und bekannten Cursor verwenden, sofern verlässlich.
2. Überlappungsfenster für verspätete Posts und Änderungen; optional regelmäßiger begrenzter Rückscan.
3. Manifest mit bisherigen Revisionen vergleichen. Unveränderter, bereits archivierter Inhalt wird übersprungen, auch wenn seine lokale Kopie nach Immich entfernt wurde.
4. Neue Quellrevision erzeugt neue Assetversion; Historie und frühere Prüfsummen bleiben erhalten.
5. Eine erfolgreiche Enumeration setzt den Cursor fort. Fehlerhafte Pagination setzt ihn nicht über unbekannte Inhalte hinweg.

Nicht jede Plattform liefert Änderungen historischer Posts oder eine beweiskräftige Versionskennung. Deshalb heißt der UI-Status „bis zu diesem Zeitpunkt erfolgreich geprüft“, nicht „garantiert vollständiges Archiv“. ETag und Last-Modified sind Downloadhilfen, keine universell verlässliche Inhaltsidentität.

## 5. Zeitpläne

Unterstützt werden sofortiger Start, ein einzelner Zeitpunkt und wiederkehrende Ausführung. Benutzer wählen einen einfachen Tages-/Wochenplan; fortgeschrittene Benutzer können einen validierten **fünffeldrigen Cron-Ausdruck** nutzen. Eine Vorschau zeigt die nächsten fünf Läufe einschließlich Zeitzone und UTC-Offset.

| Regel | Vorgabe |
| --- | --- |
| Zeitzone | IANA-Name wie `Europe/Berlin`, nicht nur `UTC+1` |
| Speicherung | Geplanter Zeitpunkt in UTC plus Originalregel und Zeitzone |
| Sommerzeit: Uhrzeit fehlt | Diesen lokalen Termin überspringen und in Vorschau kenntlich machen |
| Winterzeit: Uhrzeit doppelt | Einmal beim ersten Auftreten; zweites Auftreten derselben lokalen Planzeit unterdrücken |
| Server war aus | Standard `catch_up_once`: höchstens einen Nachhollauf, anschließend normal fortsetzen |
| Bereits laufender Auftrag | Standard zusammenfassen; kein paralleler Scan desselben Abonnements |
| Quellenlimits | Pro Plattform, Konto und Benutzer; niedrigstes erlaubtes Limit gewinnt |
| Fairness | Keine unbegrenzte Bevorzugung eines Benutzers mit vielen Abonnements |
| Pausieren | Neue Läufe stoppen; laufenden Job gesondert pausieren/abbrechen |
| Bearbeitung | Versionsnummer erhöht sich; bereits gestarteter Lauf behält seinen Konfigurationssnapshot |

cron-parser bietet Zeitzonenunterstützung; die obigen Produktregeln werden zusätzlich explizit getestet und dürfen nicht von zufälligen Bibliotheksdefaults abhängen. Quelle: [cron-parser](https://github.com/harrisiirak/cron-parser).

### Dauerhafte Erzeugung

Der Scheduler sperrt fällige Zeitpläne kurz und legt `job_run` plus Outbox transaktional an. Unique(schedule_id, schedule_version, scheduled_for_utc) verhindert doppelte Vermittlung desselben UTC-Termins. Für den Winterzeitfall wird zusätzlich die lokale Planzeit der jeweiligen Regelgeneration eindeutig geführt. Mehrere Schedulerinstanzen dürfen daher keine doppelten logischen Läufe erzeugen.

## 6. Wiederholungen und Grenzen

| Fall | Verhalten |
| --- | --- |
| Netzwerkabbruch / 5xx | Begrenzte Wiederholung, beispielsweise 30 s, 2 min, 10 min, 30 min plus Jitter |
| 429 | `Retry-After` beachten; Kontobudget drosseln und anschließend erneut versuchen |
| 401/403 oder Sitzung abgelaufen | Pausieren und Authentifizierung anfordern; kein unbegrenzter Retry |
| CAPTCHA / interaktive Challenge | `ACTION_REQUIRED`; keine automatische Umgehung |
| 404/410 | Nach Adapterklassifikation dauerhaft fehlend; bestehendes Archiv behalten |
| Speicher voll / Quote | Sicher pausieren; keine alternativen ungeprüften Speicherpfade |
| Hash-/Formatabweichung | Quarantäne und Fehler; niemals als fertig deklarieren |
| Worker stirbt | Lease läuft ab; anderer Worker übernimmt nach Zustandsabgleich |

HTTP-Range-Resume nur mit validiertem `Content-Range` und unveränderter Quellrepräsentation. Liefert der Server statt 206 eine ganze Datei oder ändern sich Validatoren, wird kontrolliert neu begonnen. HLS/DASH-Resume braucht stabile Segmentzuordnung; sonst ebenfalls Neustart. Teilobjekte mit gültiger Lease werden nie von der Staging-Bereinigung entfernt.


## 7. Konkreter Fetch-/Ingest-Vertrag

Die klare Übergabe aus Quelle B wird übernommen. Jeder CLI-Auftrag erhält einen eigenen Arbeitsbereich. Der Runner liefert Dateien unter `media/` und ein begrenztes `result.json`; Zugangsdaten liegen in einem gesonderten, vom Import ausgeschlossenen privaten Bereich. Das Manifest ist **nicht vertrauenswürdig**, auch wenn der Prozess Exit-Code 0 meldet.

Schemaausschnitt, kein bereits implementiertes Dateiformat:

```json
{
  "schemaVersion": 1,
  "jobId": "job-example",
  "leaseGeneration": 3,
  "adapterId": "pixiv",
  "adapterVersion": "pinned-version",
  "discoveryComplete": true,
  "items": [
    {
      "sourcePostId": "98765",
      "sourceAssetId": "page-0",
      "revisionKey": "source-revision-or-derived-key",
      "relativePath": "media/item-0001.jpg",
      "role": "original",
      "declaredBytes": 123456,
      "metadata": {"creatorId": "12345", "index": 1}
    }
  ],
  "errors": []
}
```

Der vertrauenswürdige Ingest prüft Job-/Leasebindung, Schemaversion, erlaubte Metadatenfelder, Dateianzahl, relative Pfade, Dateityp, tatsächliche Größe und Hash. Nur reguläre Dateien aus dem eigenen Staging werden übernommen. Symlinks, fremde Hardlinks, Geräte, Named Pipes, Credential-Dateien und unausgewiesene Zusatzdateien werden abgelehnt. Übergabe erfolgt nach beendetem bzw. kontrolliert quiesziertem Runner; dieser darf während der Hashprüfung keine Datei mehr austauschen.

Metadaten werden normalisiert und auf eine Allowlist reduziert. Vollständige ungefilterte Engine-Dumps aus Quelle B werden nicht in History oder Logs übernommen. Bei großen Creator-Feeds ist das Manifest seitenweise bzw. als begrenzter Record-Stream übertragbar; eine riesige JSON-Liste im RAM ist keine Voraussetzung.

## 8. Downloadarchiv, Presets und Vorlagen

Der Core erzeugt bei Bedarf ein **temporäres Engine-Archiv aus bereits committed History-Einträgen**. Das spart unnötige Requests. Die von einer Engine neu geschriebene Archivdatei ist nur ein Hinweis: Erst erfolgreicher Ingest markiert Inhalte in der maßgeblichen DB-History als gespeichert. Ein Crash nach Fetch darf keinen nie importierten Inhalt dauerhaft überspringen.

Engine-Schlüssel werden je Adapter auf Post, Revision und Variante abgebildet. Wenn eine Engine nur stabile Post-IDs archiviert, darf sie dadurch keine aktualisierte Revision unterdrücken; der Adapter muss gezielte Neubewertung erlauben. „Erneut herunterladen“ erzeugt einen neuen Auftrag mit einer scoped Ausnahme. Die globale History wird dafür weder gelöscht noch vorübergehend manipuliert.

| Preset | Bedeutung |
| --- | --- |
| `BEST_AVAILABLE` | Beste nach Adapterpolicy zugängliche Repräsentation; ohne verlustbehaftete Neukodierung |
| `SOURCE_BYTES` | Quelldateien bzw. Originalgruppen erhalten; Konvertierungen nur als getrennte Ableitung |
| `WITH_EXTRAS` | Gewähltes Originalprofil plus verfügbare Untertitel/Beschreibungen; Ergänzung, keine Qualitätsänderung |
| Explizites Größen-/Qualitätslimit | Optional später; deutlich als Nutzerentscheidung markieren, niemals stiller Fallback |

Die genaue Engine-Argumentliste wird für die gepinnte Version getestet. Keine freie Eingabe von Optionen oder Postprozessoren. Ein bestimmter Container wie MKV ist keine universelle Garantie, sämtliche gewünschten Originaleigenschaften abzubilden.

Die Pfadgrammatik aus 03 kann eine kleine feste Filterliste erhalten: `slug`, `lower`, `trunc:N`, `default:Text` und ausgewählte Datumsformate. Alle Filter werden vor der abschließenden Pfadsicherheitsprüfung angewandt; Ausgabe bleibt ein einzelnes Segment. Dynamische Filter, reguläre Ausdrücke aus Benutzereingaben und ausführbare Template-Engines sind ausgeschlossen. Stabile ID-Suffixe ersetzen laufende `(2)`-/`(3)`-Namen, damit parallele Jobs deterministisch bleiben.

## 9. Lastverteilung und Engine-Wartung

Zeitpläne können eine kleine konfigurierbare Startverzögerung zur Lastverteilung erhalten. Der berechnete Jitter wird einmal pro Lauf gespeichert; `scheduled_for` und Idempotenzschlüssel bleiben der ursprüngliche Termin. Wiederholungen ziehen nicht unbegrenzt neue Verzögerungen. Rate-Limits des Anbieters gelten unabhängig davon.

Engine-Updates werden in eine neue isolierte Umgebung installiert, mit Hash-/Lizenzprüfung und Vertragsfixtures geprüft und anschließend atomar für neue Jobs aktiviert. Laufende Jobs behalten ihre alte Version. Der Admin sieht Version, Freigabedatum, fehlgeschlagene Tests und Rollbackmöglichkeit. Eine freie Update-URL oder unbeaufsichtigte Installation aus dem Webinterface ist nicht vorgesehen.

Temporäre Credentials werden nach dem Job entfernt, unter restriktiven Rechten und möglichst auf verschlüsseltem oder flüchtigem Staging. „Überschreiben garantiert sichere Löschung“ wird wegen Caches, SSDs und Snapshots nicht versprochen. Langlebige Secrets gehören ausschließlich in den verschlüsselten Secret-Store.


## 10. Adminbestimmte Limits für 1–100 Benutzer

Es gibt keine feste Produktquote für die Anzahl heruntergeladener Dateien und keine unveränderliche Grenze gleichzeitiger Downloads. Die folgenden Werte sind ein **vorgeschlagener Konfigurationsvertrag**, keine lauffähige Konfigurationsdatei. `null` bedeutet bei optionalen Budgets „kein zusätzliches Betreiberlimit“; `0` pausiert die betroffene Kategorie. Positive Ganzzahlen setzen ein Limit. Fehlende Werte erben die übergeordnete Policy.

```yaml
downloads:
  maxConcurrentGlobal: null
  maxConcurrentPerUser: null
  maxConcurrentPerSourceAccount: null
  maxDownloadsPerDayPerUser: null
  maxBytesPerDayPerUser: null
  bandwidthBytesPerSecond: null
  perAdapter: {}
  perUser: {}
workers:
  downloadSlots: 4
  transferSlots: 2
  lifecycleReservedSlots: 1
```

Die Slotzahlen sind editierbare Startbeispiele, keine Obergrenzen. Der Admin kann sie passend zu CPU, RAM, Netz und Temp-Speicher erhöhen. Null-Budgets starten nur so viele Jobs, wie die konfigurierte Worker-Kapazität sicher ausführen kann. Für Transfer, Medienprüfung und Discovery gelten getrennte Pools. Kontenanzahl und gleichzeitig laufende Streams sind unterschiedliche Lastgrößen.

Pro Benutzer wird zuerst die explizite Benutzerpolicy oder der Default aufgelöst. Die kleinste aktive Grenze aus globalem, Benutzer-, Adapter-/Quellkonto-Budget und freien Slots bestimmt die Vermittlung; `null` wird dabei ausgelassen. Fairness verteilt freie Slots auf wartende Benutzer. Kumulative Tagesbudgets gelten für UTC-Kalendertage und werden mit Byte-/Jobreservierungen transaktional abgerechnet; ein Retry desselben logischen Downloads zählt nicht als zusätzliche Datei, übertragene Netzbytes werden jedoch als Verbrauch erfasst. Die UI benennt diese Semantik.

Adminänderungen werden validiert, versioniert und atomar aktiviert. Eine abgesenkte Parallelitätsgrenze verhindert neue Starts, bis die laufende Zahl darunter liegt; sie beschädigt keine laufende Datei. Pause/Sperre hat einen eigenen kontrollierten Abbruchweg. Tatsächliche Quellenantworten wie HTTP 429 und `Retry-After`, SSRF-Schutz sowie Speicherknappheit gelten unabhängig davon weiter. Der Admin sieht, ob ein Auftrag auf Kapazität, Policy, Quelllimit oder Kontofreigabe wartet.

Instagram Reels ist die bestätigte Bedeutung von „Feels“; es entsteht dafür kein separater Dienstadapter. Bei Pornhub und weiteren Videoportalen bleibt der Status bis zum jeweiligen Vertragstest „geplant“.
