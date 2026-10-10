# D3 Implementer: Doppelte Downloads beheben

- Aufgabe: `t_91855117` D3. Anforderungen REQ-DL-006 `41a71ca708d3fc58`, REQ-DL-005 `66b20a66d9133e08`, REQ-DL-004 `e852201230c9a860`, REQ-DL-002 `5d6398de6dbb5063` (Plan 04 "Inkrementelle Synchronisierung", M4 "keine doppelten logischen Termine", Plan 08).
- Status: braucht Review.
- Artefakte: Branch `fix/duplicates` (Worktree `/work/wt/dup`, Basis `afd5e1e`), vier Code-/Testcommits plus Commit dieses Berichts. Nichts gepusht. Keine Migration (0060-0068 frei, 0069 für VER reserviert, nicht berührt).
- Zusammenfassung: Der Revisionsschlüssel der gallery-dl-Posts enthielt Werte, die zwischen zwei Abfragen desselben unveränderten Posts wechseln. Jeder Lauf legte deshalb alle Posts neu an. Jetzt hängt der Schlüssel nur von Post-ID und der Menge der Datei-IDs ab. Die gespeicherte Sync-Marke wird benutzt, um das Durchlaufen eines Feeds zu beenden. Bereits archivierte Posts werden ohne Anfrage übersprungen. Ein Asset mit bekannter Datei wird nicht erneut geladen. Die Medienliste zeigt jede Datei je Abo einmal. Vorhandene Dubletten bleiben unangetastet; ein Report-Skript listet sie.

## Ursache (welches Feld)

`buildPost()` in `packages/adapters/src/gallery-dl-adapter.ts` bildete den Schlüssel aus `Post-ID | Datum der Auflistung | Dateiendungen | locked`. Zwischen den beiden Läufen der VM (21:25, 21:58) änderte sich eines der beiden Felder Datum oder Dateiendung. Welches, ist aus der Datenbank nicht beweisbar, weil nur der Hash gespeichert wurde. Eingrenzung:

- Die `original_name` beider Kopien sind gleich. Sie enthalten die Endung aus der Auflistung des Einzelposts beim Auflösen. Dort war die Endung in beiden Läufen gleich.
- Das Datum eines Posts ist bei Instagram `taken_at` (instagram.py `_parse_post`, Zeile 308) und ändert sich nicht.
- Die Endung kommt aus der URL des ersten Kandidaten von `image_versions2` (`text.nameext_from_url`, instagram.py Zeile 167-169). Ob die Auflistung des Profils `.jpg` oder `.webp` zurückgibt, hängt von `stp=dst-jpg` in der CDN-URL ab. Das ist die wahrscheinlichste Ursache (Annahme, nicht belegt). Datum ist der zweite Kandidat.
- Beides ist jetzt nicht mehr Teil des Schlüssels, egal welches Feld es war. Falls der Orchestrator es genau wissen will: bei einem neuen Lauf die Rohauflistung zweimal mit `--dump-json` aufheben und vergleichen. Das habe ich nicht getan (kein Plattformzugriff).

Zweite Ursache für die Menge an Arbeit: Die Sync-Marke wurde nur geschrieben (`saveSyncState`) und nie gelesen. Jeder Lauf las die neuesten 50 Posts und löste jeden einzelnen auf.

## Änderungen

1. Stabiler Revisionsschlüssel (`packages/adapters/src/revision.ts`, neu).
   - gallery-dl: `g-` + SHA-256(Post-ID + sortierte Menge der Datei-IDs). Datei-IDs: Instagram `media-<id>` (wie bisher), Patreon `hash-<MD5 aus dem URL-Pfad>` (vorher `file-N`), Pixiv `page-<Seite>-<12 Hex des URL-Pfads ohne Query und Endung>` (vorher `file-N`), Pornhub-Album `photo-<id>`. Fehlt die ID, bleibt `file-N`.
   - yt-dlp: `v-` + SHA-256(Video-ID), für Einzelvideo und Listeneintrag gleich. Vorher `d-` (ID, Upload-Datum, Dauer) und `f-` (ID).
   - Echtes Bearbeitungsfeld: keines. Patreon: `fields[post]` in gallery-dl 1.32.16 (patreon.py Zeile 283-297) fordert `edited_at` nicht an. Pixiv: das App-API-Werk hat kein `update_date` (kein Treffer in pixiv.py). Instagram, yt-dlp: keines. Eine Änderung des Posts zeigt sich daher nur über die Menge der Dateien.
   - direct_media (`h-`: Header ETag/Länge) nicht angefasst.
