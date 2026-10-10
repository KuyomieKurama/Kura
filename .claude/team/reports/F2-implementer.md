# F2 Implementer: Patreon-Feeds (Ausgabegrenze beim Auflisten, Fortschritt während der Suche, gesperrte Beiträge)

- Aufgabe: `t_9974180a` F2. Anforderungen REQ-DL-005 `66b20a66d9133e08`, REQ-DL-004 `e852201230c9a860`, REQ-DL-002 `5d6398de6dbb5063`. Kundenmeldung: "Patreon will nicht so ganz".
- Status: braucht Review.
- Artefakte: Branch `fix/duplicates` (Worktree `/work/wt/dup`), aufbauend auf den Commits von D3 (`07857a3`). Fünf Code-/Testcommits plus Commit dieses Berichts. Nichts gepusht. Keine Migration (0060 existiert schon von MEDIA, 0069 ist für VER reserviert, nichts hinzugefügt).
- Zusammenfassung: Der Feed eines Patreon-Creators wird nicht mehr als Ganzes gepuffert, sondern Nachricht für Nachricht gelesen, während gallery-dl noch arbeitet. Pro Nachricht gilt eine Grenze (8 MiB), nicht mehr 32 MiB für die ganze Ausgabe. Jede Nachricht wird sofort auf die Felder reduziert, die Kura liest. Der Worker trägt jeden Beitrag ein, sobald er gefunden ist; der Zähler `posts_found` und der Verlauf bewegen sich während der Suche, und ein Fehler weiter hinten im Feed nimmt nichts zurück. Zeitüberschreitung, zu große Antwort und ein abgebrochenes Lesen melden auf Deutsch, welche Plattform betroffen ist, und werden mit dem Backoff der Warteschlange wiederholt. Gesperrte Beiträge (höhere Stufe) werden als "nicht zugänglich" mit Grund gespeichert, sind kein Fehler des Laufs und werden nicht immer wieder gelesen.

## Ursache

`MAX_METADATA_STDOUT_BYTES = 32 MiB` begrenzte die ganze Ausgabe von `gallery-dl --dump-json`. gallery-dl druckt dort für **jede Datei** eine Nachricht `[3, url, {vollständige Beitragsdaten}]`. Mit Anmeldung sind die Beiträge freigeschaltet, der Inhalt (HTML), die Kampagne, Einbettungen und die Bildkarten stehen dann für jede Datei erneut in der Ausgabe. 50 Beiträge ergaben mehr als 32 MiB; der Lauf endete nach 8,5 Minuten mit `PROCESS_OUTPUT_LIMIT`. Ohne Anmeldung waren alle 50 Beiträge gesperrt (keine Dateien, 1,49 MB), deshalb sah es dort gut aus.

Zwei Eigenschaften von gallery-dl 1.32.16 machten die Wartezeit unsichtbar (alles aus dem Quelltext gelesen, siehe unten):

1. `--dump-json` druckt das Array erst, wenn die Extraktion fertig ist (`job.py` `DataJob.run`, Zeile 1137-1141). Vorher kommt kein einziges Byte.
2. Die 8,5 Minuten sind zum großen Teil Wartezeit: `patreon.py` `items()` (Zeile 45-77) fragt für jeden Beitrag die Dateinamen an (`_filename`, Zeile 252: ein HEAD je eingebettetem Bild mit `--sleep-request 3-6`; `request_location` je Anhang), auch für Beiträge, die `--post-range` überspringt (`job.py` `dispatch` zieht den Generator weiter, `elif process is None: continue`, Zeile 252).

## Entscheidung: (a) Strom lesen, nicht (b) Fenster

Gewählt ist (a). Begründung aus dem Quelltext:

