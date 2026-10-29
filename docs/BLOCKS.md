# Блоки

Справочник по встроенным блокам Node Flow Board. Источник истины — классы в `packages/blocks/src`
(метаданные: `type`, `ports`, `params`); реестр — `packages/blocks/src/registry.ts`.

## Как это работает

- **Один JSON на порт.** Роль «items» из n8n играет массив: блоки «над списком» принимают массив (одиночное
  значение считается списком из одного элемента).
- **Пустой выход — ветка не идёт.** Если блок не вернул ключ порта, нижестоящие ноды по этой ветке не запускаются
  (так работают Branch, Switch, Filter, Compare Datasets: пустой выход данных не получает).
- **Wait-all.** Нода запускается, когда данные пришли на все *подключённые* входы.
- **Запуск идёт от стартовых нод.** Если во флоу есть триггеры — от них, иначе — от источников данных
  (блоки без входов, `Source`). Выполняются стартовые ноды, всё достижимое от них и всё, что питает достижимое
  (например, `Source` во втором входе `Compare Datasets`). Нода, не связанная со стартом, не запускается, даже
  если у неё нет подключённых входов; в интерфейсе после запуска она отображается как «пропущена».
- **В один вход — одно ребро.** Несколько веток сводит `Merge`.
- **Пути** — через точку: `user.name`, `items.0.price`. Пустой путь — само значение.
- **Шаблоны `{{ путь }}`** заменяют выражения n8n и не исполняют код. Строка из одного шаблона сохраняет тип
  значения (`"{{ n }}"` → число), внутри текста значение приводится к строке. `{{ . }}` — весь объект.
  Шаблоны поддерживают: Edit Fields, Date & Time, Crypto, JWT, Respond to Webhook, Stop and Error.
- **Пользовательский код исполняется только в блоке `Code`** (SPEC §12): в `vm`, с белым списком `env`
  и таймаутом. Остальные блоки декларативны.

## Триггеры и публикация

| Блок | Срабатывает | Автоматически |
|---|---|---|
| `manual` — Manual Trigger | при ручном запуске (кнопка Run) | нет |
| `every` — Every | каждые N секунд/минут/часов | да |
| `webhook` — Webhook | при HTTP-запросе на `/api/hooks/<path>` | да |
| `local_file_trigger` — Local File Trigger | при добавлении, изменении или удалении файла в каталоге файлов | да |
| `error_trigger` — Error Trigger | когда падает автоматический запуск другого флоу | да |
| `activation_trigger` — Activation Trigger | при публикации, обновлении опубликованного флоу, старте сервера | да |
| `workflow_trigger` — Workflow Trigger | при публикации и обновлении (как в n8n, без старта сервера) | да |

Ручной запуск (Run) срабатывает **все** триггеры флоу сразу. Плановый запуск и вебхук стартуют только от своего
триггера, остальные в этом запуске молчат.

**Публикация** (`Опубликовать`) сохраняет флоу на сервере (`apps/web/.data/flows`, переменная `FL0W_DATA_DIR`)
и включает его автоматические триггеры: сервер выполняет флоу независимо от того, открыта ли страница. Нужен
хотя бы один автоматический триггер. Исполняется серверная копия — локальные правки вступают в силу после
«Обновить». Каждый запуск идёт в отдельном процессе; плановый тик пропускается, если предыдущий запуск ещё идёт.
Режим **Наблюдать** показывает запуски опубликованного флоу в реальном времени (последний запуск воспроизводится
при подключении).

### Файлы, ошибки, жизненный цикл

- **Local File Trigger** следит за файлом или папкой внутри каталога файлов (`path`, `event` any/add/change/unlink,
  маска имени `pattern` с `*` и `?`, `recursive`). Выход: `{ event, path, name, size, modifiedAt }` (у удалённого файла
  без размера и времени). Серия быстрых записей сворачивается в одно срабатывание; файлы, лежавшие до публикации,
  событий не дают. События идут под тем же лимитом параллельных запусков, что и вебхуки (лишние пропускаются).
- **Error Trigger** запускает флоу-«обработчик», когда падает **автоматический** запуск (расписание, вебхук, файл,
  активация) опубликованного флоу. `flows` — id флоу, чьи ошибки принимать (пусто — любые, в том числе этого же флоу).
  Выход: `{ flow: {id, name}, run: {id, trigger}, error: {message, node}, at }`. Ручные запуски из редактора сюда не
  попадают, а падение самого обработчика новых обработчиков не вызывает (цепочки ошибок нет). Блок `Stop and Error`
  удобен, чтобы отправлять в обработчик собственные сообщения.
- **Activation Trigger** срабатывает на события *этого* флоу: `onPublish` — первая публикация, `onUpdate` — обновление уже
  опубликованного флоу, `onStartup` — старт (перезапуск) сервера. Выход: `{ event, at, flow: {id, name} }`.
  **Workflow Trigger** — то же без старта сервера (в n8n этот узел объявлен устаревшим в пользу Activation Trigger).

