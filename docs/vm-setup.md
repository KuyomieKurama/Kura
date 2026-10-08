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
| `KURA_EXTERNAL_TOOLS_EGRESS_CONFIRMED` | worker | `true` only after the egress barrier below exists. Unset or `false`: yt-dlp and gallery-dl are never started. |
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

They are blocked until the egress barrier below is confirmed. They are not part of the image. The operator installs them on the host, for example below
`/home/kura/kura-tools`, and sets `KURA_TOOLS_HOST_DIR` to that directory; the worker sees it as `/opt/kura-tools`.
`KURA_YTDLP_PATH=/opt/kura-tools/yt-dlp` plus `KURA_YTDLP_SHA256=<sha256sum of the file>` (same for gallery-dl)
make Kura check and use them. The direct URL adapter needs no tool. The binaries must run inside the Debian
image (self-contained builds; Python-based installs need Python in the image, which it does not have).

## First start

Open `http://<vm-ip>:8080/`. While no user exists, the UI offers the one-time administrator setup.
The first person to submit it becomes the administrator. If `KURA_SETUP_TOKEN` is set in the
environment file, the token is required.

## Egress barrier for the external tools (risk R-09)

yt-dlp and gallery-dl open their own network connections (redirects, CDNs, playlists, embedded resources) and have
no allowlist of their own (D-008). The address check of Kura only covers what Kura downloads itself, so it does
not protect against a tool being pointed at an internal address. Kura therefore fails closed:

- With `KURA_EXTERNAL_TOOLS_EGRESS_CONFIRMED` unset or `false` the worker does not check, does not start and does
  not register the two tools, even if their path and hash are configured. The adapter overview and the source check
  show "Externe Werkzeuge gesperrt: Egress-Schutz nicht bestätigt"; a job for YouTube, Pixiv, Instagram or Patreon
  fails with the code `EGRESS_NOT_CONFIRMED` (history state `failed`) without any process being started. The worker
  logs this once at start. Direct media URLs keep working.
- Kura cannot see or verify the rules. Setting the variable to `true` is the operator's statement that they exist.

What the operator has to provide before setting it (Kura does not write firewall rules):

1. A network restriction that applies to the `kura-worker` container only (its own VLAN or network, or nftables
   rules on the host for that container's traffic). The API container needs none of this.
2. Allow: outgoing HTTPS (and HTTP where a tool needs it) to public addresses, and DNS to a resolver the operator
   trusts.
3. Deny everything else that is not public: loopback, the host itself, the other containers on `kura-net`
   (`kura-app`), all private and link-local ranges of IPv4 and IPv6, unique-local IPv6, cloud metadata addresses
   such as 169.254.169.254, and every internal service of the LAN (Authentik, Keycloak and others). Make exactly two
   exceptions, because the worker itself needs them: `kura-postgres` (port 5432) and the Immich servers of the users
   (the host and port an administrator approved).
   Residual risk the operator should know: the tools run as child processes inside the worker container, so
   container-level rules cannot keep them away from those two exceptions. A stricter split (tools in their own
   container or network namespace) is not part of this setup and is listed as an open question in report D2.
4. A test from inside the container that an internal address is unreachable, for example
   `podman exec kura-worker node -e "fetch('http://<internal-ip>:80').then(()=>console.log('REACHABLE')).catch(()=>console.log('blocked'))"`.
   Only then add `KURA_EXTERNAL_TOOLS_EGRESS_CONFIRMED=true` to `~/.config/kura/kura.env` and run
   `kura-deploy.sh` again. A plain `podman restart` is not enough: Podman reads the env file when the container
   is created, so the container has to be recreated.

## Limits of this setup

- No TLS: passwords cross the network unencrypted. Use only on a trusted LAN with test data.
- No egress filtering for external downloaders is provided by Kura (risk R-09). The platform adapters (yt-dlp,
  gallery-dl) stay blocked until the operator provides it and confirms it; see "Egress barrier".
- Authentik, Keycloak and Immich are operated by the project owner and are not part of this VM.