- gallery-dl 1.32.16 kennt ein zeilenweises Format: die Konfiguration `output.jsonl` (`job.py` Zeile 1098 und 1106, `DataJob.out` Zeile 1147-1150; Handbuch `gallery-dl.conf.5`, Abschnitt `output.jsonl`: "Output -j/--dump-json data in JSON Lines format"). Jede Nachricht wird gedruckt, sobald der Extraktor sie liefert. Gesetzt wird sie mit `-o output.jsonl=true` (`option.py` `ConfigParseAction` Zeile 48-53, `__init__.py` Zeile 83 `config.set(*opts)`; ein Punktschlüssel setzt den Pfad, der Wert wird als JSON gelesen, `_parse_option` Zeile 227-233).
- (b) hätte die Arbeit vervielfacht: jedes Fenster `--post-range 11-20` läuft durch alle Beiträge davor, samt deren Anfragen mit 3-6 s Pause. Fünf Fenster zu je 10 kosten 150 statt 50 Beitragsdurchläufe. Außerdem wäre jedes Fenster eine neue Sitzung mit eigenem Risiko für Cloudflare.
- Das Lesen als Strom macht auch D3's Fenster 12/24/48 überflüssig: ein Prozess liest, und die Stoppregel wird auf dem bisher Gelesenen ausgewertet. Sie darf frühestens nach 12 gelesenen Beiträgen enden (der Überlappungsbereich aus Plan 04 bleibt erhalten, Konstante `MIN_POSTS_READ_BEFORE_STOP`).

**Preis der Entscheidung, und wie er bezahlt ist.** Im Zeilenformat druckt gallery-dl den Fehlereintrag `[-1, {...}]` nicht (`DataJob.run` hängt ihn nur an `self.data` an, Zeile 1125-1128; der Exit-Code ist immer 0). Ein Strom, der endet, sagt also nicht, ob der Feed zu Ende war oder die Extraktion scheiterte (429, 403, Cloudflare, Netzwerk). Das wird so aufgefangen:

- Die Prüfung am Anfang jedes Laufs (`probe`, ein Beitrag, Array-Format) liefert Anmelde-, Not-Found- und Ratenfehler wie bisher mit Fehlereintrag.
- Endet ein Strom vor der Obergrenze, fragt `confirmEndOfFeed` einmal nach dem nächsten Beitrag (`--post-range <n+1>`, Array-Format, also mit Fehlereintrag). Kein Beitrag und kein Fehler: der Feed war zu Ende. Ein Beitrag: der Strom brach ohne Grund ab, `NETWORK_FAILED`, wird wiederholt, der Lauf sieht nicht nach "nichts Neues" aus und `checked_through` rückt nicht vor. Ein Fehlereintrag: normal eingeordnet (Anmeldung, Ratenbegrenzung, nicht gefunden). Für Patreon fragt diese Prüfung ohne Dateinamen (`-o extractor.patreon.files=[]`), damit sie nicht die HEAD-Anfragen aller übersprungenen Beiträge wiederholt.
- Ein Strom, der mit Exit-Code ungleich 0 endet, ist `PROCESS_FAILED`. Der Beitrag, der gerade gedruckt wurde, wird in diesen Fällen (Absturz, Stille, Zeitüberschreitung) nicht übernommen: seine Dateiliste kann unvollständig sein. Er kommt im nächsten Lauf.

## gallery-dl-Optionen (jede mit Quelle, gallery-dl 1.32.16, Quelltext unter `/tmp/gdl/gallery_dl-1.32.16`)

Neu in diesem Auftrag:

| Option | Zweck | Quelle |
| --- | --- | --- |
| `-o output.jsonl=true` | Feed-Liste als JSON-Zeilen, eine Nachricht pro Zeile, sofort; kein Fehlereintrag | `job.py` 1098, 1106, 1137, 1147-1150; Handbuch `output.jsonl`; `option.py` 48-53, 227-233, 612-617; `__init__.py` 83 |
| `--post-range N` (eine Zahl) | Prüfung "gibt es Beitrag N noch?" | `option.py` 825-829 und Hilfe zu `--range` (Zeile 819-824: "constant value, range, or slice"); `util.py` `predicate_range_parse` 1250-1289 (`else: start = int(group)`) |
| `-o extractor.patreon.files=[]` | nur in der Prüfung: keine Dateien je Beitrag, also keine Anfragen nach Dateinamen | `patreon.py` `items()` 45-77 und `_build_file_generators` 318-331 (Liste von Dateiarten, eine leere Liste baut keinen Erzeuger); Handbuch `extractor.patreon.files` ("list of strings") |

