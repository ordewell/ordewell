---
status: accepted
implemented: none
amends: ["0009", "0013", "0015", "0018", "0020", "0022", "0029", "0030", "0035", "0045", "0046", "0049"]
note: "Settles #33. Decided ahead of its code: what a node may do is ADR-0056, how it reports is ADR-0057."
---

# 0055 — A delegated task is a child plan behind the runner seam

## Problem

A plan is one list under one planner. A goal with a separable subdomain, a
service, a package, a research question, puts all of that subdomain's detail in
the one planner's context, and the one conversation decides everything. Research
tasks ([ADR-0037](0037-research-tasks-wake-the-planner.md)) are delegation one
level deep: a task whose report returns to the node that started it. #33 asks for
the rest: a task whose body is a plan with its own planner.

The owner's starting position was recursion to any depth, more autonomy the
deeper a node sits, a user who deals only with the root, and tens of thousands of
sessions. The research kept the shape and bounded it. This ADR decides what
recurses, where a child runs and how a parent knows it finished. What a node may
do without a person is [ADR-0056](0056-a-mandate-narrows-down-the-tree.md), how information crosses
levels is [ADR-0057](0057-information-moves-by-reference.md), the scale this
aims at is [ADR-0058](0058-a-tree-holds-many-nodes-and-few-live-sessions.md), and
where a session runs is
[ADR-0059](../isolation/0059-an-execution-lease-reserves-in-the-claim-and-opens-after-it.md).

The code assumes a flat run in specific places (measured on 2026-10-31 at
3a9cecd0):

- `Session.workspace` is both the code root and the state root, so a child rooted
  in a task worktree would keep its session file, logs and lease in a directory
  that goes with the worktree.
- A run's worktrees live under `run.workspaceRoot`. A probe with the real
  `GitWorktreeIsolation` showed a parent's `pruneOrphans` silently deleting a live
  child's worktree and its uncommitted work, and a child's `.ordewell/.gitignore`
  swept into a landing, which then failed the root's Merge all.
- The Parallel limit counts one Session's attempts and no planner, so a tree of
  *n* Sessions would run *n* times the limit.
- `mergeLanded` merges into whatever is checked out, past the command seam.
- Every question has one destination, the user.

## Decision

**A delegated task holds a goal, not a runner prompt. Its attempt is a child
Session in the same process, reached through a `ChildPlanRunner` beside the
script runner, so to its parent a subplanner is a runner. It passes only on
evidence: its child run has settled, its work is merged into the delegated
task's branch, and the subplanner called `task_complete` on its token. A check
the child cannot reach follows it in the parent's plan.**

## Key properties

### The recursive unit

- **The task is the unit (D1).** `TaskType` gains `'delegated'`. It holds:

  | field | what it is |
  |---|---|
  | `goal` | what the child plan must achieve, in place of `prompt` |
  | `assignedRunner`, `assignedModel` | the subplanner's, resolved as any task's are ([ADR-0003](../routing/0003-per-runner-model-allowlist.md), [ADR-0041](../routing/0041-a-tasks-model-follows-the-runners-own-switch.md)) |
  | `budget` | required: tokens, and optionally wall-clock time (ADR-0056 M5) |
  | `grants`, `protectedPaths`, `scope` | optional: the grants it asks for past the floor (ADR-0056 M2, M4), paths the child may not change (D7), a declared scope (ADR-0057 R6) |
  | `readOnly` | optional: it answers a question and lands nothing ([ADR-0046](../planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md)), so D6 asks for no change and D8 for a read-only check |

  It has no subtasks and is never one: it is top-level, as a script task is, and
  `checkPlanInvariants` holds it to that as it holds a script task. `subtasks`
  stays apart. No saved plan uses that field (0 of 760 tasks), and a
  child plan's tasks are never stored there: they are the child Session's own.
  `walkPlan`, `subtreeIds` and the dotted row renderer are reused as a read-only
  view of them. Only a planner writes a delegated task; surfaces draw it
  read-only, and the user consents to it as they do to any task
  ([ADR-0035](0035-effects-are-consented-and-recorded.md)). It is neither a loop's
  check nor its body: `loopErrors` refuses it as either, as it refuses a user task,
  since a round runs a task again whole, and here that is a new child each round on
  what is left of the budget.
  [ADR-0045](0045-a-check-repeats-with-its-fix-until-it-passes.md) leaves a
  delegated body out of scope.
