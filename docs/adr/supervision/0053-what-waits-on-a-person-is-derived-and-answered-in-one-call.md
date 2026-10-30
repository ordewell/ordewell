---
status: accepted
---

# 0053 — What waits on a person is derived, listed once and answered in one call

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
  clears one: whatever ends a wait ends its escalation.
- **The list holds only what will not move without a person.** What resolves
  itself is left out, and a task whose cause is listed is left out in favour of
  that cause, listed once. The tables below are the exact kinds.
- **An escalation says what is waiting and what may be answered.** A stable id
  built from its kind, task, attempt and approval id, or for a `merge-all` from
  the run and a digest of the attempts it would merge, so that a later wait is
  another escalation and a stale answer can be told from a live one; its kind; the task it belongs to, which is the link to the evidence; a reason
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
| `conflict` | `awaiting_user`, `conflict` | Add a resolver task, Retry, Skip, Mark complete | `Session.resolveConflictAsTask`, then as above |
| `files-changed` | `awaiting_user`, `files-changed` | Retry, Skip, Mark complete | as above |
| `usage-limit` | `awaiting_user`, `usage-limit`, no `resumeAt` | Resume now, or Retry with no session to resume; Skip, Mark complete | `retry_task`, as above |
| `failed` | `failed`, no loop going on | Retry, Continue, Skip, Mark complete | as above |
| `out-of-rounds` | A loop's check, `outOfRounds` | Retry, Continue, Skip, Mark complete | as above; a retry starts its rounds over ([ADR-0045](0045-a-check-repeats-with-its-fix-until-it-passes.md)) |
| `merge-gate` | Not started, held by nothing but its gate | Merge all; Force start, or Mark complete for a user task | `merge_all`, `force_start`, `mark_complete` |
| `on-hold` | Not started, held by nothing but its hold | Retry, Force start | `retry_task`, `force_start` |
| `unapproved` | Not started, nothing else holds it, added since the plan was approved ([ADR-0035](0035-effects-are-consented-and-recorded.md)) | Start | `run_task` |
| `no-prompt` | Not started, nothing to run | Skip | `skip_task` |
| `by-hand` | A user task nothing else holds | Mark complete | `mark_complete` |
| `merge-all` | Landed work, nothing moving and no gate listed | Merge all | `merge_all` |
| `blocked-run` | A run a dirty checkout turned away | Stash and continue, Run without isolation | `Session.continueWithStash`, `continueWithoutIsolation` |

`merge-gate`, `on-hold`, `unapproved`, `no-prompt` and `by-hand` are listed only
in an open run: one scheduling, held, or ended on a failure a retry continues.
Outside one nothing was going to start them, so nothing is late. A reverted task
([ADR-0054](../isolation/0054-a-landed-task-reverts-on-the-integration-branch-before-merge-all.md))
is the exception: it is `on-hold` in any run, because the user took it back,
usually after the last task landed, and whether it runs again is theirs to say.

The three options that dispatch past the seam's commands are the ones that have
no command: a resolver task is a plan edit, and a blocked run's two answers
replay a parked start. Each keeps the operation behind its button, with that
operation's own refusals, and leaves the timeline as it does today.

## What is left out

Every `StartWait` is decided in one table, `ONLY_A_PERSON`, so a new one fails
to compile until someone decides it.

| Left out | Why |
|---|---|
| A usage-limit pause with `resumeAt` | It resumes by itself at the reset. |
| A loop's check between rounds whose loop goes on | The loop runs it again ([ADR-0045](0045-a-check-repeats-with-its-fix-until-it-passes.md) L3). |
| A loop's check stopped by a body task that failed or is blocked | Retrying that task lets the loop go on, so the task is listed and the check would be the same wait twice. A check stopped by a skipped body task alone is listed as `failed`: nothing else speaks for it. |
| A blocked task | Its cause is listed, once ([ADR-0034](0034-a-failed-task-blocks-only-its-dependents.md)). |
| `dependencies`, `queued` | Work still at work, which ends by itself, or a cause listed in its place. |
| `loop-check` | A body task runs only if its check fails. |
| `usage-limit`, `start-hold`, `merging`, `completing` | Each clears by itself. |
| `started`, `repeating` | A task under way, or a check its loop starts again. |
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

