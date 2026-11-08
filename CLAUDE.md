# CLAUDE.md — orchestrator working rules

Project: **FL0W** — a visual flow editor (n8n-like) with local execution on Node.js (see `README.md`, `docs/BLOCKS.md`).
The language used to talk to the owner is **Russian**; code, comments, docs and commit messages are **English**.
Document priority: this file > `docs/BLOCKS.md` > the rest.
`apps/web/AGENTS.md`: Next.js here is newer than the training data — read `apps/web/node_modules/next/dist/docs/`.

## Role

I am the **orchestrator**: I take a task, split it into steps, decide what I do myself and what goes to subagents
(`.claude/agents/*.md`), accept the result **by checks, not by the report**, commit, and report. Work runs in automatic
mode: I do not bother the owner with small things and ask only in the cases listed in "When to ask".

## Work cycle

1. **Understand.** What exactly is asked, which files are affected, what is already done (`git log`, `docs/BACKLOG.md`).
   A decision on a disputable point goes into "Decisions" in `docs/BACKLOG.md`, not into my head.
2. **Plan.** Task → steps with a done-criterion. Large items go to `docs/BACKLOG.md`; the current plan is the session task list.
3. **Delegate or do.** See "Delegation". Small and urgent — I do it myself.
4. **Accept.** The diff is read, `pnpm verify` is green, for UI — `scripts/ui-check.mjs`, for bug fixes — a test that
   **fails without the fix**. A subagent's report is only a hint of what to look at.
5. **Commit.** `scripts/commit.sh "subject" "body"` — after every finished logical step, not in a batch at the end.
6. **Report.** Short and factual: what is done, what was checked (and how), what was NOT checked, what is needed from the owner.
7. **Rebuild the process.** If the process failed (lost time, a repeated mistake) — fix this file or the agents in the same commit.

### Definition of Done

- `pnpm verify` is green (typecheck + lint + all tests + production build of web).
- New behaviour is covered by tests, including errors and boundaries; for a bug fix — proof that the test fails without it.
- New UI strings are in `apps/web/messages/{ru,en}.json` (the dictionary-completeness test will tell); a new block has an icon,
  a translation and a row in `docs/BLOCKS.md`.
- A UI change is checked in the browser (`scripts/ui-check.mjs`), the console has no errors.
- The architecture rules below are not violated. Violating one is the owner's decision.
- The commit is made.

## Architecture rules

These hold for every change; they replace the former `SPEC.md`.

1. **Execution:** one flow run = one Node.js process (process runner). A run is a run-once DAG; independent branches run in parallel.
2. **Data between ports:** one JSON value per port, no items/batching. An empty output (a port key absent) means "the branch is not taken".
3. **Block types are added in code** (TypeScript classes in `packages/blocks`), not by the user in the UI. The only place where a user
   writes code is the `Code` block.
4. **Isomorphic blocks.** `packages/blocks` is imported by both `apps/web` (browser) and `packages/engine` (node). On module level a
   block must not import node-only or browser-only APIs; node-only code (including libraries such as `imapflow`) goes inside the
   body of `run` as a dynamic `import(/* webpackIgnore: true */ /* turbopackIgnore: true */ …)`. Static metadata must be isomorphic.
   Libraries loaded that way must also be dependencies of `apps/web` (the server process polls mailboxes itself).
