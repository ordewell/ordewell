---
status: accepted
amends: ["0013", "0014"]
---

# 0020 — Ops tasks run in the workspace, behind a merge gate

*Pending:* [ADR-0055](../supervision/0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) — no ops task runs below the root, a child's gate means the delegated task's branch, and a sealed script check passes no gate.

**Amends:** ADR-0013 (worktree isolation) — what Merge all does to a run still
going, and when a run decides whether it isolates; ADR-0014 (multi-repo
workspaces) — which tasks are isolated, where it had rejected the task marker
this ADR adds.

## Problem

Not every step of a goal is a change to files. A real working session mixes
code with operations around it: redeploy on dev and watch the pipeline,
whitelist an IP on a cloud resource, provision a resource, push a tag, reword
the subjects of commits already on the branch. Today those either happen
outside Ordewell, or a plan runs them as ordinary tasks — and under isolation
every ordinary task gets a worktree. An operation in a worktree is wrong in
three ways:

- **It acts on code the user has not merged.** The worktree is cut from the
  integration tip, and nothing reaches the user's branch until the end-of-run
  Merge all. A "redeploy" there bumps and pushes from a branch the user never
  reviewed — or deploys the user's branch *without* the run's work, depending
  on what the runner does.
- **Its order is wrong.** "Redeploy after the changes" needs the changes merged
  first, and the only merge is after the whole run.
- **Some operations have no meaning there.** Rewording commits on the user's
  branch, or pushing it, can only be done in the user's checkout.

ADR-0014 considered this and rejected "an external effects task marker": a plan
field, a scheduling rule, and a decision the planner would have to get right,
with the risk left to the user. Running sessions with operations in them showed
the cost of that choice is not risk the user can accept but work the run cannot
do in the right place or order.

## Decision

**A task is either a change or an ops task. Files change in worktrees; the
world is changed from the workspace, and only after the user has merged what
that depends on.**

### Change and ops

- A **change task** edits repository files. It runs in a worktree and lands on
  the integration branch, as every task does today. It is the default.
- An **ops task** changes no repository files. It acts on systems outside the
  repo (a cloud CLI, a deployment, a pipeline) or on git refs and history of
  the user's branch (push, tag, reword commits). It runs at the workspace root
  and never gets a worktree. In the plan it is `ops: true`; absent means a
  change, so saved plans need no migration. An AI task can be ops; a user task
  (`type: 'user'`) never runs in a worktree anyway.
- A **script task** ([ADR-0035](../supervision/0035-effects-are-consented-and-recorded.md))
  is an ops task whose body is a literal script that Ordewell runs with no
  model. It is an ops task by its type, so it carries no `ops` mark, and
  everything this ADR says of where and when ops tasks run holds for it: the
  workspace root, the merge gate, the Merge-all exclusion and the tracked-file
  check. Only its evidence differs (see Running ops tasks).
- **Only top-level tasks.** A subtask runs with its parent.
- **The planner sets it** by one test — is the task's result a file change? —
  and splits a mixed request into a change and an ops task that depends on it
  ("bump the version and redeploy" is a change that bumps and commits, then an
  ops task that pushes and watches the pipeline). The user can flip it in the
  task editor until the task starts; from then it is fixed, like its transport.
- **A question is not a task.** "What's the frontend's URL?" is answered in the
  planner conversation. The planner's envelope (ADR-0008) is for reading: a
  plan acts through ops tasks, and the planner performs an exact effect itself
  only as a script task (ADR-0035).
- **An ops task runs in the session's mode**, like any task. No mode is
  chosen for it and none is rewritten (ADR-0001): a full-access session runs its
  ops tasks with full access.

### The merge gate

- **A task that does not run in a worktree — an ops task or a user task — and
  depends on change tasks, directly or through other tasks, waits until their
  work is merged into the user's branch.** "Merged" is the same ancestry check the integration branch's clean-up
  already uses: each landing records the integration tip it produced in each repo
  it changed, and the task's work is merged once the checked-out HEAD contains
  those tips. A merge made by hand with git counts as Merge all does, and is
  found the next time the scheduler looks. The gate requires that merge;
  the setting below can perform it automatically.
- A user task is gated for the same reason as an ops task: what the user tests
  or checks by hand is their checkout or their deployment, and before the merge
  neither holds the work the task depends on.
- **Merge all mid-run merges what has landed and keeps the run going.** Landing
  is a serial queue, so the integration branch is one line; the gate merges all
  of it, not only the gated task's dependencies. Running change tasks keep their
  worktrees, the integration branch stays, and later tasks land on it. The
  end-of-run Merge all merges the rest; what was merged at a gate is already in
  the user's history, and the handoff names only what is not. The run is cleared
  up only when it has settled and everything is merged — by a last Merge all, or
  already at its gates, which leaves nothing to hand over. The Session then
  broadcasts `run_closed`, after the `isolation_merge` that caused it, and every
  surface drops the run's marks and cards on that and on nothing else: a merge
  that leaves the run going keeps them. Merge all and landings
  take turns on one queue, so a merge never reads an integration branch
  mid-landing.
