# AGENTS.md

Context for coding agents working in this repository. Humans want
[CONTRIBUTING.md](CONTRIBUTING.md) instead.

Ordewell is an open-source terminal tool that turns one goal into an ordered
plan of coding-agent tasks, each with its own runner, model and mode, then
executes and verifies them. Claude Code, Codex, OpenCode and GitHub Copilot CLI
(over ACP) can all be running targets.

## Read these before exploring

- **[CONTEXT.md](CONTEXT.md)** — the domain glossary. Every term this codebase
  cares about is defined there, with an *avoid* list of synonyms that blur a
  distinction the project maintains. Use the vocabulary in that file.
- **[docs/adr/](docs/adr/README.md)** — the architecture decisions, grouped into
  folders by area, including the options that were rejected and why. The
  README's index lists every one with its status; read the ones that touch what
  you're changing.

## Commands

```bash
npm install
npm run build          # core first — cli, vscode and web depend on its dist/
npm run lint
npm run typecheck
npm test
npm run test:coverage   # same tests, plus the per-file coverage floors CI enforces; writes coverage/ reports
npm run ci              # every ci.yml step once, in its order, unsharded: run this before pushing
npm run test:changed    # while iterating: only tests affected by uncommitted changes
npm run test:quick      # every test except the real-git e2e files (*.e2e.test.ts, GitWorktreeIsolation)
npm run test:containers # every harness's real binary in a real Docker engine; a skip is UNVERIFIED, not a pass
```

`test:changed` is the inner loop. When a package others depend on changed it
rebuilds that package's `dist/` and runs its dependents' quick suites in full,
because they consume it through `dist/` and vitest cannot see the dependency. A
path it cannot judge runs every quick suite. It skips the e2e files, so run the
full suite before pushing.

`scripts/change-scope.mjs` holds what a change has to prove, for `test:changed`
and for CI alike. Only a pull request is narrowed: a push to main and a release
tag always run everything, though a release of a commit main's push run already
passed reuses that run (`reuse-main-proof`). A changed workspace owes its full suite and its
dependents their quick ones, unless the change is to core's exported surface,
which runs the dependents in full. A path outside the workspaces owes what reads
it, as `ROOT_OWNERS` lists (`.eslintrc.js` lint, `vitest.setup.ts` the suites, a
`bench/` fake the suites that start it), and one that list does not name means
the full run. A new root config, a new `bench/` harness, a new package or a test
that reads past its own package belongs in that file's decisions and its tests.
`COVERAGE_SHARDS` there names each workspace whose full suite CI runs as several
legs whose blobs `coverage merge` judges over the whole (core today); the
Windows shards are packed from `scripts/windows-durations.json`, which
`node scripts/refresh-windows-durations.mjs <run-id> [...]` refreshes.
`Required checks` is the status to require on main, and it waits on every job
that confirms steps, `desktop-tour` and `coverage-merge` included: a skipped job
reads as a pass to GitHub, so that job judges the others by what the change owed
them.

Before pushing, run `npm run ci`. It runs what `.github/workflows/ci.yml`
runs: beyond lint, typecheck and `test:coverage` (whose per-file floors in
`packages/core/vitest.config.ts` plain `npm test` never checks), the verify
scripts, the offline planner e2e, the VS Code integration test and packaging.
It runs each step once, unsharded: CI's Windows shards, and core's coverage
shards with the merge leg that judges their floors, are there to finish sooner,
not to check anything extra. It refuses to start when ci.yml has a step it does
not know, so add any new step to `scripts/ci.mjs` too, and give a step a verdict
rests on an `id`, listed under its job in `STEPS_BY_JOB`
(`scripts/change-scope.mjs`); a new job goes there too, and in `Required
checks`' needs. Every job but `scope` and `Required checks` sets up through
`.github/actions/setup`, which restores `node_modules` (on Linux; Windows runs
`npm ci`), the workspace builds the job asks for and Electron's binary from
caches before installing, building or downloading one, so a new job uses it
rather than `npm ci`. The integration test downloads VS Code into
`packages/vscode/.vscode-test` on its first run.

A test that depends on the time of day (a usage-limit "resets 8:10pm") fails
for the hour after that time; derive such a time from the clock, or fake it,
instead of fixing it. A recorded fixture with a fixed future instant expires
the same way. `vi.waitFor` waits up to ten seconds here, not vitest's one
(`vitest.setup.ts`), and a test may run for thirty, because real git and
file-system events can take past a second on a loaded machine: pass a
`timeout` only to wait longer still. On Windows, where git and processes take
several times as long, every limit is three times longer: the defaults
(`vitest.shared.ts`), each `vi.waitFor`'s, and a test's own, which it writes as
`patient(ms)` from `@ordewell/core/testing`.

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
| `packages/core` | Pure TypeScript, no UI dependencies. Session, PlanStore, Planner, TaskOrchestrator, VerdictEngine, TaskOutputSource, ModelResolver, ModeResolver, RunnerRegistry. |
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
- **Verdicts come from evidence.** A task completes when the runner calls
  `task_complete` bound to the attempt's token. Never make the model the
  tie-breaker.
  One exception: a script task has no runner and no model, so its evidence is
  the exit status of the literal script the plan holds, handed to
  `VerdictEngine` ([ADR-0035](docs/adr/supervision/0035-effects-are-consented-and-recorded.md)).
