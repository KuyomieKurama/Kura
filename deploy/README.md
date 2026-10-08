# Kura container

Build and run rootless with Podman:

    podman network create kura-net
    podman build -f deploy/Containerfile -t kura:local .
    podman run --rm --name kura --network kura-net -p 8080:8080 -e DATABASE_URL='postgres://USER:PASSWORD@HOST:5432/kura' kura:local

The API listens on port 8080 and runs database migrations on startup. Supply a database URL appropriate for the `kura-net` network.

## Worker

The image also contains the worker (scheduler loop and download executor). Start it from the same image with the
same environment, without a published port:

    podman run -d --name kura-worker --network kura-net --restart=always --no-healthcheck \
      --env-file ~/.config/kura/kura.env kura:local node apps/worker/dist/index.js

It reports `worker started` as a JSON log line. `kura-deploy.sh` does all of this, including the check, on the VM:
`kura-app` first (it applies the migrations), then `kura-worker`. The worker needs `DATABASE_URL` and, for the
Immich handover, the same `KURA_SECRET_KEY` as the API. See `docs/vm-setup.md` for every setting, the storage
rules (`KURA_STORAGE_BACKEND=database`) and the external tools.

### External tools and the egress barrier

yt-dlp and gallery-dl are not in the image and stay blocked (`EGRESS_NOT_CONFIRMED`) until the operator sets
`KURA_EXTERNAL_TOOLS_EGRESS_CONFIRMED=true` in the env file. They have no network allowlist of their own (D-008,
risk R-09), so before setting it the operator must provide the restriction for the `kura-worker` container: its own
VLAN or network, or nftables rules, that deny loopback, the host, `kura-net`, private/link-local/unique-local ranges
and metadata addresses and allow only public HTTPS and DNS. Kura does not create or verify these rules, and neither
does `kura-deploy.sh`. Details and a check from inside the container: `docs/vm-setup.md`, "Egress barrier".