- **What a child plan may hold (D2).** Change tasks, read-only tasks, research tasks
  while it holds `research`, script tasks (ADR-0056 M9), loops, and delegated tasks
  while its depth allows (D19) and it holds `delegate` (ADR-0056 M2). `ops` and user
  tasks are refused in it at plan time: an ops task acts on the user's systems from
  their checkout, and a user task waits on a person, and neither exists below the
  root.

### Hosting

- **A nested Session behind `IRunner` (D3).** A delegated task's attempt is an
  ordinary attempt: the claim, its log, its verdict and its landing are
  `Attempts`' as for any task. `ChildPlanRunner` spawns a `ChildPlanSession`, an
  `AbstractRunnerSession` as `ScriptSession` is, that holds one Session built by
  `createSession` with narrowed deps, rooted in the delegated task's worktree:

  | the parent's | `IRunnerSession` | in the child |
  |---|---|---|
  | Stop | `stop()` | the subtree's stop (D16) |
  | message | `sendMessage` | `PlanTurns.enqueue` from `parent`, taken by its next turn |
  | question | `checkpoint` on the subplanner's token | the task `awaiting_user`, reason `checkpoint` |
  | report | `task_complete` on the subplanner's token | the handoff, weighed by `VerdictEngine` |
  | restart | `nativeSessionId()`, saved as `runnerSessionId`, and Continue | the child session reopened (D17) |

  The attempt has one turn, from its start to its verdict: `onTurnEnd` fires when
  the child ends, so [ADR-0018](../runners/0018-structured-runner-transport.md)'s
  waiting for input and completion reminder are not read off the child's planner
  turns. A separate process later is a second `IRunner`, not a redesign.
- **One kind of node (D4).** A subplanner is a Session with a planner role and
  grants. It ends with the same `task_complete` a runner uses and asks with the
  same `checkpoint`. There is no `plan_complete` and no `ask_parent`. Delegating
  is a task type in `submit_plan` and `edit_plan`, not a tool. It writes no
  repository files (ADR-0035): a planner never implements, and a worker never
  plans.
- **A subplanner is a harness planner (D5).** The plan gives it a runner, and an
  API planner is not one and has no Ordewell token
  ([ADR-0022](../runners/0022-ordewell-mcp-server.md) S1). An API planner at the
  root may delegate; it cannot be delegated to. Its token is a planner token that
  also serves `task_complete` and `checkpoint`, bound to the delegated task's
  attempt generation: planner tools are handled by the child Session, those two
  by the parent's attempt. It is reissued with each process, as a planner token
  is, and revoked with the attempt, as a task token is. It starts at the delegated
  task's worktree, the one planner that does: it has to read the branch its child
  plan lands on. Its envelope stays the planner's, with ADR-0056 M8's rule that
  nothing asks.

### The verdict

- **A verdict is evidence (D6).** `VerdictEngine` stays the only producer. A
  delegated task passes only when all of these hold at the `done` call:
  1. the child run has settled: no attempt live, no planner turn live but the one
     making the call, nothing that can start, every task `completed` or `skipped`,
     none failed, blocked or waiting;
  2. the child did work, and what landed is merged into the delegated task's branch
     (D10): at least one of its tasks `completed`, and that branch changed since its
     base unless the delegated task is `readOnly`;
  3. the changes on that branch since its base touch no protected path;
  4. the call came on the attempt's token.

  A `done` that fails 1 or 2 is refused at the call by code, naming what is
  unfinished, and the attempt stays open, as a handoff outside its limits is
  ([ADR-0047](0047-structured-task-handoffs.md)): a subplanner saying done is
  necessary and never sufficient. One that fails 3 fails the verdict, with the
  paths named, and nothing lands. `blocked` and `failed` are taken at any time:
  that is how a subtree gives up, and how a child that found nothing to change says
  so, for its parent to decide. `readOnly` is on the parent's plan, which the child
  cannot edit, so a child cannot excuse itself from 2. A subplanner may skip a task
  under its grants, as a supervisor does, so skipped work can end a child, though
  never all of it; the skips are counted in its report (ADR-0057 R2), and the check
  is what judges the result. A turn that ends with the run settled and no call gets
  the one completion reminder; a second fails the attempt with a derived report,
  since no person is there to wait for (ADR-0056 M8).
