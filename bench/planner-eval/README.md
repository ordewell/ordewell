# Planner eval (`bench/planner-eval/`)

A planning-only A/B of the planner on real models. Each run hands one goal to
the real `ordewell` terminal UI, answers the planner's questions with a fixed
line, and stops once `submit_plan` lands. It never approves, runs or merges a
plan. The submitted plan is then measured, checked against the goal's answer
key, and optionally reviewed by a rubric.

The question it answers: does the candidate planner prompt, given no nudges,
break the goals' answer keys no more often than the baseline given nudges, and
without telling the user to operate a control the terminal UI does not have?
How parallel and how delegated each side planned is reported beside that, and
judges nothing.

## Variants

| Variant | Build | Goal text | Environment |
| --- | --- | --- | --- |
| V0 | `--baseline-ref` (default `0ecc6412`) | the goal, then the two nudges below, verbatim | — |
| V1 | `--candidate-ref` (default `HEAD`) | the goal alone | — |
| V2 | `--candidate-ref` (default `HEAD`) | the goal alone | `ORDEWELL_PLANNER_READ_LIMIT=on` |

V2 is V1 with the planner's own reads capped per turn at the default limit
([ADR-0068](../../docs/adr/planner-envelope/0068-a-limit-on-the-planners-own-reads-per-turn.md)). It
runs only when `--variant` names it, or on `--mock`, and each of its records
carries the environment it ran under as `env`.

V0's nudges, each its own paragraph:

> Parallelize as much as possible.
>
> Keep your context as clear as possible: make use of research tasks to surface to you only the relevant information to make decisions.

