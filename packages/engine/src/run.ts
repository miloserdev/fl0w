import {
  getNodePorts,
  registry as defaultRegistry,
  resolveParamExpressions,
  resolveParams,
  validateParams,
  type BodyOutcome,
  type CallOutcome,
  type CallRequest,
  type RunContext,
} from "@fl0w/blocks";
import { jsonSchema, type Flow, type Json, type RunnerEvent } from "@fl0w/schema";
import { z } from "zod";
import { buildResources, dataView } from "./resources";
import { closure, participatingNodes, startNodes } from "./participants";
import { PauseGate } from "./pause-gate";
import { toposort } from "./toposort";
import { formatIssues, validateFlow, type Registry } from "./validate";

export type RunOptions = {
  registry?: Registry;
  signal?: AbortSignal;
  /**
   * id of the trigger node the run starts from; the other triggers are skipped.
   * Without the option (manual run) all triggers fire.
   */
  trigger?: string;
  /** Trigger firing data; passed to ctx.triggerData of the `trigger` node. */
  triggerData?: Json;
  /**
   * Restart from a node: it and everything after it are executed; the predecessors it needs are not run but yield
   * pinned data or `seeds[nodeId]` (output from the previous run). No data: a clear error.
   */
  from?: string;
  seeds?: Record<string, Record<string, Json>>;
  /**
   * Pins (pin data) apply. By default only when `trigger` is not set (manual run); the sandbox, which runs ONE
   * trigger with a button on the node, passes `pins: true`. Scheduled runs of a published flow never apply pins.
   */
  pins?: boolean;
  /**
   * Find a flow with an incoming call on a channel (provided by the host: published copies or ones saved in the sandbox). If the channel is missing or
   * ambiguous, throws with a reason. Without the option, the outgoing call block responds with an error.
   */
  resolveCall?: (channelId: string) => Promise<{ flow: unknown; triggerId: string }>;
  /** Flows already in the call chain (excluding the current one); used to cut off recursion. Internal: filled in by a nested run. */
  callChain?: string[];
  /**
   * Internal (loop body): execute ONLY these nodes (the body) and take the missing inputs from `seeds`: a nested run of one iteration
   * of the loop over the same, already validated flow (`validated`). It has no start checks of its own, events of frozen nodes are not written, shoot calls
   * belong to the outer run (`shots`), and `loopBreak` is called by the Break block.
   */
  scope?: Set<string>;
  validated?: boolean;
  loopBreak?: () => void;
  shots?: Set<unknown>;
  /** Pause: while on, new nodes do not start (running ones finish). Nested runs inherit the gate. */
  gate?: PauseGate;
};

/**
 * Cancelling a nested run (a shoot call cut off at the end of the run, a neighbouring branch failed) is not a failure of its nodes: nodes that stopped
 * because of the cancellation do not write `node:error` "Aborted" to the feed (otherwise all parallel Waits would look failed). The cut-off is visible via `node:killed`.
 */
const isCancellation = (e: RunnerEvent) => e.event === "node:error" && e.error === "Aborted";

/** How many nodes of one run execute at the same time. */
const MAX_PARALLEL = 16;
/** Depth of nested calls is a safety net (calls run in one process). */
const MAX_CALL_DEPTH = 20;
/** Events of loop body nodes are forwarded only for this many first iterations. */
const LOOP_EVENT_ITERATIONS = 20;

// protection from a flood of logs from user code: IPC and the UI must not choke
const MAX_LOGS_PER_NODE = 1000;
const MAX_LOG_LENGTH = 10_000;
/** Size limit of a node's inputs/parameters in the node:start event (JSON characters per value). */
const MAX_DEBUG_JSON = 50_000;