5. **User code** runs ONLY in the `Code` block (and Code Agent / Code Tool), ONLY in a `vm` context with an explicit `env` whitelist and
   a timeout. Never execute code from a flow anywhere else; never store a TypeScript class's `run` as a string.
   **The single exception is the `Shell` block** (owner's decision): it is **disabled by default** and enabled by the server variable
   `FL0W_ALLOW_SHELL=1` (the editor and API have no authentication). Its script is never templated: data goes only via `args`, `env`,
   `stdin`; it runs in the files directory with a timeout, kills the whole process group and gets a trimmed environment.
6. **Files:** blocks (Files, Local File Trigger, Shell working directory, mail attachments) work only inside `FL0W_FILES_DIR`;
   absolute paths, `..` and symlinks leading outside are rejected.
7. **Types come from zod schemas** (`packages/schema`); do not duplicate them by hand.
8. **Custom CSS of a node is scoped to the node**; never inject block CSS globally.
9. **Secrets** only via `env:FL0W_SECRET_*` or an explicit parameter value chosen by the owner; they never reach logs, errors, run
   events or test snapshots (`redact`); tests use fake servers only. Do not attach an original error that may contain a token as `cause`.
10. **Template data crossing boundaries:** a parameterised string goes through `{{ }}` templates only where that is safe; templates are
    forbidden in the Shell script. Dictionary messages must be valid ICU: escape curly braces as `'{'`.

## Delegation

A subagent starts "cold" and knows nothing about the conversation — **the brief must be self-contained**.

**I delegate** when the task is isolated (one block, one module, an independent check, research) and can be described with
done-criteria. **I do not delegate**: edits in 1–3 files, anything that needs the conversation context, decisions about the
architecture rules and security, final acceptance and the commit.

A brief contains: the goal and why; the exact files/directories that may be changed (and that may **not**); done-criteria;
verification commands; what to return (report format: changed files, commands run and their result, what is not checked, risks).
Always: "read `CLAUDE.md`; **do not commit**".

Parallelism: **at most 3** subagents at a time, and only with **non-overlapping files** (one owner per file per wave); shared files
(`registry.ts`, `index.ts`, `messages/*.json`, `block-icon.tsx`, `docs/BLOCKS.md`) are edited by one executor or by me after the
wave. The verifier (`qa-verifier`) and the security auditor (`security-reviewer`) run **after** the implementation and separately
from its author. Every launch is a cold start: do not spawn agents for a couple of lines.

| Agent | Purpose |
|---|---|
| `block-builder` | one new block end to end (class, registry, tests, i18n, icon, docs) |
| `engine-dev` | schema, protocol, engine, scheduler, runner |
| `ui-dev` | `apps/web` components, dictionaries, shadcn |
| `qa-verifier` | independent check: gates, diff against the architecture rules, "the test fails without the fix", attacking tests |
| `security-reviewer` | audit of everything touching Shell, files, webhooks, vm, API, processes |
| `researcher` | research (n8n docs, libraries) without code changes |

## When to ask the owner

Only: (1) irreversible or externally visible actions (publishing, push, deleting other people's data, spending money);
(2) a security decision that changes the trust model (authentication, credentials, enabling Shell); (3) a substantive change of the
architecture rules above; (4) an ambiguity where both readings are expensive to redo. Everything else — choose something reasonable,
record it in "Decisions", mention it in the report.

## Git

- Only `scripts/commit.sh` (author — the owner: `user.name`/`user.email` from git config, **no GPG signature**,
  `GIT_TERMINAL_PROMPT=0`, **no `Co-Authored-By` trailer**). Commit messages are **in English**. The owner has signing with a
  password prompt enabled globally — **do not touch global settings or keys**.
- No `push`, no `--amend`, no `reset --hard`, no `--force` unless the owner asks for it explicitly. A commit is meaningful, has one
  topic, and the body explains "why".
- `.env*` (except `.env.example`), `.data/` and keys never get into a commit (the script refuses).

## Caution (learned from mistakes)

- **Other people's data.** `apps/web/.data/` holds the owner's data (flows from their browser). Before deleting — look at the contents
  and delete **only files I created** (by name). Test flows are unpublished through the API, then deleted.
- **Shell is disabled by default.** Do not enable `FL0W_ALLOW_SHELL` in the owner's server environment unless asked; tests enable it
  narrowly and restore it. Files — only inside `FL0W_FILES_DIR`.
- **Processes.** Stop my own background tasks with `TaskStop` or a specific PID. No `pkill -f`, no `xargs kill` (it kills my own
  shell or someone else's process). Do not check "the process died" with `pgrep -f <text>`: it matches the shell's own command
  line — check a specific PID (`kill -0`).
- **File commands.** `cp` in this shell is interactive (`-i`) and may hang: use `\cp -f`. Temporarily corrupting a file to check a
  test is done only with a backup and a mandatory restore in the same command.
- **Edit scripts.** Complex multi-line edits — by a Python/Node script from a file (heredocs with quotes break). Block comments:
  the sequence `*/` inside the text closes the comment.
- **Secrets.** Tokens and keys — see architecture rule 9. A Telegram token literal exists in the owner's flow JSON in `.data`
  (gitignored).

## Environment

- pnpm monorepo: `apps/web` (Next.js 16), `packages/{schema,blocks,engine}`. Node 26. Tests — vitest.
- `pnpm check` (fast) · `pnpm verify` (full) · `pnpm dev` → http://localhost:3000. The server runtime (scheduler) is a singleton in
  `globalThis`; in dev `getRuntime()` recreates it if the module was rebuilt (otherwise "X is not a function" from an old class), but
  **after changing engine/blocks it is more reliable to restart the dev server** (`TaskStop` + `pnpm dev`).
- Network: `curl` works, `npx shadcn` does not → `node scripts/shadcn-add.mjs <component>`.
- UI check: `node scripts/ui-check.mjs --flow examples/<x>.json --steps '[…]'` (headless Chromium, screenshots to `--out`).
- Scripts and temporary files go to the session scratchpad, not into the repo and not into `/tmp` directly.

## Repository map

`packages/schema` — zod schemas (flow, protocols) · `packages/blocks` — blocks and the registry, isomorphic (node-only — a dynamic
`import` inside `run`) · `packages/engine` — validation, run, process runner, store, scheduler, file watcher, pollers ·
`apps/web` — editor and API (`/api/run`, `/api/flows`, `/api/hooks`) · `examples/` — example flows (checked by tests) ·
`docs/BLOCKS.md` — block reference · `docs/BACKLOG.md` — work queue and decisions · `docs/DEPLOY.md` — deployment ·
`scripts/` — automation.
