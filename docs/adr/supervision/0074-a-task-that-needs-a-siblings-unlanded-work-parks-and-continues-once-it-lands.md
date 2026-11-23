---
status: accepted
amends: ["0018", "0022", "0034", "0057"]
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
a task already said not to wait; they waited anyway. In another run, slices in
the same place built stand-ins in `/tmp` instead, 551 calls, which the note
also forbids.

## Decision

**A change task names the tasks it waits for with `wait_for`; its attempt ends
with no verdict, the plan gains those dependencies, its slot is free, and its
next start continues its saved session, on its branch, once they have landed.**

- **The call (P1).** `wait_for({ tasks, reason })` on a change task's token
  (ADR-0022), beside `task_complete`. It is refused, whole, with what to do
  instead, for work that has landed (take it in now), work that may never land
  (failed, skipped, or landing nothing: read-only, ops, a person's), a task
  that waits for this one directly or through others (the edge would be a
  cycle: through dependencies, a container's subtasks, which it lands only
  with, a loop's body, and the edges of parks granted whose attempts have not
  ended yet, so two tasks that wait for each other at once are not both
  granted), the task itself, an ancestor or a subtask of it, a task that has
  parked twice since its last fresh attempt (`MAX_PARKS`), and an attempt that
  is not a change's (an ops task, a repair). The rule is `parkDecision`
  (`Parking.ts`); the call's handler is the attempt's (`Attempts.waitFor`).
- **No verdict (P2).** A granted call ends the attempt as a usage-limit pause
  does (ADR-0018 U1): once its turn ends, or after a 30-second grace if the
  runner keeps the turn open, and the same if the runner exits or reports
  meanwhile, since nothing it says after the grant counts. Nothing is recorded
  as passed or failed, and nothing goes to the execution log as a failure. The
  task is `pending` with no hold, so it blocks nothing (ADR-0034), and what
  depends on it waits for it as for work not yet done. Its worktree and its
  runner session are kept.
- **The plan holds the wait (P3).** The tasks named that its dependencies did
  not already hold are added to them before the task is pending again: an edit
  of Ordewell's on the task's behalf, said in the run's notices, that no
  planner's or supervisor's loop guard counts. The ordinary start rule then
  holds it; readiness gains nothing. Once it is pending, so free to move, the
  plan's order is repaired as an edit's is (`PlanStore.keepDependenciesFirst`):
  it comes to sit after what it waits for, running and completed tasks moving
  up a slot, never past one another, where nothing else can take its place.
  Left where it was, ahead of a task it now depends on, every later edit's repair
  would have to move that task, running or completed, and would refuse the edit.
  Every surface shows the edge as any other,
  and the supervisor and the user may remove it. The task keeps
  `parked: { attempt, waitsOn, added, count }`, the one new field of the plan,
  saved with it, so a reload or a daemon restart keeps the wait. An edge that
  would close a cycle the plan gained since the call was granted is left out,
  and the task's next start is told that work is no longer what it waits for.
- **It continues (P4).** A start of a parked task while no attempt has run
  since the park (`owedPark`) goes on from it, whoever starts it: the
  scheduler, a force start, Execute. A start whose spawn failed never ran, so
  the park stays owed to the start after it. Where its runner saved a session it can
  resume, the same runner's, the start is a continue of that session (ADR-0018
  K1), its first message naming what landed; the worktree is restored from the
  integration tip with the task's own work merged back, so what landed is
  already in it. Where none was saved, or the task has moved to another runner,
  the start is a fresh session that carries the parked attempt's files over, as
  a carry-over does, told what it waited for and what landed.
- **No sibling wait (P5).** ADR-0057 R7 stands: no task holds a lock on another
  or hears from one. The wait is an edge of the plan, which nothing else waits
  on.
- **The built-in runner refuses a wait (P6).** Its `shell` refuses, before it
  runs, a change task's command that sleeps over 30 seconds in all, or with no
  end, or polls in a loop sleeping over 5 seconds a turn, saying to call
  `wait_for` (`waitGuard.ts`). A sleep counts where it runs: in command
  position, or in the code a `-c` string or a heredoc holds, never in a quoted
  argument such as `grep "sleep 45"`. An ops task's wait on a deploy is its work, and runs. The
  note on work landing beside a task says the same to every runner.
- **A wait that cannot end goes on without it (P7).** When work a parked task
  waits for will not land without someone's retry — it failed for good, is
  blocked by a failure, was skipped or left the plan — the edges its park
  added for that work are taken back, Ordewell's edit as the park's was, and
  the task goes on, told which work will not land and to finish its own part,
  naming the checks left in findings. A loop's check between rounds is still
  to land (ADR-0045 L3). Under ADR-0034 alone it would be blocked, and at
  Watch or Off nobody would retry what blocks it.
- **The user's controls (P8).** A Stop of a parked task holds it, as a
  cancelled task is held, so it does not go on once the work lands; a force
  start then continues it. A Retry is a fresh attempt: the park and its session
  are let go, and the edges stay, since they are the plan's now.

### Which runners have it

Every runner that runs a change task through the task token: Claude Code,
Codex, OpenCode, Pi and the ACP runners over MCP, and the built-in runner
in-process (ADR-0070), whose tool list the token decides. A runner that cannot
resume a session still parks; its next start is the carry-over of P4. Not a
read-only task, whose token never lists it: it lands nothing, and its worktree
is thrown away with what it would wait in. Not a delegated task's subplanner,
whose token is a planner's: its child plan waits through its own edges. A
script task has no runner, and an ops task is refused (P1): it already waits at
its merge gate for what it depends on (ADR-0020).

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
- **Refuse the call where the runner cannot continue a session.** The
  prototype's rule. Rejected: the task would wait inside its attempt or end
  unfinished, which is what the tool is for; a carry-over of its files loses
  only the conversation, as a move to another runner does.
- **Leave a park whose work failed blocked, as ADR-0034 blocks any dependent.**
  Rejected: the edge is Ordewell's, not the plan's author's, and a slice whose
  own part is done would never land it unless someone retried the sibling.
- **Clear `parked` as the continue starts, with a separate count.** Rejected:
  a park is owed while no attempt has run since, which the attempt ledger
  already says, so one field holds both the wait and the bound.

## Consequences

- A slice that waits holds no slot and spends no call while it waits.
- The plan changes under the planner, by a task's call: a supervisor reads the
  new edge in its next plan block, and may take it out.
- Every change task's tool list is larger by the tool's description and
  schema, about a kilobyte, on every attempt.

## History

- 2026-11-21 — proposed, with the rule for what a wait may name, the
  continuation's message and the built-in runner's guard prototyped.
- 2026-11-21 — accepted and implemented: a runner without a resumable session parks and starts as a carry-over, a lost wait goes on without it (P7), and a Stop holds a parked task (P8).
- 2026-11-21 — the cycle check counts containment and parks still ending, a park survives a failed spawn, and the shell guard reads only sleeps that run.
- 2026-11-21 — Pi, which joined the task runners beside this decision, is among the runners that have it.
- 2026-11-23 — a park reorders the plan so the waiter follows what it waits for, and the order repair moves running and completed tasks up to let a waiter past, so a park no longer leaves every later edit refused.