Unverändert, aus den Berichten IG-A und P1: `--config-ignore`, `--dump-json`, `--sleep-request`, `--sleep-extractor`, `--retries 0`, `-C <Datei>`, `-o extractor.<site>.cookies-update=false`, `-c <Datei>` (Pixiv), `--post-range 1-N`, `--post-filter` (Pixiv), `-o extractor.instagram.videos=merged`, `-o extractor.pixiv.sanity=false`, `-o extractor.pixiv.ugoira=true`. Nichts davon wurde geändert.

Nicht verwendet, weil nicht nötig: `--print`/`--Print`/`-N` (`option.py` 419-433). Das wäre ein anderer Job-Typ mit eigenem Formatstring und hätte die gesamte Auswertung neu geschrieben.

## Änderungen (was, warum, Auswirkung, Rückweg)

Alles auf dem Branch `fix/duplicates`; Rückweg für alles: `git revert` der Commits ab `f879b9c` (kein Datenbankschema, keine Migration). Die Änderungen im Einzelnen:

1. `packages/adapters/src/process-runner.ts`: `streamStdoutLines` (neu) liest stdout zeilenweise, solange der Prozess läuft. Nur die noch nicht abgeholten Zeilen (höchstens 8 MiB) werden gehalten; ist der Abnehmer langsam, wird stdout angehalten und das Werkzeug wartet in seiner Pipe. `LineSplitter` hält höchstens eine Zeile; eine längere wird gezählt und verworfen. Grenzen: Gesamtzeit, Zeit ohne neue Zeile (die Zeit, in der der Worker mit einem Beitrag beschäftigt ist, zählt nicht), Gesamtmenge als Sicherheitsnetz (1 GiB), Temp-Platz, Abbruch. Gelesene Zeilen werden vor einer Grenzverletzung noch ausgeliefert. Bricht der Abnehmer ab, wird die Prozessgruppe getötet und abgewartet. `runExternalProcess` benutzt dieselbe `ProcessGuard`-Klasse (Zeit, Temp, Abbruch, Kill-Frist); sein Verhalten ist gleich geblieben (bestehende Tests grün).
2. `packages/adapters/src/cli-support.ts`: `CliTool.streamMetadata`; Konstanten `MAX_STREAMED_MESSAGE_BYTES` 8 MiB, Gesamtzeit 2 h, Stille 15 min. `runMetadata` (Array) bleibt für Einzelbeitrag, Prüfung und End-Prüfung.
3. `packages/adapters/src/gallery-dl-output.ts`: `slimMetadata` reduziert jede Nachricht beim Eintreffen auf die Felder, die `listingOfPost` liest (feste Liste, Texte begrenzt; Personen/Album nur `id`/`name`/`full_name`/`title`; `embed` nur als Vorhanden-Marke plus `url`/`provider_url`; `frames` nur `file`/`delay`). `FeedMessageReader` baut die Beiträge aus den Zeilen auf und gibt einen Beitrag heraus, wenn der nächste beginnt. `parseDumpJson` (Array) benutzt dieselbe Reduktion.
4. `packages/adapters/src/gallery-dl-listing.ts`: `FeedStreamReader` (Zeilen rein, `PostListing` raus, Dubletten und Beiträge ohne Id wie bisher ausgelassen). `endOfNewPosts` nimmt nur noch `postId` und `date` entgegen.
5. `packages/adapters/src/gallery-dl-adapter.ts`: `discoverFeed` (Strom, frühes Ende bei bekannten Beiträgen und an der Obergrenze, `confirmEndOfFeed`, Fehlerumsetzung). Entfernt: die Fensterschleife `listNewPosts`. Neue Optionen `feedListingTimeoutMs` (2 h) und `feedListingIdleTimeoutMs` (15 min). `describeToolFailure` setzt Zeitüberschreitung und Ausgabegrenze in deutsche Sätze mit Plattformname um; eine Zeitüberschreitung, in der gallery-dl auf ein Ratenlimit wartete, bleibt `RATE_LIMITED`.
6. `packages/adapters/src/types.ts`: neuer Code `ASSET_LOCKED` für `unavailable`.
7. `apps/worker/src/executor.ts`: `recordDiscovered` (Zähler und Verlauf bewegen sich während der Suche; gefundene, nicht archivierte Beiträge werden sofort als `discovered` eingetragen); ein Fehler der Suche nach mindestens einem Beitrag behält die gefundenen Beiträge, arbeitet sie ab und beendet den Lauf danach mit dem Fehler (früher nur bei Anmelde-/Ratenfehlern, sonst gingen sie verloren); die Beiträge werden vor der Verarbeitung neueste zuerst sortiert (`newestFirst`, vorher im Adapter); `ASSET_LOCKED` zählt nicht als Fehler.
8. `apps/worker/src/history.ts`: `settledPost` zählt einen Beitrag mit nur `ASSET_UNSUPPORTED`/`ASSET_LOCKED` als erledigt. Wird er freigegeben, listet Patreon Dateien, und der Revisionsschlüssel (Beitrag plus Dateimenge) ändert sich.
9. `apps/worker/src/failure.ts`: Sätze des Adapters gelten auch für `PROCESS_TIMEOUT`, `PROCESS_OUTPUT_LIMIT`, `NETWORK_FAILED`; `PROCESS_OUTPUT_LIMIT` wird wiederholt statt endgültig zu scheitern.
10. `apps/worker/src/catalog.ts`: reicht die beiden Zeitoptionen durch (nur für Tests gesetzt; Produktion nutzt die Standardwerte).
11. `apps/web/src/Ledger.tsx`, `history-labels.ts`: ein gesperrter Beitrag zeigt "Nicht zugänglich" mit Grund (neutral, nicht rot) und "n nicht zugänglich" statt "fehlgeschlagen".