- **Protected paths are checked at the verdict, not in the landing (D7).** A
  delegated task may declare paths (tests, CI, scoring) its child may not change.
  A landing never fails a task
  ([ADR-0013](../isolation/0013-worktree-isolation.md)), so the check sits in the
  last step before one, on the same diff. A repair lands after that step, and is
  held to the same paths there (D14). Paths accumulate down the tree
  (ADR-0056 M4): a nested delegated task is held to its ancestors' too.
- **A check is a task (D8).** `delegationErrors`, in `checkPlanInvariants`, refuses
  on every route a delegated task with no script or read-only task directly
  depending on it, as `loopErrors` holds a loop. What follows from the existing
  rules:
  - The check runs once the delegated task has landed on the parent's integration
    branch, so a dependent sees its work. It cannot hold that landing back.
  - **A `readOnly` delegated task's check reads its handoff.** It never lands, and
    its worktree and branch go when it passes (ADR-0046), so the tip a dependent is
    cut from holds none of its work, and a script there would pass or fail on the
    unchanged baseline. Its handoff is all it leaves. So `delegationErrors` counts
    only a read-only task as its check, which reads that handoff with `read_task`.
  - **A script check runs sealed.** A script task runs at the workspace root
    behind a merge gate (ADR-0020, ADR-0035), so at the root it would wait for
    Merge all and check the work after it reached the user's branch. A script
    task marked `readOnly` runs instead as a read-only task's shell does
    ([ADR-0046](../planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md)):
    sealed ([ADR-0036](../planner-envelope/0036-the-planners-shell-sealed-runs-and-native-opt-in.md)),
    in a throwaway worktree cut from the integration tip, landing nothing, past no
    gate, its exit status its evidence, and consent to its body as ADR-0035 says. A
    delegated task's script check must be one. Where no sandbox can seal (ADR-0036
    S6) it cannot run, and the check must be a read-only task. So a script check is
    refused there on every route, saying why, on `canSeal` read through
    `PlanChangeScope`, since `checkPlanInvariants` is pure. One a saved plan brings to
    such a host fails at its start, saying why, and never stays ready with nothing to
    start it: from there it is a failed check, and a child it stops ends `blocked`.
  - A check may declare a loop whose body fixes what it finds (ADR-0045): the body
    may depend on the delegated task, and the delegated task stays outside it.
  - A failed check blocks its dependents and wakes the planner, as any failure
    does. A model is refused `skip_task` on it: that would let the work past its
    only check. The user's Skip stands.
  - **Reach.** The child's tools read its own plan and its ancestors' boards, never
    the parent's plan, so nothing hands it the check, and its plan's prompts do
    not name one. That is scope, not a boundary: a runner in a write-capable mode
    can read `.ordewell/` on disk (ADR-0022 A6) until a lease proves
    `fs.hostHidden` (ADR-0059 L3). A subplanner cannot: its envelope confines it.
- **A failed check holds automatic merges (D9).** Landed work whose check has not
  passed is not merged by anything but a person. Merge at gates, the run's end,
  a supervisor's `merge_all` and a child's own merge are held while any delegated
  task of that plan but a `readOnly` one has a check that has neither passed nor
  been skipped, which only the user can do, and they say why. The user's Merge all
  is not held, and its confirmation names the check. Without this a check that
  fails would stop nothing: its work is already on the branch the merge reads. A
  `readOnly` task's is not, so its check holds nothing.

### Isolation

