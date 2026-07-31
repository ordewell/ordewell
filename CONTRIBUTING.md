# Contributing to Ordewell

Thanks for considering it. Bug reports and small, focused pull requests are the
most useful things you can send.

## Before you start on something large

Open an issue first. Ordewell has opinions — about where logic lives, about what
counts as evidence that a task finished — and a PR that cuts against one of them
is a bad outcome for both of us. The [ADRs](docs/adr/) record most of those
opinions, and [CONTEXT.md](CONTEXT.md) is the vocabulary they're written in.

Small fixes (a typo, a crash, an obviously-wrong branch) need no issue. Just
send them.

## Setup

Node.js **≥ 20** on Linux, macOS, or Windows.

```bash
git clone https://github.com/ordewell/ordewell.git
cd ordewell
npm install
npm run build
```

**Build order matters.** `core` must build before `cli`, `vscode` and `web`,
because the other three consume its emitted `dist/` types. `npm run build` does
them in the right order; if you build one package directly, build `core` first:

```bash
npm run build:core     # always first
npm run build:cli      # then whichever you're working on
```

Put the CLI on your PATH while you work on it:

```bash
npm link -w packages/cli
ordewell --help
```

For the VS Code extension, open the repo in VS Code and press `F5` to launch an
Extension Development Host.

## The checks

Everything CI runs, you can run:

```bash
npm run lint
npm run typecheck
npm test
```

Plus the offline end-to-end drive of the planner conversation loop, which needs
no API key and no network — it runs against a local mock model:

```bash
node bench/live/mock-provider.mjs &     # binds 127.0.0.1:3799
node bench/live/drive-conversation.mjs
```

If you change planner behaviour, run that. It is the fastest way to find out
that a prompt edit broke plan emission.

## Layout

```
packages/
├── core/    Pure TypeScript, zero UI dependencies. Session, PlanStore, Planner,
│            TaskOrchestrator, VerdictEngine, ModelResolver, ModeResolver.
├── cli/     The `ordewell` binary, and tui/ — a pure state reducer and
│            renderer behind a thin raw-mode terminal driver.
├── cli-alias/  Seven lines. Publishes the unscoped `ordewell` package, which
│            just requires @ordewell/cli. Not an npm workspace: the VS Code
│            extension is also named `ordewell` (its Marketplace id is
│            publisher.name = ordewell.ordewell) and npm refuses two
│            workspaces with one name. Install and publish it directly.
├── vscode/  Extension host + React webview.
└── web/     Hono HTTP + WebSocket server. This is the local daemon the CLI and
            TUI talk to over 127.0.0.1 — not a website.
bench/       Offline dev harnesses. Zero dependencies, pure Node.
docs/adr/    Architecture decisions, including the ones that were rejected.
```

## Releasing to npm

Four packages ship, and the order is a dependency order — each one's `dependencies`
must already resolve on the registry when it lands:

```bash
npm publish -w packages/core
npm publish -w packages/web
npm publish -w packages/cli
(cd packages/cli-alias && npm publish)   # not a workspace — see Layout
```

`prepublishOnly` rebuilds each package first, so `dist/` can never be stale.
`packages/vscode` is `private: true` and is skipped. Versions on npm are
immutable — `npm publish --dry-run` first, and keep all four versions in lockstep
(`cli-alias` pins `@ordewell/cli` exactly).

## House style

- **No `any`.** The codebase went through a deliberate sweep to remove it; please
  don't reintroduce it. Reach for `unknown` and narrow.
- **Comment the *why*, never the *what*.** Match the density of the file you're
  editing. A comment explaining that a loop iterates will be removed.
- **Deep modules.** One module owns one concept end to end, with a narrow
  interface. If you find yourself threading a flag through four layers, the seam
  is in the wrong place — say so in the issue.
- **Verdicts come from evidence.** A task completes when its completion marker
  appears in the runner's output. Never make the model the tie-breaker.

## Pull requests

- Branch from `main`.
- Keep the diff to one concern.
- Make sure `npm run lint && npm run typecheck && npm test` passes.
- Describe what you changed and why. If it changes behaviour a user can see, say
  what they'll notice.

By contributing, you agree that your contributions are licensed under the
Apache License 2.0, the same as the rest of the project. Contributors are
credited in [AUTHORS.md](AUTHORS.md).

## Security

Do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md).
