# M5-A Adapter-Framework (packages/adapters) — Bericht Implementer

Task t_92539ab7 · req REQ-DL-002 `5d6398de6dbb5063`, REQ-DL-003 `b83be904af3eded5`, REQ-DL-001 `9fd10d9e84b53fb8` · Worktree `/work/wt/m5`, Branch `lane/adapters` (Basis: main = m3 + D1, e2c2de8) · nichts gepusht.

## Aufgabe

Quelladapter-Framework als Bibliothek in `packages/adapters`: Vertrag nach Plan 04 Abschnitt 3, Registry mit Kill-Switch, sicherer Prozess-Runner, Direct-URL-Adapter, yt-dlp- und gallery-dl-Adapter, Tests ohne Netz und ohne die echten Werkzeuge. Keine API-/UI-/Worker-Verdrahtung (das ist M5-B).

## Status

**fertig, braucht Review.** `corepack pnpm check` grün. Nicht geprüft: echter Aufruf von yt-dlp und gallery-dl (siehe Prüfung und Annahmen).

## Artefakte

Commits auf `lane/adapters` (englische Meldungen), neueste zuletzt:

- `aa34b1a` Vertrag, Registry, Prozess-Runner, Staging, Direct-URL-Adapter
- `eee8615` Tests für Runner, Staging, Registry, Direct-URL
- `62a1a35` yt-dlp- und gallery-dl-Adapter, CLI-Support, Delivery pro Asset
- `52fad6a` yt-dlp-Tests
- `488e08a` gallery-dl-Tests, Delivery-Tests, Korrektur der Bezeichnerprüfung
- `fb317d0` Prozessgruppen-Signal ohne Wurf in Event-Handlern
- dieser Bericht (eigener Commit)

Dateien (alle unter den erlaubten Pfaden):

- `packages/adapters/src/`: `types.ts` (Vertrag, normalisierte Typen), `errors.ts`, `registry.ts`, `workspace.ts`, `process-runner.ts`, `media.ts`, `staging.ts`, `target-url.ts`, `cli-support.ts`, `direct-url-adapter.ts`, `yt-dlp-adapter.ts`, `gallery-dl-adapter.ts`, `delivery.ts`, `index.ts`
- `packages/adapters/package.json`: Exportmuster unverändert (types/development → src, default → dist, build-Skript); neu nur `dependencies: { "@kura/immich-client": "workspace:*" }`
- `tests/adapters/`: `process-runner`, `staging`, `registry`, `direct-url-adapter`, `yt-dlp-adapter`, `gallery-dl-adapter` (+ `helpers.ts`, `fake-tools.ts`)
- `pnpm-lock.yaml`: 6 Zeilen (Importer-Eintrag `packages/adapters` → `link:../immich-client`). Die Datei steht nicht auf der Verbotsliste, ist aber Folge der neuen Workspace-Abhängigkeit; bitte beim Merge beachten.
- `packages/immich-client`: **keine Änderung nötig.** `createGuardedFetch`, `ImmichTargetBlockedError`, `EndpointApprovals` sind über `index.ts` (`export * from './network-guard.js'`) bereits exportiert.
- Neue externe Abhängigkeiten: **keine.** Lizenz/Name/Version entfällt. `pnpm audit --audit-level=high`: Exit-Ausgabe „2 vulnerabilities found, Severity: 1 low | 1 moderate“, also keine high/critical. Beide Funde bestehen unabhängig von dieser Karte (kein neues Paket).

## Zusammenfassung

[Iroha] Alles drin, was die Karte verlangt, und die kleinste Form dafür: zwei CLI-Adapter, ein eigener HTTPS-Adapter, ein Runner, ein Staging-Prüfer, eine Registry. Ich habe die Prüfungen eher zu streng gemacht als zu locker — ein Tool-Ergebnis mit einer einzigen Zusatzdatei wird komplett abgelehnt.

[Yui] Ich habe beim Schreiben vor allem daran gedacht, wer das später wartet: Tool-Ausgaben landen nie in Fehlermeldungen, nur in `untrustedDiagnostics`. Und ich muss ehrlich sagen, was fehlt: Die SSRF-Grenze (NET-01/T20) gilt für den Direct-Adapter, **nicht** für yt-dlp/gallery-dl. Dazu unten bei Risiken.

Was umgesetzt ist:

1. **Vertrag** (`types.ts`): `SourceAdapter` mit `capabilities / validateTarget / probe / discover / resolveAssets / download` in der Signatur aus Plan 04 §3. Zusätzlich optional `stage()` als „kontrollierte Staging-Datei“ für CLI-Adapter (Plan 04 §3 erlaubt das ausdrücklich). Normalisiert: Creator, Post, `revisionKey`, `AssetManifest` (Plattform-/Creator-/Post-ID, `assetIndex`, `sourceAssetId`, Originalname, Medientyp, Rolle, Variante, Qualitätsparameter, `declaredBytes`, Vollständigkeit je Asset und `discoveryComplete` je Manifest). Flüchtige URLs liegen nur in `ResolvedAsset.shortLived`; `toPersistableAsset()` entfernt sie. Fähigkeiten heißen wie im Plan (`single_post`, `creator_feed`, `pagination`, `resume`, `images`, `videos`, `page_snapshot`, `quality_variants`, `auth_kind`).
2. **Registry** (`registry.ts`): Registrierung je Adapter-ID + Version, `listCapabilities()`, Kill-Switch je Adapter, Version und Quelltyp (fehlende Felder = alle), `lookup()/select()` in Registrierungsreihenfolge. Ein Adapter, der beim Prüfen wirft, landet in `failures` und blockiert die anderen nicht; `TARGET_BROKEN` wird von `select()` weitergereicht statt als „nicht unterstützt“ zu erscheinen.
3. **Prozess-Runner** (`process-runner.ts`, `workspace.ts`): fester absoluter Pfad + erwartetes SHA-256 (wird vor **jedem** Start gehasht, Vergleich zeitkonstant), `spawn` mit Argument-Array, `shell: false`, `detached` (eigene Prozessgruppe), minimale Umgebung (PATH fest, HOME/TMPDIR/XDG_* im Arbeitsbereich, nichts aus der Elternumgebung; nur vom Admin gesetzte `extraEnv`), privater Arbeitsbereich 0700 je Lauf mit `media/`, `home/`, `scratch/N/`, Limits für Laufzeit, stdout, stderr und Temp-Platz (Polling alle 250 ms plus Endprüfung), SIGTERM auf die ganze Gruppe, nach Gnadenfrist SIGKILL; nach normalem Ende wird die Gruppe ebenfalls beendet (keine verwaisten Helfer). Abbruch per `AbortSignal`. Nicht-null-Exitcode wird zurückgegeben, nicht geworfen.
4. **Direct-URL-Adapter** (`direct-url-adapter.ts`): nur HTTPS, keine Zugangsdaten in der URL, kanonische URL aus geparsten Teilen, Redirects von Hand (max. 5), **jeder Hop** über `createGuardedFetch` aus `@kura/immich-client` (privat/Loopback/Link-Local/Metadaten gesperrt, privat nur mit Admin-Freigabe), Redirect auf `http:`/`file:`/Credentials abgelehnt, MIME-Allowlist (Content-Type) plus Magic-Byte-Prüfung gegen den Typ, Größenprüfung (Content-Length und gezählte Bytes), `Content-Encoding` ≠ identity abgelehnt, Leerlauf-Timeout, Streaming als `AsyncIterable`.
5. **yt-dlp-Adapter** (`yt-dlp-adapter.ts`): `YtDlpAdapter.create()` prüft Hash, liest `--version` und lehnt alles unter **2026.07.04** ab (D-007; Admin darf die Grenze nur erhöhen). Ziele: YouTube-Einzelvideo (watch, youtu.be, shorts) und Instagram-Post/Reel; Playlists/Kanäle nicht unterstützt; Instagram-Profil → `TARGET_BROKEN` (instagram:user, Plan 04 §2); Pixiv → `TARGET_UNSUPPORTED` mit Verweis auf gallery-dl (D-008). Argumente nur aus festen Optionen, Preset, Zahlen und der kanonischen URL hinter `--`.
6. **gallery-dl-Adapter** (`gallery-dl-adapter.ts`): Einzelposts für Pixiv, Instagram, Patreon. Download je Datei über die Position (`--range N`, N = Index + 1) im Listing der validierten URL; URLs, Dateinamen und Titel aus dem Listing werden nie als Argument verwendet. Post-ID aus dem Listing muss zum Ziel passen (Stolperdraht gegen Umleitungen).
7. **Staging/Delivery** (`staging.ts`, `delivery.ts`): `adoptToolOutput` übernimmt genau **eine** reguläre Datei (kein Symlink, kein Hardlink, sicherer Name, erlaubte Endung, Größenlimit, Magic Bytes passen) nach `media/item-NNNN.<ext>` unter einem von Kura gewählten Namen; jede Zusatzdatei lehnt das Ergebnis ab. `deliverAssets` führt Assets einzeln aus, ein Fehler stoppt die anderen nicht, Ergebnis `complete | partially_completed | failed` plus `result.json` im Schema aus Plan 04 §7 (mit zusätzlichem `sha256`).