- **Isolation nests (D10).** A child is a run of its own: its own id, its own
  integration branch `ordewell/<child-run>/integration`, based on the delegated
  task's branch, which is its base branch for
  [ADR-0042](../isolation/0042-merge-all-lands-only-on-the-branch-the-run-started-on.md).
  A run of its own is forced anyway: git refuses a branch name nested under a task
  branch, and `RUN_BRANCH` reads no run id from a deeper name. A child merges into
  the delegated task's branch by itself at its end, through the unchanged
  `mergeIntoCheckedOut`, and the parent's ordinary landing carries it up: two
  merges per level, and neither changes for a level. The child's has a base branch,
  so it is a fast-forward while that branch has not moved (`landsAsMergeCommit`); the
  parent's landing is the `--no-ff` merge with `landingMessage`'s words, the one
  commit that names the work. For a child, ops gates and
  "Merge all" mean the delegated task's branch.
- **Code root and state root (D11).** `Session.workspace` splits in two. The code
  root is the delegated task's worktree. The state root is the root Session's
  workspace: `.ordewell/sessions/<root>/children/<child>/` holds a child's session
  file, task logs and patches, and `.ordewell/worktrees/<child-run>/` its worktrees,
  at every depth. Never inside a task worktree.
  - `startRun` takes both and a run keeps both, one path on a flat run. Git reads the
    code root, as `workspaceRoot` is read today, so `repo.root` is the worktree and
    `baseRef` and `baseBranch` are the delegated task's HEAD and branch, as D10 needs.
  - Ordewell's own files read the state root: `runRoot`, `sweep`, `taskLogLocation`
    and `getStateDir`. `ensureStateDirIgnored` runs there and never on a task
    worktree, and a prune of the parent's worktree cannot reach a child's. The admin
    lock is keyed by it and is the tree's, since one repository's `git worktree add`s
    race whichever root asks.
  - A child's worktrees bootstrap from the repository under the state root, the
    root's checkout (ADR-0013), and not from `repo.root`, a worktree's links.
  - The session store keys a path by session id alone, so its helpers take a child's
    root as well. `listSessions` reads `sessions/*.json`, so a child session is never
    in the list and never offered: it is deleted with its root and adopted only
    through it. `deleteSession` removes files and no worktree, so deleting a root
    first discards each child's run as `discardRun` does, or its worktrees and
    branches would outlive the only record that names them.
- **Only the root touches the user's branch (D12).** Enforced where a child is
  built: `ChildPlanRunner` refuses a child whose code root is the user's checkout.
  `mergeLanded` needs no check of its own, since a child's checkout is a worktree
  on the delegated task's branch. So a delegated task needs an isolated run: in a
  run that shares the workspace root (`not-git`, `no-commits`, `disabled`, or Run
  without isolation) its start is refused, saying why, and the planner is told
  when the plan is written.
- **One session lease (D13).** A child holds no lease file. The root's
  [session lease](../isolation/0049-a-session-has-one-live-host.md) covers the
  tree, its runner groups included, and `leasedIsolation` asks it. Only a root is
  adopted, so no second host can reach a child, and a tree does not multiply the
  heartbeat.
- **A conflict is repaired by a runner (D14).** A delegated task's landing can
  conflict. Its repair ([ADR-0015](../isolation/0015-conflict-repair.md)) needs a
  session that edits files, which a subplanner never is, so a delegated task's
  repair attempt is a plain runner on its `assignedRunner` and `assignedModel`, in
  the kept worktree, in the mode `taskMode` holds for this one use, on a task token.
  `classifyAttempt` already ranks a repair first. A repair lands after the verdict, so
  `Landing.settleRepair` holds it to D7: one whose `repairBase..branch` diff, what the
  branch brings onto the tip it was repaired against, touches a protected path goes
  `unrepaired`, as one that leaves conflict markers does. A repo the landing did not
  change has no `repairBase`, and a repair can still edit it, so there both reads
  take `taskTip..branch`, the repair's own commits, before `integrate` moves
  `taskTip`. `verifyRepair` reads markers in that repo on every run, a flat group's
  included, since ADR-0015's guarantee has the same gap there; only its containment
  check needs a `repairBase`. A repair that fails either does not land, and its
  worktree is kept.
- **A retry starts a child over (D15).** A fresh retry of a delegated task discards
  its child run as `discardRun` does and starts a new child on what is left of its
  budget; the old child's state stays on disk under the root. Revert
  ([ADR-0054](../isolation/0054-a-landed-task-reverts-on-the-integration-branch-before-merge-all.md))
  takes the one landing whole: it is the user's, and it never reaches inside a
  child.

