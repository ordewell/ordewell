---
status: accepted
---

# 0013 — Worktree isolation: one checkout per task, one branch per run

## Problem

Every AI task ran in the same working directory — the workspace root. With
`maxParallelSessions` above one, several Runners edited that one tree at once.
The planner was told to keep parallel tasks on different files, but that is
advice to a model, not a boundary: it costs parallelism when two useful tasks
touch one file and get serialized by an invented dependency, and it fails
silently when they overlap anyway. Runner B rewrites the file Runner A just
changed, A's attempt-bound completion call still appears, and A verifies `pass` against a
tree that no longer holds A's work. There is no per-task record of what changed,
no way to undo one task, and — because Runners write straight into the user's
tree — nothing stops a run trampling uncommitted work.

## Decision

**When the workspace forms a repo group — a git repository, or a folder of them
(ADR-0014) — each change task runs in its own worktree, and the results are
integrated deterministically on a per-run branch.** A change task is every AI
task that is neither an ops task nor read-only; an ops task runs at the
workspace root, behind a merge gate (ADR-0020), and a read-only task runs in a
worktree of its own that lands nothing
([ADR-0046](../planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md)).
A `WorktreeIsolation`
module in core owns every git and filesystem operation for this. The
orchestrator gets a `cwd` from `prepare`, spawns the Runner there, and after the
evidence-based Verdict lands the work. A single repository is a group of one;
everything below applies per repo of the group.

### Key properties

- **One seam, and it is not the runner's.** A Runner is handed a `cwd` and
  nothing more (ADR-0025 D1). Git never enters `IRunner`, `RunnerRegistry`
  or a runner adapter, so Claude Code, Codex and OpenCode cannot produce three
  different git behaviors. The module is injected into the orchestrator the way
  `IRunner` and `PlanStore` are.
- **Isolation is run-scoped.** An `IsolationRun` is minted when a run's first
  change task starts:
  an id, per repo the base ref resolved to a commit *then* and the integration
  branch name, and per-task branch/worktree/status. It is plain JSON so it can
  be persisted with the plan state. Because task ids are only unique within one
  plan and one daemon serves many (ADR-0025 D2), operations that act on a task
  take the run — `release(run, taskId, …)`, not a bare id.
- **A run continues the plan's record while anything has landed on it.** After a
  failure, the next Execute preserves completed tasks, and a fresh integration
  branch cut from the checked-out commit would hand their dependents a tree
  without the work they depend on. So a run continues the plan's `IsolationRun`
  (same integration branches, same base refs) while it has a `merged` task, or
  once it has reverted one
  ([ADR-0054](0054-a-landed-task-reverts-on-the-integration-branch-before-merge-all.md)):
  its branch then holds commits no record names, and a retry starts from its
  tip. A record with nothing landed holds only superseded attempts and is
  discarded whole before a new one is minted. `discardRun` is how a user starts
  over.
- **Naming and location.** A task's worktrees are made by `prepare` when the task
  starts, not when the run opens. They live together in one *task
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
  (`readiness.landed` checks the record too, for completions that did not come
  from a verdict). Keeping the attempt live also keeps the identity rule: a
  cancel, retry or stop during the merge wins, and waits for the merge before
  it tears the worktree down. Mark complete is a passed verdict the user
  vouches for, so it integrates too — the way out of a stuck task whose work is
  sitting in its worktree, and of a conflict resolved by hand.
