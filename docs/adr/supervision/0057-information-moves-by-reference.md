---
status: accepted
implemented: none
amends: ["0012", "0013", "0022", "0029", "0047"]
note: "Settles #34, and #36 and #38 as far as this goes. R1 to R7 come first; the board (R8 to R10) is added after them."
---

# 0057 — Information moves by reference: reports stay one size at every level, and code decides when a planner wakes

## Problem

[ADR-0047](0047-structured-task-handoffs.md) settled what one task tells the next in a
flat plan and left hierarchy to #34, the board to #36 and cohorts to #38. A tree breaks
what a flat plan gets away with:

- **A finding has no stable name.** `checkHandoff` stores `{task, finding}` and checks
  the finding against the latest handoff, and F numbers restart per attempt, so "F3 of
  task 12" can mean something else after a retry or a loop round.
- **A planner above a subtree would re-word it.** Nothing lets a subplanner pass a child's
  finding up except typing it again.
- **Waking is per event.** [ADR-0029](0029-the-supervisor.md) merges events within five
  seconds and wakes. A wake is a model turn over a whole context, and one on an expired
  prompt cache is the expensive kind: on Claude Opus 5.5 a cache write is $5 per MTok
  against $0.20 for a hit, and on most models only cache reads stay outside ITPM, so a cold
  wake charges its whole prefix against the rate limit too (Anthropic's rate-limit and prompt-caching
  pages, read 2026-10-31).
- **What a wake carries has no cap.** A failure lists every task it blocks, a batch every
  pass, and the plan block every task. The level brief, about 2,300 characters at Act, is
  repeated on every wake, in a history a harness keeps.
- **Siblings know nothing of each other,** except what a planner re-types or a merge
  conflict says.

## Decision

**A finding moves by a reference pinned to its attempt. A pushed handoff is the same size at
every level, and a subplanner promotes child findings by reference, for Ordewell to render
verbatim. Everything that crosses a level is untrusted data with its provenance. Code
decides when a planner wakes. Between siblings the medium is the plan and git: tasks declare
scopes, and the affected task gets one addressed line. A board comes after those, and there
is no sibling chat, lock tool, wait tool or broadcast.**

## Key properties

### Up the tree

- **References are pinned (R1).** A reference is `{ node, task, attempt, finding }`, made
  of immutable ids, pinned by Ordewell as the call is accepted: an author writes `#4/F3` and
  `checkHandoff` stores the attempt that finding belongs to. It renders as `#4@2/F3`. Across
  plans it carries the derived path, `3/2:#4@2/F3`: `TaskRefs`' grammar is not overloaded, and
  the separator is one a task label cannot hold.

  A subplanner's `task_complete` is checked against its own plan, the child plan, not the
  parent's, whose attempt handles the call
  ([ADR-0055](0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) D4). Its readable
  set for `promote`, `open` and `findings[].evidence` is its whole subtree: every task of that
  plan and of each plan below it. So `#4` is the child plan's task 4, whether or not the
  parent's plan has one, a task further down is written with its path from that plan, `2:#4/F3`,
  and a refusal names the child plan's task. The producer, the delegated task, is in none of
  those plans, so `checkHandoff` is handed that set: `readableTaskIds` cannot derive it. A pinned
  reference holds the child task's immutable id and the attempt, under the `node` of its plan,
  and renders with the node path, so a later read reaches that attempt whatever the reader's
  plan holds.

  A reference stays valid for the life of the root plan,
  since attempt logs live as long as their session and a child's sit under the root's
  ([ADR-0055](0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) D11); a task
  removed from the plan keeps its log. A saved reference with no attempt reads the latest,
  as it does today.