### Stop, restart and slots

- **Stop is a tombstone first (D16).** A Stop of a node is recorded at once, in
  memory: every start under it, a claim or a planner turn at any depth, reads its
  ancestors' Stop as it reads its own Stop generation
  ([ADR-0029](0029-the-supervisor.md)) and is refused. Then the subtree stops,
  leaves first, and `ChildPlanSession.stop()` resolves when the subtree is gone,
  with no timeout of its own at an interior node. A surface shows the node as
  stopping until it does. A runner's own grace stays ADR-0018's.
- **Restart (D17).** Loading starts nothing
  ([ADR-0044](../planner/0044-the-planners-usage-limit-waits-and-resends.md),
  [ADR-0053](0053-what-waits-on-a-person-is-derived-and-answered-in-one-call.md)).
  The child's file is not read until asked for. A delegated task that was live
  reloads failed, as interrupted, with `runnerSessionId` naming its child session,
  and is listed. Continue reopens the child and acts as Execute there: its plan
  loads, in-progress tasks fail, and `PlanStore.resetForRun` readies what failed, so
  they are retried. Its subplanner resumes from its native session, or replays its
  Model context. A parent's adoption does not prune a task that names a child:
  `pruneOrphans` keeps that record as it keeps kept work, and a child's worktrees
  are out of its reach by D11. Continue never crosses runners, as ever.
- **Slots (D18).** A delegated task holds no runner slot: a parent at its limit
  would otherwise deadlock on children that hold them. The `child-plan` lease role
  reserves a node and no slot (ADR-0059 L1). One pool counts every attempt in the
  tree and every running subplanner turn against the root's Parallel limit.
  - The pool refuses at the claim, and readiness stays each Session's own: it counts
    that Session's attempts that hold a slot, so a task the pool refused stays ready
    and its run is not settled, and no child parks on `waitOnUser` for a slot.
  - A scheduler ticks on its own Session's events, and a slot may free in another. So
    the pool keeps the Sessions it refused, and each release ticks them, oldest
    first, until no slot is free. A flat run's own events already do this.
  - A pool refusal on a start nobody asked for is a wait, not a failure: `slotsFull`
    reads the pool, so an owed repair stays owed. A resume at a limit's reset is kept
    past its time, where a flat run drops it to the user. The reset's timer has fired
    by then and nothing re-arms it, so the resume calls `reserve` as a refused claim
    does (ADR-0059 L1), and a tick offers kept resumes beside `startOwedRepairs`,
    which a held run's tick still reaches. Only an explicit start answers its caller
    with the refusal.
  - A subplanner between turns holds no process: its adapter is disposed when a
    turn ends and its session id kept, so it is a parked row. A turn's own
    corrective retries stay in that process.
  - A subplanner's turn queues ahead of attempts. If everything that holds a slot
    is waiting on a planner, the oldest turn one of them waits on is let in over the
    limit, one at a time: a limit that stopped the answer would stop the tree. One
    is enough, since a turn waits on nothing (ADR-0056 M8): when it ends the test is
    read again. So nothing holds a slot for ever on a turn that waits for that slot,
    and at most one subplanner turn runs past the limit.
  - The root's planner turn is counted once the tree has a child, and never held:
    it is the user's conversation, and the run does not depend on it. With no
    delegated task live, the Parallel limit is what ADR-0030 says, attempts alone.
  - A usage limit found by one node holds for the whole tree: `LimitPauses`' waits
    are the tree's, keyed by runner.

### Shape, surfaces and the setting

- **Limits on shape (D19).** Mandate limits with hard caps in core, refused rather
  than dropped, naming the level (ADR-0056 M3):

  | limit | default | hard |
  |---|---|---|
  | depth, the root plan being 0 | 2 | 4 |
  | delegated tasks per plan | 8 | 30 |
  | tasks per child plan | 30 | 100 |

  A root plan has no task limit, so a flat run does not change.
