# FL0W blocks

Reference for the built-in FL0W blocks. The source of truth is the classes in `packages/blocks/src`
(metadata: `type`, `ports`, `params`); the registry is `packages/blocks/src/registry.ts`.

## How it works

- **One JSON per port.** The array plays the role of n8n's "items": blocks that work "over a list" accept an array (a
  single value is treated as a list of one element).
- **Empty output — the branch does not run.** If a block does not return a port key, downstream nodes on that branch are not started
  (this is how Branch, Switch, Filter and Compare Datasets work: an empty output receives no data).
- **Wait-all.** A node starts when data has arrived on all of its *connected* inputs.
- **A run starts from start nodes.** If the flow has triggers, from them; otherwise from data sources
  (blocks without inputs, `Source`). The start nodes run, along with everything reachable from them and everything that feeds
  the reachable part (for example, a `Source` on the second input of `Compare Datasets`). A node not connected to a start does not run, even
  if it has no connected inputs; after a run the interface shows it as "skipped".
- **One edge per input.** `Merge` combines several branches.
- **Paths** are dot-separated: `user.name`, `items.0.price`. An empty path is the value itself.
- **`{{ path }}` templates** replace n8n expressions and do not execute code. A string consisting of a single template keeps the type
  of the value (`"{{ n }}"` → a number); inside text the value is converted to a string. `{{ . }}` is the whole object.
  Templates are supported by: Edit Fields, Date & Time, Crypto, JWT, Respond to Webhook, Stop and Error.
- **`{{ inputs.<port>.<path> }}` expressions** give the data of previous nodes in **any** parameter of any block (like `$json` in n8n):
  `{{ inputs.in0.user.name }}`, `{{ inputs.in0.items.0.id }}`; for nodes with several inputs, `{{ inputs.in1.field }}`;
  `{{ inputs }}` is all inputs. The engine substitutes them before the block runs: a string consisting of a single expression keeps its type
  (number, object, array); inside text the value is converted to a string; no value — `null` / an empty string. For numeric, boolean and
  list parameters the form has a `{ }` button that switches to expression mode. After substitution the parameters are validated
  again ("`n` must be a number"). Parameters with `expressions: false` are not substituted — the `Code` block's code and the `Shell`
  script (data is passed to the script through `args`/`env`). The relative `{{ field }}` templates from the section above are still substituted by the blocks
  themselves (per list item), so `{{ field }}` and `{{ inputs.in0.field }}` are different things: the first refers to the current item, the second to the whole input.
- **User code runs only in the `Code` block** (see the architecture rules in `CLAUDE.md`): in `vm`, with an `env` allowlist
  and a timeout. All other blocks are declarative.

## Triggers and publishing

| Block | Fires | Automatic |
|---|---|---|
| `manual` — Manual Trigger | on a manual run (Run button) | no |
| `every` — Every | every N seconds/minutes/hours | yes |
| `webhook` — Webhook | on an HTTP request to `/api/hooks/<path>` | yes |
| `local_file_trigger` — Local File Trigger | when a file is added, changed or deleted in the files directory | yes |
| `error_trigger` — Error Trigger | when an automatic run of another flow fails | yes |
| `activation_trigger` — Activation Trigger | on publish, on update of a published flow, on server start | yes |
| `workflow_trigger` — Workflow Trigger | on publish and update (as in n8n, without server start) | yes |

A manual run (Run) fires **all** triggers of the flow at once. A scheduled run and a webhook start only from their own
trigger; the other triggers stay silent in that run.

**Publishing** (Publish) saves the flow on the server (`apps/web/.data/flows`, variable `FL0W_DATA_DIR`)
and enables its automatic triggers: the server runs the flow whether or not the page is open. At least one
automatic trigger is required. The server copy is what runs — local edits take effect after
Update. Each run is a separate process; a scheduled tick is skipped if the previous run is still going.
**Watch** mode shows the runs of a published flow in real time (the last run is replayed
on connect).

### Files, errors, lifecycle

- **Local File Trigger** watches a file or folder inside the files directory (`path`, `event` any/add/change/unlink,
  a name mask `pattern` with `*` and `?`, `recursive`). Output: `{ event, path, name, size, modifiedAt }` (a deleted file
  has no size or time). A burst of quick writes collapses into one firing; files that existed before publishing
  produce no events. Events are subject to the same concurrent-run limit as webhooks (extra ones are skipped).
- **Error Trigger** starts a handler flow when an **automatic** run (schedule, webhook, file,
  activation) of a published flow fails. `flows` is the ids of the flows whose errors to accept (empty — any, including this very flow).
  Output: `{ flow: {id, name}, run: {id, trigger}, error: {message, node}, at }`. Manual runs from the editor do not
  get here, and a failure of the handler itself does not start new handlers (there is no error chain). The `Stop and Error` block
  is handy for sending your own messages to the handler.
- **Activation Trigger** fires on events of *this* flow: `onPublish` — first publish, `onUpdate` — update of an already
  published flow, `onStartup` — server start (restart). Output: `{ event, at, flow: {id, name} }`.
  **Workflow Trigger** is the same without server start (in n8n this node is deprecated in favor of Activation Trigger).

### Webhook

`POST|GET|PUT|PATCH|DELETE|ANY /api/hooks/<path>`. The block outputs the request:

