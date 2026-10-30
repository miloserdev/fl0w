import type { Json, ParamSchema, PortsDef } from "@fl0w/schema";

export type FileWatchSpec = {
  /** Файл или папка, относительно каталога файлов (`FL0W_FILES_DIR`). */
  path: string;
  event: "any" | "add" | "change" | "unlink";
  /** Маска имени файла: `*` и `?`. */
  pattern: string;
  recursive: boolean;
};

/** Подписка Telegram Trigger: опрос Bot API (getUpdates) одним токеном на всех подписчиков. */
export type TelegramSpec = {
  /** Расшифрованный токен — живёт только в памяти сервера, в логи и ответы не попадает. */
  token: string;
  /** Типы обновлений; "*" — все, кроме chat_member, message_reaction, message_reaction_count (как у Telegram). */
  updates: string[];
  /**
   * polling — сервер сам опрашивает getUpdates (только исходящие запросы); webhook — Telegram присылает обновления
   * на адрес сервера (мгновенно, но нужен публичный https-адрес).
   */
  mode: "polling" | "webhook";
  /** Публичный адрес сервера (FL0W_PUBLIC_URL, без завершающего слэша) — только для режима webhook. */
  publicUrl?: string;
  chatIds: string[];
  userIds: string[];
  dropPending: boolean;
};

export type LifecycleReason = "publish" | "update" | "startup";
export type LifecycleSpec = Record<LifecycleReason, boolean>;

/** Инструмент, подключённый к ноде (sub-node вида tool): хозяин вызывает его по имени. */
export type ToolHandle = {
  name: string;
  description: string;
  /** Описание аргументов (JSON Schema-подобный объект) — для подсказок и будущего LLM-агента. */
  inputSchema: Json;
  call(args: Json): Promise<Json>;
};

/** Банк памяти, подключённый к ноде (sub-node вида memory): ключ → JSON; драйвер хранения скрыт за интерфейсом. */
export type MemoryHandle = {
  name: string;
  driver: string;
  get(key: string): Promise<Json | null>;
  set(key: string, value: Json): Promise<void>;
  delete(key: string): Promise<boolean>;
  keys(): Promise<string[]>;
  /** Дописывает значение в массив по ключу (создаёт его); `max` — оставить только последние `max` элементов. */
  append(key: string, value: Json, max?: number): Promise<Json[]>;
  clear(): Promise<void>;
};

/** Просьба outgoing call вызвать флоу с входящим телефоном на канале `channelId` (см. `RunContext.call`). */
export type CallRequest = {
  channelId: string;
  data: Json;
  /** await — ждать результат вызванного флоу; shoot — «выстрелить и забыть». */
  mode: "await" | "shoot";
};

/** Итог вызова: для shoot — всегда `ok` (факт отправки), для await — результат вызванного флоу или причина отказа/падения. */
export type CallOutcome = { ok: true; result: Json } | { ok: false; error: string };

/** Итог одной итерации тела цикла: значение Result тела (null, если Result нет) и просьба остановить цикл (Break) либо ошибка. */
export type BodyOutcome = { ok: true; result: Json; broke: boolean } | { ok: false; error: string };

export interface RunContext {
  log(msg: string): void;
  signal: AbortSignal;
  /** Данные, с которыми сработал триггер этой ноды (например, запрос вебхука); у остальных нод нет. */
  triggerData?: Json;
  /** Инструменты и память, подключённые к ресурсным портам этой ноды (движок собирает их перед запуском). */
  tools?: ToolHandle[];
  memory?: MemoryHandle[];
  /**
   * Вызвать флоу по каналу (outgoing call). await: возвращает результат вызванного флоу или ошибку; shoot: возвращается сразу,
   * вызванный флоу идёт «в фоне» внутри этого же запуска и обрывается, если запуск закончится раньше (это логируется).
   */
  call?: (req: CallRequest) => Promise<CallOutcome>;
  /**
   * Только у блока цикла (`bodyPort`): выполнить тело цикла — ноды, достижимые от его порта `body`, — один раз с данными итерации
   * (они выходят из порта `body`). Тело исполняется движком в том же запуске; события его нод видны на холсте.
   */
  runBody?: (data: Json) => Promise<BodyOutcome>;
  /** Внутри тела цикла: остановить ближайший цикл после текущей итерации (блок Break). Снаружи тела — нет. */
  breakLoop?: () => void;
  /** Порты выходов этой ноды, к которым подключены рёбра (нужно, чтобы не терять ошибку, если порт `err` ни к чему не ведёт). */
  connected?: string[];
  /** Флоу и нода, которую сейчас исполняют (у блоков, которым нужна «своя» идентичность — например, Counter). */
  flowId?: string;
  nodeId?: string;
  /** Показать короткий текст на самой ноде вместо иконки (до 64 символов); уходит в событие `node:done`. */
  display?: (text: string) => void;
}

