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
  and labelled `stopped: {why: 'spend' | 'wall-clock'}`. The built-in runner's
  budget of model calls per attempt is the same for both arms too, `--call-budget`
  (default 1000): every `result.json` records it as `callBudget`, and a pair whose
  arms ran with different ones is not valid (`pairs` in `batch.json`, and the
  rehearsal's pair check).
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
| `--call-budget <n>` | 1000 | the built-in runner's model calls per attempt (core's `ordewellStepLimit`), both arms; a single agent that ends its attempt for want of it shows in `ending.modelCalls` |
| `--parallel <n>` | 8 | arm B's `ORDEWELL_MAX_PARALLEL`; arm A runs one task |
| `--cpus <n>` | 8 | the box's CPU quota |
| `--memory <size>` | `12g` | the box's memory quota |
| `--stall-min <min>` | 15 | how long a person may be waited on with nothing running |
| `--settle-min`, `--no-start-min`, `--poll-sec`, `--wall-min` | 5, 10, 30 s, 180 | the settle window, the no-start bound, the poll interval and the wall-clock cap, which a rehearsal shortens |
| `--rehearse <scenario>` | | run the arms on the scripted fake provider (see Rehearsal) |
| `--plan-only` | off | arm B's planning alone, then stop: nothing runs, merges or is scored (see Plan-only) |
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

### Rehearsal

The dry run starts no agent, so it cannot see how the driver follows, stops
and scores a live run. The rehearsal can. Run it on the real image before any
paid run, and again after any change to `drive.mjs`, `lib.mjs` or `batch.mjs`:

```bash
npm run build
node bench/commit0/drive.mjs --sweep
node bench/commit0/rehearse.mjs --libs <libraries.json> [--only tlslite-ng] [--scenario a-done,b-cap] [--ordewell-root <dir>]
node bench/commit0/rehearse.mjs --libs <libraries.json> --pairs <libA,libB> [--cpus 2 --memory 4g]   # the pairs and batch.json, below
```

`--ordewell-root` is `batch.mjs`'s: the driver refuses a tree with tracked changes
(this one, while you edit the bench), so name a clean checkout of the commit,
built, to pack into the box. A rehearsal's leftover check counts only the boxes
and networks that carry its own seed, so another driver running on the host
is never mistaken for its stray.

Each scenario goes through `batch.mjs` and `drive.mjs` as a paid run does: both
arms really run, through the same code, on the library's image. Only the model
is replaced. `rehearsal-fake.mjs` is an OpenRouter-shaped endpoint on the box's
own loopback, where the box's `OPENROUTER_BASE_URL` points, since the gateway
lets nothing through to a private address. It plays the scripts in
`rehearsal.mjs` to the planner, the built-in runner and the supervisor, and it
prices each call through the usage it reports. The box's key is a placeholder.
`rehearse.mjs`, `batch.mjs --rehearse` and `drive.mjs --rehearse` each refuse to
start while a real credential is in the environment, and none of them reads
the key's usage. The settle, no-start, stall and wall-clock windows are
shortened. Results go to `rehearsals/`, never to `results.jsonl`.