## What a reload keeps

The list survives a reload exactly as the waits it reads do, and is not meant
to do better. A checkpoint or a task waiting for input is saved, and is listed
with no runner behind it. A usage-limit pause loses its saved resume on load
([ADR-0044](../planner/0044-the-planners-usage-limit-waits-and-resends.md)), so
it is listed. A loop's rounds and the merge the run owes are
saved. A failed task is not: a load gives it a fresh chance as pending
(`PlanStore.load`), and its dependents are unblocked with it. Holds, runner
approvals and a blocked run's parked start are in memory and go with the
process, and tasks not started are listed only in an open run, which a load
does not bring back. A reverted task's hold is the exception: it is saved on the
task, so it is listed after a load.

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
- **User-level only.** A repository that could set it could run a command on
  the user's machine (#92). The variable is in `SETTINGS_ENV_REFUSED`, as the
  effect allowlist is ([ADR-0035](0035-effects-are-consented-and-recorded.md)),
  so a workspace's environment files and a settings update are both refused
  it, and VS Code's setting is application-scoped and read from the user's value
  alone.
- **No shell, and the escalation in the environment only.** Part of an
  escalation's text comes from runners, so it is untrusted. The command runs as
  written, and the escalation reaches it in `ORDEWELL_ESCALATION_ID`, `_KIND`,
  `_TASK` (the task's ref and title, empty for a wait of the run itself) and
  `_REASON`, each always set, with control and format characters replaced and
  its length capped. Nothing is interpolated into the command. It runs in the
  user's home with the host's environment, never the workspace's: a repository
  chooses nothing about it. A shell the user writes into the command is theirs
  to quote.
- **Once per id, remembered in memory.** `EscalationNotifier`
  (`packages/core/src/services/escalationNotifier.ts`) keeps the ids it has
  seen, for the plan the Session holds and no longer. When a plan is adopted,
  what already waits counts as told, so a restart sends nothing it may have sent
  before; what appears after that is new. While a plan is on its way out nothing
  is told: a run stopped by leaving its session can raise a wait nobody is there
  for. An id seen while no command was set counts as told too.
- **It can never affect a run.** It is started and left, with a short time limit
  that stops it and what it started. A failure is logged once per Session and
  otherwise ignored, and it is not retried. It leads a process group of its own
  but is kept out of the runner groups a session lease records
  ([ADR-0049](../isolation/0049-a-session-has-one-live-host.md)), which would hold
  the session against another host while a hung command lived. It does not keep
  a host from exiting.
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
(`sessionEscalations.test.ts`).

The notify command is tested at the notifier, with real processes for what only
a process can show: the text staying out of the command line, the limit stopping
a hung command (`escalationNotifier.test.ts`). A real Session drives it with a
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
- **A shell string, or the text as placeholders in the command.** Rejected: the
  text is partly a runner's, and either would turn it into something run.
- **The command in `settings.json`, as the run settings are
  ([ADR-0030](0030-global-run-settings.md)).** Rejected: it sits with the other
  values a repository must never set, under the refusal that already covers
  them, and in the settings page VS Code users set those in. It is no run
  setting: nothing about a run reads it.
- **Saving the ids told with the plan.** Rejected: counting what waits on load as
  told already stops a storm after a restart, without a stored form of something
  that is otherwise derived.
- **Running it on a surface.** Rejected: it would run only with one attached,
  and the person it is for has walked away from it.

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
- Each new id runs one process, so a stop that lists many tasks at once runs the
  command that many times.
- A wait that appeared just before a host died is counted as told on load, though
  its command may never have run. A restart staying quiet is worth that miss.
- The variable is read from the environment Ordewell started in, like the effect
  allowlist: what direnv has already exported into that shell cannot be told
  from the user's own. The refusal covers what Ordewell itself reads for a
  workspace.

## History

- 2026-10-30 — accepted.
- 2026-10-30 — a reverted task is listed outside an open run (ADR-0054).
- 2026-10-30 — an optional notify command, run once for each new escalation (#30).
- 2026-10-30 — a `merge-all`'s id names the attempts it would merge, and a merge the run's close makes itself is left out (#30).
