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
| `KURA_SECRET_KEY` | API, worker | Same base64 32-byte key in both (`openssl rand -base64 32`). Without it the worker cannot read the stored Immich API keys and every file ends as "Übergabe fehlgeschlagen". The same key encrypts the Instagram cookies (see "Instagram access"); without it no cookies can be uploaded. |
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

## Instagram access

Instagram profiles (and posts or reels that ask for a login) can only be fetched with the session of a logged-in
account. Each Kura user stores the cookies of their own account; nothing is shared between users.

- Prerequisites: `KURA_SECRET_KEY` is set in both containers (see the table above), gallery-dl is installed and the
  egress barrier is confirmed (see below). Without the key the upload is refused with "SECRET_KEY_REQUIRED".
- Storage: the cookies are kept in PostgreSQL (table `platform_credentials`) only as AES-256-GCM ciphertext, bound
  to the user. API responses, logs and audit entries never contain them. Deleting them on the account page deletes
  the row. Changing `KURA_SECRET_KEY` makes stored cookies unreadable; Instagram runs then stop with "bitte Cookies
  neu hochladen" and the cookies have to be uploaded again (there is no key rotation yet).
- Use during a run: the worker decrypts the cookies in memory, writes them to a file with mode 0600 in a private
  directory (mode 0700) below `KURA_WORK_DIR`, hands the path to gallery-dl with `-C` and deletes the file and the
  directory when the run ends, also after errors and aborts. If the worker is killed in the middle of a run, the
  leftover directory is removed by the existing cleanup of abandoned run directories (older than 24 hours); the
  container directory `KURA_WORK_DIR` is not persistent and not shared.
- Account risk: Instagram can restrict accounts that fetch a lot or quickly. Use a dedicated account. Kura spaces its
  requests and fetches at most `KURA_INSTAGRAM_MAX_POSTS_PER_RUN` posts per run.
- Test steps for the operator are in the report `.claude/team/reports/IG-B-implementer.md`, section "Betrieb auf der VM".

## Patreon, Pixiv and YouTube access

The account page has one row per platform. All logins are stored like the Instagram cookies above (same table, same
encryption, additional authenticated data per user and platform, same 0600 file in a private directory that is
deleted at the end of the run). What differs:

