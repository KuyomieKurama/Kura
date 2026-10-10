# F1 Implementer: Unbehandeltes ERR_STREAM_DESTROYED im Prüftor

- Aufgabe: `t_44fb1dd0` F1. Anforderungen REQ-DL-006 `41a71ca708d3fc58`, REQ-DL-002 `5d6398de6dbb5063`. Umfang nur dieser Fehler (D-019).
- Status: fertig (zur Abnahme).
- Artefakte: Branch `lane/media`, Worktree `/work/wt/media`, ein Fix-Commit `5ac726d` auf Stand `5e6181c` plus Commit dieses Berichts. Nichts gepusht.
- Zusammenfassung: Produktionsfehler in `packages/adapters/src/staging.ts` (`stageByteStream`), kein Testproblem. Behoben mit `stream/promises.pipeline`. Regressionstest deterministisch (vorher 10 von 10 Fehlschläge, nachher grün).

## Ursache

Reproduziert: `corepack pnpm exec vitest run` (ganze Suite) bei sechs parallelen CPU-Schleifen, Lauf 2. Sechs Einzelläufe der Datei `pipeline-failures.test.ts` unter vier CPU-Schleifen blieben grün, die Suite ohne Last auch. Ergebnis des fehlgeschlagenen Laufs: 58 Dateien bestanden, 1291 Tests bestanden, 1 übersprungen, aber `Errors 1 error`, Exit 1.

