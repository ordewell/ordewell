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

## Where run data goes

A harness that runs a real model, provider or account writes its output
(reports, transcripts, session logs, builds) to a per-user directory outside any
repository, never into the working tree, ignored or not. `<bench dir>` is
`$ORDEWELL_BENCH_DIR` when set; otherwise `$XDG_DATA_HOME/ordewell-bench`, or
`~/.local/share/ordewell-bench`, on Linux and macOS; otherwise
`%LOCALAPPDATA%\ordewell-bench` on Windows. Each harness has a subdirectory
(`planner-eval/results`, `planner-eval/builds`, `live/real-report`). A harness
refuses to start, with a message naming `ORDEWELL_BENCH_DIR`, when the directory
it would write to is inside the repository working tree. The one resolver is
`bench/lib/data-dir.mjs`.

Not run data, and so unchanged: the mock-driven screenshots in
`bench/live/screenshots/`, `bench/scale/.build` (a bundle built from source) and
the temporary directories a test makes for itself. The ignore entries for the
old in-repo paths (`.results/`, `.builds/`, `.real-report/`) stay, for a
checkout that still holds data from an earlier version; nothing moves it.

## Live conversation harness (`bench/live/`)

End-to-end testing of the planner conversation loop (ADR-0002) with the real
core stack:

- `mock-provider.mjs` — a local OpenAI-compatible server simulating budget-model
  quirks (streamed reasoning, fenced JSON with trailing commas, prose preambles,
  empty turns, grilling-ignoring eagerness). Deterministic and offline. Binds
  127.0.0.1:3799 when started by hand; `--port 0` binds a free port and prints it
  on the ready line, which `start-mock.mjs` parses for every script and test
  that starts one, so concurrent runs never share a port.
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
- `webview-delegation.mjs` — draws the delegation views of the same bundle
  (a delegated task's card, its checkpoint, its handoff) and asserts them, with
  the host telling the page delegation is offered and not (ADR-0055 D21).

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
behavioural report to `<bench dir>/live/real-report/` (see
[Where run data goes](#where-run-data-goes)), or `--out DIR`, which `--dump DIR` also
must keep outside the repository:

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

## Planner eval (`bench/planner-eval/`)

A planning-only A/B of the planner prompt on real models, driven through the
real `ordewell` terminal UI. Each run goes as far as `submit_plan` and stops
there; it never approves or runs a plan. Two variants are compared: the
baseline build with two nudges in the goal and the candidate build without them. Each submitted plan is measured,
checked against the goal's answer key and reviewed by a citation-checked
rubric. The report gives a verdict per backend for each comparison.
`node bench/planner-eval/run.mjs --mock` is the offline dry run against
`bench/live/mock-provider.mjs`; `--smoke` and `--full` run the real models.
See [its README](planner-eval/README.md) for prerequisites, every flag and
what each metric means. It writes its results and its builds to
`<bench dir>/planner-eval/`.

## Commit0 (`bench/commit0/`)

The driver for comparing the built-in runner, `openrouter`, on Commit0
libraries two ways, on one model. Arm A is one hand-written task assigned to
that runner with no planner. Arm B is `ordewell plan --goal <the same
text> --runner openrouter --no-chat --yes`, then `ordewell run` and `merge
--yes`. Each library and arm runs in its own container on an internal Docker
network. The only way out is a gateway (core's egress sidecar) that opens
`openrouter.ai` alone. Inside, the box runs Ordewell packed from a built tree's
`dist/`, with `ORDEWELL_NO_MODELS_DEV=1`.

```bash
npm run build
node bench/commit0/drive.mjs --dry-run --fixture --image <a python image with pytest and git>
node bench/commit0/drive.mjs --dry-run --libs <libraries.json>
node bench/commit0/drive.mjs --sweep
```

### How the arms are held equal

- **D1. One budget.** Both arms get the same wall-clock cap (3 hours) and the
  same spend cap, `--cap-usd` (default 8). A run that meets either is stopped
  and labelled `stopped: {why: 'spend' | 'wall-clock'}`.
- **D2. Arm A is one agent alone**: supervisor off, one task, mode `full`,
  nothing started or merged on its behalf. It is scored on its working tree's
  final state whether or not its task passed: when the task did not land, the
  files of its worktree (committed and uncommitted work alike), or of its
  newest preserved branch when the worktree is gone, are the ones scored.
  That is what one agent working in a directory would be scored on.
- **D3. Arm B is Ordewell as its user runs it**: supervisor at Act, autorun on,
  automatic merging on, and `ORDEWELL_MAX_PARALLEL` from `--parallel` (default
  8). It is scored only on what Ordewell merged into the workspace: work with
  no passing verdict does not count, which is Ordewell's own rule. The
  unlanded work of its non-passing tasks stays in the run's `arm-workdir/`
  copy for diagnosis, listed in `patches`, and is never scored.
- **D4. A fixed quota per box**: `--cpus` (default 8) and `--memory` (default
  `12g`, swap held to it) apply to the box container, so a run's wall-clock
  does not depend on what else the host runs.
- **D5. A run is judged by its tasks' states**, read from the session, never
  by `ordewell run`'s exit status: that may be non-zero when a task failed, and
  at Act it may return only after the supervisor's closing turn, which can
  retry a task. The driver tolerates both, and ends a run when it is capped,
  stalled, never started, or settled (nothing running, nobody waited on,
  nothing moved for five minutes).

A run stalls when, for `--stall-min` minutes (default 15), no attempt runs and
a task waits on a person (a checkpoint, an input, an approval or an open user
task, which nobody in the bench does). It is
recorded as `stalled: {task, waiting, question, sinceMs}`, stopped and scored:
a result, not an abort. Every end goes the same way: `ordewell stop` for the
session, waited for; the `plan` and `run` followers ended, never a `merge`;
`ordewell merge` of what landed; the daemon stopped; and no Ordewell process
left in the box before the closing spend reading. On SIGINT, SIGTERM or an
uncaught error the driver removes its own containers and network. Everything
it starts is labelled with its `<host>/<pid>`, and `--sweep` removes the
labelled containers and networks whose driver on this host is no longer running.

### Options

| Option | Default | |
| --- | --- | --- |
| `--cap-usd <usd>` | 8 | the spend cap, both arms |
| `--parallel <n>` | 8 | arm B's `ORDEWELL_MAX_PARALLEL`; arm A runs one task |
| `--cpus <n>` | 8 | the box's CPU quota |
| `--memory <size>` | `12g` | the box's memory quota |
| `--stall-min <min>` | 15 | how long a person may be waited on with nothing running |
| `--ordewell-root <dir>` | this tree | the built tree packed into the box |
| `--allow-stale-dist` | off | run a dist older than its sources; the result is not valid |
| `--sweep` | | remove boxes of dead drivers; alone, nothing else runs |

The tree `--ordewell-root` names is pinned: its HEAD sha is recorded, a tree
with tracked changes is refused, and so is a `dist/` older than its newest
tracked source under `packages/core/src`, `packages/web/server` and
`packages/cli/src`, unless `--allow-stale-dist` is passed. The driver builds
nothing.

### Dry run

`--dry-run` sets up everything a run would and runs every check, but makes no
model call, and the OpenRouter key never enters the box. It checks:

- the tree holds the PR 177 merge, is clean, and its dist is fresh
- `--sweep` removes a dead driver's container and network and keeps a live one's
- the egress: only openrouter.ai answers, through the gateway or around it
- the model's context window, from OpenRouter's listing and the offline catalog
  (a missing window or the fallback value fails the run)
- the reference implementation is out of reach: not in `git log --all`, not in
  site-packages, not in a pip archive (a planted leak proves the probe catches it)
- the tests collect with the dependencies already in the image: the count is
  taken at the reference commit, before the history goes, and is the
  denominator; at the stubs, which break imports, only a missing module fails
- the count of network-marked tests left out
- per arm, the settings are written and the box's daemon reads them back
  (supervisor off for A, at Act for B, autorun, automatic merging, the
  parallel limit), and the engine holds the box's quota
- the patch chooser, on a worktree layout built with git and read on the host
  from its copy: a task's own worktree, never the integration one; a gone
  worktree's newest `ordewell-preserved/<run>/...` branch, its files written
  out whole; an open subtask as not landed; and no `.venv` read as work
- the stop path on an idle session leaves no Ordewell process
- a fixture arm, in place of a model: it writes the reference's source in,
  adds a module inside the library and imports it, edits a test, and sets a
  smudge filter and `core.fsmonitor` in the workspace's git. The fresh eval
  must count the source and the added module, keep the reference's test, run
  neither the filter nor the monitor (in either box), and pass more tests than
  the baseline

### Running

Each step that would call the model is reported UNVERIFIED. `--run` runs the
arms and spends on the key in `OPENROUTER_API_KEY`. That key must be one the
run has to itself, its limit set to the cap and its provider pinned in the
OpenRouter account, since a request cannot pin it. Pass that provider as
`--provider-pin` so every result records it.
`libraries.example.json` shows the shape of a library list. Results, per library
and arm, go to `<bench dir>/commit0/` (`dry-runs/`, `runs/`, `results.jsonl`),
and so does the packed runtime (`runtime/<sha>-<dist build>`). A library's `testCmd` defaults
to the venv Commit0's images install into, `<workdir>/.venv/bin/python -m pytest`,
since `docker exec` puts it on no PATH. The driver ignores `/.venv` in the
workspace's `.git/info/exclude`, so an agent's own `git add -A` never commits the
link core's worktree bootstrap makes to it.

Every run is scored in a fresh box, never in the one its agent worked in.
When an arm ends (settled, capped or stalled) its box is stopped and its
workdir, `.venv` left behind, is copied to the run's `arm-workdir/` by the
engine (`docker cp`): nothing in that box runs again, so no git configuration,
hook or process the arm left there touches the score. The files to score are
read on the host from that copy (D2, D3; a preserved branch is written out by
a git that reads none of the copy's configuration), and from there both arms
take one function, `scoreFiles` in `lib.mjs`. It starts a box from the same
image and quota with no network, mount, key or Ordewell; runs the same flatten
and leftover cleanup, and checks that it yields the tree the arm's box did;
then puts in only the files under the workdir that differ from that commit,
and removes the non-test files the arm deleted (`selectScoredFiles`). It
leaves out, each recorded in `excluded` with why: the tests under `testDir`
(`test_*.py`, `*_test.py`, `tests/` and `unit_tests/`); test configuration
(`conftest.py`, `pytest.ini`, `.pytest.ini`, `pytest.toml`, `.pytest.toml`
and `tox.ini` anywhere; `setup.cfg` and `pyproject.toml` are kept whole as the
reference has them); `.git` at any depth, `.venv`, `.ordewell`, bytecode
(`__pycache__`, `*.pyc`, `*.pyo`), compiled modules (`*.so`, `*.pyd`) and other
caches; a link out of the workdir; and a
new top-level module, at the workdir root or beside a src layout's package,
named like something the eval imports (`pytest`, `_pytest`, `pluggy`, the
timeout plugin, a stdlib module). An edit to test configuration or such a
module still lets the run be scored, but marks it `needsInspection` with the
reason. `arm.patch` is the fresh box's diff once the files are in. The
baseline, in the arm's box before the arm, and the scored eval, in the fresh
one, run one eval command and bound each test at 120 s (a pytest
plugin the driver writes to `/opt/commit0-bench`, since the images carry no
pytest-timeout) and the whole run at 1800 s, so a stub that spins fails its one
test instead of losing the count.

`result.json` records, beyond the counts: `valid` and `invalidReasons` (an
abort, a failed check, an eval that timed out or gave no summary, more test
outcomes than the reference collected, a stop by the batch budget, which cut
this arm short of its pair's cap, an allowed stale dist); the arm's `supervisorLevel`, `autorun`, `automerge`, `parallel`,
`cpus`, `memory`, `capUsd` and `wallCapMs`; `tests.exit` and `tests.timedOut`;
`stopped` and `stalled`; `scoredFrom` (`merged` or `task-worktree`) and
`patches`, each with the worktree or branch it came from and whether it was
scored (`arm.patch` is always the scored diff); `evalBox: 'fresh'`,
`excluded` (`[{path, reason}]`) and `needsInspection`; and
`staleDistAllowed`. A stub
baseline that collects nothing (networkx's and sphinx's stubs do not import)
is recorded as `baseline: {collected: 0, reason}`, not failed. Its offline
tests are `bench/commit0/commit0.test.mjs`.

The original implementation is off limits to both arms, and their shared
goal text says so: the agents must not look for it in caches, compiled files,
installed packages or on the network, and write it from the docstrings and the
tests. The driver backs that up: after the flatten it removes every untracked
and ignored file but `.venv`, the leak probe fails the run on any that is
left, and no bytecode crosses into the eval box.

### Threat model

The arms are not adversaries: they are agents told what is off limits, and
the harness makes their mistakes and shortcuts not count. It guarantees that
nothing from an arm's box reaches the eval except its source files, that the
tests and the test configuration the eval runs are the reference's, and that
both arms are treated identically, from their files onward through one
function. It does not claim to stop an implementation that falsifies results
from inside the library's own code (a module that patches pytest when the
library is imported, say), which no harness of this kind can. Such a run shows
in the diff, which is kept with every result as `arm.patch`, and in the
`arm-workdir/` copy.

### Batches

`batch.mjs` runs a list of libraries and arms with up to `--jobs` runs at
once, each a `drive.mjs` process with its own box at the fixed quotas, on one
key whose lock the batch takes once:

```bash
node bench/commit0/batch.mjs --dry-run --libs <libraries.json> --jobs 2
node bench/commit0/batch.mjs --run --libs <libraries.json> --provider-pin <provider> --batch-budget-usd <usd>
```

| Option | Default | |
| --- | --- | --- |
| `--jobs <n>` | 2 | runs at once |
| `--batch-budget-usd <usd>` | required with `--run` | stop every run when the key's usage since the batch began reaches it |
| `--only`, `--arm` | every library, both arms | which runs |
| `--seed <label>` | none | kept in each `result.json` and run directory's name |
| `--sweep` | | sweep before the batch |

The other `drive.mjs` options are passed to every run. A batch refuses to
start when `--jobs` times `--cpus` exceeds the host's CPUs or `--jobs` times
`--memory` exceeds 80% of its memory. A run that fails leaves the others
running. Each run's spend cap acts on what Ordewell recorded for its session
(`recordedUsd`: the planner's turns, the supervisor's and every attempt's).
A paid batch reads the key's usage before its first run, retrying, and
refuses to start when it cannot, since the budget measures from that reading.
When the batch budget is met, every run stops through its own stop path. On
SIGINT or SIGTERM the batch passes the signal to its running runs and starts
none of those still queued. The
runs and `batch.json` go in `runs/batch-<time>[-<seed>]/`. `batch.json` holds
the key's usage before and after, the recorded sum and the gap. When runs
overlapped, a run's `billedUsd` is null and `billedSource` says why; a run
alone keeps its key delta.

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
  A planner is driven the same way, from a file of tool calls per turn
  (`{"turnsFrom":"<path>"}`), which is how `delegatedTask.harness.e2e.test.ts`
  runs a subplanner.
  `claude` is the POSIX shim and `claude.cmd` the Windows one.
- `fake-acp/` — a deterministic stand-in for an ACP v1 agent, put first on
  `PATH` as `copilot` so the real `copilot-cli` connector (`AcpAdapter`) drives
  it as `copilot --acp --stdio`: no model, no API key. It answers `initialize`
  with HTTP MCP support, remembers the Ordewell server `session/new` hands it
  (url and `Authorization` header), contacts it eagerly as Copilot does, and
  completes a task only by calling `task_complete` on it over Streamable HTTP.
  A task steers it with the same cue style as `fake-opencode`:
  `<fake-acp>{"delayMs":300,"write":{"A.txt":"hi"},"status":"blocked","reason":"why"}</fake-acp>`
  (all fields optional; `edit` asks through `session/request_permission`, and
  `calls` reaches the planner tools). `copilot` is the POSIX shim and
  `copilot.cmd` the Windows one.
  The pipeline plans through its API planner, so it drives `copilot-cli` as a
  task runner only; the fake's planner half (`role: "planner"`) is there for a
  driver that starts it as the planner.
- `drive-pipeline.mjs` — drives a plan end to end through the fake `claude`
  (`--runner fake`, the default) so auto-advance, parallel task scheduling and
  dependency chains can be tested without spending anything, through the fake
  ACP agent as `copilot-cli` (`--runner acp`), or through a real `opencode`
  (`--runner opencode`). The ACP case also has `--case no-completion`: one task
  whose agent works and exits without calling `task_complete`, which must not
  pass. The VS Code integration scenarios
  (`packages/vscode/src/test-integration/`) use the same fake via `PATH`.
- `pipeline.test.mjs` — runs the driver under `node:test`. Needs core built
  first (`npm run build:core`).
- `fake-provider/` — a stand-in for Anthropic's token endpoint and Messages API,
  for the real Claude Code binary: TLS under a test CA, reached only through a
  CONNECT proxy of its own, with refresh tokens that work once. It involves no
  account and no real token. `dockerLease.e2e.test.ts` runs it in a container
  when `ORDEWELL_E2E_HARNESS_IMAGE` names an image with Claude Code in it.

## Scale benchmark (`bench/scale/`)

Where one daemon breaks: what the scheduler, the store, the saves, the view, the
supervisor's wake-ups, the task logs and the MCP server cost against plan size
and live sessions, with fake runners. Bundles core's source itself, so it needs
no build. See [its README](scale/README.md) for the commands and how to read them.

## Real-engine check (`bench/containers/`)

What makes `npm run test:containers` a verdict and not a test run. That command
(`scripts/container-e2e.mjs`) builds an image holding all three real harnesses, runs
the container suites against the engine `docker` talks to, with a stand-in model
in place of each provider, and asks `verdict.mjs` what the run proved. A skipped
test, or a harness whose real binary was not proven, reads as `UNVERIFIED`, not a
pass. CI's `real-engine` job runs it on Linux; on a Mac it is yours to run, as
[docs/containers.md](../docs/containers.md#checking-it-yourself) says.

- `verdict.mjs` — pure: counts vitest's JSON report and names the outcome, the
  engine it ran on and each harness's proof.
- `verdict.test.mjs` — its tests, under `npm run test:bench`.

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