### Meldungen (wörtlich)

- Zeitüberschreitung: "Patreon hat nicht rechtzeitig geantwortet; die Abfrage hat zu lange gedauert. Bereits gefundene Beiträge bleiben erhalten; Kura versucht es später automatisch erneut." (`retry_wait`, Backoff der Warteschlange mit Obergrenze der Versuche.)
- Strom brach ab: "Die Liste der Beiträge von Patreon brach unvollständig ab. Bereits gefundene Beiträge bleiben erhalten; Kura versucht es später automatisch erneut."
- Eine Nachricht über 8 MiB: "Ein Beitrag von Patreon ist zu groß, um gelesen zu werden. Die übrigen Beiträge wurden verarbeitet. Wenn der Fehler bleibt, ist dieser Beitrag nicht abrufbar." (wird wiederholt, endet nach den Versuchen als `failed`.) Der Satz "Die Antwort von Patreon war zu groß" aus der Aufgabe kommt nur noch bei einer Gesamtausgabe über 1 GiB vor ("Die Antwort von Patreon war ungewöhnlich groß und wurde abgebrochen ...").
- Gesperrt: "Nicht zugänglich: Der Beitrag ist für das hinterlegte Patreon-Konto gesperrt (zum Beispiel nur für Mitglieder einer höheren Stufe). Das ist kein Fehler. Sobald Patreon den Beitrag für dieses Konto freigibt, lädt Kura ihn automatisch."

## URL-Formen (Auftragspunkt 5)

`/cw/<name>`, `/cw/<name>/posts`, `/c/<name>`, `/c/<name>/posts`, `/<name>`, `/<name>/posts` (auch ohne `www`, mit Schrägstrich am Ende, mit Query und Fragment) werden alle zu `https://www.patreon.com/c/<name>/posts`, Typ `creator_feed`, `platformId` `<name>` (`patreon-target.ts`, getestet in `tests/patreon/targets-and-messages.test.ts`). Die kanonische Form passt auf das Creator-Muster von gallery-dl 1.32.16 (`patreon.py` Zeile 419-424: `(?:cw?/)?([^/?#]+)(?:/posts)?`, mit Ausschlussliste `home|create|login|signup|search|posts|messages`) und liefert denselben Namen; zum Beitrags-Muster (`/posts/<zahl>`) passt sie nicht. Das Muster steht im Test als JavaScript-Übersetzung des Python-Musters; geprüft gegen den gelesenen Quelltext, nicht mit dem laufenden Programm. Nicht entschieden: `/aiusagichan` und `/AIusagichan` sind zwei Ziele (die Schreibweise bleibt, wie getippt); ob Patreon sie gleich behandelt, weiß ich nicht.

