---
status: proposed
implemented: none
amends: ["0018", "0022", "0034", "0057"]
note: "The rule for what a wait may name, its continuation's message and the built-in shell's guard are prototyped; the tool, the attempt's end and the scheduler's continue are not."
---

# 0074 — A task that needs a sibling's unlanded work parks, freeing its slot, and continues once that work lands

## Problem

A slice whose tests import a sibling's code cannot finish before that sibling
lands. The plan review (ADR-0072) can cut a dependency such a slice really
needs. In a recorded run two slices started early and waited inside their
attempts, one with 14 `sleep 240..300` calls, 33 polls of the run's branch and
14 merges of it, the other with 17, 40 and 18, for 78 and 84 minutes: two of
eight slots, and calls spent while nothing they could change moved. Their
landings more than doubled the run's score. The supervisor read their output
at minute 46 and judged them actively working. The note on work landing beside
a task already says not to wait; they waited anyway. In another run, slices in
the same place built stand-ins in `/tmp` instead, 551 calls, which the note
also forbids.

## Decision

**A change task names the tasks it waits for with `wait_for`; its attempt ends
with no verdict, the plan gains those dependencies, its slot is free, and the
scheduler continues its saved session, on its branch, once they have landed.**

- **The call (P1).** `wait_for({ tasks, reason })` on a change task's token
  (ADR-0022), beside `task_complete`. It is refused, whole, with what to do
  instead, for work that has landed (take it in now), work that may never land
  (failed, skipped, or landing nothing), a task that waits for this one directly
  or through others (the edge would be a cycle), a runner that cannot continue a
  session, and a task that has parked twice this run (`Parking.ts`).
- **No verdict (P2).** The attempt ends as a usage-limit pause does (ADR-0018 U1):
  nothing is recorded as passed or failed, and nothing goes to the execution log
  as a failure. The task is `pending`, so it blocks nothing (ADR-0034), and what
  depends on it waits for it as for work not yet done. Its worktree and its
  runner session are kept.
- **The plan holds the wait (P3).** The tasks named are added to its
  `dependencies`, an edit recorded as Ordewell's on the task's behalf. The
  ordinary start rule then holds it; readiness gains nothing. The supervisor
  and the user see the edge as any other, and may remove it. The task keeps
  `parked: { attempt, waitsOn, count }`, the one new field of the plan.
- **It continues (P4).** When the scheduler starts a task that has `parked`, it
  starts a continue of its saved session, not a fresh attempt, with a first
  message that names what landed and how to take it in, then clears `parked`.
- **No sibling wait (P5).** ADR-0057 R7's "no sibling wait" stands: no task
  holds a lock on another or hears from one. The wait is an edge of the plan,
  which nothing else waits on.
- **The built-in runner refuses a wait (P6).** Its `shell` refuses, before it
  runs, a change task's command that sleeps over 30 seconds in all or polls in a
  loop sleeping over 5 seconds a turn, saying to call `wait_for` where the task
  has it, else to finish its part and name the checks left in findings
  (`waitGuard.ts`). An ops task's wait on a deploy is its work, and runs.

## Considered options

- **The task ends `blocked` naming the sibling; the supervisor adds the
  dependency and continues it.** Rejected as the mechanism: `blocked` is a
  failure, so it blocks the closing check and every dependent until the
  supervisor's turn; that turn is a held wake, minutes late; it needs a
  supervisor at Act that reads the reason right and makes two calls, and at
  Watch or Off the run ends with the slice failed. The recorded supervisor
  judged the waiting slices actively working.
- **Only the shell guard.** Rejected alone: it stops the sleeps of the built-in
  runner only, and a refused slice that cannot finish still ends, failed or done
  with its checks left, and its work is the closing check's.
- **A new task status for a parked task.** Rejected: every surface and the
  start rule would learn it, and `awaiting_user` would say a person is needed
  (ADR-0053), which nobody is.

## Consequences

- A slice that waits holds no slot and spends no call while it waits.
- A runner without a resumable session cannot park; it is told so.
- The plan changes under the planner, by a task's call: a supervisor reads the
  new edge in its next plan block.

## History

- 2026-11-21 — proposed, with the rule for what a wait may name, the
  continuation's message and the built-in runner's guard prototyped.