- **Integration is a serialized queue.** Verdicts can land concurrently. The
  module merges one task at a time with `git merge --no-ff` — a merge commit per
  task preserves any commits a Runner made itself, makes attribution visible, and
  makes the task branch an ancestor so it is safe to delete. A landing is atomic
  across the repos a task changed (ADR-0014). Messages name the change, not the
  plan, and are written by one function (`landingMessage`): from the commit the
  task's `done` handoff stated
  ([ADR-0047](../supervision/0047-structured-task-handoffs.md)), kept on the
  task's run record, so a conflict repair (whose own handoff states none) and
  every later landing reuse it. The sweep-up commit (for work a Runner left
  uncommitted) is that subject and body; the merge commit is `Merge: <subject>`
  with the same body, the same in every repo the task changed. Without a stated
  commit, the task title's first line stands in for the subject. A conflict
  repair is told to merge the integration tip in with
  `Merge: <subject> (resolve conflicts with integration)`. A continued task's
  kept work comes back into its branch with
  `Merge: <subject> (resume its kept work)`, and the rescue commit that kept
  it is `WIP: <subject>` with a line on why; both land with the task. Merge
  all's merge into the user's branch is `Merge: <subject>` of the one task it
  brings there, or of the first in plan order with `and N more` and a line
  per task. So git's default `Merge branch 'ordewell/…'` or
  `Merge commit '<sha>' into ordewell/…` never reaches history. A multi-line message goes
  to git as one `-m` per paragraph, never through a shell, and lands as written
  whatever the user's `commit.cleanup` (whose `strip` would drop a `#42 …`
  subject); a commit the Runner made itself is never rewritten. Each message Ordewell writes ends with the
  git trailer `Planned-with: Ordewell` unless the user turned that off with
  `ordewell trailer` or in `settings.json` ([ADR-0030](../supervision/0030-global-run-settings.md)); the
  setting is read as the message is written, so a change reaches the next
  landing. The plan's task `order`, the run id and
  Ordewell's branch names are internal and never enter a message that can
  reach the user's branch. Among tasks already waiting, the lowest plan `order` merges
  first. It never waits for a task that has not finished: a dependent cannot run
  until its predecessor integrates, so blocking on a lower-order task that is
  waiting on the queue would deadlock. Ordering is therefore deterministic for
  what is ready, not a promise about what is not. The `Landing` module
  (`services/Landing.ts`) lands a passed attempt and answers `landed`,
  `nothing-to-land`, `repair-needed` or `awaiting_user` (`conflict`,
  `landing-failed`, `repair-failed`); it never marks a task, starts an attempt
  or emits — the orchestrator applies what it answers.
- **A landing that does not go through waits on the user and never fails the
  task.** A conflicting merge is aborted with the worktree and both refs kept; it
  first gets a bounded, evidenced conflict repair on the task's own attempt
  (ADR-0015), and only a conflict repair does not clear is left `awaiting_user`,
  dependents waiting. A landing git refuses (a hook, for instance) leaves the task
  `awaiting_user` with its verdict `pass`, its worktree and branch kept (the
  record is `failed`, which surfaces show as `kept`) and the error naming what
  git stopped on; Mark complete lands it once the cause is fixed. Other ready
  tasks go on starting either way; only a failed *verdict* fails a task, and
  that blocks only its dependents
  ([ADR-0034](../supervision/0034-a-failed-task-blocks-only-its-dependents.md)). The work is
  finished, its completion call the evidence, and it sits intact in its
  worktree.
- **What happens to a worktree.** `merged` removes the task's worktree and branch
  and keeps its record, which is what the handoff's `landed` list is read from.
  A failed verdict, a stop and a cancel keep the worktree (`keep: true`) — a
  runner is often cancelled because it looked stuck after finishing, and the
  finished work must survive. Retry, removal from the plan and a failed spawn
  remove it. A fresh attempt's `prepare` replaces a kept worktree from the
  current integration tip. A continue restores the previous attempt's work
  on top of that tip, with a conflict fallback naming its preserved branches
  ([ADR-0018, K1](../runners/0018-structured-runner-transport.md)), so the saved runner
  session sees the edits it remembers. A carry-over to another runner after a
  usage limit restores it the same way (ADR-0018, U1). A read-only task's
  worktree is the exception (ADR-0046): it is never integrated, and every
  release removes it whole, kept or not, with nothing preserved on a branch
  and no git run inside it.
