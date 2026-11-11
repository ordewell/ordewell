---
status: accepted
amends: ["0018"]
note: "changes the rule ADR-0018 M1"
---

# 0023 — Messages reach a running task between tool calls

## Problem

ADR-0018's M1 first had a message sent to a structured task wait in
Ordewell's queue until the runner's turn ended. That rule was written for a conversation of
short turns. A task is not one: it is usually a single long turn, from the
prompt to `task_complete`. So "delivered when the turn ends" means "delivered
when the task is over" — a correction sent five minutes into a ten-minute task
reaches the runner after the work it was meant to change, and a message sent
to stop a wrong approach arrives once the wrong approach is finished.

Claude Code and Codex do better in their own TUIs: a message typed while the
agent works is shown to the model after the current command or edit, inside
the same turn. The structured transport speaks the same protocols, so it can
do the same. The supervisor (#28) needs it too: a message it sends to a
running task is only useful if the task reads it while it still matters.

## Decision

**A message sent to a running structured task is handed to the runner at once
and reaches the model at the runner's next step boundary — after the tool call
in flight, within the same turn. Where a runner cannot take a message
mid-turn, or refuses one, the message waits for the turn to end, as before.
*Force send* interrupts the running tool call and delivers its message
straight away, with everything the person still has queued glued ahead of it
as one message; a turn's end likewise sends what they queued as one message.
In the planner chat, force send stops the planner turn in flight and answers
the held prompts and its own in the turn that replaces it; it is turn-scoped
and never touches the run's tasks.**

## Key properties

### Delivery

- **A per-adapter optional capability (D1).** A task-mode adapter may offer
  *deliver into the running turn*. It is feature-detected, within the
  mandatory session contract (ADR-0018, S2); an adapter without it keeps the
  turn-end queue, and nothing upstream changes for it.
- **Handed over at once, delivered at the boundary (D2).** A message sent
  while a turn runs is passed to the runner immediately; the runner shows it
  to the model after the tool call in flight completes. Ordewell does not wait
  for the boundary itself — no runner exposes "between tool calls" as a moment
  a client can act in, and each one already queues and injects on its own
  (see *Per runner*). Messages are offered one at a time, in the order they
  were sent: the next goes once the runner has answered the last. A refusal
  ends offering for that turn — the refused message and every one behind it
  wait for the turn's end, so none overtakes another. Nothing is offered while
  an interrupt is in flight.
- **The runner's acknowledgement is the delivery (D3).** A message is
  *delivered* when the runner reports that the model has it — not when the
  write, POST or request succeeded. Each runner has its own evidence (below).
  Until then the message is *handed over*: still in the queue, no longer
  removable (no runner can recall it), and owed a delivery.
- **Fallback to the turn-end queue (D4).** A message goes to the turn-end
  queue when the adapter lacks the capability, when the runner refuses it
  (Codex: no active turn, or a different one), when the runner reports that
  the turn ended with the message handed over but never read (Codex and
  OpenCode), or when kill-and-resume replaces the process that held it — it
  is then sent as the next turn's message, so nothing handed over is lost.
  Such a message is removable again. Turn-end delivery keeps ADR-0018's W1
  rule: the task stays `in_progress` with no flicker.
- **A turn that ends with a message owed does not wait for input (D5).** If a
  turn ends without a completion call while a handed-over message is unacknowledged,
  the runner is about to work on it (or Ordewell is about to send it), so the
  task does not become `awaiting_user` (W1) for that turn end. A turn the
  runner opens by itself for such a message is that message's turn, not
  background work (ADR-0018, B1).
- **Completion evidence waits for the messages (D6).** A completion signal —
  the `task_complete` call — that arrives while a message is
  still undelivered is held, not settled. If the turn then ends with nothing
  left to deliver, the held verdict is published. If the message is read
  mid-turn, or opens the next turn, the runner has been told something after
  that evidence, so it is discarded and only what the runner reports from
  then on counts; the summary handed to dependents restarts there too.
- **Nothing is dropped silently (D7).** A message that can no longer reach
  the runner — its process exited, the turn failed, or it was sent to a
  session that has already ended — is reported *undelivered*
  (`message_undelivered`), with its text, instead of disappearing from the
  queue.

### The queue view and the task log

- **A message leaves the queue when the runner has it (Q1).** The queue lists
  messages not yet delivered: *queued* ones (removable, waiting for a turn to
  end on a runner without the capability) and *handed over* ones (not
  removable). Delivery removes the entry.
- **Delivery is a task-log event (Q2).** A message read inside the running
  turn is a `message_delivered` event, logged where the model read it, not
  where it was typed. A message delivered at a turn end is the `turn_start`
  of the turn it opened, carrying its `messageId`. Handing over is
  `message_handed_over`, a message back in the queue is `message_queued`
  again, and one that never reaches the runner is `message_undelivered`
  (D7). A forced message carries `forced` on its `message_queued` and
  `turn_start`. A message glued into another (F1) leaves the queue as a
  `message_removed`, logged before the message that carries its text. All of
  it replays the same way on reload (ADR-0018, P1).

### Force send

- **Interrupt the tool call, then deliver everything held (F1).** Force send
  soft-interrupts the running turn — which stops the tool call in flight — and
  sends the forced message as the turn that replaces it. The runners'
  interrupts are the ones ADR-0018 M1 already uses: Claude's `control_request`
  interrupt, Codex's `turn/interrupt`, OpenCode's abort, with kill-and-resume
  as the fallback. With no turn running, force send is a plain send. The
  person's messages still in Ordewell's queue go with it: they are glued,
  in the order sent and a line each, ahead of the composer's text into the
  one forced message, and each leaves the queue. Only the person's own
  queued messages are glued — never one the runner already has (handed over,
  or being offered), one already forced, a runner command, or a message
  Ordewell sent (the supervisor's, a completion reminder). Any message in the
  queue can be force sent by id too, queued or handed over. A queued one of
  the person's takes their other queued messages with it, glued in the order
  sent under its id; a surface with an empty composer force sends the oldest
  one, which sends everything held. One already handed over is never sent a
  second time — the model would read it twice: the interrupt alone makes it
  go first, and what the person still has queued stays queued, in order,
  since forcing it would overtake the messages the runner holds that were
  sent before it (F2). Claude Code runs it in the turn that follows the
  interrupt; Codex discards it and the OpenCode 1.x adapter lets go of it
  (D4), so Ordewell sends it as that turn. It is marked forced either way.
  One the runner reports delivered while the interrupt is on its way has
  reached the model and is not sent again; with nothing else owed, that turn
  ends as a plain interrupt does (M1). A delivered message has left the
  queue, so there is nothing to send now; force sending one already forced
  changes nothing. The surfaces: `ctrl-s` in the TUI task view (the composer
  text, or the oldest queued message when the composer is empty; either sends the
  whole queue), *Send all now* and `Ctrl+Enter` in the task log, which draw the
  planner chat's queue control, and the daemon's `execute-command` route
  carrying `message_task` with `force` or `force_send_queued`. The planner chat's force send is
  F5.
- **The forced message goes first; the rest keep their order (F2).** What
  is still in Ordewell's queue after a force send — a command, a message
  Ordewell sent, or the person's messages left behind a handed-over one —
  follows the forced one in the order it was sent, and the person's
  messages left in a row there go out as one at the turn's end (F1).
  Messages already handed over to the runner are where the runners differ:
  Claude Code keeps them in the conversation and the model reads them ahead
  of the forced message (they were sent first), in the current turn or in a
  turn the CLI opens for them. Turn-end delivery waits while any message is
  still handed over or being offered, wherever it sits in Ordewell's queue;
  a forced message cannot overtake the runner's own queue. Codex
  discards a steered message it had not consumed, and the OpenCode 1.x
  adapter deletes one still unread when the abort leaves the session idle,
  so Ordewell re-sends it after the forced one (D4). Ordewell cannot reorder
  a runner's own queue, and does not try.
- **No waiting for input in between (F3).** The interrupted turn does not make
  the task `awaiting_user`: a forced message follows, and the task stays
  `in_progress` through the switch. A plain interrupt, with no message, still
  ends in "waiting for input" (M1).
- **What an interrupt does to the running command differs (F4).** Claude Code
  and OpenCode kill it. Codex aborts the turn but leaves the command running
  to its end, and reports it later, in the next turn. On Codex, force send
  therefore stops the agent waiting on the command, not the command itself,
  and the adapter drops that late report as belonging to a finished turn.
- **In the planner chat, force send is turn-scoped (F5).** A prompt typed
  while the planner answers waits for the turn's end, held by the surface;
  at the turn's end everything held is sent as one message, glued in the
  order typed, a line each. Force send (`Session.forceSendPrompt`,
  `POST …/converse/message/now`) glues every held prompt, in the order typed,
  ahead of the composer's text into one forced message, with the same join a
  task's queue uses (`glued`, `conversation/promptHold`). It stops the planner
  turn in flight through the same path a stop takes — the harness planner's
  tool call in flight is stopped, and a plan change it had already committed
  stays (ADR-0022, P2) — and answers that one forced message alone in the
  turn that replaces it.
  The forced prompt waits before the stop, ahead of every input waiting but
  an earlier forced one, and behind the inputs the stopped turn took, so
  nothing starts in between and the rest keep their order (F2). A force
  send is not an answer to a run update, as the user's stop is: a supervisor
  wake-up turn it stops keeps its run update, which waits behind the forced
  prompt and reaches the supervisor in its next turn (ADR-0029). It stops
  whichever planner turn holds the conversation; with none in flight it is a
  plain send. It never stops, halts or edits a task: the run is not the
  planner turn, as Esc in the planner chat already never halts the tasks. The
  stopped turn ends `stopped` with `forceSent` on its `planner_turn_ended`,
  which tells a surface to keep its held prompts in order rather than hand
  them back to the input as it does after a stop. The forced prompt carries
  `forced` on its `planner_turn_started`, its pending input and its
  transcript entry, and the shared conversation view marks its line from
  either, so a reload shows it as sent now (Q2).

### Per runner

| runner | mid-turn delivery | delivered when | force send |
|---|---|---|---|
| **Claude Code** (stream-json) | a `user` message written to stdin; native | the CLI echoes it (`isReplay: true`) under `--replay-user-messages`, after the tool result | `control_request` interrupt, then the message as the next `user` line |
| **Codex** (app-server) | `turn/steer` with `expectedTurnId` and `clientUserMessageId`; native | a `userMessage` item whose `clientId` is that id | `turn/interrupt`, wait for `turn/completed: interrupted`, then `turn/start` |
| **OpenCode 1.x** (serve) | `prompt_async` while the session is busy; native | an assistant message whose `parentID` is that user message or a later one | `POST /session/:id/abort`, then `prompt_async` |
| **OpenCode 2.x** | not verified — no 2.x binary on the probe host | — | turn-end queue until verified |
| **ACP runners** (GitHub Copilot CLI) | none: ACP v1 has no mid-turn injection; turn-end queue | the next `session/prompt`, which the queued message opens | `session/cancel`, wait for the prompt's response, then `session/prompt` |

- **Claude Code.** The CLI queues a `user` line that arrives mid-turn and
  attaches it to the next tool result as "The user sent a new message while
  you were working" (its transcript records it as `queued_command`, removed
  with reason `absorbed_mid_turn`). If the model ends the turn without
  another tool call, the CLI runs the message as a turn of its own after
  `result` — delivery `turn_end`, and the adapter attributes that turn to the
  message instead of treating it as background work (ADR-0018, B1). The task
  spawn adds `--replay-user-messages`; the echo of a message is the only
  signal that tells the two cases apart. Each steer is written under a fresh
  `uuid`, and the echo carrying it is the delivery; the first prompt is echoed
  too, carries no steer's `uuid`, and is not a delivery. The CLI never lets go
  of a message it was handed — after an interrupt too, the message runs in
  the next turn — so a Claude Code steer is never dropped. A steer is refused
  while an interrupt is in flight, and before the CLI's `init` shows a
  `--resume` was taken up (a refused resume closes stdin).
- **Codex.** `turn/steer` answers `{turnId}` at once; that is acceptance, not
  delivery. The `userMessage` item appears after the item in flight completes.
  A steer before the turn id is known is refused (the request needs a string
  `expectedTurnId`); the adapter holds the message until `turn/started` or the
  `turn/start` response names the turn, as it does for interrupts. A steer
  after the turn ended is refused with `no active turn to steer`, and a wrong
  id with `expected active turn id …` — both fall back to the turn-end queue.
  The existing deny-note steer (ADR-0018, Codex approvals) is the same call.
  An accepted steer still unread when the turn ends is reported dropped and
  re-sent from the queue (D4).
- **OpenCode 1.x.** A `prompt_async` while busy returns 204 and stores the user
  message at once (`message.updated`, role `user`) — storage, not delivery.
  The session's loop reads it at its next step, including when the step in
  flight was the model's final text: the loop runs one more step instead of
  going idle. So the busy period simply continues, and the turn ends at the
  next idle as today. A steer posts `prompt_async` under a `messageID`
  Ordewell generates, to the task's root session only; an assistant message
  in that session parented on it, or on a message handed over after it, is
  the delivery. With no turn running the adapter refuses the steer. One whose
  turn went idle unread is deleted from the session
  (`DELETE /session/:id/message/:messageID`) and reported dropped, so the
  turn-end re-send does not show the model the message twice.
- **OpenCode 2.x.** Its adapter refuses every steer, so messages keep the
  turn-end queue until a mid-turn path is verified on a 2.x server.
- **ACP runners.** `AcpAdapter` offers no steer
  ([ADR-0060](0060-acp-runners-are-data-on-one-connector.md) R8): every
  message waits for the turn's end, which only the `session/prompt` response
  marks. A force send's `session/cancel` also answers each permission request
  still pending with the `cancelled` outcome, as the protocol requires.

### The supervisor

- **#28 sends through the same seam (S1).** A supervisor message is a task
  message with a different sender: it is handed over, acknowledged, logged
  and, when the runner cannot take it mid-turn, queued exactly like a
  person's. #28 described supervisor messages as delivered "at the next turn
  boundary through `IAgentSession.send`"; this decision makes that boundary
  the runner's next step rather than the end of the task, and #28 needs no
  delivery path of its own. Force send is available to the supervisor only
  under the same grant that lets it steer.

## Evidence

Observed on 2026-10-06 on the development host, with throwaway scripts
speaking each runner's protocol directly (deleted afterwards). Each probe
started a turn whose first step was `sleep 20 && echo step1done`, followed by
two more commands, and sent a message about four seconds into the sleep.

- **Claude Code 2.1.291**, `haiku` (`claude-haiku-4-5-20251001`). The message
  reached the model right after the sleep's tool result, in the same turn
  (one `result`, `num_turns` 4); the summary carried the requested word. With
  `--replay-user-messages` the message was echoed with `isReplay: true`
  between the tool result and the next tool call. A message sent during a
  text-only reply ran as a second turn after the first `result`, echoed after
  it. Interrupt: the sleep's tool result became "The user doesn't want to
  proceed…", `result` was `error_during_execution`, and a message written
  just after started a new turn. A message handed over before the interrupt
  ran in that new turn together with the forced one, ahead of it; the
  interrupt's `control_response` reported `still_queued: []` even so, so that
  field is not a reliable account of the CLI's queue.
- **Claude Code 2.1.299**, `haiku`, 2026-10-14, through the opt-in live test
  (`structuredLive.smoke.test.ts`). A message handed over during a 60-second
  foreground command and then force sent: the interrupt cut the command
  short, and with nothing more written the CLI ran that message as a turn of
  its own after the interrupted `result`, its echo opening that turn; the
  task stayed working between the two turns.
- **Codex 0.160.0**, `gpt-5.6-luna`, `danger-full-access` (the sandbox cannot
  start on this host). `turn/steer` returned `{turnId}` immediately; the
  `userMessage` item, carrying `clientId` = the `clientUserMessageId` sent,
  appeared when the sleep completed, before the next command. Refusals:
  `expectedTurnId: null` → `Invalid request: invalid type: null, expected a
  string`; omitted → `missing field expectedTurnId`; after `turn/completed` →
  `no active turn to steer`; a wrong id → `expected active turn id
  \`not-the-turn\` but found \`<id>\``. `turn/interrupt` completed the turn as
  `interrupted` at once and the command's output became "aborted by user",
  but the command itself ran on (a `sleep 15 && touch` file appeared on time)
  and its `item/completed` arrived during the next turn. A steer accepted and
  not yet consumed when the turn was interrupted never reached the model and
  is absent from the rollout.
- **OpenCode 1.18.34**, `opencode-go/deepseek-v4.1-flash`, variant `low`,
  agent `build`. `prompt_async` while busy returned 204 and the user message
  was stored immediately; the next step after the sleep finished was the
  first assistant message with that message as its `parentID`, and the
  session stayed busy until one idle at the end. A message posted during a
  text-only final step produced one more step, still without an idle between.
  Abort killed the command (the `touch` never ran; the output read "User
  aborted the command"), raised `MessageAbortedError` and went idle; a
  `prompt_async` after it opened a new loop. A message stored before the abort
  stayed in the history, so the next loop read it ahead of the forced one;
  the new loop's assistant messages are parented on the forced message.

Not verified here: OpenCode 2.x (not installed — its `/api/session/:id/prompt`
while active is the expected path); Codex in a sandboxed mode; whether a Codex
steer accepted during the turn's final reply can be dropped without an
interrupt (D4 covers it either way).

## Considered options

- **Keep turn-end delivery only.** Simple, and correct for a conversation of
  short turns, but a task is one long turn, so a message would reach the
  runner when the task is already over. Rejected; it stays as the fallback.
- **Keystroke injection into the runner's TUI.** Rejected in #28, for the
  reasons ADR-0025 removed the terminal transport: keystrokes cannot be promised
  to land between turns, and #11 and #13 were bugs in exactly this path.
- **Hook-based injection.** A Claude Code `PostToolUse` hook returning
  `additionalContext`, injected per task with `--settings`, pulling the
  attempt's pending messages from the Ordewell MCP server with the task
  token; an OpenCode plugin on its `tool.execute.after` hook through
  `OPENCODE_CONFIG_CONTENT`. It works without the runner's cooperation, but
  each runner already injects mid-turn messages natively — the same path its
  own TUI uses — and a hook would be a second, per-runner delivery channel
  with its own failure modes (a hook that does not load, a message delivered
  twice), executable code added to a task's configuration, and nothing at all
  for Codex. Rejected while native delivery exists; it is the route to
  revisit if a runner drops it.
- **Ordewell waits for the boundary and sends the message then.** No runner
  reports "between tool calls" as a moment a client can act in before the
  next model call starts; by the time a tool result is seen, the next request
  is already on its way. Handing the message over at once and letting the
  runner inject it is what makes the boundary reachable.
- **Treat the write or POST as delivery.** Every runner accepts the message
  long before the model sees it, and Codex can still discard an accepted
  steer. The queue would claim a delivery that may not have happened.
- **Send held messages one at a time.** The first design: a turn's end sent
  the oldest queued message as the next turn and the rest waited behind it,
  one turn each, and a force send sent only its own text ahead of them. The
  runner then answered a half-typed thought, and the person's later lines
  arrived as corrections to an answer already under way, a turn each; a force
  send overtook the very messages it was meant to hurry. Replaced by gluing
  what the person queued into one message (F1, F5). A command and Ordewell's
  own messages still go alone: a runner reads a command only at a message's
  start, and the supervisor's words are not the person's.
- **Glue the person's queued messages behind a handed-over message force sent
  by id.** It sends everything at once, as a force send from the composer
  does, but the glued message would overtake the messages the runner holds
  that were sent before it (F2). Rejected: they wait, and go glued at the
  forced turn's end.
- **Force send as interrupt plus a normal send.** The interrupted turn would
  become "waiting for input" for a moment, and the forced message would queue
  behind anything already waiting. F2 and F3 exist to avoid both.
- **A planner force send that stops the run too.** One key for "stop
  everything and listen" is easy to explain, but a correction to the planner
  is not a reason to stop tasks the user did not ask to stop, and the planner
  chat's own stop is already turn-scoped. Rejected (F5).
- **A planner force send drops the stopped wake-up turn's run update, as a
  stop does.** It was the first implementation, the rule for a stop applied
  to any interruption. A stop is the user's answer to the run update; a force
  send answers something else, and the supervisor would never hear of the
  failure or the run's end it carried. Dropped (F5).

## Consequences

- The structured capability's `sendMessage` means "handed over now,
  delivered at the next step" on a capable adapter, "queued until the turn
  ends" otherwise. `queued()` reports both states and marks forced messages;
  `removeQueued` refuses a handed-over message; `forceSendQueued` takes one,
  and is false only once the message was delivered. `forceSend`,
  `forceSendQueued` and the turn-end delivery glue the person's queued
  messages inside the runner session, atomically; no surface glues a task's
  queue itself.
  `forceSend` and `forceSendQueued` join the capability.
- A task-mode adapter's `steer(id, text)` is optional and answers whether the
  runner accepted the message; delivery and a drop come back as adapter
  events (`message_delivered`, `message_dropped`).
- The Claude task spawn adds `--replay-user-messages`; the adapter reads
  echoes as deliveries and attributes a turn the CLI starts for a queued
  message to that message. Tests that play transcripts recorded without the
  flag keep the turn-end queue.
- The Codex adapter steers task messages with a `clientUserMessageId`
  through the same helper as the deny note, re-sends any it never saw
  delivered, and drops the late report of a command an interrupt left
  running (F4).
- `VerdictEngine` holds completion evidence while a message is undelivered,
  and voids it when a message is read (D6).
- ADR-0018's M1 states this decision.
- `PlanTurns.forceSend` places the forced input and asks the Session to stop
  the planner turn (`PlannerConversation.stopTurn('force_send')`); a forced
  input at the head of the pending inputs is a turn of its own. The wake-ups
  of the turn it stopped stay pending, undelivered, behind the forced inputs.

## History

- 2026-10-06 — proposed, with the per-runner probe above (Claude Code 2.1.291, Codex 0.160.0, OpenCode 1.18.34).
- 2026-10-06 — accepted and implemented on Claude Code, Codex and OpenCode 1.x, force send on every surface; OpenCode 2.x keeps the turn-end queue. ADR-0018 M1 rewritten.
- 2026-10-09 — aligned with [ADR-0025](0025-structured-only-runners.md).
- 2026-10-13 — force send extended to the planner chat, turn-scoped (F5); core and daemon route.
- 2026-10-13 — F5: a force send keeps the run update of a wake-up turn it stops.
- 2026-10-14 — F1: a handed-over message can be force sent, and is never sent twice; probed on Claude Code 2.1.299. F2 corrected for OpenCode 1.x, whose adapter lets go of an unread message at the abort. Removal of a handed-over message stays refused.
- 2026-10-18 — F2: turn-end delivery waits for every message the runner still holds, including one behind a newly forced message.
- 2026-10-24 — the daemon's force send routes are replaced by the one `execute-command` route (ADR-0006 S3).
- 2026-10-26 — F5: a force send keeps what the stopped turn's tool calls already committed; nothing is deferred behind an edit (ADR-0022, P2).
- 2026-11-04 — ACP runners take the turn-end queue, with `session/cancel` then `session/prompt` for force send (ADR-0060).
- 2026-11-10 — F1, F2, F5: a force send and a turn's end glue everything the person queued into one message, instead of sending held messages one at a time.
- 2026-11-10 — F1: the task log draws the planner chat's queue control ("Send all now") instead of a bar of its own, and the TUI's ctrl-s with an empty composer sends the oldest queued message and so the whole queue, whatever row is picked.