## Prüfung

Ausgeführt (Sandbox, `DATABASE_URL=postgres://kura_dev:kura_dev@127.0.0.1:5432/kura_dev`):

- Vorher (Start, Stand e2c2de8, Datei `/tmp/m5-check-before.log`):
  `Test Files  14 passed (14)` / `Tests  135 passed | 1 skipped (136)`, Exit 0.
- Nachher (nach `488e08a`, Datei `/tmp/m5-check-after.log`):
  `Test Files  20 passed (20)` / `Tests  336 passed | 1 skipped (337)`, Exit 0.
  Das sind +6 Dateien und +201 Tests, alle in `tests/adapters/`. Endlauf nach dem letzten Code-Commit `fb317d0` und mit diesem Bericht (`/tmp/m5-check-final.log`): identisch, `Test Files  20 passed (20)` / `Tests  336 passed | 1 skipped (337)`, Exit 0.
- Review-Runde 1 (Befund: HTTPS-only im Direct-Adapter galt nur für `validateTarget` und Redirect-Hops, nicht für die tatsächlich angefragte URL): behoben in `direct-url-adapter.ts`. `open()` prüft die Start-URL jetzt mit `assertPlainHttps` (Fehler `TARGET_INVALID`); `resolveAssets()` und `download()` validieren den Post neu (`recheckPost`: Adapter, kanonische URL, `platformPostId`, Quelltyp müssen zu `validateTarget` passen, wie `targetOfPost` bei den CLI-Adaptern); `probe()` und `discover()` validieren das Target neu (`recheckTarget`). Eine `shortLived.downloadUrl` (Ergebnis nach Redirects, daher nicht gegen die kanonische URL vergleichbar) läuft durch dieselbe https-Prüfung in `open()`. Neue Tests (4, `describe('DirectUrlAdapter re-validates URLs before any request')`): manipulierter Post mit http-URL, `shortLived.downloadUrl` mit http, kanonische URL passt nicht zur `platformPostId`, manipuliertes Target in probe/discover — jeweils `TARGET_INVALID` und **kein** Fetch-Aufruf (aufzeichnender Fetcher). Endlauf danach: `Test Files  20 passed (20)` / `Tests  340 passed | 1 skipped (341)`, Exit 0 (+205 gegenüber Start 135).
- `tsc --noEmit -p packages/adapters` ohne Ausgabe; `eslint packages/adapters tests/adapters --max-warnings=0` ohne Ausgabe.
- Build-Artefakt geladen: `node -e "import('./dist/index.js')"` in `packages/adapters` → 38 Exporte, `DirectUrlAdapter` und `YtDlpAdapter` sind Funktionen (dist löst `@kura/immich-client` über dessen dist auf).
- Mutationsprobe: Entfernt man im Runner das Beenden der Gruppe nach normalem Exit, schlägt genau der Test „kills helper processes that outlive a normally exiting tool“ fehl (danach wiederhergestellt).

Von den Tests abgedeckt (Anforderung aus der Karte):

