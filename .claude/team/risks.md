# Risiken

- R-01: Plattform-Extractor (Instagram, Pornhub, Pixiv, Patreon) sind wartungsbedürftig und keine Funktionsgarantie.
- R-02: Immich-API-Verhalten (Originalprüfung, Dubletten) noch nicht live getestet; Löschfreigabe hängt davon ab.
- R-03: Lizenzmix (gallery-dl GPL, FFmpeg LGPL/GPL, Immich AGPL) verhindert "reines MIT"-Gesamtpaket.
- R-04: Aufwand 125–205 PT; nach M0 und M3 neu schätzen.
- R-05: Immich-API-Fähigkeiten für den Originalnachweis nicht vollständig belegt (D-005). Blockiert M3-Abnahme, falls der Readback-Weg scheitert.
- R-06: Plan nennt Immich v3.2.4, Scouts finden v3.2.1 (D-004). Planangabe nicht belastbar.
- R-07: Sandbox-Platte /work bei 87 %. Kura braucht PostgreSQL und node_modules; ohne Aufräumen von SuperTakt-pr21 (3,2 GB) wird es eng.
- R-08: Echte IdP-Verträge (Authentik, Keycloak) sind bis zum Test durch den Auftraggeber unbelegt; Fake-Anbieter können Abweichungen der echten Produkte nicht aufdecken (D-011).
- R-09: Die VM liegt im selben LAN (Heimnetz) wie der Hermes-Host; es gibt keine Egress-Sperre für yt-dlp/gallery-dl (D-008, T20). Vor M5 braucht die VM eigenes VLAN oder nftables-Regeln auf der VM.
- R-10: `pnpm install --frozen-lockfile` in frischer Umgebung meldet ERR_PNPM_IGNORED_BUILDS (esbuild@0.27.7). `pnpm check` läuft trotzdem grün. Offen: Build-Skript-Freigabe in pnpm-workspace.yaml explizit setzen (Orchestrator-Datei), sonst scheitert ein frischer Setup oder CI womöglich am Exit-Code.
- R-11: Teststand auf <vm-ip>:8080 läuft ohne TLS im LAN. Solange es nur Fakedaten und noch keine Anmeldung gibt, ist das vertretbar; sobald M1-B/M1-C echte Anmeldung bringt, TLS-Proxy (Caddy) vorschalten oder den Zugang auf vertrauenswürdige Adressen beschränken.
- R-12 (M3, Review-Befunde): Die zwei offenen Punkte (Cleanup-Entscheidung nur aus persistiertem Beleg mit unterstützter Serverversion und Konfigurationsgeneration; Bytezahl und Albumzuordnung im Prüfbeleg, Migration 0031) wurden in Commit 6686cbc umgesetzt. Status: umgesetzt, `pnpm check` grün (25 Tests), aber NICHT erneut vom Reviewer geprüft (D-019). Vor Verdrahtung der Löschung muss der Verifier die Cleanup-Entscheidung gegen echte Immich-Daten abnehmen (R-05).
- R-13 (V2, offen): Kein dedizierter Test für die Verweigerung der Key-Speicherung ohne KURA_SECRET_KEY (Code eindeutig, Test fehlt). Guard-Verhalten mit echtem DNS/TLS nicht gegen reale Ziele ausgeführt. Admin-Freigabe ist an Host:Port gebunden, nicht an die aufgelöste IP (Frage des Verifiers).
- R-14 (V4, offen): Dateisystem-Backend: gemeinsamer Objektzustand zwischen API-Container und Worker-Container nicht belegt; VM nutzt `KURA_STORAGE_BACKEND=database`. Vor Umstellung auf `filesystem` Test mit gemeinsamem Volume nötig.
- R-15 (offen): Das Hash-Prüfen und das Starten externer Binärdateien sind zwei Schritte (theoretischer Austausch dazwischen). Wirksam erst relevant, wenn die externen Werkzeuge freigeschaltet werden (R-09).
- R-16 (2026-10-09, offen, akzeptiert für Test): yt-dlp/gallery-dl laufen ohne Egress-Sperre (D-026). Ein manipuliertes Ziel kann sie auf Dienste im LAN lenken. Nur eigene/berechtigte Inhalte testen; danach sperren oder Sperre nach `docs/vm-setup.md` einrichten.
- R-17 (offen, Ursache wahrscheinlich gefunden): Möglicher instabiler M5-B-Test unter starker Parallellast (V8, nicht reproduzierbar, Ursache unbekannt). Bei erneutem Auftreten Stacktrace sichern und als Karte nach dem Muster F1 bearbeiten. Befund 2026-10-11: Die Sandbox begrenzt Prozesse auf 256 (pids.max); abgebrochene Läufe hinterlassen verwaiste Prozesse (/tmp/kura-faketool-*, alte pnpm check, API-Prozesse), danach EAGAIN in parallelen Läufen. Nach Aufräumen alle Läufe grün.
