import {
  getNodePorts,
  registry as defaultRegistry,
  resolveParamExpressions,
  resolveParams,
  validateParams,
  type CallOutcome,
  type CallRequest,
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
  /**
   * Найти флоу с incoming call на канале (его даёт хост: опубликованные копии или сохранённые в песочнице). Нет канала или он
   * неоднозначен — бросает с причиной. Без опции блок outgoing call отвечает ошибкой.
   */
  resolveCall?: (channelId: string) => Promise<{ flow: unknown; triggerId: string }>;
  /** Флоу, уже стоящие в цепочке вызовов (без текущего) — по ней отсекается рекурсия. Служебное: заполняет вложенный запуск. */
  callChain?: string[];
};

/** Сколько нод одного запуска исполняется одновременно. */
const MAX_PARALLEL = 16;
/** Глубина вложенных вызовов — страховка (вызовы идут в одном процессе). */
const MAX_CALL_DEPTH = 20;

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
  // shoot-вызовы (outgoing call): запуск их не ждёт; если он закончился раньше — они обрываются, и это видно в ленте
  type Shot = { nodeId: string; abort: AbortController; done: Promise<void>; settled: boolean };
  const shots = new Set<Shot>();
  const killShots = async () => {
    const live = [...shots].filter((x) => !x.settled);
    for (const x of live) {
      x.abort.abort();
      await onEvent({ event: "node:killed", nodeId: x.nodeId, reason: "the caller flow finished before the shoot call completed; the called flow was stopped" });
    }
    // оборванным даём мгновение остановиться, но не зависаем на них
    if (live.length > 0) await Promise.race([Promise.allSettled(live.map((x) => x.done)), new Promise((r) => setTimeout(r, 2000))]);
  };
  const finish = async (e: { result?: Json; error?: string }) => {
    await killShots();
    await onEvent({ event: "flow:done", ...e });
  };

  const validation = validateFlow(input, registry);
  if (!validation.ok) {
    await finish({ error: `Invalid flow: ${formatIssues(validation.issues)}` });
    return;
  }
  const flow: Flow = validation.flow;

  // --- вызовы outgoing call: вызванный флоу исполняется вложенным запуском в этом же процессе ---
  // Цепочка — пары «флоу#триггер»: рекурсия это повторный вход в ТОТ ЖЕ incoming call, а не в тот же флоу. Вызов другого графа
  // того же флоу (отдельный incoming call, не связанный с вызывающим) рекурсией не считается.
  const callChain = [...(opts.callChain ?? []), `${flow.id}#${opts.trigger ?? "*"}`];
  const failed = (error: string): CallOutcome => ({ ok: false, error });
  /** Один вызов: найти флоу по каналу, проверить рекурсию и глубину, исполнить как вложенный запуск и вернуть его результат. */
  const nestedCall = async (req: CallRequest, abort: AbortController): Promise<CallOutcome> => {
    if (!opts.resolveCall) return failed("Calling other flows is not available in this environment");
    let target: { flow: unknown; triggerId: string };
    try {
      target = await opts.resolveCall(req.channelId);
    } catch (e) {
      return failed(message(e));
    }
    const calleeId = String((target.flow as { id?: unknown } | null)?.id ?? "");
    const calleeKey = `${calleeId}#${target.triggerId}`;
    // Рекурсию валидатор запрещает статически (Emitter/Loop и Collector не в одном графе, циклов между графами нет); это страховка на
    // случай, когда флоу изменили независимо друг от друга, а проверка между ними не сработала.
    if (callChain.includes(calleeKey)) {
      return failed(`Recursive call: channel "${req.channelId}" leads to "${calleeKey}", which is already in the call chain (${[...callChain, calleeKey].join(" → ")})`);
    }
    if (callChain.length >= MAX_CALL_DEPTH) return failed(`Call chain is too deep (limit ${MAX_CALL_DEPTH} flows)`);
    // Вложенный запуск ТОГО ЖЕ флоу (отдельный граф со своим incoming call) показывает свои ноды на том же холсте — его события идут
    // наружу, чтобы было видно, что incoming отработал. События ДРУГОГО флоу не пересылаются (id нод двух флоу могут совпасть): нужен лишь итог.
    const sameFlow = calleeId === flow.id;
    let done: { result?: Json; error?: string } = { error: "The called flow ended without a result" };
    await runFlow(
      target.flow,
      async (e) => {
        if (e.event === "flow:done") done = e;
        else if (sameFlow) await onEvent(e);
      },
      { registry, signal: abort.signal, trigger: target.triggerId, triggerData: req.data, callChain, resolveCall: opts.resolveCall },
    );
    return done.error !== undefined ? failed(done.error) : { ok: true, result: done.result ?? null };
  };
  const performCall = async (nodeId: string, req: CallRequest): Promise<CallOutcome> => {
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    runSignal.addEventListener("abort", onAbort, { once: true });
    if (req.mode === "await") {
      try {
        return await nestedCall(req, abort);
      } finally {
        runSignal.removeEventListener("abort", onAbort);
      }
    }
    // shoot: стартуем и сразу возвращаемся; судьба вызванного флоу вызывающего не касается, но падение/обрыв пишутся в ленту
    const shot: Shot = { nodeId, abort, settled: false, done: Promise.resolve() };
    shot.done = nestedCall(req, abort)
      .then(async (outcome) => {
        // обрыв по окончании запуска уже отмечен node:killed; остальное (отказ канала, рекурсия, падение) — node:error
        if (!outcome.ok && !abort.signal.aborted) {
          await onEvent({ event: "node:error", nodeId, error: `shoot call to channel "${req.channelId}" failed: ${outcome.error}` });
        }
      })
      .finally(() => {
        shot.settled = true;
        runSignal.removeEventListener("abort", onAbort);
      });
    shots.add(shot);
    return { ok: true, result: { ok: true } };
  };

  // порядок и ожидание входов — только по рёбрам данных; ресурсные рёбра (инструменты, память) читает хозяин
  const dataFlow = dataView(flow, registry);
  const topo = toposort(dataFlow);
  if (!topo.ok) {
    await finish({ error: "Invalid flow: cycle" });
    return;
  }

  const signal = opts.signal ?? new AbortController().signal;
  const nodes = new Map(flow.nodes.map((n) => [n.id, n]));
  if (opts.trigger !== undefined) {
    const t = nodes.get(opts.trigger);
    if (!t || !registry[t.type]?.isTrigger) {
      await finish({ error: `Unknown trigger "${opts.trigger}"` });
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
    await finish({ error: "Nothing to start manually: this flow begins with event triggers (webhook, file, Telegram, …). Publish it and send an event, or add a Manual trigger for testing" });
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
      await finish({ error: `Unknown node "${opts.from}"` });
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

  // --- Параллельное исполнение: нода запускается, как только готовы ЕЁ входы; независимые ветки и графы идут одновременно,
  // долгая нода (Wait, HTTP…) задерживает только то, что от неё зависит. Порядок запуска одновременно готовых нод — топологический.
  const order = new Map(topo.order.map((id, i) => [id, i]));
  const unresolved = new Set(topo.order); // ещё не запущены и не пропущены
  const resolved = new Set<string>(); // отработали или пропущены: их выходные рёбра окончательны (значение или «пусто»)
  const running = new Set<Promise<void>>();
  const inner = new AbortController(); // обрывает остальные ноды, когда одна упала
  const onOuterAbort = () => inner.abort();
  signal.addEventListener("abort", onOuterAbort, { once: true });
  const runSignal = inner.signal;
  let failure: string | undefined;
  const fail = (msg: string) => {
    if (failure === undefined) {
      failure = msg;
      inner.abort();
    }
  };

  /** Решение по ноде, когда ВСЕ её источники определились: пропустить, запустить или ждать. */
  const decide = (id: string): "wait" | "skip" | "run" | "error" => {
    const node = nodes.get(id)!;
    const cls = registry[node.type]!;
    if (!(needed ? needed.has(id) : participants.has(id))) return "skip"; // нет связи со стартовой нодой / не нужна перезапуску
    if (cls.resource || cls.layout) return "skip"; // sub-node вызывает хозяин; заметки и группы — только оформление
    // данные вместо исполнения: закрепление (pin) или выход прошлого запуска для нод до точки перезапуска
    const pinned = manual ? (node.pinData ?? undefined) : undefined;
    const frozen = rerun && !rerun.has(id);
    if (pinned ?? (frozen ? opts.seeds?.[id] : undefined)) return "run";
    if (frozen) return "error"; // нужны данные прошлого запуска, а их нет
    // другие триггеры в этом запуске молчат: он начат от выбранного
    if (cls.isTrigger && (opts.trigger !== undefined ? id !== opts.trigger : cls.eventDriven)) return "skip";
    const edges = incoming.get(id) ?? [];
    // нода со входными портами, у которой ничего не подключено, сама не стартует (стартуют триггеры и источники)
    const entry = cls.isTrigger || getNodePorts(cls, node.portsOverride, node.params).inputs.length === 0;
    if (edges.length === 0 && !entry) return "skip";
    if (edges.some((e) => !resolved.has(e.source))) return "wait"; // есть вход, который ещё не определился
    // готовность входов: по умолчанию ждём ВСЕ подключённые; блок может разрешить запуск по любому пришедшему (Merge, wait: any)
    const waitAny = cls.waitMode(resolveParams(cls.params, node.params)) === "any";
    const arrived = edges.filter((e) => edgeValues.has(e.id)).length;
    if (waitAny ? arrived === 0 && edges.length > 0 : arrived < edges.length) return "skip"; // вход не пришёл — ветка не пошла
    return "run";
  };

  /** Исполнение одной ноды; сбой фиксируется в `failure` (остальные ноды обрываются). */
  const execNode = async (id: string): Promise<void> => {
    const node = nodes.get(id)!;
    const cls = registry[node.type]!;
    const pinned = manual ? (node.pinData ?? undefined) : undefined;
    const frozen = rerun && !rerun.has(id);
    const fixed = pinned ?? (frozen ? opts.seeds?.[id] : undefined);
    const edges = incoming.get(id) ?? [];
    if (fixed !== undefined) {
      await onEvent({ event: "node:start", nodeId: id, input: {}, params: {} });
      await onEvent({ event: "node:log", nodeId: id, message: pinned ? "pinned data used (node not executed)" : "data from the previous run used (node not executed)" });
      for (const e of outgoing.get(id) ?? []) {
        const value = fixed[e.sourcePort];
        if (value !== undefined) edgeValues.set(e.id, value);
      }
      if (node.type === RESULT_TYPE) results.push([id, fixed["in0"] ?? null]);
      await onEvent({ event: "node:done", nodeId: id, output: capRecord(fixed) });
      return;
    }
    const inputs: Record<string, Json> = {};
    for (const e of edges) if (edgeValues.has(e.id)) inputs[e.targetPort] = edgeValues.get(e.id)!;

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
    let displayText: string | undefined;
    try {
      const ctx: RunContext = {
        signal: runSignal,
        triggerData: id === opts.trigger ? opts.triggerData : undefined,
        call: (req) => performCall(id, req),
        connected: [...new Set((outgoing.get(id) ?? []).map((e) => e.sourcePort))],
        flowId: flow.id,
        nodeId: id,
        display: (text) => {
          displayText = String(text).slice(0, 64);
        },
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
      if (runSignal.aborted) throw new Error("Aborted");

      const parsed = outputsSchema.safeParse(raw);
      if (!parsed.success) throw new Error("Block returned a non-JSON output");
      const output = parsed.data;

      for (const e of outgoing.get(id) ?? []) {
        const value = output[e.sourcePort];
        if (value !== undefined) edgeValues.set(e.id, value);
      }
      if (node.type === RESULT_TYPE) results.push([id, inputs["in0"] ?? null]);
      await onEvent({ event: "node:done", nodeId: id, output: maskHeaders(output) as typeof output, ...(displayText !== undefined ? { display: displayText } : {}) });
    } catch (e) {
      live = false;
      // уже упала другая нода (или запуск оборван) — эта оборвана ею, лишних сообщений не пишем
      if (failure !== undefined && !signal.aborted) return;
      await onEvent({ event: "node:error", nodeId: id, error: message(e) });
      fail(`Node "${id}" failed: ${message(e)}`);
    } finally {
      live = false;
    }
  };

  try {
    for (;;) {
      if (signal.aborted) fail("Aborted");
      // запускаем всё, что готово; пропущенные ноды сразу определяют свои выходы («пусто») — это может открыть следующие
      let progress = true;
      while (progress && failure === undefined) {
        progress = false;
        for (const id of topo.order) {
          if (!unresolved.has(id)) continue;
          const d = decide(id);
          if (d === "wait") continue;
          if (d === "error") {
            fail(`No saved data for node "${id}": run the whole flow once, then re-run from a node`);
            break;
          }
          if (d === "skip") {
            unresolved.delete(id);
            resolved.add(id);
            progress = true;
            continue;
          }
          if (running.size >= MAX_PARALLEL) break;
          unresolved.delete(id);
          const p: Promise<void> = execNode(id).finally(() => {
            resolved.add(id);
            running.delete(p);
          });
          running.add(p);
          progress = true;
        }
      }
      if (failure !== undefined || running.size === 0) break;
      await Promise.race(running);
    }
    // после сбоя даём оборванным нодам мгновение остановиться, но не зависаем на них
    if (failure !== undefined && running.size > 0) await Promise.race([Promise.allSettled([...running]), new Promise((r) => setTimeout(r, 2000))]);
  } finally {
    signal.removeEventListener("abort", onOuterAbort);
  }
  if (failure !== undefined) {
    await finish({ error: failure });
    return;
  }
  results.sort((x, y) => (order.get(x[0]) ?? 0) - (order.get(y[0]) ?? 0)); // детерминированный порядок ключей, как при последовательном исполнении

  // один Result → его вход как есть; несколько → объект { nodeId: значение }
  const result: Json | undefined =
    results.length === 0
      ? undefined
      : results.length === 1
        ? results[0]![1]
        : Object.fromEntries(results);
  await finish(result === undefined ? {} : { result });
}
