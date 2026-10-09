# 0013 — Worktree isolation: one checkout per task, one branch per run

**Status:** accepted — extended by [ADR-0014](0014-multi-repo-workspaces.md) (repo groups), [ADR-0015](0015-conflict-repair.md) (conflict repair), [ADR-0019](0019-nested-repos-shared-live.md) (nested repositories) and [ADR-0020](0020-ops-tasks-and-merge-gates.md) (ops tasks and merge gates)

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

**When the workspace forms a repo group — a git repository, or a folder of them
(ADR-0014) — each change task runs in its own worktree, and the results are
integrated deterministically on a per-run branch.** A change task is every AI
task that is not an ops task; an ops task runs at the workspace root, behind a
merge gate (ADR-0020). A `WorktreeIsolation`
module in core owns every git and filesystem operation for this. The
orchestrator gets a `cwd` from `prepare`, spawns the Runner there, and after the
evidence-based Verdict lands the work. A single repository is a group of one;
everything below applies per repo of the group.

### Key properties

- **One seam, and it is not the runner's.** A Runner is handed a `cwd` and
  nothing more (ADR-0007). Git never enters `ITerminalRunner`, `RunnerRegistry`
  or a runner adapter, so Claude Code, Codex and OpenCode cannot produce three
  different git behaviors. The module is injected into the orchestrator the way
  `ITerminalRunner` and `PlanStore` are; scheduling tests use
  `FakeWorktreeIsolation`, and git behavior is tested against real temporary
  repositories asserting porcelain state — worktrees listed, branch contents,
  files present — never command lines.
- **Isolation is run-scoped.** An `IsolationRun` is minted when a run's first
  change task starts:
  an id, per repo the base ref resolved to a commit *then* and the integration
  branch name, and per-task branch/worktree/status. It is plain JSON so it can
  be persisted with the plan state. Because task ids are only unique within one
  plan and one daemon serves many (ADR-0007 T7), operations that act on a task
  take the run — `release(run, taskId, …)`, not a bare id.
- **A run continues the plan's record while anything has landed on it.** After a
  failure, the next Execute preserves completed tasks, and a fresh integration
  branch cut from the checked-out commit would hand their dependents a tree
  without the work they depend on. So a run continues the plan's `IsolationRun`
  (same integration branches, same base refs) while it has a `merged` task; a
  record with nothing landed holds only superseded attempts and is discarded
  whole before a new one is minted. `discardRun` is how a user starts over.
