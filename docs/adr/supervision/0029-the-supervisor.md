---
status: accepted
amends: ["0009", "0013", "0020", "0022"]
---

# 0029 — The supervisor: levels, live planner turns, execution tools and auto-merge

**Amends:** ADR-0009 and ADR-0022 — the planner gains execution tools, a further
explicit exception to harness planners being read-only; ADR-0013 — "never
merged for the user" now has two exits the user opts into; ADR-0020 — the
"merge at gates automatically" setting it left to the autonomy work.

## Problem

Once a run starts, the planner only wakes when the user writes to it, and what
the user writes mid-run waits in a queue. `Session.processQueuedMessages` hands
that queue to the planner only when the scheduler parks behind it with no
attempt active (`TaskOrchestrator.tick`), so "stop task 4" or "why did task 5
fail?" sent during a long task is answered after it ends. Nobody but the user
notices a stuck, failing or off-track task, and only the user can start, stop,
retry or answer one.

Four issues approach this from different sides:

- **#27** decided the first stage: the planner that wrote the plan stays in the
  conversation, wakes on events that need attention, reads, and suggests. Its
  plan edits are refused in those turns.
- **#91** asks for planner tools to run and stop the plan or a task, behind one
  core command seam, before any supervisor exists.
- **#29** wants the supervisor to start, stop, retry and replan under limits,
  with guards against loops.
- **#23** is the mandate: grants, limits, inheritance, escalation. It is an RFC
  and the largest trust decision in the roadmap.

Waiting for the mandate before any of the rest ships leaves the run unwatched
for the whole of that design. Shipping each issue on its own gives three
entry points to the scheduler and three consent rules. This ADR settles the
part that does not need the mandate, in a shape the mandate can take over.

ADR-0013 says Ordewell never merges for the user; ADR-0020 kept that and left
merging at gates automatically to this work. #84 adds a pause that ends on its
own, the usage-limit reset, which a supervisor should hear about.

## Decision

**A run has a supervisor level: Off, Watch or Act. The supervisor is the
planner conversation that wrote the plan, taking turns while the run goes on.
What it may do is checked in core at one command seam, never only in its
prompt, and the run never depends on it.**

### Supervisor levels

- **Off** — the planner speaks when the user writes to it or a task returns
  a report it asked for (ADR-0037 R2).
- **Watch** — #27 as decided. The supervisor wakes on attention events, reads
  everything, and writes to the user. Execution tools and plan edits are
  refused in its wake-up turns, with a note telling it to suggest the action
  to the user instead.
- **Act** — Watch, and in wake-up turns it may also run, stop, retry and skip
  tasks, message runners, deny approvals, edit the plan and merge, inside the
  loop guards below.

The level is a global user setting, Watch by default, set in `/settings` (or
with `ordewell supervisor` headless)
([ADR-0030](0030-global-run-settings.md)). A change applies at once, in either
direction, to the session it is made in, and to other sessions from their next
run. A tripped wake-up-rate guard or a failed supervisor also lowers the level
for the rest of the run, with a notice; the user's change lifts that lowering,
the guards' memory kept. A lowering takes effect at once, in the wake-up turn
under way too: what that turn calls or edits next is checked against the lowered
level.

