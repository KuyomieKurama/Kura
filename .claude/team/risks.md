# Risiken

- R-01: Plattform-Extractor (Instagram, Pornhub, Pixiv, Patreon) sind wartungsbedürftig und keine Funktionsgarantie.
- R-02: Immich-API-Verhalten (Originalprüfung, Dubletten) noch nicht live getestet; Löschfreigabe hängt davon ab.
- R-03: Lizenzmix (gallery-dl GPL, FFmpeg LGPL/GPL, Immich AGPL) verhindert "reines MIT"-Gesamtpaket.
- R-04: Aufwand 125–205 PT; nach M0 und M3 neu schätzen.
- R-05: Immich-API-Fähigkeiten für den Originalnachweis nicht vollständig belegt (D-005). Blockiert M3-Abnahme, falls der Readback-Weg scheitert.
- R-06: Plan nennt Immich v3.2.4, Scouts finden v3.2.1 (D-004). Planangabe nicht belastbar.
- R-07: Sandbox-Platte /work bei 87 %. Kura braucht PostgreSQL und node_modules; ohne Aufräumen von SuperTakt-pr21 (3,2 GB) wird es eng.
- R-08: Echte IdP-Verträge (Authentik, Keycloak) sind bis zum Test durch den Auftraggeber unbelegt; Fake-Anbieter können Abweichungen der echten Produkte nicht aufdecken (D-011).
