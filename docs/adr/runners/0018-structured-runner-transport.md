---
status: accepted
---

# 0018 — Structured runner transport: drive task runners through their programmatic protocol

*Pending:* [ADR-0055](../supervision/0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) — Continue of a delegated task reopens its child session, and its `runnerSessionId` names that session.

## Problem

Runner screen scraping cannot reliably distinguish a completed task, a
permission request and a turn waiting for input. The harness planners and task
runners share Claude Code, Codex and OpenCode programmatic connectors.

## Decision

**Task runners are driven only through their programmatic protocols.**
[ADR-0025](0025-structured-only-runners.md) defines the required MCP attachment
and completion evidence.

## Key properties

- **Structured always; no transport setting (S1).** Every supported runner has
  a connector. There is no terminal fallback, setting, command or toggle.
- **One session contract (S2).** `IRunner` spawns `IRunnerSession`; every session
  supplies events, messages, interrupt, approvals, native session id, task
  tools and its runner's commands (R1). These methods are mandatory, without a
  capability discriminator; a runner without commands reports none.
- **Built-in connectors (S3).** Claude Code (`stream-json`), Codex
  (`app-server`) and OpenCode (`serve`) are the only supported runners. Plugin
  manifests are ignored with one notice at host startup.
- **One connector per runner, shared with the planner (C1).** The harness
  `AgentAdapter`s gain an explicit start switch: *read-only planner* versus
  *task*. The planner path always starts read-only, and tests assert that the
  planner has no other way to start an adapter, so the ADR-0008/0009 security
  boundary holds. In task mode the permission mode and effort come from
  the **runner manifest** — ADR-0001: manifests define what a mode means — through
  the connector's mode resolution. The adapter owns only the protocol flags
  (stream format, input format, permission-prompt channel, resume).
- **Two channels (O1).**
  (a) *Plain text to `onOutput`*: the assembled agent text plus one short line
  per tool call (`› Bash(npm test)`), no JSON and no ANSI. It is only ever
  appended to: each run of reply text (ADR-0009) is written once — its
  complete copy adds what its own deltas did not, on a line of its own when
  something else was written since — a paragraph after the turn's text before
  it. It feeds
  the planner's live-output read (#3), usage-limit
  classification and the fallback summary handed to dependents.
  (b) *A full-fidelity view* built from the structured events as ADR-0017
  display blocks: streaming text, thinking, expandable tool calls with
  arguments and results, nested subagents, usage, approval cards. Each run of
  text streams into a block of its own, which its complete copy settles
  wherever it now sits, so a note or another run landing in the middle of it
  splits or crosses nothing. Channel (a)
  is deliberately lossy; nothing that needs fidelity reads it.