- **A landing can be taken back until it is merged.** One merge per task is what
  makes a landing undoable on its own. Until the user's branch holds it, the user
  can revert a task on the integration branches: a revert commit, never a
  rewrite, with its landed dependents, in every repo or none, on the landing
  queue, leaving the task pending and held. Work already in their branch is
  refused with the exact `git revert` to run (ADR-0054).
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
  git, as its own checked-out copy ([ADR-0024](../planner/0024-unified-skills.md)). A
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
  so the install stays shared. Tools' own caches at its top level (`.cache`,
  `.vite`, `.vite-temp`, `.vitest`) are not linked, so each tool makes its own
  in the worktree: Vite and Vitest take `node_modules/.vite` under the nearest
  `package.json` and read no environment to say otherwise, a link would have a
  task writing the main checkout's cache, and a sealed run cannot (ADR-0046). A
  link is recreated: a relative one keeps its
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
- **A start over what no record holds.** `prepare` prunes git's stale
  registrations, then keeps and removes whatever the task's own path and branch
  still hold when no live record does — a crashed attempt's, or one whose record
  was lost — by the rules a retry follows, and refuses when that work cannot be
  kept. A path or branch another record of the run holds is never touched.
- **Windows needs no privilege (ADR-0010).** Directories become junctions and
  files hard links, copied only when a hard link is impossible (a different
  volume), with a notice. Copies are what make the recorded link list matter
  there, since a copied `.envrc` is a plain untracked file.
