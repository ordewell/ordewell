---
status: accepted
---

# 0006 — Terminal UI as a pure core behind a thin driver

## Problem

Ordewell had the VS Code extension and a per-command CLI, but no interactive terminal client. `ordewell plan` is one-shot and line-oriented: it cannot show a live plan pane, cannot load a skill into the conversation or set a task's skills, and every model/key/allowlist change is a separate process invocation. Issue #24 asked for a TUI with the extension's capabilities.

## Decision

We decided to build `ordewell tui` as a **pure state core** (`state`, `reducer`, `render`, `slash`, `editor`, `keys`, `ansi`) with a **thin, untested driver** (`terminal.ts`, `index.ts`) at the edge, talking to the daemon (`packages/web`, an HTTP + WebSocket server with no frontend, whose clients are the CLI and the TUI). The reducer returns `{ state, effects }`; a separate executor (`effects.ts`) turns those effects into `ApiClient` calls and feeds results back as actions.

## Key properties

- **Effects as data, not calls (E1).** `reduce(state, action)` never performs I/O; it returns an `Effect[]` the runtime executes. Every command — loading a skill, setting a task's skills, model selection, provider keys, allowlists, runner toggles, task control — is asserted against the effect list with no network, no daemon, and no terminal. This is what makes the parity surface testable at all.
- **`render(state)` returns exactly `rows` lines (R1).** Layout is a pure function of state, so geometry, clipping, wrapping, scrolling and overlay content are unit-asserted. Width is measured with an ANSI- and wide-glyph-aware `width()`, not `String.length` — CJK and emoji otherwise shift every column to their right.
- **No new dependencies (D1).** The hand-rolled renderer is small and buys exact-frame tests.
- **The daemon is the TUI's single seam (S1).** The TUI holds no orchestration logic; it consumes `SessionMessage` over the daemon's websocket. The VS Code extension does not use the daemon: it constructs core's `Session` in-process and relays its messages over VS Code's webview messaging. What keeps the two in step is that both hosts run the same core `Session` — the daemon one per session in `OrchestratorPool`, the extension one for the window — and that a session planned in the terminal opens unchanged in VS Code through the saved-session store in `.ordewell/sessions/`, which both read and write through core. An execution control is the same command on every surface: the TUI, the CLI and VS Code all send core's `ExecutionCommand`, and core's `taskActionCommand(action, taskId)` is the one table from a task action (cancel, retry, resume now, skip, force start, mark complete or not done) to its command, so a button means the same command in the terminal and the editor. A skipped task, for one, is terminal and verdict-less — nothing it did lands, and its dependents go ahead without it once the work it waited on is done.
- **The daemon carries execution commands on one route (S3).** `POST /api/plans/:sessionId/execute-command` takes an `ExecutionCommand` (typed in the daemon contract, checked against the command's fields before the seam sees it), runs it as the user (ADR-0029), and answers `{ ok, message, payload? }`: the seam's line, and what a button needs beyond it (a queued message's id, a force start's queued line). A refusal is the one `ErrorBody`, a 400 with code `refused` and the seam's line as `error`, carrying `payload` where the act ran and stopped. The TUI reaches it through `ApiClient.execute`, as the CLI's task controls do, so a command added to core needs no route, no client method and no step in the TUI's action ladder. The routes that answer more than the seam does stay beside it: `execute` (the `no_plan` code), `stop` (a refused stop with nothing to stop is still stopped), `review/approve` (the plan it set going), the checkpoint answers (the 409 `checkpoint_not_waiting`), `isolation/merge` (the Merge all card's result as a 200) and `escalations/answer` (it takes an escalation's id, not a command; [ADR-0053](../supervision/0053-what-waits-on-a-person-is-derived-and-answered-in-one-call.md)). The runner's own slash command stays at `tasks/:taskId/commands`.
- **The chat pane draws core's display blocks.** The TUI accumulates no presentation state of its own from `SessionMessage`s: core builds the planner conversation view once ([ADR-0017](0017-shared-conversation-view.md)), and the TUI renders its blocks — command rows, streaming reply text, subagent blocks, plan markers and the usage line. Task logs likewise use core's pure
  `followTaskLog` for saved-log reads and live batches, shared with VS Code
  (ADR-0018 P1); the driver carries the read's stream position and each live
  batch's position into that reducer.
- **Secrets never reach the frame (K1).** `/key` renders its input masked and the confirmation names the provider and env var, never the key. Keys are written to the resolved `.env` via the existing `writeEnvVar`, the same file `ordewell models --set` uses.
- **Keys unwind one layer at a time.**
  - **Ctrl-C (C1):** overlay → half-typed line → quit. A single-press quit loses a half-composed goal; a modal-only escape strands users who do not know `esc`.
  - **ctrl+o** toggles full detail for the conversation — one `detailAll` flag that expands or collapses every tool block, subagent digest and streamed line at once, not per-block state.
  - **Double-Esc stops a running planner turn.** With the drafting line already empty, the first press arms the stop and the second confirms it, so a stray tap does not cancel.
  - **Esc unsends the newest queued prompt** when one is waiting — its text goes back into the drafting input and the planner keeps running.

### Loaded sessions are adopted

`POST /api/sessions/:id/load` **adopts** a saved session: the pool builds a Session for it and calls `Session.loadPlan(plan, goal, workspace, { sessionId })`, the same seam the VS Code extension uses in `applyLoadedSession`. Both the TUI's `/sessions` and `ordewell sessions load` call it. Without it, a restored plan rendered but was inert — every task endpoint answered `Session not found`, since the pool resolved only sessions planned during the current run.

- **Adoption is explicit, not lazy (A1).** The pool registers a session through its own endpoint.
- **A live session wins over the file (A2).** Re-adopting an already-registered session returns it untouched. `loadPlan` clears the execution log and discards the callers of the old plan's waiting planner turns, so re-reading the file mid-run would drop a running plan back to its saved state.
- **The saved id is adopted with the plan (A3).** Without `{ sessionId }`, `persist()` would fork the session under a fresh identity; with it, the same file is rewritten. Because `persist()` derives the filename from goal + `generatedAt` + id, adoption lands on the file it came from — pinned by test.
- **No LLM call (A4).** The plan is adopted exactly as saved; the planner is contacted only when the user next sends a message — or for an input no planner turn had answered when the plan was saved, which is replayed once (ADR-0029).

## Considered options

- **Ink / React (D2).** Rejected: it would add React to a package that has none, and a component tree is markedly harder to assert than an array of strings — a dependency and a testing regression for no capability gain.
- **Reducer performs its own I/O (E2).** Rejected: every command test would need a daemon double, and the command surface — the actual subject of issue #24 — is the largest part of the code.
- **Host sessions in-process, skipping the daemon (S2).** Rejected: it would duplicate the session hosting the daemon already does for the CLI, behind one HTTP+WS seam.
- **One daemon route per execution command (S4).** Dropped: about a dozen routes each turned a URL into one `ExecutionCommand` and forwarded it, with a matching `ApiClient` method and a step in the TUI's action ladder, while VS Code already called `execute` directly. Removing them lost nothing, and each new command had to be threaded through three layers.
- **A TUI package of its own (`packages/tui`) (P2).** Rejected: it consumes `ApiClient` and the CLI's `.env` helpers, and ships as another `ordewell` subcommand. A fourth workspace for one subcommand adds build wiring without a boundary.
- **Hydrate a saved session lazily inside `session()`.** Rejected: that accessor has no workspace to hydrate from, so every task route would grow a `?workspace=` param, and a plan would spring to life as a side effect of an unrelated call.

## History

- 2026-07-31 — accepted.
- 2026-09-24 — the record corrected: the VS Code extension never used the daemon, and there is no web UI; the decision stands on the shared core `Session` and session store.
- 2026-09-27 — the chat pane draws ADR-0017's blocks; ctrl+o, double-Esc and Esc-unsend.
- 2026-10-09 — skill toggles replaced by skills (ADR-0024); the Context and E1 wording follows.
- 2026-10-11 — adoption replays planner turn inputs no turn answered ([ADR-0029](../supervision/0029-the-supervisor.md)).
- 2026-10-18 — the task-log view shares core's saved-log and live-stream follow reducer with VS Code.
- 2026-10-24 — skip's note corrected: every surface sends core's `skip_task`, which lands nothing.
- 2026-10-24 — the daemon's forwarding routes for execution controls are replaced by one `execute-command` route (S3); `taskActionCommand` maps a task action to its command for the TUI, the CLI and VS Code.
- 2026-10-30 — `escalations/answer` joins the routes beside `execute-command` (S3), from ADR-0053.
