---
status: accepted
amends: ["0013", "0015", "0029"]
---

# 0034 — A failed task blocks only its dependents

## Problem

A task fails when its attempt ends without the evidence a pass needs: the
runner reported `failed` or `blocked` through `task_complete`, or exited
without calling it. Until now a failure *halted* a full-plan run: attempts
already running finished, nothing new started, and the run waited for a retry
of the failed task to resume it.

In a real run one failed task — a live test the host could not support —
stopped every later task, including the many that did not depend on its
output. Nothing about the failure made that work unsafe; the halt only
delayed it until the user noticed and retried something they may not have
been able to fix.

## Decision

**A failed task blocks only its transitive dependents.** Independent work keeps
starting as usual.

- **The blocked rule.** A task not started yet is *blocked* while a dependency
  failed or is itself blocked. A blocked task is never started by the
  scheduler, and its own dependents are blocked with it. A task already at
  work — force-started, or waiting on the user — is not blocked and passes no
  block on. The rule is one pure function (`blockingFailures`,
  `packages/core/src/services/blocking.ts`) over task statuses and
  dependencies; nothing is stored, so whatever lifts a failure lifts its block.
  A load lifts none: a failed task stays failed through it, and so its block
  stands, until a retry, a skip, Mark complete or Execute
  ([ADR-0053](0053-what-waits-on-a-person-is-derived-and-answered-in-one-call.md)).
  There is no `blocked` task status: a plan file saved with one loads it as
  pending.
  Subtasks follow the same rule. A loop's check that failed a round with
  rounds left is stored failed but blocks nothing yet: its body takes its
  report as input, and its other dependents wait for it as for work under way,
  until its loop stops or runs out of rounds
  ([ADR-0045](0045-a-check-repeats-with-its-fix-until-it-passes.md) L3).
