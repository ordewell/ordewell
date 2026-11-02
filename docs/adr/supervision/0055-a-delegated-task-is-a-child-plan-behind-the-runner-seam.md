---
status: accepted
implemented: partial
amends: ["0009", "0013", "0015", "0018", "0020", "0022", "0029", "0030", "0035", "0045", "0046", "0049", "0054"]
note: "Settles #33. Built: D1 to D19 and D21, so a child plan runs end to end behind the build's switch, asks up a level, stops as a subtree and comes back on a Continue, its conflicts and merges with it. Not built: a subplanner's native resume, so a reopened one replays its Model context. D20 is built for the TUI and VS Code: a row with its goal, budget left and live counts, D16's stopping row, a log of what its child's tasks become, and a report's open and promoted findings; a tree view is later."
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
  | `protectedPaths` | required unless `readOnly`: paths the child may not change (D7) |
  | `grants`, `scope` | optional: the grants it asks for past the floor (ADR-0056 M2, M4), a declared scope, advisory and granting nothing (ADR-0057 R6) |
  | `readOnly` | optional: it answers a question and lands nothing ([ADR-0046](../planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md)), so D6 asks for no change, D7 for no paths and D8 for a read-only AI task as its check |

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
  plans. Its `task_complete` is checked against its own child plan, and what it
  may cite is its whole subtree (ADR-0057 R1).
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
  delegated task that lands names the paths (tests, CI, scoring) its child may not
  change: `delegationErrors` refuses one with none on every route. A check runs the
  branch it judges, so a child that rewrites what the check runs, a test or the
  `package.json` that names it, turns its one gate green without the work, however
  far out of reach the check is. Ordewell cannot derive what a command reads
  (ADR-0035, [ADR-0058](0058-a-tree-holds-many-nodes-and-few-live-sessions.md) S6),
  so the planner names it: the prompt teaches listing what the check runs and the
  configuration that runs it, and a read-only AI check, told to read that change, for
  a goal that must edit one of them. The refusal proves a list was written, not that
  it is whole: a path it leaves out is the child's to change, and a pass rests on
  that list. A landing never fails a task
  ([ADR-0013](../isolation/0013-worktree-isolation.md)), so the check sits in the
  last step before one, on the same diff. A repair lands after that step, and is
  held to the same paths there (D14). Paths accumulate down the tree
  (ADR-0056 M4): a nested delegated task is held to its ancestors' too.
  A rule is relative to the repository root and read whatever its case and however
  its characters are composed, since a case-insensitive checkout writes one file under
  either name: a name covers that path and what is under it, `*` crosses no `/` and
  `**` does, and a pattern with no `/` matches a name at any depth. A rule outside the
  repository, one with another wildcard, and one that covers the whole of it are
  refused with the rest (`protectedPathFault`), since each would pass a diff it was
  meant to stop or leave a child nothing to land. A saved plan's whole-repository rule
  matches everything, so the matcher errs by refusing the work.
