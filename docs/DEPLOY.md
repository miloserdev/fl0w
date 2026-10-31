# Развёртывание

## Что хранится и где

| Данные | Переменная | В контейнере | Содержимое |
|---|---|---|---|
| Флоу | `FL0W_DATA_DIR` | `/data/flows` | JSON каждого флоу: черновики и опубликованные |
| Память | `FL0W_MEMORY_DIR` | `/data/memory` | банки Memory Bank и счётчики Counter (`_sandbox` — пробные запуски из редактора) |
| Файлы | `FL0W_FILES_DIR` | `/data/files` | всё, что читают и пишут блоки Files / Local File Trigger / Shell |

Образ объявляет `VOLUME /data`. Compose монтирует `/data` (флоу и память) и `/data/files` (файлы) отдельно, чтобы
файловый каталог можно было направить в любую папку хоста.

## Локально без Docker

Нужны Node 26+ и pnpm 11 (`corepack enable`).

```bash
pnpm install
pnpm build
FL0W_FILES_DIR=/srv/fl0w/files FL0W_ALLOW_SHELL=0 pnpm start     # порт 3000; другой: pnpm --filter @fl0w/web start -p 8080
```

Сервис поднимает расписание опубликованных флоу при старте. Для постоянной работы запустите под systemd / pm2.

## Docker Compose

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f
```

### Куда класть данные

По умолчанию — именованные тома Docker. Чтобы хранить на хосте, укажите пути в `.env`:

```
FL0W_DATA=/srv/fl0w/data      # флоу + память
FL0W_FILES=/srv/fl0w/files    # файлы, доступные блокам
```

Каталоги должны существовать, а владельцем быть uid 1000 (пользователь `node` в контейнере):
`sudo mkdir -p /srv/fl0w/{data,files} && sudo chown -R 1000:1000 /srv/fl0w`.

Резервная копия тома: `docker run --rm -v fl0w-data:/d -v "$PWD":/b busybox tar czf /b/fl0w-data.tgz -C /d .`

### Параметры и функции

Всё через `.env` (compose передаёт его в контейнер): `FL0W_ALLOW_SHELL=1` включает Shell, `FL0W_PUBLIC_URL` — вебхуки
Telegram, `FL0W_SECRET_*` — секреты. После правки: `docker compose up -d`.

Shell в контейнере исполняет команды **внутри контейнера** под пользователем `node` (доступ к хосту — только через то,
что вы смонтировали). Всё равно включайте его лишь там, куда имеете доступ только вы.

### Сеть

По умолчанию порт публикуется только на `127.0.0.1`. Для доступа извне поставьте перед сервисом обратный прокси с
авторизацией (или VPN) и только тогда меняйте `FL0W_BIND`. Вебхуки (`/api/hooks/...`, `/api/telegram/...`) должны быть
доступны снаружи — проксируйте только их, если редактор наружу открывать не нужно.

## Сборка и публикация образа

```bash
scripts/docker.sh build                                  # fl0w:<версия> и fl0w:latest
docker login ghcr.io
IMAGE=ghcr.io/<вы>/fl0w scripts/docker.sh push           # спросит подтверждение (-y — без вопроса)
IMAGE=ghcr.io/<вы>/fl0w PLATFORMS=linux/amd64,linux/arm64 scripts/docker.sh push   # мультиархитектурная сборка (buildx)
```

Версия берётся из `apps/web/package.json` (или `VERSION=…`). Скрипт ничего не отправляет без команды `push`.

## Обновление

```bash
git pull && docker compose up -d --build     # данные в томах не затрагиваются
```
или `FL0W_IMAGE=<новый образ> docker compose pull && docker compose up -d`.