2. Inkrementelle Entdeckung.
   - Stoppregel (`endOfNewPosts`, `gallery-dl-listing.ts`): Ein Feed wird in Fenstern gelesen (12, 24, 48 ... bis zur Obergrenze). Das Lesen endet mit dem ersten Fenster, in dem 3 bekannte Posts hintereinander stehen und danach kein Post mit neuerem Datum mehr kommt. Die zweite Bedingung schützt vor angehefteten Posts (alt, aber zuerst ausgegeben). Fehlt ein Datum, endet das Lesen nie früher.
   - Freigabe im Worker (`knownPostsOfFeed`): nur wenn die Sync-Marke zum Ziel gehört (`target_hash`), `checked_through` gesetzt ist und der letzte beendete Lauf des Abos `stored` war. Nach einem gescheiterten oder abgebrochenen Lauf wird der ganze Bereich gelesen. Ohne bekannte Posts (erster Lauf) wird wie bisher in einem Aufruf gelesen.
   - "Bekannt" = Post mit vollständig archivierter Revision (`stored`, oder fertig mit nur dauerhaft unmöglichen Assets `ASSET_UNSUPPORTED`). Privat/gesperrt (`ASSET_NOT_ACCESSIBLE`) gilt nicht als erledigt, weil sich das ändern kann, ohne dass sich der Schlüssel ändert.
   - Ein archivierter Post wird übersprungen, ohne die Plattform zu fragen (`isArchivedUnchanged`). Posts mit altem Schlüsselformat (`l-`, `d-`, `f-`) und vollständig archiviert gelten als unverändert: Der alte Schlüssel enthielt Wechselwerte und ist mit dem neuen nicht vergleichbar.
   - Nicht vollständig archivierte Posts des Abos (fehlgeschlagen, Asset offen) hinter dem Stoppunkt werden einzeln neu gelesen (`rediscoverOpenPosts`, höchstens 10 je Lauf). Teilweise fertige Posts laden fertige Assets nicht erneut.
   - Bearbeitungen: Innerhalb des gelesenen Fensters ergibt eine andere Dateimenge eine neue Revision. Eine Änderung hinter dem Stoppunkt wird bei inkrementellen Läufen nicht bemerkt (Test dokumentiert das; Plan 04 nennt dafür den optionalen Rückscan, nicht umgesetzt).
   - yt-dlp: Die flache Liste ist ein billiger Aufruf und bei Playlists nicht neueste-zuerst. Sie wird immer ganz gelesen; Ersparnis entsteht durch Überspringen archivierter Videos ohne Einzelabfrage und ohne Download.
3. Sicherheitsnetz je Asset (`executor.ts`, `history.ts`).
   - Vor dem Laden: Steht in einer anderen Revision desselben Posts schon ein gespeichertes Asset mit derselben ID, und sagt die ID den Inhalt (`media-`, `hash-`, `page-`, bei YouTube/Pornhub `video`/`photo-`; nicht `file-N`, nicht `ugoira`), zeigt das neue Asset auf diese Datei. Es wird nichts geladen.
   - Nach dem Laden: Hat das Abo dieselben Bytes (SHA-256, vom Worker selbst nachgerechnet, nicht dem Adapter geglaubt) schon, wird nicht erneut in den Blobstore geschrieben.
   - Zustand `stored`, gleiche `blob_object_id`, Übergabestatus des Vorbilds. `blobstore_objects.reference_count` wird um 1 erhöht, genau wie ein erneuter Import es täte.
   - Der Blobstore speichert ohnehin ein Objekt je (Benutzer, SHA-256) (`UNIQUE (owner_id, sha256)`). Auf der VM gibt es also keine doppelten Bytes im Blobstore, sondern doppelte Zeilen (Posts, Assets) und doppelt geladene Daten.
4. Medienliste (`apps/api/src/media-routes.ts`): je Abo eine Zeile je SHA-256, die neueste Post-Zeile (`discovered_at`) liefert die Metadaten, Zähler zählen `DISTINCT sha256`, neues Feld `copies` je Eintrag. Seiten und Typfilter arbeiten auf der entdoppelten Menge. Die Web-Oberfläche zeigt die Zähler der API und brauchte keine Änderung.
5. Report `apps/worker/scripts/report-duplicates.sql`: schreibgeschützte Transaktion (`BEGIN TRANSACTION READ ONLY ... ROLLBACK`), fünf Abschnitte (je Abo, je Datei mit Größe/Kopien/Referenzzähler, Posts mit mehreren Schlüsseln, Postzeilen gegen echte Posts, Summe).

## Betrieb auf der VM

Was nach dem Deploy mit den vorhandenen Dubletten passiert:

- Nichts wird gelöscht und nichts umgeschrieben. Keine Migration. Die 93 Postzeilen und ihre Assets bleiben.
- Der erste Lauf nach dem Deploy liest den Feed wie bisher (bis 50 Posts), denn `checked_through` und der letzte Lauf müssen stimmen. Alle bereits vollständig archivierten Posts mit altem Schlüssel gelten als unverändert: keine neuen Postzeilen, kein Download, keine Einzelabfrage. Nur wirklich neue Posts werden geladen.
- Ab dem zweiten Lauf nach dem Deploy liest ein Lauf über ein unverändertes Profil nur noch das Testfenster (Prüfaufruf und ein Fenster von 12 Posts).
- Posts der VM mit altem Schlüssel erkennen spätere Änderungen nicht. Der alte Schlüssel ist nicht vergleichbar. Bei Instagram kann man Bilder eines Posts nicht ändern; für Patreon/Pixiv bleibt das ein kleines Restrisiko.
- Ein auf der VM unvollständig archivierter Post (alter Schlüssel) wird unter neuem Schlüssel neu angelegt. Instagram-Dateien mit `media-` ID zeigen auf bereits gespeicherte Dateien. Bei Patreon/Pixiv haben sich die Datei-IDs geändert, dort wird geladen und per SHA-256 erkannt.
- Die Medienliste zeigt sofort nach dem Deploy jede Datei einmal, auch ohne neuen Lauf.
- Report ausführen (auf dem Server, nur lesend):

  ```
  psql "$DATABASE_URL" -f apps/worker/scripts/report-duplicates.sql
  ```

  Abschnitt 1 ist die Übersicht je Abo (`extra_rows`, `extra_bytes`, `extra_mib`). Abschnitt 2 listet jede doppelte Datei mit Kopien, Größe und `blob_reference_count`. Abschnitt 3 zeigt die Posts mit mehreren Revisionsschlüsseln. Abschnitt 5 ist die Summe. "extra" sind Zeilen, die man doppelt sieht und die doppelt geladen wurden, nicht belegter Platz: `stored_objects` zeigt, dass der Blobstore nur ein Objekt je Datei hält.
- Das Aufräumen der doppelten Zeilen (Posts/Assets, Referenzzähler) ist eine eigene Entscheidung des Auftraggebers und nicht Teil dieser Karte.

## Prüfung

Ausgeführt (`export DATABASE_URL=postgres://kura_dev:kura_dev@127.0.0.1:5432/kura_dev`):

- Vorher (Stand `afd5e1e`): `corepack pnpm check` grün, 58 Dateien, 1292 bestanden, 1 übersprungen.
- Nachher: `corepack pnpm check` zweimal hintereinander grün (Exit 0), je 63 Dateien, 1324 bestanden, 1 übersprungen. Das sind 5 neue Dateien (`tests/dedupe/*.test.ts`) und 32 neue Tests. Logs: `/tmp/dup-check-1.log`, `/tmp/dup-check-2.log`.
- Neue Tests unter `tests/dedupe/` (echtes PostgreSQL, gefälschtes gallery-dl/yt-dlp, kein Netz):
  - Zwei Läufe über ein unverändertes Profil: keine neuen Posts/Assets/Blobs, zweiter Lauf = Prüfaufruf plus Fenster `1-12`, kein Download, keine Einzelabfrage.
  - Geändertes Datum/Endung in der Auflistung: gleiche Schlüssel, nichts geladen. Neue Datei in einem Post: neue Revision, genau eine Datei geladen, die bekannte zeigt auf den gespeicherten Blob (`reference_count` 2, ein Schreibvorgang in den Blobstore).
  - Gleiche Bytes in zwei Posts: ein Blob, `reference_count` 2, ein Schreibvorgang. Alter Verlauf mit `l-`-Schlüsseln und doppelten Postzeilen: keine neuen Zeilen, kein Download. Neuer Post danach wird geladen.
  - Stoppregel: nach Fehllauf voller Bereich, angeheftete Posts täuschen nicht (Fenster 12, 24, 48), Änderung hinter dem Stoppunkt unbemerkt (dokumentiert), offener Post hinter dem Stoppunkt wird erneut geholt und danach nicht mehr.
  - Schlüssel für Instagram, Patreon, Pixiv gegen die Fixtures der echten Extraktoren; yt-dlp Einzelvideo = Listeneintrag; `endOfNewPosts` einzeln.
  - Medienliste mit gesetzten Dubletten (neueste Zeile gewinnt, Zähler, Seiten, Typfilter, anderes Abo getrennt, nichts gelöscht). Report-Skript: Werte und schreibgeschützt. YouTube-Playlist zweimal gelesen.