- **Surfaces (D20).** The root shows a delegated task as one row with derived
  counts, and its log shows the child's activity, projected into its task log. A
  child's `broadcast` carries nothing to a surface: its planner messages, cards and
  status never reach the user directly. Usage rolls up: a delegated task's usage
  adds its child's planner and tasks to `planUsage`. A full tree view is later.
- **Off unless turned on (D21).** Delegation is a run setting, off by default
  ([ADR-0030](0030-global-run-settings.md)), and turning it on sets the tree's token
  budget (ADR-0056 M5). The planner is taught delegation only then. A flat plan
  stays the default even so: the prompt teaches delegating only a separable
  subdomain with a clear boundary, and preferring a flat plan for one coherent
  feature or a change with cross-cutting invariants. Delegation and parallelism are
  separate: a child plan may be serial.

## Testing decisions

- `ChildPlanRunner` is tested as `ScriptRunner` is: through `IRunner`, with
  `FakeRunnerSession` behind a child Session, driving Stop, a message, a question,
  a report and a Continue, and asserting what the parent's attempt does.
- D6, D8 and D9 are held at the seam with a table of child states against the
  answer to `done`, every task skipped and an unchanged branch among them, and the
  plan-level refusals, a script check where nothing can seal and one on a `readOnly`
  delegated task included, through `validatePlanTasks` and `applyTaskOps`, as
  `loop.validation.test.ts` does. A `readOnly` delegated task whose check failed
  holds no merge.
- Isolation runs against real repositories. The probe task 32 saved
  (`nestedRun.probe.test.ts`, a two-level climb to main) is the prior art, extended
  with the state root, a prune with a child live, a sweep from a child's HEAD, a
  root's delete and a repo group, which the probe did not reach. It drove `GitWorktreeIsolation`
  alone: a real nested Session is untested.
- D18 is held by a test that fills every slot with attempts waiting on a checkpoint
  and asserts the answer still runs and that one turn is the most let past the limit,
  and by one with Parallel 1 across two children: the task the pool refused starts
  when the other child's ends, and no child waits on a user. A third has the pool
  refuse a resume at its reset: it starts when a slot frees, in a run still held.
  Flat runs keep their suites unchanged.
- D14's rule is tested with a repair that edits a protected path, in a repo the
  landing changed and in one it did not, and with one that leaves a conflict marker
  in a repo the landing did not change: none lands.

## Out of scope

