# Board — Kura

Stand 2026-10-06: Projekt angelegt. Nächste Stufe: M0 Machbarkeit (siehe `docs/planning/08_Umsetzungsplan_und_Abnahme.md`). Aufgaben leben im Kanban-Board `downloader`.

## Stand 2026-10-06 (Abend)
- `main` = Teststand M1 (Gerüst, lokale Anmeldung, Weboberfläche); läuft auf der Test-VM. Review/Verifier für M1-C2/C3 stehen aus.
- Laufende Lanes (Arbeitsstände als Branches auf GitHub, noch nicht zusammengeführt): `lane/identity` (OIDC), `lane/blobstore` (Speicherkern), `lane/immich` (Immich-Client); Basis `base/lanes`.

## Stand 2026-10-07 (Abend)
- Lanes identity/blobstore/immich sind auf `integration/m3` zusammengeführt und grün (VM). Noch nicht in API/UI verdrahtet, noch kein Verifier-Urteil.
- Laufend: W1 (t_1a40f3d9) OIDC-Verdrahtung, danach W2 (t_8dabad1e) Speicher + Immich ohne Löschung, Worktree `wiring/m3`.
- Offen: Verifier M1b–M3, Deploy auf die VM, M4 (Zeitpläne), M5 (Adapter), Immich-Test mit echter Instanz (R-05).
