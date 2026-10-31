---
status: accepted
implemented: full
amends: ["0022", "0029", "0037", "0045"]
note: "Settles #120 for flat plans; the hierarchy half stays with #34."
---

# 0047 — Every task ends with a handoff: a short summary, atomic findings and a way to pull the rest

*Pending:* [ADR-0057](0057-information-moves-by-reference.md) — references pin an attempt, a subplanner's handoff promotes by reference, and `read` extends `read_task`.

## Problem

What one task found reaches the next as a freeform *Report*: the `summary` of
the *Completion call*, cut to 4,000 characters per direct dependency in the
dependent's *Prior task outputs*
([ADR-0022](../runners/0022-ordewell-mcp-server.md) V4). That has four faults,
found running adversary → fix → adversary plans
([#120](https://github.com/ordewell/ordewell/issues/120)):

- **The cut is blind.** It lands mid-sentence, usually inside the last of
  several findings, and the text it points at ("see the full report") is
  something a runner cannot read: a task token carries `task_complete` and
  `checkpoint` (and `run_command` on a read-only task), while `task_output`,
  `task_query` and `task_diff` belong to the planner's token.
- **Only direct dependencies are included.** A task three steps down never
  sees what the first task found, so the planner copies findings into later
  prompts by hand, which costs a planner turn and loses detail.
- **A finding is not addressable.** Nothing says "F3 of task 12", so a fix
  cannot say which finding it answers nor a later review which it re-checked.
- **A loop's check starts blind.** A check does not depend on its body
  ([ADR-0045](0045-a-check-repeats-with-its-fix-until-it-passes.md) L1), so
  the second round of an adversarial review never sees what the fix claims to
  have changed, nor what the review itself said last round.

## Decision

**Every task ends with a handoff: a short summary written for the next reader,
optional atomic findings and artifacts, a change task's commit message, and
an optional long report that is stored and pulled, never pushed. An AI task
authors it in `task_complete`; Ordewell derives one for a script task and a user task. A dependent is given
the summary and as many whole findings as fit; the rest is read with a new
`read_task` tool.**

### The envelope

`task_complete` takes `status` and `reason?` as before (ADR-0022) and a
handoff:

- **`summary`** (required, at most 1,500 characters): written for the next
  agent, not as a log. With a `commit`, it no longer repeats what changed and
  why: it holds the exact specifics the next agent needs (paths, symbols,
  decisions) beside the artifacts, what is left and what to watch, and may be
  empty when there is nothing to add. Without one it says what changed too.
- **`commit`** (`{subject, body?}`): the commit message, written for a human
  reviewer: what changed and why. The subject is one line of 1 to 100
  characters (the contract asks for 72 or fewer, in the imperative mood), the
  body at most 500 characters, one to three lines on why. It counts only with
  `done`: with `blocked` or `failed` nothing lands, so it is dropped and the
  summary carries everything. Ordewell, not the author, decides a landed
  commit's trailers, so trailer lines in the body are removed, not refused: an attribution line in
  git trailer form with a hyphenated token (`Co-Authored-By:`,
  `Signed-off-by:`) or a `Generated with …` line wherever it stands, and a
  closing paragraph made only of `Token: value` lines, as git would read a
  trailer block. A body of one `Why: …` line is prose and stays. Only a change
  attempt's contract (fresh, continued or carried over) asks for it: an ops,
  read-only, research or script task commits nothing, and a repair resolves a
  merge. The commits Ordewell writes to land the task are written from it by
  `landingMessage` ([ADR-0013](../isolation/0013-worktree-isolation.md)).
- **`findings`**: atomic items, each with a `severity` of `blocker`, `major`,
  `minor` or `info`, a one-line `title`, a `detail` of at most 2,000
  characters, and optional `evidence`. Ordewell assigns the ids `F1` … `Fn` in
  the order given, so the author's order (most important first) is the
  rendering order and a finding is cited as "F3 of task 12". Severity is
  advice to the reader. It is never evidence: it reaches `VerdictEngine`
  nowhere, and a `done` with a blocker finding is a `done`.
- **`artifacts`**: typed references to what the task produced, of the same
  four kinds as evidence. A read-only task's saved patch is a fifth kind,
  `patch`, which Ordewell adds from its own capture and the author never states
  ([ADR-0050](../planner-envelope/0050-a-read-only-task-can-hand-off-its-prototype-as-a-patch.md));
  it comes after the author's artifacts and outside their limit.
- **`report`** (at most 20,000 characters): the long form, for the reader who
  needs it all. It is stored in the attempt's log and is never put in a prompt.

**Evidence** is a typed reference, so a reader can check a claim rather than
trust it:

| kind | carries | checked |
|---|---|---|
| `file` | a path in the repository, optionally a line | lazily, when read |
| `commit` | a sha, optionally the repo (a group has several) | lazily, when read |
| `task` | a task reference, optionally a finding id | at the call |
| `url` | `http` or `https` only | at the call |

A `task` reference must resolve to a task the producer may read (the readable
set below) and, with a finding id, to a finding that exists; the call is
refused otherwise. A `url` of any other scheme is refused, so no surface
renders a `javascript:` or `file:` link. A `file` or `commit` is a claim about
a tree the producer saw: the worktree may be gone when someone reads it, and a
commit may land after, so Ordewell does not check it at the call and a surface
shows one it cannot resolve as unresolved, not as an error.

Each reference string (path, repository, task reference, finding reference or
URL) is at most 2,000 characters, so the digest remains bounded even when
artifacts are outside the pushed text budget. Commit shas remain 4–64 hex
characters.

A handoff outside these limits is refused at the call with a result naming the
field and the limit, and the attempt stays open for the runner to resend it
(nothing is cut for the author: an author who is told learns, one who is cut
silently does not).

### What a dependent is given

Each direct dependency contributes at most 4,000 characters to the dependent's
*Prior task outputs*, built so: the commit first, its subject then its body,
then the summary, then the findings **whole**,
in the producer's order, each with its evidence references, stopping before a
finding that would pass the ceiling, reserving room for the closing pointer.
When findings remain, one line closes the block:
`+N more findings; read task #x`. Ordewell never cuts a finding, and never cuts the summary (it cannot exceed its limit). Artifacts are not part of
the budgeted text; a task that wants the next reader to start from one says so
in its summary. A task whose saved state has no handoff (a plan saved before
this decision, an attempt that ended without a completion call) falls back to
`outputSummary.report`, cut as it is today.

### Pulling the rest

A task token gains **`read_task({task, attempt?, include_report?})`**: the full
handoff of one task, from its attempt log, and its `report` when
`include_report` is true. It reads a handoff and nothing else: no transcript,
no tool calls, no diff, no command output.

The **readable set** of a task is itself, its transitive dependencies, and its
loop's other end in either direction: a check reads its body tasks, and a body
task reads its check (ADR-0045). A task outside the set is refused, so the
read is scoped by the graph the plan already holds and a task cannot read a
sibling's work it was never given. Every call is recorded in the reader's task
log, with what it asked for, like any tool call. A read-only task's token has
it too (ADR-0046): it reads Ordewell's own record, not the tree. What it
returns is the producer's words, untrusted content for the reader as every
report is (ADR-0037 R3).

The planner is unchanged in kind: `task_query` returns the digest and
`task_output` the full handoff and the report, both under the planner's
existing read budget (ADR-0022 P3). `read_task` is not a planner tool, so the
planner's envelope (ADR-0008) does not widen.

### Where it is stored

The full handoff is one **`handoff` event** at the end of the attempt's
`.jsonl` task log ([ADR-0018](../runners/0018-structured-runner-transport.md)), so it is as durable as the attempt and goes with
the session. The plan keeps a **bounded digest** on the task: the summary, the
first 25 findings, the artifacts, the commit and `findingCount`, enough for
every surface and for a dependent's prompt without reading a log. The full findings and the
report stay in the log. `+N more` counts from `findingCount`. A retry or a
loop round is a new attempt with its own handoff, and the digest is the
latest attempt's. A restarted task clears its previous digest and output
summary before it runs; older handoffs remain readable by explicit attempt.

### Script and user tasks

A task with no model still hands over. A script task's handoff is derived by
Ordewell from the evidence it holds: the exit status (or signal, or time
limit, or that it could not start) and the end of its output as the summary,
the bounded output as the report. A user task's is derived from the user's
action: that they marked it complete, and their note if they gave one. Neither
has findings, since Ordewell does not parse output into findings it cannot
vouch for. Both are rendered, stored and pulled as an authored one is.

### Loops close in both directions

ADR-0045's body task is given the check's handoff as its *Prior task outputs*
(the same rule and ceiling). The check's next round, if the check is an AI
task, is given **its own previous round's handoff** and the **latest handoffs
of its body tasks**, and is told that the body's claims are claims: it is to
verify them against the tree, not to repeat them. Its verdict still comes from
its own `task_complete`, never from a handoff (ADR-0022 V1). A script check has
no prompt, so it is unchanged.

### On the surfaces

The handoff is drawn, not just stored: the TUI and VS Code task views show the
summary, the findings with their severity and evidence, the artifacts and
`+N more` in expanded task details and task logs, not in collapsed plan cards
or rows; `status`, `run` and `status --json` carry the digest; the
planner's `task_query` and `task_output` return it; and the supervisor's run
update and a research task's report wake carry it rendered by the rule above,
the commit before the summary
([ADR-0029](0029-the-supervisor.md), [ADR-0037](0037-research-tasks-wake-the-planner.md)).
Wake-ups use the same 4,000-character ceiling, including omission and report
pull pointers; artifacts remain outside it. A surface reads the digest from
the plan and the rest through the same task log read as everything else.

## Key properties

- **Two readers, two texts.** The commit is for the human who reviews the
  change, the summary for the agent that builds on it; neither repeats the
  other.
- **The author writes it; Ordewell never summarises.** A
  second model summarising a first model's work is a second author whose
  mistakes nobody wrote, and a cut is no summary. The cost is that the author
  must write well: the prompt teaches the envelope and a refused call says why.
- **A handoff is not a verdict and not a report.** The verdict is the status
  `VerdictEngine` derives from the completion call. The report is the long
  form. The handoff is what the task tells its readers, and a reader weighs it;
  it is never evidence of the task having passed.
- **The push is bounded and the pull is scoped.** The prompt carries a fixed
  amount per direct dependency; anything more is asked for through the graph the
  plan already holds.
- **Compatibility is read-side.** A task saved before this has no handoff and
  is rendered from `outputSummary.report`. A runner told the old contract and
  sending only `summary` still completes: a summary within the limit is a
  handoff with no findings.

## Testing decisions

- The renderer is a pure function of a digest: tested for the cut falling
  between findings and never inside one, the `+N more` line, the fallback to
  `outputSummary.report`, and the ceiling per dependency.
- The `task_complete` handler is driven through the MCP server test seam and
  `FakeRunnerSession.reportComplete`, as the verdict tests are: the limits, id
  assignment, reference validation and that a refused call leaves the attempt
  open.
- `read_task` is tested against the readable set from plan graphs with a loop,
  asserting the refusal outside it and the task-log entry for every call.
- Loops are driven as `TaskOrchestrator.loop.test.ts` does, asserting what a
  second-round check and a body task are given.

## Out of scope

Hierarchy (reports across levels, event-log references, a board's scoped
sharing: #34 beside #32, #33 and #36); cohorts (#38); raw transcripts as a
handoff or as readable through `read_task`; a model that rewrites, scores or
merges findings; and any new setting.

## Considered options

- **Hand runners the planner's `task_output`, `task_query` and `task_diff`.**
  Rejected: those reach transcripts and diffs of any task, and the planner's
  confinement (ADR-0008) is an envelope the runner's token does not have. One
  scoped read of a bounded record is the whole need.
- **Raise or remove the 4,000-character cut.** Rejected: every ancestor's
  words would then grow every descendant's prompt, and a larger limit still
  cuts blindly.
- **Cut a long report at the ceiling, as today, and point to the rest.**
  Rejected: the pointer led nowhere a runner could go, and a finding cut in two
  is worse than a finding left out with a count.
- **Parse findings out of the freeform report.** Rejected: reading structure
  from a model's prose is guessing, and a wrong parse is invisible. The author
  states the structure.
- **Let a model summarise, or rank findings.** Rejected for the reason above.
- **One summary for both readers, and a commit message made from it.**
  Rejected: an agent needs paths and symbols, a reviewer needs what changed
  and why, and one text serves neither; a message cut from the summary is a
  blind cut again.
- **Refuse a commit body with trailers.** Rejected: an attribution line is a
  harness habit, not a mistake worth a resend, and the trailers a landed
  commit carries are Ordewell's to decide.
- **Ask every task for a commit.** Rejected: an ops, read-only, research or
  script task lands no commit, and a field it is told to fill but nothing
  reads teaches it to write noise.
- **Push every ancestor's report.** Rejected: the prompt grows with depth. The
  push stays at direct dependencies and the rest is pulled when it is needed.
- **Keep the planner as courier.** Rejected: that is the fault, a planner turn
  and a lossy copy for what the graph already knows.
- **The author numbers its findings.** Rejected: authors miscount and collide
  across rounds; an id Ordewell assigns can be cited.
- **Severity decides the verdict, or retries.** Rejected: that makes the model
  the tie-breaker (AGENTS.md, "Verdicts come from evidence").
- **The whole handoff in the plan.** Rejected: a 20,000-character report per
  attempt per task grows the plan file the surfaces reload on every change. The
  log already keeps it at full fidelity.
- **Check `file` and `commit` references at the call.** Rejected: the worktree
  may be thrown away when the reader gets there (ADR-0046) and a commit may
  land after the claim; a call refused for a tree Ordewell cannot see would
  punish an honest author.

## Consequences

- A dependent three steps down can pull what the first task found with no
  planner turn, and a fix can answer "F2 of task 12".
- The completion call is no longer one free string: the prompt, the tool's
  schema and the surfaces change together, and a runner that sent a long
  `summary` is told to move it to `report`.
- A plan holds a bounded digest per task; the log holds the rest. Anything that
  reads a task's result should read the digest, not the log.
- CONTEXT.md's *Isolation handoff* keeps its meaning (the end of an isolated
  run); the new term is *Handoff* alone for a task's end, and each is named by
  its qualifier where both could be meant.
- `read_task` joins the task token's tools, so the tools table of ADR-0022
  changes, and a task's reach grows by exactly its readable set.

## History

- 2026-10-22 — accepted. Not yet implemented (#120).
- 2026-10-22 — `read_task`'s switch for the report is named `include_report`.
- 2026-10-22 — bounded reference strings to keep artifacts and the plan digest bounded.
- 2026-10-22 — implemented the completion envelope, scoped reads, loop context, derived handoffs and all surfaces (#120).
- 2026-10-23 — a change task's handoff carries its commit message, and its summary stops repeating it.
- 2026-10-24 — a fifth artifact kind, `patch`, which only Ordewell adds, for a read-only task's saved patch (ADR-0050).
- 2026-10-26 — task handoffs appear in expanded task details and task logs, not collapsed plan cards or rows.