The scripted agent's edits are the reference source (copied into the box after
the leak probe has found it out of reach), a new module inside the library that
the package imports, and an edit to a test file. Every scenario checks the
fields its `result.json` holds. Each one also checks that its `batch.json`
holds its one run and is marked finished (the batch's last write), that `results.jsonl` did not grow, that the fake played the
last scripted step of every attempt the scenario needs, and that no container
or network of the bench is left behind:

| Scenario | Arm | What happens | What `result.json` must say |
| --- | --- | --- | --- |
| `a-done` | A | the task's first step is a `sleep 300`, then it makes the edits and reports done | valid; `ordewell run` returned by itself with exit 0; not truncated; 1 task completed; more passed than the baseline; the test edit excluded; the sleep was refused before it ran, in a reply that names `wait_for`, and answered at once |
| `a-failed` | A | one shell command runs past the settle window, then the edits, then the task reports failed | not stopped while the command ran; settled with 1 task open; scored from the task's unlanded worktree; more passed than the baseline; the test edit excluded |
| `a-stall` | A | the task makes the edits, then asks a checkpoint that nobody answers | ended by the stall rule (`stalled: waiting on checkpoint`), not by a cap; never complete; the attempt cut short; scored from the task's unlanded worktree; more passed than the baseline |
| `b-retry` | B | task 1 fails while task 2 waits on it; the supervisor at Act retries it fresh, then answers task 2's checkpoint | not truncated; 2 tasks completed; scored from merged work; more passed than the baseline; the supervisor played `retry_task` and `answer_checkpoint`; `metrics.supervisor` counts exactly those two acts and no wake for a failure the closing turn left |
| `b-leave` | B | task 1 fails while task 2 waits on it, and the supervisor leaves it, at the closing turn and again at the second wake core raises for the failure left standing | ended by the settle rule with both tasks held open, which the stall record names, since nobody is waited on; never complete; scored from merged work, at the baseline, since nothing landed; the supervisor said it left the task; `metrics.supervisor` holds no act but words, and exactly one wake for the failure the closing turn left (never a third) |
| `b-edit-retry` | B | task 1 fails; the supervisor's closing turn edits it (a reply with task ops, as the built-in planner has no `edit_plan` tool) and retries nothing; the second wake, for the failure left standing, retries it; the run goes on to its end | not truncated; 2 tasks completed; scored from merged work; more passed than the baseline; `metrics.supervisor` counts `plan_edit` then `retry_task`, the retry after the closing wake, and one wake for the failure left standing; the closing task ends done with a finding, and its note file is in the merged work |
| `b-take-in` | B | two tasks side by side: the producer makes the edits and reports done; the consumer runs a long step so that the producer lands, writes a note and commits it, then runs the merge command its own first message gives (the fake reads it out of that message), checks the producer's module is in its worktree, and reports done | the consumer's first message holds the `## Work landing beside yours` block and a command to take the work in with; the commit, the merge and the check each exited 0; the run's integration branch holds a two-parent `Merge: ... (take in landed work)` commit; not truncated; 2 tasks completed; scored from merged work; more passed than the baseline; the test edit excluded |
| `b-wait` | B at `--parallel 2` | three tasks side by side, the third queued behind the limit: the consumer's first step calls `wait_for` on the producer, which is still at work; the consumer's turn ends in prose; the producer lands; the consumer goes on, makes its edit and lands | the call was granted; the consumer reported nothing before it was continued, and went on in the same session only after the producer's last turn, its request holding "The work you waited for has landed" and the producer's title; the third task started after the call and before the producer's last turn; the final plan shows the consumer depending on the producer, with the park it saved; not truncated; 3 tasks completed; scored from merged work; more passed than the baseline; the test edit excluded |
| `b-blocker` | B | the opening task lands its edits; two slices after it end done with a `blocker` finding that cites it; the first reports at once, the second is at work, and the closing check waits for both; the supervisor's wake answers with one edit that adds a fix task and makes the closing check wait for it | the wake the supervisor was sent holds the landed-blocker line for task #1, the closing check and the guidance; the supervisor answered it; the final plan holds 5 tasks, one the fix, which depends on the opening task and which the closing check waits for; the fix's last turn came before the closing check's first, and the check found the fix's file in its tree; `metrics.supervisor` counts exactly one `plan_edit` and every wake's trigger is one the harness reads; not truncated; 5 tasks completed; scored from merged work; more passed than the baseline |
| `b-plan` | B, `--plan-only` | the planner returns a six-task plan with a research task, three changes, an ops task and a script that checks a loop; nothing else is scripted | marked `planOnly` and never valid; the shape the plan has (6 tasks, chain of 4, widest level 2, 6 edges, one gate, one loop check); a priced planner and a planning time; no `run` or `merge` step, no score, no tests; `plan.json` and `plan-saved.json` in the run's directory and no `arm-workdir/`; the fake heard no runner and no supervisor; `plans.jsonl` did not grow |
| `b-cap` | B | task 1 lands its edits, then task 2 reports usage past `--cap-usd` mid-attempt | stopped by the spend cap; the driver stopped `ordewell run`; the merge ran; scored from merged work; more passed than the baseline |

`b-take-in` proves, in the real box, that the built-in runner's shell lets a task
run the merge its first message gives and that the merge lands: the fake reads
the command out of that message (a step with `fromPrompt`), so a change to the
sentence that carries it, or to its merge message, fails the scenario. The
consumer commits a note of its own before it takes the work in, as the message
tells it to: with nothing of its own the merge is a fast-forward and makes no
commit. `ordewell merge` folds the integration branch into the workdir's own
and deletes it, so the judge reads the merged history from `HEAD`.

`b-wait` and `b-blocker` prove, in the real box, the two ways one task's work reaches another: a task that needs a sibling's unlanded work parks instead of sleeping (the plan gains the edge, its slot goes to the next task, and its session is continued once that work lands), and a blocker that tasks report in landed work reaches the supervisor, whose one edit adds a fix that lands before the check of the whole starts. The judges read what the fake heard (each request's time and messages) and the session's final plan, which the run's directory holds. In `b-wait` the consumer's session is resumed, so its continuation is the same attempt: a runner that started a fresh attempt fails the scenario, since the built-in runner saves a session it can resume. `a-done`'s `sleep 300` is the guard of the built-in shell, which refuses a change task's long sleep before it runs.

`--pairs <libA,libB>` adds one batch of both arms of two libraries at `--jobs 2`,
on one scenario (`--pair-scenario`, default `a-done`, whose script only arm A
plays: what it proves is the schedule and the record, not a score). It checks
that each library's A and B started together and that the second library's pair
started only after both of the first's had ended, that `batch.json` is finished
and whole (no half-written file beside it) with a result directory for every
run and no key reading, that `results.jsonl` did not grow, and that nothing is
left behind. What a stop cuts in `batch.json` (a key reading after each run)
needs a key, so a rehearsal cannot cover it; `commit0.test.mjs` covers it with
a drive that stands in for the real one.

`npm run test:bench` runs the scripts' own logic and never starts the Docker
rehearsal. `ORDEWELL_COMMIT0_REHEARSAL=<libraries.json>` (with
`ORDEWELL_COMMIT0_REHEARSAL_SCENARIOS=a,b` for some) makes
`bench/commit0/commit0.test.mjs` run it.

Only a paid run can show what a real model does with the goal: how long its
attempts take, its usage and how OpenRouter bills it, the key's usage and the
batch budget's stop, provider routing, and whether a stream stalls or a call is
refused.

### What a run records of the supervisor

`metrics.supervisor` in `result.json` is read from the session's conversation
history (`supervisorRecord` in `lib.mjs`):

- `actions`: every act the supervisor made, each with `kind`, the `task` it
  names (`#n`, or null) and its `title`, its `outcome` (`done`, `refused` or
  `declined`) and `at`. A `kind` is a call at the command seam (`retry_task`,
  `skip_task`, `stop_task`, `stop_run`, `message_task`, `answer_checkpoint`,
  `answer_approval`, `merge_all`, and the rest), `plan_edit` (one per op of an
  edit it landed, with its `op`: the history keeps an edit as a "Tasks
  updated" entry, not as a call) or `message` (what it said to the user in
  prose, which every wake-up turn ends with). `actionsBy` counts them by kind.
- `wakes`: one entry per wake-up turn (digests delivered together share a
  timestamp), with `at`, `updates` (its digests) and `triggers`, each the
  `kind` of a line the digest names (`task_failed`, `run_finished`,
  `failure_standing`, `waiting_input`, ...; `other` for text the harness does
  not know) and its `task`. A `failure_standing` carries `closing: true` when
  it is the wake core raises for a failure the supervisor's closing turn left.
  `wakesBy` counts the triggers by kind; `wakeUps` counts every digest.

A session with no history leaves all of them null, never zero.

### Plan-only

`--plan-only` measures the shape of the plans Ordewell makes for a few cents a
plan, not a three-hour run. It runs arm B as far as its plan: the box, the key
check, the egress check, the context window and the leak probe stay, then
`ordewell plan --goal <the goal> --runner openrouter --no-chat --yes`. The plan is
written and judged (every task on `openrouter`, the model and a mode the runner
has), its shape is recorded, and the run stops: nothing is started, merged or
scored. It skips the reference collection, the baseline, the copy of the arm's
work, the choice of files to score and the fresh-container eval, so no test
count or `scoredFrom` is in its result.

```bash
# one plan
node bench/commit0/drive.mjs --run --plan-only --libs <libraries.json> --only <library> --provider-pin <provider>
# a batch: several libraries, repeated seeds, two builds to compare
node bench/commit0/batch.mjs --run --plan-only --libs <libraries.json> --provider-pin <provider> \
  --batch-budget-usd <usd> --jobs 2 --seed 1 [--ordewell-root <another built tree>]
```

Arm A has no plan: `--arm A` with `--plan-only` is refused, and `--arm both` (the
default) means B. It needs `--run` or `--rehearse`, not `--dry-run`. The spend
cap still ends a planner that spends past it, the batch takes the key's lock
and budget as it does for a scored batch, and the other options apply.

A plan-only run goes in `plan-runs/` (a batch in `plan-runs/batch-<time>[-<seed>]/`),
and its result in `plans.jsonl`, never `runs/` or `results.jsonl`. Its
`result.json` is marked `planOnly: true` and is never valid: `valid` is false and
`invalidReasons` says `plan-only: …`, so a filter on `valid` can never count it as
a scored run. `tests`, `baseline`, `scoredFrom`, `tasks` and `metrics` are null, and
`patches` is empty. `batch.json` carries `planOnly: true` too. The run's own
fields, `recordedUsd` (the planner's spend as Ordewell recorded it) among them,
hold as for any run, and `planned` holds its plan:

| Field of `planned` | |
| --- | --- |
| `shape.tasks`, `shape.subtasks` | top-level tasks, and the subtasks under them |
| `shape.kinds` | tasks by kind, each task once: `research`, `change`, `ops`, `script`, `user`, `delegated` |
| `shape.loopChecks` | tasks that carry a loop, counted besides their kind (a check is a script or an AI task) |
| `shape.longestChain`, `shape.levels` | the same number: a task's level is one more than its deepest dependency's |
| `shape.chain` | the longest chain's task titles in order (of equal chains, the one whose last task the plan lists first) |
| `shape.widestLevel` | the most tasks one level holds |
| `shape.edges` | dependencies, each counted once |
| `shape.gatedByOne`, `shape.gate` | whether one task is, directly or through others, a dependency of every other, and its title; false for one task |
| `shape.valid`, `shape.problems` | false with the reasons when a task depends on no task, an id repeats or there is a cycle: the graph's fields are then null, the counts kept |
| `plannerUsd` | the planner's spend as Ordewell recorded it (null when it recorded none) |
| `planningMs` | how long `ordewell plan` ran |
| `protocolOk`, `protocolFailures` | whether the plan passed the judge every plan passes |

`plan.json` holds every top-level task's `title`, `brief` (its prompt, or its
description), `dependencies` (ids) and `dependsOn` (titles), its kind, runner,
model and mode, and its subtasks; `plan-saved.json` is the plan as core saved it.
The shape is `lib.mjs`'s `planStructure`, one function for every plan, with
tests for a chain, a fan-out, a root gate, a cycle and an unknown dependency.

### Running

Each step that would call the model is reported UNVERIFIED. `--run` runs the
arms and spends on the key in `OPENROUTER_API_KEY`. That key must be one the
run has to itself, its limit set to the cap and its provider pinned in the
OpenRouter account, since a request cannot pin it. Pass that provider as
`--provider-pin` so every result records it. The flag only records: the built-in runner has no
setting that names an upstream (it sends OpenRouter a `provider` field only to
prefer the upstream that served the conversation's last turn, with fallbacks on,
or a fixed order for Anthropic models; the `:nitro` and `:floor` model suffixes sort
by speed or price, and none picks one), so a run is pinned only by the key's
account setting, and `providerSwitches` and `metrics.calls.byUpstream` show what served it.
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
`staleDistAllowed`. Of the run itself, `result.json` also holds:

| Field | |
| --- | --- |
| `planReview` | arm B's plan review, read from the `chain review: N -> M, kept; K tasks changed` line of the session's research log (the session keeps no structured field for it): `firstChain` (the longest chain as the planner first wrote it), `reviewedChain` (null when the review failed or was refused), `tasksChanged`, `kept` and `outcome`. Null when the log holds no such line (a chain under the review's minimum, or arm A) |
| `metrics.perTask[].attempts[].runningMs` | an attempt a stop cut has a running clock of 0; its `wallTimeMs` is then its running time, and the attempt says `runningFrom: 'wallTimeMs'` (that time includes any wait on a person) |
| `metrics.calls` | from the attempts' logs: `calls`, `byUpstream` (the `provider` of each of the built-in runner's usage records; `unreported` for one without it) and `coldAfterCall`: calls billed with under `coldShare` (5%) of their input cached straight after another call of the same attempt (a subagent's calls are counted, never judged). Null without the logs |
| `ending` | how the arm stopped, in `by`: `completion` (the arm's own word: `status` `done`, `failed` or `blocked` and the `reason` text the runner gave in `task_complete`, with each task's own in `reports`; a run the settle rule found holding only failed tasks and the tasks behind them is this too, the runner having reported and nothing left to move), `cap` (`cap` is `spend`, `wall-clock` or `batch-budget`, with `spentUsd` and `atMs`), `settle` (nothing moved for the settle window while a task was still open for another cause: `open` lists each with what held it, and `quietMs`), `stall` (a person waited on for `--stall-min`), `no-start`, or `not-run` (a dry run, a plan-only run or no task). For arm A `modelCalls`: `used` (the attempts' own calls, a subagent's apart in `subagentCalls`), `perAttempt`, `peakAttempt` and `reachedLimit` against `limitPerAttempt`, the runner's step limit, which is per attempt; null for arm B and without the logs |
| `callBudget` | the built-in runner's model calls per attempt this run ran with (`--call-budget`; `stepLimit` is the same number under its older name) |
| `referenceUsd`, `referenceSpend` | the run's spend recomputed from its token counts at one price table kept in `lib.mjs` (`REFERENCE_PRICES`, `priceTable` in the record; the model's list price per million tokens in core's offline catalog), so that the dollars of two runs and two arms compare: the upstream providers behind one OpenRouter model charged prices that differed several-fold between runs. `planner` (its ledger holds the supervisor's wake-up turns too) and each of `attempts` (`task`, `attempt`, subtasks included) give `freshInputTokens`, `cachedInputTokens`, `outputTokens` and `usd`; `tokens` and `usd` are the sums. An attempt with no token counts is counted in `unmeasured` and priced at nothing. `recordedUsd` and `billedUsd` stay what the providers charged |
| `providerSwitches` | from the same usage records' `provider`: `attempts` read, `withProvider` (those naming an upstream), `attemptsSwitched` (attempts whose upstream changed at least once) and `switches` (the changes; a record naming no upstream is skipped, a subagent's calls are left out). Null without the logs, as in a dry run, which shows `ending.by: 'not-run'`; the rehearsal's fake names no upstream, so it shows no switch |

A stub
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
| `--plan-only` | off | arm B's plan alone, for every run of the batch (see Plan-only) |
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
the key's usage before and after, the recorded sum and the gap. It is written
whole (a rename, never in place) when the batch starts and after every run
ends, with `finished: false` until the last write, and `keyReadings` holds the
key's usage as read at the start and after each run when a key is present, so a
host stop loses at most the runs that were going. With both arms and `--jobs`
2 or more, a library's A and B start together, and the next library's pair
starts only when both have ended (`--jobs 4` takes two libraries at a time). When runs
overlapped, a run's `billedUsd` is null and `billedSource` says why; a run
alone keeps its key delta. Beside the recorded sum, `perArm` holds each arm's
`recordedUsd`, `referenceUsd` (at the one reference price table, `referencePriceTable`) and
`referenceTokens`, and `pairs` says for each library with both arms whether they
ran under one call budget.

### Score over time

A finished run keeps the git history of its work, so its score can be read at
earlier points afterwards, with no key and no model call. For arm B every landed
task is a merge commit on `ordewell/<run>/integration`, with the time it
landed; for arm A the task's branch (`ordewell/<run>/<task>`) holds the commits
the agent made as it went:

```bash
node bench/commit0/timeline.mjs <run dir> --libs <libraries.json> [--points 8 | --minutes 20,40,60] [--jobs 2] [--branch <ref>]
```

It picks `--points` less one (default 8) targets evenly in time over the run's
wall clock, each the newest commit at or before it, or the minutes after the run
began (the session's creation) that `--minutes` lists. The final tree is always
a point, and for arm B so is every landing after the last slice has landed: the
closing check's and whatever follows, found from the session's plan (the closing
check waits for every slice, so a landing later than its first attempt's start is
its or a later one's; a plan with no closing check keeps the last landing). These
come on top, so `--points` bounds only the evenly spaced part, and sparse late
landings are never all mapped to one commit and skipped. Arm A's points are as
`--points` says. Each point's source is written
out by the harness's own `materialize` and scored by its own
`scoreInFreshBox` (`drive.mjs` exports both and runs nothing when loaded; it is
then always a dry run), in a fresh box on no network, with no key: any key in the
environment is removed first. At most `--jobs` containers run at once. It
writes `timeline.json` into the run directory (`timeline/<point>/` holds each
point's `score.json`, `arm.patch` and `tests.log`). The final point must score
as `result.json` does (passed, failed, errors); when it does not, the timeline
says `verified: false` and why, and the exit is non-zero, as it is when a point
could not be scored. Arm B's history is the first-parent line of its integration
branch, and once the end-of-run merge has left only `commit0-base` in the
workdir, of that, which holds every landing; with `--branch` too it is the
first-parent line, never a full `git log`, which would reach a slice's own commit.
A point whose pytest was killed (exit 137) and printed no counts has no score: it
fails, is tried once more alone, and if it is killed again stays `ok: false`,
`killed: true` and out of `crossings`, the first point at which the passed tests
reach 25, 50, 75, 90 and 100% of those collected. `commit0.test.mjs` tests the choice of points and the
commit-to-time mapping on a repository it builds, the closing check's landing included, and the container call
through a fake `docker` on `PATH`.

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