- Option-Injection: URL mit führendem `-`, `--exec=…`, Newline, CR, NUL, Leerzeichen, Credentials, Look-alike-Hosts, URL in URL; hostile Metadaten (Titel `--exec=…`, Kanal `$(id)`, Dateiname/Endung `../../etc/passwd`, URL `--exec=…`) → protokollierte Argumentlisten des Fake-Tools enthalten nichts davon; jeder Aufruf endet auf `-- <kanonische URL>`; keine Option aus den Advisories (`--exec`, `--netrc-cmd`, `--write-link`, externe Downloader).
- Prozessgruppe: Timeout beendet Enkelprozess, SIGTERM-resistentes Tool wird per SIGKILL beendet, Helfer nach normalem Exit werden beendet.
- Limits: stdout, stderr, Temp-Platz (laufend und Endprüfung), Laufzeit, Abbruch per Signal.
- Hash: abweichender Hash, nachträglich ausgetauschte Datei, relativer Pfad, Großbuchstaben-Hash, fehlende/nicht ausführbare Datei → Tool wird nicht gestartet (Marker-Datei bleibt aus).
- Version: Untergrenze 2026.07.04 (akzeptiert: 2026.07.04, .05, Nightly-Suffix; abgelehnt: 2026.07.03 u. a.), unlesbare Version abgelehnt, Admin kann Grenze nur erhöhen.
- Kill-Switch je Version/Quelltyp/Adapter, Isolation eines werfenden Adapters, `TARGET_BROKEN` für instagram:user.
- Teilerfolg: Post mit fünf Dateien, Datei 3 schlägt fehl → vier gestaged, `partially_completed`, `result.json` listet vier Items und einen Fehler; außerdem `complete`, `failed`, Abbruch, unerwartete Exception ohne Textleck.
- Direct-Adapter: Redirect auf privaten Host, Loopback, `[::1]`, Metadaten-IP, Hostname→Metadaten-IP, IPv4-mapped IPv6, DNS-Antwort mit öffentlicher und privater Adresse (Rebinding) → `NETWORK_BLOCKED`; Link-Local/Metadaten auch bei „alles freigegeben“; freigegebener privater Endpunkt passiert den Guard (Verbindung scheitert danach erwartungsgemäß); Redirect auf http/file/javascript, ohne Location, Schleife; HTML/SVG/ohne Content-Type; zu große/zu kurze/zu lange Bodys; Magic-Bytes passen nicht; Leerlauf-Timeout.
- Staging: Symlink, Hardlink, Verzeichnis, Zusatzdatei, unsichere Namen, falsche Endung, Inhalt passt nicht zur Endung, Größe, doppelter Index; Aufräumen nach Fehlern und nach vorzeitigem Abbruch des Konsumenten.

**Nicht geprüft: echter Aufruf** von yt-dlp und gallery-dl (nicht installiert in der Sandbox; Netz und echte Konten laut CLAUDE.md ausgeschlossen). Alle Tests nutzen Fake-Programme (Node-Skripte mit absoluter Node-Shebang), deren Ausgabe ich selbst aus Dokumentationswissen nachgebaut habe. Ob die echten Tools dieselben Optionen akzeptieren und dasselbe JSON liefern, ist **unbekannt**.

Nicht geprüft außerdem: Verhalten unter Windows (Runner ist POSIX-only und lehnt `win32` ab), Verhalten gegen echte Ziele mit TLS/DNS im Direct-Adapter (Tests nutzen Stub-Antworten für „öffentliche“ Hosts und den echten Guard für gesperrte), CPU-/RAM-/Prozessanzahl-Limits (von Node aus nicht setzbar).

## Annahmen

