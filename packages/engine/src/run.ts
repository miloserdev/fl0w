import {
  getNodePorts,
  registry as defaultRegistry,
  resolveParamExpressions,
  resolveParams,
  validateParams,
  type RunContext,
} from "@fl0w/blocks";
import { jsonSchema, type Flow, type Json, type RunnerEvent } from "@fl0w/schema";
import { z } from "zod";
import { buildResources, dataView } from "./resources";
import { closure, participatingNodes, startNodes } from "./participants";
import { toposort } from "./toposort";
import { formatIssues, validateFlow, type Registry } from "./validate";

export type RunOptions = {
  registry?: Registry;
  signal?: AbortSignal;
  /**
   * id триггер-ноды, от которой стартует запуск; остальные триггеры пропускаются.
   * Без опции (ручной запуск) срабатывают все триггеры.
   */
  trigger?: string;
  /** Данные срабатывания триггера; передаются в ctx.triggerData ноды `trigger`. */
  triggerData?: Json;
  /**
   * Перезапуск с ноды: исполняются она и всё, что после неё; нужные ей предшественники не запускаются, а выдают
   * закреплённые данные или `seeds[nodeId]` (выход из прошлого запуска). Нет данных — понятная ошибка.
   */
  from?: string;
  seeds?: Record<string, Record<string, Json>>;
  /** Запуск триггера другого флоу (блок Run Flow); без него блок отвечает ошибкой. */
  fire?: (req: { flowId: string; triggerId: string; data: Json }) => Promise<void>;
};

// защита от потока логов из пользовательского кода: IPC и UI не должны захлебнуться
const MAX_LOGS_PER_NODE = 1000;
const MAX_LOG_LENGTH = 10_000;
/** Предел размера входов/параметров ноды в событии node:start (JSON-символов на одно значение). */
const MAX_DEBUG_JSON = 50_000;

/** Значение для отладочного события: слишком большое заменяется описанием, чтобы не раздувать ленту и память вкладки. */
function capDebug(value: Json): Json {
  const text = JSON.stringify(value) ?? "null";
  return text.length <= MAX_DEBUG_JSON ? value : `… truncated: ${text.length} characters, first ${MAX_DEBUG_JSON / 10}: ${text.slice(0, MAX_DEBUG_JSON / 10)}`;
}
/** Имена параметров, значения которых не показываем в ленте: токены, пароли, ключи (ссылки `env:` безопасны и остаются). */
const SECRET_KEY = /token|secret|passw|passphrase|api[-_]?key|authori[sz]ation|credential|cookie/i;
function maskSecrets(value: Json): Json {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) && typeof v === "string" && v !== "" && !v.startsWith("env:") ? "***" : maskSecrets(v)]),
    );
  }
  return value;
}
/** Заголовки с учётными данными в данных нод (вход вебхука кладёт заголовки запроса в выход) — в ленте маскируются. */
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)$/i;
function maskHeaders(value: Json): Json {
  if (Array.isArray(value)) return value.map(maskHeaders);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_HEADER.test(k) && typeof v === "string" ? "***" : maskHeaders(v)]));
  }
  return value;
}
const capRecord = (r: Record<string, Json>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, capDebug(v)]));

/** Тип финального блока (SPEC §5.6): нода без выходов, её вход — результат запуска. */
const RESULT_TYPE = "result";
const outputsSchema = z.record(z.string(), jsonSchema);

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Исполнение флоу в памяти. Ноды идут в топологическом порядке; нода запускается, только если
 * на ВСЕХ подключённых входах лежит JSON (wait-all). Ключа нет в результате `run` — по этому
 * порту данные не пошли, нижестоящая нода останется неготовой и будет пропущена.
 * Всё наблюдаемое отдаётся событиями протокола; метод никогда не бросает.
 *
 * `onEvent` может вернуть промис — тогда события границ ноды (`node:start`, `node:done`,
 * `node:error`) дожидаются доставки. Это важно для процесса-раннера: `process.send` асинхронный,
 * и без ожидания синхронный блок (цикл в Code) блокирует event loop раньше, чем «нода X стартовала»
 * дойдёт до UI — подсвечивалась бы предыдущая нода.
 */