```json
{ "method": "POST", "path": "demo/orders", "query": { "a": "1" }, "headers": { "content-type": "…" }, "body": { } }
```

Body: `application/json` → object, `application/x-www-form-urlencoded` → object, otherwise text. Repeated
query parameters are collected into an array. Body limit is 1 MB (`413`), concurrent webhook runs — 8 (`429`).
The path is unique among published flows (`409` on conflict).

`respond`: `onReceived` — immediately `200 {"message":"Workflow was started"}`, the flow continues in the background; `whenFinished` — the response
comes after completion: **Respond to Webhook**, otherwise the **Result** result, otherwise `500` if the flow failed.

> Webhooks are not protected by authentication — this is a decision for local and team (trusted) use.

## Reference

Ports: `in` / `out`. "List" is the value at `path` (empty — the input).

### Triggers

| Block | Ports | Parameters |
|---|---|---|
| **Manual Trigger** `manual` | — / out0 `{triggeredAt}` | — |
| **Every** `every` | — / out0 `{triggeredAt}` | `interval` (≥ 1), `unit`: seconds, minutes, hours |
| **Local File Trigger** `local_file_trigger` | — / out0 file event | `path`, `event`, `pattern`, `recursive` |
| **Error Trigger** `error_trigger` | — / out0 error data | `flows` |
| **Activation Trigger** `activation_trigger` | — / out0 `{event, at, flow}` | `onPublish`, `onUpdate`, `onStartup` |
| **Workflow Trigger** `workflow_trigger` | — / out0 `{event, at, flow}` | `onPublish`, `onUpdate` |
| **Telegram Trigger** `telegram_trigger` | — / out0 Update object | `token`, `mode`, `updates`, `chatIds`, `userIds`, `dropPending` |
| **Webhook** `webhook` | — / out0 request | `path`, `method`, `respond` |

### Apps

| Block | Ports | What it does |
|---|---|---|
| **Telegram** `telegram` | in0 / out0 | 23 Bot API operations as in n8n: chats, messages, files, replies to callback/inline queries — see "Telegram" below |

### Input / output

| Block | Ports | Parameters |
|---|---|---|
| **Source** `source` | — / out0 | `json` |
| **HTTP Request** `http_request` | in0 / out0 | `method` GET/POST, `url`, `headers`, `body` (empty — input), `timeoutMs` |
| **Respond to Webhook** `respond_to_webhook` | in0 / — | `status`, `body` (empty — input; templates), `headers` |
| **Read/Write Files** `files` | in0 / out0 | `operation` read/write/append/list, `path` (templates; mask `* ? [] **` for read and list), `format` text/json/base64, `content`, `createDirs`, `overwrite` |
| **Shell** `shell` | in0 / out0 `{stdout, stderr, exitCode, signal}` | `script`, `args`, `env`, `stdin`, `cwd`, `shell` bash/sh, `timeoutMs`, `failOnError` — **disabled by default** |
| **Notification** `notify` | in0 / out0 (input unchanged) | `title`, `message` (empty — whole input), `urgency` low/normal/critical, `icon` (theme name), `appName`, `timeoutMs` — a desktop notification via `notify-send` |
| **Atlassian** `atlassian` | in0 / out0 API response | `baseUrl`, `auth` form/basic/session/bearer, `username`, `password` (`env:FL0W_SECRET_…`), `operation` searchIssues/getIssue/createIssue/updateIssue/addComment/transitionIssue/request, `apiVersion`, operation fields — Jira Server/DC and Cloud |
| **Mail** `mail` | in0 / out0 operation result | `provider` imap/graph, `operation` sendMail/listMail/getMail/markMailRead, `host`/`smtpHost`/… or `tenantId`/`clientId`, `username`, `password`, operation fields — mail not tied to a particular service |
| **Mail Trigger** `mail_trigger` | — / out0 message `{id, from, to, cc, subject, date, unread, text, html, attachments, folder}` | `provider`, connection, `folder`, `unreadOnly`, `fromFilter`, `subjectFilter`, `intervalSec` (15…3600), `action` markRead/none, `processExisting`, `saveAttachments` — fires on every new message |
| **Result** `result` | in0 / — | — |

### Data

| Block | Ports | What it does | Parameters |
|---|---|---|---|
| **Transform** `transform` | in0 / out0 | map / filter of a list | `mode`, `path`, `fields`, condition |
| **Edit Fields** `set` | in0 / out0 | sets, overwrites, removes fields; an array is processed per item | `fields` `{path: value\|template}`, `keepOnlySet`, `remove` |
| **Filter** `filter` | in0 / out0 kept, out1 discarded | splits a list by a condition | `path`, `field`, `operator`, `value` |
| **Sort** `sort` | in0 / out0 | stable sort or shuffle | `path`, `mode` simple/random, `fields` (`"a"` or `{field, order}`), `order` |
| **Limit** `limit` | in0 / out0 | first/last N | `path`, `count`, `keep` |
| **Remove Duplicates** `remove_duplicates` | in0 / out0 | removes duplicates, keeping the first | `path`, `compare` all/fields, `fields` |
| **Aggregate** `aggregate` | in0 / out0 | list → one object | `mode` fields/all, `fields` (`"a"` or `{field, as}`), `mergeLists`, `keepMissing`, `into`, `include`, `fieldsList` |
| **Split Out** `split_out` | in0 / out0 | array from a field → items | `field`, `include` none/all/selected, `fieldsToInclude`, `into` |
| **Summarize** `summarize` | in0 / out0 | summary like a pivot table | `aggregations` `[{field, op, as, separator}]`, `groupBy` |
| **Rename Keys** `rename_keys` | in0 / out0 | renames fields | `keys` `{old: new}` (a dotted path — nested field) |
| **Date & Time** `datetime` | in0 / out0 | now, format, add, subtract, diff, extract, round (UTC) | `operation`, `value`, `unit`, `amount`, `format`, `part`, `other`, `direction`, `field`, `includeInput` |
| **Crypto** `crypto` | in0 / out0 | hash, hmac, generate, encrypt/decrypt (AES-256-GCM) | `action`, `value`, `algorithm`, `encoding`, `secret`, `kind`, `length`, `field`, `includeInput` |
| **JWT** `jwt` | in0 / out0 | sign / verify / decode (HS256/384/512) | `operation`, `secret`, `algorithm`, `payload`, `expiresInSeconds`, `token` |
| **Code** `code` | in0 / out0 | user JS | `code`, `timeoutMs` |