| Platform | Login | How the tool gets it | Without a login |
| --- | --- | --- | --- |
| Patreon | cookies.txt, needs the cookie `session_id` of patreon.com | `gallery-dl -C <file>` | public posts may work, feeds are paused at the first run |
| Pixiv | OAuth refresh token (created once with `gallery-dl oauth:pixiv` on the user's own computer) | `gallery-dl -c <gallery-dl.conf>`; the token is only inside that file (`extractor.pixiv.refresh-token`), never in an argument. The file also sets `cache.file` into the private directory | every run is paused (the Pixiv API wants a token) |
| YouTube | optional cookies.txt, needs `LOGIN_INFO` and an `*APISID` cookie | `yt-dlp --cookies <file>` | public videos work |

- Migration `0053` adds the platforms and a `kind` column (cookies or token). Nothing else is needed on the VM.
- Pacing (Kura's own choice, not tool defaults): Patreon waits 3-6 s between requests and before each process, 2-5 s
  before each file; Pixiv 2-4 s and 1-3 s. At most `KURA_PATREON_MAX_POSTS_PER_RUN` / `KURA_PIXIV_MAX_POSTS_PER_RUN`
  posts (default 50 each, 1-500) are read per run.
- Not fetched, shown as "nicht abrufbar" with the reason: videos embedded from other sites, Patreon HLS streams
  (gallery-dl would load its own yt-dlp module, which Kura cannot check), file types outside the allowlist and posts
  the account may not view. Ugoira are kept as the original zip next to a small JSON file with the frame timing; no
  conversion happens.
- Account risk: all three platforms can restrict accounts that fetch a lot or quickly. Use your own account.
- Test steps are in `.claude/team/reports/P1-implementer.md`.

## YouTube and Pornhub (yt-dlp)

Besides single videos, yt-dlp now serves YouTube playlists and channels and Pornhub video lists. Photo albums of
Pornhub go through gallery-dl (`/album/<number>`).

Tools on the VM (D-026), all found through `KURA_TOOL_PATH`, which becomes the `PATH` of the tool processes:

| Tool | Version | Why |
| --- | --- | --- |
| yt-dlp | 2026.08.19 (floor 2026.07.04, D-007) | the extractor; must be a self-contained build that includes `yt-dlp-ejs` (the official standalone binary does). Kura never passes `--remote-components`, so yt-dlp does not fetch code from the network |
| deno | 2.9.7 | the JavaScript runtime that YouTube needs. yt-dlp enables `deno` by default (`--js-runtimes` default in `options.py`) and looks it up on `PATH`; Kura passes no runtime option |
| ffmpeg (with ffprobe) | n9.0 | merges the best video stream and the best audio stream; found on `PATH` (Kura passes no `--ffmpeg-location`). Without it a download fails with "tool not installed" |

Example: `KURA_TOOLS_HOST_DIR=/home/kura/kura-tools`, `KURA_TOOL_PATH=/opt/kura-tools/bin`, with `yt-dlp`, `deno`,
`ffmpeg` and `ffprobe` in that `bin` directory. Only `yt-dlp` and `gallery-dl` are checked against a hash; deno and ffmpeg
are plain executables on `PATH`, so the directory must be read-only for the worker (it is mounted read-only).
Optionally `curl_cffi` makes yt-dlp impersonate a browser for Pornhub (Cloudflare); a standalone build may include it.
Pornhub works without it as long as the site does not ask for it.

- Address types, one canonical form each (table in the report P2): YouTube video, playlist and channel tab (videos,
  shorts, streams); Pornhub video, video list of a model, pornstar, channel or user, playlist, photo album. A YouTube
  address with a video and a list is the single video.
- Reading a list: `--flat-playlist --dump-single-json --playlist-items 1:N`. `N` is `KURA_YOUTUBE_MAX_POSTS_PER_RUN` or
  `KURA_PORNHUB_MAX_POSTS_PER_RUN` (default 50, 1-500). Channels are listed newest first by YouTube, so this also caps
  the first run of a subscription. Playlists and Pornhub lists are read in the order the site gives; videos beyond
  position `N` are not fetched later, so raise `N` for long playlists. Videos that are already stored are skipped by
  their id without a request.
- Download: best video stream plus best audio stream, merged by ffmpeg without re-encoding into `mp4`, `webm` or
  `mkv` (whichever can hold the chosen codecs, in this order). A fragmented download that misses a fragment fails
  instead of being stored incomplete.
- Pacing (Kura's own choice): 1 s between two requests of an extraction, 3-8 s before each download, no automatic
  retry of extractor errors (`--extractor-retries 0`): after a 429 or a bot check a second request makes it worse.
- Livestreams that are running, premieres and announced videos are not recorded; the entry shows
  "Noch nicht verfügbar" and is looked at again on the next run. Private, removed and region-blocked videos are marked
  as such for that entry and do not stop the run.
- Bot check ("Sign in to confirm you're not a bot"), age-restricted and members-only videos stop the run with
  "Anmeldung erforderlich" and the hint to upload YouTube cookies (account page, Zugänge). With cookies stored, a video
  that the account still may not watch is marked for that entry only. YouTube cookies are optional; Pornhub has no
  login in Kura.
- Account risk: YouTube can restrict accounts and addresses that fetch a lot or quickly. Use your own account.
- Not checked on a real VM: the real merge with ffmpeg, YouTube with deno and `yt-dlp-ejs`, Pornhub behind Cloudflare,
  the real wording of YouTube's error texts. Test steps are in `.claude/team/reports/P2-implementer.md`, section
  "Betrieb auf der VM".

## Limits of this setup

- No TLS: passwords cross the network unencrypted. Use only on a trusted LAN with test data.
- No egress filtering for external downloaders is provided by Kura (risk R-09). The platform adapters (yt-dlp,
  gallery-dl) stay blocked until the operator provides it and confirms it; see "Egress barrier".
- Authentik, Keycloak and Immich are operated by the project owner and are not part of this VM.