- **Naming and location.** A task's worktrees live together in one *task
  workspace*, `.ordewell/worktrees/<run-id>/<order>-<slug>/`, each at its repo's
  relative path, all on one branch name `ordewell/<run-id>/<order>-<slug>`; the
  integration branch is `ordewell/<run-id>/integration` in each repo.
  `.ordewell/` is git-ignored and skipped by every workspace scan, so worktrees
  stay out of git's view; cleanup is directory removal plus `git worktree
  prune`. A merge needs a checkout, and the user's is off limits, so the
  integration branch has its own worktree, released at handoff so the user can
  check the branch out.
- **Integration happens inside the attempt.** A passed verdict does not end the
  attempt: it moves to an `integrating` phase and the task stays `in_progress`
  until the landing answers. Only `merged` completes it, so "a dependent waits
  for its predecessor to be *integrated*" is not a second rule in
  `getReadyTasks` but what `completed` means in an isolated run
  (`dependencyMet` states it anyway, for completions that did not come from a
  verdict). Keeping the attempt live also keeps the identity rule: a cancel,
  retry or stop during the merge wins, and waits for the merge before it tears
  the worktree down. Mark complete is a passed verdict the user vouches for, so
  it integrates too — the way out of a stuck task whose work is sitting in its
  worktree, and of a conflict resolved by hand.
- **Integration is a serialized queue.** Verdicts can land concurrently. The
  module merges one task at a time with `git merge --no-ff` — a merge commit per
  task preserves any commits a Runner made itself, makes attribution visible, and
  makes the task branch an ancestor so it is safe to delete. A landing is atomic
  across the repos a task changed (ADR-0014). Subjects name the change, not the
  plan: the merge commit is `Merge: <task title>` and the sweep-up commit (for
  work a Runner left uncommitted) is the title alone. The plan's task `order` and
  the run id are Ordewell-internal and never enter a message that can reach the
  user's branch. Among tasks already waiting, the lowest plan `order` merges
  first. It never waits for a task that has not finished: a dependent cannot run
  until its predecessor integrates, so blocking on a lower-order task that is
  waiting on the queue would deadlock. Ordering is therefore deterministic for
  what is ready, not a promise about what is not. The `Landing` module
  (`services/Landing.ts`) lands a passed attempt and answers `landed`,
  `nothing-to-land`, `repair-needed` or `awaiting_user` (`conflict`,
  `landing-failed`, `repair-failed`); it never marks a task, starts an attempt
  or emits — the orchestrator applies what it answers.
- **A landing that does not go through waits on the user and never halts the
  run.** A conflicting merge is aborted with the worktree and both refs kept; it
  first gets a bounded, evidenced conflict repair on the task's own attempt
  (ADR-0015), and only a conflict repair does not clear is left `awaiting_user`,
  dependents waiting. A landing git refuses (a hook, for instance) leaves the task
  `awaiting_user` with its verdict `pass`, its worktree and branch kept (the
  record is `failed`, which surfaces show as `kept`) and the error naming what
  git stopped on; Mark complete lands it once the cause is fixed. Other ready
  tasks go on starting either way; only a failed *verdict* — no marker — halts
  the run. The work is finished, its marker the evidence, and it sits intact in
  its worktree.
- **What happens to a worktree.** `merged` removes the task's worktree and branch
  and keeps its record, which is what the handoff's `landed` list is read from.
  A failed verdict, a stop and a cancel keep the worktree (`keep: true`) — a
  runner is often cancelled because it looked stuck after finishing, and the
  finished work must survive. Retry, removal from the plan and a failed spawn
  remove it. The next attempt's `prepare` replaces a kept worktree from the
  current integration tip, so nothing piles up.
- **Dirty trees.** Modified tracked files in any repo of the group make
  isolated execution unavailable for that run (`dirty`); untracked and ignored
  files do not, because the bootstrap accounts for them. `isActive` returns the
  reason (`disabled`, `git-missing`, `not-git`, `no-commits`, `dirty`, the last
  two possibly naming repos) rather than a boolean.
- **Activation.** A run opens with Execute Plan, Run task, or Force start with
  nothing running, and decides whether it isolates when its first change task
  starts, by asking `isActive` (ADR-0020): an ops task needs no worktree, so a
  run of only ops tasks never asks. `not-git`, `git-missing`, `no-commits` and
  `disabled` run in the workspace root with one notice. `dirty` starts no change
  task: an `isolation_blocked` message names the dirty repos, and the start is
  parked until `Session.continueWithStash` (a `git stash push` in every dirty
  repo, through the module like every other git operation) or
  `Session.continueWithoutIsolation` (this run only, the whole group) replays it.
  Ops tasks already running carry on meanwhile. Continuing a run on a dirty tree
  is not blocked — its base is already fixed, so the user's edits could not
  reach it either way.
- **Bootstrap makes a worktree runnable.** Ignored artifacts — `node_modules`,
  `vendor`, `.venv`, `.env*`, `.envrc`, `.claude`, `.opencode`, `.codegraph` —
  are linked from the main worktree per repo, only where the checkout does not
  already provide the path, plus any `worktreeLinks` matches. `.ordewell/` is
  never linked: Ordewell's session state stays at the main root where a runner
  cannot corrupt it. `.ordewell/skills/` is the one committed part — the
  generated `.ordewell/.gitignore` ignores everything in the state directory
  except itself and `skills/` — so a project's skills reach a worktree through
  git, as its own checked-out copy ([ADR-0024](0024-unified-skills.md)). A
  runner only ever edits that copy, which lands through the merge gate and the
  user's handoff merge; the main root's state is never written by a runner. In
  a multi-repo group (ADR-0014) the group root is no repository, so its own
  `.ordewell/skills/` is read from the main checkout and needs no commit, and
  each repo's committed folder is read as checked out in the task's worktree.
  The links are recorded, and the commit step keeps
  them out of the task's commit: an ignore rule such as `node_modules/` does not
  match a symlink, so without that they would be committed. A configured
  `worktreeSetupCommand` replaces the linking for a repo, run once per repo with
  `ORDEWELL_REPO` and `ORDEWELL_MAIN_REPO` set.
- **`node_modules` is mirrored entry by entry.** It is a real directory in the
  worktree, for the repo root and for each workspace package the root
  `package.json` lists under `workspaces` (the same single-segment globs as
  `worktreeLinks`) that the main checkout has installed and the worktree has the
  folder for. Its entries are linked one by one, going one level into `@scope`
  directories and `.bin`. A real package is linked to the main checkout's copy,
  so the install stays shared. A link is recreated: a relative one keeps its
  text, so a workspace link (`node_modules/@scope/pkg -> ../../packages/pkg`)
  resolves to the worktree's own package and a `.bin` link through the
  worktree's `node_modules`; an absolute one into the main checkout outside any
  `node_modules` (what npm writes on Windows, as a junction) is moved to the same
  place in the worktree; any other keeps its text. On Windows a relative link
  becomes a junction or hard link to its target resolved in the worktree, and one
  that resolves to nothing there is skipped; the platform rules stay in
  `worktreeLink.ts` (ADR-0010). The mirrored directory is recorded like a link
  and excluded from the task's commit; removal unlinks every link inside it
  before anything deletes the worktree, and finds the workspace packages'
  directories again from `package.json` when a crash left no record.
- **Windows needs no privilege (ADR-0010).** Directories become junctions and
  files hard links, copied only when a hard link is impossible (a different
  volume), with a notice. Copies are what make the recorded link list matter
  there, since a copied `.envrc` is a plain untracked file.
- **Never merged for the user.** Ordewell never merges into the checked-out
  branch on its own. When an isolated run settles, `handoff` runs and
  `isolation_handoff` (integration branches, base refs, what landed) is broadcast
  *before* `execution_complete` — the TUI closes its execution stream on the
  latter, so anything after it is lost. What follows is the user's: review the
  diff against the base refs (one section per repo), *Merge all* (preflighted in
  every repo, merging all or none, ADR-0014; a normal `git merge`, aborted on
  conflict so the user's tree is left as it was), clean up, or discard. Merge
  all is also how the user opens a merge gate during a run (ADR-0020); it takes
  turns with the landing queue, so it never reads an integration branch
  mid-landing.
- **Integration branches go once their work is merged, never before.** Ordewell
  never deletes landed work the user has not merged, and never touches a branch
  it does not own. A Merge all that answers `merged` on a settled run clears it
  up: it is discarded as clean-up does — worktrees and task branches, a kept or
  conflicted attempt's included — and each repo's integration branch is deleted
  where the repo's checked-out HEAD contains it (`git merge-base --is-ancestor
  <branch> HEAD`, then `git branch -d`, which adds git's own refusal for a branch
  a worktree has checked out). The orchestrator then forgets the run, so the
  plan's record, every surface's handoff and every task mark go with it, and the
  next run starts from a HEAD that holds the work. A Merge all during a run
  leaves the run going (ADR-0020): its branches stay for the tasks still to
  land, each landed task whose tip HEAD now contains is marked merged, and a run
  that settles with all of its landed work merged that way is cleared up as
  above instead of handed over. A handoff names only landed work not yet merged.
  `blocked`, `conflict` and `failed` — part-way or not — delete nothing. Clean-up keeps the integration
  branch for a user who has not decided; discard deletes it. `discard` takes
  `integration: 'keep' | 'delete' | 'delete-merged'`; `delete-merged` is the
  only mode that decides per branch, and is how a replaced run that holds landed
  work is discarded.
- **Every run start sweeps.** Once a run is minted or continued, `sweep` deletes,
  in each repo of the group, every `ordewell/<run-id>/…` branch of another run
  that HEAD contains, after a `git worktree prune`. It never touches the current
  run, a branch checked out in any worktree, anything outside the
  `ordewell/<run-id>/<name>` shape, or any branch of a run that still has a
  worktree under `.ordewell/worktrees/<run-id>/` — a run with nothing landed has
  its integration branch at HEAD, and only its worktree says it may be live in
  another plan. A sweep that fails is a warning notice; the run starts
  regardless.
- **Crash recovery.** `pruneOrphans` runs when a session is adopted, in every
  repo: it drops worktrees of tasks that were `active` when the process died,
  directories and branches under the run that no record owns, and stale
  registrations. Kept, failed and conflicted worktrees are what the user may
  want, so they stay. `release(..., { keep: true })` exists so a task whose
  verification failed is moved off `active` and survives that sweep.
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
  than being taken at its word. A resolver lands only a task that is still
  conflicted: a retry in the meantime replaces the conflict with a new attempt,
  whose half-done worktree must not land through the resolver. Nothing adds the
  task but the explicit call; conflict repair (ADR-0015) is the automatic
  version, run as a new attempt of the task itself.
- **Discard does not rewrite the plan.** Discarding a run leaves completed tasks
  completed. Whether their work was kept (merged by hand, or with Merge all) is
  something only the user knows; Mark not done is how they say it was not.
- **A run closes however its last attempt ends.** Cancel, Mark complete or a
  failed spawn close a run the scheduler is not driving — a manual task run, or
  a halted plan's remaining attempts — as a verdict does; an idle `tick` closes
  it. Left open, the next run would inherit its mode. A run paused at a merge
  gate is not closed: it waits on the user, as one waiting on a user task does.
- **The planner is told.** `PlannerModes.isolatedExecution` (one-shot and
  mid-run edits) and `ConversationVariant.isolatedExecution` (the conversation)
  swap the overlap-avoidance rule for one that allows same-file parallelism and
  keeps dependencies for genuine ordering. The shared-workspace text is the
  original, word for word. A dirty tree counts as *not* isolating: the user may
  still choose to run without isolation, and the ordering rule is the safe one
  then.
- **Transcripts in a worktree.** Claude Code names its transcript directory
  after the cwd with every non-alphanumeric turned into `-`, keeping the first
  200 characters and appending a hash of the full path when it is longer — which
  a worktree path reaches sooner than a workspace root. The reader matches that
  rule and takes every directory with the kept prefix as a candidate; the
  completion marker decides.
- **A checkpoint needs a live attempt.** A conflicted task is `awaiting_user`
  like a checkpoint is. Approving or rejecting a checkpoint with no attempt
  behind it is ignored, so a conflicted task is never put back to `in_progress`
  with no runner.
- **Surfaces.** The daemon passes `isolation_blocked` and `isolation_handoff`
  through unchanged and has routes for the handoff steps (`/isolation/diff`,
  `merge`, `cleanup`, `discard`), the blocked run's two ways on
  (`stash-and-continue`, `run-without`) and `resolve-conflict`. The TUI marks a
  conflicted task in the plan pane and shows a branch and worktree only in a
  task's expanded detail; the handoff overlay (`/handoff`) opens on
  `isolation_handoff` when nothing else is open, and a blocked run asks with a
  three-way picker. The CLI has `ordewell handoff
  [review|merge|discard|cleanup]` and `ordewell run --stash` /
  `--without-isolation`. VS Code shows the same marks on its task cards, a
  handoff card, and a host modal for a blocked run; merge and discard are
  confirmed first everywhere. While tasks wait at a merge gate, each surface
  offers Merge all mid-run (ADR-0020). The stream reports isolation only as it changes,
  so a surface that was not listening is re-told from the record:
  `Session.isolationView` reads the marks and the handoff from the run record;
  VS Code replays it when its webview reconnects or a session is loaded (the
  card waits while a run executes), and the TUI and CLI read the same record
  from the saved plan.
- **Tests do not run git by accident.** `fakeConfig` has
  `worktreeIsolation: false`. An orchestrator built without an injected
  isolation falls back to git, and the suites run inside this repository; with
  the setting on, they would create worktrees in it.
- **Config.** `worktreeIsolation` (default on), an `ORDEWELL_WORKTREE_ISOLATION`
  environment override, an optional `worktreeSetupCommand`
  (`ORDEWELL_WORKTREE_SETUP`), and `workspaceRepos` and `worktreeLinks`
  (ADR-0014), following the `BaseConfig`/`EnvConfig` pattern. A repo with hooks
  or submodules that assume one worktree opts out with the setting rather than
  by not being a git repo.

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
- **Model-resolved merge conflicts, unbounded and unverified.** Rejected:
  resolving a conflict is deciding which of two changes wins, and handing that to
  a model silently rewrites a merge nobody reviewed, with the verdict depending
  on a model against the rule that verdicts come from evidence. What runs instead
  is ADR-0015's repair: bounded, on the task's own runner and model, and judged
  by evidence — the Verdict still decides, not the model's say-so.
- **Excluding links with a shared `info/exclude`.** Rejected in favor of
  recording the links per task: that file is shared by every worktree of the
  repository, so it would edit the user's repository configuration and leak the
  exclusion into their own checkout.
- **A new record for every run.** It was the first design. Rejected: it is wrong
  for a resumed plan, whose dependents would start from a tree without the work
  already landed.
- **`release(…, { keep: false })` after `merged`** — the obvious wiring.
  Rejected: it drops the record, and the task vanishes from the handoff it
  landed in.
- **Merge all ends the run.** It did, until ADR-0020. Rejected: a merge gate
  needs the user's merge while the run still has work to do, and ending the run
  there would stall parallel work no one asked to stop.
- **Decide isolation when a run starts.** It did, until ADR-0020. Rejected: an
  ops task needs no worktree, so a run of only ops tasks would be parked on a
  dirty tree for nothing.
- **A failed landing fails the task and halts the run.** It did, until
  2026-09-28. Rejected: a red X contradicts the completion marker, and halting
  stops every other task over one git problem the user has to fix anyway.
- **Cancel removes the worktree.** It did at first. Rejected: a runner is often
  cancelled because it looked stuck after finishing, and removal took the
  finished work with it.
- **Keep the integration branch until explicitly given up.** It was the first
  rule. Rejected: it left one behind for every run that landed anything, even
  after Merge all had put all of it on the user's branch.
- **Delete the integration branch whenever its run is forgotten.** Rejected:
  `cleanupRun` exists to keep that branch for a user who has not decided, and a
  branch that holds unmerged work is the one thing never given up unasked.
- **Link `node_modules` as one folder.** It was. Rejected: npm, yarn and pnpm
  install a workspace package as a link inside `node_modules`, and through a
  folder link that resolves from the main checkout — a task changing
  `packages/core` built and tested its dependents against the main checkout's
  `core` and its stale build.
- **Link each workspace package's folder into `node_modules` by name from
  `package.json`.** Rejected: the installed links already say which package goes
  where, for every package manager that writes them; reading them avoids a
  second, drifting model of the workspace. Links inside a real package (pnpm's
  `.pnpm` store) still resolve to the main checkout.

## Consequences

- Non-git workspaces, a missing git binary, `no-commits` and a disabled setting
  run every task in the workspace root, as before isolation existed.
- Integration serializes, so the throughput gain is bounded by the dependency
  graph the planner emits. Isolation makes overlap safe; it does not predict it.
- A linked `node_modules` package is shared, so concurrent installs from two
  worktrees race. The setup command is the escape hatch.
- Git hooks run on the per-task and merge commits as they would for the user. A
  hook that assumes a single worktree refuses the landing, and the task waits on
  the user with its work kept; the user can opt out with the setting.

## History

- 2026-09-25 — accepted; wired into the orchestrator, Session, planner prompt and
  surfaces; integration branches deleted once merged; extended to repo groups
  (ADR-0014).
- 2026-09-26 — `node_modules` mirrored entry by entry; conflict repair before a
  conflict reaches the user (ADR-0015).
- 2026-09-28 — a landing git refuses waits on the user instead of halting the
  run; cancel keeps the worktree.
- 2026-09-30 — nested repositories shared live instead of refused (ADR-0019).
- 2026-10-02 — commit subjects name the change, not the plan's task number or run
  id; only change tasks are isolated, isolation is decided at the first change
  task, and Merge all can run mid-run (ADR-0020).
- 2026-10-03 — a blocked run's execution stream stays open for the ops tasks still running; the choice's stream replaces it.
- 2026-10-09 — `.ordewell/skills/` committed and reaching worktrees through git (ADR-0024).
