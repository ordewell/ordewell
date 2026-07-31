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

- **Tag-parsed questions (B at Q2).** Keep the `<<ORDEWELL_QUESTION>>` tag as a UI hint, delete only the `QueuedMessage` field. Rejected: keeps the parser gadget the user wanted gone; the tag is load-bearing presentation state, not just a hint.
- **Typed PrdArtifact as hidden plumbing (B at Q1).** Keep `PrdArtifact` JSON internally to drive `generatePlanFromPrd`, invisible to the user. Rejected: redundant typed shape the user explicitly wanted removed; "messages only" means one channel, not one channel plus a hidden JSON.
- **PRD as conversation history only, no field on plan (C at Q1).** Delete `PrdArtifact` entirely; re-prompt with full PRD markdown pasted as history on every task-generation turn. Rejected: bloats context; `prdMarkdown` as a single field is cheaper to re-render and re-feed.
- **Lightweight UI-hint token for transitions (B at Q3).** The model emits a sentinel (`<<PRD>>`/`<<OUTLINE>>`) the UI parses for affordance rendering. Rejected: reintroduces parser machinery; conversation history would carry the token as raw text.
- **Explicit user-driven transitions (C at Q3).** The model never stops grilling on its own; the user types `/prd` or `/outline` to force phases. Rejected: contradicts the grill-me thesis (the model decides when it's done); adds friction.
- **Single PRD message, no separate preview (B at Q5).** The model writes one markdown PRD directly; "agree?" is the only gate. Rejected: skips the to-prd seam-check step the user wanted to match; the expensive full PRD gets rewritten whenever the model misread the goal.
- **Lean preview that expands to full PRD on accept (C at Q5).** One user gate, two model turns. Rejected: loses the explicit accept gate between preview and full PRD.
- **Fenced JSON inside prose (B at Q6).** The model emits `Here's the plan:\n` + a fenced JSON block; the system extracts the fence. Rejected: reintroduces a parser gadget (fence extraction) for marginal narration value.
- **User-triggered generate button (C at Q6).** The outline loop is conversational; a "Generate plan" button triggers the JSON commit. Rejected: contradicts "model decides transitions" (Q3=A); adds a UI affordance the user wanted removed.
- **Keep four operations relabeled (C at Q11).** Each phase stays a distinct Session method; the host infers which to call from plan state. Rejected: keeps the multi-artifact surface and the host routing ladder the user wanted gone.
- **Three operations: start + continue + commit (B at Q11).** A separate `commitPlanFromJson` the AI service calls back into. Rejected: invents an extra seam; the JSON commit is just "the planner's final message happened to be JSON," not a distinct operation.
- **Deterministic slug from goal (B at Q7).** Kebab-case the goal string. Rejected: produces ugly/ambiguous slugs for long goals.
- **User-prompted slug via modal (C at Q7).** VS Code input box at save time. Rejected: breaks the chat-only UX thesis.
- **Distinct research phase before conversation (A at Q8).** Research happens once, then dialogue is purely messages. Rejected by the user: less OpenCode-like; the user wanted interleaving.
- **On-demand research mid-conversation (C at Q8).** No upfront research pass; the model explores only when a question needs grounding. Rejected: risks under-grounded questions early.
- **researchLog collapses into conversationHistory (B at Q9).** One unified store including tool results. Rejected: tool results (file contents) bloat persisted state and model context; the model gets them via the API tool-use stream, not by re-reading conversation history.
- **Drop researchLog entirely (C at Q9).** Tool calls are ephemeral; only prose persists. Rejected: loses the tool-call evidence trail on reload.
- **Model summarizes tool results into prose (B at Q10).** Tool history is ephemeral; only prose summaries persist. Rejected: loses raw detail the model might need in later turns.
- **Mirror tool results into conversationHistory (C at Q10).** `conversationHistory` becomes the full API message history. Rejected: bloats model context with raw file contents every turn.
- **One-shot migration of old sessions (A at Q12).** A `migrateLegacyPlan` function converts old shape to new on load. Rejected by the user: "Remove all the previous sessions, I don't care."
- **Version field + lazy migration (C at Q12).** Old sessions load read-only with a re-plan notice. Rejected by the user for the same reason.
- **Core + VS Code only (B at Q13).** CLI and Web keep current behavior temporarily. Rejected: creates the two-behaviors-one-codebase mess CONTEXT.md warns against.
- **Core only, surfaces later (C at Q13).** Ship core with compatibility shims; update surfaces separately. Rejected for the same reason.

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
