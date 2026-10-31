---
status: accepted
amends: ["0013"]
---

# 0015 — Conflict repair: the task repairs its own conflict, bounded and evidenced

**Amends:** ADR-0013 (worktree isolation), which surfaces every merge conflict
for a human and rejected letting a model resolve one.

## Problem

ADR-0013's rule stands for the general case: a conflict is a decision between
two changes, and handing that decision to a model silently rewrites a merge
nobody reviewed. But most conflicts a run hits are not that — they are the
integration branch having moved under a task while it worked, with no real
disagreement about intent. Every one of those still stops the run and waits for
a human, whether or not `maxParallelSessions` gives the run any chance to make
progress elsewhere. `resolveConflictAsTask` already showed the shape of an
answer: an added task, on its own runner and model, that merges the tip and
resolves by hand. This ADR makes that the default first response instead of an
opt-in a person has to ask for, within a bound that keeps it from becoming the
retry loop ADR-0013 also rejected.

## Decision

**When a passed task's landing conflicts, Ordewell keeps the task's worktree,
records the conflicting files, and starts a conflict repair: a new attempt of
the same task, in the same kept worktree, on the task's own runner, model and
mode.** ADR-0001 already forbids rewriting a plan's modes and models at spawn
time; a repair is not a different task, so it inherits both unchanged. Its
prompt is to `git merge` the current integration tip into the task's branch,
resolve the listed files so both sides' intent survives, build and test, commit,
and call `task_complete` on the repair attempt's token — the same shape
`resolveConflictAsTask` already prompts for, run automatically instead of on
request.

- **Evidence, not opinion.** A repair only counts as having repaired the
  conflict when all of the following hold, in order:
  1. the runner calls `task_complete` with `done` on that attempt's token, as any
     other attempt is verified;
  2. the task branch now contains the integration tip the repair started
     from (`git merge-base --is-ancestor <integration-tip> <task-branch>`);
  3. `git diff --check` on the task branch finds no leftover conflict
     markers; and
  4. the normal serialized `--no-ff` landing that follows goes through
     cleanly.
  A repair that satisfies (1)–(3) but still fails (4) is a fresh conflict, not
  a claim taken at its word — exactly the guard `resolveConflictAsTask`
  already relies on. Nothing here lets a model's say-so stand in for the
  Verdict.
- **Bounded.** A setting, `conflictRepairAttempts` (env
  `ORDEWELL_CONFLICT_REPAIR_ATTEMPTS`, VS Code
  `ordewell.conflictRepairAttempts`), caps how many repairs one task may go
  through. Default is 2; 0 turns repair off and every conflict surfaces exactly
  as ADR-0013 describes. The count is per task and persisted on the run record,
  not held in memory, so a restart cannot re-run attempts already spent and
  cannot lose track of how many remain.
- **Slot reuse, not extra concurrency.** A repair starts in the slot the
  integrating attempt just released, and the run never exceeds
  `maxParallelSessions` to make room for one. Isolation properties are
  unchanged: one task, one worktree, one branch, still landed through the same
  serialized queue.
- **Exhaustion never fails the task.** A repair that fails evidence, or a task
  that has used its cap, goes back to `awaiting_user` exactly as an unrepaired
  conflict does today: the conflicting files are named, the worktree and both
  refs are kept, and Mark complete (`m`), resolve-as-a-task (`x`), and retry all
  still work. A failed or exhausted repair is not a failed *task*, so it blocks
  nothing: only a failed task blocks its dependents
  ([ADR-0034](../supervision/0034-a-failed-task-blocks-only-its-dependents.md)), and this
  decision does not touch that.
- **Control stays with the human, just later in the process.** Every repair —
  attempted, evidenced or exhausted — is logged as a notice, and the *Merge
  all* handoff adds a list of the tasks that landed through a repair together
  with the files that conflicted, so review has somewhere to concentrate
  instead of having to re-derive it from git history. Ordewell still never
  merges into the user's own checked-out branch by itself; that boundary is
  untouched.

### One worker per conflict

