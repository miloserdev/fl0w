# Node Flow Board

Визуальный редактор потоков (в духе n8n) с локальным исполнением на Node.js: блоки на холсте, расписание, вебхуки,
Telegram, файлы, циклы, вызовы флоу из флоу, Code Agent. Каждый запуск флоу — отдельный процесс.

- Как это устроено и что умеют блоки — [`docs/BLOCKS.md`](docs/BLOCKS.md), требования — [`SPEC.md`](SPEC.md).
- Развёртывание — ниже и в [`docs/DEPLOY.md`](docs/DEPLOY.md).

> **Безопасность.** У редактора и API нет аутентификации: кто достучится до порта, тот управляет флоу. Держите сервис на
> localhost или за прокси/VPN с авторизацией. Блок Shell по умолчанию выключен.

## Быстрый старт

### Локально (Node 26+, pnpm 11)

```bash
pnpm install
pnpm dev                      # разработка: http://localhost:3000
# или production-режим
pnpm build && pnpm start      # http://localhost:3000
```

Данные (флоу, память, файлы) по умолчанию — `apps/web/.data/`. Переменные окружения — таблица ниже.

### Docker

```bash
cp .env.example .env          # по желанию: порты, Shell, секреты, каталоги
docker compose up -d --build  # http://127.0.0.1:3000
```

Флоу, банки памяти и файлы лежат в томах Docker (`fl0w-data`, `fl0w-files`) или в каталогах хоста и **переживают
удаление контейнера** (`docker compose down`, обновление образа). Не запускайте `docker compose down -v` — он удалит тома.

Готовый образ из реестра: `FL0W_IMAGE=ghcr.io/<вы>/fl0w:0.1.0 docker compose up -d`.

## Настройка

Все параметры — переменные окружения (в Docker — файл `.env`, шаблон — [`.env.example`](.env.example)).

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `FL0W_DATA_DIR` | флоу | локально `apps/web/.data/flows`, в образе `/data/flows` |
| `FL0W_MEMORY_DIR` | банки памяти (Memory Bank, Counter) | локально `apps/web/.data/memory`, в образе `/data/memory` |
| `FL0W_FILES_DIR` | единственный каталог для блоков Files, Local File Trigger и Shell | локально `apps/web/.data/files`, в образе `/data/files` |
| `FL0W_ALLOW_SHELL` | `1` включает блок Shell (команды исполняются на машине сервера/в контейнере) | выключен |
| `FL0W_PUBLIC_URL` | публичный https-адрес для вебхуков Telegram | не задан |
| `FL0W_TELEGRAM_API` | адрес Bot API | `https://api.telegram.org` |
| `FL0W_SECRET_*` | секреты; в параметрах блоков — `env:FL0W_SECRET_ИМЯ` | не заданы |

Только для Docker Compose: `FL0W_PORT`, `FL0W_BIND` (адрес привязки, по умолчанию `127.0.0.1`), `FL0W_IMAGE`,
`FL0W_DATA`, `FL0W_FILES` (том или путь на хосте). Подробнее — [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Разработка

```bash
pnpm check     # типы + линт + тесты
pnpm verify    # то же + production-сборка web
```