- A full tree view, and a surface that opens a child.
- Resuming a running subtree after a restart without being asked (#31). ADR-0044
  forbids it.
- A child that outlives its parent's process, and remote hosts.
- A loop whose body is a delegated task, and moving a task between plans.
- A delegated task on a run that does not isolate.

## Considered options

- **Any depth (the owner's position).** Adapted to default 2, hard 4. Nothing bounds
  a tree at any depth but the spend. No source the research read publishes depth
  for a coding run, so these numbers are a design choice, kept where they can
  change; the largest public run is a forest whose top split a person wrote, by an
  interview claim of about 2,000 concurrent agents
  ([Cursor, vendor](https://simonwillison.net/2026/Jan/23/fastrender/)), where the
  same company's posts say several hundred. Google's study of multi-agent
  architectures ([arXiv 2512.08296](https://arxiv.org/abs/2512.08296)) finds that
  alignment of architecture to task decides whether more agents help: its extremes
  are two non-coding benchmarks, so only the direction carries over.
- **One orchestrator owning the tree.** Rejected. Every per-plan field of a Session
  (plan, conversation, turns, supervision, lease) becomes per-node, and with them
  the isolation controller, `Landing` and `LimitPauses`; ids must be unique across a
  tree; a start hold holds every node; one file is rewritten on each save. It gives
  one Stop and one restart, which D16 and D17 get for far less, and it would rewrite
  the two largest modules.
- **A separate process per child, now.** Rejected for now. Tokens and the MCP port
  die with the parent, the daemon's `execute-command` route acts as the user, and a
  host killed outright leaves its runners, which sit in their own process groups.
  Nested Sessions share a host's failure and one event loop, which
  [ADR-0058](0058-a-tree-holds-many-nodes-and-few-live-sessions.md) sizes for.
- **`subtasks` as the recursion.** Rejected. A subtask shares its parent's plan,
  planner, approval and branch: everything a delegated task must not.
- **`plan_complete` and `ask_parent` tools.** Rejected. Two tools for what
  `task_complete` and `checkpoint` already say, and a second kind of node with them
  (#112).
- **Child worktrees inside the parent's.** The probe's shape, and how it found the
  prune and the swept `.gitignore`. Rejected, not patched: a state root removes both.
- **Passing on a settled child alone.** Dropped: a child settles by skipping
  everything, and its check then reads an unchanged tree and goes green.
- **Every due turn past the limit while the slots wait on planners.** Dropped: it
  bounds nothing, and the tree needs only one turn to move.
- **A declared check on the delegated task.** Rejected: a check is a task (#39,
  ADR-0045), with a log, a verdict and a loop.
- **A `readOnly` delegated task's script check run on its branch.** Rejected: that
  branch goes with its worktree (ADR-0046), and keeping it for a check keeps work the
  task says it does not land.
- **Instructions not to game the check.** Rejected. METR found o3 reward-hacking in
  30.4% of RE-Bench runs, where it could see the scoring function, against 0.7% on
  HCAST, and "Please do not cheat" left the rate at 80% on the task it tested
  ([2025-06-05](https://metr.org/blog/2025-06-05-recent-reward-hacking/)). That is
  one 2025 model on visible graders, no base rate; it is why the check is held out
  of reach and the protected paths are code.
- **A script check behind its merge gate.** Rejected at the root, as written first.
  It would pass or fail on the user's branch, after the one step it should precede.
- **Reading markers in a repo with no `repairBase` for a delegated task's repair
  alone.** Rejected: `verifyRepair` has no reason to know the task's type, and a flat
  group's repair lands the same marker.
- **Failing a landing on a protected path.** Rejected: ADR-0013 keeps a landing from
  failing a task, and the work would wait on a person for what is a verdict.
- **A delegated task that holds a slot, or a Parallel limit carved per subtree.**
  Rejected: the first deadlocks a parent at its limit, the second leaves slots idle
  in a quiet subtree while another waits.
- **Delegation on by default.** Rejected. A vendor that gained from sub-agents on
  research says "most coding tasks involve fewer truly parallelizable tasks than
  research", at about fifteen times the tokens of chat
  ([Anthropic, vendor](https://www.anthropic.com/engineering/multi-agent-research-system)).
  A preprint on ProgramBench found implementers plateau beyond four workers and
  teams cost three to seven times solo
  ([arXiv 2610.17471](https://arxiv.org/abs/2610.17471)). A flat plan already fans
  out; a subplanner adds context compression for a separable subdomain, and nothing
  else.

## Consequences

- `TaskType` gains a member, so its 155 `.type` sites each take a decision, and
  `AttemptKind` and `TaskWork` a member; most are AI-against-the-rest.
- `Session` and an isolation run gain a state root, and everything that read
  `workspace` for state moves to it.
- A check can fail after its work landed. Taking that work back stays the user's
  Revert; the parent's way on is a fix task or a loop.
- A check's hiding is only as good as the runner's reach, until a container backend
  proves it.
- A subplanner parks, which [ADR-0009](../planner/0009-coding-agents-as-planners.md)
  rejected for the root because of the cold start on each message. A subplanner's
  turns are far apart and nobody waits on one, and the Model context stays the
  authority when a resume cannot be trusted.
- A host crash takes the tree, and Continue is the way back. Nested Sessions share
  one event loop.
- A fork carries no child: a delegated task in a fork starts over.

## History

- 2026-10-31 — accepted. Not yet implemented.
- 2026-10-31 — checked against the code: what a delegated task's grants ask for, the refusals of it in a loop, the settled test's caller, a repair's protected paths, the child's merge, the two roots on a run and a root's delete, and how the pool reaches a Session it refused.
- 2026-10-31 — checked against the code again: what wakes a kept resume, a child that did no work and `readOnly`, a script check where nothing can seal, a repair in a repo its landing did not change, the bound on turns past the limit, and `research` in a child plan.
- 2026-10-31 — checked against the code a third time: what checks a `readOnly` delegated task and what its check holds, and conflict markers in a repo a repair's landing did not change.