- **A skip releases them too.** A skipped dependency is as finished as a
  completed one for the blocked rule: nothing of it lands, so there is
  nothing of its own to wait for. The work it waited on is another matter:
  the scheduler holds its dependents until the tasks behind the skip are met
  by the usual rule (completed, and in an isolated run merged into the
  integration branch), walking through a chain of skips to the nearest tasks
  that were not skipped. A failed or blocked task behind the skip holds
  nothing back, since skipping is how the user gives up on it. Skip ends the
  failed task as `skipped`, a terminal state with no verdict, without landing
  its work; its dependents start once the work behind it is done, told in
  their prompt that it was skipped and why (ADR-0029's `skip_task`). Mark
  complete, by contrast, lands the work as vouched for.
- **Every surface says what blocks a task.** The core task row view reads the
  plan tree and reports `status: 'blocked'` with `blockedBy`, the failed tasks
  by reference; the TUI, VS Code and `ordewell status` show "blocked by #N"
  from it. The scheduler, the command seam's refusals and the supervisor read
  the same function.
- **One start rule.** Whether a task can start now, and if not why, is one
  pure function (`startWaits`, `packages/core/src/services/readiness.ts`) over
  the plan, the holds and the open isolated run. It lists every reason a task
  waits, in a fixed order, so the first is the reason: it has started (or, a
  loop's check between rounds, its loop runs it again once its body lands),
  Mark complete is landing it, it has no prompt, it is outside the user's
  approval record, it is on hold, it is blocked, it is in a loop's body whose
  check has not failed this round, its dependencies are not met (or, for
  a force start queued behind them, are still under way), a Merge all is under
  way and it is an ops task, its runner waits on a usage limit's reset, a
  planner turn holds new starts, it is at its merge gate (ADR-0020), or it is
  a user task. The scheduler's pick, its second look before each claim, the
  automatic merge at a gate, the force starts, the command seam's refusals,
  the task row's merge gate and the planner's view of the plan all read it. A
  force start reads it as forced: past a hold, a failure, a usage limit and
  the merge gate the user confirmed, never past dependencies still under way.
  A hold someone chose (a stop, a completion taken back) lasts until a retry
  or a force start: starting the plan again, the user's Stop of the run and an
  edit of the same plan leave it, and only loading another plan lets it go. The
  hold a failed start sets ("start it again") is not chosen, and a new run
  releases it.
  A force start is judged again once its run has opened, against the task as
  it stands then: one an edit gave dependencies still under way meanwhile
  waits for them, queued or made now. The claim then checks only what can
  change at the last moment: a Stop, the task leaving the plan, Mark complete
  landing it, the approval and a slot (ADR-0029).
- **The run ends when nothing can start.** With nothing running and every task
  left failed or blocked, the run ends (`execution_complete`), saying how many
  tasks completed, failed and are blocked, and how many were skipped; the
  summary carries all four. A loop's check between rounds is not a failed task
  left: its loop still has work to start. A run whose every task completed or was skipped
  is finished.
  A task waiting on the user, on hold, at a merge gate or on a usage limit
  keeps the run open, as before.
- **A retry or a skip continues the run.** Retrying or skipping a task of a
  run that ended on a failure re-arms the scheduler, so the tasks the failed
  one blocked start once its retry passes, or on a skip once the work behind it is done — by the user,
  or by an Act supervisor within its loop guards. A run a usage-limit pause
  holds meanwhile stays held: the retry makes it the plan's run, which the
  reset then lets go (ADR-0018 U1). A planner edit made in between is
  reconciled into that run rather than reloaded over it
  (`TaskOrchestrator.adoptEdit`), so the failed task stays failed: an edit is
  not a retry, and a reload would drop the review approval the retry continues.
  An edit outside a run leaves a failure as it is too. A failed task an edit
  makes manual is the exception, in a run or not: it has nothing to retry, so it
  waits as a manual task does.
  Loading another plan, starting a run (`beginRun`) or stopping one forgets it.
  Every one of these is an event of the run's state, and one pure function
  (`nextRunState`, `packages/core/src/services/runState.ts`) says what each
  leaves.
- **A merge gate and a usage-limit pause keep their meaning.** A task at a
  merge gate (ADR-0020) waits for Merge all and keeps the run open. A
  usage-limit pause still holds the whole run until the limit resets, and the
  reset resumes it whether or not a task failed meanwhile.
- **The supervisor is told.** A failure still wakes it (`task_failed`, ADR-0029);
  a loop's check wakes it once, when its loop runs out of rounds, not for each
  round it fails (ADR-0045).
  The run update names the tasks the failure blocks as the update goes out,
  and the run's end counts the blocked tasks.

Verdicts are unchanged: a task completes only on `task_complete` bound to its
attempt. This decides what a failure stops, not how a verdict is reached.

## Considered options

- **Halt the run on a failure, resume it on a retry.** The design until
  2026-10-14. Rejected: it stops work that does not depend on the failure, so
  one task the host cannot run stalls the whole plan until someone retries it,
  and a failure the user cannot fix leaves the rest of the plan unrun.
- **Store `blocked` on each dependent when a task fails, and clear it when the
  retry passes.** Rejected: a stored status has to be set and cleared on every
  path that fails, retries, edits, removes or reloads a task, and one missed
  path leaves a task blocked by nothing. A rule read from the plan's statuses
  cannot drift from them.
- **End the run but let a retry run only the retried task.** Rejected: the
  tasks the failure blocked would never start once it passed, so a retry
  would not undo the failure's effect — the bug the halt's resume was there to
  fix.
- **Release the dependents only by a passing retry or Mark complete.** The
  design until the skip landed. Rejected: when a failure cannot be fixed on
  this host, the only way to let its dependents go on was Mark complete, which
  lands the failed work as if someone had vouched for it.
- **Let each start path work out the start rule itself.** The design until
  2026-10-18. Rejected: the copies drifted. A runner's usage-limit hold was
  only in the scheduler's pick, the automatic merge at a gate merged for a
  task the user had not approved, and a force start queued behind its
  dependencies started during a planner turn's start hold and past a merge
  gate nobody had confirmed.
- **A load giving a failed task a fresh chance.** The design until 2026-10-31.
  Dropped: a restart unblocked the failure's dependents with nothing said about
  it, so a task could read as ready on a failure nobody had seen. Execute gives
  that chance when the user asks for it.
- **Keep the run open until every failure is retried.** Rejected: a run that
  never ends never hands its work over, and a surface treats the end of the
  execution stream as the run's end; the retry continues an ended run instead.

## Consequences

- A plan finishes everything it can. A failure leaves only its own dependents
  undone, named on every surface and counted in the run's summary.
- A run can end with failed and blocked tasks, its landed work handed over as
  any finished run's is. The retry that continues it opens a run again.
- Independent work runs while a failure waits on the user, so a run spends
  runner time a halt would have held back until the retry.

## History

- 2026-10-14 — accepted and implemented; replaces the halted run.
- 2026-10-14 — a skipped task releases its dependents as a completed one does, without landing its work; a skip continues a run that ended on a failure; run summaries count skipped tasks.
- 2026-10-16 — a skipped dependency no longer lets its dependents start ahead of the work behind it: they wait until the skipped task's own unfinished ancestors are met, and the scheduler log and the command seam's refusals name those ancestors.
- 2026-10-18 — the stored `blocked` status is gone from `TaskStatus`, and so is the code that set and cleared it; a saved one loads as pending, and the derived rule is the only blocked rule.
- 2026-10-18 — the whole start rule is one function, with a typed reason for each wait, which every start path, the seam's refusals, the task row's merge gate and the planner's view read.
- 2026-10-18 — a force start judged again as its run opens waits for dependencies an edit added meanwhile, queued or made now; the claim's last-moment checks are listed in full.
- 2026-10-21 — a loop's check that fails a round with rounds left blocks nothing, ends no run and wakes no one until its loop stops or runs out of rounds; the start rule gains the check between rounds and the body waiting on its check ([ADR-0045](0045-a-check-repeats-with-its-fix-until-it-passes.md)).
- 2026-10-24 — the run's state changes only through `nextRunState`; Execute begins a run with `beginRun` and a planner edit is adopted with `adoptEdit`; a retry while a usage-limit pause holds a run that ended on a failure keeps it held until the reset.
- 2026-10-24 — a hold set by a stop or a taken-back completion survives starting the plan again, the user's Stop of the run and an edit of the same plan; it was cleared by all three.
- 2026-10-31 — a load and an edit outside a run leave a failed task failed, so its block stands; Execute gives the fresh chance ([ADR-0053](0053-what-waits-on-a-person-is-derived-and-answered-in-one-call.md)).
- 2026-10-31 — a failed task an edit makes manual has nothing to retry, so it stops being failed, in a run or not ([ADR-0053](0053-what-waits-on-a-person-is-derived-and-answered-in-one-call.md)).