1. **Optionen der Tools aus Dokumentationswissen, nicht gegen die echten Programme geprüft.** yt-dlp: `--ignore-config --no-update --no-cache-dir --no-playlist --no-warnings --dump-single-json --no-progress --no-mtime --max-filesize N -f <format> -o asset.%(ext)s --`, `--version`. gallery-dl: `--config-ignore --dump-json -D <dir> -f asset.{extension} --range N --filesize-max N --`, `--version`. Absichtlich nicht verwendet, weil ich sie nicht belegen kann: `--no-plugin-dirs` und ähnliche. Plugin-/Konfig-Suchpfade werden stattdessen über privates HOME/XDG und `PYTHONNOUSERSITE=1` entschärft; ein Plugin-Verzeichnis neben dem Binärpfad liegt in Admin-Hand.
2. **JSON-Formen sind nachgebaut:** yt-dlp `-J`-Felder (`id`, `title`, `ext`, `channel_id`, `channel`, `uploader`, `upload_date`, `duration`, `width`, `height`, `_type`); gallery-dl `--dump-json` als Liste aus `[2, {…}]`/`[3, url, {…}]` mit Feldern `id`, `num`, `extension`, `filename`, `title`, `date`, `user.id/name`, `width`, `height`; Instagram-Schlüssel `post_shortcode`; Patreon-`id`. Ein fehlender oder anders benannter Schlüssel führt zu `unknown`/`null` bzw. (Pixiv/Patreon ohne `id`) zu `OUTPUT_INVALID`.
3. **gallery-dl-Datumswerte ohne Zeitzone werden als UTC gelesen.** Unbelegt.
4. **Exitcodes:** gallery-dl liefert bei Teilfehlern einen Nicht-null-Exit nach teilweiser Ausgabe; ich werte das als „Liste möglicherweise unvollständig“ (`discoveryComplete=false`), nicht als Fehler. Nicht-null-Exit ohne Ausgabe ist ein Fehler.
5. **Format `bestvideo*+bestaudio/best`** für `BEST_AVAILABLE` bei yt-dlp; ob dafür FFmpeg nötig ist und welche Version erlaubt ist, ist **unbekannt** (D-007). Der Admin kann per `extraEnv` ein PATH mit festem FFmpeg setzen.
6. **Zielumfang konservativ:** yt-dlp: `youtube`, `instagram` (nur Einzelpost/Reel); gallery-dl: `pixiv`, `instagram`, `patreon` (nur Einzelposts). Pornhub ist **nicht** enthalten (Plan: „geplant bis Vertragstest“). `creator_feed`, `pagination`, `resume`, `page_snapshot`, `quality_variants` sind überall `false`; gallery-dl deklariert `videos: false`, obwohl es Dateien wie mp4 durchlassen würde.
7. **`auth_kind: 'none'` überall.** Ein Kanal für Cookies/Tokens ist in dieser Karte nicht gebaut (siehe Risiken).
8. **`revisionKey`:** yt-dlp: Hash aus ID, Upload-Datum, Dauer (Titeländerungen lösen bewusst keinen neuen Download aus); gallery-dl: Hash aus Post-ID, Datum, Dateiendungen; Direct: Hash aus ETag/Last-Modified/Content-Length oder `unversioned`. Ob das als „Quellrevision“ reicht, ist eine fachliche Annahme.
9. **Zustandslose Adapter:** `probe`, `discover` und `resolveAssets` rufen jeweils das Tool neu auf; `stage` ein Aufruf je Asset. Das kostet Laufzeit und Requests, vermeidet aber geteilten Zustand zwischen Aufrufen.
10. **`resolveAssets(post, policy)` hat laut Plan keinen Kontext** und damit kein `AbortSignal`; Abbruch dort nur über das Metadaten-Timeout (Standard 120 s).
11. **Pfade/Namen:** Staging-Layout `<workRoot>/run-<24 Hex>/{media/item-NNNN.<ext>, result.json, home/, scratch/N/}` ist mein Vorschlag, angelehnt an Plan 04 §7 (`media/item-0001.jpg`, Index hier 0-basiert).
12. **M0-Berichte nicht auffindbar:** In `.claude/team/reports` liegen keine M0-Berichte (nur M1…W3, D1). Die Sicherheitsbefunde habe ich aus D-007/D-008 in `decisions.md` übernommen. Falls die M0-Berichte weitere Punkte enthalten, sind sie hier nicht berücksichtigt.
13. Der Guard-Fehlertyp heißt `ImmichTargetBlockedError`. Ich verwende ihn unverändert (Wiederverwendung statt Kopie) und übersetze ihn in `NETWORK_BLOCKED`. Die Freigabe ist dort an Host:Port gebunden, nicht an die aufgelöste IP (R-13 der Risikoliste gilt entsprechend).

## Risiken

