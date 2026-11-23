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
  (`app-server`), OpenCode (`serve`) and GitHub Copilot CLI (ACP over stdio,
  through the one ACP connector,
  [ADR-0060](0060-acp-runners-are-data-on-one-connector.md)) are the only
  supported runners. Plugin manifests are ignored with one notice at host
  startup.
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
  or owed. A turn is interrupted when its runner says so or when Ordewell
  asked for an interrupt in that turn and the runner did not refuse it, even
  if the model finished as the request landed, so every runner ends the same
  race the same way and no reminder follows a user's interrupt; only an error
  of the turn's own, such as a usage limit, outranks it. One module,
  `TurnOutcome`, holds that rule for every adapter. A subagent an interrupt cut
  short finishes `stopped`, not `failed`, by the same latch, and
  `SubagentTracker` reports each subagent's start and finish once for every
  adapter. Only a `task_complete` call settles the task; if the reminder's
  turn ends without one, the task waits for input and the user (or the
  supervisor) responds or marks it complete. The reminder asks for no new
  work, so the summary handed to dependents keeps the report written before
  it. Approval requests arrive
  mid-turn and do **not** change task status: "waiting for approval" is derived
  from the task's pending approvals. The idle timer keeps running during a turn
  and is paused while the task waits, on input, a checkpoint or an open
  approval, so a long approval wait does not also read as idle, and while a
  tool call is in flight, from its `tool_call` until its `tool_result` or its
  turn's end, so a runner waiting on a long command it started is not flagged
  quiet while one with no call in flight and no output still is. Each flag in
  an attempt doubles the silence the next one needs, and a new attempt starts
  over, so a long run that prints now and then does not wake its reader again
  after every line. An AI task's attempt is also flagged
  **running long**, as advice and never a verdict: once its running time
  passes the larger of 30 minutes and three times the longest running time of
  an AI task that passed in its plan (its attempt's, kept as it ends; an attempt
  saved before that has only its wall time). Once five AI tasks have passed
  (the same set), the larger of 19 minutes and three times their median
  running time applies where it comes first: one slow pass stretches the
  longest, and in a recorded run whose slices took a median of 6 minutes two
  ran on near 40 and were first flagged by their context, 41 minutes in; on
  the recorded runs replayed, 19 flags those two at 19 minutes and at most one
  in ten ordinary passes, where 10 flagged a fifth of one run's. Until the
  first flag the threshold is read again at least once a minute, so a task that
  passed meanwhile can put that flag off or bring it forward. Every later flag
  is due at exactly twice the last, whatever passes do to the threshold since:
  read again, it rose with the median, and two slow tasks of a recorded run
  were not flagged a second time in over an hour. The first flag names which
  comparison fired: the longest pass, or the median and how many passed; a
  later one names the flag it doubles. A flag still waiting for a wake when its
  attempt passes or fails is dropped: it advised on an attempt that has ended
  (ADR-0057 R4). An attempt that follows one of the same task that failed or was
  stopped (the ending is kept on that attempt's usage as `outcome`) is first
  flagged at the larger of 30 minutes and that attempt's running time instead:
  a retry already had that long once, and a retry of a task that failed after
  42 minutes ran 108 minutes before a plan-wide threshold flagged it. Only running time counts: a wait on input, a checkpoint or an
  approval holds the clock, and is left out of a passed task's running time
  too, and a usage limit ends the attempt. An automatic
  compaction of the task's own runner session flags it, whatever the time, and
  so does a large context before any compaction; a manual compaction and a
  subagent's context do not. C4 holds when a task compacts, which compactions
  are routine, and what counts as a large context. The runner is told nothing. It reads the context as the flag's own
  facts do, so it applies to every runner that reports its context and its
  model's window, and stays silent while either is unknown: Claude Code states
  its window on a turn's last line, so a first long turn on a model the
  session has no window for flags only on time and compaction. The flag says
  which of time, compaction and context raised it, and carries the
  running time, the threshold and the task it was computed from, the live
  context and the model's window, the window Ordewell set the runner to
  compact at when it did (the context line names it, the model's beside it),
  the peak context (the saved usage keeps only
  the last) and the compactions so far. The live context and window follow
  the usage meter's rules: a compaction that states no size, or a change of
  model or source, leaves the context unknown until the next call measures it,
  never the old size, and a new model is not measured against the old one's
  window. The task's context meter reads the same way (C4 says against what). A
  script task has its `timeoutMs` and
  a delegated task its `budget.wallClockMs`, so neither has this clock; a
  delegated task's children do. Nothing is re-flagged after a restart: a plan
  load ends every interrupted attempt, and the flag is the attempt's. The
  supervisor reads it as it reads a quiet task's (ADR-0057 R4), and rows and
  cards say "Running long" while the task runs (`RunningLong.ts`,
  `VerdictEngine`). If a queued message is delivered as the
  turn ends, or the runner still owes one it was handed (M1), the task stays
  `in_progress` with no flicker.
- **The completion contract lives in the runner's instructions (C2).** A
  runner compacts its own context (Claude Code's auto-compact, Codex's
  auto-compaction, OpenCode's summarize-on-overflow), and what it keeps of the
  first message is its own summary or a truncated copy. How a task ends — call
  `task_complete` with `done` and the full report, or `blocked`/`failed` and the
  reason — is therefore not in that message: it is the system prompt
  (`--append-system-prompt-file`, a file the process owns, never text on its
  command line: [ADR-0010](../platform/0010-windows-support.md) §1), the
  thread's `developerInstructions`, or
  OpenCode's `system` / instruction entry, or the built-in runner's system
  prompt ([ADR-0070](0070-the-built-in-ordewell-runner-runs-in-process.md)),
  applied again on every resume. ACP
  has no system-prompt field, so an ACP runner takes the contract through its
  own channel outside the worktree (an owner-only file it is pointed at, or a
  documented `session/new` field), or else as a preamble on the first prompt
  of every new process, a resumed one included (ADR-0060 R6). Never as a file
  in the worktree. The first message is the task's prompt and its context
  only. The attempt's token is not part of any of it; it travels in the MCP
  connection.
- **A runner that meets its brief stops, and a compaction says so again (C3).**
  A runner can meet its brief's done criterion and keep going into the scope of
  later tasks, never committing or calling `task_complete`; compaction makes it
  likelier, since its own summary may drop where the brief ended. The contract
  (C2) therefore says that once the brief's done criterion holds the runner
  commits, if its work lands as a commit, and calls `task_complete`, and that
  work beyond the brief belongs to other tasks and goes in the handoff as an
  open question or a follow-up. And when a task's runner reports a compaction
  of its own session it started itself (`trigger: 'auto'`; the user's
  `/compact` is not one), Ordewell sends it one message through the queue
  `message_task` uses (M1), marked `from: 'ordewell'` and logged as any queued
  message is: the task's title and description, and that if what the brief asks
  is done it should commit (a task that lands nothing is not asked to) and call
  `task_complete` now, leaving work beyond the brief to other tasks. It is sent
  once per compaction, so two give two. It is never sent to an attempt that has
  ended or decided, or whose task waits on the user, whom a message would put
  back to work. A harness that takes nothing mid-turn delivers it at its next
  turn, as it does any queued message (ADR-0023 D4). It asks for no verdict: only
  the `task_complete` call settles the task (W1). Nor does it hold one back: a
  `task_complete` call made while it is still queued settles the task, as it
  would without it (ADR-0023 D6).
- **When a task compacts is one rule for every harness (C4).** A runner
  compacts its own context (Claude Code's auto-compact, Codex's
  auto-compaction, OpenCode's summarize-on-overflow, an ACP agent's own
  policy, the built-in runner's `Compactor`), and compaction is a guard on
  capacity, not a quality tool: a summary loses detail and the prompt cache,
  and a task re-reads what it had read. So by default no task is made to
  compact before its harness would near the model's own window, and a task that
  outgrows its brief is the supervisor's to notice, not the summary's to
  absorb. One setting, `taskCompactAt` in the global `settings.json`, which
  `ORDEWELL_TASK_COMPACT_AT` overrides when it is not blank, takes `auto`, the
  default; `off`; or a whole number of tokens above zero, the context size at
  which compaction starts, whatever the harness or model. Any other value
  refuses the task's start, saying what is accepted. A planner never reads it.
  Each harness is given the setting through the one control it has; the
  per-harness table is in
  [planners-and-runners.md](../../planners-and-runners.md#when-a-tasks-context-compacts):
  - **Claude Code** takes a window, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; its CLI
    starts compacting a fixed buffer below it (32,000 tokens, inferred from
    recorded sessions), so a number is sent as that plus the buffer, held to the
    CLI's 100,000 to 1,000,000 with a log line when it moves. `auto` sets none,
    except for Haiku, which charges several times its base prices over a
    100,000-token prompt: its window is set for compaction to start just under
    that step. `off` sets none, Haiku's included. A window inherited from
    Ordewell's own environment (a nested Ordewell started from a task) is
    dropped from a task's launch under every setting, so `auto` and `off` mean
    the CLI's own.
  - **Codex** takes `model_auto_compact_token_limit` (scope `total`) at
    `thread/start`, held to at least 16,000; Codex compacts at 90% of its
    window at most, so once it reports the window a number above that is held
    there, each with a log line. **OpenCode** takes `compaction.reserved` (the
    model's window less the number, held to 16,000 from either end with a
    warning, and nothing set for a model whose window is unknown, with a
    warning). Each is for a number only; `auto` and `off` set nothing, and the
    compaction room a task's inherited `OPENCODE_CONFIG_CONTENT` carries is
    dropped from it. OpenCode 1.x applies `reserved` only to a model with an
    input limit; the version is known only once the server answers, so for any
    other model a 1.x task says in one line that the number is not applied and
    keeps no start, as under `auto`. An inline config that cannot be read takes
    no start either.
  - **An ACP agent** exposes nothing to set, so a number is warned about, once,
    as one that cannot be honoured, and nothing is passed; `auto` and `off` are silent. Its
    compactions are inferred from a fall of more than half in its reported
    context from above 32,000 tokens, or half the window where that is less,
    outside a turn that runs one of the agent's own commands (a listed name,
    or before the agent lists any, a slash and a bare name, not a path).
  - **The built-in runner** reads the setting itself: a number is clamped to
    what its guard allows (the window less its reserve), with a line in the
    task's log when it moves; `off` is not honoured, since without compaction
    the runner would run into its provider's limit, so it compacts as `auto`
    does, and says so in the log (ADR-0070). A request the provider refuses
    as too long shrinks the window the guard reads, which can bring the start
    below the number; the start it reports follows, and the refusals of one
    step are announced as one compaction.

  What Ordewell sets is kept on the session as `compactWindowTokens`, the
  window in force, and, where the setting itself is the start (Codex, OpenCode,
  the built-in runner), as `compactStartTokens`; Claude Code's start is
  inferred from its window as the window less the buffer. The context meter
  reads against where compaction starts when a window is in force (`ctx 61k
  (52% · compacts at 118k)`) and against the model's window otherwise (`ctx 61k
  (6%)`), and follows the start as it moves during an attempt. The running-long
  clock reads the window in force as the start plus Claude Code's 32,000-token
  buffer on every harness, so one number counts alike whichever runner holds
  it. A model whose own window is smaller than the one set is no reason to
  set less: the harness compacts at the smaller of the two.

  An automatic compaction is reported on every harness as the same
  `compaction` event, and three things follow from it alike: the meter resets
  to the compacted size (a compaction that states no size leaves the context
  unknown until the next call measures it), C3's reminder of the brief is
  queued once, and the running-long clock counts it. Under a window in force
  below 200,000 tokens a compaction is routine and flags from the attempt's
  third, then the 6th, 12th and so on, since a task compacts a few times in
  ordinary work there; at 200,000 or more, or where Ordewell sets none and the
  harness compacts near its model's own window, every compaction flags.
  A large context flags too, before any compaction: once the task's context
  first reaches 40% of its effective window, the smaller of the model's window
  and a window Ordewell set, and never below 150,000 tokens, then again at each
  doubling of that size while it stays below the effective window, once per
  size and never after the attempt ends. An attempt that continues a saved
  session takes the context its first call carries over as its baseline: a
  size at or under it does not flag, so its first is the next doubling above
  it. Seen live: a continued attempt that carried 449k of a 1,049k window was
  flagged a second in, and the supervisor spent a turn on a task just begun.
  Quality falls with a context's
  length well before its window is full, though no measurement gives a point,
  so both numbers are a judgement (`CONTEXT_SHARE`, `CONTEXT_FLOOR_TOKENS`); and
  the remedy is a fresh session with a handoff, which is the supervisor's to
  start (ADR-0057 R4), not a summary. The flag applies to every runner that
  reports its context and its model's window and stays silent on that count
  while either is unknown. `RunningLong.ts`, `compactionStart.ts` and
  `taskCompactWindow.ts` hold it; the pinning test is
  `compactionPerHarness.test.ts`.
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
  still leaves the view once nothing queued is left to take back. Claude Code (checked on 2.1.299): the `initialize`
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
  asks about every write. Claude Code's documentation offers Auto on every
  plan, but only for some models (on Anthropic's API, Opus and Sonnet 4.6 or
  later, Haiku 5.5 and the Fable models; fewer on Bedrock, Vertex and
  Foundry), and an administrator or Anthropic's server can turn it off. The
  connector compares the mode `init` reports with the one the plan asked for
  and fails the turn in plain words on a mismatch (ADR-0001), naming both
  modes in the error event (`modeRefused`). Nothing ran, so the attempt ends
  at once: its verdict says what happened in the user's words and, where the
  mode the runner did start in is another the manifest lists (never its
  read-only profile), offers it. The offer is the user's own switch, the
  escalation option `switch-mode`: a hand edit of the task's mode, then a
  retry. Nothing switches a mode for the user. Every task not started that
  would meet the same refusal (the same runner, mode and model, since the
  runner decides by model and account) is held before it starts, and the run
  is told once. The failed task's one escalation lists them and its switch
  takes them along; each one's own hold is left out of the list while it does.
- **Lifetime (L1).** The process ends with its attempt, and at a verdict as
  soon as the verdict is accepted, not once the work has landed: the log lives
  in Ordewell, and work after the verdict would go unverified. It ends the way
  the runner ends a turn. A turn still open gets the soft interrupt, except the
  turn that reported `task_complete`: its tool reply is still in flight, so
  that turn is left to close by itself within the interrupt grace. The report
  is published once it closes; if it is still open at the grace, the report is
  published then, and the stop the verdict orders gives the runner one more
  grace to close before it is killed. A provider bills a request cut off
  mid-stream, and OpenCode records an interrupted step as zero, so where the
  runner says when a step starts and ends (OpenCode 2.x), a wind-down after
  `task_complete` lets that turn's step in flight end by itself within the
  interrupt grace before interrupting; a second stop kills at once. An aborted
  OpenCode 2.x turn is interrupted, and the server disposed of once it has
  acknowledged, or after one second, short because the abort is often a user's
  stop. In the common path the attempt lands only
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
  id. The native session id is saved on the task as soon as the runner reports
  it, and again as the attempt ends, with the count of its cost the session
  ended on: an Ordewell that dies unasked winds nothing down, and a restart
  reads only what was saved, so a task it was running is still continued in
  that session.
- **Continue (K1).** A retry that resumes the saved native session with the
  user's message as the next turn. It is verified and landed like any attempt.
  It is offered on completed and failed structured tasks with a saved session
  id, and on one stopped mid-attempt (a Stop, the task's or the run's, puts it
  back to not started with its session saved and its worktree kept), not on
  conflicts, and only while the task is still assigned to the runner
  that session belongs to: a saved session records its owner
  (`runnerSessionOwner`; for a plan from before that, the runner of the last
  attempt), and a session cannot cross runners
  ([ADR-0041](../routing/0041-a-tasks-model-follows-the-runners-own-switch.md)). Dependents
  are left alone, as with retry, and unfinished dependencies or a merge gate
  refuse it as they refuse a retry. If the runner
  refuses the resume, the attempt fails; no fresh session is started in its
  place. An agent that offers no way back into a session (an ACP agent with
  neither `session/resume` nor `session/load`) is known only once it has
  started: the continue fails saying the runner cannot resume a saved session
  and that Retry starts the task afresh, and the saved session is dropped. In an isolated run the task workspace is recreated at the same path
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
  resume, and what follows is what follows a verdict. A park
  ([ADR-0074](../supervision/0074-a-task-that-needs-a-siblings-unlanded-work-parks-and-continues-once-it-lands.md)) ends its attempt
  the same way, holding no run and with no reason waiting on the user: the
  task is not started, and its next start continues the saved session once the
  work it waits for lands, or, where its runner saved none it can resume, is a
  carry-over of the parked attempt's files. A held run stays open
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
  the task marked complete, its resume cancelled, the task leaving the plan, or
  an edit making it manual, which holds no runner to wait for — releases the hold
  the same way; a task still paused without a resume
  time keeps only its own runner's tasks from starting. Execute, a planner's
  `run_plan` and signing off the review start nothing under a hold and take no
  resume back: they take the plan in, and what the hold then gives back is the
  plan's run. Its message says the limit has reset and reports what K1 did with
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
- **Provider errors (E1).** A turn that fails on its provider's error, not
  the account's or the task's, has not failed the task either: an HTTP 5xx,
  Claude Code's `API Error: 5xx`, an overload, OpenCode's `Provider returned
  error` unless a 4xx status other than 429 beside it, or words naming a
  context too long, say the request or the key was refused (OpenCode keeps an
  `APIError`'s status in its `statusCode`, which the adapter puts beside the
  words as `HTTP <status>`), a throttle the runner's own field says is not its usage limit
  (Codex's `rateLimitExceeded`), or the network to the provider failing: Node's
  error codes for a name that did not resolve or a connection refused, reset,
  unreachable or timed out (`EAI_AGAIN`, `ENOTFOUND`, `ECONNREFUSED`,
  `ECONNRESET`, `ETIMEDOUT` and their kin), Claude Code's `Can't reach the API
  server`, an SDK's `Connection error` or `Request timed out`, `fetch failed`
  or `socket hang up`; a bare "timed out", which a test's timeout prints, is
  not one. `classifyRunnerStop` reads it from the turn's
  error as `transient`, after U1: a usage limit, by its field or its words,
  keeps U1's pause. The task stays `in_progress` with no escalation, and the
  turn is tried again in its saved session, told the error, after 30, 60 and
  120 seconds, with a notice for each. A turn that ends any other way starts
  the count over, and a turn the user opens in the wait is the try and drops
  the pending one, as ending the attempt does. When the last try fails too, the
  task waits for input as any failed turn does, and the escalation's reason
  names the error. The error is the runner's text, so the notice, the try and
  the reason carry it redacted, as the rest of its text is. The planner's turn follows the same rule in `settleReply`,
  each call its provider failed resent in the same conversation; a stop during
  the wait ends it, and the turn settles on the error.
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
  header, a `→ Task N` composer label whose `/` is the runner's (R1), and Esc,
  which acts on the queue first: it takes back the newest message the runner
  has not been handed (into the composer only when that is empty; otherwise
  it is dropped), then clears the draft, and returns to the plan only once
  neither is left. A take-back the runner beat is refused, and the text Esc put
  in the composer comes out again. Send now (ctrl-s) delivers everything
  queued at once, the composer text last, as the planner chat's does. In VS Code each task
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
- **ACP for every agent immediately.** Rejected: native connectors already
  work, and ACP reaches Claude Code and Codex only through third-party shims.
  An agent with a native ACP server runs through the one ACP connector instead
  ([ADR-0060](0060-acp-runners-are-data-on-one-connector.md)).
- **Optional structured capabilities on `ITerminalSession`.** Once adopted to
  coexist with terminals; rejected now because every session has the same
  structured contract (`IRunnerSession`).
- **Raw JSON to `onOutput`.** Rejected: tool results would flood the bounded
  output buffer; full-fidelity consumers read events instead.
- **A fixed compaction window for every Claude Code task.** Shipped on
  2026-10-31 (a 150,000-token window) so that no task grew a long context.
  Reversed: a compaction costs the detail and the cache, the setting reached
  one harness only, and a task that outgrows its brief is better handed on by
  the supervisor than summarized. A user who wants it back sets a number.
- **One setting per harness.** A number of tokens means the same on all of
  them, and a user asking "where does my task compact" has one place to look;
  the harness-specific units (a window plus a buffer, a reserve) stay in the
  adapters (C4).
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
- **No Continue for a stopped task.** The rule before 2026-11-23: a Stop left
  the task not started, which Continue refused, so the only way on was a
  fresh attempt from the integration tip, its stopped predecessor's commits
  on a preserved branch it was not told of. Seen live: a supervisor stopped a
  task after 81 minutes of committed work, was refused the continue, and its
  fresh retry's note promised work the new worktree did not hold.
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
- **A provider error waits for input at once.** The earlier rule: an outage
  of a minute stopped an unattended run behind a "waiting for your input" that
  named nothing to answer.
- **A provider error pauses as a usage limit does (U1).** It holds every
  start on that runner for a reset nobody announced; the next turn usually
  gets through, and other tasks need not wait for it.
- **Retrying without a bound.** An outage that lasts would spend the run's
  time unseen; after the bounded tries the user decides.
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
- 2026-10-31 — K1: a continue waits on a task's dependencies and merge gate as a retry does.
- 2026-10-31 — U1: an edit making a paused task manual ends its pause as it lands; Execute, a planner's `run_plan` and signing off the review start nothing under a hold and take no resume back, and the reset gives back the plan's run.
- 2026-11-04 — S3: GitHub Copilot CLI runs through the ACP connector; C2: an ACP runner takes the contract through its own channel or a first-prompt preamble (ADR-0060).
- 2026-11-10 — W1: a tool call in flight pauses the idle timer until its result or its turn's end; each idle flag in an attempt doubles the silence the next one needs.
- 2026-11-10 — K1: the native session id is saved as soon as the runner reports it, so a task interrupted by Ordewell stopping can be continued; an agent that cannot resume fails the continue in plain words and points to Retry.
- 2026-11-10 — V1: in the TUI task view Esc takes back the newest queued message before it clears the draft or returns, and send now sends the whole queue, as the planner chat's keys do.
- 2026-11-12 — L1: a wind-down after `task_complete` lets an OpenCode 2.x step in flight end within the interrupt grace before interrupting, a second stop killing at once; an aborted OpenCode 2.x turn is interrupted, with a one-second grace, before its server is disposed of.
- 2026-11-13 — W1: an interrupt asked for and not refused ends its turn interrupted on every runner, even when the turn finished as it landed; an error of the turn's own still outranks it.
- 2026-11-13 — W1: a subagent an interrupt cut short finishes `stopped` on every runner, not `failed`, and one tracker per adapter reports each subagent's start and finish once, where the planner service did.
- 2026-11-14 — E1: a turn its provider failed (a 5xx, an overload, a throttle that is not the usage limit) is tried again in its saved session after a 30, 60 and 120 second backoff, the planner's as a task's, before input is asked with the error in its reason.
- 2026-11-14 — E1: a `Provider returned error` with a 4xx status other than 429 is not transient; the error is redacted wherever it is repeated.
- 2026-11-14 — E1: OpenCode's `APIError` status is kept beside its words, a status code written as `statusCode` or a quoted string counts, and a context too long is not transient without a status.
- 2026-11-14 — W1: an AI task's attempt that runs past max(30 min, 3× the longest passed AI task's wall time), doubled after each flag, or whose runner session compacts on its own, is flagged running long, as advice.
- 2026-11-14 — C3: the completion contract tells a runner to commit and call `task_complete` once its brief's done criterion holds and to name work beyond it in the handoff; after a compaction of the runner's own session Ordewell queues it one message restating its brief with that instruction.
- 2026-11-14 — W1: the running-long threshold is a multiple of a passed task's running time, waits left out, kept on its attempt as it ends; the live context and window follow the usage meter's rules across a sizeless compaction and a model change. C3: the queued nudge holds no `task_complete` back.
- 2026-11-15 — W1: a compaction flags running long from the attempt's third, then at the 6th, 12th and so on, where Ordewell sets the window the runner compacts at, and from the first where it sets none; the flag names that window. C3's reminder after each compaction is unchanged.
- 2026-11-16 — C2: a Claude Code task's completion contract is appended from a file the process owns (`--append-system-prompt-file`), no longer as text on its command line ([ADR-0010](../platform/0010-windows-support.md) §1).
- 2026-11-17 — C2: the built-in runner carries the contract in its system prompt too ([ADR-0070](0070-the-built-in-ordewell-runner-runs-in-process.md)).
- 2026-11-17 — W1: a Claude Code task's compaction window is the `taskCompactAt` setting (`auto`: none, except Haiku's, set to compact just under its price step; a number, where compaction starts; `off`), no longer a fixed 150k; a compaction is routine only under a window below 200k.
- 2026-11-17 — W1: a task's context reaching 40% of its effective window, never below 150k, and each doubling of that below the window, flags running long; the context meter reads against where compaction starts under a compaction window in force.
- 2026-11-17 — C4: when a task compacts is stated once for every harness: one `taskCompactAt` setting (`auto`, a number, `off`), what each harness is given, `compactStartTokens` for the meter, and the running-long and reminder effects; W1 refers to it.
- 2026-11-17 — C4: the running-long clock reads every harness's window as its start plus 32,000; Codex's number is held to 16,000 and 90% of its window; an inherited Claude Code window or OpenCode compaction room is dropped from a task's launch; OpenCode 1.x keeps no start for a model without an input limit; ACP infers compactions under small windows and after non-command slash messages; the built-in runner announces one compaction per step and reports the start in force.
- 2026-11-18 — W1: an attempt that follows a failed or stopped attempt of the same task is first flagged at max(30 min, that attempt's running time), not at 3× the plan's longest pass; the flag names that attempt.
- 2026-11-19 — W1: an attempt that continues a saved session takes the context it starts with as its baseline, so its first context flag is the next doubling above it; fresh attempts and the time and compaction flags are unchanged.
- 2026-11-20 — W1: once five AI tasks have passed, a first attempt is also flagged at max(19 min, 3× their median running time) where that comes first; the threshold is read each minute, the next flag is never under double the last, and the line names the median.
- 2026-11-20 — W1: a flag set by double the last one's time names that time, not the lowered threshold's doubling.
- 2026-11-21 — W1: after the first running-long flag the next is due at twice the last, the threshold no longer read again for it; a flag still waiting when its attempt ends is dropped.
- 2026-11-21 — U1: a park ends its attempt as a pause does and its next start continues the saved session, or carries its files over where none can be resumed (ADR-0074).
- 2026-11-21 — B2: a mode refusal fails its task in the user's words and offers the mode the runner started in as the user's switch; the tasks that would meet it too are held before they start, told once for the run.
- 2026-11-22 — E1: the network to the provider failing (its error codes, `Can't reach the API server`, `Connection error`, `fetch failed`) is transient too, so an outage is waited out on the backoff, a task's turn and the planner's alike. Seen live: two supervisor wake-up turns failed on `EAI_AGAIN` within seconds and supervision stopped.
- 2026-11-23 — K1: a task stopped mid-attempt, by its own Stop or the run's, with its session saved is continued as a failed one is, its kept worktree restored. Seen live: a supervisor's continue of a task stopped after 81 minutes was refused, and the fresh retry lost sight of its commits.
