# AGENTS.md

Context for coding agents working in this repository. Humans want
[CONTRIBUTING.md](CONTRIBUTING.md) instead.

## Read these before exploring

- **[CONTEXT.md](CONTEXT.md)** — the domain glossary. Every term this codebase
  cares about is defined there, with an *avoid* list of synonyms that blur a
  distinction the project maintains. Use the vocabulary in that file.
- **[docs/adr/](docs/adr/)** — the architecture decisions, including the options
  that were rejected and why. Read the ones that touch what you're changing.

## Commands

```bash
npm install
npm run build          # core first — cli, vscode and web depend on its dist/
npm run lint
npm run typecheck
npm test
```

Build order is not optional: `core` emits the types the other three packages
compile against. Building a leaf package against a stale `core/dist` produces
type errors that describe the wrong problem.

Offline end-to-end drive of the planner loop — no API key, no network:

```bash
node bench/live/mock-provider.mjs &     # 127.0.0.1:3799
node bench/live/drive-conversation.mjs
```

## Layout

| Path | What lives there |
| --- | --- |
| `packages/core` | Pure TypeScript, no UI dependencies. Session, PlanStore, Planner, TaskOrchestrator, VerdictEngine, ModelResolver, ModeResolver, RunnerRegistry. |
| `packages/cli` | The `ordewell` binary. `src/tui/` is a pure reducer + renderer behind a thin raw-mode driver. |
| `packages/vscode` | Extension host and React webview. |
| `packages/web` | Hono HTTP + WebSocket server. This is the **local daemon** the CLI and TUI drive over `127.0.0.1` — it is not a website and has no frontend. |
| `bench/` | Offline dev harnesses. Zero dependencies, pure Node. |

## Conventions

- **No `any`.** The codebase was deliberately swept clean of it. Use `unknown`
  and narrow.
- **Comment *why*, never *what*.** Match the comment density of the file you're
  editing. Self-evident comments get removed in review.
- **Deep modules.** One module owns one concept end to end behind a narrow
  interface. Threading a new flag through several layers usually means the seam
  is wrong — raise it rather than widening every signature.
- **Verdicts come from evidence.** A task completes when its completion marker
  appears in the runner's output. Never make the model the tie-breaker.
- **The plan is the source of truth** for what runs. Modes and models are never
  silently rewritten at spawn time
  ([ADR-0001](docs/adr/0001-autonomous-mode-resolution.md)).

## Cautions

- Do not add quantified performance or cost claims to any user-facing text.
  There is no published measurement behind one, and an earlier projection did
  not survive end-to-end testing. See `bench/README.md`.
- The planner's exploration envelope is a security boundary
  ([ADR-0008](docs/adr/0008-planner-exploration-envelope.md)). Do not widen what
  it permits without an ADR.
- Sessions persist to `.ordewell/` and are gitignored. Nothing there is a
  fixture; do not commit it.
