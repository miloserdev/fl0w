import type { Json, ParamSchema } from "@fl0w/schema";
import type { RunContext } from "./block";
import { CODE_ENV_TYPES, CodeBlock } from "./code";

/** d.ts окружения Code Agent: всё из Code плюс подключённые инструменты и память. */
export const CODE_AGENT_ENV_TYPES = `${CODE_ENV_TYPES}
/** Инструменты, подключённые к порту «Инструменты». */
declare const tools: {
  /** Имена, описания и схемы аргументов подключённых инструментов. */
  list(): { name: string; description: string; inputSchema: any }[];
  /** Вызвать инструмент по имени; ошибка инструмента — исключение. */
  call(name: string, args?: any): Promise<any>;
  /** Короткий вызов: tools.run.<имя>(args) */
  run: Record<string, (args?: any) => Promise<any>>;
};
interface Memory {
  name: string;
  driver: string;
  get(key: string): Promise<any | null>;
  set(key: string, value: any): Promise<void>;
  delete(key: string): Promise<boolean>;
  keys(): Promise<string[]>;
  /** Дописать в массив по ключу; max — оставить последние max элементов. */
  append(key: string, value: any, max?: number): Promise<any[]>;
  clear(): Promise<void>;
}
/** Первый подключённый банк памяти (undefined, если ничего не подключено). */
declare const memory: Memory | undefined;
/** Все подключённые банки по имени. */
declare const memories: Record<string, Memory>;
`;

const DEFAULT_CODE = `// Доступны: inputs, params, log, fetch, tools, memory, memories.
// tools.list() — что подключено; await tools.call("current_datetime", { timezone: "UTC" })
const now = await tools.call("current_datetime", {})
const seen = memory ? ((await memory.get("runs")) ?? 0) + 1 : 1
if (memory) await memory.set("runs", seen)
return { out0: { ...inputs.in0, now, runs: seen } }
`;

/** Код внутри vm (после `host`): строит `tools`, `memory`, `memories` поверх строкового моста. */
const AGENT_BOOTSTRAP = `
  const call = async (fn, payload) => {
    const out = JSON.parse(await fn(JSON.stringify(payload)));
    if (out.error !== undefined) throw new Error(out.error);
    return out.result;
  };
  const toolInfo = JSON.parse(host.toolInfo);
  const runners = {};
  for (const t of toolInfo) runners[t.name] = (args) => call(host.tool, { name: t.name, args: args === undefined ? null : args });
  globalThis.tools = Object.freeze({
    list: () => JSON.parse(JSON.stringify(toolInfo)),
    call: (name, args) => call(host.tool, { name: String(name), args: args === undefined ? null : args }),
    run: Object.freeze(runners),
  });
  const banks = {};
  let first;
  for (const m of JSON.parse(host.memoryInfo)) {
    const op = (name, extra) => call(host.memory, { bank: m.name, op: name, ...extra });
    const bank = Object.freeze({
      name: m.name,
      driver: m.driver,
      get: (key) => op("get", { key: String(key) }),
      set: async (key, value) => { await op("set", { key: String(key), value: value === undefined ? null : value }); },
      delete: (key) => op("delete", { key: String(key) }),
      keys: () => op("keys", {}),
      append: (key, value, max) => op("append", { key: String(key), value: value === undefined ? null : value, max }),
      clear: async () => { await op("clear", {}); },
    });
    banks[m.name] = bank;
    first ??= bank;
  }
  globalThis.memories = Object.freeze(banks);
  globalThis.memory = first;
`;

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Нода с кодом, к которой подключаются инструменты и банки памяти (по образцу AI Agent в n8n, но вместо модели — ваш
 * код). Ресурсы приходят в `ctx.tools` / `ctx.memory`; в код попадают только через строковый мост, как и `fetch`.
 */
export class CodeAgent extends CodeBlock {
  static override type = "code_agent";
  static override label = "Code Agent";
  static override icon = "bot";
  static override category = "data";
  static override ports = {
    inputs: [
      { id: "in0" },
      { id: "tools", label: "Tools", kind: "tool" as const, multiple: true },
      { id: "memory", label: "Memory", kind: "memory" as const, multiple: true },
    ],
    outputs: [{ id: "out0" }],
  };
  static override params: ParamSchema[] = [
    { name: "code", type: "string", required: true, default: DEFAULT_CODE, editor: "code", expressions: false },
    { name: "timeoutMs", type: "number", default: 10000, min: 1, max: 300_000 },
  ];
  static override codeTypes = CODE_AGENT_ENV_TYPES;

  protected override bridge(ctx: RunContext) {
    const tools = ctx.tools ?? [];
    const banks = ctx.memory ?? [];
    // как и в fetch-мосте: функции не бросают и не отклоняются, ошибка — внутри строки
    const guard = (fn: (payload: Record<string, Json>) => Promise<Json>) => async (raw: string): Promise<string> => {
      try {
        if (ctx.signal.aborted) throw new Error("Aborted"); // запуск отменён: новые вызовы инструментов и памяти не начинаем
        const result = await fn(JSON.parse(raw) as Record<string, Json>);
        return JSON.stringify({ result: result ?? null });
      } catch (e) {
        return JSON.stringify({ error: errorMessage(e) });
      }
    };
    return {
      host: {
        toolInfo: JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))),
        memoryInfo: JSON.stringify(banks.map((m) => ({ name: m.name, driver: m.driver }))),
        tool: guard(async ({ name, args }) => {
          const t = tools.find((x) => x.name === name);
          if (!t) throw new Error(`Unknown tool "${String(name)}". Available: ${tools.map((x) => x.name).join(", ") || "none"}`);
          return t.call(args ?? null);
        }),
        memory: guard(async ({ bank, op, key, value, max }) => {
          const m = banks.find((x) => x.name === bank);
          if (!m) throw new Error(`Unknown memory bank "${String(bank)}"`);
          switch (op) {
            case "get":
              return m.get(String(key));
            case "set":
              await m.set(String(key), value ?? null);
              return null;
            case "delete":
              return m.delete(String(key));
            case "keys":
              return m.keys();
            case "append":
              return m.append(String(key), value ?? null, typeof max === "number" ? max : undefined);
            case "clear":
              await m.clear();
              return null;
            default:
              throw new Error(`Unknown memory operation "${String(op)}"`);
          }
        }),
      },
      bootstrap: AGENT_BOOTSTRAP,
    };
  }
}
