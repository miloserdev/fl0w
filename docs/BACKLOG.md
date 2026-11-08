# BACKLOG — the orchestrator's work queue

A living document: the orchestrator takes tasks from the top down, updates statuses and adds what it finds along the way. Working rules are in `CLAUDE.md`.
Statuses: `todo` · `doing` · `blocked` (waiting for the owner) · `done`. Executor: an agent from `.claude/agents/` or "me" (the orchestrator).

## Owner decisions (awaiting an answer)

Tasks that depend on them are marked `blocked`. Each decision comes with the orchestrator's recommendation.

| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | **SSH** — remote commands on other machines | A — system `ssh` (keys/`ssh-agent`, `known_hosts`, allowlist of hosts); B — the `ssh2` library with a key in the parameters; C — an agent on the remote machine (pull model) | A, command execution only; command = executable + array of arguments (escaped), host list in `FL0W_SSH_HOSTS`; SFTP as a separate step |
| D2 | **Access model** for the editor and API (they have no authentication) | listen on `127.0.0.1` only; `FL0W_TOKEN` token (Bearer/cookie); both | both: `127.0.0.1` by default, a token is mandatory for external access |
| D3 | **Credential store** | encrypted file + master key in the environment; system keyring integration | encrypted file (AES-256-GCM, key `FL0W_MASTER_KEY`); blocks reference credentials by name, secrets do not end up in flows or logs |
| D4 | **WebSocket trigger** | client to someone else's socket; server for your own clients | depends on the scenario — needs the owner's answer |
| D5 | **Execute Workflow** (calling a flow from a flow) | contract: subflow input/output, Execute Workflow Trigger, recursion protection | do after D3; recursion is limited by depth |

## Queue

| P | Status | Task | Done criterion | Executor |
|---|---|---|---|---|
| P1 | blocked (D2) | Listen on `127.0.0.1` by default (`FL0W_HOST`), token for external access | `pnpm dev`/`start` are unreachable on an external address without a token; tests for the denial; docs | engine-dev → security-reviewer |
| P1 | todo | **Run history**: store the last N runs of a flow on disk (summary + events with limits), show a list in the UI and open a run | survives a server restart; size limits; the UI opens any run in the result panel; tests | engine-dev (storage/API) → ui-dev (list) |
| P1 | todo (confirm: previously excluded) | **Server flows in the UI**: `GET /api/flows` (list), a "Flows" menu (draft/published, open, delete, "New flow") | published flows from another browser can be found and opened; deleting unpublishes; API tests | engine-dev + ui-dev |
| P2 | todo | Blocks: **GraphQL** (HTTP wrapper), **TOTP**, **Split In Batches** (chunks), **Debug Helper**, **Execution Data** | one `block-builder` per block, up to 3 in parallel; shared files (`registry.ts`, `index.ts`, dictionaries, `block-icon.tsx`, `BLOCKS.md`) — the orchestrator after the wave | block-builder × N → qa-verifier |
| P2 | todo | Blocks with dependencies: **HTML** (cheerio), **XML** (fast-xml-parser), **Markdown** (marked), **RSS** | `researcher` first (native modules/pnpm build scripts are forbidden, size); dependencies are loaded dynamically inside `run` | researcher → block-builder |
| P2 | todo | **Test reliability**: run the file watcher and scheduler tests 20×, find flaky tests, stabilize them | 20 consecutive runs without failures | qa-verifier |
| P2 | todo | **Runner cold start**: ~0.4 s on `tsx`; bundle the runner into a single JS file + cache | launching `Source → Result` is twice as fast; behavior and tests unchanged; dev mode picks up block changes | engine-dev |
| P2 | **done** | **Parallel branches**: independent nodes run simultaneously (limit 16, a failure of one aborts the rest, wait-all/any preserved) | — | me |
| P2 | todo | **Monaco locally** (no CDN) | the editor works without internet; workers are built by Next | ui-dev |
| P3 | todo | UX: short parameter caption on the node (like the subtitle in n8n), copying/duplicating nodes | checked with `ui-check`, ru/en dictionaries | ui-dev |
| P3 | todo | Observability: server log to a file with rotation, run counters | does not grow without bound; tests | engine-dev |
| P3 | blocked (D1) | SSH block | see D1 | block-builder → security-reviewer |
| P3 | blocked (D3) | Credentials + HTTP Request with authorization | see D3 | engine-dev + ui-dev → security-reviewer |

