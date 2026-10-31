---
status: accepted
---

# 0053 — What waits on a person is derived, listed once and answered in one call

*Pending:* [ADR-0056](0056-a-mandate-narrows-down-the-tree.md) — a subplanner's question reaches this list as its delegated task's checkpoint, naming the path; a child's own waits never do.

## Problem

A run that needs a person says so in many separate places: a runner approval
in a task's log, a checkpoint card, a task waiting for input, a merge gate on a
task's row, a Merge all offered at the run's end, a user task, a landing
conflict, a failed task, a loop out of rounds, a dirty checkout. Each has its
own card or command, and each surface shows some of them. Someone who walked
away has no single list of what is waiting on them, and nothing to answer it
through.

Issue #30 first proposed an `Escalation` record persisted with the plan, created by mandate rules and by
supervisors that are unsure, with a deadline or default answer.

## Decision

**What will not move without a person is derived from what the run already
holds, listed once, and answered through one call that dispatches to the
existing command for that wait.**

- **An escalation is derived, never stored.** `escalations`
  (`packages/core/src/services/escalations.ts`) is a pure function, as
  `planBlocks` and `startWaits` are, over the plan, the start rule's waits, the
  pending approvals and what the run is doing. Nothing sets one and nothing
  clears one: whatever ends a wait ends its escalation. The one thing saved
  for its sake is a count on the task, `Task.waitsEnded`, a fact about the task
  and no form of the escalation: see [What an id names](#what-an-id-names).
- **The list holds only what will not move without a person.** What resolves
  itself is left out, and a task whose cause is listed is left out in favour of
  that cause, listed once. The tables below are the exact kinds.
- **An escalation says what is waiting and what may be answered.** A stable id
  that names the wait and not just its attempt, so that a later wait is another
  escalation and a stale answer can be told from a live one; its kind; the task
  it belongs to, which is the link to the evidence; a reason
  in plain words; and the options a user may choose, which are what that wait's
  own card or command offers, as the seam would take them now. An option carries
  the question its card asks first, where there is one. There is no deadline
  and no default answer.
- **One answering call.** `answerEscalation(id, option, note?, confirmed?)` on
  the command seam (`ExecutionCommands`) derives the list afresh, refuses an id
  that is no longer live in plain words, and dispatches to the existing command
  for the option, as the user, so every check that command has still applies.
  It adds no authority. It takes no actor: it is a user action, no planner tool
  reaches it, and the planner's envelope
  ([ADR-0008](../planner-envelope/0008-planner-exploration-envelope.md)) is
  unchanged. The supervisor keeps its own tools.
- **Nothing else changes.** Existing cards and commands, and what blocks what,
  stay as they are. A waiting task waits and the rest of the plan goes on.

## What is listed

Kinds on a task come first in the plan's order, each runner approval ahead of
its task's own wait; `blocked-run` comes ahead of them and `merge-all` after.
Mark complete is offered on an AI or script task only while nothing could move
it on, since the seam refuses it otherwise
([ADR-0029](0029-the-supervisor.md)); a user task's is always offered.

| Kind | What it reads | Options | Dispatches to |
|---|---|---|---|
| `approval` | A pending runner approval of a task in the plan | Allow, Allow for this task where the runner proposed it, Deny | `answer_approval` |
| `checkpoint` | `awaiting_user`, `checkpoint`, runner there | Approve, Reject, Skip | `answer_checkpoint`, `skip_task` |
| `checkpoint` | The same, no runner left to hear it | Retry, Skip, Mark complete | `retry_task`, `skip_task`, `mark_complete` |
| `input` | `awaiting_user`, `input` or no saved reason, runner there | Reply, Skip, Mark complete | `message_task`, `skip_task`, `mark_complete` |
| `input` | The same, no runner left to read a reply | Retry, Skip, Mark complete | as above |
| `conflict` | `awaiting_user`, `conflict`, no resolver out to it | Add a resolver task, Retry, Skip, Mark complete | `Session.resolveConflictAsTask`, then as above |
| `conflict` | The same, with a resolver nothing will start | Start its resolver task, Retry, Skip, Mark complete | `run_task` on the resolver, then as above |
| `files-changed` | `awaiting_user`, `files-changed` | Retry, Skip, Mark complete | as above |
| `usage-limit` | `awaiting_user`, `usage-limit`, no `resumeAt` | Resume now, or Retry with no session to resume; Skip, Mark complete | `retry_task`, as above |
| `failed` | `failed`, no loop going on | Retry, Continue, Skip, Mark complete | as above |
| `failed` | A loop's check between rounds nothing will run ([ADR-0045](0045-a-check-repeats-with-its-fix-until-it-passes.md) L5), its body landed | Start its next round, Retry, Continue, Skip, Mark complete; while a dependency holds any start of it, that wait is named and none of Start, Retry and Continue is offered, with its body landed or not | `run_task`, then as above |
| `out-of-rounds` | A loop's check, `outOfRounds` | Retry, Continue, Skip, Mark complete | as above; a retry starts its rounds over ([ADR-0045](0045-a-check-repeats-with-its-fix-until-it-passes.md)) |
| `merge-gate` | Not started, held by nothing but its gate | Merge all; Force start, or Mark complete for a user task | `merge_all`, `force_start`, `mark_complete` |
| `on-hold` | Not started, held by nothing but its hold | Retry, Force start; Force start alone for a reverted task behind a dependency, whose retry the seam refuses until that has finished; Mark complete alone for a user task, which no runner starts | `retry_task`, `force_start`, `mark_complete` |
| `unapproved` | Not started, nothing else holds it, added since the plan was approved ([ADR-0035](0035-effects-are-consented-and-recorded.md)), or waited on by a loop carried on | Start | `run_task` |
| `no-prompt` | Not started, nothing to run | Skip | `skip_task` |
| `by-hand` | A user task nothing else holds | Mark complete | `mark_complete` |
| `merge-all` | Landed work, nothing moving and no gate listed | Merge all | `merge_all` |
| `blocked-run` | A run a dirty checkout turned away | Stash and continue, Run without isolation | `Session.continueWithStash`, `continueWithoutIsolation` |

A task whose attempt ended, listed as `failed`, `out-of-rounds`, `conflict`,
`files-changed`, or a `checkpoint` or `input` with no runner left, offers no Retry
and no Continue while a dependency, a merge gate or its loop's undecided check
holds any start of it: the seam would refuse both, so its reason names that wait
instead. A `usage-limit` pause with a session keeps Resume now: a resume goes on
with the attempt the limit cut short, which no such wait holds.

`merge-gate`, `on-hold`, `unapproved`, `no-prompt` and `by-hand` are listed only
in an open run: one scheduling, held, or ended on a failure a retry continues.
Outside one nothing was going to start them, so nothing is late. A loop carried
on with no scheduler
([ADR-0045](0045-a-check-repeats-with-its-fix-until-it-passes.md) L5) is an open
run for its own tasks alone: the rest of the plan does not start, so nothing
there is late. In a plan nobody approved, its task is `unapproved` all the same,
since the loop's next step waits on it. A reverted task
([ADR-0054](../isolation/0054-a-landed-task-reverts-on-the-integration-branch-before-merge-all.md))
is the exception: it is `on-hold` in any run, because the user took it back,
usually after the last task landed, and whether it runs again is theirs to say.
It is listed behind a dependency, a blocked one or its loop's check too: a chain
revert leaves each task behind the one before it, and none of that lifts a hold
only the user can.

The three options that dispatch past the seam's commands are the ones that have
no command: adding a resolver task is a plan edit, and a blocked run's two answers
replay a parked start. Each keeps the operation behind its button, with that
operation's own refusals, and leaves the timeline as it does today.

## What is left out

Every `StartWait` is decided in one table, `ONLY_A_PERSON`, so a new one fails
to compile until someone decides it.

| Left out | Why |
|---|---|
| A usage-limit pause with `resumeAt` | It resumes by itself at the reset. |
| A conflict repair that will start by itself | It waits for a slot, a planner's turn or a usage limit ([ADR-0015](../isolation/0015-conflict-repair.md)). A Stop or a reload leaves its conflict waiting, which is listed. |
| A conflict with a resolver out to it | The resolver moves it on, or is listed in its place. |
| A loop's check between rounds whose loop goes on | Something will run it again: a scheduler, the one a usage-limit reset gives back, or its carried loop ([ADR-0045](0045-a-check-repeats-with-its-fix-until-it-passes.md) L3, L5). After a Stop or a reload nothing will, so it is listed as `failed`, and its row says so. |
| A loop's check stopped by a body task that failed or is blocked | Retrying that task lets the loop go on, so the task is listed and the check would be the same wait twice. A check stopped by a skipped body task alone is listed as `failed`: nothing else speaks for it. |
| A blocked task | Its cause is listed, once ([ADR-0034](0034-a-failed-task-blocks-only-its-dependents.md)). |
| `dependencies`, `queued` | Work still at work, which ends by itself, or a cause listed in its place. |
| `loop-check` | A body task runs only if its check fails. |
| `usage-limit`, `start-hold`, `merging`, `completing`, `resolver` | Each clears by itself, or its cause is listed. |
| `started`, `repeating` | A task under way, or a check between rounds, listed above by whether anything will run it. |
| A task with any of these besides a wait of its own | Its turn comes once they clear: it waits on a person only then. |
| A merge gate while Ordewell merges at gates by itself | The scheduler merges it, unless a merge stopped, which lists it again. |
| Landed work while anything could still land more | Merge all is offered at a gate or once nothing moves. |
| Landed work the run's close merges by itself | The run says it has ended just before it closes, and nobody has to answer that merge. A Stop, or a merge that stopped, leaves the work to the user, and it is listed. |
| A planner approval | It times out by itself into a denial, and belongs to the conversation the user is told of it in, not to a task. |
| A planner paused on its context or its usage limit | A wait of the conversation, shown there, with no task and no command at the seam. |
| The plan's review | Nothing records that one is waiting: `review_needed` is an event, and a plan nobody executed is no run waiting. |

A supervisor at Act does not take anything off the list. Whether it will act
is a model's choice, and the user may still answer first; the seam refuses
whichever answer comes second.

## What an id names

An attempt can wait many times: every turn that ends without `task_complete`
waits for input, and a runner can reach several checkpoints. So the attempt is
not enough to name a wait, and each kind says what tells it from the next. A
task's id is `kind:task:attempt`, then whatever of these it has.

| Kind | Told from the next wait by |
|---|---|
| `approval` | The request's own id, unique to it. |
| `merge-gate` | A digest of the attempts it waits to have merged, as a `merge-all`'s id: a Force start confirmed past one task's work says nothing of another's. |
| Any other kind on a task | `Task.waitsEnded`, when it is not 0. |
| `merge-all` | The run, and a digest of the attempts it would merge, in place of a task and attempt. |
| `blocked-run` | Which of the session's starts a dirty checkout turned away, in place of a task and attempt: a replay can be turned away again in the same run. In memory, as the parked start is. |

`Task.waitsEnded` counts the waits ended since the task's latest attempt
started: `PlanStore` adds one as a task moves off any status but `in_progress`,
and as its approval is withdrawn, since it then waits on something the user has
not seen. A new attempt starts it over, the number having moved on. The first
wait of an attempt adds nothing to its id. A hidden wait that comes back, a
usage-limit pause whose resume was cancelled, was never left, and keeps its id.

Saved with the plan, the count holds an id across a reload, so a surface that
held one can still answer it and a stale one is still refused. A `no-prompt`
task keeps its id through an edit that fills its prompt and one that empties it
again: no run moved, and the wait's only answer means the same in both.

## What a reload keeps

**A load changes no outcome, so what waits on a person is still listed when they
come back to a host that restarted.** The list survives a reload as the waits it
reads do.

- **A failed task stays failed.** `PlanStore.load` leaves it as it was saved, with
  its verdict and report. Its dependents stay blocked by the derived rule
  ([ADR-0034](0034-a-failed-task-blocks-only-its-dependents.md)), and it is
  listed with its usual options. A loop's check keeps its round, so one out of
  rounds is listed as `out-of-rounds`, and one between rounds is read as it was
  before the load
  ([ADR-0045](0045-a-check-repeats-with-its-fix-until-it-passes.md) L5), and
  listed, since no run comes back to run it.
- **The fresh chance is given where the user asks for it.** A retry starts that
  one task: a load brings no run back, so what its pass unblocks waits for
  Execute. Execute readies every failed task (`PlanStore.resetForRun`), a loop's
  failed check with its rounds started over (L7), and leaves one between rounds
  for its body to run first. With tasks started by hand at work it does the same
  as it takes them into the plan's run (`PlanStore.readyFailed`), and so with a
  usage limit holding them, which takes no resume back: that run goes on at the
  reset ([ADR-0018](../runners/0018-structured-runner-transport.md) U1). A
  scheduled run keeps its failures, with work live or not, one waiting on a person
  or held by a usage limit included: a retry continues them
  ([ADR-0034](0034-a-failed-task-blocks-only-its-dependents.md)), and Execute only
  approves what waits in it. Neither a planner's `run_plan` nor autorun asks: a
  join leaves a failure as it is, and autorun's run leaves what failed in the
  reply it follows
  ([ADR-0030](0030-global-run-settings.md)). An edit outside a run asks for neither,
  and leaves a failure and a wait as they are (`resetForRun({ edited: true })`).
  The one exception is a task an edit made manual, by the planner or by hand, in a
  run or not, failed or waiting on the user: it has nothing to retry, so it is the
  manual task it now is (`releaseMadeManual`, as the edit lands), and a pause it
  was under holds nothing. A runner still at a question keeps its wait while it
  lives, to be answered; its end releases what it left, and so does a load, where
  both saved forms are read. A usage limit that ends that runner holds nothing:
  no resume is promised, and the rest of the run goes on.
- **A task running when the host died is failed.** Nothing runs when a plan comes
  off disk, so `failInterruptedTasks` fails a task saved in progress where both
  saved forms are read, `loadSession` and `loadState`. Its reason says it was
  interrupted when Ordewell stopped, it is listed as `failed`, and a retry or
  Execute starts it again. Its verdict reports nothing, as a runner's that exited
  without reporting, so it starts no round (L2). Its attempts and logs stay.
- **The other saved waits.** A checkpoint or a task waiting for input is saved,
  and is listed with no runner behind it. A usage-limit pause loses its saved
  resume on load
  ([ADR-0044](../planner/0044-the-planners-usage-limit-waits-and-resends.md)), so
  it is listed. A loop's rounds and the merge the run owes are saved. A reverted
  task's hold is saved on the task, so it is listed after a load. A task saved
  waiting for a conflict repair loads waiting on its conflict
  (`settleOwedRepairs`): nothing starts that repair now, and Execute still does.
- **What stays in memory, which #31 decides.** Other holds, runner approvals and
  a blocked run's parked start go with the process. Tasks not started are listed
  only in an open run, which a load does not bring back. Resuming an interrupted
  task, rather than starting it again, is #31 as well.
- **The notify command is told nothing of it.** What waits at a load counts as
  already told, a failed or interrupted task included, so a restart sends no
  storm: see [Telling a person](#telling-a-person).

## Reaching a surface

The list travels as run state does: whole on every `status_update`, so a client
learns of a change as it learns of a task's, and in `RunView.escalations`, so
`run_snapshot` and the session routes carry it to a client that joins late. The
daemon adds `GET /api/plans/:id/escalations`, and
`POST /api/plans/:id/escalations/answer` beside `execute-command`
([ADR-0006](../surfaces/0006-tui-pure-core-thin-driver.md) S3), answering in the
same shapes.

## Telling a person

**The user may name one command, and Ordewell runs it once for each new
escalation.** It covers a desktop notification, a chat message or a webhook,
whichever they want, and core sends nothing out by itself. A surface answers the
list; this reaches someone who is not looking at one.

- **One optional setting, an argument vector.** `ORDEWELL_NOTIFY_COMMAND`, a
  JSON array with the program first, or VS Code's `ordewell.notifyCommand`,
  which wins. With neither, nothing runs. It is read as each new escalation
  appears. A plain string is refused with a warning, not split: splitting one
  is a shell's job, and there is none.
- **Nothing Ordewell reads for a workspace sets it.** A repository that could
  set it through Ordewell could run a command on the user's machine (#92). The
  variable is in `SETTINGS_ENV_REFUSED`, as the effect allowlist is
  ([ADR-0035](0035-effects-are-consented-and-recorded.md)), so a workspace's
  `.ordewell/env`, what direnv exports for its runners and a settings update are
  all refused it, and VS Code's setting is application-scoped and read from the
  user's value alone.
- **The environment Ordewell started in is the exception, and is read as the
  user's.** `ORDEWELL_NOTIFY_COMMAND` comes from `process.env`, as
  `ORDEWELL_EFFECT_ALLOW` does, so an `.envrc` that direnv has exported into the
  shell Ordewell is started from can set it, and that value cannot be told from
  the user's own. It adds no authority: `direnv allow` is already consent to run
  that file's code as the user, every time they enter the directory.
- **No shell, and the escalation in the environment only.** Part of an
  escalation's text comes from runners, so it is untrusted. The command runs as
  written, and the escalation reaches it in `ORDEWELL_ESCALATION_ID`, `_KIND`,
  `_TASK` (the task's ref and title, empty for a wait of the run itself) and
  `_REASON`, each always set, with control and format characters replaced and
  its length capped. Nothing is interpolated into the command. It runs in the
  user's home with the host's environment, never the workspace's. A shell the
  user writes into the command is theirs to quote.
- **Once per id, remembered in memory.** `EscalationNotifier`
  (`packages/core/src/services/escalationNotifier.ts`) keeps the ids it has
  seen, for the plan the Session holds and no longer. When a plan is adopted,
  what already waits counts as told, so a restart sends nothing it may have sent
  before; what appears after that is new. While a plan is on its way out nothing
  is told: a run stopped by leaving its session can raise a wait nobody is there
  for. An id seen while no command was set counts as told too.
- **It can never affect a run.** It is started and left, with a short time limit
  that stops it and what it started. Two run at a time and up to 32 wait in
  order, so a stop that lists many tasks starts no storm of processes. Past
  that an id is dropped, logged once per Session: it counts as told, and the
  list still holds it. A failure is logged once per Session and otherwise
  ignored, and it is not retried. It leads a process group of its own but is
  kept out of the runner groups a session lease records
  ([ADR-0049](../isolation/0049-a-session-has-one-live-host.md)), which would hold
  the session against another host while a hung command lived. It does not keep
  a host from exiting, and it does not outlive one: the limit's timer goes with
  the host, so the host's teardown (`onHostTeardown`) stops a command still
  running on an exit or a signal, as it stops the runner groups.
- **It runs where the run runs.** The notifier reads the list as each status
  update goes out, so after what the update says is saved, and it needs no
  surface attached. Its seam is `SessionDeps.runNotifyCommand`, wired in
  `createSession`.

## Testing decisions

Three seams, each through the public interface. `escalations` with the real
start rule over a table of states against the expected ids, kinds and option
ids, every case left out among them (`escalations.test.ts`).
`answerEscalation` with a host, one row per option against the command it
reaches, as the user (`escalations.answer.test.ts`). A real Session driving a
fake runner to each wait and answering it, which also folds the stream through
`reduceRun` and holds it to what the Session derives
(`sessionEscalations.test.ts`), and each way a wait can come back under the
same task (`sessionEscalations.reuse.adversarial.test.ts`). What a reload keeps
is held to a real run's plan through a real save and load into a new Session:
failed tasks, a loop's checks and interrupted tasks, answered and executed
afterwards (`sessionReload.test.ts`).

The notify command is tested at the notifier, with real processes for what only
a process can show: the text staying out of the command line, the limit stopping
a hung command, a host ending with one still running
(`escalationNotifier.test.ts`). A real Session drives it with a
fake command through what a run leaves waiting, a reload, a plan left, and a
command that fails, throws or never answers
(`sessionEscalationNotify.test.ts`). A workspace's value is refused where each
reader takes it (`workspaceEnv.test.ts`, `VsCodeConfig.test.ts`).

## Out of scope

- Surfaces, which build on this.
- Escalations raised by a supervisor, or by mandate rules (#23). Neither can be
  derived from what a run holds, so they would need a stored form, decided then.

## Considered options

- **A stored `Escalation` record, as #30 first proposed.** Rejected for the
  reason ADR-0034 rejected a stored `blocked`: it has to be set and cleared on
  every path, and the two would drift from the waits they describe.
- **A deadline or a default answer.** Rejected: answering for the user on a
  timer is a consent decision, and belongs to the mandate (#23).
- **An `answer_escalation` command at the seam.** Rejected: a name any actor can
  ask for, needing its own refusal for each, and a second timeline record beside
  the command it dispatches to.
- **A planner tool to read or answer the list.** Rejected: it adds a route to
  the user's answers for nothing, since the user is there, and the supervisor
  already has tools for what it may do.
- **Taking the choice of an option as the user's yes.** Rejected: Mark complete
  needs an explicit yes a call cannot imply (ADR-0029), and a list is exactly
  where one keystroke would otherwise land unchecked work. `confirmed` is the
  one thing the call adds to `answerEscalation(id, option, note?)` as first
  drawn. Force start past a gate, where a surface asks and the seam does not,
  is held to the same question.
- **The run's id alone as a `merge-all`'s id.** Dropped: a run that holds a record
  keeps its id past a Merge all, so work landing later would be told as the first
  wait, and the notify command would stay silent for it.
- **The task ids themselves in a `merge-all`'s id.** Rejected: the id is capped
  where the notify command reads it, and a long run's would not fit.
- **The attempt alone in a task's id.** Dropped: an attempt waits many times, so
  a second checkpoint took the first one's id, heard the first one's stale
  answer, and the notify command stayed silent for it.
- **Counting waits in the notifier.** Rejected: it remembers in memory, so after
  a reload a stale id would be answered as a live one, and a surface that asks
  for the list would see other ids than the notifier told.
- **The run's end merged before the status that says it ended.** Rejected: the
  surfaces would not hear the run was over for as long as git took, and a Mark
  complete or a cancel closing a run has the same gap with no such status to
  move. `TaskOrchestrator.mergesAtClose` answers for all of them, and is what
  decides the merge.
- **Leaving Merge all out while the setting is on.** Rejected: a Stop leaves
  landed work the run will not merge, with the setting still on, and that wait
  is real.
- **Listing every blocked dependent.** Rejected: one failure reads as many
  decisions, and every one of them has the same answer.
- **One escalation for all the tasks at a merge gate.** Rejected: Force start is
  answered task by task, and a gate names different unmerged work per task. A
  Merge all from one makes the others stale, which the id says.
- **A message of its own for a change of the list.** Rejected: a status update
  already goes out on each change the list reads, and says everything about
  what it covers.
- **A built-in webhook.** Rejected: it makes core send data out with no egress
  guard yet (#88, #90). A command the user wrote is theirs to point anywhere.
- **A built-in desktop notifier.** Rejected: per-platform code that the command
  already covers.
- **The command from a repository or a workspace's environment files.**
  Rejected: that lets a repository run a command on the user's machine (#92).
- **Reading the command from a source only the user owns, not `process.env`.**
  Rejected: it would close the `.envrc` exception, but a repository the user
  allowed direnv for can already run anything as them, so nothing would be
  protected, and the command would be read unlike the effect allowlist beside it.
- **A shell string, or the text as placeholders in the command.** Rejected: the
  text is partly a runner's, and either would turn it into something run.
- **The command in `settings.json`, as the run settings are
  ([ADR-0030](0030-global-run-settings.md)).** Rejected: it sits with the other
  values a repository must never set, under the refusal that already covers
  them, and in the settings page VS Code users set those in. It is no run
  setting: nothing about a run reads it.
- **A process that watches the host and stops the command, or the command's own
  group in the lease.** Rejected: a watcher is a second process for every
  notification, and needs a Node to run on in a VS Code host; the lease would
  hold a session by a command that has no say in a run. A host killed outright
  is the one case either would cover.
- **Saving the ids told with the plan.** Rejected: counting what waits on load as
  told already stops a storm after a restart, without a stored form of something
  that is otherwise derived.
- **Running it on a surface.** Rejected: it would run only with one attached,
  and the person it is for has walked away from it.
- **A load giving a failed task a fresh chance as pending.** The design until
  2026-10-31. Dropped: a restart took the failure out of the list, unblocked its
  dependents and left nothing to say what went wrong, so the person who most
  needed the inbox lost it. Execute already gave that chance, and it was only a
  second one the user had not asked for. An edit needed a `keepFailed` option on
  the load to escape it.
- **A task saved in progress going back to pending.** The design until
  2026-10-31. Dropped for the same reason: outside an open run a pending task is
  not listed, so work that stopped halfway read as work never started.
- **A status or field of its own for an interrupted task.** Rejected: a failed
  task is already listed, blocks its dependents and is retried, and a new status
  would have to teach every surface and rule the same things. The reason says
  what happened.

## Consequences

- Anything that adds a wait adds a row here and a case in the derivation, or the
  run has a wait the inbox does not show. A new `StartWait` is caught at compile
  time; a new way for a run to wait outside the start rule is not.
- The list is derived on every status update, reading each waiting task's
  attempt; a script's after a reload comes off its log directory.
- An option can be refused after it is offered, when the run moves between the
  list and the answer. That is the same refusal the card meets.
- A stale id is refused, however close the new wait is to the old one: a client
  reads the list again rather than retrying.
- Each new id runs the command once, so a stop that lists many tasks runs it many
  times, two at a time, and one past the queue's bound is told only by the list.
  A command that hangs holds its turn until the limit.
- A host killed outright runs no teardown, so a command it left running ends only
  when it ends by itself. It holds nothing against another host.
- A wait that appeared just before a host died is counted as told on load, though
  its command may never have run, and a task the host died running is too, so
  no command says it stopped. A restart staying quiet is worth that miss.
- A saved session read without being adopted, for a host that is not the one
  running it, shows that run's tasks as interrupted: the read cannot tell a dead
  host from a live one, and only a claim of the lease can
  ([ADR-0049](../isolation/0049-a-session-has-one-live-host.md)). A claim is
  refused while the other host lives, so nothing is saved from such a read.
- After a restart a failed task's dependents wait for the user's answer, and a
  retry starts only that task: Execute is what carries on with the rest.

## History

- 2026-10-30 — accepted.
- 2026-10-30 — a reverted task is listed outside an open run (ADR-0054).
- 2026-10-30 — an optional notify command, run once for each new escalation (#30).
- 2026-10-30 — a `merge-all`'s id names the attempts it would merge, and a merge the run's close makes itself is left out (#30).
- 2026-10-31 — an id names the wait, not the attempt; a user task on hold offers Mark complete; the Decision names the `.envrc` exception (#30).
- 2026-10-31 — a load keeps a failed task failed, and a task saved in progress loads failed as interrupted; the fresh chance is Execute's alone (#30).
- 2026-10-31 — the notify command runs through a bounded queue, two at a time, and a host's teardown stops one still running (#30).
- 2026-10-31 — a repair that will start by itself is left out, a conflict with a resolver nothing will start offers to start it, and a load lists what waited for a repair (ADR-0015).
- 2026-10-31 — a reverted task is listed behind its dependencies, with what the seam takes then (ADR-0054).
- 2026-10-31 — a check between rounds nothing will run is listed, a carried loop is an open run for its own tasks, Execute gives its fresh chance to hand-started work it takes in, and an edit keeps every wait and frees a failed task it made manual (#30).
- 2026-10-31 — a task an edit made manual is released from a wait with no runner behind it too, at the edit or at a load, and a check whose dependency holds its next round names it rather than offering a start that refuses.
- 2026-10-31 — a stranded check behind a dependency offers no Continue either, and the seam refuses one; a task made manual is released when the runner it kept its wait for ends; a reverted task is listed behind its loop's check too.
- 2026-10-31 — an ended attempt's entry names what holds any start of its task and offers no Retry or Continue the seam would refuse; a usage limit that ends a task made manual holds nothing.
- 2026-10-31 — a task an edit made manual is released as a direct edit lands too; a scheduled or held run keeps its failures and pauses through Execute with nothing live; a conflict, changed files and a pause with no session offer no Retry the seam would refuse, and a seam Continue is refused behind a loop's undecided check.
