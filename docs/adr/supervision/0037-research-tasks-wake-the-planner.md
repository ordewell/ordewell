---
status: accepted
implemented: full
amends: ["0009", "0029"]
---

# 0037 — Evidence the planner decides on is a research task, and its report wakes the planner

*Pending:* [ADR-0056](0056-a-mandate-narrows-down-the-tree.md) — in a child plan R4's chain spends from the node's budget, and starting one needs the `research` grant.

## Problem

A planner turn holds the conversation, and its end gives the conversation
back to the user. Work the planner starts therefore has to finish inside the
turn. An API planner's research subagents run within one tool round
(ADR-0005). A harness planner that ends its turn with background agents still
running is sent back to wait for them (ADR-0009; `MAX_AGENT_WAITS` in
`CliAgentAiService`), because nothing would bring their results into the
conversation afterwards.

So a long investigation is a long turn. The user cannot talk to the planner
while it runs, everything it reads passes through the planner's context or its
subagents' digests, and "scout first, then plan" becomes one turn that grows
until it is compacted.

The supervisor already brings results into the conversation later (ADR-0029):
run updates open wake-up turns while tasks run, and the user's messages are
live planner turns in between. What is missing is a task whose result is
addressed to the planner.

## Decision

**Evidence the planner must decide something on is a research task: a
read-only task in the plan whose report is addressed to the planner. When it
ends, the planner wakes with the report, at every supervisor level. Evidence
only a later task acts on is a plain read-only task that task depends on.
Orientation stays in the turn, with the planner's own reads and its own agents,
awaited before the turn ends.**

- **What it is (R1).** A read-only AI task (ADR-0031) marked `research: true`,
  with a self-contained brief: what to find out, where to start, and what the
  report must contain. Its result is its `task_complete` handoff: a short
  summary and optional findings and artifacts; the long form stays in the handoff's
  `report`, pulled with `task_output`
  ([ADR-0047](0047-structured-task-handoffs.md); ADR-0022 V4). Like every
  read-only task
  ([ADR-0046](../planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md))
  it lands nothing: it works in a worktree of its own where the run isolates,
  which its sealed commands may write and which is thrown away when it ends,
  and in the workspace, which its commands cannot write, where the run does
  not.
- **Its end wakes the planner (R2).** A research task that passes, fails or is
  blocked opens a planner turn with a run update carrying its handoff, or the
  reason it did not pass. Reports from tasks that end close together are
  batched, as `WakePolicy` batches events today. Unlike the supervisor's
  wake-ups these come at every supervisor level, Off included: the planner
  asked for this report, and supervision is not the question.
- **Authority in that turn (R3).** A report turn acts with the authority of
  the turn that started the research task. One started in the user's turn acts
  as the user's turns do (ADR-0029, ADR-0030); one started in a supervisor's
  wake-up turn acts at the supervisor's level. The report itself is untrusted
  content, like everything the planner reads.
- **Starting one (R4).** A research task the planner adds is approved as it
  lands and starts without asking, under ADR-0046's shared read-only profile.
  Removing research or lifting read-only withdraws that approval. How many
  research tasks a message starts is the planner's judgement: it starts a
  research task for each independent question, and in a report turn starts
  another when the report opens a genuinely new
  question. That research's own report opens the next planner turn, so a
  report → research → report chain continues with no user message in between.
  **The chain is deliberately not bounded per message.**
  Its bounds are the planner's judgement, the run's Parallel limit
  (`maxParallelSessions`, ADR-0030) for what runs at once — research tasks and
  every other task share the same slots, and one beyond the limit waits for a
  slot like any other — `mayReport` (two consecutive automatically opened
  turns failed), which holds reports for the user's next message, and the
  user's Stop. A research report does not spend a separate allowance. Each
  task counts against its runner's usage like any task.
- **Who explores is decided by what the result is (R5).** A planner cannot
  know how long a lookup takes before it starts, so the line is drawn by what
  the result is, never by its duration. The test it applies on the spot: if
  the finding a later task acts on would end up in its brief, it is evidence;
  if it only decides what the planner says or asks the user, it is
  orientation.
  - *Orientation* is what the planner needs this turn to answer, ask or
    outline, when only the conclusion matters and no later task acts on it. It
    stays in the turn: the planner's own reads, or its own agents awaited
    before the turn ends ([ADR-0005](../planner/0005-parallel-research-subagents.md)'s
    `spawn_research_agent` for an API planner whose service can run
    subagents, the harness's own subagents for a harness planner as ADR-0009
    T8 says, none for an OpenCode or a Gemini planner), each briefed to
    return a digest of the conclusion and file:line references.
  - *Evidence* is a task of its own: when finding out needs a worktree (a
    failing test, a build, a reproduction), another runner or model should
    judge it, the user should see it and be able to stop it, or a later task
    will act on its findings. In the last case the later task depends on it,
    so the findings reach it in its handoff (ADR-0047) instead of being
    re-typed by the planner into the later task's brief. It is a research
    task only when the planner must decide something on its report; one whose
    report only later tasks read is a plain read-only task they depend on,
    since waking the planner for a report it will not act on spends its
    context for nothing. The planner takes a research task's summary, and
    pulls the full report with `task_output` only where the plan rests on the
    detail.
  - *A first plan may be research tasks alone*, when the plan cannot be
    outlined without their evidence: its outline says in a line what each
    asks, they start as R4 says, and the planner plans the rest when their
    reports wake it. A vague goal the user can clarify is not one: the planner
    asks first.
  - *Search*, a problem that needs rounds of branching where each round's
    reports decide the next, is the `explore` skill: rounds of research tasks.
    Where the question is which of several approaches to take, the skill has
    read-only explorers try them side by side against a check fixed before
    they start, and only a candidate that passes is eligible. An explorer
    keeps its prototype with `save_patch` ([ADR-0050](../planner-envelope/0050-a-read-only-task-can-hand-off-its-prototype-as-a-patch.md)),
    since its worktree goes with it. If exactly one passes it is chosen; if
    several do, one judge task that depends on all of them recommends one and
    cites the checks they ran. The judge is a research task, so its
    recommendation wakes the planner, which adds the build task on the
    recommended patch, and approving that task is the pick. The build task
    depends on the chosen explorer and applies its patch with `apply_patch`,
    resolving the conflicts the tool reports.

  #24 draws a line at the task boundary: inside a task the harness decides,
  and across tasks Ordewell does. This keeps it: what another task acts on, or
  the user should see and stop, is Ordewell's. The planner prompt states the
  rule once, in `whoExploresSection`, and every other section refers to it.
