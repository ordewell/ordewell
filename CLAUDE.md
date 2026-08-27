# CLAUDE.md

Claude Code, welcome. This is Ordewell — an open-source terminal tool that
turns one goal into an ordered plan of coding-agent tasks, each with its own
runner, model and mode, then executes and verifies them. Claude Code, Codex
and OpenCode can all be running targets.

## Start here before changing anything

- **[CONTEXT.md](CONTEXT.md)** — the domain glossary. Every term the codebase
  cares about is defined here, with an *avoid* list of synonyms that blur a
  distinction the project maintains. Use this vocabulary.
- **[AGENTS.md](AGENTS.md)** — the full working conventions (commands, layout,
  cautions). This file is the short version; AGENTS.md is the source of truth.
- **[docs/adr/](docs/adr/)** — architecture decisions, including the options
  that were rejected and why. Read the ones that touch what you're changing.

## Build entry point

```bash
npm install
npm run build          # core first — cli, vscode and web depend on its dist/
npm run lint && npm run typecheck && npm test
```

Build order is not optional: `core` emits the types the other three packages
compile against.

## Hard constraints (non-negotiable, keep them)

- **No `any`.** The codebase was deliberately swept clean of it. Use `unknown`
  and narrow.
- **Verdicts come from evidence.** A task completes only when its completion
  marker appears in the runner's output. Never make the model the tie-breaker.
- **The plan is the source of truth.** Modes and models are never silently
  rewritten at spawn time ([ADR-0001](docs/adr/0001-autonomous-mode-resolution.md)).
- **Comment *why*, never *what*.** Match the comment density of the file you're
  editing.

## Two things that will get flagged in review

- Never add a quantified performance or cost claim to user-facing text — there
  is no published measurement behind one ([AGENTS.md](AGENTS.md) cautions).
- The planner's exploration envelope is a security boundary
  ([ADR-0008](docs/adr/0008-planner-exploration-envelope.md)). Do not widen what
  it permits without an ADR.

## Don't

- Commit anything under `.ordewell/` — sessions persist there, it's gitignored,
  and nothing in it is a fixture.
- Reach for a new flag through several layers when a module seam is the real
  fix — raise the seam instead of widening signatures.