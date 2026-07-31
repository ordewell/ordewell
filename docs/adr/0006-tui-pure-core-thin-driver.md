# 0006 — Terminal UI as a pure core behind a thin driver

**Status:** accepted

Ordewell had three surfaces — the VS Code webview, the `web` server, and a per-command CLI — but no interactive terminal client. `ordewell plan` is one-shot and line-oriented: it cannot show a live plan pane, cannot toggle a skill mid-session, and every model/key/allowlist change is a separate process invocation. Issue #24 asked for a TUI with the extension's capabilities.

We decided to build `ordewell tui` as a **pure state core** (`state`, `reducer`, `render`, `slash`, `editor`, `keys`, `ansi`) with a **thin, untested driver** (`terminal.ts`, `index.ts`) at the edge, talking to the same daemon the webview and web UI use. The reducer returns `{ state, effects }`; a separate executor (`effects.ts`) turns those effects into `ApiClient` calls and feeds results back as actions.

## Key properties

- **Effects as data, not calls (E1).** `reduce(state, action)` never performs I/O; it returns an `Effect[]` the runtime executes. Every command — skill toggles, model selection, provider keys, allowlists, runner toggles, task control — is asserted against the effect list with no network, no daemon, and no terminal. This is what makes the parity surface testable at all.
- **`render(state)` returns exactly `rows` lines (R1).** Layout is a pure function of state, so geometry, clipping, wrapping, scrolling and overlay content are unit-asserted. Width is measured with an ANSI- and wide-glyph-aware `width()`, not `String.length` — CJK and emoji otherwise shift every column to their right.
- **No new dependencies (D1).** Ink (React for terminals) was rejected: it would add React to a package that has none, and a component tree is markedly harder to assert than an array of strings. The hand-rolled renderer costs ~300 lines and buys exact-frame tests.
- **The daemon is the single seam (S1).** The TUI holds no orchestration logic. It consumes `SessionMessage` over the same websocket the webview does, so a session planned in the terminal opens unchanged in VS Code. The one deviation is `skip`, which the daemon has no endpoint for — the extension implements it as "mark complete and tick", and the TUI matches that rather than inventing different semantics.
- **Secrets never reach the frame (K1).** `/key` renders its input masked and the confirmation names the provider and env var, never the key. Keys are written to the resolved `.env` via the existing `writeEnvVar`, the same file `ordewell models --set` uses.
- **Ctrl-C unwinds one layer at a time (C1).** Overlay → half-typed line → quit. A single-press quit loses a half-composed goal; a modal-only escape strands users who do not know `esc`.

## Considered options

- **Ink / React (D2).** Rejected per D1: a dependency and a testing regression for no capability gain.
- **Reducer performs its own I/O (E2).** Rejected: every command test would need a daemon double, and the command surface — the actual subject of issue #24 — is the largest part of the code.
- **Re-implement orchestration in-process, skipping the daemon (S2).** Rejected: it would fork the execution path from the webview and the web UI, and duplicate the pool/session machinery that already exists behind one HTTP+WS seam.
- **A TUI package of its own (`packages/tui`) (P2).** Rejected: it consumes `ApiClient` and the CLI's `.env` helpers, and ships as another `ordewell` subcommand. A fourth workspace for one subcommand adds build wiring without a boundary.

## Loaded sessions (resolved)

`OrchestratorPool.session()` originally resolved only sessions the daemon planned during the current run, while `/api/sessions/:id` read from disk and registered nothing — so a restored plan rendered but was inert, and every task endpoint answered `Session not found`. This affected `ordewell sessions load` equally; it was never TUI-specific.

`POST /api/sessions/:id/load` now **adopts** a saved session: the pool builds a Session for it and calls `Session.loadPlan(plan, goal, workspace, { sessionId })`, the same seam the VS Code extension uses in `applyLoadedSession`. Both the TUI's `/sessions` and `ordewell sessions load` call it.

- **Adoption is explicit, not lazy (A1).** Hydrating inside `session()` was rejected: that accessor has no workspace to hydrate from, so every task route would have to grow a `?workspace=` param, and a plan would spring to life as a side effect of an unrelated call. Registration is the pool's job and deserves its own endpoint.
- **A live session wins over the file (A2).** Re-adopting an already-registered session returns it untouched. `loadPlan` clears the execution log and queued messages, so re-reading the file mid-run would drop a running plan back to its saved state.
- **The saved id is adopted with the plan (A3).** Without `{ sessionId }`, `persist()` would fork the session under a fresh identity; with it, the same file is rewritten. Because `persist()` derives the filename from goal + `generatedAt` + id, adoption lands on the file it came from — pinned by test.
- **No LLM call (A4).** The plan is adopted exactly as saved; the planner is contacted only when the user next sends a message.

