# Deployment

## What is stored and where

| Data | Variable | In the container | Contents |
|---|---|---|---|
| Flows | `FL0W_DATA_DIR` | `/data/flows` | JSON of every flow: drafts and published |
| Memory | `FL0W_MEMORY_DIR` | `/data/memory` | Memory Bank banks and Counter counters (`_sandbox` — trial runs from the editor) |
| Files | `FL0W_FILES_DIR` | `/data/files` | everything the Files / Local File Trigger / Shell blocks read and write |

The image declares `VOLUME /data`. Compose mounts `/data` (flows and memory) and `/data/files` (files) separately, so that
the files directory can be pointed at any folder on the host.

## Locally without Docker

Requires Node 26+ and pnpm 11 (`npm install -g pnpm@11`).

```bash
pnpm install
pnpm build
FL0W_FILES_DIR=/srv/fl0w/files FL0W_ALLOW_SHELL=0 pnpm start     # port 3000; another port: pnpm --filter @fl0w/web start -p 8080
```

The service brings up the schedule of published flows at startup. For continuous operation, run it under systemd / pm2.

## Docker Compose

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f
```

### Where to put the data

By default, named Docker volumes are used. To store data on the host, set the paths in `.env`:

```
FL0W_DATA=/srv/fl0w/data      # flows + memory
FL0W_FILES=/srv/fl0w/files    # files available to blocks
```

The directories must exist and be owned by uid 1000 (the `node` user in the container):
`sudo mkdir -p /srv/fl0w/{data,files} && sudo chown -R 1000:1000 /srv/fl0w`.

Volume backup: `docker run --rm -v fl0w-data:/d -v "$PWD":/b busybox tar czf /b/fl0w-data.tgz -C /d .`

### Settings and features

Everything goes through `.env` (compose passes it into the container): `FL0W_ALLOW_SHELL=1` enables Shell, `FL0W_PUBLIC_URL` — Telegram
webhooks, `FL0W_SECRET_*` — secrets. After editing: `docker compose up -d`.

Shell in the container runs commands **inside the container** as the `node` user (access to the host only through
what you have mounted). Still, enable it only where you are the only one with access.

### Network

By default the port is published on `127.0.0.1` only. For external access, put a reverse proxy with
authentication (or a VPN) in front of the service, and only then change `FL0W_BIND`. Webhooks (`/api/hooks/...`, `/api/telegram/...`) must be
reachable from outside — if you do not need to expose the editor, proxy only these.

## Building and publishing the image

```bash
scripts/docker.sh build                                  # fl0w:<version> and fl0w:latest
docker login ghcr.io
IMAGE=ghcr.io/<you>/fl0w scripts/docker.sh push          # asks for confirmation (-y — without asking)
IMAGE=ghcr.io/<you>/fl0w PLATFORMS=linux/amd64,linux/arm64 scripts/docker.sh push   # multi-architecture build (buildx)
```

The version is taken from `apps/web/package.json` (or `VERSION=…`). The script sends nothing without the `push` command.

## Updating

```bash
git pull && docker compose up -d --build     # data in volumes is not affected
```
or `FL0W_IMAGE=<new image> docker compose pull && docker compose up -d`.
