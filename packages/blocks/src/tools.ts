import type { Json, ParamSchema } from "@fl0w/schema";
import type { ToolHandle } from "./block";
import { CodeBlock } from "./code";
import { ToolBlock } from "./resources";

const nameParam = (def: string): ParamSchema => ({ name: "name", type: "string", required: true, default: def });
const descriptionParam = (def: string): ParamSchema => ({ name: "description", type: "string", multiline: true, default: def });

/** Имя инструмента — идентификатор, по которому его вызывает код (и, позже, модель). */
function toolName(raw: Json | undefined, def: string): string {
  const name = String(raw ?? def).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error(`Invalid tool name "${name}": use letters, digits and _ (up to 64), not starting with a digit`);
  return name;
}

const obj = (args: Json): { [k: string]: Json } => (args !== null && typeof args === "object" && !Array.isArray(args) ? args : {});

/* ---------------------------------------------------------------- дата и время */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Текущие дата и время; часовой пояс — IANA-имя (`Europe/Moscow`), по умолчанию UTC. */
export function currentDateTime(timezone: string, now = new Date()): Json {
  let parts: Record<string, string>;
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "longOffset",
    });
    parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  } catch {
    throw new Error(`Unknown time zone "${timezone}" (use an IANA name such as Europe/Berlin or UTC)`);
  }
  const date = `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
  const time = `${parts["hour"]}:${parts["minute"]}:${parts["second"]}`;
  const offsetRaw = (parts["timeZoneName"] ?? "GMT").replace("GMT", "");
  const offset = offsetRaw === "" ? "+00:00" : offsetRaw;
  const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
  return { iso: `${date}T${time}${offset}`, date, time, weekday, timezone, utcOffset: offset, unix: Math.floor(now.getTime() / 1000) };
}

export class DateTimeTool extends ToolBlock {
  static type = "tool_datetime";
  static label = "Date & Time Tool";
  static icon = "clock";
  static params: ParamSchema[] = [
    nameParam("current_datetime"),
    descriptionParam("Returns the current date and time (optionally in a given IANA time zone)."),
    { name: "timezone", type: "string", default: "UTC" },
  ];

  createTool(params: Record<string, Json>): ToolHandle {
    const fallback = String(params["timezone"] || "UTC");
    return {
      name: toolName(params["name"], "current_datetime"),
      description: String(params["description"] ?? ""),
      inputSchema: { type: "object", properties: { timezone: { type: "string", description: `IANA time zone, default ${fallback}` } } },
      call: async (args) => currentDateTime(String(obj(args)["timezone"] || fallback)),
    };
  }
}

/* ---------------------------------------------------------------- калькулятор */

const MAX_EXPR = 500;
const MAX_DEPTH = 40;
const FUNCS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  trunc: Math.trunc,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  ln: Math.log,
  log: Math.log10,
  exp: Math.exp,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

/** Безопасный вычислитель арифметики: рекурсивный спуск, без eval и доступа к окружению. */
export function calculate(expression: string): number {
  if (expression.length > MAX_EXPR) throw new Error(`Expression is too long (max ${MAX_EXPR} characters)`);
  const src = expression;
  let i = 0;
  const peek = () => {
    while (src[i] === " " || src[i] === "\t") i++;
    return src[i];
  };
  const fail = (what: string): never => {
    throw new Error(`${what} at position ${i + 1}`);
  };
  const expr = (depth: number): number => {
    if (depth > MAX_DEPTH) fail("Expression is nested too deeply");
    let v = term(depth);
    for (;;) {
      const c = peek();
      if (c === "+") {
        i++;
        v += term(depth);
      } else if (c === "-") {
        i++;
        v -= term(depth);
      }
      else return v;
    }
  };
  const term = (depth: number): number => {
    let v = power(depth);
    for (;;) {
      const c = peek();
      if (c === "*" && src[i + 1] !== "*") {
        i++;
        v *= power(depth);
      } else if (c === "/") {
        i++;
        const d = power(depth);
        if (d === 0) fail("Division by zero");
        v /= d;
      } else if (c === "%") {
        i++;
        const d = power(depth);
        if (d === 0) fail("Division by zero");
        v %= d;
      } else return v;
    }
  };
  const power = (depth: number): number => {
    const base = unary(depth);
    const c = peek();
    if (c === "^" || (c === "*" && src[i + 1] === "*")) {
      i += c === "^" ? 1 : 2;
      return base ** power(depth + 1); // правоассоциативно
    }
    return base;
  };
  const unary = (depth: number): number => {
    const c = peek();
    if (c === "-") {
      i++;
      return -unary(depth + 1);
    }
    if (c === "+") {
      i++;
      return unary(depth + 1);
    }
    return atom(depth);
  };
  const atom = (depth: number): number => {
    const c = peek();
    if (c === "(") {
      i++;
      const v = expr(depth + 1);
      if (peek() !== ")") fail("Expected ')'");
      i++;
      return v;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (!id) return fail(c === undefined ? "Unexpected end of expression" : `Unexpected "${c}"`);
    i += id[0].length;
    const name = id[0].toLowerCase();
    if (peek() === "(") {
      const fn = Object.hasOwn(FUNCS, name) ? FUNCS[name] : undefined;
      if (!fn) return fail(`Unknown function "${id[0]}"`);
      i++;
      const args: number[] = [];
      if (peek() !== ")") {
        for (;;) {
          args.push(expr(depth + 1));
          if (peek() === ",") i++;
          else break;
        }
      }
      if (peek() !== ")") fail("Expected ')'");
      i++;
      return fn(...args);
    }
    if (Object.hasOwn(CONSTS, name)) return CONSTS[name]!;
    return fail(`Unknown name "${id[0]}"`);
  };
  const result = expr(0);
  if (peek() !== undefined) fail(`Unexpected "${peek()}"`);
  if (!Number.isFinite(result)) throw new Error("Result is not a finite number");
  return result;
}

export class CalculatorTool extends ToolBlock {
  static type = "tool_calculator";
  static label = "Calculator Tool";
  static icon = "calculator";
  static params: ParamSchema[] = [
    nameParam("calculator"),
    descriptionParam("Evaluates an arithmetic expression: + - * / % ^, parentheses, sqrt, abs, round, min, max, pow, sin, cos, ln, log, pi, e."),
  ];

  createTool(params: Record<string, Json>): ToolHandle {
    return {
      name: toolName(params["name"], "calculator"),
      description: String(params["description"] ?? ""),
      inputSchema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
      call: async (args) => {
        const a = obj(args);
        const expression = typeof args === "string" ? args : a["expression"];
        if (typeof expression !== "string" || expression.trim() === "") throw new Error('Argument "expression" (string) is required');
        return { expression, result: calculate(expression) };
      },
    };
  }
}

/* ---------------------------------------------------------------- случайные значения */

export class RandomTool extends ToolBlock {
  static type = "tool_random";
  static label = "Random Tool";
  static icon = "dices";
  static params: ParamSchema[] = [
    nameParam("random"),
    descriptionParam('Random values: kind "int" or "float" (min, max), "uuid", or "pick" (items).'),
  ];

  createTool(params: Record<string, Json>): ToolHandle {
    return {
      name: toolName(params["name"], "random"),
      description: String(params["description"] ?? ""),
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["int", "float", "uuid", "pick"] },
          min: { type: "number" },
          max: { type: "number" },
          items: { type: "array" },
        },
      },
      call: async (args) => {
        const a = obj(args);
        const kind = String(a["kind"] ?? "int");
        const num = (k: string, d: number) => {
          const v = a[k] === undefined ? d : Number(a[k]);
          if (!Number.isFinite(v)) throw new Error(`"${k}" must be a number`);
          return v;
        };
        // криптостойкий источник доступен и в браузере, и в Node (globalThis.crypto)
        const unit = () => globalThis.crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
        switch (kind) {
          case "uuid":
            return { value: globalThis.crypto.randomUUID() };
          case "int": {
            const min = Math.ceil(num("min", 0));
            const max = Math.floor(num("max", 100));
            if (min > max) throw new Error('"min" must not be greater than "max"');
            return { value: min + Math.floor(unit() * (max - min + 1)) };
          }
          case "float": {
            const min = num("min", 0);
            const max = num("max", 1);
            if (min > max) throw new Error('"min" must not be greater than "max"');
            return { value: min + unit() * (max - min) };
          }
          case "pick": {
            const items = a["items"];
            if (!Array.isArray(items) || items.length === 0) throw new Error('"items" must be a non-empty array');
            return { value: items[Math.floor(unit() * items.length)] ?? null };
          }
          default:
            throw new Error(`Unknown kind "${kind}" (int, float, uuid, pick)`);
        }
      },
    };
  }
}

/* ---------------------------------------------------------------- свой инструмент на коде */

const TOOL_CODE = `// args — аргументы вызова. Верните { out0: <json> }.
return { out0: { echo: inputs.in0 } }
`;

/** Инструмент, который пишете вы: тело функции в той же песочнице `vm`, что и у блока Code; аргументы — `inputs.in0`. */
export class CodeTool extends ToolBlock {
  static type = "tool_code";
  static label = "Code Tool";
  static icon = "code";
  static params: ParamSchema[] = [
    nameParam("custom_tool"),
    descriptionParam("Custom tool written in code."),
    { name: "inputSchema", type: "json", default: { type: "object", properties: {} } },
    { name: "code", type: "string", required: true, default: TOOL_CODE, editor: "code", expressions: false },
    { name: "timeoutMs", type: "number", default: 10000, min: 1, max: 300_000 },
  ];
  static codeTypes = CodeBlock.codeTypes;

  createTool(params: Record<string, Json>): ToolHandle {
    const code = String(params["code"] ?? "");
    const timeoutMs = Number(params["timeoutMs"] ?? 10000);
    return {
      name: toolName(params["name"], "custom_tool"),
      description: String(params["description"] ?? ""),
      inputSchema: params["inputSchema"] ?? { type: "object", properties: {} },
      call: async (args) => {
        const ac = new AbortController();
        const out = await new CodeBlock().run({ in0: args }, { code, timeoutMs }, { signal: ac.signal, log: () => {} });
        return out["out0"] ?? null;
      },
    };
  }
}