- When the merge goes through, the gated tasks start by themselves. When it does
  not — a conflict with the user's branch, a dirty overlap — Merge all is aborted
  as at the end of a run, the user's tree is left as it was, and the gated tasks
  wait on.
- **Force start passes a gate after one confirmation** that names the
  dependencies whose work is not merged yet. The choice is logged on the task;
  the gate stands for every other task. A force start that waits for
  dependencies still under way passes only the gate the user confirmed when
  they forced it: work that lands after it was forced stops it at the gate,
  which says so, and it starts on the Merge all that opens the gate, or on
  another force start, which asks again.
- **Merge at gates automatically is an opt-in global user setting**
  (merge automatically in `/settings`; [ADR-0029](../supervision/0029-the-supervisor.md),
  [ADR-0030](../supervision/0030-global-run-settings.md)), off by default, with
  or without a supervisor. A change applies at once to the session it is made
  in, and to other sessions from their next run. When a task waits on nothing
  but its gate — approved, off hold, its dependencies met — Ordewell runs
  Merge all itself through the same queue; a
  conflict or dirty overlap aborts with the tree untouched and the gate waits
  for the user, with a notice and an `onAutoMerge` observer event. A failed
  automatic merge waits for a Merge all that goes through — the user's, or an
  Act supervisor's `merge_all` — or the next run before automatic merging
  resumes. The timeline records
  "auto-merged for task N", attributed to Ordewell setting. A supervisor at Act
  may also call `merge_all`.
- The plan shows it: an ops task carries an `ops` mark, and a gated task "waits
  for Merge all". Status updates carry each task's gate and a `RunMergeView`
  whenever landed work is not merged into the user's branch yet. It names that
  work and whether a gate waits on it; `paused` means the run waits at a gate
  with nothing else running. Every surface offers Merge all for those landings,
  with a quiet unmerged task count. VS Code keeps its mid-run card for gates.
- **Without isolation there is no gate.** Every task already runs in the
  workspace, so a dependent sees its dependency's work as soon as it is done.

### Running ops tasks

- **Ops tasks run in parallel, as their dependencies allow.** Provisioning one
  resource and whitelisting an address on another do not touch each other. Two
  ops tasks whose git operations would collide (a push and a reword of the same
  branch) are ordered by the planner with a dependency — the plan is the source
  of truth, as for shared paths (ADR-0014).
- **Merge all and ops tasks never overlap.** Merge all does not start while an
  ops task runs, and an ops task does not start during a merge — the one
  collision the planner cannot order, because the merge is the user's.
- **An ops task that changed files waits on the user.** When it ends, the
  workspace's tracked files in every repo of the group are compared with a
  snapshot taken when it started; a new tracked change makes the task
  `awaiting_user` with a notice naming the files, and nothing is committed.
  Untracked and ignored output (logs, build artifacts) does not count, nor does
  history the task rewrites (a reword, a rebase): a tracked change is one not
  committed. The snapshot comes from `git stash create`, which records the
  working tree without touching it, the index or the stash. The check is the
  evidence the rule rests on — a runner cannot be stopped from writing, only
  caught. It never runs in a run that shares the workspace root, where every
  task's edits land in it and a change task's would trip it; a run that has not
  yet decided, having started only ops tasks, checks wherever its workspace
  could isolate.
- **Retry carries the attempt before.** An ops task's effects are outside
  Ordewell and cannot be rolled back, and a half-done one may have created what
  it was making. A retry's prompt carries what the previous attempt did and asks
  the runner to check what already exists before acting. That is read from the attempt's saved log, reloaded or not: a list of its last
  twenty tool calls and how each ended, then its last message and the error
  that stopped it.
- Its completion evidence is the attempt-bound `task_complete` call, as for any task (ADR-0013). A task that
  watches a pipeline runs until the pipeline ends. A script task has no runner
  to make that call, so its evidence is its exit status, handed to
  `VerdictEngine` (ADR-0035).

### Isolation is decided at the first change task

An ops task needs no isolation, so a run decides whether it isolates **when its
first change task starts**, not when it opens: an ops-only run never asks and is
never blocked by a dirty tree, and a run that begins with ops tasks asks at its
first change task, with the same stash or continue-without choice (ADR-0013).
Ops tasks already running carry on while it waits. Once decided, a run keeps
it.

## Considered options