- **What is pushed is one size (R2).** A handoff is pushed at most 4,000 characters at every
  level (`HANDOFF_PUSH_CHARS`, its artifacts apart), so a node's inbound context depends on its
  fan-out and not on its subtree. Its Report, the long form of at most 20,000, stays pulled
  ([ADR-0047](0047-structured-task-handoffs.md)). A subplanner's `task_complete` adds two fields, refused on any other token:
  `promote`, up to 8 references to findings in its subtree, and `open`, references its parent
  must decide, both pinned and scoped as R1 says. Rendered, by ADR-0047's rule, whole items until
  the ceiling and then a count:

  ```text
  counts       done, failed, blocked, skipped, commits, tokens: derived by Ordewell
               findings in the subtree by severity, and how many of each show below
  commit, summary
  open         what the parent must decide
  promoted     each verbatim, with its author's path and its evidence
  findings     the subplanner's own
  +N more; read #4
  ```

  The finding counts read the latest attempt of each task in the subtree, and `+N more`
  counts what the ceiling cut, promoted items included. So what a subplanner leaves out
  shows without a pull, and `read` on the delegated task lists it, each by its reference.
  A child's finding moves up only by reference. A subplanner adds its judgement as a finding of
  its own; it cannot edit a child's, and no model summarises one. Paths its branch changed
  outside its `scope` join `open`, from code ([ADR-0056](0056-a-mandate-narrows-down-the-tree.md)
  M7). The attempt logs keep the rest, to pull.
- **What crosses a level is untrusted (R3).** Reports, boards and handoffs are data, shown with
  their provenance and never as instructions: the block says whose words they are, by path, and
  a prompt tells the reader so. ADR-0037 R3 and ADR-0047 say this for one level. A tree makes
  each report a way into every node above it, and into each task that reads it, so a report
  never becomes a plan's text unless a planner writes it, and that planner is then answerable
  for it.

### Waking

- **Waking is decided in code (R4).** In `WakePolicy`, a pure function with no model. ADR-0029's
  five-second merge stays as what "at once" means.

  | wakes at once | events |
  |---|---|
  | a child plan ended | a delegated task's verdict, or its Stop |
  | a person is needed | `waiting_input`, `waiting_approval`, `landing_conflict` left waiting, `auto_merge_stopped`, `usage_limit` |
  | something is open | a question from a child, or a report with `open` |
  | a report arrived | `task_report` ([ADR-0037](0037-research-tasks-wake-the-planner.md)) |
  | the run ended | `run_finished`, with no merge window |

  Any other event but a pass, `task_failed` and `task_idle` among them, is held until the first
  of these, each of which is read from the plan:
  - **nothing can start** on this node without a decision;
  - **the cohort is done**: every task that became ready with this one has ended;
  - **a failure blocks work** that would otherwise be ready;
  - **a maximum age**: 80% of the planner's cache TTL once anything is held, so a wake finds its
    prefix warm. Each connector states its TTL, an unknown one reads as five minutes, and time is
    counted as the provider counts it, from the start of the request.

  A pass is not held: it wakes nothing and starts no clock, and rides along in the next wake, as it
  does today, so a plan that only passes opens no turn. A delegated task's pass is a child plan
  ending, in the table. Not waiting on the cohort alone is deliberate: it would be bound to its
  slowest task. There are no keep-warm pings: they are model turns that grow the context.
- **Bounded wakes (R5).** A wake has a size cap, 24,000 characters, with one line per ride-along
  event of at most 120. Overflow becomes counts and a pointer: `task_query` reads the rest. A
  failure blocking many tasks names the first few and the count. The level brief is sent once
  and then one line on a change, through `PlannerBriefing`, and again whole only when a context
  no longer holds it, as ADR-0012 T10 sends the plan block; ADR-0029's "each turn" goes. The plan
  block is bounded too: past its cap it shows live and waiting tasks, a count of the rest and a
  `task_query` pointer. The 24,000 is a tuning value.

### Between siblings