### Webhook

`POST|GET|PUT|PATCH|DELETE|ANY /api/hooks/<path>`. Блок отдаёт запрос:

```json
{ "method": "POST", "path": "demo/orders", "query": { "a": "1" }, "headers": { "content-type": "…" }, "body": { } }
```

Тело: `application/json` → объект, `application/x-www-form-urlencoded` → объект, иначе текст. Повторяющиеся
параметры query собираются в массив. Предел тела — 1 МБ (`413`), одновременных запусков по вебхукам — 8 (`429`).
Путь уникален среди опубликованных флоу (`409` при конфликте).

`respond`: `onReceived` — сразу `200 {"message":"Workflow was started"}`, флоу идёт в фоне; `whenFinished` — ответ
после завершения: **Respond to Webhook**, иначе результат **Result**, иначе `500` при ошибке флоу.

> Вебхуки не защищены аутентификацией — это решение для локального и командного (доверенного) использования.

## Справочник

Порты: `in` / `out`. «Список» — значение по `path` (пусто — вход).

### Триггеры

| Блок | Порты | Параметры |
|---|---|---|
| **Manual Trigger** `manual` | — / out0 `{triggeredAt}` | — |
| **Every** `every` | — / out0 `{triggeredAt}` | `interval` (≥ 1), `unit`: seconds, minutes, hours |
| **Local File Trigger** `local_file_trigger` | — / out0 событие файла | `path`, `event`, `pattern`, `recursive` |
| **Error Trigger** `error_trigger` | — / out0 данные об ошибке | `flows` |
| **Activation Trigger** `activation_trigger` | — / out0 `{event, at, flow}` | `onPublish`, `onUpdate`, `onStartup` |
| **Workflow Trigger** `workflow_trigger` | — / out0 `{event, at, flow}` | `onPublish`, `onUpdate` |
| **Webhook** `webhook` | — / out0 запрос | `path`, `method`, `respond` |

### Ввод / вывод

| Блок | Порты | Параметры |
|---|---|---|
| **Source** `source` | — / out0 | `json` |
| **HTTP Request** `http_request` | in0 / out0 | `method` GET/POST, `url`, `headers`, `body` (пусто — вход), `timeoutMs` |
| **Respond to Webhook** `respond_to_webhook` | in0 / — | `status`, `body` (пусто — вход; шаблоны), `headers` |
| **Read/Write Files** `files` | in0 / out0 | `operation` read/write/append/list, `path` (шаблоны; маска `* ? [] **` для read и list), `format` text/json/base64, `content`, `createDirs`, `overwrite` |
| **Shell** `shell` | in0 / out0 `{stdout, stderr, exitCode, signal}` | `script`, `args`, `env`, `stdin`, `cwd`, `shell` bash/sh, `timeoutMs`, `failOnError` — **отключён по умолчанию** |
| **Result** `result` | in0 / — | — |

### Данные

| Блок | Порты | Что делает | Параметры |
|---|---|---|---|
| **Transform** `transform` | in0 / out0 | map / filter списка | `mode`, `path`, `fields`, условие |
| **Edit Fields** `set` | in0 / out0 | задаёт, перезаписывает, удаляет поля; массив — поэлементно | `fields` `{путь: значение\|шаблон}`, `keepOnlySet`, `remove` |
| **Filter** `filter` | in0 / out0 kept, out1 discarded | делит список по условию | `path`, `field`, `operator`, `value` |
| **Sort** `sort` | in0 / out0 | устойчивая сортировка или перемешивание | `path`, `mode` simple/random, `fields` (`"a"` или `{field, order}`), `order` |
| **Limit** `limit` | in0 / out0 | первые/последние N | `path`, `count`, `keep` |
| **Remove Duplicates** `remove_duplicates` | in0 / out0 | убирает повторы, остаётся первое | `path`, `compare` all/fields, `fields` |
| **Aggregate** `aggregate` | in0 / out0 | список → один объект | `mode` fields/all, `fields` (`"a"` или `{field, as}`), `mergeLists`, `keepMissing`, `into`, `include`, `fieldsList` |
| **Split Out** `split_out` | in0 / out0 | массив из поля → элементы | `field`, `include` none/all/selected, `fieldsToInclude`, `into` |
| **Summarize** `summarize` | in0 / out0 | сводка как в pivot-таблицах | `aggregations` `[{field, op, as, separator}]`, `groupBy` |
| **Rename Keys** `rename_keys` | in0 / out0 | переименование полей | `keys` `{старое: новое}` (точечный путь — вложенное поле) |
| **Date & Time** `datetime` | in0 / out0 | now, format, add, subtract, diff, extract, round (UTC) | `operation`, `value`, `unit`, `amount`, `format`, `part`, `other`, `direction`, `field`, `includeInput` |
| **Crypto** `crypto` | in0 / out0 | hash, hmac, generate, encrypt/decrypt (AES-256-GCM) | `action`, `value`, `algorithm`, `encoding`, `secret`, `kind`, `length`, `field`, `includeInput` |
| **JWT** `jwt` | in0 / out0 | sign / verify / decode (HS256/384/512) | `operation`, `secret`, `algorithm`, `payload`, `expiresInSeconds`, `token` |
| **Code** `code` | in0 / out0 | пользовательский JS | `code`, `timeoutMs` |