/**
 * Базовый класс блока. Изоморфен: на уровне модуля — никаких node-only
 * или browser-only импортов (они допустимы только внутри тела run).
 */
export abstract class Block {
  static type: string;
  static label: string;
  static icon: string;
  static category: string;
  static ports: PortsDef;
  static params: ParamSchema[];
  static defaultCss = "";
  /**
   * Ресурсный блок (sub-node): не участвует в потоке данных и не запускается сам, а подключается к ресурсному порту
   * ноды-хозяина — `tool` (инструмент) или `memory` (банк памяти). null — обычный блок.
   */
  static resource: "tool" | "memory" | null = null;
  /**
   * Блок оформления (заметка, группа): живёт на холсте и в JSON флоу, но не участвует в запуске — не стартует, не получает
   * и не отдаёт данные. Движок такие ноды игнорирует.
   */
  static layout = false;
  /** Размер ноды на холсте задаёт пользователь (params.width/height, тянут за уголок): заметки, группы, Log. */
  static resizable = false;
  /** Триггер: нода без входов, с которой стартует запуск (по расписанию или вручную). */
  static isTrigger = false;
  /**
   * Триггер срабатывает сам (по расписанию или входящему запросу), без участия человека.
   * Опубликованный флоу без таких триггеров никогда не запустится, поэтому публикация требует хотя бы один.
   */
  static autoTrigger = false;
  /**
   * Триггер ждёт внешнего события (запрос вебхука, файл, сообщение Telegram, ошибка другого флоу, публикация). В ручном запуске
   * такой триггер НЕ стартует: настоящих данных у него нет, а выдуманные «example» запускали бы цепочку с побочными эффектами.
   * Его запускает только само событие (планировщик).
   */
  static eventDriven = false;
  /**
   * Триггер, который поднимается ТОЛЬКО вызовом (incoming call ← outgoing call): ни ручной запуск (даже с закреплёнными
   * данными), ни события, ни расписание его не стартуют.
   */
  static callOnly = false;
  /**
   * Блок цикла: id выходного порта, от которого начинается ТЕЛО цикла (ноды, достижимые от него, исполняются движком по
   * итерациям, а не в основном потоке). null — обычный блок.
   */
  static bodyPort: string | null = null;
  /**
   * Служебные ключи результата `run`, которых нет среди портов: их читает сам движок или хост (Result отдаёт `in0` для ленты,
   * Respond to Webhook — `response` для HTTP-ответа). Любой другой ключ вне объявленных портов — ошибка блока.
   */
  static serviceOutputs: readonly string[] = [];
  /** Порты, зависящие от параметров (например, `err` только в режиме await); null — использовать `ports`. */
  static portsFor(_params: Record<string, Json>): PortsDef | null {
    return null;
  }
  /** Для триггеров по файловой системе: что отслеживать (путь относительно каталога файлов); null — не файловый. */
  static fileWatch(_params: Record<string, Json>): FileWatchSpec | null {
    return null;
  }
  /** Для Telegram Trigger: подписка на обновления бота; null — не такой триггер. */
  static telegram(_params: Record<string, Json>): TelegramSpec | null {
    return null;
  }
  /**
   * Для триггеров жизненного цикла флоу: при каких событиях срабатывать — публикация,
   * обновление опубликованного флоу, старт сервера; null — не такой триггер.
   */
  static lifecycle(_params: Record<string, Json>): LifecycleSpec | null {
    return null;
  }
  /** Для триггера ошибок: ошибки каких флоу обрабатывать (пустой список — любых); null — не такой триггер. */
  static errorScope(_params: Record<string, Json>): { flows: string[] } | null {
    return null;
  }
  /** Для триггеров-вебхуков: на какой путь и метод слушать; null — нода не вебхук. */
  static webhook(_params: Record<string, Json>): { path: string; method: string } | null {
    return null;
  }
  /** Для триггеров с расписанием: период срабатывания в мс; null — расписания нет. */
  static intervalMs(_params: Record<string, Json>): number | null {
    return null;
  }
  /** d.ts окружения для автокомплита в редакторе кода (только у блоков с `editor: "code"` параметром). */
  static codeTypes = "";

  /**
   * Когда запускать ноду: `all` — когда готовы ВСЕ подключённые входы (по умолчанию); `any` — когда пришёл хотя бы один
   * (остальные ветки не пошли — например, после Branch). Решает сам блок по параметрам (Merge).
   */
  static waitMode(_params: Record<string, Json>): "all" | "any" {
    return "all";
  }

  abstract run(
    inputs: Record<string, Json>,
    params: Record<string, Json>,
    ctx: RunContext,
  ): Promise<Record<string, Json>>;
}