- **Merge into the user's branch requires consent.** Ordewell merges into the
  branch the run started on, and only while it is checked out
  ([ADR-0042](0042-merge-all-lands-only-on-the-branch-the-run-started-on.md)),
  when the user presses Merge all, or has opted into one of two settings:
  *merge automatically* (in `/settings`; `ordewell automerge` headless), and the
  supervisor at Act (also in `/settings`; `ordewell supervisor act` headless),
  which may call `merge_all` in its wake-up turns
  ([ADR-0029](../supervision/0029-the-supervisor.md)). Both are global user
  settings, opted into once rather than per plan, and a change applies at once to
  the session it is made in ([ADR-0030](../supervision/0030-global-run-settings.md)).
  Without either, Ordewell never merges on its own.

  When an isolated run settles, `handoff` runs and `isolation_handoff`
  (integration branches, base refs, what landed) is broadcast *before*
  `execution_complete` — the TUI closes its execution stream on the latter, so
  anything after it is lost. What follows is the user's: review the diff against
  the base refs (one section per repo), *Merge all* (preflighted in every repo,
  merging all or none, ADR-0014; a normal `git merge`, aborted on conflict so
  the user's tree is left as it was), clean up, or discard. Two cases hand the
  merge to Ordewell instead. With *merge automatically* on, a task that reaches
  a merge gate runs Merge all, and so does the end of a run that settles with
  landed work not yet merged; the handoff is sent only if that merge stops. With
  the supervisor at Act, the handoff is sent marked as deferred to the
  supervisor, who may merge it. Every automatic merge goes through the same
  queue and preflight as the user's: a conflict or a dirty overlap aborts with
  the user's tree untouched, and the gate, or the handoff, waits for the user.
  Merge all is available whenever a run has unmerged landings, including to open
  a merge gate during a run (ADR-0020); it takes turns with the landing queue,
  so it never reads an integration branch mid-landing. Preparing a task
  workspace takes its turn too: a group's integration tips are consistent only
  between landings, and a branch cut from one a landing had merged into some
  repos but not yet the others would keep that merge after its rollback.
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
  above instead of handed over. So is a settled run whose session is loaded
  after the user merged it: the saved record cannot know what was merged since,
  so adopting a run asks git again, and a run still holding kept or conflicted
  work stays. A handoff names only landed work not yet merged; a repo whose
  integration branch is gone has nothing Merge all could merge, so its landed
  work counts as merged there, while a repo git cannot read at all counts as not
  merged. A surface's handoff shrinks with each status update, which says what
  landed work is still unmerged.
  `blocked`, `conflict` and `failed` — part-way or not — delete nothing. Clean-up keeps the integration
  branch for a user who has not decided; discard deletes it. `discard` takes
  `integration: 'keep' | 'delete' | 'delete-merged'`; `delete-merged` is the
  only mode that decides per branch, and is how a replaced run is discarded,
  whatever its records say: a retry drops a landed task's record, and the branch
  alone still knows what landed.
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
  verification failed is moved off `active` and survives that sweep. Only the
  host holding the session's lease adopts it, continues its run or changes it
  in any way ([ADR-0049](0049-a-session-has-one-live-host.md)): a second host
  continuing the same run id names the same worktrees, and its prune and
  `prepare` would remove a live host's.
- **Persistence.** `LegacyPlanState.isolation` holds `{ run, resolvers }`,
  written from the orchestrator at persist time like `tasks`, and saved on every
  change to it rather than at the end of the run — the record is what lets a
  crashed process's worktrees be found again. Adopting a saved plan is not
  itself saved: the prune is never written, and what git shows merged since is
  saved only where the load may save — VS Code's restore adopts with
  `persist: false`, and without the session's id a write there would fork a new
  session file on every reload, so it keeps the change for its next save. A fork of a
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
  failed spawn close a manual task run, which the scheduler is not driving, as
  a verdict does; an idle `tick` closes it. Left open, the next run would
  inherit its mode. A run paused at a merge gate is not closed: it waits on the
  user, as one waiting on a user task does. Nor is a run held on a usage limit:
  the reset continues it
  ([ADR-0034](../supervision/0034-a-failed-task-blocks-only-its-dependents.md)).
- **The planner is told.** `PlannerModes.isolatedExecution` (one-shot and
  mid-run edits) and `ConversationVariant.isolatedExecution` (the conversation)
  swap the overlap-avoidance rule for one that allows same-file parallelism and
  keeps dependencies for genuine ordering. The shared-workspace text is the
  original, word for word. A dirty tree counts as *not* isolating: the user may
  still choose to run without isolation, and the ordering rule is the safe one
  then. The planner and its research subagents never execute in a worktree: they
  start at the workspace root, and read-only planning keeps its existing envelope
  ([ADR-0008](../planner-envelope/0008-planner-exploration-envelope.md)).
- **Output belongs to the attempt.** The completion call supplies the durable
  summary; the captured plain-output tail is the fallback for summary text.
  No transcript-directory search determines completion or binds an output to
  a worktree (ADR-0025).
- **A checkpoint needs a live attempt.** A conflicted task is `awaiting_user`
  like a checkpoint is. Approving or rejecting a checkpoint with no attempt
  behind it is ignored, so a conflicted task is never put back to `in_progress`
  with no runner.
- **Surfaces.** The daemon passes `isolation_blocked` and `isolation_handoff`
  through unchanged and has routes for the handoff steps (`/isolation/diff`,
  `merge`, `cleanup`, `discard`), the blocked run's two ways on
  (`stash-and-continue`, `run-without`), `resolve-conflict` and
  `revert-preview`. The TUI marks a
  conflicted task in the plan pane and shows a branch and worktree only in a
  task's expanded detail; the handoff overlay (`/handoff`) opens on
  `isolation_handoff` when nothing else is open, and a blocked run asks with a
  three-way picker. The CLI has `ordewell handoff
  [review|merge|discard|cleanup]` and `ordewell run --stash` /
  `--without-isolation`. VS Code shows the same marks on its task cards, a
  handoff card, and a host modal for a blocked run; merge and discard are
  confirmed first everywhere. Each surface offers Merge all mid-run whenever
  landed work is unmerged, with a quiet count; a gated task still waits for
  Merge all (ADR-0020). The stream reports isolation only as it changes,
  so a surface that was not listening is re-told by `Session.runSnapshot()`,
  which carries the marks and the handoff: the socket greets with it, and the
  session routes' load and read answers carry it, so no surface rebuilds them
  from the saved record (`Session.isolationView` still reads the record, for
  the handoff a VS Code merge confirmation names, and the CLI's `status` and
  `handoff` read the saved plan). Whether a merge or a discard ended the run is
  the Session's word, `run_closed`, which `reduceRun` folds into dropping the
  marks, the handoff and the merge view; no surface infers it from a merge
  result.
- **Config.** `worktreeIsolation` (default on), an `ORDEWELL_WORKTREE_ISOLATION`
  environment override, an optional `worktreeSetupCommand`
  (`ORDEWELL_WORKTREE_SETUP`), and `workspaceRepos`
  (`ORDEWELL_WORKSPACE_REPOS`) and `worktreeLinks` (`ORDEWELL_WORKTREE_LINKS`)
  (ADR-0014), following the `BaseConfig`/`EnvConfig` pattern. A repo with hooks
  or submodules that assume one worktree opts out with the setting rather than
  by not being a git repo.

## Testing decisions

A good test here observes externally visible behaviour: git state at the
porcelain level (worktrees listed, branch contents, whether a merge is reported
as conflicted, whether artifacts and cleanup exist), the `cwd` a Runner was
spawned with, and the task statuses the orchestrator settles on — never the
literal git command lines or private fields.

- **`GitWorktreeIsolation` runs against real temporary repositories**
  (`GitWorktreeIsolation.test.ts`), built the way `sessionStore.test.ts` and
  `workspace.test.ts` build real temp directories. It covers activation and its
  reasons, detection, dirty trees, the task workspace, the bootstrap, atomic
  landing (with a crash mid-landing, and git older than 2.38), the handoff,
  `pruneOrphans`, `sweep` and merged branches. Assertions read `git worktree
  list`, branch tips and file contents, not strings. These are the real-git
  files `npm run test:quick` skips.
- **`TaskOrchestrator` runs against a fake isolation collaborator**
  (`FakeWorktreeIsolation`, in `TaskOrchestrator.isolation.test.ts`), the way
  its existing suite fakes `IRunner`, with `fakeConfig` and the shared test kit
  (`packages/core/src/testing.ts`). It asserts the seam, not git: what `cwd` a
  Runner is spawned with, when a dependent may start, in what order work
  integrates, and what a conflict, a cancel, a retry and a workspace without git
  do to a task.
- **Tests do not run git by accident.** `fakeConfig` has
  `worktreeIsolation: false`. An orchestrator built without an injected
  isolation falls back to git, and the suites run inside this repository; with
  the setting on, they would create worktrees in it.
- **Config and the planner prompt** are covered beside the existing config and
  prompt tests: the `worktreeIsolation` default and its environment override,
  and the overlap rule present or absent depending on whether isolation is
  active.

## Out of scope

- Isolation for non-git version control (Mercurial, SVN). The fallback is
  shared-root execution; only git worktrees are in scope.
- Overlap-aware scheduling from a declared per-task file scope. The concurrency
  policy trusts the dependency graph; conflicts are handled, not predicted.
  File-scope-gated scheduling is the obvious follow-up if conflicts prove
  frequent.
- Pushing, pull requests, or any remote operation.
- OS-level sandboxing of runners. A runner is scoped by its mode
  ([ADR-0001](../routing/0001-autonomous-mode-resolution.md));
  [ADR-0011](../planner-envelope/0011-sandboxing-the-planners-shell.md)
  sandboxes the planner's shell only.
- Redefining how Runners themselves use git; they continue to receive a `cwd`.

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
- **Auto-merging the result into the user's branch by default.** Rejected: it is
  the one irreversible step, and it would land work in a tree that may hold
  uncommitted changes. Ordewell produces one reviewable branch and the user
  chooses to review, merge or discard. A user who wants the merge made for them
  opts in once, as above.
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
  2026-09-28. Rejected: a red X contradicts the attempt-bound completion call, and halting
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
- Open: a Codex task's `workspace-write` sandbox is rooted at its worktree, and a
  linked worktree keeps its git directory in the main repository, outside that
  root, so a git command the task runs that writes there may be refused.
  Ordewell's own per-task commit and landing run in core, not in the runner, so
  integration does not depend on it. Not checked against a real Codex.

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
- 2026-10-09 — aligned with [ADR-0025](../runners/0025-structured-only-runners.md).
- 2026-10-11 — Merge all exposed throughout a run for unmerged landings (#85).
- 2026-10-11 — merge at gates automatically, and the supervisor's `merge_all` at Act, as opt-in exits from "never merged for the user" ([ADR-0029](../supervision/0029-the-supervisor.md)).
- 2026-10-11 — implemented the automatic gate setting and core merge_all action.
- 2026-10-11 — `merge_all` reaches the planner as a tool through the command seam, allowed only to a supervisor at Act ([ADR-0029](../supervision/0029-the-supervisor.md)).
- 2026-10-11 — a continue restores the previous attempt's preserved work (ADR-0018, K1).
- 2026-10-12 — the merge consents become global user settings ([ADR-0030](../supervision/0030-global-run-settings.md)).
- 2026-10-12 — the end of a run is a handoff unless the user opted in to automatic merging, which now also merges at the end of a run, or the supervisor at Act merges ([ADR-0029](../supervision/0029-the-supervisor.md), "Merge at gates automatically").
- 2026-10-14 — a failed verdict blocks only the task's dependents instead of halting the run ([ADR-0034](../supervision/0034-a-failed-task-blocks-only-its-dependents.md)).
- 2026-10-14 — a carry-over restores a usage-limit-paused attempt's work for its new runner (ADR-0018, U1).
- 2026-10-17 — the pre-implementation spec this ADR was built from is retired: its testing decisions and out-of-scope list moved here, and the merge paragraph states the global settings and the end-of-run merge that only History held.
- 2026-10-17 — Merge all merges only into the branch the run started on (ADR-0042).
- 2026-10-18 — the Session says when it closed the run (`run_closed`), and a surface re-told by a load or refresh takes `runSnapshot()` instead of reading the run record.
- 2026-10-18 — a run held on a usage limit is no longer closed when its last attempt ends; it stays open for the reset (ADR-0034).
- 2026-10-19 — adopting a saved run asks git what the user merged since and clears up a settled run left with nothing to hand over; a gone integration branch counts as merged.
- 2026-10-21 — a read-only task's worktree lands nothing and is never kept, and removing a worktree follows no link a task put on the way (ADR-0046).
- 2026-10-22: merge automatically and supervisor Act are set in `/settings`; the one-value slash commands are gone from the TUI and VS Code.
- 2026-10-23 — landing commits and merges are written from the commit the task's handoff stated, falling back to its title; a conflict repair's merge names the task, not Ordewell's branches.
- 2026-10-23 — the commits and merges Ordewell writes end with a `Planned-with: Ordewell` trailer, which the user can turn off (ADR-0030).
- 2026-10-23 — Merge all's merge, a continue's merge of kept work and the rescue commit are named for the tasks and carry the trailer, like the landing.
- 2026-10-23 — the messages Ordewell writes land as written, whatever the user's `commit.cleanup`.
- 2026-10-24 — preparing a task workspace takes its turn, and a replaced run's integration branch is deleted only where HEAD contains it, never on the word of its records.
- 2026-10-24 — only the host holding the session's lease adopts, continues or changes its run (ADR-0049).
- 2026-10-24 — preparing a task prunes stale worktree registrations and clears an unrecorded leftover at the task's path or branch, keeping its work first.
- 2026-10-30 — one task's landing can be reverted on the integration branch before Merge all, and a run that reverted one continues (ADR-0054).
- 2026-10-31 — tools' caches in `node_modules` are left out of the mirror, so a task keeps its own and a sealed run can run vitest.
