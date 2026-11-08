import type { Json, ParamSchema } from "@fl0w/schema";
import type { RunContext } from "./block";
import { CODE_ENV_TYPES, CodeBlock } from "./code";

/** d.ts of the Code Agent environment: everything from Code plus the attached tools and memory. */
export const CODE_AGENT_ENV_TYPES = `${CODE_ENV_TYPES}
/** Tools attached to the "Tools" port. */
declare const tools: {
  /** Names, descriptions and argument schemas of the attached tools. */
  list(): { name: string; description: string; inputSchema: any }[];
  /** Call a tool by name; a tool error is an exception. */
  call(name: string, args?: any): Promise<any>;
  /** Short call: tools.run.<name>(args) */
  run: Record<string, (args?: any) => Promise<any>>;
};
interface Memory {
  name: string;
  driver: string;
  get(key: string): Promise<any | null>;
  set(key: string, value: any): Promise<void>;
  delete(key: string): Promise<boolean>;
  keys(): Promise<string[]>;
  /** Append to the array under the key; max keeps the last max items. */
  append(key: string, value: any, max?: number): Promise<any[]>;
  clear(): Promise<void>;
}
/** The first attached memory bank (undefined if nothing is attached). */
declare const memory: Memory | undefined;
/** All attached banks by name. */
declare const memories: Record<string, Memory>;
`;

const DEFAULT_CODE = `// Available: inputs, params, log, fetch, tools, memory, memories.
// tools.list() lists what is attached; await tools.call("current_datetime", { timezone: "UTC" })
const now = await tools.call("current_datetime", {})
const seen = memory ? ((await memory.get("runs")) ?? 0) + 1 : 1
if (memory) await memory.set("runs", seen)
return { out0: { ...inputs.in0, now, runs: seen } }
`;

/** Code inside the vm (after `host`): builds `tools`, `memory`, `memories` on top of the string bridge. */
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
 * A node with code that tools and memory banks attach to (modelled on the AI Agent in n8n, but instead of a model, your
 * code). Resources arrive in `ctx.tools` / `ctx.memory`; they get into the code only through the string bridge, like `fetch`.
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
    // as in the fetch bridge: functions do not throw or reject, the error is inside the string
    const guard = (fn: (payload: Record<string, Json>) => Promise<Json>) => async (raw: string): Promise<string> => {
      try {
        if (ctx.signal.aborted) throw new Error("Aborted"); // the run is cancelled: we do not start new tool and memory calls
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
