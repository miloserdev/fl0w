import type { Json, ParamSchema, PortsDef } from "@fl0w/schema";

export type FileWatchSpec = {
  /** A file or folder, relative to the files directory (`FL0W_FILES_DIR`). */
  path: string;
  event: "any" | "add" | "change" | "unlink";
  /** File name mask: `*` and `?`. */
  pattern: string;
  recursive: boolean;
};

/** Telegram Trigger subscription: Bot API polling (getUpdates) with one token shared by all subscribers. */
export type TelegramSpec = {
  /** Decrypted token: lives only in server memory, never reaches logs or responses. */
  token: string;
  /** Update types; "*" means all except chat_member, message_reaction, message_reaction_count (as in Telegram). */
  updates: string[];
  /**
   * polling: the server polls getUpdates itself (outgoing requests only); webhook: Telegram pushes updates
   * to the server address (instant, but needs a public https address).
   */
  mode: "polling" | "webhook";
  /** Public server address (FL0W_PUBLIC_URL, no trailing slash): used only in webhook mode. */
  publicUrl?: string;
  chatIds: string[];
  userIds: string[];
  dropPending: boolean;
};

/** Mail Trigger subscription: polls a mailbox. Holds the decrypted password: lives only in server memory, never reaches logs or responses. */
export type MailWatchSpec = {
  /** Connection parameters (provider, host/port/..., tenantId/clientId): the same as in the Mail block. */
  connection: Record<string, Json>;
  username: string;
  password: string;
  folder: string;
  unreadOnly: boolean;
  fromFilter: string;
  subjectFilter: string;
  /** Polling period, in seconds. */
  intervalSec: number;
  /** What to do with a message after the flow has run. */
  action: "none" | "markRead";
  /** Save attachments into the files directory (subfolder `attachmentsDir`). */
  saveAttachments: boolean;
  attachmentsDir: string;
  /** Process messages already in the mailbox at publish time (otherwise only new ones start the flow). */
  processExisting: boolean;
};

export type LifecycleReason = "publish" | "update" | "startup";
export type LifecycleSpec = Record<LifecycleReason, boolean>;

/** A tool attached to a node (a sub-node of kind tool): the owner calls it by name. */
export type ToolHandle = {
  name: string;
  description: string;
  /** Description of the arguments (a JSON Schema-like object): for hints and a future LLM agent. */
  inputSchema: Json;
  /** `signal`: cancellation of the owner's run; the tool code stops together with it. */
  call(args: Json, signal?: AbortSignal): Promise<Json>;
};

/** A memory bank attached to a node (a sub-node of kind memory): key -> JSON; the storage driver is hidden behind the interface. */
export type MemoryHandle = {
  name: string;
  driver: string;
  get(key: string): Promise<Json | null>;
  set(key: string, value: Json): Promise<void>;
  delete(key: string): Promise<boolean>;
  keys(): Promise<string[]>;
  /** Appends a value to the array under the key (creating it); `max` keeps only the last `max` items. */
  append(key: string, value: Json, max?: number): Promise<Json[]>;
  clear(): Promise<void>;
};

/** A request for an outgoing call to invoke a flow with an incoming phone on the channel `channelId` (see `RunContext.call`). */
export type CallRequest = {
  channelId: string;
  data: Json;
  /** await: wait for the result of the called flow; shoot: fire and forget. */
  mode: "await" | "shoot";
};

/** Call outcome: for shoot always `ok` (the fact of sending), for await the result of the called flow or the reason for refusal/failure. */
export type CallOutcome = { ok: true; result: Json } | { ok: false; error: string };

/** Outcome of one loop-body iteration: the body's Result value (null if there is no Result) and a request to stop the loop (Break) or an error. */
export type BodyOutcome = { ok: true; result: Json; broke: boolean } | { ok: false; error: string };

export interface RunContext {
  log(msg: string): void;
  signal: AbortSignal;
  /** Data the trigger of this node fired with (for example, a webhook request); other nodes have none. */
  triggerData?: Json;
  /** Tools and memory attached to this node's resource ports (the engine collects them before the run). */
  tools?: ToolHandle[];
  memory?: MemoryHandle[];
  /**
   * Call a flow over a channel (outgoing call). await: returns the called flow's result or an error; shoot: returns immediately,
   * the called flow runs "in the background" inside this same run and is aborted if the run ends earlier (this is logged).
   */
  call?: (req: CallRequest) => Promise<CallOutcome>;
  /**
   * Loop block only (`bodyPort`): run the loop body (the nodes reachable from its `body` port) once with the iteration data
   * (they come out of the `body` port). The engine runs the body in the same run; its node events are visible on the canvas.
   */
  runBody?: (data: Json) => Promise<BodyOutcome>;
  /** Inside a loop body: stop the nearest loop after the current iteration (the Break block). Outside a body: no effect. */
  breakLoop?: () => void;
  /** Output ports of this node that have edges connected (needed so an error is not lost if the `err` port leads nowhere). */
  connected?: string[];
  /** The flow and node currently being executed (for blocks that need their "own" identity, for example Counter). */
  flowId?: string;
  nodeId?: string;
  /** Show a short text on the node itself instead of the icon (up to 64 characters); goes into the `node:done` event. */
  display?: (text: string) => void;
}