1. **NET-01 / T20 ist für yt-dlp und gallery-dl NICHT erfüllt.** Die beiden Programme machen ihre Netzwerkzugriffe selbst; der Guard greift nur im Direct-Adapter. Redirects, CDN-Aufrufe und eingebettete Ressourcen der CLI-Tools müssen extern begrenzt werden (Proxy, nftables, Netzwerk-Namespace; D-008, R-09). Ohne diese Grenze darf M5-B die CLI-Adapter nicht gegen Nutzereingaben freischalten.
2. **Hash-Prüfung und Start sind zwei Schritte** (Zeitfenster zwischen Hashen und `spawn`). Wer das Verzeichnis des Binärs beschreiben kann, kann das Fenster nutzen. Gegenmaßnahme ist Betrieb: Binär und Verzeichnis root-eigen, nicht vom Worker-Benutzer schreibbar. Nicht im Code gelöst.
3. **Keine Ressourcenlimits für CPU, RAM, Prozessanzahl;** Temp-Platz wird nur per Polling (250 ms) geprüft, ein schneller Schreiber kann zwischen zwei Prüfungen überschießen. Gehört in Container/cgroup/Dienstmanager.
4. **Keine Zugangsdaten-Strecke:** Instagram, Patreon und Pixiv brauchen in der Praxis meist Login. Ohne Cookie-/Token-Kanal scheitern solche Ziele mit `PROCESS_FAILED`; die Ursache (abgelaufenes Cookie vs. Rate-Limit) wird nicht klassifiziert, `waiting_auth`/`waiting_rate_limit` lassen sich daraus noch nicht ableiten.
5. **Tool-Ausgaben sind untrusted.** `untrustedDiagnostics` ist bereinigt (Steuerzeichen entfernt, 2000 Zeichen) und darf nicht interpretiert, aber auch nicht ungeprüft in Logs/UI mit Markup gerendert werden.
6. Wartungsrisiko Extractor (R-01): jede Annahme zum JSON-Format kann mit einer neuen Toolversion brechen; die Tests sind Fake-Verträge, keine Vertragstests gegen die echten Versionen.
7. Das Schema `result.json` ist ein Hinweis für den Importer; Vertrauen entsteht erst durch dessen eigene Prüfung (Job-/Leasebindung, Hash, Größe).
8. `pnpm-lock.yaml` ist angefasst (6 Zeilen) — Kollisionsgefahr mit anderen Lanes beim Merge (z. B. `lane/scheduler`), die dieselbe Datei ändern könnten.

## Offene Fragen

1. [Yui] Wer setzt die Egress-Grenze für die CLI-Tools durch, und wann (VLAN/nftables auf der VM, R-09)? Ohne das ist T20 nur für den Direct-Adapter bewiesen.
2. [Yui] Soll der Cookie-/Token-Kanal (privater, vom Import ausgeschlossener Bereich, Datei 0600, garantierte Bereinigung) Teil von M5-B werden oder eine eigene Karte? Die Workspace-Struktur lässt Platz dafür, ist aber nicht gebaut.
3. [Iroha] Mindestversion für gallery-dl? D-008 nennt nur v1.32.2 als bekannte Version, keine Sicherheitsuntergrenze. Der Code kennt `minimumVersion`, setzt aber keinen Standardwert.
4. FFmpeg-Zielversion (unbekannt laut D-007) und ob `BEST_AVAILABLE` ohne FFmpeg betrieben werden soll.
5. Reicht `revisionKey` (Annahme 8) fachlich, oder soll Titel-/Beschreibungsänderung eine neue Assetversion erzeugen?
6. [Iroha] Gewollt, dass Instagram über gallery-dl zuerst und yt-dlp als zweite Wahl läuft? Die Reihenfolge bestimmt allein die Registrierungsreihenfolge im Worker.
7. Soll der Direct-Adapter später Range-Resume bekommen (`resume` ist jetzt `false`)?

## Einbindung (für M5-B)

**Aufbau beim Start des Workers** (je Adapter eigenes try/catch, damit ein Fehler nur diesen Adapter auslässt):

```ts
const registry = new AdapterRegistry(killSwitchesFromDatabase);        // KillSwitch[] persistiert M5-B selbst
registry.register(new DirectUrlAdapter({ approvals }));                // approvals: bestehende EndpointApprovals
registry.register(await GalleryDlAdapter.create({ binary: { path, sha256 }, workRoot, extraEnv }));
registry.register(await YtDlpAdapter.create({ binary: { path, sha256 }, workRoot, extraEnv }));
```

`create()` wirft `BINARY_NOT_CONFIGURED`, `BINARY_HASH_MISMATCH` oder `BINARY_VERSION_REJECTED`; der Worker soll das protokollieren und den Adapter in der Admin-Ansicht als nicht verfügbar zeigen. Kill-Switches ändert der Worker mit `registry.setKillSwitches()` / `disable()` / `enable()`; eine Tabelle dafür gibt es noch nicht (Migrationen waren verboten).

**Ablauf eines Auftrags:**

