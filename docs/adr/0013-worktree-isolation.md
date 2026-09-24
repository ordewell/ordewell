# 0013 — Worktree isolation: one checkout per task, one branch per run

**Status:** accepted

Every AI task ran in the same working directory — the workspace root. With
`maxParallelSessions` above one, several Runners edited that one tree at once.
The planner was told to keep parallel tasks on different files, but that is
advice to a model, not a boundary: it costs parallelism when two useful tasks
touch one file and get serialized by an invented dependency, and it fails
silently when they overlap anyway. Runner B rewrites the file Runner A just
changed, A's completion marker still appears, and A verifies `pass` against a
tree that no longer holds A's work. There is no per-task record of what changed,
no way to undo one task, and — because Runners write straight into the user's
tree — nothing stops a run trampling uncommitted work.

## Decision

**When the workspace is a git repository, each AI task runs in its own
worktree, and the results are integrated deterministically on a per-run branch.**
A `WorktreeIsolation` module in core owns every git and filesystem operation for
this. The orchestrator gets a `cwd` from `prepare`, spawns the Runner there, and
after the evidence-based Verdict calls `integrate`. This task adds the module,
its record types and its config; wiring it into the orchestrator, persistence and
the surfaces is separate work.

### Key properties

- **One seam, and it is not the runner's.** A Runner is handed a `cwd` and
  nothing more (ADR-0007). Git never enters `ITerminalRunner`, `RunnerRegistry`
  or a runner adapter, so Claude Code, Codex and OpenCode cannot produce three
  different git behaviors. The module is injected into the orchestrator the way
  `ITerminalRunner` and `PlanStore` are; scheduling tests use
  `FakeWorktreeIsolation`, and git behavior is tested against real temporary
  repositories asserting porcelain state — worktrees listed, branch contents,
  files present — never command lines.
- **Isolation is run-scoped.** An `IsolationRun` is minted when a run starts:
  an id, the base ref resolved to a commit *then*, the integration branch name,
  and per-task branch/worktree/status. It is plain JSON so it can be persisted
  with the plan state. Because task ids are only unique within one plan and one
  daemon serves many (the ADR-0007 T7 point), operations that act on a task take
  the run — `release(run, taskId, …)`, not a bare id.
- **Naming and location.** Worktrees at
  `.ordewell/worktrees/<run-id>/<order>-<slug>`, branches
  `ordewell/<run-id>/<order>-<slug>`, integration branch
  `ordewell/<run-id>/integration`. `.ordewell/` is already git-ignored and
  skipped by every workspace scan, so worktrees stay out of git's view; cleanup
  is directory removal plus `git worktree prune`. A merge needs a checkout, and
  the user's is off limits, so the integration branch has its own worktree, which
  is released at handoff so the user can check the branch out.
- **Integration is a serialized queue.** Verdicts can land concurrently. The
  module merges one task at a time with `git merge --no-ff` — a merge commit per
  task preserves any commits a Runner made itself, makes attribution visible, and
  makes the task branch an ancestor so it is safe to delete. Among tasks already
  waiting, the lowest plan `order` merges first. It never waits for a task that
  has not finished: a dependent cannot run until its predecessor integrates, so
  blocking on a lower-order task that is waiting on the queue would deadlock.
  Ordering is therefore deterministic for what is ready, not a promise about what
  is not.
- **Conflicts are surfaced, never resolved.** A conflicting merge is aborted,
  the worktree and both refs are kept, and the outcome is `conflict`. Nothing
  resolves it automatically; running a resolve task is an opt-in the surfaces
  offer.
- **Dirty trees block isolation.** Modified tracked files make isolated
  execution unavailable for that run (`dirty`). Untracked and ignored files do
  not, because the bootstrap accounts for them. `isActive` returns the reason
  (`disabled`, `git-missing`, `not-git`, `no-commits`, `dirty`) rather than a
  boolean, since the orchestrator answers a dirty tree with an offer to stash or
  to run without isolation, and the others with a one-line notice and today's
  shared-root behavior.
