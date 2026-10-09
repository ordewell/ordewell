# 0018 — Structured runner transport: drive task runners through their programmatic protocol

**Status:** accepted

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
  supplies events, messages, interrupt, approvals, native session id and task
  tools. These methods are mandatory, without a capability discriminator.
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
  per tool call (`› Bash(npm test)`), no JSON and no ANSI. It feeds
  the planner's live-output read (#3), usage-limit
  classification and the fallback summary handed to dependents.
  (b) *A full-fidelity view* built from the structured events as ADR-0017
  display blocks: streaming text, thinking, expandable tool calls with
  arguments and results, nested subagents, usage, approval cards. Channel (a)
  is deliberately lossy; nothing that needs fidelity reads it.
- **A turn without a completion call is "waiting for input" (W1).** A turn that ends
  without a `task_complete` call makes the task `awaiting_user` with a saved reason:
  `input | checkpoint | conflict | files-changed`. A checkpoint wins over input. There is no
  automatic nudge — no verdict is guessed, and the user (later the supervisor,
  #28) responds or marks the task complete. Approval requests arrive
  mid-turn and do **not** change task status: "waiting for approval" is derived
  from the task's pending approvals. The idle timer keeps running during a turn
  and is paused while the task waits, on input, a checkpoint or an open
  approval, so a long approval wait does not also read as idle. If a queued message is delivered as the
  turn ends, or the runner still owes one it was handed (M1), the task stays
  `in_progress` with no flicker.
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
- **Background work (B1).** Claude Code reports a turn's `result` when the
  model stops talking, even with a background shell or agent still running, and
  opens a turn of its own when the work finishes. The Claude connector therefore
  holds a task's turn open while the CLI lists background tasks, so later output
  belongs to the same turn. Completion evidence arrives through the MCP tool,
  independent of the output stream. If the CLI starts
  no follow-on turn once the list is empty, the turn ends after a short grace.
  Anything a runner does by itself after a turn has closed is delivered to the
  session as a turn of its own, with no user message, instead of being dropped.
- **The plan's mode is held (B2).** `--permission-mode auto` on a model or
  account without auto mode is not refused: the CLI starts in `default` and
  asks about every write. The connector compares the mode `init` reports with
  the one the plan asked for and fails the turn in plain words on a mismatch
  (ADR-0001).
- **Lifetime (L1).** The process ends once its task passes. The log lives in
  Ordewell, and work after the verdict would go unverified. The native session
  id is saved per attempt.
- **Continue (K1).** A retry that resumes the saved native session with the
  user's message as the next turn. It is verified and landed like any attempt.
  It is offered on completed and failed structured tasks with a saved session
  id, not on conflicts. Dependents are left alone, as with retry. If the runner
  refuses the resume, the attempt fails; no fresh session is started in its
  place.
- **Task log persistence (P1).** Append-only, per attempt, at
  `.ordewell/sessions/<session>/tasks/<task>/<attempt>.jsonl`, holding
  normalized events with long tool output trimmed. The same reducer rebuilds
  the view on reload. Earlier attempts are kept, and the log is deleted with
  the session.
- **Approvals (A1, #56).** A runner's tool request goes through `IApproval` /
  `PendingApprovals` / `resolveApproval` as a new kind, `runner_tool`, carrying
  the task id, with **no timeout** (the planner keeps its five-minute
  auto-deny; a task's request waits for a person). The answers are *Allow*,
  *Allow for this task* (Claude's own session-scoped permission suggestions,
  offered only when Claude provides them) and *Deny* with an optional note
  back to the agent. The card appears in the task log, with a notice line in
  the TUI and a badge on the VS Code card. Cancel, stop and retry deny pending
  requests, so nothing is left hanging. The supervisor (#28) can answer through
  the same seam later; nothing assumes a human is the only answerer.
- **Surfaces (V1, #57).** In the TUI, Enter on a task in the plan pane
  swaps the chat pane to the task view: a distinct accent colour, a state
  header, a `→ Task N` composer label, and Esc to return. In VS Code each task
  has an editor tab opened on demand ("Open log"); it never opens
  automatically, reopening focuses it, and closing it never affects the task.
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
- **A user-facing transport setting.** Previously adopted; rejected because
  it permits selecting an obsolete path and leaves ambiguous saved choices.
- **A lingering process after pass.** Rejected: the
  log lives in Ordewell and what the agent did after the verdict would be
  unverified.
- **The adapter keeping its own mode table.** A second definition of what a
  mode means, against ADR-0001; the manifest owns it.
- **Live-only task logs.** A reload would lose what the task did.
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
