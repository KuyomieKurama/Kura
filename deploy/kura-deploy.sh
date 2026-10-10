#!/bin/sh
# Build and (re)start the Kura test stand on this VM. Usage: kura-deploy.sh [git-ref]
# The ref is a branch (e.g. main) or a release tag (e.g. v0.3.0, see docs/vm-setup.md, "Version and update").
#
# Containers (all on the Podman network kura-net, all from the same env file):
#   kura-postgres  PostgreSQL, volume kura-pgdata
#   kura-app       the API and web UI, published as 8080:8080
#   kura-worker    scheduler loop and download executor, no published port
# The script is idempotent: run it again and the two Kura containers are replaced by the new image.
set -eu
REF="${1:-m1-core}"
REPO="$HOME/work/Kura"
ENV_FILE="$HOME/.config/kura/kura.env"

cd "$REPO"
git fetch -q --tags origin
if git rev-parse -q --verify "refs/remotes/origin/$REF^{commit}" >/dev/null; then
  # A branch: follow the remote.
  git checkout -q "$REF"
  git reset -q --hard "origin/$REF"
elif git rev-parse -q --verify "refs/tags/$REF^{commit}" >/dev/null; then
  # A tag (a release such as v0.3.0): there is no origin/<tag>, check out the tag itself.
  git checkout -q --detach "refs/tags/$REF"
else
  echo "unknown git ref: $REF (neither a branch on origin nor a tag)" >&2
  exit 1
fi
COMMIT="$(git rev-parse --short HEAD)"

# The version this build reports is the "version" of the root package.json at this ref (single source of truth;
# no node needed on the host). It is passed to the image as build argument together with the commit.
VERSION="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' package.json | head -n 1)"
if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "warning: no valid version in package.json (found: '$VERSION'); the build will report an unknown version" >&2
  VERSION=""
fi
case "$REF" in
  v[0-9]*)
    if [ -n "$VERSION" ] && [ "$REF" != "v$VERSION" ]; then
      echo "warning: ref $REF, but package.json says $VERSION; the app will report $VERSION" >&2
    fi
    ;;
esac

# Value of a KEY=value line of the env file (last one wins), empty if the key is not set.
# The env file is not sourced here: podman reads it as plain KEY=value lines, not as shell.
env_value() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}

podman network exists kura-net || podman network create kura-net >/dev/null
podman volume exists kura-pgdata || podman volume create kura-pgdata >/dev/null

if ! podman container exists kura-postgres || [ "$(podman inspect -f '{{.HostConfig.NetworkMode}}' kura-postgres)" != "kura-net" ]; then
  podman rm -f kura-postgres >/dev/null 2>&1 || true
  . "$ENV_FILE"
  podman run -d --name kura-postgres --network kura-net --restart=always \
    -v kura-pgdata:/var/lib/postgresql/data \
    -e POSTGRES_USER="$KURA_DB_USER" -e POSTGRES_PASSWORD="$KURA_DB_PASSWORD" -e POSTGRES_DB="$KURA_DB_NAME" \
    --shm-size=128m docker.io/library/postgres:17-trixie >/dev/null
fi

podman build -q -t "localhost/kura:$COMMIT" -t localhost/kura:latest \
  --build-arg "KURA_VERSION=$VERSION" --build-arg "KURA_COMMIT=$COMMIT" -f deploy/Containerfile .

# Storage. With KURA_STORAGE_BACKEND=database (recommended) nothing is mounted: the API and the worker share
# the objects through PostgreSQL. Anything else means the filesystem backend (the API default): then a named
# volume is mounted on KURA_STORAGE_ROOT in both containers (see docs/vm-setup.md, "Storage").
STORAGE_BACKEND="$(env_value KURA_STORAGE_BACKEND)"
STORAGE_ROOT="$(env_value KURA_STORAGE_ROOT)"
STORAGE_ROOT="${STORAGE_ROOT:-/var/lib/kura/blobstore}"
# Host directory with the external tools (yt-dlp, gallery-dl, ...), mounted read-only into the worker only.
TOOLS_HOST_DIR="$(env_value KURA_TOOLS_HOST_DIR)"