- **Rejected: keep every task isolated (ADR-0014's position).** It is the
  context above: operations run on unmerged code, in the wrong order, or not at
  all.
- **Rejected: run ops tasks one at a time.** Most share nothing. The only
  overlap that needs code is with the user's merge; the rest is ordering the
  planner already does with dependencies.
- **Rejected: let an ops task edit files.** It would put unreviewed changes on
  the user's branch, the thing isolation exists to prevent. A version bump is a
  change task followed by an ops task.
- **Rejected: a warning when an ops task dirties the tree.** A completed task
  with unexplained edits under it is worse than one that waits to be looked at.
- **Rejected: gate on the task's own dependencies only.** The integration branch
  is linear; merging part of it means cherry-picking, which loses the
  attribution and ancestry the per-task merge commits keep.
- **Rejected: at a gate, wait for every running change task, then hand off and
  start a fresh run.** Simpler, but it stalls parallel work no one asked to stop.
- **Rejected: the terminal tail as the structured retry's context.** Mostly
  prose, it buries the actions that matter and does not survive a reload.
- **Rejected: preserving terminal output for retries.** New persisted state
  for a transport removed by ADR-0025; the task log already owns retry context.
- **Rejected: retry blocked for ops tasks.** Safer for the rare half-done
  effect, more friction for the common attempt that failed before doing
  anything.
- **Rejected: an "ops-only" mode default.** The mode is the session's choice;
  ADR-0001 forbids rewriting it at spawn.
- **Rejected names: operation, effect, action, command, chore.** "Operation"
  is used loosely throughout the docs and code; "effect" and "action" are the
  TUI's reducer vocabulary; "command" is slash and runner commands; "chore" is
  a maintenance commit in commit conventions. `kind` beside the existing
  `type: 'ai' | 'user'` would name two synonyms, so the field is a flag.

## Consequences

- A plan can carry a goal through to its deployment, in the right order, with
  the user's review at the one point that ships code.
- Merge all becomes something the user may press more than once per run. Its
  preflight and atomicity (ADR-0014) are unchanged; what changes is that it no
  longer ends a run that still has work to do.
- A run can pause at a gate with nothing running. Every surface must say so as
  plainly as it says a task waits on the user.
- Ops tasks act on real systems with the session's mode, and the planner decides
  which tasks are ops. A wrong decision either way is recoverable: a change
  marked ops is caught by the tree check, an ops task marked change runs in a
  worktree as today.
- The planner prompt gains the ops rule, the split of mixed requests, and the
  ordering of colliding git operations.
- A false alarm is possible: a user editing tracked files in their checkout
  while an ops task runs makes that task wait. It costs a look, not work.

## History

- 2026-10-02 — accepted, and implemented (#67).
- 2026-10-03 — retry context for structured ops tasks comes from the saved log, so it survives a reload.
- 2026-10-09 — aligned with [ADR-0025](../runners/0025-structured-only-runners.md).
- 2026-10-11 — Merge all offered for unmerged landings throughout a run (#85).
- 2026-10-11 — merge at gates automatically, and the supervisor's `merge_all` ([ADR-0029](../supervision/0029-the-supervisor.md)).
- 2026-10-11 — implemented the automatic gate setting and core merge_all action.
- 2026-10-11 — `merge_all` reaches the planner as a tool through the command seam, allowed only to a supervisor at Act ([ADR-0029](../supervision/0029-the-supervisor.md)).
- 2026-10-11 — wording: automatic merging resumes after any Merge all that goes through, an Act supervisor's `merge_all` included, as the code always did.
- 2026-10-12 — merge at gates automatically becomes a global user setting, live in the session it is changed in ([ADR-0030](../supervision/0030-global-run-settings.md)).
- 2026-10-12 — the automatic merge setting also merges at the end of a run, by the same route as a gate merge ([ADR-0029](../supervision/0029-the-supervisor.md), "Merge at gates automatically").
- 2026-10-16 — the gate covers the task's whole dependency closure, not just its direct dependencies: a dependency on a verification task implies the work it verified, and a verification lands nothing of its own, so a direct-only gate let an ops task act on the user's checkout before that work was merged. A skipped task adds nothing of its own, but the work behind it still counts.
- 2026-10-18 — a merge that leaves the run going no longer clears a surface's isolation marks: the Session announces the run's closing as `run_closed` ([ADR-0013](0013-worktree-isolation.md)).
- 2026-10-18 — a force start queued behind its dependencies passes only the gate the user confirmed when forcing it, and an automatic merge at a gate is made only for a task nothing else holds back: one the user has not approved no longer triggers it ([ADR-0034](../supervision/0034-a-failed-task-blocks-only-its-dependents.md)'s one start rule).
- 2026-10-21 — a script task is an ops task Ordewell runs from a literal script with no model, whose evidence is its exit status, and the planner may add and start one; the planner no longer "never carries out an effect itself" ([ADR-0035](../supervision/0035-effects-are-consented-and-recorded.md)).
- 2026-10-22: merge automatically is set in `/settings`; `ordewell automerge` stays headless.
