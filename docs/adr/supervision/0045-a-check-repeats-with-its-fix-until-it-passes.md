---
status: accepted
amends: ["0029", "0034"]
---

# 0045 — A check repeats with its fix until it passes

## Problem

"Until it passes" is a common shape of work: an adversarial review and a fix,
repeated until the review finds nothing; a test suite and a fixer; a benchmark
and an optimiser. The plan could not express it (#118).

- A failed task blocks its dependents
  ([ADR-0034](0034-a-failed-task-blocks-only-its-dependents.md)), so a task
  meant to run only when a check fails never ran.
- The supervisor at Act could add rounds by re-planning
  ([ADR-0029](0029-the-supervisor.md)), but that needs Act, spends a wake-up
  turn per round, and leaves it to the model whether to go on. At Off or Watch
  nothing happened at all.
- The only bounded loop in the code was conflict repair
  ([ADR-0015](../isolation/0015-conflict-repair.md)), which repeats one task's
  landing, not a piece of the plan.

## Decision

**A task may declare a loop: `loop: { body, maxRounds }`. It is the loop's
check, its body is the top-level tasks that fix what it finds, and Ordewell
runs the rounds itself: the check, and while it fails with rounds left, the
body and then the check again.**

The check is any task whose verdict is evidence: an AI task, which reports
through `task_complete`, or a script task
([ADR-0035](0035-effects-are-consented-and-recorded.md)), whose exit status
decides. `maxRounds` is the most times the check runs in one set of rounds:
3 when left out, from 1 to 10. Round *r* is the check's *r*th run; between
round *r* and round *r* + 1 the body runs once.

1. **Round 1** is the check's first run. The body waits for it.
2. **It passes**: the loop is done. Body tasks that did not run, or did not
   pass, end skipped ("not needed: its check passed"), and the check's
   dependents go on as usual.
3. **It fails, having found something, with rounds left**: the body runs, as
   new attempts, from the integration tip, so each round builds on what the
   rounds before it landed. Each body task gets the check's latest handoff as
   its *Prior task outputs*, told which round it is from. Once every body task
   has passed and landed, the check runs again as a new attempt: the next
   round. An AI check gets its own previous handoff and the latest handoffs
   of its body tasks, whose claims it is told to verify against the tree.
   Both directions use the summary and whole findings within the same
   4,000-character ceiling per handoff
   ([ADR-0047](0047-structured-task-handoffs.md)). There is no planner turn
   in between.
4. **It reports `blocked`**, or cannot otherwise be said to have run: no round
   starts, and it fails as any task does.
5. **Out of rounds** — it failed in its last round: the check ends failed, body
   tasks that have not run end skipped ("not run: the loop ran out of rounds"),
   its dependents are blocked (ADR-0034), and the supervisor gets one attention
   event that says how many rounds it ran.
6. **A body task fails, or the user skips one**: the loop stops there. The
   check stays failed and its dependents blocked. Retrying the body task until
   it passes resumes the loop where it stopped.

## Key properties

- **The loop is declared on its check (L1).** `loop` names its body by task
  id. The rules (`loopErrors`, part of `checkPlanInvariants`) keep the graph
  acyclic and the body its check's alone: the check is a top-level AI or
  script task; each body task is a top-level AI or script task in one loop
  only, never the check and never a check itself, and depends on the check
  and otherwise only on what the check depends on or on other tasks of its
  body; no task outside the loop depends on a body task, and the check never
  waits for its own body. A check and its body may read each other's handoffs
  with `read_task` without adding dependency edges (ADR-0047). No task in a
  loop has subtasks, since a round runs each again whole. Every route holds a loop to this: `submit_plan`,
  `edit_plan` (whose body references resolve like dependencies), the user's
  direct edits and a hand-added task. A loop written as `null` is dropped.
- **Only `failed` evidence starts a round (L2).** The verdict keeps what the
  evidence said, `Verdict.reported`: the status the `task_complete` call
  carried; for a script, `failed` on a non-zero exit, a signal or its time
  limit, and `blocked` when a step could not start. A check that reports
  `blocked`, a runner that exits without reporting, and a stopped script found
  nothing a fix could answer, so none of them starts a round.
- **Between rounds the check is no failure (L3).** A check that failed with
  rounds left is stored as `failed`, verdict and report included, and its
  being *between rounds* is derived (`betweenRounds`), as a block is: nothing
  is stored that a path could forget to clear. While its loop goes on — no
  body task failed, skipped or blocked — it blocks none of its dependents,
  which wait for it as for work under way; it does not end the run; it wakes
  no supervisor; and the loop guards do not remember it as a failure
  (`planBlocks`, `repeatingChecks`, `RunSupervision.taskSettled`). The start
  rule says it waits `repeating`, as round *r* of *N*, for the body still to
  land.
- **A body runs only for its check (L4).** A body task's dependency on its
  check is met only while the check is between rounds. Before that it waits
  `loop-check` ("runs if #X fails"), not on a dependency to finish, and a
  force start of it queues behind the check as behind any work under way;
  once the loop is over it has ended skipped.
- **The check runs again once its body has landed (L5).** At each tick, a check
  between rounds whose body has all passed and landed is made pending again as
  its next round (`PlanStore.repeat`): a new attempt, its verdict and report
  cleared from the task (they stay in its attempt's log), the round counted
  in `loopRound`. The round is saved on the check, and the loop's state is
  read from statuses at every tick, so a reload or a daemon restart resumes
  mid-round: a plan load and a new run keep a check between rounds failed
  rather than giving it the fresh chance a failed task gets, so its body runs
  first. The rounds take the one start rule: approval, holds, the Merge-all
  exclusion of ops work and the merge gate apply to them as to any start, and
  a Stop ends a round's running attempt as it ends any.
  A check started again from outside while a fix of its body is still at work
  or has passed and not landed (a retry, a force start) waits for that fix to
  finish and land, as it waits on its dependencies, so it checks the fix
  rather than racing it. It then runs as round 1 of a new set of rounds (L7).
- **A loop ends once (L6).** A pass, a Mark complete or a skip of the check, or
  its last round failing, closes the loop: what of the body has not run or did
  not pass ends skipped with why, and a body task at work is left to finish.
  Out of rounds, the one `task_failed` the supervisor hears says "its loop ran
  out of rounds: it failed all *N*", and so does the report of a check whose
  result a planner turn asked for (ADR-0037, R2), which is owed only now: a
  round's failure is no end it reports. An edit that leaves a check between
  rounds with no rounds left (lowering `maxRounds` to the round in progress)
  closes the loop as its last round failing does: the body task that has not
  run ends skipped ("not run: the loop ran out of rounds"), and the check
  settles once more, so the supervisor hears one attention event
  (`TaskOrchestrator.planEdited`, called from `reconcilePlan` and from
  `PlanEditor.commit`).
- **What stops a loop, and what starts its rounds over (L7).** A body task that
  fails, is skipped or is blocked stops the loop: the check is then the
  failure it is stored as, and its dependents are blocked until what stopped
  the loop is retried and passes. A retry of the check — the user's, a
  `rearm`, a force start after a failure, a fresh chance on load or Execute —
  starts a new set of rounds: `loopRound` goes, and the body waits for the
  check again. The loop's own run of the check is no retry: the retry limit
  and the identical-retry guard (ADR-0029) count none of its rounds. A resume
  after a usage limit goes on in the round it was in. A supervisor or planner
  start of a check between rounds is refused, with the line that the loop runs
  it again itself, and the supervisor does not skip it: it needs no one.
  A new round revives only the skips the loop made itself, the body that went
  unrun when the loop closed; a body task the user skipped stays skipped, and
  keeps stopping the loop, until they retry it.
- **Removing a body task takes it out of its loop; a check is not removed
  (L8).** A body task removed from the plan leaves its loop's body, as it
  leaves dependency lists, and a loop left with no body is dropped. A check
  may not be removed while it has a loop: its body would be left as tasks that
  run whatever happens. Nor may a loop's tasks be merged or split.
- **A check outside a worktree waits for its body's work at its merge gate
  (L9).** An ops or script check acts on the user's checkout, which holds the
  body's fix only once it is merged, so its merge gate (ADR-0020) counts its
  body's landed work as it counts its ancestors'. A change-task check needs
  nothing: its next round's worktree is cut from the integration branch.

## Consent

Approval is not spent by a run. The plan's approval covers its loop's rounds,
so a body task approved once runs every round without asking again, and one
the user never approved waits for approval as any task does. A script task's
consent is to its body (ADR-0035): the loop re-runs it unchanged, so it needs
no new consent; an edit to its body takes it out of the approved set as
before.

## Testing decisions

- `TaskOrchestrator.loop.test.ts` drives the rounds through
  `FakeRunnerSession` (`reportComplete`, `reportScriptExit`) on a shared-root
  run and, for landing, on `FakeWorktreeIsolation` with `holdIntegration`, as
  the blocked and script orchestrator tests do.
- `sessionLoop.test.ts` uses the supervisor test kit to count wake-ups and the
  guards' memory under Act, and reloads a saved plan state mid-round.
- `loop.validation.test.ts` holds each L1 refusal to its wording through
  `validatePlanTasks` and `applyTaskOps`, and reads the derived state off plain
  task lists.

## Out of scope

Nested loops; a loop whose body is a delegated child plan (#33); a manual task
as check or body; a user editing a loop's `loop` field by hand from a surface.

## Considered options

- **Rounds the supervisor adds by re-planning.** Rejected: it needs Act,
  spends a planner turn per round, leaves it to the model whether to go on,
  and does nothing at Off or Watch. The loop is in the plan, so the rounds run
  at every level and the supervisor hears once, at the end.
- **Dependency back-edges: the check depends on its fix, the fix on the
  check.** Rejected: every consumer of the plan — the blocked rule, the start
  rule, order repair, every surface's tree — assumes an acyclic graph, and
  `checkPlanInvariants` refuses cycles. The loop is one declaration on one
  task over an acyclic graph.
- **Unrolling each round into new rows.** Rejected: the plan grows each round
  with work nobody planned (the reason ADR-0015 rejected added resolver
  tasks), while attempts already keep each round's log and report.
- **Only declared checks (#39) as checks.** Rejected: an AI check, such as an
  adversarial review, is the main use, and its `task_complete` report is
  already evidence. #39 itself was closed: a check is a task in the plan, so
  there is no separate declared check.
- **A stored `repeating` status.** Rejected for the reason ADR-0034 rejected a
  stored `blocked`: it has to be set and cleared on every path that fails,
  retries, edits, removes or reloads a task. Between rounds is read from the
  check's status, verdict and round.
- **Telling `blocked` from `failed` by the reason text.** Rejected: the text is
  the runner's, and a script has no such word. The verdict keeps the reported
  status as a field.
- **The loop approving its body each round.** Rejected: approval is the user's
  word on a task, kept until the task changes or leaves the plan; a body task
  the user never approved must not run because a loop asked.
- **Fixing up a loop whose check is removed.** Rejected: its body would become
  tasks that run unconditionally, which is not what anyone removed.

## Consequences

- An "until it passes" goal is one check and its fix in the plan, run to its
  end at any supervisor level, with one row per task and every round's log in
  its attempts.
- A run can spend up to `maxRounds` runs of a check and one fewer of its body
  with no one asked; the round limit is the bound.
- A body task whose landing conflicts waits on the user as any conflict does
  (ADR-0015): the loop neither stops nor goes on until it lands.
- Each round's body attempt is a fresh worktree: its earlier rounds' landings
  stay on the integration branch, while the run's record of the task, which
  the handoff lists, is its latest attempt's.
- Surfaces get `loop` and `loopRound` on every task and on status updates, and
  `reported` on a verdict, and draw "round *r* of *N*" and "runs if #X fails"
  from the one row view (`taskRowView`, `row.loop`), which reads the same
  `planBlocks` the scheduler does: a check between rounds shows as fixing, not
  as failed. A surface asks before a removal only where core will allow it, and
  quotes core's refusal of a check's removal (L8) rather than offering it.
- The conversation planner's prompt teaches a loop only for an explicit
  iterate-until goal or a specific acceptance condition that needs independent
  repeated checking and fixing, and has it give the reason in the outline when
  it infers one. Routine tests, type checks and self-review stay inside the
  implementation tasks, and tests that exist, a rerunnable command or changed
  code never make a loop. It prefers a script check and has the planner choose
  `maxRounds`; the one-shot planner's prompt does not.

## History

- 2026-10-21 — accepted; core implemented (#118).
- 2026-10-21 — surfaces draw the rounds and the planner prompt teaches loops (#118); implemented.
- 2026-10-21 — a check retried or force-started while a fix of its body is at work waits for it to land, then runs as round 1 of a new set of rounds (L5); a new round revives only the loop's own skips, never the user's (L7).
- 2026-10-22 — an edit that leaves a check between rounds with no rounds left closes its loop (L6).
- 2026-10-22 — decided, not built: handoffs run in both directions of a loop ([ADR-0047](0047-structured-task-handoffs.md), #120).
- 2026-10-22 — implemented handoffs in both loop directions and scoped reads between check and body (step 3, L1; ADR-0047, #120).
- 2026-10-26 — the planner prompt and the diagnose skill add a loop only for an explicit iterate-until goal or a specific acceptance gate, not for routine validation.
- 2026-10-30 — #39 closed: a check is a task in the plan, so no declared check is planned.