- **A turn without a completion call is "waiting for input" (W1).** A turn that ends
  without a `task_complete` call makes the task `awaiting_user` with a saved reason:
  `input | checkpoint | conflict | files-changed`, or `usage-limit` for a turn
  whose error is the runner's usage limit (U1). A checkpoint wins over input. No
  verdict is guessed. Weaker models often finish, report in prose and stop
  without the call (#105), so the first turn of an attempt that ends cleanly
  this way gets one **completion reminder** first: a message from Ordewell
  telling the runner to call `task_complete` with `done` and its full report,
  or `blocked` and the reason, or to say what it needs from the user and end
  its turn. It goes through the message seam (M1) marked `from: 'ordewell'`,
  so it is logged, delivered and replayed like any message but drawn as
  Ordewell's, and the task stays `in_progress`. It is sent once per attempt
  (a retry or continue gets its own), for every task kind, and never after a
  failed or interrupted turn, a usage limit, or while a user message is queued
  or owed. Only a `task_complete` call settles the task; if the reminder's
  turn ends without one, the task waits for input and the user (or the
  supervisor) responds or marks it complete. The reminder asks for no new
  work, so the summary handed to dependents keeps the report written before
  it. Approval requests arrive
  mid-turn and do **not** change task status: "waiting for approval" is derived
  from the task's pending approvals. The idle timer keeps running during a turn
  and is paused while the task waits, on input, a checkpoint or an open
  approval, so a long approval wait does not also read as idle. If a queued message is delivered as the
  turn ends, or the runner still owes one it was handed (M1), the task stays
  `in_progress` with no flicker.
- **The completion contract lives in the runner's instructions (C2).** A
  runner compacts its own context (Claude Code's auto-compact, Codex's
  auto-compaction, OpenCode's summarize-on-overflow), and what it keeps of the
  first message is its own summary or a truncated copy. How a task ends — call
  `task_complete` with `done` and the full report, or `blocked`/`failed` and the
  reason — is therefore not in that message: it is the system prompt
  (`--append-system-prompt`), the thread's `developerInstructions`, or
  OpenCode's `system` / instruction entry, applied again on every resume. The
  first message is the task's prompt and its context only. The attempt's token
  is not part of any of it; it travels in the MCP connection.
- **Talking to a task (M1).** Ordewell owns the message queue. A message sent
  while a turn runs is handed to the runner at once and reaches the model at
  the runner's next step boundary — after the tool call in flight, inside the
  same turn — where the runner supports it (Claude Code, Codex, OpenCode 1.x;
  [ADR-0023](0023-messages-reach-a-running-task.md)). Otherwise, or when the
  runner refuses or lets go of it, the message waits in the queue and opens
  the next turn when this one ends. The queue shows each message as queued
  (removable) or handed over (the runner has it; no longer removable) until
  the runner reports it delivered; one that can no longer reach the runner is
  reported undelivered, never dropped silently. *Force send* interrupts the
  running tool call and delivers its message as the turn that replaces it.
  Interrupt is the runner's soft interrupt (Claude's `control_request`,
  Codex's `turn/interrupt`, OpenCode's abort), with kill-and-resume as the
  fallback; an interrupted turn becomes "waiting for input" unless a forced
  message follows.
  `session.write(text)` means "send as a user message". Checkpoint answers
  settle the open MCP call through `VerdictEngine`. Clarifying questions are plain text for now: a task starts
  with `AskUserQuestion` disallowed, so the agent asks in prose and ends its
  turn; a question card is a later option.
- **Runner commands (R1, #66).** Runners stay fully native: the user's skills,
  hooks, MCP servers, custom commands and the runner's own compaction keep
  working in a task. A task's chat therefore speaks its runner's slash
  commands, not Ordewell's. The connector reports what the runner offers
  (`TaskModeAgentAdapter.commands`, optional: name, description, argument
  hint, kind `builtin | skill | command`, aliases) and runs one
  (`invokeCommand`) as a turn of its own; the session exposes both as
  `commands()` and `invokeCommand(name, args)`. A command sent while a turn
  runs is queued behind it and never handed into it, where a runner would read
  it as text, and nothing sent after it overtakes it. A connector that cannot
  invoke one gets `/name args` as a message. The task log records the command
  turn (`command`, in place of its `turn_start`), what a command that runs
  without the model printed (`command_output`), every compaction the runner
  reports, asked for or automatic (`compaction`), and, once per process, what
  it loaded: its commands and the MCP servers of the user's setup, without
  Ordewell's own (`runner_loaded`, drawn collapsed). In the TUI task view `/`
  completes the runner's list alone, at the start of the message, the one
  place a runner reads a command; a reported `/name` runs as that command, an
  unreported one is refused with a note, and with no list reported the text
  goes as typed. A model command is run by the runner like any other; the Claude Code
  connector sees the model the next turn reports, and the plan follows that
  switch ([ADR-0041](../routing/0041-a-tasks-model-follows-the-runners-own-switch.md)).
  Ordewell's run and plan commands are neither offered nor run
  there; they stay on the plan pane, its keys and the planner chat, and Esc
  still leaves the view. Claude Code (checked on 2.1.299): the `initialize`
  control request lists every command with its description, argument hint,
  aliases and a `builtin` flag before any turn; each turn's `init` names the
  skills, the commands only its own TUI runs (left out) and the MCP servers;
  `commands_changed` lists them again. A slash command runs when a user
  message starts with it (no control request does it), `/compact` emits
  `compact_boundary` with its trigger and token counts, and a local command's
  printout comes back as a `<local-command-stdout>` echo. Codex (checked on
  0.162.1) lists enabled skills with `skills/list`, invokes their native
  `skill` input with its reported path, and maps `/compact` to
  `thread/compact/start`; the acknowledgement opens the operation, while
  `turn/*` notifications finish it and `contextCompaction` items mark the
  boundary. Its app-server exposes no custom slash-prompt discovery or
  invocation, so none are listed. OpenCode lists commands and skills with
  `/command` and `/skill` (1.x, checked against 1.18.34), or `/api/command`
  and `/api/skill` (2.x, checked on 2.0.28). 1.x invokes commands and skills
  through `/session/:id/command` and compacts through `summarize` with the
  assigned model; 2.x invokes commands through `/api/session/:id/command`,
  attaches skill ids to a native prompt, and compacts through
  `/api/session/:id/compact`. `/summarize` aliases `/compact` on OpenCode;
  neither runner's compaction API accepts summarization instructions.
  OpenCode reports completed compactions as `session.compacted` on 1.x
  and `session.compaction.ended` on 2.x. Neither protocol exposes the rest
  of its TUI-only command surface. VS Code task cards
  and log tabs complete the same runner-reported list through the Session;
  native commands use `invokeTaskCommand`, and log tabs draw command results,
  compactions and the collapsed loaded configuration through the shared block
  renderer. The planner chat keeps its own commands.
- **Background work (B1).** Claude Code reports a turn's `result` when the
  model stops talking, even with a background shell or agent still running, and
  opens a turn of its own when the work finishes. The Claude connector therefore
  holds a task's turn open while the CLI lists background tasks, so later output
  belongs to the same turn. Completion evidence arrives through the MCP tool,
  independent of the output stream. If the CLI starts
  no follow-on turn once the list is empty, the turn ends after a short grace.
  Main-thread work a runner starts after a turn has closed opens a turn of
  its own, with no user message. A subagent's late activity is logged without
  opening a main-thread turn. A routed turn-end or error event ends its turn
  immediately, before another protocol line in the same stdout chunk can be
  assigned to it; queued input waits for the adapter to release its send.
- **The plan's mode is held (B2).** `--permission-mode auto` on a model or
  account without auto mode is not refused: the CLI starts in `default` and
  asks about every write. The connector compares the mode `init` reports with
  the one the plan asked for and fails the turn in plain words on a mismatch
  (ADR-0001).
- **Lifetime (L1).** The process ends with its attempt, and at a verdict as
  soon as the verdict is accepted, not once the work has landed: the log lives
  in Ordewell, and work after the verdict would go unverified. It ends the way
  the runner ends a turn. A turn still open gets the soft interrupt, except the
  turn that reported `task_complete`: its tool reply is still in flight, so
  that turn is left to close by itself within the interrupt grace. The report
  is published once it closes; if it is still open at the grace, the report is
  published then, and the stop the verdict orders gives the runner one more
  grace to close before it is killed. In the common path the attempt lands only
  after the reporting turn has closed. The call itself is acknowledged at once:
  as it is accepted on the attempt's token, the task's status says the report
  was received (`completionReceived`, read as "Completion received", or a
  failed or blocked report received), and keeps saying so through the
  attempt's wind-down and landing. That receipt is no verdict: nothing lands,
  no dependent starts and no handoff is published on it, and it is never
  saved. A refused call shows none; a turn or a message the runner reads after
  reporting voids it with the report; it goes with the attempt, and an earlier
  attempt's runner never sets it. What the runner reports as that turn closes still
  belongs to the attempt that ended: Claude Code states a turn's cost and its
  model's window only on its `result` line, which comes after the
  `task_complete` call. The attempt's output is the call's summary, which the
  verdict already holds ([ADR-0022](0022-ordewell-mcp-server.md) V4), and the
  completion contract tells the runner nothing else it writes reaches anyone.
  Then a runner that can end by itself is told nothing more is coming (Claude
  Code exits on stdin's end, and only an exit of its own saves the session's
  running totals for `--resume`), and one that cannot is killed. A runner still
  there once the interrupt grace runs out is killed. A continue waits on that
  wind-down (K1). A plan adopted under it is a new scope: what the old runner still
  reports is dropped, never written to a task of the new plan that reuses its
  id. The native session id is saved per attempt, with the count of its
  cost the session ended on.
- **Continue (K1).** A retry that resumes the saved native session with the
  user's message as the next turn. It is verified and landed like any attempt.
  It is offered on completed and failed structured tasks with a saved session
  id, not on conflicts, and only while the task is still assigned to the runner
  that session belongs to: a saved session records its owner
  (`runnerSessionOwner`; for a plan from before that, the runner of the last
  attempt), and a session cannot cross runners
  ([ADR-0041](../routing/0041-a-tasks-model-follows-the-runners-own-switch.md)). Dependents
  are left alone, as with retry. If the runner
  refuses the resume, the attempt fails; no fresh session is started in its
  place. In an isolated run the task workspace is recreated at the same path
  from the current integration tips, then the previous attempt's unlanded work
  is merged into it. Before removing the kept worktrees, Ordewell commits
  uncommitted edits, including new files and deletions, to rescue commits and
  keeps their tips on `ordewell-preserved/<run-id>/<order>-<slug>` branches
  (with a numeric suffix when needed). A continue must recover that work:
  its saved session remembers those edits and would otherwise reason from
  files that no longer exist. The resumed agent is told its previous changes
  are in the working tree. If anything landed meanwhile conflicts with them,
  every repo of the group falls back to its integration tip; the preserved
  branches stay, and the agent is told exactly which branch holds its work
  in each changed repo, with `git log <branch>` and `git diff HEAD...<branch>`
  to inspect it before recovering it. Unrecovered branches are saved with the
  task's isolation record until it lands, so another continue or a reload
  still reports them while the task remains unfinished. A landing clears that
  reminder; the preserved branches remain available for inspection.
  Fresh retries still start clean from the integration tips. Shared runs
  continue in the same checkout with their
  uncommitted work already in place, and say so. A carry-over (U1) — a
  task moved to another runner, from a usage-limit pause or from any state that
  left a saved session — restores the earlier runner's attempt's work the same
  way, files only: no session crosses runners, so it is a fresh session given
  the task's prompt.
- **Usage limits (U1, #84).** A runner that stops on its account's usage
  limit — its process exits mid-turn with the limit as the last thing it
  printed, or a turn fails with it as its error, or the limit refuses the turn
  Ordewell was starting — has not failed the task. A limit counts only when it
  ended a turn Ordewell started: limit words left by a turn that had already
  ended did not stop the runner. Where the runner's protocol names the cause in
  a field, the field decides over the words (Codex's `codexErrorInfo`:
  `usageLimitExceeded` is the limit, with its reset from `account/rateLimits`;
  any other named cause is not, though its words read like one), and the same
  reading serves the planner and the supervisor
  ([ADR-0044](../planner/0044-the-planners-usage-limit-waits-and-resends.md)). The attempt ends
  as a verdict would end it (L1), the task is `awaiting_user` with reason
  `usage-limit`, and the run holds: every other start would spend the same
  exhausted limit. However the limit arrived, the pause is one rule
  (`LimitPauses`): no verdict is recorded and nothing goes to the execution
  log, the task's summary names the limit, its worktree is kept for the
  resume, and what follows is what follows a verdict. A held run stays open
  ([ADR-0034](../supervision/0034-a-failed-task-blocks-only-its-dependents.md)):
  with nothing left at work it is neither handed over nor merged at its end,
  and sends no `execution_complete`. The hold is held from whatever the run
  was — the scheduler driving it, a task started alone, or a run that ended on
  a failure — and goes back to that once released, so a task started alone
  never becomes a scheduled run, and an ended run is still the one a retry
  continues (`nextRunState`). When the runner's message says when the limit resets
  (`readUsageLimitReset`, beside `classifyRunnerStop`: Claude Code and Codex
  do; OpenCode passes its provider's error through and adds no time), the task
  gets a resume time, saved with the plan: the reset plus a minute. Tasks
  paused on one runner share one wait, at the latest of their resets, and
  resume together. A resume is a continue (K1) of the task's saved session —
  a fresh attempt where none was saved — told the limit has reset, and once
  nothing else waits on a reset, the hold on the run is released, whether or
  not a task failed meanwhile (ADR-0034). The last wait going any other way —
  the task marked complete, its resume cancelled, or the task leaving the
  plan — releases the hold the same way; a task still paused without a resume
  time keeps only its own runner's tasks from starting. Its message says the limit has reset and reports what K1 did with
  the previous work: restored in the working tree, or a conflict fallback to
  the integration tips with the preserved branches named. The saved session
  and its working files must agree for an unattended run to carry on after a
  limit. Nobody has to wait for the reset when the limit resets early: *Resume
  now* (`resumeNow`) — on the task row, or a message sent to the paused task,
  which follows the reset notice in the same continuation — resumes it in its
  saved session at once, with or without a resume time, and with it every task
  waiting on that runner's reset, as the reset itself would. A Resume now the
  asked task cannot take — every slot taken, or the task not approved — is
  refused before anything changes, so every resume at the reset stands. A task
  it sweeps along that cannot start keeps its resume time and waits for the
  reset; only at the reset does one that cannot start wait for the user. The planner and
  the supervisor ask for it with `retry_task` from `session`, or `message_task`;
  a pause is not a failure, so the supervisor's identical-retry guard does not
  apply, though it counts against its retry limit. A task with no saved session
  is not resumed this way; a fresh retry starts it over. A resumed attempt,
  automatic or asked for, that hits the limit again within five minutes waits
  for a manual retry, and says so. Loading a saved session clears its scheduled
  resume times, whether still ahead or already passed, and leaves the tasks paused for the user to resume
  explicitly. The hold lives with the run, not the plan: opening an old session
  never starts a task or spends tokens. Cancelling
  the resume (the task row and the task view) and stopping the run
  both leave the task waiting for a manual retry, as one with no readable
  reset waits. Moving a task to another runner, through a direct edit or the
  planner, cancels its resume through `cancelScheduledResume` before changing
  its assignment and makes a paused task ready for the scheduler's next slot.
  A task that is not paused is moved the same way, and its next start is the
  user's Retry. Either way the next attempt is a carry-over (attempt kind
  `carryOver`, owed through the task's `carriedFrom`, which a Retry after a
  move sets from the session's owner and which is saved with the plan until
  that attempt runs): a fresh session on the new runner, its worktree restored from
  the paused attempt's work as K1 restores a continue's, and its prompt told
  the files come from a previous attempt on the old runner and may be
  unfinished. When that work conflicts with what landed meanwhile, the
  attempt starts fresh from the integration tips, as before, and both its
  prompt and the task log name the branches holding that work. A shared run's
  carry-over finds the edits already in the checkout. Other
  tasks on the old runner keep their shared wait and pending work on that
  account stays held. A model change on the same runner keeps the resume:
  the limit belongs to that runner's account. The orchestrator's
  `onUsageLimitWait` announces each pause and
  each change to its resume, with the time or null, for a supervisor to wake on;
  a cancelled resume is marked as one, so it wakes nobody.
- **Task log persistence (P1).** Append-only, per attempt, at
  `.ordewell/sessions/<session>/tasks/<task>/<attempt>.jsonl`, holding
  normalized events with long tool output trimmed; a run's text events carry
  its id, and consecutive deltas are merged only within one run. The same
  reducer rebuilds the view on reload, a log saved before runs carried an id
  included. Every runner exit records `runner_ended`, closing the view's
  turn and its streaming blocks even when every tool call has returned. A
  settled plan status wins over a stale live turn on the surfaces. Both
  surfaces use core's pure `followTaskLog` to buffer batches during every
  saved-log read and join that attempt's batches by the read's stream
  position, taken synchronously with the read. A batch already covered by
  the read is skipped even if its socket delivers it later; a newer
  attempt's batch is kept because it belongs to another file. The view
  follows newer attempts unless the reader picks an earlier one, and
  ignores late batches from older attempts. Earlier attempts are kept,
  and the log is deleted with the session.
- **Approvals (A1, #56).** A runner's tool request goes through `IApproval` /
  `PendingApprovals` / `resolveApproval` as a new kind, `runner_tool`, carrying
  the task id, with **no timeout** (the planner keeps its five-minute
  auto-deny; a task's request waits for a person). The answers are *Allow*,
  *Allow for this task* (Claude's own session-scoped permission suggestions,
  offered only when Claude provides them) and *Deny* with an optional note
  back to the agent. The card appears in the task log, with a notice line in
  the TUI and a badge on the VS Code card. Cancel, stop and retry deny pending
  requests, so nothing is left hanging. The supervisor (#28) can answer through
  the same seam later; nothing assumes a human is the only answerer. An
  OpenCode answer is decided only after its HTTP reply succeeds. A failed
  reply keeps the request open and adds a task-log warning, so its card can
  take another answer. OpenCode reconnects a lost event stream once during
  a turn; another loss fails the turn in plain words, since unseen permission
  requests cannot be answered.
- **Surfaces (V1, #57).** In the TUI, Enter on a task in the plan pane
  swaps the chat pane to the task view: a distinct accent colour, a state
  header, a `→ Task N` composer label whose `/` is the runner's (R1), and Esc
  to return. In VS Code each task
  that has started an attempt has an editor tab opened on demand ("Open
  chat"); a task never run has no chat, and the control is absent. It never
  opens automatically, reopening focuses it, and closing it never affects the
  task.
  The card keeps its one-line peek and gains a waiting badge.
- **No tmux, no `script` (W2).** A session is a plain child process speaking
  a protocol and needs neither. Runner execution also works on native Windows
  (ADR-0010); the TUI itself remains unverified there.

### Codex specifics

- **Start and Continue.** `thread/start` takes the sandbox, approval policy and
  reviewer from the manifest's per-mode settings. A resume sends
  `thread/resume` with the full start params, because a bare thread id resets
  the approval policy.
- **Interrupt (M1).** `turn/interrupt` requires the turn id as well as the
  thread id. An interrupt asked for before Codex has named the turn is sent
  once it does.
- **Approvals (A1).** Command, file-change and permission requests become
  runner approvals. *Allow for this task* is `acceptForSession` or a
  session-scoped grant. Codex's decline carries no message, so a deny note is
  steered into the running turn. A yes-or-no MCP elicitation is an approval
  too. One that asks for input is declined.
- **Questions.** `item/tool/requestUserInput` is refused with an instruction to
  ask in plain text and end the turn. The question then arrives as a turn
  without a completion call (W1). Any other request gets `-32601` at once, so a turn
  never waits on Ordewell.

## Out of scope

#58 (take over in the runner's own TUI), #26 roll-ups, #31. No terminal
transport is retained for take-over.

## Considered options

- **Keep scraping and get better at it.** Each fix so far was specific to one
  runner, and #11, #13 and #14 were bugs in exactly this path. Rejected as the
  foundation.
- **Keep the runner TUI and add side channels.** Rejected: hooks differ per
  runner and keystrokes cannot guarantee message delivery at a step boundary.
- **ACP for every agent immediately.** Deferred: native connectors already
  work. ADR-0025 records ACP as the expected successor for third-party harnesses.
- **Optional structured capabilities on `ITerminalSession`.** Once adopted to
  coexist with terminals; rejected now because every session has the same
  structured contract (`IRunnerSession`).
- **Raw JSON to `onOutput`.** Rejected: tool results would flood the bounded
  output buffer; full-fidelity consumers read events instead.
- **No reminder; a turn without the call always waits for input.** The
  earlier rule. Runs stalled on tasks whose work was done and reported, until
  a person typed "call task_complete" (#105).
- **Treating a final report in the text as completion.** Verdicts come only
  from `task_complete`; the text is the runner's, and guessing would let a
  confident summary pass unverified work.
- **Reminding on every such turn.** A runner that is asking the user something
  would be told to finish again and again; once is enough to catch a missed
  call.
- **A new `TaskStatus` for waiting, or `in_progress` plus a flag.** Waiting is
  a reason for the existing `awaiting_user`, which every surface already
  handles; a flag would leave two sources of truth.
- **`awaiting_user` for approvals too.** Status churn and a plan save on every
  request, for something that does not end the turn.
- **Per-task transport** (a setting on each task). The plan would carry a
  transport field on every task for the user to maintain; the supported connector set (S3) already defines what can run.
- **Structured as an opt-in, terminal the default or fallback.** Previously
  adopted while connectors matured; rejected because maintaining two transports
  duplicates runner behavior. Every supported runner now has a connector.
- **A prefix or a menu that keeps Ordewell's commands in the task chat beside
  the runner's.** Two namespaces in one composer, and Ordewell's `/compact`
  shadowing the runner's; the run and plan commands already have the plan
  pane, its keys and the planner chat (#66).
- **Typing `/name` as a plain message, with no list.** It reaches a runner
  only at a turn's start, offers no completion, cannot tell a typo from a
  command, and leaves nothing in the log but text.
- **A user-facing transport setting.** Previously adopted; rejected because
  it permits selecting an obsolete path and leaves ambiguous saved choices.
- **A lingering process after pass.** Rejected: the
  log lives in Ordewell and what the agent did after the verdict would be
  unverified.
- **The adapter keeping its own mode table.** A second definition of what a
  mode means, against ADR-0001; the manifest owns it.
- **Live-only task logs.** A reload would lose what the task did.
- **A usage limit fails the task, or waits for a manual retry only.** The
  first paints a red X on work that only has to wait; the second, the
  behaviour before #84, leaves a run started overnight idle from the first
  limit hit until someone retries it. Resuming continues what the user
  started; it is not new consent.
- **Resuming early only by a fresh retry.** The behaviour before Resume now:
  a continue refused a paused task and a message found no turn, so the only
  way past a limit that reset early threw away a nearly finished attempt and
  spent the quota just reset repeating it.
- **Keeping the runner up across the wait and messaging it at the reset.**
  A process held for hours, or days for a weekly limit, is lost on any daemon
  restart, so the continue path is needed regardless; it is also the only one
  after a runner's process exits on the limit.
- **Continuing from the integration tip with only a warning to check the
  tree.** Previously adopted; rejected because the saved session remembers
  edits that the new tree omits, and an unattended agent is not told where
  they went. Restoring the preserved work keeps that session usable; naming
  its branches is the conflict fallback.
- **Continuing directly from the kept branch without bringing the integration
  tip along.** Rejected because it omits work landed while the task waited.
  Merging the previous work into the current tips preserves both when clean.
- **A wait per task.** A limit belongs to the account a runner signs in with,
  and the runner is usable only once every limit it hit has reset.
- **Starting a moved task fresh from the integration tip.** Previously
  adopted; rejected because the new runner redid work already on disk, which
  sat unseen on the paused attempt's kept branch.
- **Reading Claude Code's `rate_limit_event`.** Its stream-json reports the
  reset as an epoch too, but the printed message covers both runners that give
  a time, and both ways a limit arrives, with one reader per runner.
- **Continuing a session on a runner it does not belong to.** Rejected: the new
  runner cannot open it and the attempt would fail; Continue is not offered
  after a move.
- **A Retry after a move that starts clean from the integration tips.** The
  behaviour when only a paused task's move carried work over: the earlier
  runner's files were discarded unseen. The carry-over is the same for every
  move.
- **Storing the log inside the session JSON.** That file is rewritten on every
  save; an append-only file per attempt is not.

## History

- 2026-09-29 — accepted: structured opt-in, Claude Code only.
- 2026-10-01 — the Codex connector (#54).
- 2026-10-02 — the OpenCode connector (#55); structured the default, terminal the fallback, tmux optional (#61).
- 2026-10-04 — the OpenCode connector speaks the 2.x API as well as 1.x.
- 2026-10-06 — M1 per ADR-0023: messages reach a running turn between tool calls, the turn-end queue as the fallback, force send.
- 2026-10-09 — the `runnerTransport` setting and its surfaces removed; a saved plan pinned to `terminal` loads as structured and the field is dropped.
- 2026-10-09 — aligned with [ADR-0025](0025-structured-only-runners.md).
- 2026-10-10 — the TUI task-log surface corrected to Enter on a task in the plan pane.
- 2026-10-11 — U1: a task paused on a usage limit resumes on its own at the reset (#84).
- 2026-10-11 — a cancelled resume is marked on `onUsageLimitWait`, and a task going silent is announced (`onTaskIdle`), for the supervisor ([ADR-0029](../supervision/0029-the-supervisor.md)).
- 2026-10-11 — direct and planner runner changes share resume cancellation and scheduler readiness; same-runner model changes preserve the account's wait.
- 2026-10-11 — K1 and U1 preserve a continued attempt's unlanded work, with an atomic conflict fallback naming the preserved branches.
- 2026-10-13 — a runner's end is observed at `close` (after stdout drains) with its last unterminated line flushed, and a throwing event consumer ends the turn rather than crashing the host or passing as a bad frame.
- 2026-10-13 — W1: one completion reminder per attempt before a turn without `task_complete` waits for input (#105).
- 2026-10-14 — U1: Resume now — the user, planner or supervisor resumes a task paused on a usage limit early, in its saved session.
- 2026-10-14 — C2: the completion contract moved from the first message into the runner's instructions, where its own compaction keeps it whole.
- 2026-10-14 — R1: a task's chat speaks its runner's own slash commands; the task log records commands, compactions and what the runner loaded (#66; Claude Code, Codex, OpenCode and the TUI).
- 2026-10-14 — R1: VS Code task cards and log tabs complete and invoke native runner commands and draw the runner’s command, compaction and loaded-configuration blocks.
- 2026-10-14 — U1: a paused task moved to another runner carries the paused attempt's work over to a fresh session (#94).
- 2026-10-17 — K1/U1: a saved session records its owner and Continue never crosses runners; a Retry after any move to another runner is a carry-over, not only a paused task's; a limit counts only in a turn Ordewell started, and a runner's structured field decides over its words ([ADR-0041](../routing/0041-a-tasks-model-follows-the-runners-own-switch.md), [ADR-0044](../planner/0044-the-planners-usage-limit-waits-and-resends.md)).
- 2026-10-18 — U1: a held run stays open with nothing at work; the reset releases the hold whatever failed meanwhile; a refused Resume now changes no resume, and a task it sweeps along keeps waiting for its reset; a loaded plan's reset resumes only its paused tasks.
- 2026-10-18 — O1/P1: text is kept by run — written once to the plain text, settled in its own block, merged only within its run; older logs replay as before.
- 2026-10-18 — B1/A1: only main-thread work opens a turn; routed terminal events end it immediately, HTTP permission answers wait for delivery, and a lost OpenCode event stream gets one reconnect before the turn fails.
- 2026-10-18 — P1: saved and live task logs join by stream position through one follow reducer, and every runner exit closes its view's turn.
- 2026-10-18 — U1: the hold on a run is released however its last reset wait goes — Mark complete, a cancelled resume or the task leaving the plan — not only at the reset.
- 2026-10-18 — O1: a run's late copy that adds to its deltas after another run or a tool line was written starts its addition on a line of its own.
- 2026-10-18 — U1: loading a session clears saved resume times and keeps paused tasks idle until explicitly resumed.
- 2026-10-19 — L1: an attempt's runner stops at its verdict, before the landing, by interrupting the turn and taking the runner's last report (Claude Code's cost and window) before the process goes; a continue waits for that wind-down, and what the runner would still write after `task_complete` is cut short. A plan adopted during one is a new scope, and the old runner's late reports are dropped.
- 2026-10-22: the turn that reported `task_complete` closes itself within the interrupt grace before its report is published, so the tool reply reaches the runner; a turn still open at the grace has its report published then and is stopped.
- 2026-10-24 — U1: the three ways a limit arrives — an exit mid-turn, a failed turn, a refused start — are one pause, owned by `LimitPauses`; a refused start now settles as a verdict does.
- 2026-10-24 — U1: a pause also holds a run that ended on a failure, which it goes back to once released; the hold is an event of the run's state (`nextRunState`).
- 2026-10-25 — the VS Code task-log control reads "Open chat" and appears once an attempt has started.
- 2026-10-26 — L1: an accepted `task_complete` call is shown received at once, while its turn closes and its attempt winds down; the receipt is no verdict and is never saved.
