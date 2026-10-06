# Test VM setup (Arch Linux, rootless Podman)

This documents how the Kura test stand is run. It is a test setup, not a production deployment:
plain HTTP, no reverse proxy, no TLS (see risk R-11). Do not expose it to untrusted networks.

## Host requirements

- Linux with systemd, rootless Podman (netavark, aardvark-dns, crun, passt), cgroup v2.
- A normal user with `loginctl enable-linger` and `podman-restart.service` enabled for that user,
  so containers with `--restart=always` come back after a reboot.
- NTP synchronisation (the DST and schedule tests depend on a correct clock).
- Node.js and pnpm are **not** installed on the host; they run inside the container image.

## Layout

- `kura-postgres`: PostgreSQL 17 container with the named volume `kura-pgdata`, on the Podman network `kura-net`.
- `kura-app`: the Kura image (`deploy/Containerfile`), published as `8080:8080`.
- `~/.config/kura/kura.env` (mode 600): database credentials, `DATABASE_URL`, `COOKIE_SECURE=false`.
  This file is **not** in the repository and must never be committed. `.env.example` lists the variable names.
- `~/work/Kura`: a clone of this repository, used for image builds.

## Deploying

```
~/bin/kura-deploy.sh m1-core
```

The script (`deploy/kura-deploy.sh` in this repository) fetches the ref, builds the image, recreates
`kura-app`, and waits for `/healthz`. Migrations run when the API process starts (guarded by a
PostgreSQL advisory lock).

## First start

Open `http://<vm-ip>:8080/`. While no user exists, the UI offers the one-time administrator setup.
The first person to submit it becomes the administrator. If `KURA_SETUP_TOKEN` is set in the
environment file, the token is required.

## Limits of this setup

- No TLS: passwords cross the network unencrypted. Use only on a trusted LAN with test data.
- No egress filtering for external downloaders (risk R-09). Required before platform adapters are used.
- Authentik, Keycloak and Immich are operated by the project owner and are not part of this VM.