Each ref is built once into its own git worktree under
`<bench dir>/planner-eval/builds/<sha12>` (see [Where run data goes](#where-run-data-goes);
a worktree may live anywhere, so it is outside this checkout), in the order core,
web, cli. A second run reuses that build. With
the default refs, a checkout at `0ecc6412` builds the same commit for both
sides. To compare a prompt change, pass `--candidate-ref` with its branch or
commit. Each build is a worktree of this checkout. To free one, run
`git worktree remove --force <bench dir>/planner-eval/builds/<sha12>`.

## Target

Every run plans against a throwaway repository: a `git archive` of the baseline
ref, committed as one commit in a fresh `git init` with no remote. G4's goal
first applies its bug patch (`setup.patches` in
`goals/g4-failure-to-explain.json`), which makes exactly two core tests fail.

Each run gets its own clone of the template, under the OS temp directory, or
under `~/.cache` when only that shares the builds' file system. The baseline
build's `node_modules` are put into each clone as real files: hard links where
the file system allows, copies where it does not, and each workspace link
recreated as it was, so `@ordewell/core` resolves to the clone's own package
rather than the build's. The clone is removed afterwards unless `--keep` is
given.

The planner may run the tests there without asking. `TEST_COMMANDS` in
`lib/config.mjs` (`npx vitest run`, `npm test` and their kin) reach the
planner allowlist (ADR-0026) through `ORDEWELL_APPROVAL_ALLOW`. A command no
rule covers runs sealed and is stopped at a minute, which a cold vitest start
can take. The bench grants this, not the planner prompt.

## Goals and answer keys

| Goal | What it asks | What the key expects |
| --- | --- | --- |
| G1 | per-task token usage on every surface | a leading task that decides the usage shape, which every surface task depends on; 3–8 tasks. Width is compared with 4–6 slices ±1, reported only |
| G2 | rename a persisted field, with migration | the rename and its migration kept together (one task, or a serial chain); 1–3 tasks; no parallel split |
| G3 | a hint's wording fix plus its test | one task |
| G4 | a findings badge names the mildest severity | 1–5 tasks. Reproduce first: the planner ran the failing test and saw its result, a reproduction task precedes every fix, or the fix runs the failing tests before it changes code. The fix, or a task after it, runs the named tests. Hypotheses go to research tasks before the fix only when no fix names the cause |
| G5 | which child-process spawn sites pass `process.env` unfiltered, then a helper that filters it | 3–7 tasks; at least two agents or research tasks, briefed by package, before any change; the planner's own reads at most 10 and 60 KB. Width is compared with 2–5 slices ±1, reported only |

Each `goals/gN-*.json` holds the goal text and its `key`. The key's
`expectedStrategy` and `integrationRisks` are prose for the rubric reviewer.
The other fields are checked mechanically (`lib/keys.mjs`).

The task count counts the tasks that do the work. One verify/fix loop pair (or
one verify task where there is no loop) is left out, and a key's "kept
together" counts change tasks only: research, read-only, verify, loop and docs
tasks change none of the code it is about.

G4's fix may say it runs the failing tests first, as the planner is told to
have it do when it could not run them itself; that passes only with the
validation beside it. A planner's own test run counts only when its result
shows a test run (vitest's summary or a failing file): a refused or sealed run
saw nothing fail.

G5's `groundTruth` lists every source file that imports a child-process API at
the baseline commit, with the `git grep` that found them; a test checks the
list against that commit. `expectedSlices` sits beside the key, outside it, so
changing it leaves the key's hash alone.

## What a run does

1. It clones the target, picks a free port, and writes the run's own settings
   file, which `ORDEWELL_SETTINGS_PATH` points the TUI and its daemon at. The
   settings turn autorun off and automatic merging at gates on. They pick the
   cell's planner model and enable only the planner's runner (`--runners`
   overrides that).
2. It starts `ordewell tui` in the target under `script(1)` for a real
   terminal, with `AI_PROVIDER` and `ORCHESTRATOR_MODEL` set for the cell. The
   TUI starts its own daemon on that port.
3. It pastes the goal and polls the daemon's session every few seconds:
   - It answers a question with `No preference: decide yourself, note your assumption, and continue.`
   - It answers an outline with `Confirmed. Submit the plan.`
   - It answers any open planner approval card through the daemon's approval
     endpoint (allow, unless the goal file sets `"approvals": "deny"`). The
     TUI's approval overlay is modal and swallows a pasted reply.
   - It checks that each line it sent landed (the history grew, or the
     planner went busy) and sends it once more after 45 s if not.
   - It stops when the plan is submitted, on an error turn, on the run's
     timeout, or after 4 driver turns. A timeout with a planner approval card
     still open is its own outcome, `timeout with a pending approval`, counted
     as a timeout and in its own column of the completion table. A run stopped by the turn limit is
     recorded as no plan.
4. It saves the session (redacted) and computes the metrics and key checks.
   Unless `--no-review` is given, it also runs the rubric.
5. It stops the TUI and its daemon (`ordewell stop --server --port N` as the
   safety net), removes that daemon's token file, and removes the clone.

On an OpenCode Go cell whose planner reports a quota or usage limit, the run is
retried once with the same model family through OpenRouter (the cell's
`fallback`). The record carries `substitution: {from, to, reason}`, and the
report lists it.

## Backends

| Cell | Planner | Model |
| --- | --- | --- |
| `claude-code/haiku` | Claude Code | `haiku` |
| `codex/gpt-6-luna` | Codex | `gpt-6-luna` |
| `opencode/deepseek-v4.1-flash` | OpenCode | `opencode-go/deepseek-v4.1-flash` (fallback `openrouter/deepseek/deepseek-v4.1-flash`) |
| `opencode/glm-5.3-flash` | OpenCode | `opencode-go/glm-5.3-flash` (fallback `openrouter/z-ai/glm-5.3-flash`) |
| `openrouter/deepseek-v4.1-flash` | the API planner over OpenRouter | `deepseek/deepseek-v4.1-flash` |
| `openrouter/glm-5.3-flash` | the API planner over OpenRouter | `z-ai/glm-5.3-flash` |

`gpt-6-luna` is passed to Codex as written. Ordewell's own Codex aliases at the
baseline name the `gpt-5.6-*` family, so a Codex that does not know
`gpt-6-luna` fails the run with an error turn. To use another model, edit the
cell in `lib/config.mjs`.

### Which harnesses can plan

A harness plans when Ordewell can run it as the planner. Claude Code, Codex
and OpenCode do this natively (`CONNECTORS` in
`packages/core/src/services/harness/connectors.ts`). The ACP harnesses do it
when their profile says `roles.plans: true`, and at the baseline that holds
for:

- GitHub Copilot CLI (`copilot-cli`)
- Qwen Code (`qwen-code`)
- Cline (`cline`)
- Gemini CLI (`gemini-cli`)
- Cursor Agent (`cursor-agent`)

These are the optional cells (`cline/default` and so on). They run with
`--with-optional`, or when `--backend` names them. They plan with the
harness's own default model, unless `--model` names one:
`--model cline=deepseek/deepseek-v4.1-flash,qwen-code=glm-5.3-flash` sets
`ORCHESTRATOR_MODEL` and the harness's own variable (`CLINE_MODEL` for Cline,
`OPENAI_MODEL` for Qwen Code, with the host's `OPENAI_BASE_URL` and key), runs
the cell under the id `cline/deepseek_deepseek-v4.1-flash` and records the model in
every result. Only those two harnesses can be named. Any other harness cannot plan through Ordewell,
and the API planner covers every OpenAI-compatible endpoint. `--list` names
each cell whose binary or key this host lacks, and the run skips it rather than
failing.

## Prerequisites

- Linux or macOS with `script(1)`. Windows has no `script(1)`, so the TUI
  cannot get a terminal there, and the driver refuses to start.
- `git`, Node and npm. The first run of a ref runs `npm ci` and the build in
  its worktree, which needs the network once.
- For each cell you run, its harness on `PATH` and logged in (`claude`,
  `codex`, `opencode`), or `OPENROUTER_API_KEY` in the environment.
- For the rubric, `claude` logged in with access to the review model
  (default `opus`).

The key is read only from the environment. It reaches only the runs that plan
through OpenRouter, and everything the bench writes or prints is redacted (the
key, the daemons' tokens, anything key-shaped).

## Commands

```bash
# Offline dry run: the mock planner, this checkout's build, every variant on G1.
node bench/planner-eval/run.mjs --mock

# Smoke: G1 on claude-code/haiku, once per variant, reviewed.
node bench/planner-eval/run.mjs --smoke

# Everything: G1–G5 x the six cells x V0/V1, three times each.
OPENROUTER_API_KEY=... node bench/planner-eval/run.mjs --full --candidate-ref <branch>

# A slice, and a resume after an interruption.
node bench/planner-eval/run.mjs --full --backend opencode --goal g4 --variant V0,V1
node bench/planner-eval/run.mjs --full --resume <bench dir>/planner-eval/results/<stamp>

# Print the runs without starting any; re-aggregate a results directory.
node bench/planner-eval/run.mjs --full --list
node bench/planner-eval/run.mjs --report <bench dir>/planner-eval/results/<stamp>

# Score stored runs again with today's keys and metrics, into a new directory.
node bench/planner-eval/run.mjs --rescore <bench dir>/planner-eval/results/<stamp> --out <bench dir>/planner-eval/results/<stamp>-rescored

# The candidate with and without the planner read limit, on the OpenCode cells.
node bench/planner-eval/run.mjs --full --backend opencode --variant V1,V2

# Run only the candidate, and compare it with V0 runs stored elsewhere.
node bench/planner-eval/run.mjs --full --variant V1 --baseline-from <bench dir>/planner-eval/results/<stamp>-rescored
```

`--help` lists every flag. The useful ones:

- `--concurrency N` (default 2) sets how many runs go at once. Each has its own
  daemon, port, settings file and clone.
- `--timeout S` (default 900) is the most a single run may take. A run that
  reaches it is a failed run, not a plan with no violations: it counts toward
  completion only, and `--resume` runs it again.
- `--model harness=model[,…]` names the model of an ACP cell (Cline, Qwen Code);
  see *Which harnesses can plan*.
- `--api-timeout S` (default twice `--timeout`) is the same for an API
  planner over OpenRouter, whose turns take longer.
- `--baseline-from DIR` takes V0's runs from DIR wherever this directory has
  none for that cell and goal. A V0 run of its own replaces the borrowed ones
  for its cell and goal.
- `--repeats N` overrides the mode's repeat count.

## Where run data goes

A real run writes model output, session logs and provider responses, so none
of it goes inside a repository, ignored or not. `<bench dir>` above is, in
order:

1. `$ORDEWELL_BENCH_DIR`, when set;
2. `$XDG_DATA_HOME/ordewell-bench`, or `~/.local/share/ordewell-bench`, on
   Linux and macOS;
3. `%LOCALAPPDATA%\ordewell-bench` on Windows.

This harness uses `<bench dir>/planner-eval/results` and
`<bench dir>/planner-eval/builds`. The run refuses to start, naming
`ORDEWELL_BENCH_DIR`, when the directory it would write to (the default, or the
one `--out`, `--resume`, `--report` or `--rescore` names) is inside the repository
working tree, compared after resolving links. Results and builds an earlier
version left under `bench/planner-eval/.results` and `.builds` are not moved:
move or copy them to the new directories to resume or re-aggregate them there.
The old `.gitignore` entries stay for such a checkout. The shared resolver is
`bench/lib/data-dir.mjs`.

## Results

Results go to `<bench dir>/planner-eval/results/<stamp>/` (never inside the
repository, so never committed), or to `--out`:

- `<run>.json`: the run record, holding the metrics, key checks, rubric, error
  and substitution.
- `<run>.session.json`: the session as the daemon served it, redacted.
- `<run>.screen.log`: the TUI's terminal output.
- `meta.json`: one pass per invocation, each with its mode, the refs and their
  commits, the harness versions, the flags, the goals and runs it ran, its
  timeouts and any `--baseline-from`. A `--resume` adds a pass and overwrites
  none.
- `report.json` and `report.md`: the aggregate.

## Metrics

Each is computed by `lib/metrics.mjs` from the session the daemon served when
the driver stopped. Width and critical path count top-level tasks only, since a
subtask runs inside its parent.

| Metric | Meaning |
| --- | --- |
| submitted | `submit_plan` landed: the plan holds tasks, or the history records a generated plan |
| tasks | every task, subtasks included |
| width | the largest set of top-level tasks no two of which are ordered by dependencies, which is the most the plan lets run at once |
| path | the longest dependency chain, in tasks (`–` for a cycle) |
| research | tasks marked `research` |
| read-only | research tasks plus tasks whose mode is read-only (`plan`, `ask`, …) |
| loops | tasks with a `loop` |
| ctx@submit | the prompt tokens of the planner's last turn, the context it planned in, where the planner reports usage |
| in / out | the planner's input and output tokens over the conversation, where it reports usage |
| own reads, own read bytes | read-like tools the planner ran itself (`read_file`, `grep`, `bash`, …), and the bytes they returned; a research subagent's steps are not counted. An ACP planner reads through `run_command` and file-system requests, which count too. Bytes are a result's true size: the session log clips each result at 10,000 characters and appends `[... truncated, total N chars]`, and N is used when it is there. The same reads are also split at the planner's first delegation (its first research-agent call or a call adding a research task) into `bytes before delegating` and `bytes after delegating` |
| agents | research agents the planner spawned (`spawn_research_agent`, or a harness's own `Agent`/`task` tool) |
| own-read share | own reads ÷ (own reads + agents + research tasks): how much of its look at the code the planner did itself (`–` when it looked at nothing) |
| key viol. | answer-key checks that failed |
| rubric problems | rubric questions answered 'problem' with at least one cited claim |
| wording viol. | true wording violations: sentences in the planner's hand-back after `submit_plan` that tell the user to operate a control the terminal UI does not have (press a button, open a card, click 'Execute plan' or 'Merge all'), or ask the user to merge while automatic merging is on and do not say it happens automatically or by itself. A sentence that describes rather than instructs is not one. Quoted text, code identifiers and the goal's own terms are exempt, since a task may need to change them, and so is a sentence naming VS Code, the webview or desktop, which do have those controls |
| turns | driver turns: the goal plus each reply the driver sent |
| wall ms | from the goal pasted to the driver stopping |

A run is complete when it has metrics, no error, and stopped for a reason
other than its timeout, a TUI exit or an error. Only complete runs enter the
medians and the verdict.

A planner that reports no usage, such as the mock, leaves the token columns
empty rather than zero.

## Rubric

For each submitted plan, a single call is made:
`claude -p --model opus --output-format json --json-schema …`. It runs with no
tools, no MCP and no session persistence. It gets the goal, the answer key, the
plan's digest and a fixed list of questions:

- a leading task for each shared decision
- steps the key keeps together that were split
- the task count, and which tasks are too small
- parallel tasks that decide the same interface
- whether the prompts name their paths
- for G4, reproduction first, validation by the failing tests, and
  hypotheses in research only where the cause is not named
- for G5, delegation by package before any change

Every claim must cite a task id from the plan, or quote the plan verbatim. A
claim that does neither is discarded, and an answer left with no cited claim
reads 'unsupported', not 'problem'. The record keeps the count of discarded
claims.

## Verdicts

The report gives one verdict per backend for V1 against V0, and for V2 against
V1 on a backend that ran V2, over the goals both sides have complete runs of. Two criteria
judge it, each against run-to-run spread:

- key violations per run, where a complete run with no plan counts one;
- true wording violations per run, where zero always holds.

A criterion holds when the candidate's mean is no more than the baseline's
plus half the wider of the two sides' ranges of per-repeat means: how far two
passes of the same build already differ.

Reported beside it, judging nothing:

- the completion rate, so a timeout or a crash shows here and nowhere else;
- for each goal with `expectedSlices`, how many runs planned a width in range;
- the median own-read share and own read bytes;
- rubric problems per run, where both sides were reviewed.

Width and share describe a plan's shape, which a key already judges where it
matters. A criterion with no data on a side makes the verdict 'incomplete',
never a pass. Every violation, error and substitution is listed by run.

The report holds medians and spreads over the repeats it ran. It makes no
claim beyond those runs.

## Re-scoring

`--rescore DIR` reads every run record in DIR and scores it again with the
current keys and metrics from its saved session, into `--out` (default
`DIR-rescored`, never DIR itself). Each record keeps the hash of the key it was
scored under; a record with none was scored with the goals at `312cc3c1`. The
rubric is reviewed again only where that hash changed; with `--no-review` the
old review is dropped and the record is marked `rubricStale`. A timed-out run stays a failed run. The new `meta.json` keeps
the source's passes under `fromPasses`.

## Your settings

Each run has its own settings file through `ORDEWELL_SETTINGS_PATH`. Ordewell
has no override for `~/.ordewell/` itself, so the bench snapshots
`~/.ordewell/settings.json` and `~/.ordewell/.env` before it starts. It puts
them back on any exit, an interrupt included, if anything changed them. It
removes only the token files of the daemons it started.

## Tests

`planner-eval.test.mjs` proves the pure parts offline:

- the metrics, keys and rubric filter
- the wording check, on hand-backs that do and do not instruct
- aggregation, verdicts, completion and the spread allowance
- the clone's `node_modules`
- re-scoring and `--baseline-from`, through `run.mjs` itself
- redaction and the guard
- the driver's reading of a turn
- the run matrix and the terminal command
- G4's patch, against the baseline's `Handoff.ts`, and G5's ground truth,
  against the baseline's `git grep`

`npm run test:bench` runs it. `--mock` is the end-to-end dry run.