Операторы условий: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `exists`, `truthy`.
Операции `summarize`: `count`, `countUnique`, `sum`, `average`, `min`, `max`, `append`, `concatenate`.
Формат дат: токены `YYYY MM DD HH mm ss SSS`; пусто — ISO 8601. Даты без пояса считаются UTC.

### Логика

| Блок | Порты | Что делает | Параметры |
|---|---|---|---|
| **Branch** `branch` | in0 / out0 true, out1 false | одно условие | `field`, `operator`, `value` |
| **Switch** `switch` | in0 / out0…out3, fallback | до 4 правил, первое совпавшее или все | `field`, `rules` `[{field?, operator, value}]`, `mode` first/all |
| **Merge** `merge` | in0…in3 / out0 | сводит подключённые входы | `mode` array/object/assign/concat |
| **Compare Datasets** `compare_datasets` | in0 A, in1 B / A only, same, different, B only | сравнение по ключу | `fieldA`, `fieldB`, `skip`, `fuzzy`, `resolve` a/b/both |
| **Wait** `wait` | in0 / out0 | пауза (до 5 минут — лимит запуска) | `amount`, `unit` |
| **Stop and Error** `stop_and_error` | in0 / — | останавливает запуск с ошибкой | `errorType`, `message`, `errorObject` |
| **No Operation** `noop` | in0 / out0 | пропускает данные | — |

## Чего нет по сравнению с n8n — и почему

| n8n | Решение |
|---|---|
| SSH | команды на чужих машинах: нужны учётные данные и проверка хостов; решение пока не принято |
| Execute Command | есть как **Shell**, но по умолчанию отключён (см. «Окружение и безопасность») |
| Loop Over Items (Split In Batches) | граф — DAG, циклы запрещены; списки обрабатываются целиком |
| Compression, Convert to File, Extract from File, Edit Image | бинарных данных в модели «один JSON на порт» нет |
| Send Email, FTP, Git, LDAP, RSS | нужны внешние учётные данные; хранилища credentials в MVP нет |
| Выражения `{{ $json… }}` | заменены шаблонами `{{ путь }}` без исполнения кода |
| Часовые пояса в Date & Time | всё в UTC |

## Окружение и безопасность

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `FL0W_FILES_DIR` | единственный каталог, доступный блокам Files, Local File Trigger и рабочей папке Shell | `apps/web/.data/files` |
| `FL0W_ALLOW_SHELL` | `1` / `true` разрешает блок Shell | не задана — Shell отключён |
| `FL0W_DATA_DIR` | где хранятся опубликованные флоу | `apps/web/.data/flows` |

Запуск с Shell: `FL0W_ALLOW_SHELL=1 pnpm dev`.

**Почему Shell отключён.** Редактор и API не защищены аутентификацией: кто достучится до порта, тот может опубликовать флоу с
блоком Shell. Включайте переменную только на машине, к которой доступ есть у вас одного (или за аутентификацией на уровне
прокси/сети). Что сделано для безопасности самого блока:

- скрипт не шаблонизируется — данные передаются в `args` (это `$1`, `$2`…), `env` и `stdin`, поэтому `{{ ввод }}` не может
  превратиться в команду;
- команде не передаётся окружение сервера (токены, ключи) — только `PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`, `TERM` и заданные в `env`;
- выполнение в каталоге файлов, таймаут (по умолчанию 30 с, максимум 5 мин), вывод до 1 МБ, при таймауте и отмене запуска
  убивается вся группа процессов;
- файловые блоки не выходят за `FL0W_FILES_DIR`: абсолютные пути, `..` и симлинки наружу отвергаются.

Shell всё равно исполняет произвольные команды с правами пользователя, под которым запущен сервер.

## Добавить блок

Класс в `packages/blocks/src` + строка в `registry.ts`. Для UI нужны переводы в `apps/web/messages/{ru,en}.json`
(`blocks.<type>`, `params.<type>.<param>`, `paramOptions.<param>.<value>`, `ports.<type>.<port>` для портов с
подписью) и иконка в `block-icon.tsx`; тест `messages.test.ts` подскажет, чего не хватает.