/** Value for a debug event: one that is too large is replaced by a description so as not to bloat the feed and the tab's memory. */
function capDebug(value: Json): Json {
  const text = JSON.stringify(value) ?? "null";
  return text.length <= MAX_DEBUG_JSON ? value : `… truncated: ${text.length} characters, first ${MAX_DEBUG_JSON / 10}: ${text.slice(0, MAX_DEBUG_JSON / 10)}`;
}
/** Names of parameters whose values are not shown in the feed: tokens, passwords, keys (`env:` references are safe and stay). */
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
/** Headers with credentials in node data (the webhook input puts request headers into its output); masked in the feed. */
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)$/i;
function maskHeaders(value: Json): Json {
  if (Array.isArray(value)) return value.map(maskHeaders);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_HEADER.test(k) && typeof v === "string" ? "***" : maskHeaders(v)]));
  }
  return value;
}
const capRecord = (r: Record<string, Json>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, capDebug(v)]));

/** Type of the final block: a node without outputs, its input is the run result. */
const RESULT_TYPE = "result";
const outputsSchema = z.record(z.string(), jsonSchema);

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * In-memory flow execution. Nodes go in topological order; a node starts only if
 * every connected input holds JSON (wait-all). A key missing from the `run` result means
 * no data went through that port, so the downstream node stays not ready and is skipped.
 * Everything observable is delivered as protocol events; the method never throws.
 *
 * `onEvent` may return a promise, in which case node boundary events (`node:start`, `node:done`,
 * `node:error`) wait for delivery. This matters for the process runner: `process.send` is asynchronous,
 * and without waiting a synchronous block (a loop in Code) blocks the event loop before "node X started"
 * reaches the UI, so the previous node would be highlighted.
 */