- **On the surfaces (R6)**, a research task is a row in the plan, marked as
  research, with its log, usage, stop and retry like any task. It waits for a
  free slot like any other task. Its handoff is drawn in the conversation as the
  run update that delivered it: whole when short, folded after a few lines when
  long with the lines left out counted, and opened on its own (ADR-0017, X1). A chain continues in the conversation as its reports arrive,
  so the user can follow it and stop it at any point.

## Considered options

- **Draw the line by duration** (the design until 2026-10-23): research that
  should outlive the turn, or that the planner would otherwise run in the
  background, is a research task, and the rest stays with the planner's own
  agents. Dropped: a planner cannot know how long something takes before it
  starts, so the same brief ("map subsystem X") fit both sides. It sent
  lookups to cold runner sessions, and kept evidence the plan rested on in the
  planner's context, from where only re-typing it into later briefs passed it
  on.
- **Let a harness's background agents outlive the turn**, and treat the turn
  the harness opens when they finish as a planner turn. Rejected: only some
  harnesses open one, the work is invisible to the plan and to its limits, and
  no surface can stop it. What crosses a turn belongs to Ordewell, as #24 says
  of what crosses a task.
- **A research job outside the plan.** Rejected: a second kind of background
  work beside tasks, with its own lifecycle, logs, limits and surfaces, for
  what a read-only task already is.
- **Wake the planner on every pass.** Rejected for ADR-0029's reason: passes
  ride along. A research task's report wakes it because the planner asked for
  that report.
- **Research tasks that always wait for approval.** Rejected once ADR-0046 is implemented on every runner:
  they change nothing, and approving each one stops the conversation they keep
  going. Until then they wait, since read-only is only as good as each
  runner's own mode.
- **Deliver reports only at the supervisor's levels.** Rejected: at Off the
  planner would never hear the answer to its own question.

## Consequences

- The planner can scout and plan in rounds while the user keeps talking: plan
  the first round of exploration, then extend the plan as reports come back.
  The planner prompt teaches this for open problems.
- This is delegation one level deep: a task whose report returns to the node
  that started it. Delegated tasks (#33) extend it to child plans.
- Research costs runner sessions. The run's Parallel limit bounds it, and the
  plan shows it.
- CONTEXT.md defines *Research task*. ADR-0009 keeps harness subagents inside
  their turn; ADR-0029 distinguishes research reports from ordinary passes.

## History

- 2026-10-15 — accepted. Not yet implemented.
- 2026-10-21 — where a research task works, and what it may write, follow read-only tasks as ADR-0046 defines them (R1).

- 2026-10-21 — implemented the core lifecycle, authority, approval and persisted message limits.
- 2026-10-21 — implemented the surfaces (R6): the research mark and the report block on the TUI, VS Code and the CLI commands, and the planner's guidance (R5).
- 2026-10-22 — the per-message research budget and its two run settings are gone: the planner decides how many a message starts, bounded by the run's Parallel limit, and a research task waits for a slot like any other (R4, R6).
- 2026-10-22 — the report chain is deliberately unbounded per message: a report turn may start further research whose report wakes the planner again, and its only bounds are the planner's judgement, the run's Parallel limit, `mayReport` and the user's Stop (R4, R6).
- 2026-10-22 — decided, not built: a research task's report is its handoff ([ADR-0047](0047-structured-task-handoffs.md), #120).
- 2026-10-22 — implemented research handoffs in report wake-ups and their surfaces (R1, R2, R6; ADR-0047, #120).
- 2026-10-23 — retitled from "Research that outlives a planner turn"; who explores is decided by what the result is: orientation in the turn, evidence a research task that a task acting on it depends on, search the explore skill; the duration line is dropped (R4, R5).
- 2026-10-23 — a Gemini planner has no in-turn agents: it neither declares nor is taught `spawn_research_agent`, as ADR-0005 now says (R5).
- 2026-10-24 — research's unasked approval is withdrawn as the tree changes, by `ApprovalRecord`, not at the next save; surfaces are told with the plan (R4).
- 2026-10-24 — who explores gets a test by the brief, a first plan may be research tasks alone, a report only later tasks read is a plain read-only task, and the explore skill gains explorers then a judge (R5).
- 2026-10-24 — retitled from "Evidence the planner needs is a research task, and its report wakes the planner": only evidence the planner must decide on is a research task (R5).
- 2026-10-24 — the explore skill's choice between approaches: explorers save their prototypes as patches, a check fixed beforehand decides eligibility, a judge only when several pass, and the build task applies the chosen patch (R5).
- 2026-10-24 — the judge only recommends and is always a research task: the planner adds the build task on the recommended patch, and approving that task is the pick, as [ADR-0050](../planner-envelope/0050-a-read-only-task-can-hand-off-its-prototype-as-a-patch.md) says (R5).
- 2026-10-25 — a long report in a run update opens on its own in VS Code, which has no detail switch any more (R6; ADR-0017 X1).