## Prüfung

Ausgeführt (`export DATABASE_URL=postgres://kura_dev:***@127.0.0.1:5432/kura_dev`):

- Vorher (Stand D3, `07857a3`): `corepack pnpm check` grün, 63 Dateien, 1324 bestanden, 1 übersprungen.
- Nachher: `corepack pnpm check` zweimal hintereinander grün (Exit 0), je 68 Dateien, 1394 bestanden, 1 übersprungen. 5 neue Dateien und 70 neue Tests (alle unter `tests/patreon/`). Logs: `/tmp/f2-check-1.log`, `/tmp/f2-check-2.log`. Dazu `corepack pnpm --filter @kura/web test`: 14 Dateien, 94 Tests grün (2 neu in `apps/web/src/Locked.test.tsx`; dieser Lauf gehört nicht zu `pnpm check`).
- Neue Tests (`tests/patreon/`, echte PostgreSQL, gefälschtes gallery-dl, kein Netz):
  - `line-stream.test.ts` (16): Zeilen kommen an, während der Prozess läuft; 60 MiB in 3.000 Zeilen werden gelesen; Zeilen über der Grenze werden gezählt und nicht gehalten; Gegendruck (ein langsamer Abnehmer hält das Werkzeug zurück: weniger als 12 MiB werden ausgegeben); Stille, Gesamtzeit, Gesamtmenge, Abbruch, Kill der Prozessgruppe samt Kindprozess.
  - `large-listing.test.ts` (14): ein Feed aus 50 Beiträgen mit je 8 Dateien und 110 KiB Inhalt je Nachricht, **50,8 MiB** Ausgabe, in 40-KB-Stücken geschrieben, mit Pause je Beitrag: alle 50 Beiträge kommen an; **Spitzenverbrauch 13,0 MiB** (Heap plus Puffer, gemessen alle 5 ms), Prüfung `< Ausgabe / 2` und `< 80 MiB`. Stoppregel (frühestens nach 12 Beiträgen, Prozess wird beendet), keine Abkürzung bei neueren Beiträgen hinter bekannten, Obergrenze, End-Prüfung, Strom ohne Wort beendet (Beiträge bleiben, `NETWORK_FAILED`), Drosselung in der Prüfung, Absturz, Stille, zu große Nachricht, Fehler vor dem ersten Beitrag.
  - `worker.test.ts` (8): Beiträge erscheinen in der Datenbank, während der Feed gelesen wird (`posts_found` nimmt in mindestens vier Zwischenständen zu, `discovering`); Fehler in der Mitte behält 8 von 12 Beiträgen, der Lauf endet `partially_completed` mit der deutschen Meldung, `checked_through` rückt nicht vor, der nächste Lauf vervollständigt ohne Dubletten (8 übersprungen, 4 gespeichert); Warteschlange `retry_wait`; Zeitüberschreitung; zu große Nachricht; gesperrte Beiträge (`ASSET_LOCKED`, Lauf `stored`, `assets_failed` 0, in späteren Läufen weder Einzelabfrage noch Download, nach Freigabe wird der Beitrag geladen).
  - `slimming.test.ts` (11): für alle Listen der echten Extraktoren (Instagram, Patreon, Pixiv, Pornhub-Album) ergibt die reduzierte Nachricht dieselbe `PostListing` wie die vollständige; die Reduktion lässt Felder weg, die niemand liest.
  - `targets-and-messages.test.ts` (21): URL-Formen, Muster von gallery-dl, deutsche Meldungen und Wiederholung.
- Instagram und Pixiv: die bestehenden Suiten laufen durch den neuen Weg (`tests/instagram/*`, `tests/platforms/adapter.test.ts`, `tests/platforms/credentials-worker.test.ts`, `tests/dedupe/*`) und sind grün; geändert wurde nur, was die neue Arbeitsweise sichtbar ändert (siehe unten).
- Mutationsprobe: siehe Abschnitt am Ende.

