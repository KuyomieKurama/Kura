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
- `kura-app`: the Kura image (`deploy/Containerfile`), API and web UI, published as `8080:8080`.
- `kura-worker`: the same image, started with `node apps/worker/dist/index.js`, no published port. It runs the
  scheduler loop (creates the due runs) and the download executor. Without it no schedule fires and no download runs.
- `~/.config/kura/kura.env` (mode 600): database credentials, `DATABASE_URL`, `COOKIE_SECURE=false`.
  This file is **not** in the repository and must never be committed. `.env.example` lists the variable names.
- `~/work/Kura`: a clone of this repository, used for image builds.

## Deploying

```
~/bin/kura-deploy.sh m1-core
```

The script (`deploy/kura-deploy.sh` in this repository) fetches the ref, builds the image, recreates
`kura-app`, waits for `/healthz`, then recreates `kura-worker` and waits until it is running and has logged
`worker started`. Migrations run when the API process starts (guarded by a PostgreSQL advisory lock), which is why
the worker is started after the API is healthy. The script can be run again at any time; it replaces both
containers and does not touch `kura-postgres`.

Check the worker by hand:

```
podman ps --filter name=kura-          # kura-app, kura-worker and kura-postgres are Up
podman logs --tail 20 kura-worker      # JSON lines; "worker started" and no "level":"error" lines
```

## Environment file (`~/.config/kura/kura.env`)

Both Kura containers read the same file, so every setting exists once. `.env.example` lists all names. What the
worker needs on top of what the API needs:

| Variable | Needed by | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | API, worker | PostgreSQL URL (host `kura-postgres` on `kura-net`). |
| `KURA_STORAGE_BACKEND` | API (script) | Set `database`. See "Storage" below. |
| `KURA_SECRET_KEY` | API, worker | Same base64 32-byte key in both (`openssl rand -base64 32`). Without it the worker cannot read the stored Immich API keys and every file ends as "Übergabe fehlgeschlagen". |
| `KURA_STORAGE_QUOTA_BYTES` | API, worker | Same per-user quota. |
| `WORKER_*`, `KURA_WORK_DIR` | worker | Optional tuning; defaults are in `.env.example`. In the container `KURA_WORK_DIR` is `/var/lib/kura/staging` (not persistent; the biggest file must fit there twice). |
| `KURA_YTDLP_PATH`, `KURA_YTDLP_SHA256`, `KURA_GALLERYDL_PATH`, `KURA_GALLERYDL_SHA256`, `KURA_TOOL_PATH` | worker | External tools; see "External tools" below. Path and hash only together. |
| `KURA_TOOLS_HOST_DIR` | script | Host directory mounted read-only at `/opt/kura-tools` in `kura-worker`. |

## Storage

The worker always stores downloaded files in PostgreSQL (`DatabaseBlobStore`). Set `KURA_STORAGE_BACKEND=database`
in the env file so that the API uses the same store; then nothing has to be mounted and both containers see the
same objects.

If `KURA_STORAGE_BACKEND` is unset or `filesystem` (the API default), the script creates the named volume
`kura-blobdata` and mounts it on `KURA_STORAGE_ROOT` (default `/var/lib/kura/blobstore`, must be absolute) in
both containers. That keeps the API's own files across restarts, but it does **not** make the worker's files
visible to the API: the filesystem backend keeps its object index in the memory of its process, and the worker
does not use it. Use `database`.

## External tools (yt-dlp, gallery-dl)

They are not part of the image. The operator installs them on the host, for example below
`/home/kura/kura-tools`, and sets `KURA_TOOLS_HOST_DIR` to that directory; the worker sees it as `/opt/kura-tools`.
`KURA_YTDLP_PATH=/opt/kura-tools/yt-dlp` plus `KURA_YTDLP_SHA256=<sha256sum of the file>` (same for gallery-dl)
make Kura check and use them. The direct URL adapter needs no tool. The binaries must run inside the Debian
image (self-contained builds; Python-based installs need Python in the image, which it does not have).

## First start

Open `http://<vm-ip>:8080/`. While no user exists, the UI offers the one-time administrator setup.
The first person to submit it becomes the administrator. If `KURA_SETUP_TOKEN` is set in the
environment file, the token is required.

## Limits of this setup

- No TLS: passwords cross the network unencrypted. Use only on a trusted LAN with test data.
- No egress filtering for external downloaders (risk R-09). Required before platform adapters are used.
- Authentik, Keycloak and Immich are operated by the project owner and are not part of this VM.
