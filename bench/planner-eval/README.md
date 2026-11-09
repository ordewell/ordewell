# Planner eval (`bench/planner-eval/`)

A planning-only A/B of the planner on real models. Each run hands one goal to
the real `ordewell` terminal UI, answers the planner's questions with a fixed
line, and stops once `submit_plan` lands. It never approves, runs or merges a
plan. The submitted plan is then measured, checked against the goal's answer
key, and optionally reviewed by a rubric.

The question it answers: does the candidate planner prompt, given no nudges,
plan at least as parallel (where the key allows) and at least as delegated as
the baseline given nudges? And does it do that without breaking the key, and
without telling the user about controls the terminal UI does not have?

## Variants

| Variant | Build | Goal text | Environment |
| --- | --- | --- | --- |
| V0 | `--baseline-ref` (default `0ecc6412`) | the goal, then the two nudges below, verbatim | — |
| V1 | `--candidate-ref` (default `HEAD`) | the goal alone | — |
| V2 | as V1 | the goal alone | `ORDEWELL_PLANNER_READ_METER=1` |

V0's nudges, each its own paragraph:

> Parallelize as much as possible.
>
> Keep your context as clear as possible: make use of research tasks to surface to you only the relevant information to make decisions.

Each ref is built once into its own git worktree under `.builds/<sha12>`
(gitignored), in the order core, web, cli. A second run reuses that build. With
the default refs, a checkout at `0ecc6412` builds the same commit for both
sides. To compare a prompt change, pass `--candidate-ref` with its branch or
commit. Each build is a worktree of this checkout. To free one, run
`git worktree remove --force bench/planner-eval/.builds/<sha12>`.

## Target

Every run plans against a throwaway repository: a `git archive` of the baseline
ref, committed as one commit in a fresh `git init` with no remote. Its
`node_modules` are symlinked from the baseline build, so the planner (and G4's
reproduction) can run the tests. G4's goal first applies its bug patch
(`setup.patches` in `goals/g4-failure-to-explain.json`), which makes exactly two core tests fail.
Each run gets its own clone of the template under the OS temp directory. The
clone is removed afterwards unless `--keep` is given.

## Goals and answer keys

| Goal | What it asks | What the key expects |
| --- | --- | --- |
| G1 | per-task token usage on every surface | a leading task that decides the usage shape, which every surface task depends on; the surfaces in parallel; 3–8 tasks |
| G2 | rename a persisted field, with migration | the rename and its migration kept together (one task, or a serial chain); 1–3 tasks; no parallel split |
| G3 | a hint's wording fix plus its test | one task |
| G4 | a findings badge names the mildest severity | reproduce first (a task, or the planner's own run of the failing test); the hypotheses go to research tasks before the fix; 2–5 tasks |

Each `goals/gN-*.json` holds the goal text and its `key`. The key's
`expectedStrategy` and `integrationRisks` are prose for the rubric reviewer.
The other fields are checked mechanically (`lib/keys.mjs`).

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
   - It stops when the plan is submitted, on an error turn, on the run's
     timeout, or after 4 driver turns. A run stopped by the turn limit is
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
harness's own default model. Any other harness cannot plan through Ordewell,
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

# Everything: G1–G4 x the six cells x V0/V1/V2, three times each.
OPENROUTER_API_KEY=... node bench/planner-eval/run.mjs --full --candidate-ref <branch>

# A slice, and a resume after an interruption.
node bench/planner-eval/run.mjs --full --backend opencode --goal g4 --variant V0,V1
node bench/planner-eval/run.mjs --full --resume bench/planner-eval/.results/<stamp>

# Print the runs without starting any; re-aggregate a results directory.
node bench/planner-eval/run.mjs --full --list
node bench/planner-eval/run.mjs --report bench/planner-eval/.results/<stamp>
```

`--help` lists every flag. The useful ones:

- `--concurrency N` (default 2) sets how many runs go at once. Each has its own
  daemon, port, settings file and clone.
- `--timeout S` (default 900) is the most a single run may take.
- `--repeats N` overrides the mode's repeat count.

## Results

Results go to `bench/planner-eval/.results/<stamp>/` (gitignored, never
committed), or to `--out`:

- `<run>.json`: the run record, holding the metrics, key checks, rubric, error
  and substitution.
- `<run>.session.json`: the session as the daemon served it, redacted.
- `<run>.screen.log`: the TUI's terminal output.
- `meta.json`: the mode, the refs and their commits, the harness versions and
  the flags.
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
| own reads, own read bytes | read-like tools the planner ran itself (`read_file`, `grep`, `bash`, …), and the bytes they returned; a research subagent's steps are not counted |
| agents | research agents the planner spawned (`spawn_research_agent`, or a harness's own `Agent`/`task` tool) |
| own-read share | own reads ÷ (own reads + agents + research tasks): how much of its look at the code the planner did itself (`–` when it looked at nothing) |
| key viol. | answer-key checks that failed |
| rubric problems | rubric questions answered 'problem' with at least one cited claim |
| wording viol. | sentences in the planner's chat that name a button or card, say 'press', 'Execute plan' or 'Merge all', or ask the user to merge while automatic merging is on; quoted text and code are ignored, since a task may need to change them, and so is a button or card in a sentence naming VS Code, the webview or desktop, which do have them |
| turns | driver turns: the goal plus each reply the driver sent |
| wall ms | from the goal pasted to the driver stopping |

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
- for G4, reproduction first and hypotheses in research

Every claim must cite a task id from the plan, or quote the plan verbatim. A
claim that does neither is discarded, and an answer left with no cited claim
reads 'unsupported', not 'problem'. The record keeps the count of discarded
claims.

## Verdicts

The report gives one verdict per backend for V1 against V0 and for V2
against V1. The candidate passes when each of these holds:

- Key violations per run are no more than the baseline's.
- Rubric problems per run are no more than the baseline's, where both sides
  were reviewed.
- The median own-read share is no higher.
- The median width is no lower on each goal whose key allows parallel work
  (G1, G4).
- There are zero wording violations.
- No fewer plans are submitted.

A criterion with no data on a side makes the verdict 'incomplete', never a
pass. Every violation, error and substitution is listed by run.

The report holds medians and spreads over the repeats it ran. It makes no
claim beyond those runs.

## Your settings

Each run has its own settings file through `ORDEWELL_SETTINGS_PATH`. Ordewell
has no override for `~/.ordewell/` itself, so the bench snapshots
`~/.ordewell/settings.json` and `~/.ordewell/.env` before it starts. It puts
them back on any exit, an interrupt included, if anything changed them. It
removes only the token files of the daemons it started.

## Tests

`planner-eval.test.mjs` proves the pure parts offline:

- the metrics, keys and rubric filter
- aggregation and verdicts
- redaction and the guard
- the driver's reading of a turn
- the run matrix and the terminal command
- G4's patch, against the baseline's `Handoff.ts`

`npm run test:bench` runs it. `--mock` is the end-to-end dry run.