Nicht geprüft:

- **Kein laufendes gallery-dl.** Auf diesem Rechner ist weder gallery-dl noch das Python-Paket `requests` installiert; der Versuch, `python3 -m gallery_dl` aus dem Quelltext zu starten, scheiterte mit `ModuleNotFoundError: requests`. Alle Aussagen über `output.jsonl`, `--post-range N` und `extractor.patreon.files=[]` stammen aus dem gelesenen Quelltext und dem Handbuch von 1.32.16, nicht aus einem Lauf. Das gefälschte Werkzeug gibt wieder, was ich dort gelesen habe.
- Keine echte Patreon-Antwort. Insbesondere nicht bestätigt: wie viele Anfragen und wie viel Zeit ein Lauf wirklich braucht (der Fehlschlag vom 10.10. dauerte 8,5 min bis zur Grenze); dass Patreon gesperrte Beiträge mit `current_user_can_view: false` und ohne Dateien meldet (so liest es der Quelltext, `patreon.py` 51-53, und so war es ohne Cookies auf der VM).
- Die Web-Oberfläche wurde nicht im Browser angesehen, nur mit dem Komponententest geprüft.

## Geänderte bestehende Tests (Abweichung von "nur neue Dateien unter tests/patreon", unvermeidbar)

Neues Format der Argumente (`-o output.jsonl=true`), Reihenfolge und Zählung durch den Strom, `ASSET_LOCKED`:

- `tests/instagram/fake-instagram-tool.ts`, `tests/dedupe/feed-tool.ts` (Fälschungen): geben mit `output.jsonl=true` Zeilen ohne Fehlereintrag aus, verstehen `--post-range N` und `--post-range A-B`; neue Steuerung `ignoreRange`.
- `tests/instagram/listing.test.ts`: Reihenfolge ist die des Werkzeugs (angeheftete Beiträge zuerst; das Sortieren macht jetzt der Worker); Argumente; zwei `rawOutput`-Tests auf `ignoreRange`/`listings` umgestellt; `posts[0]` zu "der Reel".
- `tests/instagram/cookies.test.ts`: 6 statt 5 Aufrufe (die End-Prüfung trägt die Cookies ebenfalls; jede Schleife prüft `-C`).
- `tests/instagram/pipeline.test.ts`: Aufrufe der Liste (3 statt 2 für ein kurzes Profil).
- `tests/dedupe/incremental.test.ts`: statt Fenstern 1-12/1-24/1-48 steht ein Strom `1-50`, der nach den ersten 12 Beiträgen mit bekannten Beiträgen endet.
- `tests/platforms/adapter.test.ts`, `tests/platforms/credentials-worker.test.ts`: Argumente, `ASSET_LOCKED`.
- `tests/platforms/ytdlp-worker.test.ts`: (1) Die Läufe werden nach Startzeit sortiert, und beide Läufe hatten dieselbe Uhrzeit (die Uhr des Tests steht still); die Reihenfolge hing an der Lage der Zeilen im Heap. Der Test lässt die Uhr jetzt um 60 s weiterlaufen. (2) Nach dem Bot-Check sind die anderen fünf Videos nun als "gefunden" (`discovered`) eingetragen, statt gar nicht vorzukommen; das ist die verlangte progressive Aufzeichnung.
- `tests/m5b/fixture.ts`: Option `feedListingIdleTimeoutMs`.

## Betrieb auf der VM