export async function runFlow(
  input: unknown,
  onEvent: (e: RunnerEvent) => void | Promise<void>,
  opts: RunOptions = {},
): Promise<void> {
  const registry = opts.registry ?? defaultRegistry;
  const finish = (e: { result?: Json; error?: string }) => onEvent({ event: "flow:done", ...e });

  const validation = validateFlow(input, registry);
  if (!validation.ok) {
    finish({ error: `Invalid flow: ${formatIssues(validation.issues)}` });
    return;
  }
  const flow: Flow = validation.flow;

  // порядок и ожидание входов — только по рёбрам данных; ресурсные рёбра (инструменты, память) читает хозяин
  const dataFlow = dataView(flow, registry);
  const topo = toposort(dataFlow);
  if (!topo.ok) {
    finish({ error: "Invalid flow: cycle" });
    return;
  }

  const signal = opts.signal ?? new AbortController().signal;
  const nodes = new Map(flow.nodes.map((n) => [n.id, n]));
  if (opts.trigger !== undefined) {
    const t = nodes.get(opts.trigger);
    if (!t || !registry[t.type]?.isTrigger) {
      finish({ error: `Unknown trigger "${opts.trigger}"` });
      return;
    }
  }
  const incoming = new Map<string, Flow["edges"]>();
  const outgoing = new Map<string, Flow["edges"]>();
  for (const e of dataFlow.edges) {
    incoming.set(e.target, [...(incoming.get(e.target) ?? []), e]);
    outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e]);
  }

  // Запускаются только ноды, связанные со стартовыми (триггеры / источники данных), — не любая «без входов».
  const participants = participatingNodes(flow, registry, opts.trigger);
  if (opts.from === undefined && flow.nodes.some((n) => registry[n.type]?.isTrigger) && startNodes(flow, registry, opts.trigger).length === 0) {
    finish({ error: "Nothing to start manually: this flow begins with event triggers (webhook, file, Telegram, …). Publish it and send an event, or add a Manual trigger for testing" });
    return;
  }

  const edgeValues = new Map<string, Json>(); // edge.id → JSON, лежащий на ребре
  const results: [string, Json][] = [];

  // Перезапуск с ноды: rerun — исполняемые (она и всё после), needed — они плюс все их предшественники
  const manual = opts.trigger === undefined; // закрепления (pin) действуют только в ручных запусках; плановые идут по триггеру
  let rerun: Set<string> | undefined;
  let needed: Set<string> | undefined;
  if (opts.from !== undefined) {
    if (!nodes.has(opts.from)) {
      finish({ error: `Unknown node "${opts.from}"` });
      return;
    }
    const out = new Map<string, string[]>();
    const inn = new Map<string, string[]>();
    for (const e of dataFlow.edges) {
      out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
      inn.set(e.target, [...(inn.get(e.target) ?? []), e.source]);
    }
    rerun = closure([opts.from], (id) => out.get(id) ?? []);
    needed = closure(rerun, (id) => inn.get(id) ?? []);
  }

  for (const id of topo.order) {
    if (signal.aborted) {
      finish({ error: "Aborted" });
      return;
    }

    if (!(needed ? needed.has(id) : participants.has(id))) continue; // нет связи со стартовой нодой / не нужна перезапуску
    if (registry[nodes.get(id)!.type]?.resource || registry[nodes.get(id)!.type]?.layout) continue; // sub-node вызывает хозяин; заметки и группы — только оформление
    const node = nodes.get(id)!;

    // Данные вместо исполнения: закрепление (pin) или выход прошлого запуска для нод до точки перезапуска
    const pinned = manual ? (node.pinData ?? undefined) : undefined;
    const frozen = rerun && !rerun.has(id);
    const fixed = pinned ?? (frozen ? opts.seeds?.[id] : undefined);
    if (frozen && fixed === undefined) {
      finish({ error: `No saved data for node "${id}": run the whole flow once, then re-run from a node` });
      return;
    }
    if (fixed !== undefined) {
      await onEvent({ event: "node:start", nodeId: id, input: {}, params: {} });
      await onEvent({ event: "node:log", nodeId: id, message: pinned ? "pinned data used (node not executed)" : "data from the previous run used (node not executed)" });
      for (const e of outgoing.get(id) ?? []) {
        const value = fixed[e.sourcePort];
        if (value !== undefined) edgeValues.set(e.id, value);
      }
      if (node.type === RESULT_TYPE) results.push([id, fixed["in0"] ?? null]);
      await onEvent({ event: "node:done", nodeId: id, output: capRecord(fixed) });
      continue;
    }
    // другие триггеры в этом запуске молчат: он начат от выбранного
    if (registry[node.type]!.isTrigger && (opts.trigger !== undefined ? id !== opts.trigger : registry[node.type]!.eventDriven)) continue;
    const edges = incoming.get(id) ?? [];
    // нода со входными портами, у которой ничего не подключено, сама не стартует (стартуют триггеры и источники)
    const cls = registry[node.type]!;
    const entry = cls.isTrigger || getNodePorts(cls, node.portsOverride).inputs.length === 0;
    if (edges.length === 0 && !entry) continue;
    if (!edges.every((e) => edgeValues.has(e.id))) continue; // вход не готов — ветка не пошла

    const inputs: Record<string, Json> = {};
    for (const e of edges) inputs[e.targetPort] = edgeValues.get(e.id)!;

    // выражения `{{ inputs.inN.путь }}` подставляются во ВСЕ параметры (кроме expressions: false) до запуска блока
    let params: Record<string, Json> = {};
    let paramsError: unknown;
    try {
      params = resolveParamExpressions(cls.params, resolveParams(cls.params, node.params), inputs);
    } catch (e) {
      paramsError = e;
    }
    await onEvent({ event: "node:start", nodeId: id, input: capRecord(maskHeaders(inputs) as Record<string, Json>), params: capRecord(maskSecrets(params) as Record<string, Json>) });
    // после завершения ноды её ctx.log молчит: код может жить в фоне и писать после flow:done
    let live = true;
    let logged = 0;
    try {
      const ctx: RunContext = {
        signal,
        triggerData: id === opts.trigger ? opts.triggerData : undefined,
        fire: opts.fire,
        log: (msg) => {
          if (!live || ++logged > MAX_LOGS_PER_NODE + 1) return;
          const message =
            logged > MAX_LOGS_PER_NODE ? "… log truncated" : String(msg).slice(0, MAX_LOG_LENGTH);
          onEvent({ event: "node:log", nodeId: id, message });
        },
      };
      // после подстановки параметры проверяются ещё раз — например, число из выражения должно быть числом
      if (paramsError !== undefined) throw paramsError;
      // инструменты и память, подключённые к ресурсным портам этой ноды
      const res = buildResources(flow, registry, id, inputs, ctx.log);
      ctx.tools = res.tools;
      ctx.memory = res.memory;
      const issues = validateParams(cls.params, params);
      if (issues.length > 0) throw new Error(`Invalid parameters after resolving expressions: ${issues.map((i) => i.message).join("; ")}`);
      const raw = await new cls().run(inputs, params, ctx);
      if (signal.aborted) throw new Error("Aborted");

      const parsed = outputsSchema.safeParse(raw);
      if (!parsed.success) throw new Error("Block returned a non-JSON output");
      const output = parsed.data;

      for (const e of outgoing.get(id) ?? []) {
        const value = output[e.sourcePort];
        if (value !== undefined) edgeValues.set(e.id, value);
      }
      if (node.type === RESULT_TYPE) results.push([id, inputs["in0"] ?? null]);
      await onEvent({ event: "node:done", nodeId: id, output: maskHeaders(output) as typeof output });
    } catch (e) {
      live = false;
      await onEvent({ event: "node:error", nodeId: id, error: message(e) });
      finish({ error: `Node "${id}" failed: ${message(e)}` });
      return;
    } finally {
      live = false;
    }
  }

  // один Result → его вход как есть; несколько → объект { nodeId: значение }
  const result: Json | undefined =
    results.length === 0
      ? undefined
      : results.length === 1
        ? results[0]![1]
        : Object.fromEntries(results);
  finish(result === undefined ? {} : { result });
}
