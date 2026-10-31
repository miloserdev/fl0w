#!/usr/bin/env bash
# Сборка и публикация образа Node Flow Board.
#   scripts/docker.sh build            — собрать локально (теги <IMAGE>:<версия> и :latest)
#   scripts/docker.sh push             — собрать и ОТПРАВИТЬ в реестр (спросит подтверждение; -y — без вопроса)
#   scripts/docker.sh run              — запустить собранный образ (данные в томах fl0w-data/fl0w-files)
# Переменные: IMAGE (по умолчанию fl0w; для push — полное имя, напр. ghcr.io/you/fl0w), VERSION (по умолчанию из apps/web/package.json),
#             PLATFORMS (напр. linux/amd64,linux/arm64 — тогда сборка через buildx сразу с отправкой).
# Перед push выполните `docker login <реестр>`. Скрипт сам ничего никуда не отправляет без явной команды push.
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
      echo "Для push задайте IMAGE с реестром, например: IMAGE=ghcr.io/you/fl0w scripts/docker.sh push" >&2; exit 1
    fi
    if [[ "$yes" != "-y" ]]; then
      read -r -p "Отправить $IMAGE:$VERSION и $IMAGE:latest в реестр? [y/N] " a
      [[ "$a" == "y" || "$a" == "Y" ]] || { echo "Отменено"; exit 1; }
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
