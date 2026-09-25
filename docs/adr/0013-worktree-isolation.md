# 0013 — Worktree isolation: one checkout per task, one branch per run

**Status:** accepted — amended by [ADR-0014](0014-multi-repo-workspaces.md)

**Amended by ADR-0014** (multi-repo workspaces): the workspace is a *repo group* rather than one repository. Where a decision below is changed, a note marked *ADR-0014* says how; everything unmarked stands.

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

*ADR-0014: "the workspace is a git repository" becomes "the workspace is a repo group". A single repo is a group of one; each task gets one worktree per repo.*

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
  *ADR-0014: the base ref and integration branch are per repo, so the run holds one of each for every repo in the group.*
- **Naming and location.** Worktrees at
  `.ordewell/worktrees/<run-id>/<order>-<slug>`, branches
  `ordewell/<run-id>/<order>-<slug>`, integration branch
  `ordewell/<run-id>/integration`. `.ordewell/` is already git-ignored and
  skipped by every workspace scan, so worktrees stay out of git's view; cleanup
  is directory removal plus `git worktree prune`. A merge needs a checkout, and
  the user's is off limits, so the integration branch has its own worktree, which
  is released at handoff so the user can check the branch out.
  *ADR-0014: a task's worktrees live together in one task workspace, `.ordewell/worktrees/<run-id>/<order>-<slug>/`, each at its repo's relative path and all on one shared branch name.*
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
  *ADR-0014: integration is atomic across repos — a conflict or failure in any repo the task changed rolls back its merges in the others, and the task is `conflict` as a whole.*
- **Dirty trees block isolation.** Modified tracked files make isolated
  execution unavailable for that run (`dirty`). Untracked and ignored files do
  not, because the bootstrap accounts for them. `isActive` returns the reason
  (`disabled`, `git-missing`, `not-git`, `no-commits`, `dirty`) rather than a
  boolean, since the orchestrator answers a dirty tree with an offer to stash or
  to run without isolation, and the others with a one-line notice and today's
  shared-root behavior.
  *ADR-0014: any dirty repo in the group holds the whole run, the notice names the repos, and stash and "run without isolation" apply to the whole group. `nested-repos` is a new reason, naming the nested repos; `not-git` is left for a folder with no repository in it, and `no-commits` for a group none of whose repos has a commit.*
- **Bootstrap makes a worktree runnable.** Ignored artifacts — `node_modules`,
  `vendor`, `.venv`, `.env*`, `.envrc`, `.claude`, `.opencode`, `.codegraph` —
  are linked from the main worktree, only where the checkout does not already
  provide the path. `.ordewell/` is never linked: Ordewell's session and skills
  state stays at the main root where a runner cannot corrupt it. A configured
  `worktreeSetupCommand` replaces the linking for repos where sharing is wrong.
  The links are recorded, and the commit step keeps them out of the task's
  commit: an ignore rule such as `node_modules/` does not match a symlink, so
  without that they would be committed.
  *ADR-0014: linking and the setup command apply per repo, `worktreeLinks` adds paths, and loose files and un-isolatable repos become shared paths.*
- **Windows needs no privilege (ADR-0010).** Directory symlinks require
  administrator rights or developer mode on Windows, so directories become
  junctions and files are copied. Copies are what make the recorded link list
  matter there, since a copied `.envrc` is a plain untracked file.
  *ADR-0014: files become hard links, copied only when a hard link is impossible (a different volume), with a notice.*
- **Never merged for the user.** Ordewell never merges into the checked-out
  branch on its own. The end of a run is a handoff: the integration branch, the
  base ref and what landed, with helpers to review the diff against the base ref,
  to merge on request (a normal `git merge`, aborted on conflict so the user's
  tree is left as it was), and to discard a run. Discarding removes worktrees and
  task branches but can keep the integration branch until it is explicitly given
  up.
  *ADR-0014: one "Merge all" preflights every repo first and merges none unless all pass, and the review diff has one section per repo.*
- **Crash recovery.** `pruneOrphans` runs when a session is adopted: it drops
  worktrees of tasks that were `active` when the process died, directories and
  branches under the run that no record owns, and stale registrations. Kept,
  failed and conflicted worktrees are what the user may want, so they stay.
  `release(..., { keep: true })` exists so a task whose verification failed is
  moved off `active` and survives that sweep.
  *ADR-0014: pruning covers every repo in the group.*