- Mutationsprobe (kurz verändert, wieder zurück): ohne Stoppregel scheitern 5 Tests, ohne Regel für alte Schlüssel 2, ohne Wiedererkennung per Datei-ID 1, mit der alten Medienliste 4.

Nicht geprüft:

- Kein echter Plattformzugriff. Alle Auflistungen sind die Fixtures der echten Extraktoren (gallery-dl 1.32.16) oder daraus abgeleitete Änderungen. Wie Instagram sich wirklich zwischen zwei Anfragen unterscheidet, ist nicht beobachtet.
- Das Skript wurde nur über den pg-Treiber ausgeführt (ohne `\echo`), nicht mit `psql` (nicht installiert).

Geänderte bestehende Tests (Abweichung von "nur neue Dateien unter tests/dedupe", unvermeidbar, weil sie das alte Format prüften): `tests/adapters/gallery-dl-adapter.test.ts`, `tests/adapters/yt-dlp-adapter.test.ts`, `tests/instagram/listing.test.ts`, `tests/platforms/ytdlp-adapter.test.ts` (Format `l-`/`d-`/`f-` zu `g-`/`v-`; ein Test hieß "keeps the revision of a video archived before lists existed" und prüft jetzt "id alone"), `tests/platforms/credentials-worker.test.ts` (Patreon-Datei-ID `file-0` zu `hash-…`). Jeweils eine Zeile bis wenige Zeilen.

## Annahmen

- Die Ursache auf der VM ist Datum oder Endung der Profilauflistung (siehe oben), wahrscheinlich die Endung.
- Der Blobstore der Produktion ist `DatabaseBlobStore` (`worker.ts`). Das Erhöhen von `blobstore_objects.reference_count` aus dem Worker per SQL koppelt den Worker an dessen Tabelle (`packages/blobstore` darf ich nicht ändern, eine API zum Erhöhen gibt es nicht).
- Ein Post gilt über alle Abos des Benutzers als bekannt (der Unique-Schlüssel ist je Benutzer). Das war schon vorher so.
- Rückscan, Cursor-Fortsetzung und ein "Erneut herunterladen" wurden nicht gebaut.
- Fenstergröße 12 und 3 bekannte Posts in Folge sind meine Wahl (Instagram liefert etwa 12 Posts je Seite, Plan 04 verlangt ein Überlappungsfenster), nicht aus einer Messung.
- Die Patreon-Hash-IDs und Pixiv-Seiten-IDs sind aus den Fixtures abgeleitet (`hash`, `url`, `num`), nicht an einer echten Antwort geprüft.

## Risiken

- Posts mit altem Schlüssel: spätere Bearbeitungen bleiben unbemerkt (siehe oben).
- Ein gelöschter oder nie lesbarer offener Post kostet bis zu 10 Anfragen je Lauf, bis er erledigt ist. Es gibt kein Zählwerk dafür.
- Ein Patreon-Beitrag mit gesperrten Inhalten (`ASSET_NOT_ACCESSIBLE`) gilt nicht als erledigt, wird also je Lauf erneut gelesen und verhindert das frühe Stoppen, wenn er im Fenster liegt. Gewollt, kostet aber Anfragen.
- Ein Lauf, der nicht `stored` endet (zum Beispiel wegen eines dauerhaften Fehlers eines Posts), hebt das frühe Stoppen für den nächsten Lauf auf. Sicher, aber langsam.
- Der Test für das Skript nutzt nicht `psql`.
- Fremdes Abo mit demselben Post: `upsertPost` behält die `subscription_id` der ersten Zeile; ein zweites Abo, das denselben Post enthält, sieht ihn in seiner Medienliste nicht. Das war schon vorher so und ist nicht Teil dieser Karte.
- Kollisionen: `apps/worker/src/executor.ts` und `history.ts` sind jetzt größer (666 → ca. 790 Zeilen, 402 → ca. 560). Falls weitere Karten dort anbauen, besser vorher aufteilen.

## Offene Fragen

- Soll es einen regelmäßigen Rückscan (Plan 04 Punkt 2) geben, damit Bearbeitungen alter Posts erkannt werden? Er würde das Fenster zum Beispiel einmal am Tag über die ganze Grenze legen.
- Soll das Aufräumen der Dubletten (Zeilen, Referenzzähler) eine eigene Karte werden, wenn der Auftraggeber den Report gesehen hat?
- Die rohen Auflistungen eines Instagram-Profils zweimal hintereinander aufheben und vergleichen, um das Feld sicher zu benennen?

## Nächster Schritt

Review durch den Reviewer, danach Merge von `fix/duplicates` durch den Orchestrator. Auf der VM nach dem Deploy: zwei Läufe abwarten, dann `report-duplicates.sql` zeigen und prüfen, dass `download_posts` nicht mehr wächst.
