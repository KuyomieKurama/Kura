# Board — Kura

Stand 2026-10-06: Projekt angelegt. Nächste Stufe: M0 Machbarkeit (siehe `docs/planning/08_Umsetzungsplan_und_Abnahme.md`). Aufgaben leben im Kanban-Board `downloader`.

## Stand 2026-10-06 (Abend)
- `main` = Teststand M1 (Gerüst, lokale Anmeldung, Weboberfläche); läuft auf der Test-VM. Review/Verifier für M1-C2/C3 stehen aus.
- Laufende Lanes (Arbeitsstände als Branches auf GitHub, noch nicht zusammengeführt): `lane/identity` (OIDC), `lane/blobstore` (Speicherkern), `lane/immich` (Immich-Client); Basis `base/lanes`.

## Stand 2026-10-07 (Abend)
- Lanes identity/blobstore/immich sind auf `integration/m3` zusammengeführt und grün (VM). Noch nicht in API/UI verdrahtet, noch kein Verifier-Urteil.
- Laufend: W1 (t_1a40f3d9) OIDC-Verdrahtung, danach W2 (t_8dabad1e) Speicher + Immich ohne Löschung, Worktree `wiring/m3`.
- Offen: Verifier M1b–M3, Deploy auf die VM, M4 (Zeitpläne), M5 (Adapter), Immich-Test mit echter Instanz (R-05).

## Stand 2026-10-08 (früh)
- `main` = Tag `m3` + D1 (Paket-Exports auf dist). Läuft auf der Test-VM (Commit e2c2de8), Port 8080, mit OIDC (nur bei Konfiguration), Speicherkern (Datenbank-Backend), Immich-Verbindung mit Admin-Freigabe privater Ziele, Test-Upload mit Originalnachweis. Urteil PARTIALLY VERIFIED (D-021). Keine Löschung lokaler Originale.
- Offen: M4 (Zeitpläne), M5 (Adapter), Test gegen echtes Immich (R-05/R-12), echte IdP-Verträge (R-08), R-13.
