# Kura container

Build and run rootless with Podman:

    podman network create kura-net
    podman build -f deploy/Containerfile -t kura:local .
    podman run --rm --name kura --network kura-net -p 8080:8080 -e DATABASE_URL='postgres://USER:PASSWORD@HOST:5432/kura' kura:local

The API listens on port 8080 and runs database migrations on startup. Supply a database URL appropriate for the `kura-net` network.
