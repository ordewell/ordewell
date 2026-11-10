---
status: accepted
---

# 0002 — Planner as a conversation loop (messages only)

## Problem

Ordewell's planner used to emit several distinct typed artifacts over the course of planning: `QueuedMessage[]` (parsed from `<<ORDEWELL_QUESTION>>` tags in model output), `PrdArtifact` (a structured JSON with `status`/`feedback` fields and a state machine of `pending`/`approved`/`rejected`), and the task plan itself. Each artifact had its own field on `LegacyPlanState`, its own Session operation (`continueResearchWithAnswers`, `approvePrd`, `rejectPrd`, `generatePlanFromPrd`), and its own host-side routing branch (a ladder in `extension.ts` that inferred which operation to call from plan state). The interview mode was observed dying after one question: `Planner.continueResearchWithAnswers` lacked the fallback guard that `generate` had, so when the model emitted `READY_FOR_PRD` instead of a tagged question, it fell straight to PRD synthesis.

## Decision

We decided to collapse the planner to a single messages loop — "the LLM either thinks, executes commands, or sends messages to the user, very similarly to OpenCode." There is one channel: assistant messages in, user messages out, until the planner commits the plan as JSON.

## Key properties

- **One persisted dialogue.** `conversationHistory: { role, content, timestamp, kind? }[]` on `LegacyPlanState` is the single source of truth for both UI redisplay and model context. Surfaces draw all of it. The model is given its projection, `modelContext()`: everything, until a compaction makes a checkpoint (below). Tool-call results are NOT stored here — they live in the AI service's tool-use history; `researchLog` is the persisted tool trace for the UI.
- **Two operations.** `Session.startPlanning(goal, runners)` kicks off research and the first planner message; `Session.continueConversation(userMessage)` handles every reply after it. The host routes with one branch: the user replied → `continueConversation(text)`.
- **The model decides transitions, with no tokens and no quotas.** The planner reads the conversation and decides when to move from questions to an outline to the commit. There is no `<<ORDEWELL_QUESTION>>` tag, no `READY_FOR_PRD` sentinel and no status field. The base workflow tells it to ask before planning when the goal is vague or a decision materially changes the outcome (storage, library, scope, API shape), and that a clear goal needs no questions. A deeper interview is a skill the user invokes (`/grilling`, `packages/core/skills/grilling/`), substituted into the planner's message: one question at a time with a recommended answer, exploring the codebase instead of asking when it can, until shared understanding.
- **The final commit is auto-detected JSON.** When the planner decides the user has confirmed the outline, its next response IS the `{tasks:[...]}` JSON. The system runs `extractJsonObject` on every planner response; if it parses as a plan, the plan is loaded; otherwise it is rendered as a chat message.
- **A PRD is markdown in the conversation.** A planner reply that carries an `ORDEWELL_PRD` block is captured — even in the same turn as the plan JSON — into `prdMarkdown` on the plan and saved to `.scratch/<slug>/PRD.md`. There is no PRD state machine. A spec from the conversation is the `to-spec` skill's job.
- **Research interleaves with conversation.** Tool calls and questions happen within the same turn; the model explores more when it needs grounding mid-dialogue. The AI service maintains authoritative tool-use history across turns; `researchLog` is the persisted UI trace.
- **No Approve/Reject buttons.** Pure chat. The user types "approve" or "change X"; the planner decides what to do.
- **Silent degradations are made visible, not machined away.** An empty planner reply (a budget model after tool use) gets a nudge and then a visible "(The planner returned an empty response …)" message rather than a blank bubble. A hallucinated tool (`create_task`, `create_file`) is answered by restating the planner's role — read-only research, agents execute later — and the commit channel, raw JSON in the reply. The plan format's id example reads "unique-task-id (any short unique string)", because a `uuid-string` example made a model call a nonexistent uuid tool.
- **The line can be forked, rewound and condensed** — always as a transcript edit, so it works the same on a vendor API planner and a harness planner (ADR-0009):
  - **Fork** copies the conversation and the task list into a new persisted session, leaving the original untouched.
  - **Rewind is a fork from a point.** It copies the transcript up to just before a chosen user message, with `researchLog` cut at the same point, into a new session the daemon adopts like a fork. The original — file, transcript, live planner context — is untouched. The opening goal is a floor a rewind cannot cross. A checkpoint is not a floor: the copy is a prefix, so a rewind before a checkpoint leaves it behind with what followed. The rewound message's text comes back with the fork, so a surface can offer it for editing and resending. The fork has no live context, so its first message replays the shortened transcript's model context on every backend.
  - **Compaction** (`/compact`) shortens the model's context, never the history. A summary of the model context is asked for: an API planner writes it in calls on its own model and credentials that offer no tools (`IAiService.condenseContext`), the same calls an automatic compaction makes (below), and a harness planner in one hidden turn of its agent. The summary is appended as a `compaction` entry carrying a checkpoint, `{ id, keptFrom, trigger, record? }`. Where the plan holds a decision record, the entry is that record restated whole, then `Where we are:` and a summary asked to cover only what the record does not hold, and `record` counts the entries it restated ([ADR-0067](0067-the-planners-decision-record.md)); every checkpoint, automatic ones included, is written the same way. `keptFrom` is the transcript index where verbatim replay resumes, the second-to-last user message, so the last two exchanges are kept as they were. Then the live context is reset. Every message and the whole `researchLog` stay on disk and on screen, rewind positions do not move, and tasks and run state are not touched.
    - **One projection.** `modelContext()` is the newest checkpoint's summary, then every entry from its `keptFrom` on, without any other `compaction` entry. It is the only thing replayed or condensed: a reload, a model or provider switch, a fork, a rewind, and a summary turn with no live context. A second compaction therefore condenses the first summary and what followed it, and supersedes it. When nothing new can be saved past the last checkpoint, `/compact` is refused.
    - **Checkpoints only append.** A cut is never behind the previous checkpoint's, nor past an input an open planner turn still holds, since that input lands at its held position and must be replayed. Inserts land at or after the cut, so `keptFrom` never moves. A checkpoint committed in its own save stays valid whether the turn it was made during lands, fails, stops or is abandoned. This is the seam an automatic compaction during a turn commits through.
    - **Read defensively.** A saved checkpoint counts only with an id, a known trigger, and an integer cut no later than its entry and no earlier than the previous checkpoint's. One that fails is passed over, which replays more and hides nothing. A `compaction` entry without a checkpoint is a marker: drawn, never replayed. The exception is a legacy summary standing first, from builds that replaced the transcript; it is read as a checkpoint cutting at index 1, and still plays the goal's part for rewind.
    - **Atomic.** The summary must be wrapped in tags, because a harness planner returns a crashed agent's error as a normal reply. Nothing is written until the summary is in hand, so a failure or a stop is a no-op. Anything else the summary turn emits, task ops included, is discarded.
  - **Automatic compaction** keeps an API planner's calls inside its model's window without ending its turn. It is on by default; `plannerAutoCompaction: false` in the settings file turns it off, and no settings panel shows it. A harness planner's agent compacts its own context, and a task runner its own: neither is touched. Before every call, between the rounds of a turn and only once the tools a call asked for have returned, the chat budgets the call on the model configured at that moment:
    - **The budget.** The prompt may fill 90% of the model's known window. An OpenAI-compatible window holds the reply too, so the prompt also stops short of the reply asked for: the smallest of 32,000 tokens, the provider's stated cap and a quarter of the window. Gemini states the input limit apart, `inputTokenLimit`, and the reply has its own, the smaller of 16,384 and `outputTokenLimit`. A call is costed from what the provider measured of the same model's last call, with a margin, or of another model's with a wider one; nothing counts tokens offline. Another model's measurement only estimates: no call is held on another tokenizer's ratio, nor on a refusal's bound past what any tokenizer gives. A Gemini model turn is sized as it is sent back, thoughts and signatures included. A window the catalogs Ordewell already holds do not state turns automatic compaction off for that model; `/compact` still works. The planner's context meter, which every surface already draws, says so quietly (`· no auto-compact`), and why on hover: the settings file, or a window no catalog states.
    - **Prune first.** Older output of the workspace reads, which can be made again, is cut to a stub, oldest first, down to a low-water mark below the ceiling: first sparing the two newest complete rounds anywhere, then only the current turn's. The output of a command, a web read, a task read, an execution tool or a subagent is never pruned, and neither is a round whose results are still being sent. Pruning alone is reported as a compaction that only ever ends.
    - **Then summarize the history that landed.** Still over, the live context from before the open turn is condensed by the summary calls into a checkpoint, committed in its own save while the turn holds its inputs, its cut before them. The newest exchanges whose replay fits below the low-water mark beside the turn are kept verbatim; one too large to fit, however recent, is condensed with the rest. The live context becomes the checkpoint's projection, then the turn's own messages as they were, and the same call goes on from there.
    - **Then summarize the turn's own rounds.** A turn that still fills the window by itself has its older complete rounds condensed in the live context alone: the user's message stays verbatim, then a note with their summary and a list, read off the messages and not asked of the model, of every call they made that changed something or reached out, with what it returned. The list is not what keeps one from running twice: a call the model asks for again with the same tool and arguments is answered with what that call returned, shown as not executed, and never run. The list is never cut short, so the room the rounds are condensed to counts it. The newest rounds that fit, and the call whose results are being sent, stay as they were. On Gemini the note joins the user's turn as a part of its own, as a new plan's goal joins the instructions' turn, so no two user turns follow each other. Nothing of it is written: tool output was never in the transcript.
    - **What a summary call is.** One call, or a bounded fold of up to eight when what it condenses does not fit one, each part folded into the summary so far, on the planner's own provider, model and credentials, asking for a reply within the provider's cap and a tenth of what a call may carry. It offers no tools and its reply is only read as text, so nothing it says runs a tool or changes the plan. Its spend counts in the usage totals and measures nothing of the live context. A reply is refused, and nothing it would have replaced changes, when it was cut off, holds no complete tagged summary, is too short to stand for what it condensed, has hardly condensed it, ran past the room kept for it or declines; and when the turn was stopped or abandoned, the planner model changed or the live context moved while it was written. The summary is told the current plan outranks anything the conversation said of task state, and every compaction drops the whole-plan certainty (ADR-0012 T10).
    - **A refusal as too long.** It is recognised by the provider's own signal and nothing broader: OpenAI's `context_length_exceeded` or its "maximum context length" wording, Gemini's "input token count exceeds the maximum" wording. Any other 400, a rate limit, a refused key, a dropped connection and a reply the output limit cut off are other failures, never retried here; the cut-off stays on the reply's repair path. A refusal is answered once per call. The window it states, and the size of the prompt it refused, bound every later call of that chat on the model. One more compaction is made below the refused prompt, then the same input is sent once more; one that could not be made smaller is not sent again. A window no catalog states turns this off too: the refusal pauses the planner at once.
    - **No fit: the planner pauses.** Where no compaction can bring the call under what the model takes, the resend is refused again, or no summary can be had, the call is not made. A call a summary was committed for is held to the 90% budget it was condensed for, judged on the model's own measurement or, with none, on the estimate it was condensed on: summaries were paid for to make room, and a call still past the budget is not sent on the chance the model takes it. Any other call is held only past what the model takes, and only on its own measurement. The user's Retry sends once whatever the estimate. Its input is held, so no tool runs again and no result is sent twice. The turn lands nothing; a failure line in the transcript says why, never claiming an estimate is a count. Its inputs stay in `pendingTurns`, and `plannerContextPause` on the plan records the pause: the model, the reason, the inputs, and the calls the turn made that changed something or reached out, read off the messages (`effectLedger`), at most 40. Nothing else of the live context is saved. Only the planner pauses: tasks run, start and finish on their own evidence, and the supervisor's wake-ups wait with the pause without counting as its failures. A message sent meanwhile is saved, answered at once, and waits for the turn after.
    - **Retry compaction** is the user's, and compacts whatever the settings file says. The paused turn opens again on the inputs the pause kept, never on ones that arrived since, so none of those reaches a summary. While the live context still holds the input and a window is known, from a catalog or the refusal's statement, it is condensed and the held input sent once: one attempt, and refused again it pauses again. Otherwise (a reload, another provider, a model whose window no one stated) nothing holds the turn's calls but the pause's list, one line each: a turn that listed none starts again from the model context, its reads made again; one that listed any, or whose list was cut short, is refused before any call, the pause kept, with what already ran and the way on: Stop, or a model whose window is known while the live context remains. A Stop ends the pause and drops the paused turn's user inputs, as a stopped turn's are; a stop during the retry, or during a `/compact` run while paused, does the same, and nothing late from it commits. The pause's suggestion follows what is too long: when the message, the held results or the instructions are past the window by themselves, it says to switch to a larger model, since a Retry on the same one would pause again. The terminal UI has `/compact retry`, the CLI `ordewell compact retry`, VS Code a bar above the composer, and the daemon `POST /api/plans/:id/conversation/compact/retry`.
  - **The task list rides along as-is.** A rewind keeps tasks the discarded turns created; a fork starts with the tasks the original had. Run state cannot travel to a session with no run: in-progress and checkpointed tasks become pending and planner turn inputs still waiting stay behind (`forkPlanState` is the one place that decides).
  - **Busy rules.** All three are refused while a planner turn is in flight and allowed while a run executes. A message sent while a summary is being written is refused (`ConversationBusyError`, a 409 from the daemon), before the planning abort slot is touched, so a stop still reaches the summary turn.
  - **VS Code** offers `/fork`, `/rewind [n]` and `/compact` (and Command Palette entries) through `Session` directly, since it does not use the daemon. While `/compact` runs it shows a status that the composer's Stop stops, and a message typed meanwhile waits for it, as it does for a Retry compaction or a compaction from the Command Palette; the compaction folds into the conversation as one marker and nothing is redrawn (ADR-0017 C1). A fork or a rewind is loaded as a saved session, which replaces its single `Session` and stops its run, so it asks first while one executes.
