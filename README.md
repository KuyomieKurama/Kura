# Kura

Self-hosted web application with a permanent background service for downloading media from supported platforms, scheduling, and verified transfer to Immich.

Status: planning only, no implementation yet. The consolidated plan (version 2.1, 2026-10-06) lives in [docs/planning](docs/planning/00_Uebersicht.md).

Key decisions: Node.js/TypeScript, React, Fastify, PostgreSQL; OIDC SSO (Authentik reference, Keycloak contract test); local originals are only removed after a verified Immich transfer.

License: MIT for own code. Third-party components keep their own licenses, see [docs/planning/09_Lizenzen_und_Quellen.md](docs/planning/09_Lizenzen_und_Quellen.md).
