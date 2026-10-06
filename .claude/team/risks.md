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