```ts
const { adapter, target } = registry.select(url);        // wirft TARGET_UNSUPPORTED / TARGET_BROKEN / ADAPTER_DISABLED
registry.assertEnabled(adapter, target.sourceType);      // erneut kurz vor Start prüfen (Kill-Switch kann inzwischen gesetzt sein)
for await (const post of adapter.discover({ jobId, leaseGeneration, target, signal })) {
  const manifest = await adapter.resolveAssets(post, { preset: 'BEST_AVAILABLE' });
  const workspace = await createRunWorkspace(stagingRoot);
  try {
    const delivery = await deliverAssets({ adapter, post, manifest, policy, workspace, jobId, leaseGeneration, limits: { maxBytes }, signal });
    // Importer: liest nur workspace.rootDir/media/* und result.json, prüft Lease, Hash, Größe, Typ
  } finally {
    await workspace.dispose();                           // erst nach abgeschlossenem Import
  }
}
```

- `delivery.completion` ist `complete | partially_completed | failed` und passt auf die Zustände aus Plan 04 §4; `delivery.outcomes` ist die Wahrheit je Asset. Bereits gestagte Assets dürfen bei einem Teilfehler nicht neu geladen werden.
- Nur `discoveryComplete === true` im Manifest erlaubt, den Cursor/„erfolgreich geprüft bis“ weiterzusetzen (Plan 04 §4).
- `toPersistableAsset()` verwenden, bevor ein Asset in die DB geht; `shortLived` bleibt im Auftragskontext.
- Fehler sind `AdapterError` mit `code`. Vorschlag zur Abbildung (nicht implementiert): `PROCESS_TIMEOUT`, `NETWORK_FAILED`, `DOWNLOAD_FAILED` → `retry_wait`; `TARGET_*`, `POLICY_UNSUPPORTED`, `MIME_REJECTED`, `SIZE_LIMIT`, `STAGING_REJECTED`, `OUTPUT_INVALID` → `failed` (STAGING_REJECTED/Hash-Themen → Quarantäne laut Plan 04 §6); `BINARY_*`, `ADAPTER_DISABLED` → Adapter gesperrt, andere Quellen laufen weiter; `PROCESS_ABORTED` → Pause/Abbruch. `PROCESS_FAILED` ist unklassifiziert (Ursache nur in `untrustedDiagnostics`).
- `AbortSignal` ans Durchreichen für Pause/Abbruch: Runner beendet die Prozessgruppe.

**Staging-Layout** je Lauf (`createRunWorkspace(parent)` → `<parent>/run-<24 Hex>/`, Rechte 0700):

```
media/item-0000.jpg   geprüfte Dateien, Name von Kura gewählt (Index 0-basiert, 4 Stellen)
result.json           schemaVersion 1, jobId, leaseGeneration, adapterId, adapterVersion, discoveryComplete, items[], errors[]
home/                 HOME/TMPDIR/XDG_* des Tools (nicht importieren)
scratch/N/            Arbeitsverzeichnis je Tool-Aufruf (wird nach dem Aufruf entfernt)
```

Der Importer muss nur `media/` und `result.json` ansehen, die Lease binden (`jobId`, `leaseGeneration` stehen in `result.json`), Dateien erneut prüfen und alles andere ablehnen.

**Konfiguration von Binärpfaden und Hashes:** Der Code liest keine Umgebungsvariablen und keine Datei; er erwartet `{ path, sha256 }` vom Aufrufer. Vorschlag für M5-B (Namen sind nicht festgelegt): je Werkzeug Pfad und SHA-256 aus der Betreiberkonfiguration, Hash per `sha256sum <pfad>` nach der Installation ermitteln und bei jedem Update der Binärdatei neu setzen. Weitere Betreiberwerte: `workRoot` (Staging-Volume, nur für den Worker-Benutzer beschreibbar), optional `extraEnv` (z. B. `PATH` mit gepinntem FFmpeg), `metadataTimeoutMs` (Standard 120 s), `downloadTimeoutMs` (Standard 2 h), `minimumVersion`. Direct-Adapter: `approvals`, optional `maxRedirects` (5), `maxAssetBytes` (2 GiB), `idleTimeoutMs` (60 s). Bei einer neuen Toolversion ändern sich Hash und `adapterVersion`; Kill-Switches beziehen sich auf diese Version.

## Nächster Schritt

Review der Karte, danach M5-B (Worker-Verdrahtung, Persistenz der Kill-Switches, Importer, Fehlerabbildung). Vor dem Freischalten der CLI-Adapter gegen Nutzereingaben: Egress-Grenze (Risiko 1) und, falls echte Plattformkonten gebraucht werden, die Zugangsdaten-Strecke (Offene Frage 2). Ein Vertragstest gegen die echten Versionen mit eigenen Inhalten steht aus und ist erst nach Installation der Tools möglich.