Condition operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `exists`, `truthy`.
`summarize` operations: `count`, `countUnique`, `sum`, `average`, `min`, `max`, `append`, `concatenate`.
Date format: tokens `YYYY MM DD HH mm ss SSS`; empty — ISO 8601. Dates without a time zone are treated as UTC.

### Logic

| Block | Ports | What it does | Parameters |
|---|---|---|---|
| **Branch** `branch` | in0 / out0 true, out1 false | a single condition | `field`, `operator`, `value` |
| **Switch** `switch` | in0 / out0…out3, fallback | up to 4 rules, the first match or all | `field`, `rules` `[{field?, operator, value}]`, `mode` first/all |
| **Merge** `merge` | in0…in3 / out0 | combines inputs | `wait` all/any, `mode` array/object/assign/concat |
| **Compare Datasets** `compare_datasets` | in0 A, in1 B / A only, same, different, B only | comparison by key | `fieldA`, `fieldB`, `skip`, `fuzzy`, `resolve` a/b/both |
| **Wait** `wait` | in0 / out0 | pause (up to 5 minutes — the run limit) | `amount`, `unit` |
| **Stop and Error** `stop_and_error` | in0 / — | stops the run with an error | `errorType`, `message`, `errorObject` |
| **No Operation** `noop` | in0 / out0 | passes data through | — |

## What is missing compared with n8n — and why

| n8n | Decision |
|---|---|
| SSH | commands on other machines: requires credentials and host verification; no decision yet |
| Execute Command | available as **Shell**, but disabled by default (see "Environment and security") |
| Loop Over Items (Split In Batches) | covered by the **Loop** block (a body subgraph, `items`/`count`/`while`/`forever`, **Break**); the graph itself stays a DAG |
| Compression, Convert to File, Extract from File, Edit Image | there is no binary data in the "one JSON per port" model |
| Send Email | covered by **Mail** (SMTP or Microsoft Graph); the password is a parameter or an `env:FL0W_SECRET_…` reference |
| FTP, Git, LDAP, RSS | require external credentials; there is no credentials store |
| `{{ $json… }}` expressions | replaced by `{{ path }}` templates with no code execution |
| Time zones in Date & Time | everything is UTC |

## Telegram

Two blocks, as in n8n: **Telegram** (bot actions) and **Telegram Trigger** (receiving updates).

**Token.** Get it from @BotFather. It is better not to store it in the flow: in the `token` field give a reference to a server environment
variable `env:FL0W_SECRET_<NAME>` (only variables with the `FL0W_SECRET_` prefix are read), for example
`FL0W_SECRET_TELEGRAM_BOT_TOKEN=123456:ABC… pnpm dev`. An empty `token` field means exactly this variable. The token is always hidden
in error messages, logs and the run feed. A literal is also accepted (the `123456:AA…` format is checked), but then it sits
in the flow in plain text.

**Telegram — operations** (in the "Operation" list they are grouped by n8n resources):
Chat: `getChat`, `getChatAdministrators`, `getChatMember`, `leaveChat`, `setChatDescription`, `setChatTitle` ·
Callback: `answerCallbackQuery`, `answerInlineQuery` · File: `getFile` (with `download` — the content in base64 and, with `saveTo`,
saved to the files directory) · Message: `deleteMessage`, `editMessageText`, `pinChatMessage`, `unpinChatMessage`, `sendAnimation`,
`sendAudio`, `sendChatAction`, `sendDocument`, `sendLocation`, `sendMediaGroup`, `sendMessage`, `sendPhoto`, `sendSticker`, `sendVideo`.
Form fields depend on the operation (conditional visibility). Chat, text, ID and the like support `{{ path }}` from the input — after Telegram Trigger:
`chatId = {{ message.chat.id }}`. `replyMarkup` is Bot API JSON (`inline_keyboard`, `keyboard`, …). Any other method parameters go
in `additional` (snake_case; the fields you set do not override them). The result is the `result` of the Bot API response (a message object, etc.),
and `{ ok: true }` for a `true` response.

**Files to send:** `file_id`, an HTTP link or `file:path` — an upload from the files directory (`FL0W_FILES_DIR`, up to 50 MB,
multipart). In `sendMediaGroup` the items can be any of these forms (`attach://` is filled in automatically).

