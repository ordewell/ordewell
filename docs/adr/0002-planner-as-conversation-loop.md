# 0002 — Planner as a conversation loop (messages only)

**Status:** accepted, implemented

Ordewell's planner previously emitted several distinct typed artifacts over the course of planning: `QueuedMessage[]` (parsed from `<<ORDEWELL_QUESTION>>` tags in model output), `PrdArtifact` (a structured JSON with `status`/`feedback` fields and a state machine of `pending`/`approved`/`rejected`), and the task plan itself. Each artifact had its own field on `LegacyPlanState`, its own Session operation (`continueResearchWithAnswers`, `approvePrd`, `rejectPrd`, `generatePlanFromPrd`), and its own host-side routing branch (the ladder in `extension.ts:1162-1172` that inferred which operation to call from plan state). The grill-me mode was observed dying after one question: `Planner.continueResearchWithAnswers` lacked the `if (grillMeEnabled)` fallback guard that `generate` had, so when the model emitted `READY_FOR_PRD` instead of a tagged question, it fell straight to PRD synthesis.

We decided to collapse the planner to a single messages loop — "the LLM either thinks, executes commands, or sends messages to the user, very similarly to OpenCode." There is one channel: assistant messages in, user messages out, until the planner commits the plan as JSON.

## Key properties

- **One persisted dialogue.** `conversationHistory: { role, content, timestamp }[]` on `LegacyPlanState` is the single source of truth for both UI redisplay and model context. It replaces `queuedMessages`, `researchResults` (as prose), and the dialogue aspect of `prd`. Tool-call results are NOT stored here — they live in the AI service's tool-use history; `researchLog` remains the persisted tool trace for the UI.
- **Two operations, not four.** `Session.startPlanning(goal, runners)` kicks off research + the first planner message; `Session.continueConversation(userMessage)` handles every subsequent reply — grill-me answers, PRD accept/adjust, outline confirm. The four former operations are deleted, and the host's phase-routing ladder collapses to one branch.
- **Model decides transitions, no tokens.** The planner reads the conversation and decides when to move from grilling to PRD preview to outline to commit. There is no `<<ORDEWELL_QUESTION>>` tag, no `READY_FOR_PRD` sentinel, no PRD status field. The prompt carries a hard minimum-questions floor for grill-me ("ask at least 3 probing questions spanning every major design branch before transitioning; if you believe the goal is fully clear before that, justify why no more questions are needed — then transition").
- **Final commit is auto-detected JSON.** When the planner decides the user has confirmed the outline, its next response IS the `{tasks:[...]}` JSON (nothing else). The system runs `extractJsonObject` on every planner response; if it parses as a plan, the plan is loaded; otherwise it's rendered as a chat message. `generatePlanFromPrd` collapses into this path — the PRD (when present) is just conversation history the planner references.
- **PRD is a markdown message, saved to disk.** Only when the PRD toggle is on (off by default, opt-in like grill-me). Two steps: a short prose preview (problem, approach, seams, risks) the user accepts in chat, then the full markdown PRD (to-prd template) saved to `.scratch/<feature-slug>/PRD.md` per the Matt Pocock native convention. The feature-slug is proposed by the model and editable by the user in chat before save. Carried on the plan as `prdMarkdown: string`. The typed `PrdArtifact` (with `status`/`feedback`) is deleted; there is no PRD status machine.
- **Research interleaves with conversation.** Tool calls and questions happen within the same turn; the model explores more when it needs grounding mid-dialogue. The AI service maintains authoritative tool-use history across turns (not `conversationHistory`); `researchLog` is the persisted UI trace.
- **No Approve/Reject buttons.** Pure chat. The user types "approve" or "change X"; the planner decides what to do. UI affordances that existed for PRD approval are removed from all three surfaces.
- **Old sessions are wiped.** No migration. The shape change is hard enough that preserving old state costs more than it saves; the saved-sessions store is cleared on first run of the new version.

## Considered options

- **Keep the `<<ORDEWELL_QUESTION>>` tag as a UI hint,** deleting only the
  `QueuedMessage` field. Rejected: the tag is load-bearing presentation state,
  not just a hint, and keeping the parser gadget was the thing being removed.
- **Keep a typed `PrdArtifact` internally** to drive `generatePlanFromPrd`,
  invisible to the user. Rejected: "messages only" means one channel, not one
  channel plus a hidden JSON shape the user had explicitly asked to see gone.