- Kein Datenbankschema, keine Migration. Vorhandene Beiträge bleiben.
- Der Fehllauf `192897c1` hat nichts gespeichert. Der nächste Lauf liest den Feed (mit Cookies) in einem Strom: Beiträge erscheinen in der Oberfläche, sobald gallery-dl sie liefert, nicht erst nach Minuten. Die Pausen von 3-6 s je Anfrage bleiben (Kuras eigene Wahl, `PLATFORM_SETTINGS`). Dass der erste Lauf nicht in 8,5 Minuten fertig ist, ist zu erwarten; er hat jetzt aber keine Obergrenze von 32 MiB mehr, nur 2 h Gesamtzeit und 15 min ohne Ausgabe.
- Hinweis: Ein Lauf mit vielen Beiträgen und vielen eingebetteten Bildern kann länger als 15 Minuten *an einem einzigen Beitrag* brauchen (jedes Bild eine Anfrage mit Pause). Dann gilt die Stille-Grenze (`PROCESS_TIMEOUT`, wird wiederholt). Die Grenze ist ein Standardwert (`feedListingIdleTimeoutMs`), keine Umgebungsvariable.
- Frühere Läufe ohne Cookies haben gesperrte Beiträge unter dem Code `ASSET_NOT_ACCESSIBLE` eingetragen (Fehlschlag). Diese Zeilen bleiben. Sobald die Beiträge mit Cookies Dateien haben, bekommen sie einen neuen Revisionsschlüssel und werden normal geladen.
- Nach dem Deploy auf der VM prüfen (nur lesend): im Verlauf `download_runs` des nächsten Laufs, ob `posts_found` während `discovering` steigt, und ob der Lauf `stored` oder `partially_completed` mit einer der oben genannten Meldungen endet.

## Annahmen

- gallery-dl 1.32.16 verhält sich auf der VM wie der gelesene Quelltext (siehe "Nicht geprüft"); insbesondere dass `-o output.jsonl=true` in Verbindung mit `--dump-json` Zeilen statt eines Arrays ausgibt (`job.py` 1106 und 1137: `if self.file and not self.jsonl`), und dass der Prozess dabei mit Exit-Code 0 endet.
- Ein gelesener Beitrag ist vollständig, wenn der nächste `[2, ...]` beginnt oder der Strom sauber (Exit 0) endet.
- Die `--post-range`-Zählung von gallery-dl und die Zahl der gedruckten `[2, ...]`-Nachrichten stimmen überein (`job.py` `dispatch` ruft `pred_post` genau einmal je Beitrag und druckt dann das Verzeichnis).
- 8 MiB je Nachricht reichen. Gemessen habe ich keine echte Nachricht. Aus dem Fehllauf folgt nur: mehr als 32 MiB für höchstens 50 Beiträge, also im Mittel weniger als einige MiB je Beitrag und weniger je Nachricht; die Fälschung nutzt 110 KiB je Nachricht.
- Stillezeit 15 min und Gesamtzeit 2 h sind meine Wahl, nicht aus einer Messung.
- Ein gesperrter Patreon-Beitrag hat im Strom keine Datei-Nachricht (`patreon.py` `items()` Zeile 51-53: `continue` nach dem Verzeichnis), also leere Dateimenge, und wird später mit Dateien neu geschlüsselt.

## Risiken

- **Echter Lauf offen.** Wenn `output.jsonl` auf der VM anders wirkt als gelesen, schlägt der Strom fehl. Der Befund wäre sofort sichtbar (`OUTPUT_INVALID`, "Tool output is not valid JSON" bei der ersten Zeile).
- **Verdopplung der Anfragen bei kurzen Feeds**: endet ein Feed vor der Obergrenze, kommt die End-Prüfung dazu (bei Instagram mit 8-15 s Pause je Seite). Bei Patreon ist sie billig (keine Dateinamen), bei Instagram und Pixiv nicht.
- Ein Beitrag, der gerade gedruckt wird, wenn der Strom abbricht, wird verworfen, auch wenn er vollständig war. Er kommt im nächsten Lauf.
- Die Reihenfolge in `lastSeenPostId` bleibt "neueste zuerst, letzter = ältester" (Sortierung im Worker); gilt nur, wenn alle Beiträge ein Datum haben, wie in D3.
- Gefundene, aber nicht bearbeitete Beiträge (Lauf bricht wegen Anmeldung/Rate ab) stehen jetzt als `discovered` in der Datenbank, vorher gar nicht. Sie gelten nicht als erledigt und werden im nächsten Lauf geholt; die Medienliste zeigt nur gespeicherte Dateien, ändert sich also nicht.
- Läuft eine Anmeldung mit abgelaufenen Cookies, kann Patreon *alle* Beiträge als gesperrt melden (so war es ohne Cookies auf der VM). Der Lauf endet dann als "gespeichert", ohne Hinweis. Siehe offene Fragen.
- Der Strom-Reader nimmt für Pixiv und Instagram dieselben Nachrichten, die vorher im Array standen; die Äquivalenz ist an den Fixtures der echten Extraktoren geprüft (`slimming.test.ts`), nicht an einer echten Antwort.
- **Hotspot:** `apps/worker/src/executor.ts` (810 Zeilen, vorher 773) und `packages/adapters/src/gallery-dl-adapter.ts` (825). Wenn weitere Karten dort anbauen, vorher aufteilen: Entdeckung (`discover`, `recordDiscovered`, `rediscoverOpenPosts`, `knownPostsOfFeed`) in eine eigene Datei.