- **Bootstrap makes a worktree runnable.** Ignored artifacts — `node_modules`,
  `vendor`, `.venv`, `.env*`, `.envrc`, `.claude`, `.opencode`, `.codegraph` —
  are linked from the main worktree, only where the checkout does not already
  provide the path. `.ordewell/` is never linked: Ordewell's session and skills
  state stays at the main root where a runner cannot corrupt it. A configured
  `worktreeSetupCommand` replaces the linking for repos where sharing is wrong.
  The links are recorded, and the commit step keeps them out of the task's
  commit: an ignore rule such as `node_modules/` does not match a symlink, so
  without that they would be committed.
- **Windows needs no privilege (ADR-0010).** Directory symlinks require
  administrator rights or developer mode on Windows, so directories become
  junctions and files are copied. Copies are what make the recorded link list
  matter there, since a copied `.envrc` is a plain untracked file.
- **Never merged for the user.** Ordewell never merges into the checked-out
  branch on its own. The end of a run is a handoff: the integration branch, the
  base ref and what landed, with helpers to review the diff against the base ref,
  to merge on request (a normal `git merge`, aborted on conflict so the user's
  tree is left as it was), and to discard a run. Discarding removes worktrees and
  task branches but can keep the integration branch until it is explicitly given
  up.
- **Crash recovery.** `pruneOrphans` runs when a session is adopted: it drops
  worktrees of tasks that were `active` when the process died, directories and
  branches under the run that no record owns, and stale registrations. Kept,
  failed and conflicted worktrees are what the user may want, so they stay.
  `release(..., { keep: true })` exists so a task whose verification failed is
  moved off `active` and survives that sweep.
- **Config.** `worktreeIsolation` (default on), an `ORDEWELL_WORKTREE_ISOLATION`
  environment override, and an optional `worktreeSetupCommand`
  (`ORDEWELL_WORKTREE_SETUP`), following the `BaseConfig`/`EnvConfig` pattern.
  A repo with hooks or submodules that assume one worktree opts out with the
  setting rather than by not being a git repo.

## Considered options

- **Full clones per task.** Rejected: a clone duplicates the object store for
  every task and severs the shared ref namespace, so integrating means fetching
  between clones and a crash leaves whole repositories behind. A linked worktree
  shares objects and refs with the main repository, so integration is a local
  merge and cleanup is `git worktree remove`.
- **One shared worktree per batch of parallel tasks.** Rejected: it moves the
  same-file problem rather than removing it. Tasks in a batch would still edit one
  tree at once, a `pass` could still be won by work a sibling later overwrote, and
  there would be no per-task branch to inspect, retry or undo.
- **Auto-merging the result into the user's branch.** Rejected: it is the one
  irreversible step, and it would land work in a tree that may hold uncommitted
  changes. Ordewell produces one reviewable branch and the user chooses to
  review, merge or discard.
- **Model-resolved merge conflicts.** Rejected: resolving a conflict is deciding
  which of two changes wins, and handing that to a model silently rewrites a merge
  nobody reviewed. It also makes the verdict depend on a model, against the rule
  that verdicts come from evidence. The conflict is surfaced with everything
  needed to resolve it by hand, or as an explicit, opt-in task.
- **Excluding links with a shared `info/exclude`.** Rejected in favor of
  recording the links per task: that file is shared by every worktree of the
  repository, so it would edit the user's repository configuration and leak the
  exclusion into their own checkout.

## Consequences

- Non-git workspaces, a missing git binary, `no-commits` and a disabled setting
  behave exactly as before.
- Integration serializes, so the throughput gain is bounded by the dependency
  graph the planner emits. Isolation makes overlap safe; it does not predict it.
- A linked `node_modules` is shared, so concurrent installs from two worktrees
  race. The setup command is the escape hatch.
- Git hooks run on the per-task and merge commits as they would for the user.
  A hook that assumes a single worktree fails the commit, the task lands
  `failed` with its refs kept, and the user can opt out.
- Not yet true, by design: the orchestrator does not use the module, nothing is
  persisted, and no surface shows isolation state. Those follow.