- **Old sessions were wiped.** No migration from the artifact shape; the saved-sessions store was cleared on the first run of the loop.

## Considered options

- **Keep the `<<ORDEWELL_QUESTION>>` tag as a UI hint,** deleting only the
  `QueuedMessage` field. Rejected: the tag is load-bearing presentation state,
  not just a hint, and keeping the parser gadget was the thing being removed.
- **Keep a typed `PrdArtifact` internally** to drive `generatePlanFromPrd`,
  invisible to the user. Rejected: "messages only" means one channel, not one
  channel plus a hidden JSON shape the user had explicitly asked to see gone.
- **PRD as conversation history only, no field on the plan.** Rejected: re-feeding
  the full PRD as history on every generation turn bloats context — a single
  `prdMarkdown` field is cheaper to re-render and re-feed.
- **A lightweight UI-hint token for transitions** (`<<PRD>>`/`<<OUTLINE>>`
  sentinels the UI parses for affordances). Rejected: reintroduces parser
  machinery, and the token would ride into conversation history as raw text.
- **User-driven transitions** — the model never stops asking on its own; the
  user types `/prd` or `/outline` to force phases. Rejected: contradicts the
  point of the interview (the model decides when it's done) and adds friction.
- **A numeric minimum-questions floor** ("ask at least 3 questions"). It was the
  first fix for the one-question failure. Rejected: a quota is machinery standing
  in for judgement. Prompt guidance carried the depth instead, and now the
  `grilling` skill does. Weak models may still under-interview; that is a model
  strength observation, worth reporting when testing.
- **Commit gates that bounce a plan once** — when it arrived before three planner
  turns in interview mode, or with PRD mode on and no PRD written. They existed
  while the interview and the PRD were mode toggles, as nudges that never
  blocked. They went with the toggles they were keyed to; the skills that
  replaced the toggles carry their own instructions.
- **The interview and the PRD as planner-mode toggles** (`grill-me`, PRD on/off,
  each a hardcoded prompt block). Replaced by a general skills system: built-in
  skills (`grilling`, `to-spec`) invoked by slash command, with no settings
  surface.
- **One PRD message, no separate preview.** Rejected: it skips the seam-check
  between preview and full document, so the expensive full PRD gets rewritten
  every time the model misread the goal.
- **Lean preview that expands silently on accept.** One user gate, two model
  turns — but it loses the explicit accept step between preview and full PRD.
- **Fenced JSON inside prose** (`Here's the plan:` + a fence the system
  extracts). Rejected: buys marginal narration value at the price of another
  parser gadget.
- **A user-triggered Generate Plan button.** Rejected: same objection as
  user-driven transitions, plus a UI affordance the redesign was removing.
- **Keep the four operations, relabeled.** Rejected: keeps the multi-artifact
  surface and the host routing ladder this ADR exists to delete.
- **Three operations: start + continue + a separate `commitPlanFromJson`.**
  Rejected: invents a seam where there is none — the commit is just "the
  planner's final message happened to be JSON".
- **Deterministic slug from the goal string** (kebab-case it). Rejected:
  produces ugly, ambiguous slugs on long goals.
- **User-prompted slug via a VS Code input modal.** Rejected: breaks the
  chat-only thesis.
- **A distinct research phase before conversation.** Rejected: less
  OpenCode-like, and the interleaving of exploration with questions is the
  behavior being copied on purpose.
- **On-demand-only research** (no upfront pass). Rejected: risks
  under-grounded questions in the early turns, where they matter most.
- **Collapse `researchLog` into `conversationHistory`** (one store, tool
  results included). Rejected: file contents bloat both persisted state and
  model context; the model receives them via the API tool-use stream, not by
  re-reading history.
- **Drop `researchLog` entirely** — tool calls are ephemeral, only prose
  persists. Rejected: loses the tool-call evidence trail across a reload.
- **Have the model summarize tool results into prose** (tool history
  ephemeral). Rejected: same loss — raw detail the model may need in a later
  turn is gone.
- **Mirror tool results into `conversationHistory`** (it becomes the full API
  message history). Rejected for the same context-bloat reason as the
  collapse option.
- **Migrate old sessions** with a `migrateLegacyPlan` on load. Rejected: the
  shape change is large enough that preserving old state costs more than it
  saves. Both variants (full one-shot, and a version field with read-only legacy
  loading) were dropped for that reason.
- **Ship core + VS Code first,** CLI and web later. Rejected: two behaviors
  in one codebase is exactly the mess CONTEXT.md warns against. Rejected in
  the shim variant too, for the same reason.
- **Rewind in place** (truncate the transcript). It was the first rewind.
  Rejected: the discarded turns were gone for good, so a user who rewound to
  try another direction could not go back. A fork from a point costs a session
  file; the in-place cut cost the conversation.
- **Both an in-place rewind and a fork-from-point.** Rejected: two operations
  under one name, differing only in whether history survives, is the kind of
  distinction users learn by losing work.
- **Reconstruct the plan as it was at the rewind point.** Rejected: it needs
  versioned plan snapshots per turn and a rule for tasks that ran since — whose
  effects are in the working tree, not the transcript. Keeping the task list
  as-is makes the result obvious: the conversation moved, the plan did not, and
  the planner sees the real plan in its per-turn block.
- **Compaction as a deterministic prune, with no summary turn.** Rejected: the
  transcript holds no tool output to prune, so what makes it long is the
  dialogue itself, and only a model can say which of it still matters.
- **Compaction through a harness agent's native `/compact`.** Rejected: only
  some harnesses have it, and it shrinks that agent's own memory, not the
  context Ordewell replays after a reload or a fork, so the two would drift. A
  harness planner's own automatic compaction stays under the harness's control.
- **Compaction that replaces the transcript** with the summary and the last two
  exchanges. It was the first compaction. Dropped because it destroyed what it
  condensed. The originals left disk, a reload hid the research from before the
  cut though `researchLog` still held it, rewind positions shifted, and nothing
  before the summary could be rewound to.
- **Keep every message and replay all of it after the summary.** Rejected: the
  condensed messages would be sent to the model beside their own summary, and a
  second compaction would summarise them again. Placing the summary first
  instead shifts every rewind position and makes the goal a rewind target.
- **A copy of the kept context per checkpoint.** Rejected: the transcript grows
  by a whole copy at each compaction. A cut index into the append-only
  transcript says the same with a few bytes.
- **Pruning at a fixed prompt size** (100,000 tokens, whatever the model). It
  was the first automatic compaction. Dropped: it fired too late for a small
  window and far too early for a large one, read the last call's size rather
  than the next one's, and stubbed the round the model had just read.
- **Automatic compaction through the `/compact` turn.** Rejected: that turn
  offered the planner's tools, and a read it asked for ran; it rode the whole
  context it was condensing; and it could only run between turns, so a turn
  that filled the window had to end first.
- **A summary of the transcript alone.** Rejected: tool output is never in the
  transcript, so the findings a turn read would be lost; the live context the
  summary condenses holds them.
- **The last two exchanges kept, as `/compact` keeps them.** Rejected for
  automatic compaction: two exchanges can be any size. What is kept is what
  fits.
- **Asking the summary to list what the turn did.** Rejected: a model can leave
  a call out, and a call left out is one the planner may make again. The list
  is read off the messages.
- **A checkpoint for a turn's own condensed rounds.** Rejected: its input is
  not in the transcript until the turn lands, and no cut may pass it; and its
  tool output never is. The note lives in the live context alone.
- **A tokenizer for exact counts.** Rejected: one is exact for one provider's
  models only, and another dependency. The estimate errs high, and the
  provider's refusal is the backstop.
- **A separate, cheaper model for summaries.** Rejected: it would need its own
  credentials and limits, and send the conversation to a model the user did
  not pick for it.
- **Failing the turn when a call cannot fit.** It was the first behaviour: the
  user's message was dropped with the turn, and the next message was sent over
  the same full context.
- **Retrying a refused call until it fits.** Rejected: every attempt is paid,
  and a provider that keeps refusing would be asked forever. One compaction and
  one resend, then the user decides.
- **Cutting the newest input to make it fit.** Rejected: a user's message or the
  results the planner just read, silently shortened, is a planner answering
  something it was not asked.
- **A new message lifting the pause.** Rejected: it would go over the same full
  context. For a window no catalog states, only the user's Retry consents to a
  compaction at all.
- **Saving the live context so a reload resumes it exactly.** Rejected: a second,
  unbounded copy of the session's tool output on disk. The inputs are saved
  already, and a turn whose calls changed something is not restarted.
- **Restarting such a turn from the transcript, told what it already did.** It
  was the first behaviour: a note listed the calls and asked the planner not to
  make them again. Rejected: only the model's compliance kept one from running
  twice, and a saved line per call is too little to answer a repeated call
  from. The turn stays paused for the user.
- **Pausing the run with the planner.** Rejected: a task's verdict comes from its
  own evidence, which needs no planner.

## Consequences

- The host's phase-routing ladder is gone; every surface routes a reply with
  one branch.
- The UI's Approve/Reject PRD buttons and Generate Plan button are gone from
  every surface. The user types in the chat.
- `extractJsonObject` is the single parsing seam for the planning phase; it
  existed for plan parsing and also serves as the commit-detector.
- The AI services (`OpenAiService`, `GeminiService`) are stateful across
  conversation turns — they maintain the tool-use message history internally,
  not just within one call. This was the largest implementation cost.
- An API planner's turn can outgrow its model's window and carry on: a summary
  costs paid calls, which the usage totals count. What it condensed is gone
  from the model's context for the rest of the turn, though never from the
  transcript; a model whose window no catalog states gets none of it.
- A planner that cannot fit waits for the user, however long: its turn's inputs
  and the supervisor's wake-ups wait with it, while the run goes on. A retry
  that cannot carry on the live context starts again only a turn whose calls
  changed nothing; after a reload, one that ran a command waits for the user
  to stop it and say where to pick up.
- The interview's depth rests on the prompt and the skill, not on structure. A
  weak model can still transition too early; the user can say "keep asking".
- A future reader sees no `queuedMessages`, no `PrdArtifact`, no
  Approve/Reject buttons and no mode toggles for the interview — this ADR is the
  "why."

## History

- 2026-07-03 — implemented: the stateful loop, one routing branch per surface;
  the minimum-questions floor removed in favour of prompt guidance.
- 2026-07-04 — depth guidance in the interview prompt; the PRD and early-commit
  nudges; hallucinated-tool steering.
- 2026-08-20 — the interview and PRD toggles replaced by skills (`/grilling`).
- 2026-09-25 — fork, rewind (first in place, then as a fork from a point) and
  compaction (#9, #10).
- 2026-10-11 — a fork leaves waiting planner turn inputs behind, not a mid-run edit queue ([ADR-0029](../supervision/0029-the-supervisor.md)).
- 2026-10-25 — compaction keeps the whole transcript and appends a checkpoint that `modelContext()` projects. A rewind reaches past a summary.
- 2026-10-25 — API planners compact automatically between calls on 90% of the model's known window: pruning first, then a checkpoint of the history that landed, then the turn's own older rounds, by summary calls that offer no tools; `/compact` on an API planner uses the same calls. Before it, a fixed 100,000-token threshold pruned only, Gemini never pruned, and `/compact` offered the planner's tools to its summary turn.
- 2026-10-25 — a refusal as too long bounds the chat, compacts once more and resends once; a call that still cannot fit pauses the planner, saved with its inputs and a bounded list of the calls that changed something, until the user's Retry compaction or Stop. Before it, the turn failed and dropped its message.
- 2026-10-25 — found in review: a condensed turn's list of calls counts in its room and a call still past the window by the estimate it was condensed on is held; another model's ratio never holds a call; Gemini sizes its turns as sent and keeps the note in the user's turn; the meter says when automatic compaction is off; a Stop ends a pause a `/compact` was running in; a results-only pause says to switch model. Before it, a condensed call could be sent past the window, a switched model was refused on the old one's tokenizer, and nothing said automatic compaction was off.
- 2026-10-26 — found in review: a call a summary was committed for is held past the 90% budget, not only past the window; the user's Retry is never held before its one send; a new Gemini plan sends its goal in the instructions' turn. Before it, a condensed call could fill 96% of the window, a Retry on a measured model made no call, and a new Gemini plan opened on two user turns.
- 2026-10-26 — found in review: a paused turn whose calls changed something is refused rather than started again from the transcript, and a call a condensed turn already made is answered with what it returned. Before it, only a note asked the planner not to make such a call again.
- 2026-11-10 — a checkpoint restates the planner's decision record whole before its summary, which covers only what the record does not hold ([ADR-0067](0067-the-planners-decision-record.md)). Before it, the summary alone stood for every decision and constraint.