export async function runFlow(
  input: unknown,
  onEvent: (e: RunnerEvent) => void | Promise<void>,
  opts: RunOptions = {},
): Promise<void> {
  const registry = opts.registry ?? defaultRegistry;
  // shoot calls (outgoing call): the run does not wait for them; if it finished earlier they are cut off, and this is visible in the feed
  type Shot = { nodeId: string; abort: AbortController; done: Promise<void>; settled: boolean };
  const shots = (opts.shots as Set<Shot> | undefined) ?? new Set<Shot>();
  const killShots = async () => {
    if (opts.scope) return; // loop iteration: shoot calls live as long as the whole run
    const live = [...shots].filter((x) => !x.settled);
    for (const x of live) {
      x.abort.abort();
      await onEvent({ event: "node:killed", nodeId: x.nodeId, reason: "the caller flow finished before the shoot call completed; the called flow was stopped" });
    }
    // give cut-off ones a moment to stop, but do not hang on them
    if (live.length > 0) await Promise.race([Promise.allSettled(live.map((x) => x.done)), new Promise((r) => setTimeout(r, 2000))]);
  };
  const finish = async (e: { result?: Json; error?: string }) => {
    await killShots();
    await onEvent({ event: "flow:done", ...e });
  };

  let flow: Flow;
  if (opts.validated) flow = input as Flow; // nested run of a loop body: the flow was already validated by the outer run
  else {
    const validation = validateFlow(input, registry);
    if (!validation.ok) {
      await finish({ error: `Invalid flow: ${formatIssues(validation.issues)}` });
      return;
    }
    flow = validation.flow;
  }

  // --- outgoing call: the called flow runs as a nested run in this same process ---
  // The chain is "flow#trigger" pairs: recursion means re-entering the SAME incoming call, not the same flow. A call to another graph
  // of the same flow (a separate incoming call unrelated to the caller) does not count as recursion.
  const callChain = opts.scope ? [...(opts.callChain ?? [])] : [...(opts.callChain ?? []), `${flow.id}#${opts.trigger ?? "*"}`];
  const failed = (error: string): CallOutcome => ({ ok: false, error });
  /** One call: find the flow by channel, check recursion and depth, execute as a nested run and return its result. */
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
    // The validator forbids recursion statically (Emitter/Loop and Collector are not in one graph, no cycles between graphs); this is a safety net for
    // the case where flows were changed independently of each other and the check between them did not fire.
    if (callChain.includes(calleeKey)) {
      return failed(`Recursive call: channel "${req.channelId}" leads to "${calleeKey}", which is already in the call chain (${[...callChain, calleeKey].join(" → ")})`);
    }
    if (callChain.length >= MAX_CALL_DEPTH) return failed(`Call chain is too deep (limit ${MAX_CALL_DEPTH} flows)`);
    // A nested run of the SAME flow (a separate graph with its own incoming call) shows its nodes on the same canvas, so its events go
    // outward to make it visible that the incoming call worked. Events of ANOTHER flow are not forwarded (node ids of two flows may coincide): only the result is needed.
    const sameFlow = calleeId === flow.id;
    let done: { result?: Json; error?: string } = { error: "The called flow ended without a result" };
    await runFlow(
      target.flow,
      async (e) => {
        if (e.event === "flow:done") done = e;
        else if (sameFlow && !isCancellation(e)) await onEvent(e);
      },
      { registry, signal: abort.signal, trigger: target.triggerId, triggerData: req.data, callChain, resolveCall: opts.resolveCall, gate: opts.gate },
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
    // shoot: start and return immediately; the fate of the called flow does not concern the caller, but a failure/cut-off is written to the feed
    const shot: Shot = { nodeId, abort, settled: false, done: Promise.resolve() };
    shot.done = nestedCall(req, abort)
      .then(async (outcome) => {
        // a cut-off at the end of the run is already marked by node:killed; everything else (channel refusal, recursion, failure) is node:error
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

  // order and input waiting go only by data edges; resource edges (tools, memory) are read by the host
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
    if (t.disabled) {
      await finish({ error: `Trigger "${opts.trigger}" is disabled` });
      return;
    }
  }
  const incoming = new Map<string, Flow["edges"]>();
  const outgoing = new Map<string, Flow["edges"]>();
  for (const e of dataFlow.edges) {
    incoming.set(e.target, [...(incoming.get(e.target) ?? []), e]);
    outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e]);
  }

  // Only nodes connected to the starting ones (triggers / data sources) run, not just any node "without inputs".
  const participants = participatingNodes(flow, registry, opts.trigger);
  if (!opts.scope && opts.from === undefined && flow.nodes.some((n) => registry[n.type]?.isTrigger && !n.disabled) && startNodes(flow, registry, opts.trigger).length === 0) {
    await finish({ error: "Nothing to start manually: this flow begins with event triggers (webhook, file, Telegram, …). Publish it and send an event, or add a Manual trigger for testing" });
    return;
  }

  const edgeValues = new Map<string, Json>(); // edge.id → the JSON lying on the edge
  const results: [string, Json][] = [];

  // Restart from a node: rerun is what gets executed (it and everything after), needed is rerun plus all their predecessors
  const manual = opts.pins ?? opts.trigger === undefined; // pins apply only in manual runs; scheduled ones go by the trigger
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

  // --- Loops: the loop body (nodes reachable from the `body` port) is executed by the loop block itself, iteration by iteration, not by the main flow ---
  const loopBodies = new Map<string, Set<string>>();
  for (const n of flow.nodes) {
    const bodyPort = registry[n.type]?.bodyPort;
    if (!bodyPort) continue;
    const starts = (outgoing.get(n.id) ?? []).filter((e) => e.sourcePort === bodyPort).map((e) => e.target);
    loopBodies.set(n.id, closure(starts, (id) => (outgoing.get(id) ?? []).map((e) => e.target)));
  }
  // External body inputs: sources of edges that enter the body from outside. The body runs inside the loop and cannot "wait" for them
  // later, so the loop itself waits until all of them are determined (a value or "empty").
  const bodyFeeders = new Map<string, string[]>();
  for (const [loopId, body] of loopBodies) {
    const feeders = new Set<string>();
    for (const e of dataFlow.edges) if (body.has(e.target) && !body.has(e.source) && e.source !== loopId) feeders.add(e.source);
    bodyFeeders.set(loopId, [...feeders]);
  }
  // the main flow skips the body nodes of ITS OWN loops; an iteration run (scope) covers the loop bodies inside the scope (outer loops do not count)
  const inBody = new Set<string>();
  for (const [loopId, body] of loopBodies) {
    if (opts.scope && !opts.scope.has(loopId)) continue;
    for (const b of body) inBody.add(b);
  }
  if (opts.scope) {
    // scope: only body nodes are executed, direct sources of their inputs are "frozen" and supply data from seeds
    rerun = opts.scope;
    needed = new Set(opts.scope);
    for (const e of dataFlow.edges) if (opts.scope.has(e.target) && !opts.scope.has(e.source)) needed.add(e.source);
  }

  /** One loop iteration: a nested run of the body (scope); the iteration data comes out of the loop's `body` port. */
  const iterations = new Map<string, number>();
  const runBodyIteration = async (loopId: string, bodyPort: string, data: Json): Promise<BodyOutcome> => {
    const body = loopBodies.get(loopId);
    if (!body || body.size === 0) return { ok: false, error: 'The loop has no body: connect nodes to its "each" output' };
    const seeds: Record<string, Record<string, Json>> = { [loopId]: { [bodyPort]: data } };
    for (const e of dataFlow.edges) {
      // values that came into the body from outside (from nodes outside the body) are taken from already computed edges
      if (body.has(e.target) && !body.has(e.source) && e.source !== loopId && edgeValues.has(e.id)) (seeds[e.source] ??= {})[e.sourcePort] = edgeValues.get(e.id)!;
    }
    const n = iterations.get(loopId) ?? 0;
    iterations.set(loopId, n + 1);
    // body node events are visible on the canvas only for the first iterations, otherwise the feed and IPC would choke on a long loop
    const forward = n < LOOP_EVENT_ITERATIONS;
    let broke = false;
    let done: { result?: Json; error?: string } | undefined;
    await runFlow(
      flow,
      async (e) => {
        if (e.event === "flow:done") done = e;
        else if (forward && !isCancellation(e)) await onEvent(e);
      },
      { registry, signal: runSignal, trigger: opts.trigger, triggerData: opts.triggerData, callChain, resolveCall: opts.resolveCall, scope: body, seeds, validated: true, loopBreak: () => (broke = true), shots, gate: opts.gate },
    );
    if (n === LOOP_EVENT_ITERATIONS) await onEvent({ event: "node:log", nodeId: loopId, message: `events of the iterations after ${LOOP_EVENT_ITERATIONS} are not shown` });
    if (done === undefined) return { ok: false, error: "The loop body ended without a result" };
    const d = done as { result?: Json; error?: string };
    return d.error !== undefined ? { ok: false, error: d.error } : { ok: true, result: d.result ?? null, broke };
  };

  // --- Parallel execution: a node starts as soon as ITS inputs are ready; independent branches and graphs run at once,
  // a long node (Wait, HTTP…) delays only what depends on it. Nodes that become ready together start in topological order.
  const order = new Map(topo.order.map((id, i) => [id, i]));
  const unresolved = new Set(topo.order); // not yet started and not skipped
  const resolved = new Set<string>(); // finished or skipped: their output edges are final (a value or "empty")
  const running = new Set<Promise<void>>();
  const inner = new AbortController(); // aborts the remaining nodes when one fails
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

  /** Decision about a node once ALL its sources are determined: skip, run or wait. */
  const decide = (id: string): "wait" | "skip" | "run" | "error" => {
    const node = nodes.get(id)!;
    const cls = registry[node.type]!;
    if (node.disabled) return "skip"; // disabled: takes no part (no outputs, so the branch behind it does not run)
    if (inBody.has(id)) return "skip"; // the loop body is executed by the loop itself
    if (!(needed ? needed.has(id) : participants.has(id))) return "skip"; // not connected to a starting node / not needed for the restart
    if (cls.resource || cls.layout) return "skip"; // a sub-node is called by its host; notes and groups are decoration only
    // data instead of execution: a pin or the previous run's output for nodes before the restart point
    const pinned = manual ? (node.pinData ?? undefined) : undefined;
    const frozen = rerun && !rerun.has(id);
    if (pinned ?? (frozen ? opts.seeds?.[id] : undefined)) return "run";
    if (frozen) return opts.scope ? "skip" : "error"; // previous run data is needed but absent (a loop iteration's input may not have arrived, so the branch did not go)
    // other triggers are silent in this run: it was started from the chosen one
    if (cls.isTrigger && (opts.trigger !== undefined ? id !== opts.trigger : cls.eventDriven)) return "skip";
    // a loop also waits for the external inputs of its body (otherwise the body starts without data and wait-all nodes silently skip)
    if (cls.bodyPort && (bodyFeeders.get(id) ?? []).some((dep) => !resolved.has(dep))) return "wait";
    const edges = incoming.get(id) ?? [];
    // a node with input ports and nothing connected does not start by itself (triggers and sources do)
    const entry = cls.isTrigger || getNodePorts(cls, node.portsOverride, node.params).inputs.length === 0;
    if (edges.length === 0 && !entry) return "skip";
    if (edges.some((e) => !resolved.has(e.source))) return "wait"; // there is an input that is not yet determined
    // input readiness: by default wait for ALL connected; a block may allow starting on any one that arrived (Merge, wait: any)
    const waitAny = cls.waitMode(resolveParams(cls.params, node.params)) === "any";
    const arrived = edges.filter((e) => edgeValues.has(e.id)).length;
    if (waitAny ? arrived === 0 && edges.length > 0 : arrived < edges.length) return "skip"; // the input did not arrive, so the branch did not go
    return "run";
  };

  /** Execution of one node; a failure is recorded in `failure` (the other nodes are aborted). */
  const execNode = async (id: string): Promise<void> => {
    const node = nodes.get(id)!;
    const cls = registry[node.type]!;
    const pinned = manual ? (node.pinData ?? undefined) : undefined;
    const frozen = rerun && !rerun.has(id);
    const fixed = pinned ?? (frozen ? opts.seeds?.[id] : undefined);
    const edges = incoming.get(id) ?? [];
    if (fixed !== undefined) {
      if (!opts.scope) {
        await onEvent({ event: "node:start", nodeId: id, input: {}, params: {} });
        await onEvent({ event: "node:log", nodeId: id, message: pinned ? "pinned data used (node not executed)" : "data from the previous run used (node not executed)" });
      }
      for (const e of outgoing.get(id) ?? []) {
        const value = fixed[e.sourcePort];
        if (value !== undefined) edgeValues.set(e.id, value);
      }
      if (node.type === RESULT_TYPE) results.push([id, fixed["in0"] ?? null]);
      if (!opts.scope) await onEvent({ event: "node:done", nodeId: id, output: capRecord(fixed) });
      return;
    }
    const inputs: Record<string, Json> = {};
    for (const e of edges) if (edgeValues.has(e.id)) inputs[e.targetPort] = edgeValues.get(e.id)!;

    // `{{ inputs.inN.path }}` expressions are substituted into ALL parameters (except expressions: false) before the block runs
    let params: Record<string, Json> = {};
    let paramsError: unknown;
    try {
      params = resolveParamExpressions(cls.params, resolveParams(cls.params, node.params), inputs);
    } catch (e) {
      paramsError = e;
    }
    await onEvent({ event: "node:start", nodeId: id, input: capRecord(maskHeaders(inputs) as Record<string, Json>), params: capRecord(maskSecrets(params) as Record<string, Json>) });
    // after the node finishes, its ctx.log is silent: code can live in the background and write after flow:done
    let live = true;
    let logged = 0;
    let displayText: string | undefined;
    try {
      const ctx: RunContext = {
        signal: runSignal,
        triggerData: id === opts.trigger ? opts.triggerData : undefined,
        call: (req) => performCall(id, req),
        ...(cls.bodyPort ? { runBody: (data: Json) => runBodyIteration(id, cls.bodyPort!, data) } : {}),
        breakLoop: opts.loopBreak,
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
      // after substitution the parameters are checked again, e.g. a number from an expression must be a number
      if (paramsError !== undefined) throw paramsError;
      // tools and memory attached to this node's resource ports
      const res = buildResources(flow, registry, id, inputs, ctx.log, runSignal);
      ctx.tools = res.tools;
      ctx.memory = res.memory;
      const issues = validateParams(cls.params, params);
      if (issues.length > 0) throw new Error(`Invalid parameters after resolving expressions: ${issues.map((i) => i.message).join("; ")}`);
      const raw = await new cls().run(inputs, params, ctx);
      if (runSignal.aborted) throw new Error("Aborted");

      const parsed = outputsSchema.safeParse(raw);
      if (!parsed.success) throw new Error("Block returned a non-JSON output");
      const output = parsed.data;
      // a result key that is not among the ports (typo, a rule outside Switch's ports, code without portsOverride) is an error,
      // not a silent "the branch did not go"
      const declared = new Set([...getNodePorts(cls, node.portsOverride, params).outputs.map((p) => p.id), ...cls.serviceOutputs]);
      const undeclared = Object.keys(output).filter((k) => !declared.has(k));
      if (undeclared.length > 0) {
        throw new Error(
          `The block returned data for ${undeclared.length > 1 ? "ports" : "port"} ${undeclared.map((k) => `"${k}"`).join(", ")} that ${undeclared.length > 1 ? "do" : "does"} not exist (output ports: ${[...declared].join(", ") || "none"}). Add the port to the node or fix the key`,
        );
      }

      for (const e of outgoing.get(id) ?? []) {
        const value = output[e.sourcePort];
        if (value !== undefined) edgeValues.set(e.id, value);
      }
      if (node.type === RESULT_TYPE) results.push([id, inputs["in0"] ?? null]);
      await onEvent({ event: "node:done", nodeId: id, output: maskHeaders(output) as typeof output, ...(displayText !== undefined ? { display: displayText } : {}) });
    } catch (e) {
      live = false;
      // another node has already failed (or the run was aborted); this one was aborted by it, so no extra messages
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
      // start everything that is ready; skipped nodes immediately determine their outputs ("empty"), which may unlock the next ones
      let progress = true;
      let heldBack = false;
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
          if (opts.gate?.paused) {
            heldBack = true;
            break;
          }
          unresolved.delete(id);
          const p: Promise<void> = execNode(id).finally(() => {
            resolved.add(id);
            running.delete(p);
          });
          running.add(p);
          progress = true;
        }
      }
      if (failure !== undefined || (running.size === 0 && !heldBack)) break;
      // while paused, also wait for the pause to be lifted/cancelled, not only for running nodes to finish
      await Promise.race([...running, ...(heldBack ? [opts.gate!.untilResumed(signal)] : [])]);
    }
    // after a failure give aborted nodes a moment to stop, but do not hang on them
    if (failure !== undefined && running.size > 0) await Promise.race([Promise.allSettled([...running]), new Promise((r) => setTimeout(r, 2000))]);
  } finally {
    signal.removeEventListener("abort", onOuterAbort);
  }
  if (failure !== undefined) {
    await finish({ error: failure });
    return;
  }
  results.sort((x, y) => (order.get(x[0]) ?? 0) - (order.get(y[0]) ?? 0)); // deterministic key order, as in sequential execution

  // one Result → its input as is; several → an object { nodeId: value }
  const result: Json | undefined =
    results.length === 0
      ? undefined
      : results.length === 1
        ? results[0]![1]
        : Object.fromEntries(results);
  await finish(result === undefined ? {} : { result });
}