- **Config.** `worktreeIsolation` (default on), an `ORDEWELL_WORKTREE_ISOLATION`
  environment override, and an optional `worktreeSetupCommand`
  (`ORDEWELL_WORKTREE_SETUP`), following the `BaseConfig`/`EnvConfig` pattern.
  A repo with hooks or submodules that assume one worktree opts out with the
  setting rather than by not being a git repo.
  *ADR-0014: adds `workspaceRepos` and `worktreeLinks`.*

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
  *ADR-0014: a folder that holds repositories is no longer a non-git workspace; it isolates them as a repo group. A repository with nested repositories that are not submodules, which used to isolate without them, is refused (`nested-repos`).*
- Integration serializes, so the throughput gain is bounded by the dependency
  graph the planner emits. Isolation makes overlap safe; it does not predict it.
- A linked `node_modules` is shared, so concurrent installs from two worktrees
  race. The setup command is the escape hatch.
- Git hooks run on the per-task and merge commits as they would for the user.
  A hook that assumes a single worktree fails the commit, the task lands
  `failed` with its refs kept, and the user can opt out.
- Not yet true when this was accepted: the orchestrator did not use the module
  and nothing was persisted. See the updates below.

## Update (2026-09-25) — wired into the orchestrator, Session and planner prompt

The orchestrator now executes through the module. What that took, where the
first draft of the wiring was wrong, and what was chosen instead:

- **Integration happens inside the attempt.** A passed verdict does not end the
  attempt: it moves to an `integrating` phase and the task stays `in_progress`
  until the merge answers. Only `merged` completes it, so "a dependent waits for
  its predecessor to be *integrated*" is not a second rule in `getReadyTasks`
  but what `completed` means in an isolated run (`dependencyMet` states it
  anyway, for completions that did not come from a verdict). Keeping the attempt
  live also keeps the identity rule: a cancel, retry or stop during the merge
  wins, and waits for the merge before it tears the worktree down.
- **`merged` does not call `release`.** `integrate` already removes a merged
  task's worktree and branch and keeps its record, which is what the handoff's
  `landed` list is read from. A `release(…, { keep: false })` after it — the
  obvious wiring — would drop that record and the task would vanish from the
  handoff it landed in.
- **The other outcomes.** `conflict` → the task is `awaiting_user`, worktree
  and refs kept, dependents wait. `failed` (git refused, e.g. a hook) → the task
  is `failed` and the run halts exactly as for a failed verdict, refs kept. A
  failed verdict and a stop keep the worktree (`keep: true`); cancel, retry,
  removal from the plan and a failed spawn remove it. A retry prepares afresh
  from the integration tip when it next starts. Mark complete is a passed
  verdict the user vouches for, so it integrates too — the way out of a stuck
  task whose work is sitting in its worktree, and of a conflict resolved by hand.
- **A run continues the plan's record while anything has landed on it.** "A new
  run mints a new record" was the plan, and it is wrong for a resumed plan: after
  a failure, the next Execute preserves completed tasks, and a fresh integration
  branch cut from the checked-out commit would hand their dependents a tree
  without the work they depend on. So a run continues the plan's `IsolationRun`
  (same integration branch, same base ref) while it has a `merged` task; a
  record with nothing landed holds only superseded attempts and is discarded
  whole before a new one is minted. `discardRun` is how a user starts over.
- **Activation.** A run starts (Execute Plan, Run task, or Force start with
  nothing running) by asking `isActive`. `not-git`, `git-missing`, `no-commits`
  and `disabled` run in the workspace root with one notice. `dirty` does not
  start: an `isolation_blocked` message goes out, and the start is parked until
  `Session.continueWithStash` (a `git stash push`, through the module like every
  other git operation) or `Session.continueWithoutIsolation` (this run only) replays it.
  Continuing a run on a dirty tree is not blocked — its base is already fixed,
  so the user's edits could not reach it either way.
- **Handoff before completion.** When an isolated run settles, `handoff` runs and
  `isolation_handoff` is broadcast *before* `execution_complete`: the TUI closes
  its execution stream on the latter, so anything after it is lost.
- **Persistence.** `LegacyPlanState.isolation` holds `{ run, resolvers }`,
  written from the orchestrator at persist time like `tasks`, and saved on every
  change to it rather than at the end of the run — the record is what lets a
  crashed process's worktrees be found again. Adopting a saved plan prunes
  orphans without persisting: VS Code's restore adopts with `persist: false`,
  and a write there would fork a new session file on every reload. A fork of a
  plan must not carry the field; the branches it names belong to one plan.
