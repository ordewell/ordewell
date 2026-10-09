# 0018 — Structured runner transport: drive task runners through their programmatic protocol

**Status:** accepted

A task's runner is a TUI in tmux (ADR-0007) or a headless one-shot process, and
Ordewell talks to it through the screen and the keyboard. "Done" and
checkpoints are found by scanning rendered PTY bytes (`VerdictEngine`,
`terminalRender.ts`); idle is guessed from silence, so "waiting on a permission
prompt" and "thinking" look the same; the only way to talk to a runner is
`ITerminalSession.write`, which types keystrokes and cannot promise they land
between turns; and what a run consumed is not observable.

The harness planners (ADR-0009) already talk to Claude Code, Codex and OpenCode
through their programmatic protocols (`stream-json`, `app-server`, `serve`).
Task execution did not. Issue #25 settled the design; this ADR records it.
Claude Code was the reference runner; Codex (#54) and OpenCode (#55) followed.

## Decision

**Task runners are driven through their programmatic protocol — the
*structured* transport. The terminal transport is only the fallback for a
runner with no structured connector.** A task on the structured transport is driven through its runner's
protocol instead of a screen and a keyboard.

## Key properties

- **Structured always; no transport setting (S1).** A task whose runner has a
  structured connector always runs structured. There is no setting, command or
  toggle to choose the transport. A saved plan that still carries a pinned
  `terminal` runs structured too, and the old field is dropped when the plan is
  loaded. The plan, not a live setting, says what runs (ADR-0001), and the
  route is decided per task (S3).
- **Drop-in shape (S2).** A structured session *is* an
  `ITerminalRunner`/`ITerminalSession`, the way `TmuxRunner` was added
  (ADR-0007 T1), so `VerdictEngine`, `TaskOutputSource`, `PoolAwareRunner` and
  the orchestrator need no change. What a terminal cannot do sits on an
  **optional capability** callers feature-detect, the way `writeControl` is
  detected today: send a message, interrupt, turn state, the event stream and
  the native session id. Code that does not look for the capability behaves as
  it did.
- **Per-task routing (S3).** A task runs structured if its runner has a
  task-mode connector: Claude Code, Codex (`codex app-server`) and OpenCode
  (`opencode serve`) do. Any other runner, a plugin runner included, falls back
  to the terminal transport, and every surface shows the fallback and its
  reason (for example `terminal: no structured connector for <runner>`) —
  never a silent downgrade.
- **The terminal transport is fallback-only.** Runner-facing features target
  the structured transport; the terminal transport gets bug fixes, not new
  features.
- **One connector per runner, shared with the planner (C1).** The harness
  `AgentAdapter`s gain an explicit start switch: *read-only planner* versus
  *task*. The planner path always starts read-only, and tests assert that the
  planner has no other way to start an adapter, so the ADR-0008/0009 security
  boundary holds. In task mode the permission mode and effort flags come from
  the **runner manifest** — ADR-0001: manifests define what a mode means — via
  the same code terminal tasks use. The adapter owns only the protocol flags
  (stream format, input format, permission-prompt channel, resume).
- **Two channels (O1).**
  (a) *Plain text to `onOutput`*: the assembled agent text plus one short line
  per tool call (`› Bash(npm test)`), no JSON and no ANSI. It feeds
  `VerdictEngine` marker detection, the planner's live-output read (#3), usage-limit
  classification and the fallback summary handed to dependents.
  (b) *A full-fidelity view* built from the structured events as ADR-0017
  display blocks: streaming text, thinking, expandable tool calls with
  arguments and results, nested subagents, usage, approval cards. Channel (a)
  is deliberately lossy; nothing that needs fidelity reads it.
- **A turn without the marker is "waiting for input" (W1).** A turn that ends
  without the done marker makes the task `awaiting_user` with a saved reason:
  `input | checkpoint | conflict`. That reason replaces today's inference that
  a live attempt means checkpoint. A checkpoint wins over input. There is no
  automatic nudge — no verdict is guessed, and the user (later the supervisor,
  #28) responds or marks the task complete. Approval requests arrive
  mid-turn and do **not** change task status: "waiting for approval" is derived
  from the task's pending approvals. The idle timer keeps running during a turn
  and is paused while the task waits, on input, a checkpoint or an open
  approval (2026-10-03: approvals added, so a long one doesn't also read as
  idle). If a queued message is delivered as the
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
  `session.write(text)` means "send as a user message", so checkpoint replies
  work unchanged. Clarifying questions are plain text for now: a task starts
  with `AskUserQuestion` disallowed, so the agent asks in prose and ends its
  turn; a question card is a later option.
- **Background work (B1).** Claude Code reports a turn's `result` when the
  model stops talking, even with a background shell or agent still running, and
  opens a turn of its own when the work finishes. The Claude connector therefore
  holds a task's turn open while the CLI lists background tasks, so what is said
  afterwards — the marker included — belongs to the same turn. If the CLI starts
  no follow-on turn once the list is empty, the turn ends after a short grace.
  Anything a runner does by itself after a turn has closed is delivered to the
  session as a turn of its own, with no user message, instead of being dropped.
- **The plan's mode is held (B2).** `--permission-mode auto` on a model or
  account without auto mode is not refused: the CLI starts in `default` and
  asks about every write. The connector compares the mode `init` reports with
  the one the plan asked for and fails the turn in plain words on a mismatch
  (ADR-0001).
- **Lifetime (L1).** A structured process ends once its task passes. This
  deliberately differs from `LingeringRunners` for terminal tasks: the log
  lives in Ordewell, and work after the verdict would go unverified. The native
  session id is saved per attempt.
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
- **Surfaces (V1, #57).** In the TUI, `t` or `/terminal` on a structured task
  swaps the chat pane to the task view: a distinct accent colour, a state
  header, a `→ Task N` composer label, and Esc to return. In VS Code each task
  has an editor tab opened on demand ("Open log"); it never opens
  automatically, reopening focuses it, and closing it never affects the task.
  The card keeps its one-line peek and gains a waiting badge.
- **No tmux, no `script` (W2).** A structured session is a plain child process
  speaking a protocol, so it needs neither, and also works on native Windows
  (ADR-0010). tmux is optional: nothing at start-up refuses to run or warns
  when it is missing. Only a run on the terminal transport needs it, for the
  per-task window; on a host without it those tasks run headless, the plan's
  first such task says what is unavailable and how to get it (install tmux, or
  keep the structured transport), and opening a task's terminal gives the same
  advice.

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
  without the marker (W1). Any other request gets `-32601` at once, so a turn
  never waits on Ordewell.

## Out of scope

#58 (take over in the runner's own TUI), #26 roll-ups, #31.

## Considered options

- **Keep scraping and get better at it.** Each fix so far was specific to one
  runner, and #11, #13 and #14 were bugs in exactly this path. Rejected as the
  foundation.
- **Keep the TUI and add side channels** — runner hooks such as Claude Code's
  `Stop`/`PreToolUse`, OpenCode's local server, Codex `notify`. The plumbing
  differs per runner and is weakest for Codex, and sending a message would
  still mean typing keystrokes. The TUI is not lost either: `terminal` stays
  available, and take-over (#58) brings it back for structured tasks.
- **ACP for every agent.** ADR-0009 rejected it as the only transport; still
  worth checking for the long tail.
- **Replace `ITerminalSession` with a turn-based interface everywhere.** Too
  large, and it would regress the tmux and VS Code terminals that work today.
- **Raw JSON to `onOutput`.** Streamed text deltas would split the done marker
  across lines, and tool results would flood the 256 KB buffer.
- **A new `TaskStatus` for waiting, or `in_progress` plus a flag.** Waiting is
  a reason for the existing `awaiting_user`, which every surface already
  handles; a flag would leave two sources of truth.
- **`awaiting_user` for approvals too.** Status churn and a plan save on every
  request, for something that does not end the turn.
- **Per-task transport** (a setting on each task). The plan would carry a
  choice the user makes once per run anyway; per-task *routing* by connector
  availability (S3) covers the real need.
- **Structured as an opt-in, terminal the default.** It shipped that way, marked
  experimental, until structured matched terminal on a parity checklist (done
  detection, approvals, log view, a connector for every built-in runner). Once
  met, two first-class transports would have doubled every runner-facing
  feature, so structured became the default and terminal the fallback.
- **A user-facing transport setting** (`runnerTransport`, `/transport`,
  `ordewell transport`, a Structured toggle). Shipped while structured was
  maturing, then dropped: with a connector for every built-in runner, the
  choice only let a user pin the path that gets bug fixes and no new features,
  and a stored `terminal` from an older build was indistinguishable from a
  deliberate one. Routing by connector availability (S3) covers the real need.
- **A lingering process after pass.** Would mirror `LingeringRunners`, but the
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
- 2026-10-09 — the `runnerTransport` setting and its surfaces removed.
