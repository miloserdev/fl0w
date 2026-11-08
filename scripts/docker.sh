#!/usr/bin/env bash
# Build and publish the FL0W image.
#   scripts/docker.sh build            — build locally (tags <IMAGE>:<version> and :latest)
#   scripts/docker.sh push             — build and PUSH to the registry (asks for confirmation; -y skips the question)
#   scripts/docker.sh run              — run the built image (data in the fl0w-data/fl0w-files volumes)
# Variables: IMAGE (default fl0w; for push use the full name, e.g. ghcr.io/you/fl0w), VERSION (default from apps/web/package.json),
#            PLATFORMS (e.g. linux/amd64,linux/arm64 — then the build goes through buildx with an immediate push).
# Run `docker login <registry>` before push. The script never pushes anything anywhere without an explicit push command.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-fl0w}"
VERSION="${VERSION:-$(node -p "require('./apps/web/package.json').version")}"
cmd="${1:-}"; yes="${2:-}"

case "$cmd" in
  build)
    docker build -t "$IMAGE:$VERSION" -t "$IMAGE:latest" .
    ;;
  push)
    if [[ "$IMAGE" != */* ]]; then
      echo "For push, set IMAGE with a registry, for example: IMAGE=ghcr.io/you/fl0w scripts/docker.sh push" >&2; exit 1
    fi
    if [[ "$yes" != "-y" ]]; then
      read -r -p "Push $IMAGE:$VERSION and $IMAGE:latest to the registry? [y/N] " a
      [[ "$a" == "y" || "$a" == "Y" ]] || { echo "Cancelled"; exit 1; }
    fi
    if [[ -n "${PLATFORMS:-}" ]]; then
      docker buildx build --platform "$PLATFORMS" -t "$IMAGE:$VERSION" -t "$IMAGE:latest" --push .
    else
      docker build -t "$IMAGE:$VERSION" -t "$IMAGE:latest" .
      docker push "$IMAGE:$VERSION"
      docker push "$IMAGE:latest"
    fi
    ;;
  run)
    docker run --rm --init -p 127.0.0.1:3000:3000 -v fl0w-data:/data -v fl0w-files:/data/files "$IMAGE:latest"
    ;;
  *)
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 1
    ;;
esac