Stapel (Vitest, „Uncaught Exception"):

```
Error: Cannot call write after a stream was destroyed
 ❯ node:internal/fs/streams:431:23          (writeAll in lib/internal/fs/streams.js, Node v22.23.2)
 ❯ FSReqCallback.wrapper [as oncomplete] node:fs:809:5
Serialized Error: { code: 'ERR_STREAM_DESTROYED' }
Letzter Test davor: "records nothing in the queue when the lease was lost"
```

Ablauf:

1. `stageByteStream` schreibt Chunks mit `output.write(chunk)` (ohne auf das Ende des Schreibens zu warten, solange `write` `true` liefert) in eine `fs.WriteStream`.
2. Bricht die Quelle ab (verlorene Lease, Abbruch, Verbindungsabbruch, Größenlimit der Quelle), geht die Schleife in den `catch` und ruft `output.destroy()`. Das Schreiben des letzten Chunks läuft zu diesem Zeitpunkt noch im Thread-Pool.
3. Node merkt das fertige Schreiben an einem zerstörten Stream (`writeAll`: `this.destroyed` → `ERR_STREAM_DESTROYED('write')`) und gibt den Fehler an `close()` weiter. Der Stream sendet nun ein Ereignis `error`.
4. An der Datei hing kein `error`-Listener (`once(output, 'drain')` gilt nur, solange darauf gewartet wird). Ein `error`-Ereignis ohne Listener ist eine nicht abgefangene Ausnahme.

Pfad: Worker-Executor (`apps/worker/src/executor.ts:497`) und `packages/adapters/src/delivery.ts:67` → `stageByteStream`. Andere Pfade geprüft und unauffällig: `blob-import.ts` (liest mit `for await`, schreibt in den Blobstore ohne Dateistrom), `process-runner.ts` (`sha256OfFile` hat `error`-Listener), `cli-support.ts`/`hashFile` (`for await`), `network-guard.ts` (Fehler der Quelle zerstört die Anfrage mit Fehler, `outgoing` hat Listener).

## Produktion oder Test

Produktion. Im Worker-Prozess würde dieselbe nicht abgefangene Ausnahme den ganzen Worker beenden, sobald ein Download mit gerade laufendem Schreiben abbricht (Abbruch durch Nutzer, verlorene Lease, abgerissene Verbindung). Dass sie im Test selten auffiel, liegt nur am Zeitfenster: der letzte Chunk muss noch im Thread-Pool sein, wenn die Quelle fehlschlägt. Unter Last ist das Fenster größer. Eine Änderung am Test wäre falsch: sie würde den Fehler verstecken. Auch ein Plattenfehler (z. B. ENOSPC) zwischen zwei Chunks hätte denselben Effekt (`error` ohne Listener) und ist mit behoben.

## Änderungen (alle)

1. `packages/adapters/src/staging.ts`, `stageByteStream`: Schreiben jetzt über `await pipeline(measured(), output)`. `measured()` ist ein Async-Generator, der die Quelle durchreicht und dabei Bytes zählt, das Limit prüft (`SIZE_LIMIT`) und den Hash bildet. `pipeline` hält einen Fehler-Listener an der Datei, zerstört sie bei Fehlern der Quelle mit diesem Fehler und beendet erst, wenn die Datei geschlossen ist; erst danach löscht der `catch` die Teildatei. Entfernt: manuelles `output.write`/`once(output, 'drain')`/`output.end()`/`output.destroy()` und der Import `once` aus `node:events`. Fehlerklassen und -texte unverändert (der Fehler der Quelle kommt unverändert zurück). Auswirkung: kein unbehandelter Streamfehler mehr; Verhalten bei Erfolg, Größenlimit und leerem Download gleich.
2. `tests/adapters/staging.test.ts`: neuer Test „survives a source that fails while a write is still in flight: no unhandled error, no partial file" (siehe unten).

Rückgängig: `git revert 5ac726d` (stellt den alten Code und den Fehler wieder her). Keine Migration, keine Datenänderung. Keine anderen Dateien, keine verbotenen Dateien berührt.

## Regressionstest

`tests/adapters/staging.test.ts`, 10 Durchläufe in einem Test: die Quelle liefert einen Chunk, wartet 20 ms (Datei ist offen, Schreiben fertig), liefert den zweiten Chunk und wirft sofort „connection reset". Das Schreiben des zweiten Chunks läuft dann im Thread-Pool, während der Stream abgebaut wird. Der Test nimmt die `uncaughtException`-Listener von Vitest für die Dauer des Szenarios heraus, sammelt eigene, wartet 100 ms (das Ereignis kommt asynchron) und stellt wieder her. Erwartet: Fehler „connection reset" kommt bei jedem Aufruf an, keine Teildatei bleibt, keine nicht abgefangene Ausnahme. Das ist die Ursache, kein globales Schlucken: der Eingriff gilt nur im Test.

- Vorher (alter Code): schlägt 3 von 3 Läufen fehl, jeweils 10 Mal „Cannot call write after a stream was destroyed". Ein freistehender Node-Versuch mit demselben Ablauf: 50 von 50 Ausnahmen.
- Nachher: `tests/adapters/staging.test.ts` und `tests/adapters/direct-url-adapter.test.ts`: 5 Läufe hintereinander 72 von 72 bestanden.

## Prüfung (ausgeführt)

Fünf aufeinanderfolgende vollständige `corepack pnpm check` (typecheck, lint, Web-Build und Vitest mit echter PostgreSQL, Build aller Pakete), Fix-Stand `5ac726d`, ohne zusätzliche Last. Ergebniszeilen:

```
gate 1 exit=0 ERR_STREAM_DESTROYED=0  Test Files 58 passed (58) | Tests 1292 passed | 1 skipped (1293)
gate 2 exit=0 ERR_STREAM_DESTROYED=0  Test Files 58 passed (58) | Tests 1292 passed | 1 skipped (1293)
gate 3 exit=0 ERR_STREAM_DESTROYED=0  Test Files 58 passed (58) | Tests 1292 passed | 1 skipped (1293)
gate 4 exit=0 ERR_STREAM_DESTROYED=0  Test Files 58 passed (58) | Tests 1292 passed | 1 skipped (1293)
gate 5 exit=0 ERR_STREAM_DESTROYED=0  Test Files 58 passed (58) | Tests 1292 passed | 1 skipped (1293)
```

Belastungslauf wie bei der Reproduktion (sechs CPU-Schleifen parallel, ganze Vitest-Suite, 6 Läufe hintereinander; Vorher-Stand schlug in Lauf 2 fehl):

```
run 1 exit 0 streamerr=0
run 2 exit 0 streamerr=0
run 3 exit 0 streamerr=0
run 4 exit 0 streamerr=0
run 5 exit 0 streamerr=0
run 6 exit 0 streamerr=0
```

Jeder Lauf: 1292 bestanden, 1 übersprungen, keine Zeile „Errors". Die Zahl der Tests stieg von 1291 auf 1292 durch den neuen Test.

## Annahmen

- Die Reproduktion (1 Treffer in 2 Läufen unter Last, vorher) zeigt dieselbe Ursache wie der Befund des Verifiers V7; dessen Protokoll lag mir nicht vor. Der Stapel ist derselbe Fehlercode (`ERR_STREAM_DESTROYED`, Datei `pipeline-failures.test.ts`, „Uncaught Exception").
- Das Verhalten von `writeAll` und `_destroy` habe ich am Quelltext von Node v22.23.2 (`lib/internal/fs/streams.js`, von GitHub geladen) und mit Versuchsskripten bestätigt; andere Node-Versionen nicht geprüft.
- Dass `pipeline` nach einem Fehler die Fehler-Listener nicht entfernt, schließe ich aus dem Versuch (keine nicht abgefangene Ausnahme in 10 + 6 Läufen), nicht aus dem Quelltext von `pipeline`.
- Der Pfad „Plattenfehler zwischen zwei Chunks" ist durch `pipeline` abgedeckt, aber nicht mit eigenem Test belegt (ENOSPC lässt sich in der Sandbox nicht sicher erzeugen).

## Risiken

- `pipeline` wirft den Fehler der Quelle weiter, sobald die Datei geschlossen ist; ein hängender Quell-Iterator (der nie zurückkehrt) würde weiterhin hängen wie vorher. Abgedeckt durch die Zeitüberwachung der Adapter, nicht Teil dieser Aufgabe.
- Bei `flags: 'wx'` und einer bereits vorhandenen Datei (Wettlauf nach `assertAbsent`) löscht der `catch` wie zuvor die Datei. Unverändert, nicht Teil dieser Aufgabe.
- Im Worktree liegt ein nicht versionierter Ordner `shots-out/` (stammt nicht von dieser Aufgabe, nicht angefasst, nicht committet).

## Offene Fragen

Keine.

## Nächster Schritt

Review und Verifier-Lauf des Prüftors auf `lane/media`; Orchestrator führt Merge durch.