## Offene Fragen

- Soll ein Lauf, in dem **alle** Beiträge eines Patreon-Creators gesperrt sind, obwohl ein Login gespeichert ist, einen Hinweis zeigen ("Möglicherweise sind die Cookies abgelaufen")? Das wäre ein neues Feld im Lauf oder eine eigene Meldung, nicht Teil dieser Karte.
- Sollen `AIusagichan` und `aiusagichan` dasselbe Ziel sein? (Ich weiß nicht, ob Patreon die Schreibweise unterscheidet.)
- Soll die Stillezeit (15 min) und die Gesamtzeit (2 h) als Umgebungsvariable einstellbar sein?
- Soll `resolveAssets` für einen sehr großen Einzelbeitrag ebenfalls als Strom gelesen werden? Dort gilt weiter die Gesamtgrenze von 32 MiB für ein Array (ein Beitrag mit 300 Dateien à 110 KiB wäre knapp darüber). Ich habe es nicht angefasst, weil die Karte die Feed-Liste meint.
- Ein echter Probelauf von `gallery-dl --config-ignore --dump-json -o output.jsonl=true --post-range 1-3 -- <Creator-URL>` auf der VM (mit Cookies) würde die Annahmen bestätigen; die rohe Ausgabe zweimal aufzuheben würde zugleich das Feld klären, das D3 offen ließ.

## Nächster Schritt

Review durch den Reviewer, danach Merge von `fix/duplicates` durch den Orchestrator. Auf der VM: einen Lauf des Patreon-Abos abwarten, `posts_found` während `discovering` beobachten, Ergebnis des Laufs (gespeichert/Meldung) lesen. Bei einem Fehler zuerst die ersten Bytes der Ausgabe von `gallery-dl ... -o output.jsonl=true` ansehen.

## Mutationsprobe (kurz verändert, wieder zurückgesetzt, Baum sauber)

| Veränderung | Ergebnis |
| --- | --- |
| End-Prüfung `confirmEndOfFeed` ausgeschaltet | 6 Tests schlagen fehl (großer Feed, Strom ohne Wort, Drosselung, Lauf in der Mitte) |
| Fehler in der Mitte verwirft die gefundenen Beiträge (altes Verhalten) | 1 Test schlägt fehl (`keeps the posts found before the end`) |
| Beiträge werden nicht während der Suche eingetragen | 4 Tests schlagen fehl (Fortschritt, Absturz in der Mitte, Zeitüberschreitung, gesperrte Beiträge) |
| Gesperrter Beitrag zählt als Fehler des Laufs | 1 Test schlägt fehl |
| Kein Gegendruck (Warteschlange 8 GiB) | 1 Test schlägt fehl (`holds the tool back`) |
| Stoppregel darf schon nach 3 Beiträgen enden | 3 Tests schlagen fehl (Überlappungsfenster, zwei D3-Tests) |
| Nachrichten werden nicht reduziert | 2 Tests schlagen fehl (`slimming.test.ts`) |

Für die Speichergrenze des Adapters selbst (Spitzenwert 13,0 MiB bei 50,8 MiB Ausgabe) gibt es keine einzelne Mutation, die nur sie bricht; sie hängt an Gegendruck (oben) und an der Reduktion (oben), beide geprüft.