**A conflict has at most one worker: a repair or a resolver, never both, and
never two resolvers.** The rule is one read, `Landing.liveResolvers`, of the link
`resolveConflictAsTask` makes: a resolver is live while it is in the plan and
neither skipped nor completed. A failed one is still live: retrying it, skipping
it or removing it is the way on.

- **Adding one is refused beside a worker.** `PlanEditor.addConflictResolver`
  asks `TaskOrchestrator.resolverRefusal`, for every path alike: the TUI, VS
  Code, the daemon's route and the inbox's option. A repair at work, a repair
  owed and a live resolver each refuse, in words that say how to take the
  conflict back. A repair owed is refused rather than withdrawn, because the
  resolver would wait for the same slot, and refusing asks nothing of a surface
  that has not caught up.
- **A resolver keeps the conflict.** While one is live, `nextRepair` answers null,
  the start rule holds the conflicted task with the wait `resolver`, and the one
  claim every attempt passes refuses it. So Execute, a force start or a landing
  that conflicts again starts no second worker beside it, however it was reached.
- **A control that would end a conflict waits for a resolver at work.** A retry
  or a skip of the conflicted task is refused until it is stopped or finishes.
  Deleting the task is the user meaning it: its resolver is cancelled.
- **A resolver left behind never starts.** When a conflict ends some other way —
  the task landed, was retried or skipped, left the plan, or a clean-up took the
  branches — its link goes and the resolver not started is skipped, with the
  reason `not needed: the conflict it was added for is gone`, so no merge runs
  that is no longer needed. `landResolved`'s check that the task is still
  conflicted remains the last guard. A skipped task can still be started by
  hand; that is the user's own act.
- **A resolver starts as a repair does.** The user's action asked for the
  conflict to be resolved, so one added with no scheduler driving the run is
  started by `startWhenAllowed`: it waits with the queued starts, is judged by
  the whole start rule and past none of it, takes a free slot within the Parallel
  limit, says what holds it, and a Stop withdraws it. With a scheduler it is
  claimed as any task is, exactly as before.

### How a repair runs

- **Two operations on the isolation seam.** `reopen` hands a `conflict`
  task's kept workspace to the repair as it is and returns the same cwd;
  it records each changed repo's integration tip as `repairBase`, counts the
  repair in `repairs`, adds the conflict's files to `repairedFiles`, and moves
  the record to a new status, `repairing`. `verifyRepair` commits the
  repair's work and checks (2) and (3) above per repo of `repairBase`. The
  landing (4) is the unchanged `integrate`, so `land()` still makes one
  `--no-ff` merge per changed repo, all or nothing.
- **A repair is spent when it starts.** `reopen` counts it before the runner
  is spawned, so a crash can never hand an attempt back. Anything that ends a
  repair without landing it — a failed verdict, a stop, a spawn that fails,
  missing evidence, a release, or `pruneOrphans` after a crash — leaves the
  record `conflict` again, with its files and worktree.
- **Scheduling.** A repair takes the slot the integrating attempt freed. When
  none is free — a Mark complete or a resolver's re-landing that conflicted
  while other tasks hold every slot — the task goes back to `pending`, and the
  scheduler repairs it once a slot frees. More generally, whenever the
  scheduler starts a task whose record is `conflict` and that has repairs
  left — a session restored from disk, the next Execute — it repairs it
  instead of re-running it; with none left it runs afresh from the tip, as a
  conflicted task always has. A repair that did not land waits on the user and
  is not tried again in the same run.