- **A check is a task (D8).** `delegationErrors`, in `checkPlanInvariants`, refuses
  on every route a delegated task with no check directly depending on it, as
  `loopErrors` holds a loop. A check is a read-only AI task or a script task
  marked `readOnly`. What follows from the existing rules:
  - The check runs once the delegated task has landed on the parent's integration
    branch, so a dependent sees its work. It cannot hold that landing back.
  - **A check starts by itself.** When a delegated task passes and its check is ready,
    the check starts, on every route that started the task: Execute, a `run_task`, a
    retry or a Continue. A scheduler does this anyway. With none, the passing attempt
    carries the check on, as a loop's rounds are carried on (ADR-0045 L5): the run
    stays open for it alone, and closes when it ends, so nothing reads as finished
    with the work unjudged. It is read off the plan as it stands, so a check behind a
    failure, or behind a task nothing is running, is not carried and holds nothing open.
    A Stop withdraws it, and a restart forgets it, since loading starts nothing (D17).
    It takes the start rule whole. A check outside the user's approval record is not
    started: a start consents to the task it names and a script's consent is to its body
    (ADR-0035), so it waits in the inbox, and the run says so and stays open for the answer.
  - **A `readOnly` delegated task's check reads its handoff.** It never lands, and
    its worktree and branch go when it passes (ADR-0046), so the tip a dependent is
    cut from holds none of its work, and a script there would pass or fail on the
    unchanged baseline. Its handoff is all it leaves. So `delegationErrors` counts
    only a read-only AI task as its check, which reads that handoff with
    `read`, and refuses a script there on every route, `readOnly` or not.
  - **A script check runs sealed.** A script task runs at the workspace root
    behind a merge gate (ADR-0020, ADR-0035), so at the root it would wait for
    Merge all and check the work after it reached the user's branch. A script
    task marked `readOnly` runs instead as a read-only task's shell does
    ([ADR-0046](../planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md)):
    sealed ([ADR-0036](../planner-envelope/0036-the-planners-shell-sealed-runs-and-native-opt-in.md)),
    in a throwaway worktree cut from the integration tip, landing nothing, past no
    gate, its exit status its evidence, and consent to its body as ADR-0035 says. A
    delegated task's script check must be one. Where no sandbox can seal (ADR-0036
    S6) it cannot run, and the check must be a read-only AI task. So a script check is
    refused there on every route, saying why, on `canSeal` read through
    `PlanChangeScope`, since `checkPlanInvariants` is pure. One a saved plan brings to
    such a host fails at its start, saying why, and never stays ready with nothing to
    start it: from there it is a failed check, and a child it stops ends `blocked`.
  - **A new result is checked again.** A pass judged one result, and a re-run of
    the delegated task makes another. A completed task never runs again, and
    ADR-0054 leaves a dependent that landed nothing as it is, so that pass would
    stand over work and a handoff it never read. So a delegated task's checks are
    retried with it, whatever their status, their rounds starting over (ADR-0045 L7),
    at two points. `PlanStore.retry`, which a retry, a continue, Mark not done and a
    revert all pass through, does it at once, since each of those ends the result the
    pass judged. The claim does it for the starts that never call `retry`: being the
    one point every start passes, it has a fresh attempt, neither a repair nor a
    continuation, take its checks back, which reaches Execute's fresh chance
    (`resetForRun`, `readyFailed`, a child's Continue by D17) and a force start. That
    takes back a check the user skipped too, though a new run leaves any other skipped
    task as it is: a Skip let one result past, not the next. A live check refuses the
    retry, naming it, as a live dependent refuses a revert (ADR-0054), and is a start
    wait of a fresh attempt, so Execute's and a force start's wait for it to end. A
    resume after a usage limit goes on with the attempt the limit cut short, so it
    takes nothing back.
  - A check may declare a loop whose body fixes what it finds (ADR-0045): the body
    may depend on the delegated task, and the delegated task stays outside it.
    `delegationErrors` refuses, on every route, a body that is not a worktree task,
    meaning a script task or an ops AI task, when its check depends on a delegated
    task, directly or through other tasks. Such a body waits at a merge gate
    (ADR-0020) for that task's work, which D9 holds until the check passes, and the
    check waits on the body for its next round. So no body waits on a merge D9 holds.
  - A failed check blocks its dependents and wakes the planner, as any failure
    does. A model is refused `skip_task` on it: that would let the work past its
    only check. The user's Skip stands.
  - **A check this host cannot read is still a check.** What makes an AI task a check
    is its mode, read from its runner's manifest. A runner switched off since, removed
    or absent from this machine leaves that unreadable, so every AI task directly on the
    delegated task and on such a runner counts as one: it holds the merge (D9), may not be
    skipped by a model, is taken back and refuses a retry beside it. That fails closed, and
    a change task on such a runner holds too, until the user skips it or merges. Only a
    plan being written is held to the modes it can read: a task nothing can read is no
    check to accept one on.
  - **Reach.** The child's tools read its own plan and its ancestors' boards, never
    the parent's plan, so nothing hands it the check, and its plan's prompts do
    not name one. That is scope, not a boundary: a runner in a write-capable mode
    can read `.ordewell/` on disk (ADR-0022 A6) until a lease proves
    `fs.hostHidden` (ADR-0059 L3). A subplanner cannot: its envelope confines it.
- **Landed work holds automatic merges until its check passes (D9).** Landed work
  whose check has not passed is not merged by anything but a person. Merge at gates,
  the run's end, a supervisor's `merge_all` and a child's own merge are held while
  any delegated task of that plan has landed work not yet merged, read as ADR-0054
  reads both, and a check that has neither passed nor been skipped, which only the
  user can do, and they say why. The user's Merge all is not held, but it asks: the
  seam answers it with the checks it would go past, named as the plan names them, and
  merges only when the command carries `pastChecks`. Every surface asks that second
  question and sends the yes; a supervisor or a planner is refused whatever it carries. Without this a check that fails would stop nothing:
  its work is already on the branch the merge reads. Work that has not landed holds
  nothing, so a check waiting on its delegated task, or blocked behind one that
  failed, stays out of every other task's merge, and a `readOnly` task, which never
  lands, holds nothing. A held merge is no merge that stopped: the hold ends with
  the check's pass or Skip, and the next tick merges, a run that closed with its
  merge held included, which owes that merge rather than handing it to the user.
  A delegated task started alone leaves no such hold behind it unasked: its ready check
  starts by itself (D8), so the run closes after the check and merges as its settings
  say. The hold fails closed: a check whose runner cannot be read here holds as any does (D8).

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
  - `startRun` takes both and a run keeps both. A flat run saves only the one path,
    so its file reads as it always did. Git reads the code root, as `workspaceRoot`
    is read today, so `repo.root` is the worktree and `baseRef` and `baseBranch` are
    the delegated task's HEAD and branch, as D10 needs.
  - Ordewell's own files read the state root: `runRoot`, `taskLogLocation` and the
    session store. `ensureStateDirIgnored` runs there and never on a task worktree,
    and a prune of the parent's worktree cannot reach a child's. The admin lock is
    keyed by it, and a child is handed its parent's isolation, so the lock is the
    tree's: one repository's `git worktree add`s race whichever root asks.
  - A child never sweeps: its HEAD holds the tip its siblings start from, so a sibling
    that has no worktree yet would read as an earlier run, merged, and lose its
    integration branch. The root's sweep clears a tree.
  - A child's worktrees bootstrap from the repository under the state root, the
    root's checkout (ADR-0013), and not from `repo.root`, a worktree's links.
  - The session store keys a path by session id alone, so its helpers take a child's
    root as well, and a child's file is `session.json` beside its logs.
    `listSessions` reads `sessions/*.json`, so a child session is never in the list
    and never offered: it is deleted with its root and adopted only through it.
    `deleteSession` removes files and no worktree, so a host deleting a root first
    stops its tree and calls `discardChildRuns`, which discards each child's run as
    `discardRun` does, or its worktrees and branches would outlive the only record
    that names them. A child at work cannot have them taken from under it, so the
    stop comes first, and the delete waits for it (D16). What git could not let go
    stops the delete, the Session left open and stopped.
  - `Session.hostChild` seats a child: it mints the child's id, names it on the
    delegated task's run record (`childSession`), and hands back what `createSession`
    builds the child from. Asked again it finds the same child, so a reopen does too.
- **Only the root touches the user's branch (D12).** Enforced where a child is
  built: `createSession`, and so `ChildPlanRunner`, refuses a child whose code root
  is not a task's workspace under its state root, the user's checkout included, and
  so do `loadPlan`, which can move a code root, and `startRun`. `mergeIntoCheckedOut`
  holds to it for a saved record that names one, below every route to a merge, since
  git cannot tell a task worktree from a checkout. So a delegated task needs an
  isolated run: in a run that shares the workspace root (`not-git`, `no-commits`,
  `disabled`, or Run without isolation) `hostChild` refuses it, saying why, and the
  planner is told when the plan is written.
- **One session lease (D13).** A child holds no lease file. Its `childLease` reads
  the root's [session lease](../isolation/0049-a-session-has-one-live-host.md),
  which covers the tree, its runner groups included, and `leasedIsolation` asks it.
  Only a root is adopted, so no second host can reach a child, and a tree does not
  multiply the heartbeat. A run a held lease refuses stays unopened: it does not fall
  back to running without worktrees, as a refusal from git does. A child reads the
  lease through its parent, so a parent's `destroy`, which hosts do not wait on,
  stops its subtree at once and lets the lease go only once that subtree has gone:
  read as free before then, the tree could be taken from under what still writes.
  `Session.gone` settles when it has. The tree's ledger waits for the same (ADR-0056 M5).
- **A conflict is repaired by a runner (D14).** A delegated task's landing can
  conflict. Its repair ([ADR-0015](../isolation/0015-conflict-repair.md)) needs a
  session that edits files, which a subplanner never is, so a delegated task's
  repair attempt is a plain runner on its `assignedRunner` and `assignedModel`, in
  the kept worktree, on a task token. It runs in the runner's mode for the delegated
  task's mandate `autonomy`, read by `ModeResolver` as ADR-0056 M6 reads a child's
  tasks, and set on the repair attempt for that one use. A delegated task has no
  `taskMode` on the plan, so a repair never falls to the spawn's `build`, which is
  wider than a Guarded run's mode on one runner and no mode at all on another.
  `classifyAttempt` already ranks a repair first. A repair is that plain runner to the
  ledger too: what it spends is charged as a runner's is, where a child's rolled up
  from its node. It runs on a task whose saved session is the child's and whose
  handoff is its subplanner's report, so it replaces neither: D15 and D17 still find
  the child, and its own handoff goes to its attempt's log, where a read of that
  attempt finds it, its words held as ADR-0057 R3 says. A repair lands after the verdict, so
  `Landing.settleRepair` holds it to D7: one whose `repairBase..branch` diff, what the
  branch brings onto the tip it was repaired against, touches a protected path goes
  `unrepaired`, as one that leaves conflict markers does. A repo the landing did not
  change has no `repairBase`, and a repair can still edit it, so there both reads
  diff `taskTip` against the branch, before `integrate` moves `taskTip`. That diff is
  wider than the repair's own edits: it also holds what the repair merged in from the
  integration tip, so a landed task's lines can refuse a repair, which then waits on
  the user, and nothing the repair left goes unread, in a merge commit or not.
  `verifyRepair` reads markers in that repo on every run, a flat group's included,
  since ADR-0015's guarantee has the same gap there; only its containment check needs
  a `repairBase`. A repair that fails either does not land, and its worktree is kept.
  With no repair left the conflict waits as any does: on the user at the root, and on
  its subplanner, which is woken for it, below (ADR-0056 M8). A resolver the user adds
  takes that mode on the plan, for the same reason, and is theirs: it is held to no
  protected path, as nothing they do by hand is.
- **A fresh attempt starts a child over (D15).** When a delegated task's next
  attempt is fresh by any route, Execute, a force start, a retry, or Mark not done
  then a start, its child run is discarded as `discardRun` does, grandchildren first,
  and a new child starts on what is left of its budget (ADR-0056 M10). A Continue
  never discards it: D17 reopens that child. A delegated task removed from the plan,
  by a person or a planner's edit, has its child run discarded too, or its worktrees
  and branches would outlive the only record that names them (D11), and a run's own
  Clean up and Discard take its children's with them. Merge and split refuse a
  delegated task, so neither reaches one. The Session does this, through the orchestrator
  and never `PlanStore`, which reaches no run: for a fresh attempt as it opens, the
  first step past the claim, since a claim is synchronous and git is not, and that
  attempt's kind says it is fresh on every route; for an edit as it lands. The task's
  `runnerSessionId` names the child, set as it is seated and cleared only by the
  discard, so a retry that dropped the task's record and a crash both leave the name.
  What git could not let go stops the start, with the name kept. The old child's
  state stays on disk under the root. Revert
  ([ADR-0054](../isolation/0054-a-landed-task-reverts-on-the-integration-branch-before-merge-all.md))
  takes the one landing whole: it is the user's, and it never reaches inside a
  child.

### Stop, restart and slots

- **Stop is a tombstone first (D16).** A Stop of a node is recorded at once, in
  memory: every start under it, a claim or a planner turn at any depth, reads its
  ancestors' Stop as it reads its own Stop generation
  ([ADR-0029](0029-the-supervisor.md)) and is refused. Then the subtree stops,
  leaves first, and `ChildPlanSession.stop()` resolves when the subtree is gone,
  with no timeout of its own at an interior node: its runners, its live planner turn
  and any turn at a gate included. A surface shows the node as stopping until it
  does. A runner's own grace stays ADR-0018's. The tombstone is the attempt's own, so
  a later attempt starts clear of it, and a child reads it through its
  `SubplannerLink`, which reads on up. A node its budget or its clock stopped reads
  the same way (ADR-0056 M3, M5).
- **Restart (D17).** Loading starts nothing
  ([ADR-0044](../planner/0044-the-planners-usage-limit-waits-and-resends.md),
  [ADR-0053](0053-what-waits-on-a-person-is-derived-and-answered-in-one-call.md)).
  The child's file is not read until asked for. A delegated task that was live
  reloads failed, as interrupted, with `runnerSessionId` naming its child session,
  which is written as the child is seated, and is listed. Continue reopens the child
  and acts as Execute there: its plan loads, in-progress tasks fail, and
  `PlanStore.resetForRun` readies what failed, so they are retried, and its
  subplanner replays its Model context with the message: a planner's native session
  is held in memory and saved nowhere, so a new process has none to resume. A child
  whose plan never reached the disk plans its goal again, and one with nothing left to
  run goes straight to that turn: it may owe only its report. A delegated task parked
  at its subplanner's question reloads waiting, with no answer left to wait for: what
  would hear one is held in memory, so the question is lost. It says so, in its row
  (`question-lost`) and in the inbox, which quotes the question, saved beside the wait for
  this alone, and offers Continue, since its child and its work are still there. Its node closed as it ended,
  or a crash left it open, so a Continue carves again, under the same child, from
  what the task has left, after `Session.ledger()` has answered. The task's worktree
  is restored in place, on the same path, read-only or not, since a child's run is
  tied to that path: a record that names a child keeps its parent's run continuing,
  whether or not a Stop has yet taken it off `active`, and a child whose path moved
  anyway is refused, `blocked`, rather than mint a run and leave what it landed behind. A stopped delegated task
  reads as not started and may be continued, since its child is still there: a surface's
  composer continues it, as it does a finished task, and every other start discards that
  child (D15). One that landed may not, since its child has gone with the work. A subplanner a guard
  lowered, or that failed its restart, is Act again (ADR-0056 M8). A parent's adoption does not prune a task that names a child:
  `pruneOrphans` keeps a record with a `childSession` as it keeps kept work, a
  read-only one too, and a restore carries the name. A child's worktrees are out of
  its reach by D11. Continue never crosses runners, as ever.
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
    corrective retries stay in that process. An opening waits for a slot at the
    gate `PlanTurns` does not reach, and a Stop reaches a turn waiting for one as
    it reaches a turn at that gate.
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
    are the tree's, keyed by runner. A sibling's work on that runner waits for the
    reset, which ticks every node, and two nodes' limits on one runner end at the
    later of the two. A flat run's waits stay its own.

### Shape, surfaces and the setting

- **Limits on shape (D19).** Mandate limits with hard caps in core, refused rather
  than dropped, naming the level (ADR-0056 M3):

  | limit | default | hard |
  |---|---|---|
  | depth, the root plan being 0 | 2 | 4 |
  | delegated tasks per plan | 8 | 30 |
  | tasks per child plan | 30 | 100 |

  A root plan has no task limit, so a flat run does not change.
- **Surfaces (D20).** The root shows a delegated task as one row, of `kind`
  `delegated`. Its status carries a `delegation` row, derived each time one goes out and
  kept nowhere: where its child's tasks stand now, what is left of what the tree granted
  it, its budget and every raise, across every child the task has had (ADR-0056 M5, M10),
  or nothing on that until the ledger is read for a task that ran, since a restart has
  yet to read what it spent, and, while a Stop is still winding its
  subtree down, that it is stopping (D16), since by then the task already reads as not
  started. A surface draws these beside the goal, and a finished child's counts come
  from its report. Its log shows the child's activity, one line each time a child task's
  status changes, projected into its task log, and its handoff draws what a report adds
  to any task's: Ordewell's counts, what the plan above must decide (`open`), and what
  its subplanner passed up (`promoted`), each by the reference that names it
  (ADR-0057 R2). A surface draws none of it unless delegation is offered, and a webview,
  which cannot read the checkout it was built from, is told by its host. A child's `broadcast` carries nothing to a surface: its planner messages, cards
  and status never reach the user directly. Usage rolls up: each record its planner or
  a task spends goes up as it arrives, a level at a time, onto the delegated task's
  attempt, so `planUsage` and the row add it as they add any task's. It was charged
  where it was spent (ADR-0056 M5), so an attempt of a delegated task charges nothing,
  and the row has no context meter: no one session's context is a subtree's. A child
  session is never offered: `listSessions` does not see it (D11). A full tree view is
  later.
- **Off unless turned on (D21).** Delegation is a run setting, off by default
  ([ADR-0030](0030-global-run-settings.md)), and turning it on sets the tree's token
  budget (ADR-0056 M5). While the rest of this ADR is unbuilt a build holds it back
  as well: `DELEGATION_OFFERED` is on only with `ORDEWELL_DELEGATION=1` in a build run
  from a git checkout of this repository, so a published package ignores the variable,
  no surface shows the setting, and what a saved setting asks for stays inert. A
  saved plan that holds a delegated task there ends it `blocked`. The planner is
  taught delegation only where its mandate holds `delegate`: anywhere else its
  prompts and its tools do not change by a byte. A flat plan
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
  delegated task included, a `readOnly` script among them, a delegated task that
  lands with no protected paths, and a script or ops AI body whose check depends on a
  delegated task, directly or not, through
  `validatePlanTasks` and `applyTaskOps`, as `loop.validation.test.ts` does. A merge
  is held by landed work whose check is pending, blocked or failed, and not by a
  delegated task that has not landed, a `readOnly` one included, nor by work the user
  has merged; a held merge goes through at the next tick once the check passes. A
  retry, a continue, Mark not done and a revert each take a passed, failed or skipped
  check back, its next run reads the new handoff, and a live check refuses them.
  Execute, with work live and with none, and a force start take one back at the fresh
  attempt's claim, and wait for a live one; a resume and a repair take nothing back.
- Isolation runs against real repositories, in `nestedRun.e2e.test.ts`, which grew
  out of the probe task 32 saved: a two-level climb to main, with the state root, a
  prune with a child live, a sweep from a child's HEAD, a root's delete and a repo
  group. It also runs a nested Session built by `createSession` beside a running
  parent, through a restart. `flatSessionLayout.e2e.test.ts` holds a flat session's
  files, and passed on the commit before the two roots split.
- D18 is held by a test that fills every slot with attempts waiting on a checkpoint
  and asserts the answer still runs and that one turn is the most let past the limit,
  and by one with Parallel 1 across two children: the task the pool refused starts
  when the other child's ends, and no child waits on a user. A third has the pool
  refuse a resume at its reset: it starts when a slot frees, in a run still held.
  These run real Sessions side by side in `treeSlots.test.ts`, and the pool's own
  rules are tested alone in `SlotPool.test.ts`. Flat runs keep their suites unchanged,
  and `executionLease.flatRun.test.ts` holds them with a table over Parallel limits.
- D14's rule is tested with a repair that edits a protected path, its own and an
  ancestor's, with what it brings to a repo the landing did not change, and with a
  conflict marker there: none lands. A repair spawns in the mode its mandate's
  `autonomy` resolves to, at both levels, and the plan gains no `taskMode`.
- A delegated task runs end to end on real repositories in `delegatedTask.e2e.test.ts`,
  a scripted planner calling the tools a harness planner would, and in
  `delegatedTask.harness.e2e.test.ts` with only the binary faked: the real adapter, the
  real server and a token bound to the attempt. The parent's deadlock is held there
  with real Sessions. `delegation.validation.test.ts` holds the plan rules on both
  routes, and `delegation.session.test.ts` who may write one.
- What a child sends up runs end to end in `delegatedReports.e2e.test.ts`: a report, a
  finding climbing two levels, the usage it rolls up and a child session never listed.
- D15 is tested in `childRunLifecycle.e2e.test.ts` on real repositories, with each
  route to a fresh attempt, a removal and a run's own discard: the old child's
  worktrees and branches go and its state stays. A Continue leaves them. D16 and D17
  are tested there too: a Stop that resolves only once a held runner and a live turn
  have gone, a start refused under it, a grandchild, a child opening as it comes, and a
  crash in the middle of a child run, taken from the files a process left, followed by
  a load that starts nothing, a Continue and a fresh retry. The harness test does a
  Stop and a Continue with only the binary faked.

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
  die with the parent, and the daemon's `execute-command` route acts as the user.
  Nested Sessions share a host's failure and one event loop, which
  [ADR-0058](0058-a-tree-holds-many-nodes-and-few-live-sessions.md) sizes for.
- **`subtasks` as the recursion.** Rejected. A subtask shares its parent's plan,
  planner, approval and branch: everything a delegated task must not.
- **`plan_complete` and `ask_parent` tools.** Rejected. Two tools for what
  `task_complete` and `checkpoint` already say, and a second kind of node with them
  (#112).
- **An admin lock shared by every isolation in the process.** Tried, and dropped: a
  git command that hangs in one session then stops every other in that workspace,
  and a flat run's recovery from a crash waits on the attempt that crashed.
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
- **A hold from the moment a check is planned.** Dropped: a check is a task from the
  moment its delegated task is written, so every merge of the plan waited on work
  that had not landed.
- **A hold on a failed check alone.** Rejected: a merge in the moments before a check
  runs would carry the work past it, which is what D9 is for.
- **A check that keeps its pass through a re-run.** Dropped: ADR-0054 leaves it as it
  is, so new work merged on the old pass, and a new handoff went unread.
- **A gate that opens without its merge for a body on a delegated task's check.**
  Rejected: a script or ops body acts on a checkout that does not hold the work it
  should fix, and merging it gives up D9. Refusing the plan leaves the fix to a
  worktree task, which is cut from the integration tip and passes no gate.
- **A queued start for a delegated task's check.** Rejected: a queued start outlives what
  it waits for, so it stayed pending behind a failed task and read as a run still
  advancing. Carrying the check is read off the plan each time, so one that stops being
  ready stops holding the run open.
- **A check left for the next Execute.** Dropped: a delegated task started alone closed
  its run with everything reading as finished, its check pending and its merge held.
- **Starting a delegated task approves its check.** Rejected: ADR-0035's consent is to what
  will run, and a start names one task.
- **A check on a runner this host cannot read falling back to the literal `plan` mode.**
  Rejected: a mode's id is the runner's own (ADR-0031), so it would still fail open on any
  runner whose read-only mode has another name.
- **Taking a check back in `PlanStore.retry` alone.** Dropped: Execute readies a failed
  task without it and a force start claims one as it stands, so a skipped check stayed
  skipped over the new result, and D9 released it. Adding each route was rejected for
  the same reason: the claim is the one point none can miss.
- **Optional protected paths.** Dropped: a plan that left them out gave the child the
  check's inputs, and nothing said so until its report, after the merge.
- **Deriving a check's inputs from its command, or a built-in floor of paths.** Rejected:
  ADR-0035 and ADR-0058 S6 say why nothing can derive them, and a floor of manifests and
  CI files differs by language and fails the verdict of a task that adds a dependency.
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
- **A delegated task's repair in a `taskMode` on the plan.** Dropped: a delegated
  task never has one, since `plannedTask` resolves a mode only for an AI task and
  the planner cannot set it, so the repair read nothing and got `build`.
- **Discarding a child on a retry alone.** Dropped: Execute and a force start make a
  fresh attempt without `PlanStore.retry`, and a removal makes none, so each left the
  old child's worktrees and branches with no record naming them.
- **Discarding a child in `PlanStore`.** Rejected: it applies plan changes and has no
  run or isolation to discard.
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
  `AttemptKind` a member and `TaskWork` two; most are AI-against-the-rest.
- `Session` and an isolation run gain a state root, and everything that read
  `workspace` for state moves to it.
- A check can fail after its work landed. Taking that work back stays the user's
  Revert; the parent's way on is a fix task or a loop.
- A check's hiding is only as good as the runner's reach, until a container backend
  proves it.
- A pass is only as good as the planner's `protectedPaths`: a check that runs the
  repository's own code trusts what the list leaves out.
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
- 2026-10-31 — checked against the code a fourth time: a re-run takes its checks back, only landed work holds a merge, a script is no check of a `readOnly` delegated task, and what `taskTip`'s diff holds.
- 2026-10-31 — checked against the code a fifth time: a fresh attempt takes its checks back at the claim, Execute and a force start included, and a delegated task that lands must name its protected paths.
- 2026-10-31 — checked against the code a sixth time: a subplanner's handoff is checked against its own plan, a body on a delegated task's check is a worktree task, a repair's mode comes from the mandate, and a child run is discarded on any fresh attempt or removal.
- 2026-10-31 — D21's run setting implemented, off by default; nothing can delegate yet, so the planner is not taught it, and it moves only the root's mandate ([ADR-0030](0030-global-run-settings.md)).
- 2026-10-31 — D10 to D13 and D17's prune implemented, reached by `Session.hostChild`: `createSession` is where a child is refused the user's checkout until `ChildPlanRunner` exists, a child takes its parent's isolation and never sweeps, a delete stops on what git could not let go, and a run a held lease refuses does not fall back to the checkout.
- 2026-10-31 — D18 implemented in `SlotPool`, behind the lease (ADR-0059 L1): the root's pool reaches a child through `ChildPlacement`, and the subplanner's opening waits for a slot.
- 2026-11-01 — D15, D16 and D17 implemented: a tombstone first, on the attempt, read at every claim and turn below it; `ChildNode.close` returns a child's budget on every end; a fresh attempt discards as it opens, not at the claim, and a stopped task may be continued. A subplanner replays on a reopen, since no planner saves a native session. A delete stops its tree first, and a root's `destroy` keeps the lease until its children have gone.
- 2026-11-01 — one child plan end to end: D1, D2, D3 to D7, D8's plan rules and read-only script, and D19, in `ChildPlanRunner`, `models/Delegation.ts` and `PlanChangeCheck`. D21 gains the build's switch, and a protected path is one more check of the verdict.
- 2026-11-01 — a subplanner's question goes up, and D8's take-back, D9's merge hold, D14's repair and M9's rules for a child's scripts are implemented. A run that closed with its merge held owes it to the next tick, and a resolver of a delegated task's conflict takes the mode a repair does.
- 2026-11-01 — D20's minimum: a delegated row, usage rolled up a level at a time and charged once, and the child's activity in its log. D1's `read` is the runner's tool (ADR-0057 R11).
- 2026-11-01 — from a real run: a Continue with nothing left to run goes to its subplanner's turn, where it had failed on Execute's refusal; a report counts every opening of its task; a Stop says what a Continue keeps and Execute discards.
- 2026-11-01 — D20 on the TUI and VS Code: a delegated row's `delegation` (child counts, budget left, stopping), a report's `open` and `promoted`, VS Code's raise and answer words, and a Merge all that asks before it goes past a check. A webview is told by its host that delegation is offered, which it could not read itself.
- 2026-11-01 — from review and a real run: a ready check starts by itself once its delegated task passes, on every route (D8, D9); a check whose runner cannot be read holds as any does; a restart says a parked question is lost, and Continue picks the child up (D17).
- 2026-11-01 — from review: a repair is charged to the ledger and leaves the child's names and the report as they stood (D14).
- 2026-11-01 — from real runs: a surface's composer continues a stopped delegated task and one whose question was lost (D17), and its row counts raises and says no budget it has not read (D20).
- 2026-11-02 — from an audit: D7 says what a protected path covers, one matcher reads it on every use, and a rule the matcher would not honour is refused as it is written.