- **PRD as conversation history only, no field on the plan.** Delete
  `PrdArtifact` entirely and re-prompt with the full PRD markdown pasted as
  history on every generation turn. Rejected: bloats context — a single
  `prdMarkdown` field is cheaper to re-render and re-feed.
- **A lightweight UI-hint token for transitions** (`<<PRD>>`/`<<OUTLINE>>`
  sentinels the UI parses for affordances). Rejected: reintroduces parser
  machinery, and the token would ride into conversation history as raw text.
- **User-driven transitions** — the model never stops grilling on its own; the
  user types `/prd` or `/outline` to force phases. Rejected: contradicts the
  point of the interview (the model decides when it's done) and adds friction.
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
- **Migrate old sessions** with a `migrateLegacyPlan` on load. **Wipe them.**
  The wipe won: the shape change is large enough that preserving old state
  costs more than it saves. Both migration variants (full one-shot, and a
  version field with read-only legacy loading) were considered and dropped
  for that reason.
- **Ship core + VS Code first,** CLI and web later. Rejected: two behaviors
  in one codebase is exactly the mess CONTEXT.md warns against. Rejected in
  the shim variant too, for the same reason.

## Consequences

- The host's phase-routing ladder (`extension.ts:1162-1172` — "if `tasks.length===0 && prd` → `rejectPrd`, if `queuedMessages` → `answerQuestions`, …") is deleted and replaced with a single branch: user replied → `continueConversation(text)`.
- The UI's Approve/Reject PRD buttons and Generate Plan button are removed from all three surfaces (VS Code, Web, CLI). The user types in the chat.
- `extractJsonObject` becomes the single parsing seam for the planning phase; it already existed for plan parsing and now also serves as the commit-detector.
- The AI service (`OpenAiService`, `GeminiService`) becomes stateful across conversation turns — it must maintain the tool-use message history internally, not just within one `researchAndPlan` call. This is the largest implementation cost of the change.
- `LegacyPlanState` shape changes: `prd: PrdArtifact` → `prdMarkdown: string`; `queuedMessages` and `researchResults` removed; `conversationHistory` added. Saved sessions are wiped on first run; no migration.
- The PRD toggle is off by default (opt-in like grill-me); TDD is unaffected (it injects a prompt suffix on the executor's task prompt, not on the planner conversation).
- The grill-me bug (one question then PRD) is fixed structurally: the missing `grillMeEnabled` guard in `continueResearchWithAnswers` is moot because that method is deleted; the loop is just "continue conversation." The prompt carries a hard minimum-questions floor to prevent premature transition.
- The `Planner` and `Session` glossary entries are revised, and `conversationHistory`, `PRD`, and `outline` are added to CONTEXT.md.
- A future reader sees no `queuedMessages`, no `PrdArtifact`, no Approve/Reject buttons — this ADR is the "why."

## Update (2026-07-03) — minimum-questions floor removed

The hard "ask at least 3 probing questions" floor described above (added to fix grill-me dying after one question on weak models) has been removed. Grill-me's prompt (`GRILL-ME` block in `buildConversationSystemPrompt`, and `buildGrillMeResearchPrompt`) now matches the original Matt Pocock `grill-me` skill (`~/.claude/skills/grill-me/SKILL.md`) instead: interview until shared understanding with no quota, ask one question at a time with a recommended answer attached, and explore the codebase instead of asking when possible. This is a conscious tradeoff — the one-question-then-transition failure mode this floor guarded against can recur on weaker orchestrator models. If it resurfaces, the fix is either to reintroduce a floor or to steer users toward stronger orchestrator models for grill-me.

## Update (2026-07-04) — anti-early-transition guidance added to grill-me

Field testing surfaced the exact failure mode the removed floor used to guard:
budget models transitioning to the outline after a single question on a vague
goal. Rather than reintroducing a numeric quota (rejected above), the
`GRILL-ME` block now carries explicit depth guidance: "a vague goal is never
resolved by one or two questions", a checklist of design branches to cover
(scope, users, approach/alternatives, constraints, edge cases, testing, out of
scope), a prohibition on proposing the outline/PRD preview while significant
branches remain unexplored, and a one-line justification when transitioning.
This stays prompt-only — no tags, sentinels, or counting machinery — and keeps
the block close to the original Matt Pocock skill's "interview until shared
understanding" intent. Weak models may still under-interview; that remains a
model-strength observation, but transitioning after one question on a vague
goal is now contrary to the prompt and worth reporting when testing.

## Update (2026-07-03) — implemented

The loop landed: `IAiService.startConversation`/`continueConversation` (stateful,
OpenAI + Gemini), `Session.startPlanning`/`Session.continueConversation`, one
routing branch per surface, and deletion of the tag parser, fallback question,
interview corrections, `READY_FOR_PRD`, and the `PrdArtifact` state machine.
One addition beyond the ADR text: a planner turn with empty content (a real
budget-model behavior after tool use) is surfaced as a visible "(empty
response)" message instead of a blank bubble. The offline cheap-model
simulator and live driver in `bench/live/` exercise the loop end-to-end.

## Update (2026-07-04) — PRD fail-safe nudge and planner-tool steering

Live cheap-model sweeps surfaced two silent-degradation paths, both now
repaired structurally (in the spirit of the existing plan-JSON repair retry,
not as a phase machine):

- **PRD mode commit without a PRD.** A budget model can jump straight to the
  task-plan JSON without ever emitting the `ORDEWELL_PRD` block, silently
  committing a plan with no PRD on record. `runConversationTurn` now tracks
  whether a PRD block has appeared (`ConversationTurnContext.prdCaptured`);
  if a plan parses while PRD mode is on and no PRD exists, the loop bounces
  ONCE with a corrective message asking for the PRD block followed by the
  same plan JSON. If the model still refuses, the plan is accepted (visible
  degradation beats trapping the user). Plan turns now carry their raw
  `text` so a PRD emitted in the same turn as the JSON is captured by
  `Session.applyConversationTurn` instead of being dropped.
- **Hallucinated tools.** Budget models invent `create_task`/`create_file`/
  `run_code`-style tools instead of emitting plan JSON, and one model
  concluded from a terse "Unknown tool" error that it could not do the work
  at all. The unknown-tool result now restates the planner's role (read-only
  research; agents execute tasks later) and the commit channel (raw JSON in
  reply text). Relatedly, the plan format's `"id": "uuid-string"` example
  made one model call a nonexistent uuid tool; the example now reads
  "unique-task-id (any short unique string)".