**Telegram Trigger** starts a flow on bot updates. There are two ways to receive them (`mode`):

- `polling` (default) — the server polls `getUpdates` itself (long polling), outgoing requests only, nothing needs to be published;
- `webhook` — as in n8n: on publish `setWebhook` is called, and Telegram delivers updates instantly to
  `<FL0W_PUBLIC_URL>/api/telegram/<key>`. The key and the secret header `X-Telegram-Bot-Api-Secret-Token` are derived from the token
  one-way (the token is not in them); the request is checked in constant time, repeated `update_id`s are dropped, body ≤ 1 MB.
  The `FL0W_PUBLIC_URL` variable is required (the server's public **https** address, with no path or query; without it publishing returns 409). When
  a flow is unpublished the webhook is removed (`deleteWebhook`). **Expose only the `/api/telegram/` path to the outside (through a reverse proxy)**:
  the editor and API are not authenticated (decision D2 in `docs/BACKLOG.md`).

A bot can use only one mode at a time: a second trigger with a different `mode` is ignored (a log entry). Types — `updates`
(a list of checkboxes; `*` — all except `chat_member`, `message_reaction`, `message_reaction_count`, as in Telegram); restrictions by
chats and users — `chatIds`, `userIds`; `dropPending` discards what accumulated during downtime. Several triggers with the same
token share one poll / one webhook. In polling mode updates are not lost (a queue of up to 500, runs in order), and unprocessed ones
survive a server restart. In polling mode the bot must not have an active webhook (`409 Conflict` — a hint appears in the log).

What is missing compared with n8n: *Send and Wait for Response* (needs a flow pause and a public webhook) and receiving files/images in the trigger
(`Download Images/Files`) — a file is downloaded by a separate `getFile` step with `download`. The API address can be changed with the
`FL0W_TELEGRAM_API` variable (your own Bot API server); the real Telegram is never called in tests.

## Environment and security

| Variable | Purpose | Default |
|---|---|---|
| `FL0W_FILES_DIR` | the only directory accessible to the Files blocks, Local File Trigger and the Shell working folder | `apps/web/.data/files` |
| `FL0W_ALLOW_SHELL` | `1` / `true` enables the Shell block | not set — Shell is disabled |
| `FL0W_DATA_DIR` | where published flows are stored | `apps/web/.data/flows` |
| `FL0W_MEMORY_DIR` | memory banks (Memory Bank, Counter) | `apps/web/.data/memory` |
| `FL0W_PUBLIC_URL` | the server's public https address (Telegram webhooks) | not set |
| `FL0W_SECRET_*` | secrets that parameters can reference as `env:FL0W_SECRET_…` (Telegram token, etc.) | not set |
| `FL0W_TELEGRAM_API` | Bot API address | `https://api.telegram.org` |

Running with Shell: `FL0W_ALLOW_SHELL=1 pnpm dev`.

**Why Shell is disabled.** The editor and API are not protected by authentication: whoever can reach the port can publish a flow with
a Shell block. Enable the variable only on a machine that only you can access (or behind authentication at the
proxy/network level). What has been done for the safety of the block itself:

- the script is not templated — data is passed in `args` (these are `$1`, `$2`…), `env` and `stdin`, so `{{ input }}` cannot
  turn into a command;
- the server environment (tokens, keys) is not passed to the command — only `PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`, `TERM` and what is set in `env`;
- execution happens in the files directory, with a timeout (30 s by default, 5 min maximum), output up to 1 MB, and on timeout or run cancellation
  the whole process group is killed;
- file blocks do not escape `FL0W_FILES_DIR`: absolute paths, `..` and symlinks pointing outside are rejected.

Shell still executes arbitrary commands with the privileges of the user the server runs as.

## Adding a block

A class in `packages/blocks/src` plus a line in `registry.ts`. For the UI you need translations in `apps/web/messages/{ru,en}.json`
(`blocks.<type>`, `params.<type>.<param>`, `paramOptions.<param>.<value>`, `ports.<type>.<port>` for labeled ports)
and an icon in `block-icon.tsx`; the `messages.test.ts` test will tell you what is missing.

## Node data from the last run (window on the right)

A separate **Node data** window on the right, below the overall run result, shows the last run of the selected node (manual or from Watch): input, parameters after
expression substitution, output, log and error. The source is `node:start` (`input`, `params`) and `node:done/error`. Values larger than
50,000 characters are truncated; values of parameters named `token`, `secret`, `password`, `api key`, `authorization`, `cookie` are masked
(`***`; `env:` references stay). Data of nodes the new run has not reached yet is not erased; it is reset when the flow is cleared (import).

## Code Agent, tools and memory bank

Modeled on the AI Agent in n8n: the host node has **resource ports** (diamonds) at the bottom, to which **sub-nodes** are connected with dashed lines — round
resource nodes with a port on top. For now, instead of a language model there is a node with your code; a model can be added later as a third kind of resource.

| Block | Kind | Purpose |
|---|---|---|
| **Code Agent** `code_agent` | host | Like Code, plus `tools`, `memory`, `memories` in the code. Ports: `in0` (data), `tools` (tools, multiple), `memory` (memory, multiple), `out0` |
| **Date & Time Tool** `tool_datetime` | tool | `current_datetime({timezone?})` → `{iso, date, time, weekday, timezone, utcOffset, unix}`; the time zone is an IANA name |
| **Calculator Tool** `tool_calculator` | tool | `calculator({expression})` → `{expression, result}`; `+ - * / % ^ **`, parentheses, `sqrt abs round floor ceil trunc min max pow sin cos tan ln log exp`, `pi`, `e`; no `eval` |
| **Random Tool** `tool_random` | tool | `random({kind: int\|float\|uuid\|pick, min, max, items})` → `{value}` (cryptographically secure source) |
| **Code Tool** `tool_code` | tool | Your own tool: `name`, `description`, `inputSchema`, code (arguments — `inputs.in0`, result — `out0`), the same `vm` sandbox as Code |
| **Memory Bank** `memory_bank` | memory | A "key → JSON" bank; `driver` (currently `json`: file `<FL0W_MEMORY_DIR>/<name>.json`) and `name`. Banks with the same name are one store |

Code Agent code:

```js
tools.list()                                        // [{ name, description, inputSchema }]
const t = await tools.call("current_datetime", { timezone: "Europe/Berlin" })
await tools.run.calculator({ expression: "2 * (3 + 4)" })   // short form
await memory.set("visits", n)                       // memory — the first connected bank
await memory.get("visits")                          // null if there is no key
await memory.append("history", item, 20)            // append to an array, keep the last 20
await memory.keys(); await memory.delete("k"); await memory.clear()
memories.notes.get("x")                             // banks by name
```

Rules:
- **Resource edges are not part of the data flow**: they do not affect ordering, input waiting or cycles; sub-nodes do not run on their own and do not count as start nodes.
  Only ports of the same kind connect (data / `tool` / `memory`), otherwise the error is `port_kind`. A port without `multiple` accepts one edge.
- Sub-node parameters support `{{ inputs.in0.path }}` — over the **host's inputs**. A tool name is an identifier (`[A-Za-z_][A-Za-z0-9_]*`, ≤ 64), unique within one host.
- Every tool call is written to the host's log (`tool name(arguments) → result`, truncated) — the Data tab and the result panel.
- A tool or memory error is an exception in the code (it can be caught with `try/catch`); an uncaught one is a node error.
- Memory: a key is a string of 1–256 characters (`__proto__` is forbidden); a value ≤ 1 MB, keys ≤ 10,000, file ≤ 10 MB. A write is atomic (temp file + `rename`),
  between runner processes there is a lock file (a stale one is cleared after 15 s); a corrupted file is not overwritten but raises an error. A bank name is `[A-Za-z0-9_-]{1,64}`.
- The banks directory is `FL0W_MEMORY_DIR` (default `apps/web/.data/memory`, in `.gitignore`). New drivers (SQLite, Redis…) are added to `MEMORY_DRIVERS`,
  and the wiring to blocks does not change.
- Security: resources reach the code only through a string bridge (like `fetch`), host objects are not exposed; `tools`/`memory` are frozen; the code of Code Agent and Code Tool is `expressions: false`.

## Pin data and restarting from a node

- **Pin data.** In the Node data window (on the right below the overall run result; it appears when a node is selected, parameters and code are edited in the window on the left) there is a "Pin output" button (or "Set data manually…" — JSON `{ port: value }`). In a **manual** run
  a pinned node is not executed and returns this data (the log says "pinned data used"); a pinned node on the canvas shows a pin icon. Pins are stored in the flow
  (`node.pinData`) but do not change whether a published flow counts as modified and **do not apply in scheduled runs** of a published flow — those use real data.
  An event trigger (Webhook, Telegram, Local File…) with pinned data **starts** in a manual run: the pinned "request" replaces the real event.
  Pinned data sits in the flow JSON (and in git) — do not pin secrets.
- **Run from here.** The selected node and everything after it are executed; the predecessors it needs do not run but supply pinned data or the output from the
  last run (the log says "data from the previous run used"). If there is no data, the error is `No saved data for node "…"` and a full run is needed. API: `POST /api/run`
  `{ flow, from, seeds }`; in the engine — `RunOptions.from` / `seeds`.

## Notes, groups and calling a flow from a flow

- **Sticky Note** `note` and **Group** `group` are canvas decoration (the Layout category): text/title, color, size (`width`/`height`, resized by the corner).
  A group lies under the blocks; moving it moves the blocks whose centers lie inside the frame. The engine ignores them (they neither run nor count as "skipped"), and editing them does not
  change whether a published flow counts as modified.
- **Emitter** `run_flow` (outgoing call) / **Collector** `call_trigger` (incoming call) — calling one flow from another over a **channel** `channelId`, strictly 1:1 (inside one process: the called flow
  runs as a nested run in the caller's runner).
  - The Emitter's **`mode`** parameter — one block with a switch:
    - **`await`** (with acknowledgment, default): the caller waits; `out0` is the result of the called flow (the value of its Result, `null` if there is no Result); the **`err`** port (visible only
      in this mode) carries the called flow's error `{ message, channelId }`. If nothing is connected to `err`, the error fails the node itself (nothing is lost silently).
    - **`shoot`** (fire and forget): the caller does not wait; `out0 = { ok: true }` — the fact of sending, not the result; there is no `err` port. The runner **does not wait** for such calls: if the main
      flow finished while the called one is still running, it is aborted (`node:killed`, no guarantee it completes). A failure/abort of the called flow is written to the feed (`node:error` /
      `node:killed` on the calling node) and does not affect the caller.
  - **Validator:** a channel has at most one incoming and one outgoing end — within a flow and across saved flows (on save the server responds 400 `call_channel`). A pair may
    appear later (the caller is created first).
  - **Collector is not a start trigger:** neither a manual run (even with pinned data), nor events, nor a schedule start it — only its paired Emitter.
    Publishing a flow that has only a Collector is allowed.
  - **There is no recursion by construction:** one graph (connected blocks) cannot contain both an outgoing call (Emitter, Loop) and an incoming one (Collector) — the validator rejects such a flow
    (`call_same_graph`). So a called graph never calls anyone itself: no call chains or cycles. The `allowRecursive`/`maxDepth` parameters no longer exist; for repetition use the **Loop** block.
    (The engine keeps a safeguard: re-entering the same Collector or a chain longer than 20 is an error.)
  - Nested runs do not send events outward (node ids of the two flows may coincide) — the caller gets the result.

**Sandbox and production runs.** The Run button is the **sandbox**, a published flow is **production**, and they do not overlap:

- In the sandbox an Emitter looks for a Collector among the **saved copies** of flows (a draft is fine, no publishing needed), and for its own flow uses the version from the editor (including unsaved).
  A production run looks only among **published** flows. Production copies are not run from the sandbox.
- Sandbox memory banks and counters are stored separately (`<FL0W_MEMORY_DIR>/_sandbox/`); production memory is not changed by trial runs.
- Pins (pin data) apply only in the sandbox; closing the feed or Stop also cancels nested calls.
- The sandbox does not isolate external effects (HTTP, Telegram, files): a trial run does what the block always does.

## Counter and Log

- **Counter** `counter` (in0 / out0, Logic category) counts **how many times the node has fired** and **shows the number on the node itself instead of the icon**. Data passes through unchanged
  (nothing is added to the JSON). The count survives runs (`<FL0W_MEMORY_DIR>/counters.json`); the sandbox (Run) and a production published flow each have their own. By default
  this very node is counted (key — flow + node id); `name` sets a shared counter for several nodes (supports `{{ inputs… }}`); `operation: reset` zeroes it (the node shows 0). A pinned
  node is not executed and does not count. The number arrives in the `node:done` event (`display`) — after the editor reloads it is shown again with the first run.
- **Log** `log` (in0 / out0, Input / output category) writes a message to the run journal and **shows it on the node itself** in the style of the other blocks (monospaced `$ …` lines of the last run, scrolling inside,
  resized by the corner). An empty message — the whole input as JSON; `{{ path }}` from the input works in the message; `level` info/warn/error (warn lines are yellow, error lines red). Data passes through unchanged.

## Loop and Break

**Loop** `loop` (in0 → `out0` "done" and `body` "each iteration", Logic category) is a real loop, unrelated to Emitter/Collector. The nodes reachable from the **`body`** output are the **loop body**: the loop
runs them once per iteration (the iteration data `{ item, index, total }` comes out of `body`; body node events are visible on the canvas for the first 20 iterations), and at the end **`out0`** outputs an array of
results — the body's **Result** value per iteration (`null` if there is no Result in the body). A Result inside the body belongs to the iteration and does not enter the result of the whole run. The body cannot overlap
the continuation after the loop (`loop_body_overlap`); values coming into body nodes from outside (from nodes outside the body) are taken from those already computed — **the loop waits until these external inputs are resolved**. Loops nest (a Loop in a Loop body). The graph stays acyclic.

Modes (`mode`):
- `items` — over the elements of an array from the input (`path`, empty — the whole input), `item` is the element;
- `count` — `for`: from `from` while `i < to` (with a negative `step` — while `i > to`) with step `step`; `item` is the number;
- `while` — while the condition (`field` / `operator` / `value`, as in Branch) over the result of the **previous iteration** (for the first — over the input) is true; `item` is the previous result;
- `forever` — `while true`: until a **Break** block in the body.

`maxIterations` (1000 by default, at most 10,000) limits any mode: exceeding it is an error, not a hang. `onError`: `stop` — an iteration error fails the loop, `continue` — the iteration is skipped and the errors `[{ index, item, error }]` come out of the `err` port (visible only in this mode; fires only if there were errors). Iterations run one after another. **Break** `loop_break` — inside the body it stops the nearest loop after the current iteration (that iteration's result is kept); outside a body it is an error.
Example: `examples/loop.json`.

## Block resource limits

- **HTTP Request:** response body ≤ 10 MB (`Content-Length` is checked immediately, the stream is cut off while reading) — anything larger is an error.
- **Files:** reading by mask — at most 1000 files and **50 MB total** (checked from metadata before reading), at most 16 concurrent disk accesses; a directory listing — at most 20,000 entries.
- **Code, Code Agent, Code Tool:** `timeoutMs` from 1 to 300,000 ms (as in Shell).

**Run cancellation** (the Stop button, a closed feed, a failure of a neighboring branch, the time limit) reaches the blocks: HTTP, Shell, Telegram, Wait, Code, Loop, as well as **Files** (a check between operations, `signal` on
read/write), **Memory Bank / Counter** (waiting for the lock stops), **Code Agent / Code Tool** (tool and memory calls from the code do not start, the tool code is stopped) and **Crypto**
(scrypt in a thread pool, does not block the event loop). A `while(true)` loop without `await` inside Code can only be stopped by the timeout / process termination — a `vm` limitation.

**Triggers do not invent events.** Webhook, Telegram Trigger, Local File Trigger, Error Trigger, Activation/Workflow Trigger and Incoming Call output only the data of a real event; without it `run` fails with an error
("… has no event data"). Previously "examples" were substituted (`example.txt`, a message from "Example", etc.) that could start a chain with side effects. To debug without an event, pin data in a manual run.

**Running a single trigger.** The **Manual Trigger** node has a ▶ button on the left: it runs only this trigger (the other triggers stay silent), and sandbox pins (pin data) apply. The Run button in the
header still starts all triggers that are not waiting for events. API: `POST /api/run { flow, trigger }`; in the engine — `RunOptions.trigger` + `pins: true` (scheduled runs do not apply pins).

## Disabled node

The power button in the inspector header sets `disabled: true`. The node **does not participate at all**: it does not run and outputs nothing
(the branch behind it does not start — a "clean skip", not pass-through as in n8n), a trigger is not registered in the scheduler,
parameters are not validated, and it is not counted in Emitter/Collector channels, tools, memory, or in the "has a trigger" requirement
when publishing. Manually running a disabled trigger is an error.

Group: the lock in the header (the `locked` parameter) prevents dragging and resizing the group.

## Pausing and stopping a trial run

While a run from the editor is in progress, the Manual node shows pause/resume and stop instead of ▶. **Pause** (`PauseGate`, the runner commands
`pause`/`resume`, the `run:paused` event) prevents new nodes from starting; ones already running (Wait, HTTP…) finish — they
cannot be frozen. The gate is shared by nested runs (loop bodies, flow calls). **Stop** aborts the run (like the Stop button),
including from a pause. It works only for trial runs (`POST /api/run` with `runId`, pause — `POST /api/run/control`); published
flows have no such controls.

## Notification (desktop notifications)

The block shows a notification on the machine where the server runs: KDE Plasma, GNOME and any freedesktop notification daemon —
through `notify-send` (the libnotify package: Arch/Manjaro `libnotify`, Debian/Ubuntu `libnotify-bin`). In `title` and `message`
`{{ path }}` from the input works; an empty `message` is the whole input as text. Data passes through unchanged.

- The command is run without a shell, arguments as an array, and the title and text come after `--`: data from the flow does not become
  flags or commands. The icon is a theme name only (a file path is rejected). Only the session environment is passed to the command
  (`PATH`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `DISPLAY`, `WAYLAND_DISPLAY`…); server secrets are not.
- The server process needs a desktop session. Running `pnpm dev` / `pnpm start` from a terminal in your KDE session works.
  Under a systemd service or in a Docker container there is no session bus — the block fails with an error; in Docker you can forward the socket
  (`-v $XDG_RUNTIME_DIR/bus:/run/user/1000/bus -e DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus`) and install
  `libnotify-bin` in the image — this is not there by default.
- `urgency: critical` in Plasma stays on screen until it is dismissed.

## Multiple flows (tabs)

Above the canvas is a tab strip: each tab is a separate flow with its own canvas, run, inspector and autosave in the browser
(`fl0w:flow:<id>`, the tab list — `fl0w:tabs:v2`; the single flow of the previous version moves to the first tab). Inactive tabs
stay mounted: a run in them continues. Double-click the name to rename; "+" — a new flow or open one from the server
(published and drafts); closing a flow with content that is not saved on the server asks for confirmation. Open from a file
(File → Open): a flow whose id matches an open tab replaces its content, otherwise a new tab opens. No more than 12 tabs.

Flows are independent: published ones run on the server by their own triggers regardless of open tabs. They can call each other
through Emitter/Collector (a 1:1 channel). A trial run from the editor finds a Collector in the other **open tabs** (including
unsaved ones), then in the copies saved on the server; in production mode only published ones apply.

## Atlassian (Jira)

A block for Jira (Server/Data Center and Cloud): JQL search, get, create and update issues, comment, transition by status
(by id or by transition name) and an arbitrary REST `request` — it can also be used to reach Confluence (`/rest/api/content?...`).
In `jql`, `summary`, `description`, `comment`, `issueKey` the `{{ path }}` from the input works.

**Sign-in (`auth`)** — no API token needed
- `form` (default) — login and password through the Jira login form `POST /login.jsp` (`os_username`/`os_password`, as in a browser):
  success is the `X-Seraph-LoginReason: OK` header and a `JSESSIONID` cookie; a wrong password or captcha gives a clear error;
- `basic` — login and password in a Basic header (in Cloud — e-mail and API token);
- `session` — sign-in through `POST /rest/auth/1/session` (the same as REST);
- `bearer` — a personal access token (PAT, Server/DC 8.14+), `username` is not needed.
For `form` and `session` the cookie lives for one block call, and at the end the session is terminated (`DELETE /rest/auth/1/session`).

**Password.** The `password` field is either a plain-text password (stored in the flow file and in the browser: do not publish such flows and files) or a reference
`env:FL0W_SECRET_NAME` to a server environment variable (`FL0W_SECRET_JIRA_PASSWORD=… pnpm start` or `.env` in Docker) — then the flow contains no password.
The password never reaches logs, events or error messages.

**Address safety.** Requests go only to `baseUrl` (with no credentials, query or fragment in it); the `request` path must start
with a single `/` and contain no `..`, scheme or spaces — it cannot redirect the request to another host; redirects are not followed (a redirect
to a login page is an error). The response is limited to 10 MB. With `http://` the password travels in plain text — use https or a trusted network.

`apiVersion` 2 (default) works on both Server/DC and Cloud (plain-text description); 3 — Cloud, text is automatically converted to ADF.

## Mail

The block is not tied to a particular mail service: operations (send, list messages with filters, read a message, mark as read)
are performed by a **provider driver**; there are currently two, and a new one is added as a driver (`MailDriver` in `packages/blocks/src/mail-types.ts`) without
changing the block or flows.

- **`imap`** — any mail server over IMAP (reading) and SMTP (sending): Exchange/Outlook, Gmail, Yandex, your own.
  `host`/`port`/`secure` — IMAP (993, TLS), `smtpHost` (empty — the same)/`smtpPort`/`smtpSecure` — SMTP (465 with immediate TLS or 587 with STARTTLS),
  `username` — the login (usually the mailbox address), `password`. `tlsInsecure` disables certificate verification (internal servers with a self-signed one).
- **`graph`** — Microsoft Graph (Outlook / Microsoft 365) with no extra libraries. It needs an Azure AD application (`tenantId`, `clientId`,
  `password` = client secret) with `Mail.Read` / `Mail.ReadWrite` / `Mail.Send` permissions on the `username` mailbox. The Graph and login addresses can be
  replaced with the `FL0W_GRAPH_URL` and `FL0W_GRAPH_LOGIN_URL` variables (national clouds).

Operations: `replyMail` (reply to the author; `replyAll` — to everyone; with In-Reply-To), `moveMail` (to a folder; to the trash — by moving) and `sendMail` — `to`/`cc`/`bcc` (addresses separated by commas, `;` or newlines), `subject`, `body` (text, or HTML with `html`);
`listMail` — `folder` (INBOX, sent, drafts, …), `unreadOnly`, `fromFilter`, `subjectFilter`, `since`, `limit` (up to 100), newest first;
`getMail` — by `messageId` (for IMAP this is the UID in the folder, for Graph the message id): headers, `text`, `html`, the list of attachments; with `saveAttachments`
attachments are saved to `<files directory>/<attachmentsDir>/<message id>/<name>` (names are sanitized, duplicates are made distinct, up to 50 files and 100 MB),
and the metadata gains a `path`; `markMailRead`. In `to`, `subject`, `body` and the filters, `{{ path }}` from the input works.

**Security.** The password is plain text (stored in the flow) or an `env:FL0W_SECRET_…` reference; it does not reach errors or logs. Recipients
are validated, and the subject and addresses must be strictly one line (headers cannot be forged with a line break). The body and responses are size-limited.
Without a trusted server, do not send the password over an open channel: keep TLS enabled for IMAP/SMTP.

### Mail Trigger (new message)

Like Email Trigger (IMAP) and Microsoft Outlook Trigger in n8n, but one block for any provider: it fires on every new message in the mailbox,
**one run per message**, oldest first; the output is the whole message (like `getMail`). It works for a published flow: every `intervalSec`
(at least 15 s) the server polls the mailbox through the provider driver (IMAP or Microsoft Graph) — no incoming connections are needed.

- `action: markRead` (default) — mark the message as read after the run; messages that were in the mailbox at publish time are
  also processed. `action: none` — messages are not touched, and ones already present at publish time are skipped (unless
  `processExisting` is on). The "already seen" list lives in server memory, so for reliability across restarts use `markRead`.
- Filters `folder`, `unreadOnly`, `fromFilter`, `subjectFilter`; `saveAttachments` saves attachments to the files directory (see above).
- A failure (network, password) is retried with a growing pause (5 s … 5 min), and the password is stripped from the log. Parameters are validated on publish.
- What is missing compared with n8n: IDLE (instant notification — here it is polling), the Simple/Resolved/RAW formats (there is one output), arbitrary IMAP rules
  (filters instead), Outlook calendar and contact events.

## Keyboard shortcuts

They work on the canvas of the active tab (not in input fields, the code editor and windows); `Ctrl` = `Cmd` on Mac; letters are matched by physical key — the same in a Russian layout.

| Keys | Action |
|---|---|
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | copy / cut / paste the selected nodes together with the connections between them, parameters, pinned data and the "disabled" flag. Goes through the system clipboard (JSON): you can paste into another tab, another browser or a text file. Pasting gives new ids, offsets the nodes so they do not land on top of the originals, and selects what was pasted |
| `Ctrl+D` | duplicate the selection |
| `Ctrl+A` | select all |
| `Ctrl+Z` | undo |
| `Ctrl+Shift+Z`, `Ctrl+Y` | redo |
| `Delete`, `Backspace` | delete the selection |
| `Shift+A` | open "Add block" |

History (up to 100 steps) is separate for each tab; a step is an edit after which nothing changed for 0.35 s (typing in a field is one step, a drag is one step);
selection and zoom are not part of history; loading a flow is the start of history (it cannot be undone).

**Add block:** type part of a name and the list is filtered; `↑`/`↓` pick a block by screen position (one row up/down), `←`/`→` at the edge of the search field move to the
adjacent block; `Enter` adds the selected one (the first by default); `Esc` closes.
