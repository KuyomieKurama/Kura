# Kura — Projektregeln

Kura (Arbeitstitel bis 2026-10-06: Downloader) ist eine selbst gehostete Webanwendung mit dauerhaftem Hintergrunddienst für Medien-Downloads, Zeitpläne und geprüfte Übertragung nach Immich. Stand: lauffähiger Prototyp M0–M5 (PARTIALLY VERIFIED, D-023; siehe `.claude/team/board.md`).

Verbindliche Quellen:

- `docs/requirements/REQ-DL-*.md` — unveränderliche Aufträge des Auftraggebers (neue Fassung = neue ID).
- `docs/planning/` — konsolidierter Projektplan v2.1. Einstieg: `00_Uebersicht.md`, dann 12, 11, 05, 08. Keine Umsetzung ohne Deckung durch eine Anforderung (F01–F26) daraus.
- `.claude/team/decisions.md` — getroffene Entscheidungen (ADR-Kurzform).

Der Plan beschreibt Spezifikationen, keine lauffähige Anwendung. Beispiele und SQL sind Entwurf.

## Stack (Planungsstand)

Node.js/TypeScript, React, Fastify, PostgreSQL; getrennte Worker-Prozesse; kein Kubernetes, kein Redis. Externe Downloader (yt-dlp, gallery-dl) werden separat installiert, nicht mitgeliefert. Immich: jeweils neueste stabile Version, vor Release pinnen. Repositoryvorschlag: `apps/{web,api,worker}`, `packages/{domain,storage,adapters,immich-client,contracts,identity}`, `migrations`, `tests/fixtures`, `deploy`, `docs`.

## Unverhandelbare Zusagen

- Lokale Originale werden nur entfernt, wenn exakt dieses Original im richtigen Immich-Konto verifiziert, die History dauerhaft gespeichert und eine gültige Löschfreigabe vorhanden ist. HTTP-Status allein reicht nie.
- Kein E-Mail-Autolinking bei SSO; stabile lokale Benutzer-ID.
- Produktion nur hinter TLS-Reverse-Proxy. Secrets verschlüsselt, nie in Logs, CI oder Fixtures.
- Externe Plattformtests nur mit eigenen/freigegebenen Inhalten und berechtigten Testkonten.
- Lizenz: MIT für eigenen Code; abweichende Lizenzen (gallery-dl GPL, FFmpeg, Immich AGPL) transparent in `docs/planning/09`.

## Sprache

Kommunikation, Agentenberichte, `board.md`, `decisions.md`, `risks.md`: Deutsch. Bezeichner, Dateinamen, Codekommentare, Commits, PR-Texte, `README.md`, Projektdoku: Englisch. `docs/planning/` bleibt deutsch (Quelle).

## Programmierstil

Verständlich vor kurz. Aussagekräftige englische Namen, klarer Ablauf, keine Abstraktion ohne konkreten Bedarf, keine Parallelversionen. Kommentare nur für nicht offensichtliche Gründe. Keine notwendigen Validierungen oder Sicherheitsprüfungen entfernen.

## Hoheit

Zwei gleichzeitig laufende Agenten fassen nie dieselbe Datei an. Schnittstelle umbauen und Schnittstelle messen laufen in aufeinanderfolgenden Wellen. Gemeinsame Dateien ändert nur der Orchestrator: `CLAUDE.md`, `.claude/team/*.md`, `package.json`, `pnpm-workspace.yaml`, alle `tsconfig*.json`, `.github/**`, Reihenfolge der Migrationen.

`.github/**` wird von Agenten nicht geändert, committet oder gepusht; nötige Änderungen werden dem Auftraggeber zur manuellen Umsetzung genannt. Remote: `origin` = github.com/KuyomieKurama/Kura (öffentlich). Agenten pushen nie; Push, Merge nach `main` und Tags macht ausschließlich der Orchestrator vom Host.

## Ablauf und Berichte

Arbeit läuft in Wellen über das Kanban-Board `downloader`. Agenten sprechen nicht miteinander. Bericht je Aufgabe unter `.claude/team/reports/<ID>-<rolle>.md`:

```
Aufgabe / Status (fertig|blockiert|braucht Review|teilweise) / Artefakte / Zusammenfassung /
Prüfung (ausgeführt, nicht geprüft + Grund) / Annahmen / Risiken / Offene Fragen / Nächster Schritt
```

Bei Blockade nicht raten, melden. Gelesen-nicht-gelaufen gehört in die Annahmen. Eine Aufgabe ist fertig nach Review und Verifier-Urteil (VERIFIED oder PARTIALLY VERIFIED mit Begründung); eine fehlende Prüfung wird als offen dokumentiert.

## Befehle

`pnpm check` (Prüftor: eslint, vitest mit echter PostgreSQL, Build aller Pakete; Stand M1-A). Datenbank für Entwicklung/Tests: Podman-Container `kura-postgres`, siehe `docs/dev-setup.md` und D-010. In der Sandbox erreichbar unter 127.0.0.1:5432; der Orchestrator verwaltet den Container. Kein `sudo`, kein `apt` in der Sandbox.