- **A repair that waits reads as what it is.** A repair that will start by
  itself is progress, not a conflict to act on, so `TaskIsolation.repairWaits`
  says what it waits for (a slot, a planner's turn, a usage limit) on the task
  row and the task log, and the inbox leaves it out. It is derived and never
  saved: the record says `conflict`, and the scheduler says a repair is owed.
  Outside a scheduled run `TaskOrchestrator.owedRepairs` holds what no scheduler
  would claim. It respects the Parallel limit, a start hold and a usage limit.
- **Whatever ends that wait leaves the conflict waiting on the user.** A Stop of
  the task, or of the run, withdraws the repair: the task goes to `awaiting_user`
  with reason `conflict`, not back to not started, so its options are offered
  and the inbox lists it (ADR-0053). The same holds for a repair stopped at
  work, on no hold. A load does the same (`settleOwedRepairs`), since what owed
  it went with the host. The repair is not spent by any of this: it was never
  started, and the next Execute repairs the task.
- **What the repair is given.** `buildConflictRepairPrompt` goes through the
  same `composeAugmentedPrompt` as any spawn, with the completion and
  checkpoint tool instructions. The repair uses a fresh attempt token
  (ADR-0025). The task keeps the verdict and output summary
  its own work earned; the repair's verdict only decides whether its work
  tries to land.
- **`git diff --check` exits 2 for whitespace as well as markers**, so only
  its `leftover conflict marker` lines count. Git's own rule decides what a
  marker is: a line the task adds of exactly seven `=` (a Markdown heading
  underline) reads as one, and fails the repair.

## Considered options

- **Resolving inside the integration worktree, during `land()`.** Rejected:
  `land()` runs the one serialized merge queue every task's landing waits on.
  Resolving there — even briefly — holds that queue for the length of a whole
  agent session, and the more tasks a run parallelizes, the worse that gets. A
  repair belongs in the task's own worktree, on its own attempt, so the queue
  only ever does the mechanical merge it already does.
- **A resolver withdrawing a repair owed.** Rejected: the resolver needs the same
  slot, and a press on a stale surface would give up a repair that was about to
  run. A Stop is one press, and says what it did.
- **Removing a resolver left behind from the plan.** Rejected: a task the user
  asked for would vanish, along with what depends on it; a skip keeps it, with
  why, as a loop's body is kept when its loop ends.
- **A saved mark for a repair that waits.** Rejected: it would have to be set and
  cleared on every path, as ADR-0034 and ADR-0053 rejected for what they derive.
- **Reading a saved `pending` task with a conflict as still owed.** Rejected:
  nothing starts it after a load, so the inbox would leave out a conflict that
  will not move, and the row would say a repair is coming.
- **Spawning resolver tasks automatically, added to the plan.** Rejected: it
  grows the plan with work nobody planned, which is exactly what ADR-0001 tries
  to keep from happening implicitly. `resolveConflictAsTask` (the `x` action)
  already gives a human that option explicitly; a repair is a new attempt of
  the *same* task, not a new plan entry, and never adds one on its own.
- **Unbounded retries.** Rejected: a conflict that keeps recurring — because
  the two sides genuinely disagree, or because the tip keeps moving faster than
  the task can catch up — would retry forever with no signal that it should
  stop. `conflictRepairAttempts` exists so a run always reaches a human instead.
- **Keeping ADR-0013's surface-only rule as the only path.** Rejected as the
  only path, though it remains the fallback: every conflict needing a human
  does not scale as parallelism grows, and most conflicts a run hits are stale
  tips, not real disagreements. The evidence bar above is what keeps a repair
  honest when it is tried, and `conflictRepairAttempts: 0` keeps the old
  behavior available to anyone who wants it.

## Consequences

- A merge that goes through cleanly — repaired or not — but breaks something
  only once combined with other landed work is not caught here; that is the
  plan's final verification task's job, unchanged.
- A repair that runs out of attempts is a conflict still waiting on a human,
  not a failed task, so its dependents wait rather than being blocked (ADR-0034).
  Making a conflict that a human declines to resolve eventually fail the task
  is future work, not decided here.
- The persisted per-task attempt count is new state on the run record; a
  record saved before this ADR has none and is read as zero attempts spent,
  so an old run's first conflict after upgrading still gets its full
  `conflictRepairAttempts`.

## History

- 2026-09-26 — accepted and implemented.
- 2026-10-09 — aligned with [ADR-0025](../runners/0025-structured-only-runners.md).
- 2026-10-14 — a failed task blocks only its dependents instead of halting the run ([ADR-0034](../supervision/0034-a-failed-task-blocks-only-its-dependents.md)).
- 2026-10-31 — one worker per conflict; a repair that waits says so, and a Stop or a load leaves its conflict waiting on the user; a resolver left behind is skipped, and one added outside a run is started.