- **Tasks declare a scope (R6).** `scope: { paths, provides, consumes }` is an optional task field,
  written by the planner. Overlap is checked as the plan commits and answered in the tool's result,
  and the planner orders the tasks or names an owner. Producers go first, which is an edge in the
  plan and costs nothing new.

  When a landing touches a path or interface a running task declared, that task gets one addressed
  line at a step boundary
  ([ADR-0023](../runners/0023-messages-reach-a-running-task.md)), marked `from: 'ordewell'`, at most
  one per task per ten minutes and coalesced past that. An index from path to task makes this cost
  the tasks that overlap, not the plan.

  **Scopes are advisory.** Worktrees already isolate writes, and a miss costs a merge conflict, which
  has a repair ([ADR-0015](../isolation/0015-conflict-repair.md)). So scopes neither gate scheduling
  nor refuse a change; [ADR-0013](../isolation/0013-worktree-isolation.md)'s "conflicts are handled,
  not predicted" stands for what a planner did not declare.
- **No sibling chat, lock, wait or broadcast (R7).** Sibling messages (#38) stay out. They come back
  only if replays of real trees show both of these: conflicts or duplicated work between siblings
  that scope lines and the board do not lower; and, on the same goals, messages on costing fewer
  tokens per landed task than messages off, not just fewer conflicts.

### The board

Added after R1 to R7, and only if those leave a need; replays of Ordewell's own runs decide.

- **A board per delegated task (R8).** Typed entries go in through `post`, and are read by pull through
  `read`. Entries are one-way: a `post` wakes nobody. Types: `finding`, `claim`, `attempt` (tried and
  failed, so others skip it), `artifact`, `contract`, `assume`, `scope_change`, and for planners
  `decision` and `pin`. A node reads its own board and its ancestors'. A map, one line per entry, is
  kept by code from the entries' typed fields, not by a model. A root gains a board with its first
  delegated task, which is where its pins live. A flat plan has none.
- **Stale and contested are computed (R9).** `file` evidence gains an optional blob sha, compared with
  the branch at read, so a claim on a changed file shows `stale`. Entries with one `key` and different
  values show `contested`. Both are flags in the map, in code; a semantic contradiction needs a model,
  so it is a review task's.
- **Pins (R10).** A planner's `pin` is a decision every descendant must know. It reaches each new
  descendant at spawn, nearest ancestor first, within 2,000 characters in all, then a count. It is the
  one push down a tree, and a check never goes in one.

### Tools

- **A small, fixed set per role (R11).** A runner has `task_complete`, `checkpoint`, `read`, `post` and
  `apply_patch`; a read-only task keeps ADR-0046's tools beside the first four. A task with no board has
  no `post`, so a flat run's tool list grows by nothing. `read` extends `read_task`, whose name stays an
  alias at the call and leaves the list. That rename is the one change to a flat list: a session resumed
  across the build that ships it misses its prompt cache once. A planner holding delegated tasks gains `read` and `post`. Each
  role's set is fixed at session start, in a stable order
  ([ADR-0056](0056-a-mandate-narrows-down-the-tree.md) M6), with a CI test on its serialised size.
  Turning delegation on reaches a planner at its next process.
- **Plain `tools/call` (R12).** No MCP Tasks, subscriptions, sampling or internal A2A. MCP 2026-07-28 is
  stateless, and references passed as arguments fit it. Delivery goes over each runner's own message path
  (ADR-0023).

## Testing decisions

- The renderer stays a pure function of a digest, tested for the order, the whole-item cut and the
  counts, as ADR-0047's is. R1 is tested across a retry and a loop round: a reference still reads what
  it named. A finding promoted from a child's task 4 renders and reads that task's attempt, with and
  without a task 4 in the parent's plan, and a refusal names the child plan's task.
- `WakePolicy` stays pure: a table of event streams against a fake clock asserts when a batch is due,
  including each flush reason, a pass that flushes nothing, and a flat run's events.
- The tool sets are held by a test that serialises each role's list and fails past a stated size, and
  by one that a role's list does not change across a session.
- Scope overlap goes through `validatePlanTasks` and the tool's answer; the addressed line through
  `FakeRunnerSession`, with its rate limit on a fake clock.

## Out of scope

- A fresh start from the plan for a subplanner with a large cold context, which needs a measurement.
- Embedding search over a board, and a board across roots.
- Whether API planners' wakes miss the cache because the brief is dropped from history: the wake brief's
  change removes the likely cause, and #34's token task should log cached tokens per wake.

## Considered options

- **A model summarising each level.** Rejected. In three open-source deep-research systems, 84.7% of
  AI-Q's final-report errors arose at the orchestrator, while agents summarising a single document were
  nearly clean ([arXiv 2608.24306](https://arxiv.org/abs/2608.24306), EMNLP 2026). That measures AI-Q and
  citations, not code: the transfer to a planner is an analogy, and the safer side of one. ADR-0047
  already holds that the author writes it.
- **A subplanner's references checked against the parent's plan.** Rejected: it is the plan on hand
  where the call is handled, but `#4` would resolve to the parent's task 4, a wrong handoff stored
  silently whenever that task is readable, and a child's finding could never be cited.
- **A report that grows with its subtree.** Rejected: the root's context would depend on the tree's size.
- **Waking per event, or on the debounce alone.** Rejected: it is the cost in the Problem, at each level.
- **Waking only when a cohort ends.** Rejected: one slow task holds everything.
- **A pass among the held events.** Dropped: run one at a time, each task is a cohort of its own, so
  every pass would open a turn over the whole plan, where today none does.
- **Free messages between siblings.** Rejected. CooperBench found two agents succeeding about 30% less
  working together than on each task alone, and blames communication ("channels become jammed"), though
  it has no silent arm to compare ([arXiv 2601.13295](https://arxiv.org/abs/2601.13295)). On one set of
  message-heavy work at eight agents, shared files cut output tokens about 42%, and naming a coordinator
  did nothing ([arXiv 2608.16801](https://arxiv.org/abs/2608.16801), whose agents also went looking for
  grading material in four fifths of runs). A third found executable rules beat the same rules as text
  ([arXiv 2609.32965](https://arxiv.org/abs/2609.32965)), which is why these are in code.
- **Only reacting to conflicts, with no declared scope.** Rejected. One single-author benchmark of nine
  scenarios went from 1/9 to 9/9 clean integrations by declaring scopes and merge order
  ([arXiv 2610.07261](https://arxiv.org/abs/2610.07261)): a designed result, no field rate.
- **Chat instead of a line after a landing.** Rejected. A message describing a finished concurrent change
  recovered 82% of failures on constructed tasks, whose interference the authors say does not estimate
  practice: mined Django pairs showed it once in 834 runs
  ([arXiv 2609.25396](https://arxiv.org/abs/2609.25396)). So one cheap line is worth having, and no more.
- **Enforced scopes, or a lock tool.** Rejected: isolation makes a miss cheap, so a refusal would stop work
  to save a conflict.
- **A wait tool.** Rejected: a tool call times out by default at 60 seconds on Codex and 30 on OpenCode, and
  a blocked runner keeps a process and a slot.
- **MCP Tasks.** Rejected. Of the three harnesses only Claude Code has a mark in the client matrix, and Codex
  and OpenCode have no row. Ordewell already owns the task lifecycle.
- **A global board, or one every task reads.** Rejected: it brings back the cost it replaces.

## Consequences

- Flat runs change here, on purpose: ADR-0056's "no change" is the mandate's. A failed task with nothing
  blocked may wake the supervisor minutes later, in a batch. Anything that needs a person still wakes it
  at once, and a pass still wakes nothing.
- A subplanner's parent reads less than it could, and pulls by reference when a decision rests on detail.
  If replays show planners pulling most references, the push is too small.
- The completion call gains two fields, and evidence a pinned attempt.
- A scope a planner gets wrong warns about nothing. That is the cost of its being advisory.

## History

- 2026-10-31 — accepted. Not yet implemented.
- 2026-10-31 — checked against the code: R2 names the push ceiling and not the Report's limit, and R11 states what its rename does to a flat run's list.
- 2026-10-31 — checked against the code again: a pass stays a ride-along, and R2's counts show what a subplanner left out of its subtree.
- 2026-10-31 — checked against the code a third time: a subplanner's references resolve in its own plan, and it may cite its whole subtree.