- **The plan is the source of truth** for what runs. Modes and models are never
  silently rewritten at spawn time
  ([ADR-0001](docs/adr/routing/0001-autonomous-mode-resolution.md)).
- **Every suite runs on Windows too** (CI's `windows` jobs,
  [ADR-0010](docs/adr/platform/0010-windows-support.md)). Build paths with
  `path`, never `/`-joined strings or a `:`-joined PATH, and compare a path git
  or the OS printed with `realpathSync.native`: on Windows it may differ by an
  8.3 short name, the drive letter's case or its slashes. A test that needs a
  home of its own sets one with `setEnv(homeEnv(dir))` from
  `@ordewell/core/testing`, since HOME alone moves no home on Windows, and every
  test file already starts under a throwaway one. A fake CLI is a Node script
  with a `.cmd` and a `.ps1` shim beside its POSIX one, put on PATH with
  `pathWithFake`. Skip on Windows (`it.skipIf(process.platform === 'win32')`,
  with the reason) only a test whose subject is POSIX-only: bubblewrap,
  Seatbelt, signals and process groups, file modes, `/dev`, a file name
  Windows cannot hold (a line break, a `"`), containers. The Windows suites run
  under Git Bash, as CI's do, so a test may use its `sh` as a tool.
## Architecture decisions

[docs/adr/README.md](docs/adr/README.md) is the full guide: read it before
writing or changing an ADR. In short:

- **A new ADR needs all three: hard to reverse, surprising without context, a
  real trade-off.** A bug fix, a refactor that keeps the design, a tuning value,
  a command that follows a recorded decision, and a plan or to-do list are not
  ADRs. A term goes in CONTEXT.md and a how-to in `docs/`. The README lists
  [what qualifies](docs/adr/README.md#should-this-be-an-adr), with examples.
- **A change to a recorded decision edits the ADR that owns it.** Rewrite what is
  no longer true and add one dated History line. A decision that stands on its
  own gets its own ADR, with `amends` naming the one it changes.
- **ADRs state the current decision, not a log of edits.** An ADR reads as
  what is true now: *Decision* as if it had always been the design; *Considered
  options* including any option once chosen and later dropped, with why; and a
  *History* of one dated line per change, with no restated content. Do not
  append `Update`/`Amendment` sections. When a later ADR changes an earlier
  one, rewrite the affected part of the earlier ADR once the change is
  implemented. Until then the earlier ADR carries one *Pending* line naming the
  new ADR. Once it is implemented, fold the new ADR into the earlier one when
  [its folding rules](docs/adr/README.md#folding-one-adr-into-another) allow
  (small or fully overtaken, nothing citing its rule IDs); otherwise it keeps its
  full reasoning as a separate ADR. CONTEXT.md follows the same rule: it
  describes what is, with no dated notes.
- **Where and how to write one.** `docs/adr/<folder>/NNNN-slug.md`, the folder
  chosen as [the README says](docs/adr/README.md#where-it-goes), the number from
  `node scripts/verify-adr.mjs --next`, written to the
  [template](docs/adr/README.md#writing-one). Write it in the same change as the
  code it describes, and cite it (`ADR-NNNN`) in a comment where the code
  embodies it. A decision made ahead of its code is `implemented: none`, with a
  *Pending* line on the ADR it changes ([the README](docs/adr/README.md#changing-an-existing-one)).
- **ADR numbers and rule IDs are permanent.** Code and docs cite `ADR-NNNN` and
  rule IDs such as `ADR-0018 M1`. Never reuse or renumber either: a folded ADR
  keeps its number in the host's `folds`, and moving a file between folders
  changes no citation.
- **Run `node scripts/verify-adr.mjs` after touching `docs/adr/`.** `--write`
  regenerates the README's index; CI runs the check.

## Cautions

- Do not add quantified performance or cost claims to any user-facing text.
  There is no published measurement behind one, and an earlier projection did
  not survive end-to-end testing. See `bench/README.md`.
- The planner's exploration envelope is a security boundary
  ([ADR-0008](docs/adr/planner-envelope/0008-planner-exploration-envelope.md)). Do not widen what
  it permits without an ADR.
- Sessions persist to `.ordewell/` and are gitignored. Nothing there is a
  fixture; do not commit it. The exceptions are `.ordewell/skills/`, which is
  committed by design (ADR-0024), and the generated `.ordewell/.gitignore` that
  carves it out.
