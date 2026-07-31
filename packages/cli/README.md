# @ordewell/cli

The command line and terminal UI for **[Ordewell](https://ordewell.ai)** — turn one
goal into an ordered plan of coding-agent tasks, each with its own runner, model
and mode, then execute and verify it.

```bash
npm install -g @ordewell/cli              # or: npm install -g ordewell

export OPENROUTER_API_KEY="sk-or-..."     # any one provider key — auto-detected

ordewell                                  # the TUI
```

Bare `ordewell` opens the full-screen terminal UI. On first run it tells you
what it still needs — a planner and at least one runner — both settable from
inside it with `/planner`, `/runners` and `/key`. Or drive it as a CLI:

```bash
ordewell plan --goal "Add rate limiting to the public API"
ordewell run
```

No API key? Plan on a coding agent you already have installed — it's what
executes the tasks anyway:

```bash
export AI_PROVIDER="claude-code"          # or codex, or opencode
ordewell plan --goal "Add rate limiting to the public API"
```

## The two surfaces in this package

```bash
ordewell            # full-screen terminal UI: chat on the left, plan on the right
ordewell --help     # every slash command is also a subcommand
```

`ordewell setup` walks through first-run configuration interactively.

## Requirements

Node.js ≥ 20, and **tmux** for the TUI on every platform — it is what backs each
task's live terminal (`apt install tmux`, `brew install tmux`). Linux, macOS and
Windows are all supported; on Windows, run the TUI under WSL.

Installing this package also installs `@ordewell/web`, the local API server the
CLI and TUI drive over `127.0.0.1`. It starts on demand — you don't need to run
it yourself.

## Documentation

Full documentation, including the VS Code extension, is at
**[github.com/ordewell/ordewell](https://github.com/ordewell/ordewell)**.

Licensed under the [Apache License 2.0](./LICENSE).