Covered by `BaseAiService.conversation.test.ts` and the bench PRD scenario.

## Update (2026-07-04) — interview depth: prompt anchor + one-shot commit gate

Live probes with neutral replies ("go with your recommendation; ask the next
question if any branch is open") showed grill-me collapsing to a single
question before plan commit on budget models, and the base (non-grill-me)
prompt producing zero clarifying questions on vague goals. Two changes:

- **Prompt.** The base WORKFLOW now says to ask before planning when the goal
  is vague or a decision materially changes the outcome (storage, library,
  scope, API shape) — and that clear goals need no questions. The GRILL-ME
  block gains a depth anchor ("typically five, ten, sometimes twenty or more
  questions on a broad goal"), an explicit "an answer to one question is never
  permission to stop interviewing", and a commit precondition: plan JSON only
  after a presented prose outline was explicitly confirmed.
- **Structure.** `runConversationTurn` tracks `plannerMessageTurns`; in
  grill-me mode a plan that parses before 3 planner message turns (no room
  for even question + outline + confirmation) is bounced ONCE with a
  resume-the-interview message. Like the PRD nudge, it never blocks: a model
  that insists commits on re-emit. This is deliberately a nudge, not the
  numeric quota this ADR removed — the model still decides transitions.

Measured effect (neutral-reply probes, `bench/live/drive-conversation.mjs`):
deepseek-v4-flash 1 → 4 question turns (~8 questions), qwen3.5-flash 1 → 3
question turns, both ending with outline → confirmed commit. Without
grill-me, both models now ask before choosing storage on "add persistence"
and present options on vague goals instead of silently assuming.

## Update (2026-08-20) — grill-me renamed to grilling; superseded by the skill system

The `grill-me` mode toggle and its `GRILL-ME` prompt block described throughout
this ADR no longer exist: the interview workflow moved from a hardcoded
planner-mode toggle to a user-invoked skill (`packages/core/skills/grilling/`,
substituted into the planner's message on `/grilling`) with no settings-surface
toggle at all. The references to `grill-me`, `grillMeEnabled`, and the
`GRILL-ME` block above describe the toggle-based mechanism as it existed at the
time each entry was written and are left as-is; the current mechanism is the
skills system, not a mode toggle.

## Update (2026-09-25) — the conversation line can be rewound or forked; the task list rides along

Issue #9. "One persisted dialogue" above described an append-only line: once a
message was sent, the only way on was another message. The line can now be cut
short or copied:

- **Rewind** truncates `conversationHistory` to just before a chosen user
  message (the opening goal excepted) and the planner's `researchLog` to the
  same point.
- **Fork** copies the conversation and the task list into a new persisted
  session, leaving the original untouched.

Both act on the **conversation only**. The task list — tasks, statuses,
assignments, runner set — rides along as-is: a rewind keeps tasks that the
discarded turns created, and a fork starts with the tasks the original had at
the moment of forking. The one exception is run state, which a fork cannot
carry because it has no run: in-progress and checkpointed tasks become pending,
queued mid-run edits stay behind (`forkPlanState` is the one place that decides
what travels).

Either operation ends with the planner's live context reset through
`PlannerConversation`, so the next message replays from the edited transcript
through the ordinary resume path. That is what makes the feature identical on a
vendor API planner and on a harness planner (ADR-0009), whose native session id
the reset clears — otherwise the agent would resume its own memory of the
discarded turns underneath the replay. Both are refused while a planner turn is
in flight; a task run is no obstacle.

**Rejected: reconstructing the plan as it was at the rewind point.** It would
need plan history (versioned `PlanStore` snapshots per turn) and a rule for
tasks that ran or completed after that point — whose effects are in the
working tree, not in the transcript. Rolling the plan back while the code keeps
the work is a second, less predictable kind of drift. Keeping the task list
as-is makes the result obvious — the conversation moved, the plan did not — and
the planner sees the real current plan in its per-turn block on the next
message, so it can reconcile anything the user wants changed.

## Update (2026-09-25) — the conversation line can be condensed on request

Issue #10. The line only grew: reactive and proactive compaction
(`contextCompaction.ts`) prune tool output on the planner's schedule, and only
under pressure. A user can now ask for the conversation itself to be condensed.

One hidden planner turn produces a summary; the transcript is replaced by a
`compaction` entry holding it, followed by the last two user messages and their
replies verbatim; the live context is reset. Like rewind and fork it is a
transcript edit plus `reset`, so it is the same on a vendor API planner and on a
harness planner (ADR-0009) — the summary is asked through the planner's own
conversation, not through a vendor-specific compaction call the harness agents
do not share. The task list is out of it: anything the summary turn emits beside
the summary, task ops included, is discarded.

Two rules keep it safe. The summary must be wrapped in tags, because a harness
planner returns a crashed agent's error as a normal reply and would otherwise
overwrite the transcript with it; and nothing is written until the summary is in
hand, so a failure or a stop is a no-op. A rewind cannot cross the summary — the
turns before it no longer exist — and a fork copies the condensed transcript.

**Rejected: a deterministic prune of the transcript, with no summary turn.**
The transcript holds no tool output to prune (the tool history lives in the
model's context and `researchLog`), so what makes it long is the dialogue
itself, and only a model can say which of it still matters.

**Rejected: asking the planner's own native compaction (a harness agent's
`/compact`).** It exists only on some harnesses, leaves Ordewell's persisted
transcript at full length, and the two would drift.

A third rule came out of reviewing this with the other surfaces: a message sent
while the summary is being written is refused (`ConversationBusyError`, a 409
from the daemon), the way a compaction is refused while a reply is in flight. The
TUI lets a message through during `/compact`, and taking it would have shared the
summary turn's live context — which the compaction resets as it lands — and
condensed the message away unanswered. The daemon refuses it before touching the
planning abort slot, so a stop still reaches the summary turn.

The VS Code extension offers all three (`/fork`, `/rewind [n]`, `/compact` and
matching Command Palette entries) by calling `Session` directly, since it does
not use the daemon. Its host refuses a planner message during `/compact` by
locking the webview input, with core's `ConversationBusyError` behind it. A
rewind or compaction redraws only the webview's transcript, never the plan or a
running task's output, because both are allowed mid-run. A fork is loaded as a
saved session, and loading replaces the extension's single `Session` and stops
its run, so the extension asks before forking while one is executing.