/**
 * Base class of a block. Isomorphic: at module level there must be no node-only
 * or browser-only imports (they are allowed only inside the body of run).
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
   * Resource block (sub-node): does not take part in the data flow and does not run by itself, but is attached to a resource port
   * of the owner node: `tool` (a tool) or `memory` (a memory bank). null means a regular block.
   */
  static resource: "tool" | "memory" | null = null;
  /**
   * Decoration block (note, group): lives on the canvas and in the flow JSON but does not take part in a run: it does not start, receive
   * or emit data. The engine ignores such nodes.
   */
  static layout = false;
  /** The user sets the node size on the canvas (params.width/height, dragged by the corner): notes, groups, Log. */
  static resizable = false;
  /** Trigger: a node with no inputs that a run starts from (on a schedule or manually). */
  static isTrigger = false;
  /**
   * The trigger fires by itself (on a schedule or an incoming request), without a human.
   * A published flow without such triggers would never run, so publishing requires at least one.
   */
  static autoTrigger = false;
  /**
   * The trigger waits for an external event (webhook request, file, Telegram message, another flow's error, publication). In a manual run
   * such a trigger does NOT start: it has no real data, and made-up "example" data would start a chain with side effects.
   * Only the event itself (the scheduler) starts it.
   */
  static eventDriven = false;
  /**
   * A trigger raised ONLY by a call (incoming call <- outgoing call): neither a manual run (even with pinned
   * data), nor events, nor a schedule start it.
   */
  static callOnly = false;
  /** A trigger that can be started manually with a button on the node itself (Manual): ONLY it runs, the other triggers stay silent. */
  static manualStart = false;
  /**
   * Loop block: the id of the output port the loop BODY starts from (nodes reachable from it are run by the engine per
   * iteration, not in the main flow). null means a regular block.
   */
  static bodyPort: string | null = null;
  /**
   * Service keys of the `run` result that are not among the ports: they are read by the engine or host itself (Result emits `in0` for the feed,
   * Respond to Webhook emits `response` for the HTTP reply). Any other key outside the declared ports is a block error.
   */
  static serviceOutputs: readonly string[] = [];
  /** Ports that depend on parameters (for example, `err` only in await mode); null means use `ports`. */
  static portsFor(_params: Record<string, Json>): PortsDef | null {
    return null;
  }
  /** For file-system triggers: what to watch (a path relative to the files directory); null means not a file trigger. */
  static fileWatch(_params: Record<string, Json>): FileWatchSpec | null {
    return null;
  }
  /** For Mail Trigger: what to poll in the mailbox; null means not such a trigger. */
  static mailWatch(_params: Record<string, Json>): MailWatchSpec | null {
    return null;
  }
  /** For Telegram Trigger: a subscription to the bot's updates; null means not such a trigger. */
  static telegram(_params: Record<string, Json>): TelegramSpec | null {
    return null;
  }
  /**
   * For flow lifecycle triggers: which events to fire on: publication,
   * update of a published flow, server start; null means not such a trigger.
   */
  static lifecycle(_params: Record<string, Json>): LifecycleSpec | null {
    return null;
  }
  /** For the error trigger: which flows' errors to handle (an empty list means any); null means not such a trigger. */
  static errorScope(_params: Record<string, Json>): { flows: string[] } | null {
    return null;
  }
  /** For webhook triggers: which path and method to listen on; null means the node is not a webhook. */
  static webhook(_params: Record<string, Json>): { path: string; method: string } | null {
    return null;
  }
  /** For scheduled triggers: the firing period in ms; null means no schedule. */
  static intervalMs(_params: Record<string, Json>): number | null {
    return null;
  }
  /** d.ts of the environment for autocomplete in the code editor (only for blocks with an `editor: "code"` parameter). */
  static codeTypes = "";

  /**
   * When to run the node: `all` when ALL connected inputs are ready (default); `any` when at least one has arrived
   * (the other branches did not fire, for example after Branch). The block decides by its parameters (Merge).
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

/**
 * Data of the event the trigger fired with. A trigger is an entry point that has only a real event: there are no invented "examples"
 * (they could start a chain with side effects). Without data it is an error; to debug without an event, use pinning (pin).
 */
export function triggerPayload(ctx: RunContext, who: string): Json {
  if (ctx.triggerData === undefined) throw new Error(`${who} has no event data: it starts only from its event (or with pinned data in a manual run)`);
  return ctx.triggerData;
}
