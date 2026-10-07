#!/bin/sh
# Build and (re)start the Kura test stand on this VM. Usage: kura-deploy.sh [git-ref]
set -eu
REF="${1:-m1-core}"
REPO="$HOME/work/Kura"
ENV_FILE="$HOME/.config/kura/kura.env"

cd "$REPO"
git fetch -q origin
git checkout -q "$REF"
git reset -q --hard "origin/$REF"
COMMIT="$(git rev-parse --short HEAD)"

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

podman build -q -t "localhost/kura:$COMMIT" -t localhost/kura:latest -f deploy/Containerfile .

podman rm -f kura-app >/dev/null 2>&1 || true
podman run -d --name kura-app --network kura-net --restart=always \
  --env-file "$ENV_FILE" -p 8080:8080 \
  -e HOST=0.0.0.0 -e PORT=8080 \
  "localhost/kura:$COMMIT" >/dev/null

for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
    echo "kura $COMMIT is up: http://$(hostname -i 2>/dev/null | awk '{print $1}'):8080"
    exit 0
  fi
  sleep 2
done
echo "kura $COMMIT did not become healthy" >&2
podman logs --tail 40 kura-app >&2 || true
exit 1
