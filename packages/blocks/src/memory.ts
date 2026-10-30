import type { Json, ParamSchema } from "@fl0w/schema";
import type { MemoryHandle } from "./block";
import { MemoryBlock } from "./resources";

/** Каталог банков памяти (драйвер json). Сервер выставляет его в окружение, оно наследуется процессами-раннерами. */
export const MEMORY_DIR_ENV = "FL0W_MEMORY_DIR";

/** Пределы банка: значение, число ключей, размер файла. */
export const MEMORY_LIMITS = { valueBytes: 1024 * 1024, keys: 10_000, fileBytes: 10 * 1024 * 1024 } as const;

const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 10_000;

/** Драйвер хранения: все операции атомарны относительно друг друга (в том числе между процессами-раннерами). */
export interface MemoryDriver {
  /** Выполнить изменение над копией данных банка и сохранить результат; читающие видят либо старое, либо новое состояние. */
  read(signal?: AbortSignal): Promise<Record<string, Json>>;
  update<T>(fn: (data: Record<string, Json>) => T, signal?: AbortSignal): Promise<T>;
}

/** Имя банка: безопасное имя файла — без путей, точек и регистра-зависимых сюрпризов. */
export function assertBankName(name: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error(`Invalid memory bank name "${name}": use letters, digits, - and _ (up to 64)`);
}

const queues = new Map<string, Promise<unknown>>();

/** Драйвер json: один файл `<имя>.json`, запись через временный файл и rename, блокировка lock-файлом между процессами. */
export function createJsonDriver(bank: string): MemoryDriver {
  assertBankName(bank);

  const paths = async () => {
    const dir = process.env[MEMORY_DIR_ENV];
    if (!dir) throw new Error(`Memory is not configured: set ${MEMORY_DIR_ENV}`);
    const fs = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "node:fs/promises");
    const path = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "node:path");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(await fs.realpath(dir), `${bank}.json`);
    return { fs, file };
  };

  const load = async (fs: typeof import("node:fs/promises"), file: string): Promise<Record<string, Json>> => {
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error(`Memory bank "${bank}" is corrupted (invalid JSON); fix or delete ${bank}.json`, { cause: e });
    }
    const data = (parsed as { data?: unknown } | null)?.data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error(`Memory bank "${bank}" has an unexpected format`);
    return data as Record<string, Json>;
  };

  const withLock = async <T>(fs: typeof import("node:fs/promises"), file: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const lock = `${file}.lock`;
    const start = Date.now();
    for (;;) {
      try {
        const h = await fs.open(lock, "wx");
        await h.close();
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (signal?.aborted) throw new Error("Aborted", { cause: e }); // ждать замок дальше нет смысла: запуск отменён
        // «мёртвый» замок (процесс убит посреди записи) снимаем по давности
        const st = await fs.stat(lock).catch(() => null);
        if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) await fs.rm(lock, { force: true });
        else if (Date.now() - start > LOCK_WAIT_MS) throw new Error(`Memory bank "${bank}" is busy (lock timeout)`, { cause: e });
        else await new Promise((r) => setTimeout(r, 15));
      }
    }
    try {
      return await fn();
    } finally {
      await fs.rm(lock, { force: true });
    }
  };

  return {
    async read(signal?: AbortSignal) {
      if (signal?.aborted) throw new Error("Aborted");
      const { fs, file } = await paths();
      return load(fs, file);
    },
    update<T>(fn: (data: Record<string, Json>) => T, signal?: AbortSignal): Promise<T> {
      // очередь внутри процесса + lock-файл между процессами
      const run = async (): Promise<T> => {
        const { fs, file } = await paths();
        if (signal?.aborted) throw new Error("Aborted");
        return withLock(fs, file, async () => {
          const data = await load(fs, file);
          const result = fn(data);
          const keys = Object.keys(data).length;
          if (keys > MEMORY_LIMITS.keys) throw new Error(`Memory bank "${bank}" is full (max ${MEMORY_LIMITS.keys} keys)`);
          const text = JSON.stringify({ version: 1, data });
          if (text.length > MEMORY_LIMITS.fileBytes) throw new Error(`Memory bank "${bank}" is full (max ${MEMORY_LIMITS.fileBytes} bytes)`);
          const tmp = `${file}.${process.pid}.tmp`;
          await fs.writeFile(tmp, text, { mode: 0o600 });
          await fs.rename(tmp, file);
          return result;
        }, signal);
      };
      const prev = queues.get(bank) ?? Promise.resolve();
      const next = prev.then(run, run);
      queues.set(bank, next);
      void next.finally(() => queues.get(bank) === next && queues.delete(bank)).catch(() => {});
      return next;
    },
  };
}