- **Resolve as a task.** `resolveConflictAsTask` adds an AI task on the
  conflicted task's runner and model whose prompt is to `git merge --no-ff` the
  conflicted branch in its own worktree (which starts at the integration tip)
  and resolve it. When that task lands, the conflicted task is integrated again
  through the same queue: its branch is an ancestor by then, so it merges clean
  — and if the resolver did not really bring it along, it conflicts again rather
  than being taken at its word. Nothing adds the task but the explicit call.
- **Discard does not rewrite the plan.** Discarding a run leaves completed tasks
  completed. Whether their work was kept (merged by hand, or with `mergeRun`)
  is something only the user knows; Mark not done is how they say it was not.
- **The planner is told.** `PlannerModes.isolatedExecution` (one-shot and
  mid-run edits) and `ConversationVariant.isolatedExecution` (the conversation)
  swap the overlap-avoidance rule for one that allows same-file parallelism and
  keeps dependencies for genuine ordering. The shared-workspace text is
  unchanged, word for word. A dirty tree counts as *not* isolating: the user may
  still choose to run without isolation, and the ordering rule is the safe one then.
- **Transcripts in a worktree.** Claude Code names its transcript directory
  after the cwd with every non-alphanumeric turned into `-`. The reader only
  replaced `/` and `_`, which never mattered until the cwd was under
  `.ordewell/`; it now matches Claude Code's rule, so a worktree task's summary
  comes from its transcript rather than the terminal render.
- **A checkpoint needs a live attempt.** A conflicted task is `awaiting_user` like
  a checkpoint is. Approving or rejecting a checkpoint with no attempt behind it
  is now ignored; before, it would have put the conflicted task back to
  `in_progress` with no runner.
- **Tests do not run git by accident.** `fakeConfig` now has
  `worktreeIsolation: false`. An orchestrator built without an injected
  isolation falls back to git, and the suites run inside this repository; with
  the setting on, they would have created worktrees in it.

## Update (2026-09-25) — surfaces, and what the integration review changed

The daemon passes `isolation_blocked` and `isolation_handoff` through unchanged
and adds routes for the handoff steps (`/isolation/diff`, `merge`, `cleanup`,
`discard`), for the blocked run's two ways on (`stash-and-continue`,
`run-without`) and for `resolve-conflict`. The TUI marks a conflicted task in the
plan pane and shows a branch and worktree only in a task's expanded detail; the
handoff overlay (`/handoff`) opens on `isolation_handoff` when nothing else is
open, and a blocked run asks with a three-way picker. The CLI has
`ordewell handoff [review|merge|discard|cleanup]` and `ordewell run --stash` /
`--without-isolation`. VS Code shows the same marks on its task cards, a handoff
card, and a host modal for a blocked run; merge and discard are confirmed first
everywhere.

Reviewing the branches together changed five things:

- **A run closes however its last attempt ends.** Only a verdict used to close
  a run the scheduler was not driving — a manual task run, or a halted plan's
  remaining attempts. Ended by cancel, Mark complete or a failed spawn, the run
  stayed open, no handoff went out, and the next run inherited its mode: after a
  discard, tasks ran in the workspace root while the planner was told they were
  isolated. An idle `tick` now closes it.
- **A resolver lands only a task that is still conflicted.** A conflicted task
  the user retried meanwhile has a new attempt of its own; landing it through
  the resolver merged that attempt's half-done worktree and completed it.
- **Landed work keeps its branch when a run cannot be continued.** "A record
  with nothing landed is discarded whole" was applied to every run a new one
  replaced, including one that holds landed work but ran from another workspace
  path; its integration branch now stays.
- **Claude Code shortens long directory names.** It keeps the first 200
  characters of the munged cwd and appends a hash of the full path, and a
  worktree path reaches that sooner than a workspace root. The transcript reader
  takes every directory with the kept prefix as a candidate; the completion
  marker decides.
- **A surface that was not listening is re-told from the record.** The stream
  reports isolation only as it changes. `Session.isolationView` reads the marks
  and the handoff from the run record; VS Code replays it when its webview
  reconnects or a session is loaded (the card waits while a run executes), and
  the TUI and CLI read the same record from the saved plan.

