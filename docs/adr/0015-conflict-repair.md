# 0015 — Conflict repair: the task repairs its own conflict, bounded and evidenced

**Status:** accepted — amends [ADR-0013](0013-worktree-isolation.md)

**Amends:** ADR-0013 (worktree isolation), which surfaces every merge conflict
for a human and rejected letting a model resolve one.

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
- **Exhaustion never halts the run.** A repair that fails evidence, or a task
  that has used its cap, goes back to `awaiting_user` exactly as an unrepaired
  conflict does today: the conflicting files are named, the worktree and both
  refs are kept, and Mark complete (`m`), resolve-as-a-task (`x`), and retry all
  still work. A failed or exhausted repair is not a failed *task* — ADR-0013's
  "a failed task halts the run" is unchanged and untouched by this decision.
- **Control stays with the human, just later in the process.** Every repair —
  attempted, evidenced or exhausted — is logged as a notice, and the *Merge
  all* handoff adds a list of the tasks that landed through a repair together
  with the files that conflicted, so review has somewhere to concentrate
  instead of having to re-derive it from git history. Ordewell still never
  merges into the user's own checked-out branch by itself; that boundary is
  untouched.

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
- "A failed task halts the run" is unchanged: a repair that runs out of
  attempts is a conflict still waiting on a human, not a run-ending failure.
  Making a conflict that a human declines to resolve eventually halt the run is
  future work, not decided here.
- The persisted per-task attempt count is new state on the run record; a
  record saved before this ADR has none and is read as zero attempts spent,
  so an old run's first conflict after upgrading still gets its full
  `conflictRepairAttempts`.

## History

- 2026-09-26 — accepted and implemented.
- 2026-10-09 — aligned with [ADR-0025](0025-structured-only-runners.md).
