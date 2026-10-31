# Ordewell dev harnesses

Offline tooling for exercising the planner conversation loop, the VS Code
webview, and the execution pipeline against the real core stack. Zero
dependencies. Pure Node (`node:test`, stdlib).

> **The cost model that used to live here has been retired.** `run.mjs` priced a
> routed plan against a single-premium-model baseline from a token *estimate* and
> a price table — it never metered a real run, because Ordewell drives external
> runner CLIs that bill out of band. It was only ever a projection, and an
> end-to-end measurement on real repositories did not reproduce its conclusion.
> Nothing user-facing should quote a cost saving; there is no measurement behind
> one. See the caution in [AGENTS.md](../AGENTS.md).

## Live conversation harness (`bench/live/`)

End-to-end testing of the planner conversation loop (ADR-0002) with the real
core stack:

- `mock-provider.mjs` — a local OpenAI-compatible server simulating budget-model
  quirks (streamed reasoning, fenced JSON with trailing commas, prose preambles,
  empty turns, grilling-ignoring eagerness). Deterministic and offline.
- `scenarios.mjs` — the webview harness's scripted conversation tour, and
  `GOAL_SCENARIOS`: one scenario per kind of goal the planner's strategy step
  teaches (#108), driven by the live harness below.
- `drive-conversation.mjs` — drives `OpenAiService`/`Session` through scripted
  scenarios with assertions (against the mock), or prints a behavioral report
  against a real model: `--real --model deepseek/deepseek-v4-flash` with
  `OPENROUTER_API_KEY` in the environment (never hardcoded).
- `drive-taskops.mjs` — drives the post-plan `task_ops` edit path.
- `webview-harness.mjs` + `webview-screenshot.mjs` — serve the built VS Code
  chat webview in a browser with a mocked VS Code API, replay a full planning
  conversation, assert the sequential-timeline UI contract, and capture
  screenshots.

### Kinds of goal (#108)

The strategy step tells the planner what kind of goal it is looking at. The
mock suite runs one scenario per kind through a real `Session`, with a persona
(`mock/goal-*`) that replies with that kind's plumbing:

| Kind | Persona | What the session must accept |
| --- | --- | --- |
| A question | `mock/goal-question` | no plan, a prose answer, the conversation still open |
| A small effect | `mock/goal-effect` | one `run_script` call, which adds a script task and runs it; its exit status passes |
| A build | `mock/goal-build` | a committed plan of three chained vertical slices, no research, script or loop |
| A failure to explain | `mock/goal-failure` | a reproduction script task as a loop's check, the fix in its body, two read-only research tasks with no dependencies that are approved and start in parallel |
| An open problem | `mock/goal-open` | a committed first round of research tasks only, approved and started |

The API planner submits a whole plan as the JSON envelope — the same commit
path a harness planner's `submit_plan` reaches — and calls `run_script` as an
execution tool. The assertions are about that plumbing: the session validates,
adopts, approves and starts what the planner sends. They are not a judgment of
the prompt; only a real model can show what strategy it picks.

`--real` replays the same five goals against a real provider and writes a
behavioural report to `bench/live/.real-report/` (gitignored), or `--out DIR`:

```bash
OPENROUTER_API_KEY=sk-or-... node bench/live/drive-conversation.mjs \
  --real --model deepseek/deepseek-v4-flash
```

`--model` picks the model, or `MODEL` in the environment as `drive-taskops.mjs`
reads it; the key and base URL come from `OPENROUTER_API_KEY` and
`OPENROUTER_BASE_URL`, never from the file.

The report records the strategy observed for each goal, the plan's shape and a
transcript excerpt. It grades nothing — it has no pass/fail thresholds — and
makes no cost or performance claim, per [AGENTS.md](../AGENTS.md). A real run
may ask questions; one generic nudge answers, so the report shows the planner's
own choice rather than a scripted one. `--real --goal "..." --replies "a::b"`
still runs a single goal the old way.

## Execution pipeline harness (`bench/pipeline/`)

- `fake-claude/` — a deterministic stand-in for the `claude` CLI: no LLM, no
  API key. Put the folder first on `PATH` and Ordewell's own `claude-code`
  connector and structured runner drive it as they would the real binary. It
  speaks the stream-json protocol the connector reads, answers the `mcp_status`
  check, and completes a task by calling `task_complete` on the Ordewell MCP
  server named in the `--mcp-config` file it is given — it never prints the
  text marker. A task steers it with a cue in its prompt:
  `<fake-claude>{"delayMs":400,"write":{"A.txt":"hi"},"status":"blocked","reason":"why"}</fake-claude>`
  (all fields optional; see the header of `fake-claude.mjs` for the full list).
  `claude` is the POSIX shim and `claude.cmd` the Windows one.
- `drive-pipeline.mjs` — drives a plan end to end through the fake `claude`
  (`--runner fake`, the default) so auto-advance, parallel task scheduling and
  dependency chains can be tested without spending anything, or through a real
  `opencode` (`--runner opencode`). The VS Code integration scenarios
  (`packages/vscode/src/test-integration/`) use the same fake via `PATH`.
- `pipeline.test.mjs` — runs the driver under `node:test`. Needs core built
  first (`npm run build:core`).

## Scale benchmark (`bench/scale/`)

Where one daemon breaks: what the scheduler, the store, the saves, the view, the
supervisor's wake-ups, the task logs and the MCP server cost against plan size
and live sessions, with fake runners. Bundles core's source itself, so it needs
no build. See [its README](scale/README.md) for the commands and how to read them.

## Runner-detection lab (`bench/lab/`)

A throwaway `HOME` and a shim bin dir that decide, for one run, which
coding-agent CLIs the host appears to have installed — so a machine with Claude
Code installed can still test the "nothing here" first run, and a Codex-only or
OpenCode-only one can be faked without uninstalling anything.

- `lab.mjs` — builds the lab (fresh `HOME`, `bin/`, a throwaway git repo) and
  writes a shim per runner: one that prints a version reads as installed, one
  that exits 1 reads as absent. The install probe searches the process's own
  `PATH` first, so a shim in `bin/` shadows a real binary further down. Run
  `node bench/lab/lab.mjs --scenario <name>` to print ready-to-run env for the
  TUI and the VS Code extension. Scenarios: `none`, `claude-only`, `codex-only`,
  `opencode-only`, `claude+opencode`, `all`. `--root <dir>` builds the lab at a
  fixed path instead of a fresh temp dir (wiped first, so re-runs start clean):
  the `Run Extension (no harness, no key)` debug configuration in
  [.vscode/launch.json](../.vscode/launch.json) expects one at `/tmp/ordewell-lab`.

  ```bash
  node bench/lab/lab.mjs --scenario none --root /tmp/ordewell-lab
  ```

  The shims are what make a scenario honest — absent runners need their exit-1
  shims even though nothing is on the lab PATH, because the probe's augmented
  PATH ends in the well-known bin dirs (`/opt/homebrew/bin`, ~/.local/bin, …),
  where a real CLI would otherwise answer and "none" would not mean none.
- `lab.test.mjs` — asserts the real `RunnerInstallation` probe against each
  scenario, that a failing shim shadows a real CLI, and that a CLI installed
  while the host runs is seen after `refresh()`. Needs core built first
  (`npm run build:core`).

The shim tests the *detection* path only: a version stub makes a runner
selectable, not runnable. End-to-end execution uses `bench/pipeline/fake-claude`.

## Tests

The unit-style suites here use `node:test`, not vitest, so `npm test` does not
pick them up. They need core built first, and CI runs them right after the
built core exists:

```bash
npm run build:core
npm run test:bench
```