/** Банк памяти поверх драйвера: ключ → JSON. */
export function createMemoryHandle(name: string, driverName: string, driver: MemoryDriver, signal?: AbortSignal): MemoryHandle {
  const checkValue = (v: Json) => {
    if (JSON.stringify(v).length > MEMORY_LIMITS.valueBytes) throw new Error(`Value is too large (max ${MEMORY_LIMITS.valueBytes} bytes)`);
  };
  // ключ — непустая строка; `__proto__` отвергается: присваивание ему меняет прототип объекта, а не создаёт запись
  const checkKey = (key: string) => {
    if (key === "" || key.length > 256) throw new Error("Key must be a string of 1 to 256 characters");
    if (key === "__proto__") throw new Error('Key "__proto__" is not allowed');
  };
  const clone = <T extends Json>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const own = (data: Record<string, Json>, key: string) => (Object.hasOwn(data, key) ? data[key]! : null);
  return {
    name,
    driver: driverName,
    async get(key) {
      checkKey(key);
      return clone(own(await driver.read(signal), key));
    },
    async set(key, value) {
      checkKey(key);
      checkValue(value);
      await driver.update((d) => void (d[key] = clone(value)), signal);
    },
    delete: async (key) => (checkKey(key), driver.update((d) => Object.hasOwn(d, key) && delete d[key], signal)),
    async keys() {
      return Object.keys(await driver.read(signal));
    },
    async append(key, value, max) {
      checkKey(key);
      checkValue(value);
      return await driver.update((d) => {
        const cur = Object.hasOwn(d, key) ? d[key] : [];
        if (!Array.isArray(cur)) throw new Error(`Key "${key}" holds a ${cur === null ? "null" : typeof cur}, not an array`);
        let list = [...cur, clone(value)];
        if (max !== undefined) {
          if (!Number.isInteger(max) || max < 1) throw new Error('"max" must be a positive integer');
          list = list.slice(-max);
        }
        d[key] = list;
        return clone(list);
      }, signal);
    },
    async clear() {
      await driver.update((d) => {
        for (const k of Object.keys(d)) delete d[k];
      }, signal);
    },
  };
}

/** Драйверы банка памяти; новые (SQLite, Redis…) добавляются сюда, подключение к блокам не меняется. */
export const MEMORY_DRIVERS: Record<string, (bank: string) => MemoryDriver> = {
  json: createJsonDriver,
};

/** Банк памяти — «база данных» для Code Agent и других блоков: ключ → JSON, драйвер выбирается параметром. */
export class MemoryBank extends MemoryBlock {
  static type = "memory_bank";
  static label = "Memory Bank";
  static icon = "database";
  static params: ParamSchema[] = [
    { name: "driver", type: "enum", default: "json", options: Object.keys(MEMORY_DRIVERS).map((value) => ({ value })) },
    // банки с одним именем — одно хранилище (общее для флоу и запусков)
    { name: "name", type: "string", required: true, default: "default" },
  ];

  createMemory(params: Record<string, Json>, signal?: AbortSignal): MemoryHandle {
    const driver = String(params["driver"] ?? "json");
    const name = String(params["name"] ?? "default").trim();
    const make = Object.hasOwn(MEMORY_DRIVERS, driver) ? MEMORY_DRIVERS[driver] : undefined;
    if (!make) throw new Error(`Unknown memory driver "${driver}" (available: ${Object.keys(MEMORY_DRIVERS).join(", ")})`);
    assertBankName(name);
    return createMemoryHandle(name, driver, make(name), signal);
  }
}