The levels are a slim precursor of the mandate (#23). Watch is its `observe`
grant; Act later becomes the bundle of `control` and `replan` (and the merge
grant #23's comment proposes). Grants given separately, limits, inheritance,
delegation and revocation stay with #23. Because the check already lives at the
seam, the mandate replaces the level check there and nothing above it moves.

### Same conversation, its own message kind

The supervisor is the planner conversation that wrote the plan (#27). It
knows why each task exists, and its notes appear in the chat the user already
has. Compaction keeps a long run bounded. Supervisor messages carry their own
`kind` in `conversationHistory`, so every surface can tell them from a reply
to the user and style them apart. There is no second model, no second
transcript, no second process.

### What wakes it

A wake-up turn is opened by a batch from `WakePolicy`
(`packages/core/src/services/WakePolicy.ts`), the pure, tested debounce #59
built. The attention events are:

- a task failed — a loop's check that fails a round with rounds left has not,
  and wakes it once, when its loop runs out of rounds
  ([ADR-0045](0045-a-check-repeats-with-its-fix-until-it-passes.md));
- a task is waiting for input;
- a task is waiting for approval;
- a task went idle;
- a landing conflict (ADR-0015);
- an automatic Merge all at a merge gate that stopped;
- the run finished;
- **new:** a task paused on a usage limit, with the time it resumes (#84).
  Every task one runner's limit pauses is one entry.

An ordinary pass never wakes it. Passes ride along as "since last time: tasks
2, 3, 4 passed". A research task's end, passed, failed or blocked, is an
attention event at every level, Off included: the run update carries its
handoff or its reason. It uses the report path shared with `run_script`, and
acts with the authority of the turn that started it. A report turn may start
further research, whose report opens the next turn with no user message in
between: the chain is deliberately not bounded per user message
([ADR-0037](0037-research-tasks-wake-the-planner.md), R4). What bounds it is
the planner's judgement, the run's Parallel limit for concurrency, `mayReport`
after two consecutive failed automatic turns, and the user's Stop. Events
close together — within five seconds of the first — are merged into one
wake-up; the run's end is delivered at once. The policy is code, not prompt
text, so when the supervisor speaks is testable without a model.

A due batch reaches the conversation as a **run update**: one line per event,
naming its task and a short detail — the verdict's reason and the tasks the
failure blocks as the update goes out
([ADR-0034](0034-a-failed-task-blocks-only-its-dependents.md)), the question,
the request, the resume time — and the passes since the last one; the run's end
counts what completed, failed and is blocked. A finished task's handoff is
rendered as its summary and whole findings within 4,000 characters, including
omission and pull pointers; artifacts sit outside that text budget. The long
report stays in the attempt log, read with `task_output`
([ADR-0047](0047-structured-task-handoffs.md)). Never a log: the
supervisor reads more with `task_output` and `task_diff`. The run update is
the supervisor's input (`kind: 'wake_up'`), and what it says in the turn is
its note (`kind: 'supervisor'`). The rules of its level are told to it after
the run update, each turn, and never saved.

### Live planner turns replace the between-batches queue

The pending plan edit queue is removed. **A user message during a run and a
wake-up are both planner turns taken at once, one at a time, while running
tasks carry on.** A planner turn already holds the conversation one at a time
(`PlannerTurn`); a wake-up that arrives during a user's turn waits for it, and
a user message during a wake-up turn is held as a queued prompt.

- **The scheduler holds new starts for the duration of a turn.** Running tasks
  are untouched; nothing new is spawned until the turn ends, a force start
  queued behind its dependencies included, though one finishes mid-turn. The
  hold is always released when the turn ends — settled, stopped, failed or
  timed out — so a planner that crashes cannot freeze the run, and its release
  looks again at what was queued, with or without a run. This is what keeps a
  turn's plan edits from racing a task that would otherwise start mid-turn.
- **Plan edits in a turn apply at once to tasks not yet started.** An edit aimed
  at a running or finished task is refused with a note the model can act on:
  "task 4 is running; stop it first, or retry it after". That is the planner
  side of ADR-0012's direct-versus-planner rule, now applied mid-run instead of
  deferred. A batch of edits still applies whole or not at all, so one refused
  op refuses its batch; a whole new plan is refused while tasks run, since only
  edits can leave running work as it is.
- **Inputs that arrive during a turn are taken together by the next one**, in
  order, through one entry (`PlanTurns.enqueue`) that names who the input is
  from. The hold also lapses after five minutes, after which the turn goes on
  without holding the run: an edit is checked against the tasks as they stand
  when it applies, so a task that started meanwhile refuses it.
- **Pending turns are persisted on the plan**, so a daemon restart neither
  loses a user's message nor a wake-up batch not yet delivered.

### Reads

- **`task_output` reads any attempt's saved task log**, not only the live tail:
  filtered by event kind and paged, so a supervisor can read why attempt 1
  failed while attempt 2 runs.
- **`task_diff`** is new: the attempt's changed files first, then one file's
  diff on request. A supervisor deciding whether to retry needs what the task
  did, not only what it said.
- **In a wake-up turn the per-message read cap is replaced by a per-turn read
  budget**, a global setting of 12 reads unless changed in `/settings`
  (`ordewell supervisor reads <n>` headless)
  ([ADR-0030](0030-global-run-settings.md)). The user's
  turns keep today's caps
  (`MAX_TASK_QUERIES`, ADR-0022 P3). A wake-up has no user message to bound it,
  and a supervisor reading three things before it must land would miss the one
  that explains a failure.

### Execution tools, through one command seam

All of these reach the scheduler through **one core command seam**, as #91
asked; no tool calls into `TaskOrchestrator` directly. The API planner reaches
the same seam through its own tool definitions.

| tool | does |
|---|---|
| `run_plan` | start the approved plan |
| `run_task` | start one ready task; refuses one whose dependencies or merge gate are not met, and says which |
| `stop_task` | stop one task, denying its open approvals as stop does |
| `stop_run` | stop every running task, keep the plan |
| `retry_task` | retry, continuing the saved session (ADR-0018, K1) or fresh; an amended prompt goes through `edit_plan` first, so the plan holds what runs |
| `message_task` | send a task message (ADR-0023) |
| `answer_approval` | deny a runner approval with a note, or escalate it to the user — never allow |
| `answer_checkpoint` | approve the checkpoint a task waits at, or reject it with a required reason the runner acts on. In Act wake-up turns only |
| `merge_all` | Merge all, in Act wake-up turns only |
| `skip_task` | end a task that failed, is blocked or is waiting for input as *skipped*, with a required reason; nothing of it lands, and its dependents go ahead, told the reason. In Act wake-up turns only |
| `run_script` | add a script task ([ADR-0035](0035-effects-are-consented-and-recorded.md)) and start it in one step; answers with its verdict and the tail of its output, or "still running" after a minute |

A planner's edit is in the plan as its `edit_plan` call answers
([ADR-0022](../runners/0022-ordewell-mcp-server.md), P2), so a start the turn
asks for after editing that task in the same reply goes through the seam at
once, against the plan as edited: the plan holds what runs, and the edit
counts as the change a retry after a failure needs. A task the edit added is
named by its id, its reference, its title or the handle the edit gave it. The
start is judged and consented to as any start is — a task the edit added is
approved only as the rules above say, and the user is asked on the card in
Guarded — and what it hands the run waits for the turn's start hold like any
start of the scheduler's. Nothing is queued behind an edit, so nothing is
replayed when the reply ends. In a wake-up
turn at Act the supervisor edits task by task; a whole new plan is refused,
since only edits let the user follow what changed.

**A Stop withdraws every start asked for before it.** A start is admitted
when it is asked for, and counts as live work until it claims its task:
waiting on its approval card, or still opening its run. The user's Stop — `stop_run` from any surface, or the Session's own stop —
stops these too, so it is never refused, or answered "stopped", while one of
them could still start. None of them starts afterwards: each is kept in the
timeline as refused, and said as not done, "stopped before it could start";
a card still asking is cleared. A start asked for after the Stop is a new one,
and runs. Every start — the scheduler's, `run_task`, a retry, a continue, a
resume, a force start, a conflict repair — claims its task at
one point, which checks in one step that the user approved the task, that no
Stop came since the start was admitted, that Mark complete is not landing it
and that a slot is free, before anything is awaited. The claim takes the task
by id with the admission the start was asked under, and reads the task as it
stands then: a start that awaited first — its run opening, the user's answer —
runs what the plan holds, an edit made meanwhile included. Each attempt keeps
the admission it was claimed under, and the repair its conflict is owed claims
under that one, so a Stop since withdraws the repair as it did the attempt.
Whether the task may start at all is the one start rule
([ADR-0034](0034-a-failed-task-blocks-only-its-dependents.md)), read before the
claim.

**`skip_task` never vouches for work.** Verdicts come from evidence, so the
supervisor cannot Mark complete: that lands the work as if someone had checked
it, and only the user does. What it may decide is that work will not be waited
for. A skipped task gets no verdict and lands nothing; its worktree and branch
are kept, as a failed task's are, so the user can still look at it, retry it
or Mark complete it. A skip releases the task's dependents
([ADR-0034](0034-a-failed-task-blocks-only-its-dependents.md)), and each is
told in its prompt that the dependency was skipped and why, so it does not
count on that work. The reason is required of the supervisor and shown in the
timeline; the user's own Skip goes through the same command, as the user,
with the reason optional. The supervisor skips only a task that already needs
someone — failed, blocked, or waiting for input — never one that is running,
completed, or has not started with nothing blocking it.

**`answer_approval` never allows.** A runner asks because its mode did not
cover the request. Allowing it would widen the mode the plan gave that task,
which ADR-0001 forbids at spawn and #92 forbids down the tree. A supervisor can
narrow (deny), or hand the decision to a person.

**`answer_checkpoint` is the supervisor's at Act, and the user's.** A runner at
a checkpoint asks a person to approve its work before it goes on, and the
answer is the user's judgement unless they let the supervisor act. In a
wake-up turn at Act the supervisor approves it, so the task goes on, or rejects
it with a reason, which the runner is told and acts on; a rejection without a
reason is refused, since the runner would be left with nothing to act on. A
planner turn in the user's own turn is refused: the user is in the conversation
and answers from the task's checkpoint card, and the refusal tells the planner
to tell them what the runner asks and what it would answer. The supervisor
below Act and autorun are refused the same way. A checkpoint is not answered
with `message_task`: that is refused too, and each refusal is worded for who
asked — the checkpoint tool to the supervisor at Act, the card to a planner
turn, Approve or Reject to the user. **A checkpoint that asks for the user's
judgement on an irreversible or outward effect — a deletion, a push, a payment,
a message to someone — is escalated to the user, not approved.** The supervisor
leaves it waiting and tells the user what it asks and why it did not answer.
This is the escalation rule the mandate (#23) will enforce; until then it is
the Act brief's guidance, and Act is the user's statement that they accept the
supervisor's judgement on the rest.

**Consent depends on who started the turn:**

- **A user-started turn** follows #91. Stops and messages are always allowed —
  they only end or steer work. Starts and retries ask the user in Guarded and
  follow plan approval in Full. An unapproved task never starts, at any level,
  with one exception ([ADR-0030](0030-global-run-settings.md)): with autorun on,
  a plan the planner submits is approved and started as the user's standing
  instruction, and with autorun on and Full the planner may also start a task it
  added after the plan was approved.
  `merge_all`, `skip_task` and `answer_checkpoint` are refused: the user is in
  the conversation, and presses Merge all, skips the task or answers its
  checkpoint from the card themselves. A skip decides that
  work will not be waited for, which only the user, or a supervisor they let
  act, decides. A `run_script` call asks the user on the approval card, shown
  the script as written, unless the effect allowlist covers it, or autorun in
  Full approves it ([ADR-0035](0035-effects-are-consented-and-recorded.md)).
- **A wake-up turn under Watch** refuses every execution tool with "suggest it
  to the user".
- **A wake-up turn under Act** allows all of them without asking, `run_script`
  included, which the timeline records as consented to by Act, or by the
  effect allowlist rule that covers it. Choosing Act is the consent.

**Tasks the supervisor adds under Act count as pre-approved and may start —
ops tasks and script tasks included.** A `run_task`, a fresh `retry_task` or a
`run_plan` it asks for in the reply whose edit adds the task waits for the edit
and then starts the task as a start of any approved task does, whether or not a
run is in progress: nothing else would start it once the run has ended. The
edit's approval is what lets the start through, so below Act the start is
refused in the words of the level, and a task the plan already holds that the
user has not approved stays refused. A skip of a task the same edit adds is
refused instead. This is a deliberate choice, and it carries the risk
#23's comment describes: an instruction injected into something the planner
read — an issue body, a fetched page, a task's output — can become an ops task
that runs unattended on real systems, in the session's mode, with no one asked
after the first approval. Without it, Act would stop at every replan for a
person, which is Watch with extra steps. The answer belongs in the mandate:
changes after approval going back to the user unless granted, declared scope
per ops task, and escalation of irreversible or outward effects. #23 revisits
this choice; until then Act is the user's statement that they accept it, and
the level picker says so.

**Every action is recorded in the timeline with who asked** — the user, a
planner turn, or the supervisor — and surfaces draw it as they draw the
matching button press, so the plan pane looks the same whichever route acted.

**Mark complete and Mark not done on an AI or script task are a recovery
action, taken deliberately with the run stopped.** The user's vouch lands work
no verdict passed, so the seam holds the call to two rules whichever surface
sent it, and the surfaces only explain them. First, it is refused while
anything could still move the task on without being asked: the plan starting,
a scheduler driving it, an attempt starting, running or integrating, a start
admitted and not yet claimed, a force start queued, a start a dirty checkout
parked for Stash and continue, or a usage-limit hold or scheduled resume. That holds for a task that has not started, failed, waits,
or already completed. The refusal tells the user to Stop the run first, and
the Stop makes the override possible once its attempts have settled. A run that
ended on a failure is not in the way, since nothing advances until a retry or a
skip, and overriding the failed task is how its dependents are released.
Second, it needs the user's explicit yes, carried on the command as
`confirmed`, with the `status` they were asked about as `seen`: a call without
the yes is refused in the words of the question, and one whose task has moved
on since is refused rather than overridden, so a stale click, the CLI and the
API cannot skip the acknowledgment. The question says that Mark complete
vouches for the work although no passing verdict said it was done, may land
what the task kept, and releases its dependents on a future run; Mark not done
clears the completion and holds the task until it is retried or started, and
undoes neither the work nor what already ran on it. While an override lands,
nothing starts and no second override is taken, so a run or a script requested
under it, and a skip that would start the run again, are refused until it has
landed. A manual task's sign-off is the user's own work:
it is never held up by a run and asks no yes of the seam, so it can release the
tasks that wait on it mid-run. The VS Code card puts the two controls last in
a task's expanded details, never on its status circle; the TUI's `m` and the
slash commands and the CLI's `--yes` follow the same asking, and a call with no
terminal to ask on is a no.

**The user's own controls are commands at the same seam.** Besides the tools
above, which the user's buttons reach as the user, the seam has a command for
each control only the user presses: `force_start`, `mark_complete`,
`mark_not_done`, `interrupt_task`, a force send (`message_task` with `force`),
`force_send_queued`, `remove_queued`, `cancel_resume` and `approve_review`.
Resume now is `retry_task` from `session` on a paused task. A planner turn,
the supervisor or autorun asking for one is refused: the user is in the
conversation and presses it. The checkpoint answer, `answer_checkpoint`, is
the user's control too, and the one the supervisor at Act may also press (above). The supervisor never Mark completes,
at any level. The user's `answer_approval` may allow, allow for the task, or
deny with a note; everyone else's still only denies or escalates. Each command
is checked, claimed and recorded as the shared ones are, and saved before any
surface hears of it. What a command answers besides its line is a typed
payload: the id of a queued message, the line saying a force start waits for
its dependencies, and, for the user's Merge all, the whole merge result. A
Merge all that stops is refused with that result, so the Merge all card can
show why; whether the merge closed the run is the Session's word, `run_closed`
([ADR-0013](../isolation/0013-worktree-isolation.md)), never the payload's. A
user's Stop with nothing to stop is answered ok and recorded nowhere, since
the surface already shows the run stopped. So is a Merge all, from anyone
allowed one, once the plan's last isolated run closed with everything it
landed merged: by the automatic Merge all at its end, by an earlier Merge all,
or as a run of tasks started one by one settled in the middle of the turn that
asks. There is nothing left to merge, and saying "no isolated run" would read
as a failed merge. The plan saves that run's id (`mergedRun`) until a later
run decides how it executes, so a restart changes nothing; a plan that never
isolated, or whose last run shared the workspace root, is still refused. A refusal is worded for who asked,
in one place: a model is
told the tools it calls and what to tell the user, the user the controls they
press, and the supervisor and a planner turn are told apart where they differ,
as for a task waiting at a checkpoint. Every surface's control reaches these commands through the Session's one
`execute` as the user; the Session keeps no per-verb control method for them.
VS Code sends each of its controls — task cards, the plan bar, the command
palette and the task-log panel, a Deny with a note included — through these
commands as the user, and shows a refusal as the seam worded it; the chat writes
no note of its own for them, so the timeline's line is the only one.
The daemon takes these controls on one route, `POST /api/plans/:sessionId/execute-command`,
whose body is the `ExecutionCommand` and which runs it through `Session.execute`
as the user: it answers a refusal as the 400 that carries the seam's line, so
the CLI prints the same words the other surfaces show. It answers the command's
line as `message`, and a `payload` where a surface needs more: a task message's
`id`, a force start's queued line, a Merge all's result. Execute, Stop, the
review approval, a checkpoint's answers and Merge all keep routes of their own,
since each answers more than the seam does ([ADR-0006](../surfaces/0006-tui-pure-core-thin-driver.md) S3). A task named in
a route is resolved by the seam, so the CLI sends a reference as typed (an id,
`#order`, title, or the user's unique id prefix) and reads no plan first. The TUI writes no
notice beside the timeline's line for a control and shows a refusal as the
daemon worded it.

### Loop guards (Act)

Checked at the seam, where the action executes:

- **Retries per task**: a global setting, 2 unless changed in `/settings`
  (`ordewell supervisor retries <n>` headless)
  ([ADR-0030](0030-global-run-settings.md)). Past it,
  `retry_task` is refused.
- **No identical retry**: a retry after a failure with the same prompt and
  model as the failed attempt is refused. Something has to change.
- **No oscillating edits**: re-adding a task it removed this run, or reverting
  its own edit, is refused.
- **Skips count**: a skip of a task the supervisor retried this run counts
  against that task's retry limit, so past the limit the supervisor can
  neither retry nor skip it; the task is the user's. A task its own edit
  added has not started and nothing blocks it, so a skip of it is refused.
- **No un-skipping**: a skipped task is never run again by the supervisor —
  not by `retry_task`, `run_task`, `run_plan` or an edit that re-arms it.
  Whether it runs again is the user's to decide.
- **Wake-up rate**: more than six wake-ups within 30 minutes with no pass in
  between drops the run to Watch, with a notice. A supervisor that keeps waking
  and nothing passes is spinning.
- **A loop's rounds are no retries**: the loop runs its check again itself, so
  neither the retry limit nor the identical-retry guard counts a round. While
  something will run a check between rounds, a supervisor's start or skip of it
  is refused, since its loop goes on without anyone; when nothing will, its
  start runs the next round, uncounted, and it may skip it as any failed task
  (ADR-0045 L7).

A start of a task that failed is a retry however it is asked for — `run_task`,
or `run_plan`, which would start every failed task again. What the guards
remember lasts from the user's start of a run to their next: a run the
supervisor restarts itself, or a usage-limit reset resumes, continues the one
before, its level as lowered included, or each restart would wipe the count.
A failure blocks only the failed task's dependents; independent work goes on,
and the run ends once nothing else can start (ADR-0034). A skip of the failed
task continues that ended run as a retry does, so what it blocked starts. An edit to the failed
task is reconciled into that ended run, keeping the task failed, so the
supervisor's retry after it continues the run and the tasks it blocked start
once it passes, rather than the one task running on its own.

A refusal is a plain note back to the model naming the guard and what would be
accepted. Each tripped guard also posts a supervisor message to the user.

### Failure handling: the run never depends on the supervisor

- **A wake-up turn has a timeout** of ten minutes. On a crash or hang the
  planner is restarted by its saved native session id (ADR-0009's resume path)
  and the turn retried once. A turn that does not end when stopped has the
  conversation taken back from it, and nothing it held lands, as nothing of a
  failed turn does: a planner turn writes nothing to the dialogue until the
  save that lands it, so there is nothing to undo. Its end is announced as the
  conversation is taken back, and nothing it streams or settles afterwards
  reaches a surface: a vendor planner restarts nothing, so the hung call
  settles whenever it does, while the retry runs. A plan scope that ends
  first — a new plan, another session adopted — discards the wake-up turn,
  its timeout and grace with it, so taking the conversation back never
  reaches the next scope's turn and no failure is counted. A planner turn that ends without a reply — a dead agent — is a
  crash here, not a note.
- **Then the run goes unsupervised**: it carries on as Off, with a visible
  notice. Wake-ups not delivered are persisted and handed over whole at the
  next successful turn or user message, so nothing that happened is lost to
  the conversation.
- **A planner usage limit waits for its reset** as a runner's does (#84): the
  turn's wake-ups wait with its other inputs and go again in the planner's
  resend ([ADR-0044](../planner/0044-the-planners-usage-limit-waits-and-resends.md)); one
  whose reset cannot be read leaves the run unsupervised.
- **Loading a session never opens a planner turn or starts execution.**
  Undelivered wake-up batches and user inputs are preserved for a new input;
  the supervisor's saved debounce is not rearmed on load. Autorun applies to
  a new plan submission, never to opening a saved session.

### Usage limits

A task paused on a usage limit wakes the supervisor with its resume time. Under
Act it may move pending tasks to another allowed runner. That is a recorded
plan edit, and it cancels those tasks' scheduled auto-resume and makes them
ready for the next scheduler slot. Direct user edits follow the same rule.
Other tasks on the old runner keep their shared wait. Changing only the model
on the same runner keeps the resume because the limit belongs to that runner's
account. Moving a running task is refused like any edit to a running task.
Once the user says the limit has reset early, it may resume the task in its
saved session with `retry_task` from `session` (ADR-0018, U1). A pause is not
a failure, so no prompt or model change is asked of it, but the resume counts
against the task's retry limit; one that hits the limit again at once waits
for the user.

### Merge at gates automatically

A global user setting, merge automatically in `/settings`
(`ordewell automerge` headless) ([ADR-0030](0030-global-run-settings.md)),
**usable with the supervisor Off.** When a task reaches a merge gate with
nothing else holding it back — approved, off hold, its dependencies met — Ordewell
runs Merge all itself, through the same queue as landings and the user's Merge
all. A conflict, or a dirty overlap in the user's tree, aborts it with the tree
untouched (ADR-0014's preflight, unchanged); the gate then waits for the user,
with a notice and, if a supervisor is on, a wake-up. The timeline records
"auto-merged for task N".

This is a second, opt-in exit from ADR-0013's "never merged for the user",
beside `merge_all` under Act. Both are switched on by the user, once; without
either, the user's Merge all stays the only path.

The setting reads "merge automatically": at merge gates and at the end of a
run, so that a user who turned it on is not stopped at the end of the run
either:

- **The setting also merges at the end of a run.** With it on, when a run
  settles with landed work that is not merged yet, Ordewell runs Merge all
  itself, by the same route as a gate merge: the `onAutoMerge` observer, the
  "auto-merged" timeline entry, a notice and the `isolation_merge` broadcast.
  If that merge stops (conflict, dirty overlap, failure) the run is handed off
  to the user, and a supervisor that is watching gets an `auto_merge_stopped`
  event. The settings key is `mergeAtGatesAutomatically`. The run update the
  run's end wakes the supervisor with says where its landed work stands:
  merged into the user's branch, with nothing to merge, or waiting for Merge
  all. A live planner hears of the merge nowhere else.
- **Surfaces do not open the handoff while a merge is coming,** so the overlay
  never asks about a merge Ordewell or the supervisor is about to make. With
  auto-merge on, no handoff is sent unless the automatic merge stops. With the
  supervisor at Act, the handoff is sent marked as deferred to the supervisor:
  the TUI prints only its transcript line, and the VS Code card says the
  supervisor may merge it but keeps its buttons. If the supervisor's wake-up
  turn for the finished run ends without merging, the handoff is sent again
  unmarked, and the TUI overlay opens then.

### Out of scope

Spending limits and harness distribution (a separate design), delegation and
delegated tasks (#33), mandate inheritance (#23, #92), the escalation inbox
(#30). An escalated approval goes to the user through today's approval card
until #30 exists.

## Considered options

- **Rejected: wait for the mandate.** The run stays unwatched for the whole of
  #23's design, and the mandate would arrive with no seam to enforce it at.
- **Rejected: one on/off toggle (#27's original shape).** Some users want to be
  told, not acted for. Two consents need two settings; three levels is the
  fewest that hold both.
- **Rejected: the word "autonomous" for the level.** ADR-0001 uses it for runner
  permission modes, and the autonomy level (Full, Guarded) is a different
  setting. A Guarded session can have an Act supervisor.
- **Rejected: keep the between-batches queue.** A question about a running task
  is answered after it ends, and a wake-up about a failure waits behind the
  task that is still running. A queue for wake-ups beside the one for user
  messages would be two paths for one thing.
- **Rejected: defer a start behind the turn's held edit.** Previously adopted
  while a tool's edit was held until its reply ended: a start of a task the
  edit changed or added was judged against a preview of the plan, queued, and
  run again through the seam once the edit landed, told as not done when it
  did not. It made one start two decisions apart in time, a Stop had a queue
  to withdraw, and a reply that failed after the edit dropped both. With the
  edit committed as its call answers (ADR-0022, P2) the start reads the plan
  it changed and needs none of it.
- **Rejected: pause running tasks during a planner turn.** Their work is not in
  question. Holding only new starts is enough to keep edits from racing a
  spawn.
- **Rejected: apply edits to running tasks by stopping them implicitly.** It
  hides a stop inside an edit. The refusal says "stop it first", and the stop is
  then its own recorded action.
- **Rejected: enforce the level in the prompt.** A prompt is advice. The model
  that wants to retry will try; the seam is where it learns it cannot (#29,
  ADR-0008's `refuse` tier).
- **Rejected: let the supervisor Mark complete.** It would land work no
  evidence vouched for, with the model as the tie-breaker on whether it was
  done. A skip lets the run go on without the work instead, and lands none of
  it.
- **Rejected: a skip that marks the task complete.** The user's Skip did this
  until 2026-10-14: it landed the work as if vouched for, so "skip this, it is
  not needed" and "this is done" were one action with one effect.
- **Rejected: let any planner turn skip.** A plain planner turn the user did
  not let act would decide on its own that work need not be waited for.
- **Rejected: let `answer_approval` allow.** It widens a task's mode after
  the plan set it (ADR-0001, #92). Deny or escalate keeps the plan the source
  of truth.
- **Rejected: added tasks under Act wait for the user.** Safer against
  injection, but Act then stalls at every replan. Recorded as a choice for #23
  to revisit, not as safe.
- **Rejected: checkpoint answers are the user's alone.** Until 2026-10-24 a
  planner turn, the supervisor and autorun were refused `answer_checkpoint`,
  like the user's other controls. A runner that stopped at a checkpoint after
  noticing another process editing its worktree then had no one to answer it
  at Act: the supervisor's only tool was `answer_approval`, which covers
  runner requests, and it could only tell the user it could not answer. Act is
  the user's consent to the supervisor's judgement, and a checkpoint is a
  judgement; what stays the user's is the one on an irreversible or outward
  effect.
- **Rejected: let a planner turn in the user's turn answer checkpoints.** The
  user is present and presses Approve or Reject from the card, as with Merge
  all.
- **Rejected: `merge_all` in user-started turns.** The user is present and can
  press it; a merge by proxy adds a route to the user's branch for nothing.
- **Rejected: a separate supervisor model or process.** It would not know why
  the tasks exist, and the user would have two conversations about one plan.
- **Rejected: a supervisor the run waits on.** A planner crash, hang or limit
  would stop work that does not need it. The run degrades to Off instead.
- **Rejected: auto-merge only with a supervisor.** Merging at gates needs no
  judgement — the preflight decides — and users who want it may not want a
  supervisor.

## Consequences

- The pending plan edit, its queue and the drain go. Surfaces stop listing
  edits above the input; a mid-run message is a planner turn like any other.
- The scheduler gains a start hold scoped to a planner turn, with release on
  every way a turn ends. A test must cover the failure path.
- The planner's MCP server gains `task_diff` and the execution tools; the API
  planner gains matching tool definitions. Both go through the command seam.
- Harness planners can now change what runs, not only the plan. The file-write
  and shell invariants of ADR-0008, ADR-0009 and ADR-0026 are unchanged: the
  planner still edits no file and its commands run inside its envelope. An
  effect happens only in a task: a task runner's, or the script task that
  `run_script` adds ([ADR-0035](0035-effects-are-consented-and-recorded.md)).
- A plan gains pending turns — the user's messages and the wake-up batches not
  yet delivered — and the run's `runSettings`. The level, retry limit, read
  budget and merge setting are global ([ADR-0030](0030-global-run-settings.md));
  older plans' values are ignored.
- Act with ops tasks can act on real systems unattended. The level picker says
  so; #23 owns the narrower answer.
- ADR-0013's "never merged for the user" holds unless the user opts in, once (ADR-0030).

## History

- 2026-10-11 — accepted.
- 2026-10-11 — the command seam and the planner's execution tools (#91), less
  `merge_all`: user-started turns only; the supervisor is refused until its
  levels land. Plan approval is kept on the plan as the tasks the user
  approved — every task when they execute it, and each one they start or retry
  themselves — and a Guarded start asks on the planner's approval card.
- 2026-10-11 — live planner turns implemented (`PlanTurns`); the pending plan edit queue, its drain and `modifyDuringExecution` removed.
- 2026-10-11 — the Watch level (`Supervisor`): wake-ups from run events, `usage_limit` coalesced per runner, run updates, the wake-up read budget, refusals at Watch, failure handling and persistence. Surfaces offer Off and Watch; a plan set to Act runs as Watch until Act's rules land.
- 2026-10-11 — the Act level: every execution command without asking, `merge_all` as a planner tool (refused in user-started turns), edits in wake-up turns (a whole plan refused), tasks the supervisor adds approved and marked `addedBy: 'supervisor'`, a moved task's scheduled resume cancelled, and the loop guards (`LoopGuards`; retry limit `supervisorRetryLimit`, default 2). Added: the user may lower a running supervisor at once, a start waits for the same reply's held edit, and a start of a failed task counts as a retry however asked. Surfaces offer Act, saying what it allows.
- 2026-10-11 — moved tasks become ready on their new runner through the same resume decision as direct user edits; same-runner model changes keep the wait.
- 2026-10-11 — supervision survives a daemon restart: the loop guards' memory (retries, failed-attempt shapes, the supervisor's edits, reported trips) and the wake policy's undelivered events, passes and wake-up timestamps are saved on the plan (`supervision`) and restored when it is adopted, so a debounced batch is still delivered and the guards hold at the point they reached. A user-started run still clears them.
- 2026-10-11 — the surfaces' execution buttons reach the seam as the user, so
  their actions appear in the timeline as the planner's and the supervisor's do:
  Execute plan (`run_plan`), Run task (`run_task`), Retry (`retry_task` from
  `fresh`), Continue (`retry_task` from `session`), Stop/cancel (`stop_task`),
  Stop execution (`stop_run`), a task message (`message_task`) and a runner
  approval's deny (`answer_approval`). `approveReview` approves every task in
  the plan, as executing it does. Force start past a merge gate, Mark
  complete/incomplete, Skip and the user's Merge all were left on their Session
  methods, which the seam had no command for.
- 2026-10-11 — final verification of the merged slices. A planner edit adopted
  after a failure is reconciled into the run instead of reloading the plan. A start deferred behind a held edit
  that never lands is dropped with a notice. VS Code's task-log message and
  Continue, and its Retry and Cancel task commands, reach the seam as the user,
  as the other surfaces' buttons do. The defaults are stated in the body: retry
  limit 2, wake-up read budget 12, wake-up debounce 5 s, wake-up turn timeout
  10 min, start-hold lapse 5 min, wake-up rate more than 6 in 30 min.
- 2026-10-12 — amended by [ADR-0030](0030-global-run-settings.md): the level,
  merge at gates automatically, the retry limit and the read budget become
  global user settings changed by chat commands, applied at once to the
  session they are typed in; Watch is the default; autorun starts a submitted
  plan.
- 2026-10-12 — merge automatically also at the end of a run, and the end-of-run
  handoff is deferred while an automatic merge or an Act supervisor's merge is
  coming (see "Merge at gates automatically").
- 2026-10-13 — run supervision has one owner (`RunSupervision`), and who opened
  a run travels with the call that opened it rather than being read from what
  else was in flight: the user's Execute while a supervisor's `merge_all` was
  still merging had continued the run before, its lowered level and the
  guards' memory included.
- 2026-10-14 — a failure blocks only its dependents instead of halting the run; run updates name the tasks a failure blocks, and the run's end counts them ([ADR-0034](0034-a-failed-task-blocks-only-its-dependents.md)).
- 2026-10-14 — a start deferred behind a held edit is judged before it waits, against the task as edited, and one refused once the edit lands is told to the user and to the planner's next turn. Seen live: an Act supervisor's retry of a task added after the user approved the plan was answered "Queued", then refused after the turn with nobody told.
- 2026-10-14 — `skip_task`: a verdict-less `skipped` state that lands nothing and releases dependents, for the supervisor at Act with a required reason; the user's Skip goes through it as the user instead of marking the task complete. Skips count against the retry limit of a task the supervisor retried, and the supervisor never runs a skipped task again.
- 2026-10-14 — a task paused on a usage limit is resumed early with `retry_task` from `session`, outside the identical-retry guard and inside the retry limit (ADR-0018, U1).
- 2026-10-16 — plan approval is read only from the approval record, never from the plan's display status. The plan keeps its own `approved` mark, set by Execute plan, signing off a review and autorun's start, beside `approvedTasks`; a user's start of one task approves that task, not the plan. A plan saved before the mark existed is read from its status once, as it is adopted. Seen live: VS Code wrote its dock status (`draft`) onto the Session's plan after a run that ended with failures, after a stop and on reload, and every planner and supervisor start was then refused as unapproved. Surfaces keep their display status to themselves.
- 2026-10-16 — in Guarded, a planner start in a user-started turn of tasks the user has not approved asks instead of being refused: the approval card names the tasks a yes approves, a yes approves them as Execute plan does and starts the work, and a no is declined. Every other refusal still comes before the question, a plan the user never executed is still theirs to execute, and the supervisor's starts stay within what the user approved. A start deferred behind a held edit — `run_plan`, and a start of a task the edit adds — is judged against the plan as the edit leaves it, and one that will ask says so in its answer. Seen live: `run_plan` after `edit_plan` added tasks answered "Queued", and was refused once the reply ended.
- 2026-10-16 — the user's Stop of planner work cancels every user message waiting for it, at any stage — at the planner gate, behind a live opening or a live reply — each caller told it was stopped; before, it did so only at the gate, and the stopped turn's release opened the next one. Wake-ups waiting behind a stopped live turn are not what the user answered, so they stay undelivered and go with the next turn something else opens (the user's next message or the supervisor's next wake-up), never off the stopped turn's release; at the gate they are the stopped turn's and go with it. A force send still keeps the queue (ADR-0023). Seen live: a message sent while the opening ran was answered after Stop, its `submit_plan` landed, and autorun started a task.
- 2026-10-16 — approval covers exactly what the user consented to, and leaves the plan with its task. A start approves the tasks it was checked against, taken at its last check — after any question — and recorded before it acts, never read again after it awaits; a yes on the Guarded card approves the tasks the card names and no others. The record stays keyed by task id and is kept continuous with the plan: every rebuild of the task tree — an edit's remove, merge or split, a whole plan that leaves a task out, a reconciled edit, a load, a fork — drops the approval of each id no longer in it, so a removed task's id, written again by a planner later, names a new task nobody approved. `Session.isApproved` is the one read, for the seam and the scheduler alike. A creation identity per task was weighed and not taken: a task an edit adds already gets an id the planner cannot choose, and an id a whole plan restates is the same task by the rules that carry its status, verdict and runner session across the rewrite (`keepExecutionState`, `stampOrigin`), so an identity would only mirror id continuity, at the cost of a new saved field on every task and surface. The one gap, an id that leaves and comes back, is closed where it leaves. A saved session loads with its approvals; an id whose task is no longer in it is dropped as it is adopted. Seen in an audit: Execute's spawn held while a planner edit landed approved the added task; and a removed task's id, brought back as an ops task with a new prompt, started on `run_task` with nobody asked.
- 2026-10-16 — the Stop generation: the user's Stop withdraws every start admitted before it and not yet claimed — one queued behind a held edit, one waiting on its card, one still opening its run — each kept as refused and said as not done, and counts them as work to stop. Every start claims its task at one point that checks approval, the Stop generation and a free slot together. Seen live: a `run_plan` queued behind an edit started the plan after the user's Execute and Stop; a Run sent beside Stop left the task running after Stop answered "stopped"; with one slot, two Runs sent at once both spawned.
- 2026-10-17 — a planner usage limit keeps the turn's wake-ups with its other inputs and sends them in the planner's resend at the reset, instead of the supervisor holding its own wait ([ADR-0044](../planner/0044-the-planners-usage-limit-waits-and-resends.md)).
- 2026-10-18 — the claim takes the task by id with the start's admission and reads the task as it stands, so a start that awaited its run opening runs the task as edited meanwhile; a conflict repair claims under the admission of the attempt whose work it repairs, rather than whatever Stop generation is current; a force start queued behind its dependencies waits for a planner turn's start hold, and the hold's release looks at the queue with or without a run.
- 2026-10-18 — a planner turn holds what it writes — its inputs, the skills the planner loads, its research subagents — until the save that lands it, so a hung or failed turn has nothing to undo, whatever was saved while it ran.
- 2026-10-18 — the user's own controls get commands at the seam: force start, Mark complete and Mark not done, interrupt, force sending or taking back a task message, cancelling a scheduled resume, a checkpoint answer and approving the review, refused to anyone but the user; the user's `answer_approval` may allow; a typed payload carries the full Merge all result and a force start's queued line; the user's Stop with nothing running is a quiet no-op; refusals are worded per actor.
- 2026-10-18 — VS Code sends every control, the task-log panel's answers to a runner's request included, through the seam as the user, and the chat stops writing notices that contradicted the timeline's line.
- 2026-10-18 — a hung turn's end is announced once, when the conversation is taken back, and nothing it streams or settles afterwards reaches a surface; a run update is told again after a turn that did not land an answer.
- 2026-10-18 — the daemon, the CLI and the TUI send every control through the seam as the user: the daemon's routes answer each command's line and carry a refusal as the seam worded it, the CLI sends a task reference as typed and prints that line, and the TUI drops the notices that repeated the timeline's.
- 2026-10-18 — every user control reaches the seam through `Session.execute`; the Session's per-verb control methods (Execute plan, Run task, Retry, Continue, Stop, Mark complete and not done, Resume now, force start, interrupt, approving the review, Merge all, the task-message and queued-message controls, a checkpoint answer and cancelling a scheduled resume) are gone, so a surface, the daemon's routes and the CLI's commands all take the one path, and `TaskOrchestrator.runTask` goes with them.
- 2026-10-18 — the seam reads a task reference from the user's controls as the CLI and TUI do, a unique id prefix included; a model's references stay id, label and title.
- 2026-10-18 — a plan scope that ends while a wake-up turn is out discards it with its timeout and grace, so its grace never abandons the next scope's turn or counts a failure there.
- 2026-10-18 — the Merge all payload carries the merge result alone; whether the merge closed the run is the Session's `run_closed` ([ADR-0013](../isolation/0013-worktree-isolation.md)), and the payload cannot say it another way.
- 2026-10-18 — loading a session keeps saved planner inputs and supervisor batches idle, without rearming the supervisor debounce.
- 2026-10-21 — a loop's check failing a round with rounds left is no attention event and no failure the guards remember; it wakes the supervisor once, when its loop runs out of rounds, and the supervisor neither starts nor skips it between rounds ([ADR-0045](0045-a-check-repeats-with-its-fix-until-it-passes.md)).
- 2026-10-21 — `run_script` joins the execution tools: the planner performs an exact effect itself as a script task, consented to by the card, the effect allowlist, autorun in Full or Act, and refused at Watch ([ADR-0035](0035-effects-are-consented-and-recorded.md)).
- 2026-10-21 — research reports wake the planner at every level under the originating authority; all automatic report turns share the persisted message limit (ADR-0037 R2, R3, R4).
- 2026-10-22: the level and its guards are set in `/settings` in the TUI and VS Code; the one-value slash commands are gone there, and `ordewell supervisor` stays headless.
- 2026-10-22 — automatic report turns are not bounded per user message: a report turn may start further research, whose report opens the next turn, and the chain is held only by the planner's judgement, the run's Parallel limit, `mayReport` and the user's Stop (ADR-0037 R4).
- 2026-10-22 — decided, not built: run updates carry a task's handoff ([ADR-0047](0047-structured-task-handoffs.md), #120).
- 2026-10-22 — implemented handoffs in run updates, with whole findings and a pull pointer (ADR-0047, #120).
- 2026-10-24 — the supervisor at Act may answer a checkpoint with `answer_checkpoint`, a planner tool of its own; a planner turn in the user's turn, the supervisor below Act and autorun are refused, a rejection needs a reason, and one that asks for the user's judgement on an irreversible or outward effect is escalated to them.
- 2026-10-24 — the daemon's per-control routes are replaced by one `execute-command` route (ADR-0006 S3); the seam's lines and payloads travel as before.
- 2026-10-24 — the approval record's rules live in one module, `ApprovalRecord`, and run on each change to the task tree rather than inside a save: a task that leaves the plan takes its approval, and a save only writes. Approval taken from a task is announced to surfaces as a plan update with a status, wherever the change was made. `Session.isApproved` stays the one read.
- 2026-10-24 — a start the Act supervisor asks for of a task its own edit adds waits for the edit instead of being refused as "tell the user".
- 2026-10-25 — Mark complete and Mark not done on an AI or script task are refused while a run could advance the task and otherwise need the user's explicit yes, in both directions; a manual task's sign-off is never held up by a run.
- 2026-10-26 — a planner's edit commits as its `edit_plan` call answers (ADR-0022, P2), so a start asked for after it goes through the seam at once against the plan as edited; the starts deferred behind a held edit, their replay and their "not done" notices are gone.
- 2026-10-26 — the run update at the run's end says whether its landed work is merged or waits for Merge all, and a Merge all after the plan's last isolated run closed merged is answered ok as nothing to merge, recorded nowhere, across a restart too (`mergedRun`). Seen live: an Act supervisor woken after the automatic Merge all at the run's end called `merge_all`, and the timeline said "refused: This plan has no isolated run".
- 2026-10-31 — a supervisor's start or skip of a check between rounds is refused only while something will run it (ADR-0045 L7).