## Ideas from an external review (n8n pain points) — analysis

| # | Idea | State | Decision |
|---|---|---|---|
| I1 | Input/output on every node | **exists**: the "Data" tab (input, parameters, output, log, error) | — |
| I2 | Pin data (pin a node's output for debugging) | **done** (`node.pinData`, manual runs only, JSON editor) | — |
| I3 | Step-by-step execution, re-run from a selected node | re-run **done** (`from`+`seeds`, the "Run from here" button); step-by-step mode (one node at a time) — todo | P1: "next step" on top of `from` |
| I4 | Git-native: stable order and ids | partial (zod schema, ids are assigned by the editor) | P2: sort nodes/edges and keys on save, a "save→load→save yields the same text" test |
| I5 | Maintainability: groups/subflows, node search, notes, minimap | minimap exists | P2: notes (comment block), search (Ctrl+K), groups; subflows — after D5 |
| I6 | Error port and retries on a node | Error Trigger exists at the flow level | P1: a common node parameter `retries/retryDelay` and an optional error output (`onError: stop|continue|port`) |
| I7 | `require`/npm in Code | **no, needs the owner's decision** (trust model, architecture rule 5) | D6 |
| I8 | Avoid: hidden data loss in loops, silent webhook failures | no loops (DAG); webhook failures | P2: audit of `/api/hooks` responses and the journal (a run error is visible in Watch and the log) |

D6 (awaiting the owner): should Code be allowed `require`/npm? Recommendation — no by default; optionally an allowlist of modules via `FL0W_CODE_MODULES` and a separate process without the `vm` boundary.

## Findings of the data-flow review (open)

| # | Finding | Status |
|---|---|---|
| R1 | **Secondary substitution**: a value substituted by `{{ inputs… }}` then passes through `{{ path }}` once more in the block (set, telegram, files, shell args/env/stdin, respond, jwt, stop_and_error) — external text `{{ secret }}` turns into a read of an input field. A decision on the template model is needed (escape substituted values or a single pass) | **blocked: owner's decision** (recommendation — escape the substituted value, `\{{` for a literal) |
| R2 | `{{ path }}` does not work in `url/body/headers` of HTTP Request, `cwd` of Shell, `headers` of Respond to Webhook | todo |
| R3 | `null` from an expression yields `"null"` in Shell `args/env/stdin`, headers, `stop_and_error.message` — a single text helper | todo |
| R4 | `crypto.secret`, `jwt.secret` — literals in the flow; wire up `resolveSecret` (`env:FL0W_SECRET_*`) | todo |
| R5 | a "block → parameters → mechanism" table in `docs/BLOCKS.md` | todo |

Done: a numeric string in `datetime` is epoch ms; a "whole" expression with a nonexistent path gives a clear error; the `authorization/cookie/x-api-key` headers are masked in events.

## Decisions made (log)

- **Resource ports (tools/memory) and Code Agent** — at the owner's request, modeled on the AI Agent sub-nodes in n8n (architecture rules in `CLAUDE.md`). Instead of a model there is a node with code; the model will be added as a third kind of resource (`model`). The memory bank is a single `memory_bank` block with a `driver` parameter (currently `json`); new drivers go in `MEMORY_DRIVERS`.
- **A run starts from the start nodes** (triggers; without triggers — data sources). A node with no connection to a start does not execute.
- **Publishing** requires at least one automatic trigger (`autoTrigger`: Every, Webhook, Local File, Error, Activation, Workflow); the server copy of the flow is what runs.
- **Shell is disabled by default**, enabled by `FL0W_ALLOW_SHELL=1`; the script is not templated; the command's environment is trimmed. (architecture rule 5)
- **Files** — only inside `FL0W_FILES_DIR`; symlinks leading outside are rejected.
- **n8n expressions are replaced by `{{ path }}` templates** with no code execution. A "whole" template is the entire string without outer whitespace.
- **Error Trigger** accepts errors only from automatic runs; running the handler does not produce an error chain; the message of the node itself is passed.
- **Webhooks without authentication** — for local/trusted use; limits: 1 MB body, 8 parallel runs.
- **Git**: commits are authored by Claude, unsigned, via `scripts/commit.sh`; the owner's global config is not touched.
- **Secrets are references to environment variables** `env:FL0W_SECRET_*` (only this prefix): the token does not live in the flow and does not end up in logs/errors/the feed. This is an interim decision until D3 (a full store).
- **Telegram Trigger has two modes**: `polling` by default (outgoing requests only, one poll per token, queue of 500) and `webhook` at the owner's request (needs `FL0W_PUBLIC_URL`; expose only `/api/telegram/*` outward, since the editor has no authentication — D2). The webhook key and secret are derived from the token via HMAC; modes cannot be mixed on one token.
- **Expression in a string parameter**: a "whole" `{{ inputs.inN.path }}` with a number/boolean/object is coerced to a string (chat id is a number); numeric and boolean parameters keep their type.
- **A manual run does not start event triggers** (`eventDriven`: Webhook, Local File, Telegram, Error, Activation, Workflow): they have no real data, and made-up "example" data started chains with side effects. What remains are Manual, Every and sources; if the flow contains only event triggers, there is a clear error. They are started by an event (the scheduler).
- **Waiting for inputs**: wait-all by default (architecture rule 1); Merge got a `wait: all|any` parameter via `Block.waitMode()` — `any` runs the node on the inputs that have arrived (the graph is a DAG, a node runs after all its predecessors, so this means "those that arrived").
- **Sandbox ≠ production**: "Run" (including "Run from here", pin data) works on the saved copies and in a separate memory (`_sandbox`), does not write to Watch/Error Trigger of working flows; Run Flow from the sandbox does not start published copies. A published flow calls only published ones. External effects are not isolated.
- **Call pair (calling a flow from a flow)**: the `run_flow`/`call_trigger` blocks (types preserved, labels Outgoing Call/Incoming), linked by `channelId` 1:1, modes `await`/`shoot`; the called flow is a nested run in the caller's runner (hence depth ≤ 20, "0 = unlimited" removed); an incoming call is started by nothing except a call; the runner does not wait for shoot calls and aborts them on completion (`node:killed`). The old `flowId/triggerId` parameters are no longer used — existing nodes need a `channelId` set.
- **Parallel execution**: a node starts as soon as all its inputs are determined; independent branches and unconnected graphs of one flow run simultaneously (Wait/HTTP delay only what depends on them), limit of 16 nodes; when one fails the rest are aborted without extra `node:error`; the key order of the result is topological. CPU-bound blocks (Code with a synchronous loop) still block the process — it is a single thread.
- **Recursion is forbidden, repetition is Loop** (owner's decision): Emitter and Collector cannot be in the same graph (connected component), so a called graph calls nobody — there are no call chains/cycles; `allowRecursive`/`maxDepth` removed. Cost: a called graph does not call anything itself (no chains); if they are needed, allow chains without cycles as a separate decision.
- **Loop is separate logic, not calls**: the `loop` block with outputs `out0` (done) and `body` (iteration); the body is the nodes from `body`, executed by the engine (a nested run of a "scope" on the same flow), modes items/count/while/forever, Break, a `maxIterations` limit; the graph stays a DAG.
- **Node shape**: start nodes (have an output, no input) have the left side rounded at 24px, final ones (input without output) the right side.
- **Conditional parameter visibility** (`showWhen`) — a general schema facility, like `displayOptions` in n8n; hidden parameters are not required and not validated.
- **Skipped deliberately**: Loop Over Items (the graph is a DAG), binary nodes, other integrations with external accounts (need D3), Telegram *Send and Wait for Response*.

## Process log

- Introduced `CLAUDE.md`, six agents, `scripts/` (`commit.sh`, `ui-check.mjs`, `shadcn-add.mjs`), the `pnpm check` / `pnpm verify` commands.