# Mount options as plain strings (POSIX sh has no arrays), so paths must not contain spaces.
STORAGE_MOUNT_ARGS=""
if [ "$STORAGE_BACKEND" != "database" ]; then
  case "$STORAGE_ROOT" in
    /*" "*) echo "KURA_STORAGE_ROOT must not contain spaces" >&2; exit 1 ;;
    /*) ;;
    *) echo "KURA_STORAGE_ROOT must be an absolute path inside the container (got: $STORAGE_ROOT)" >&2; exit 1 ;;
  esac
  podman volume exists kura-blobdata || podman volume create kura-blobdata >/dev/null
  STORAGE_MOUNT_ARGS="-v kura-blobdata:$STORAGE_ROOT"
fi

TOOLS_MOUNT_ARGS=""
if [ -n "$TOOLS_HOST_DIR" ]; then
  case "$TOOLS_HOST_DIR" in
    *" "*) echo "KURA_TOOLS_HOST_DIR must not contain spaces" >&2; exit 1 ;;
  esac
  if [ ! -d "$TOOLS_HOST_DIR" ]; then
    echo "KURA_TOOLS_HOST_DIR is set but $TOOLS_HOST_DIR is not a directory" >&2
    exit 1
  fi
  TOOLS_MOUNT_ARGS="-v $TOOLS_HOST_DIR:/opt/kura-tools:ro"
fi

# --- API ---------------------------------------------------------------------------------------------------
podman rm -f kura-app >/dev/null 2>&1 || true
# shellcheck disable=SC2086  # the mount options are deliberately split into words
podman run -d --name kura-app --network kura-net --restart=always \
  --env-file "$ENV_FILE" -p 8080:8080 \
  -e HOST=0.0.0.0 -e PORT=8080 \
  $STORAGE_MOUNT_ARGS \
  "localhost/kura:$COMMIT" >/dev/null

api_healthy=""
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
    api_healthy=yes
    break
  fi
  sleep 2
done
if [ -z "$api_healthy" ]; then
  echo "kura $COMMIT did not become healthy" >&2
  podman logs --tail 40 kura-app >&2 || true
  exit 1
fi

# --- Worker ------------------------------------------------------------------------------------------------
# Started after the API is healthy: the API applies the database migrations on its start, the worker needs them.
# --no-healthcheck: the image HEALTHCHECK asks port 8080, which the worker does not serve.
podman rm -f kura-worker >/dev/null 2>&1 || true
# shellcheck disable=SC2086
podman run -d --name kura-worker --network kura-net --restart=always --no-healthcheck \
  --env-file "$ENV_FILE" \
  $STORAGE_MOUNT_ARGS $TOOLS_MOUNT_ARGS \
  "localhost/kura:$COMMIT" node apps/worker/dist/index.js >/dev/null

# Liveness without a port: the container must be running and must have logged "worker started" (the start
# connects to PostgreSQL and starts the scheduler and download loops), and still be running a few seconds later.
worker_state() {
  podman inspect -f '{{.State.Status}}' kura-worker 2>/dev/null || echo missing
}
worker_started=""
for i in $(seq 1 30); do
  if [ "$(worker_state)" = "running" ] && podman logs kura-worker 2>&1 | grep -q '"message":"worker started"'; then
    worker_started=yes
    break
  fi
  sleep 2
done
if [ -n "$worker_started" ]; then
  sleep 3
  [ "$(worker_state)" = "running" ] || worker_started=""
fi
if [ -z "$worker_started" ]; then
  echo "kura-worker $COMMIT did not start (state: $(worker_state))" >&2
  podman logs --tail 40 kura-worker >&2 || true
  exit 1
fi

echo "kura $COMMIT (version ${VERSION:-unknown}) is up: http://$(hostname -i 2>/dev/null | awk '{print $1}'):8080 (api and worker running)"
