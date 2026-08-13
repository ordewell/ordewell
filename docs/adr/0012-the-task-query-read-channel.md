# 0012 — The task-query read channel: reading a task before rewriting it

**Status:** accepted

The per-turn plan context block (`Session.planContextBlock`) deliberately
carries only short fields — id, order, title, status, type, runner, model,
mode, effort, autonomy, deps. A twenty-task plan re-sent in full on every
message would burn thousands of tokens a turn on content the model is not
touching, so the block was built to be cheap by construction: it never
carries a task's `prompt`, its `description`, its `userSteps`, a completed
task's `verdict` or `outputSummary`, or `userStoriesCovered`.

That left the planner with no way to ground an edit in what a task actually
says. "Tighten task 3's prompt" or "does task 5 still make sense given what
task 2's verdict says" name content the model has never read — the plan
block shows task 3 exists and what runner it is on, nothing about what its
prompt contains. A model asked to rewrite a field it cannot see either
fabricates plausible-sounding content (ADR-0001: the plan is supposed to be
the source of truth, not a guess dressed as one) or the user has to paste the
current text back into chat by hand, which defeats having a plan the model
can already see at all.

The same gap sits behind the runner/model catalog. `Session.catalogBlock`
already re-sends the *ids* every turn so an edit can pick a valid
`assignedModel`/`taskMode` without scrolling back to the system prompt, but
it caps at 100 models per runner and never carries a model's label, its
thinking-effort variants, or a mode's description — detail a query answer
carries in full, once, on the turn that actually needs it.

## Decision

**A `taskQuery` reply kind** — `{"taskQuery":{"tasks":[...], "fields"?:[...],
"catalog"?:true}}` — structurally alongside the plan and `taskOps` envelopes
Ordewell already parses. `classifyPlannerReply` (`PlanRepair.ts`) recognizes
it and a malformed attempt (`broken_task_query`) the same way it recognizes a
botched plan or a botched edit: worth a corrective re-emit, not silence.
`TaskQuery.ts` owns the wire shape, the reference resolver (id / `#order` /
bare order / exact title), and the rendered answer; `Session.drainTaskQueries`
owns the loop, the budget, and the injection.

A query is answered **outside** `repairLoop`, in its own small loop, before a
settled turn is ever handed to `applyTaskOpsTurn` or `applyConversationTurn`:

1. The planner replies with a `taskQuery`.
2. `Session` renders the answer — the full body of each named task, filtered
   to the requested `fields` (or every field, unfiltered), plus the full
   catalog if asked — from **live state**, and sends it back as the next
   user turn.
3. The planner reads it and replies again — with another query, with the
   `taskOps`/plan JSON for the edit it came to make, or with prose.

Steps 1–3 repeat until the planner stops asking. Nothing is written to the
plan by a query and nothing is persisted to `conversationHistory` — the
answer is context for the very next reply, not a fact worth keeping once the
turn moves on, so it is rebuilt from scratch on every single query rather
than cached or replayed.

## Key properties

- **One text envelope for both planner backends, like `taskOps` before it
  (T1).** The channel is prose the model reads and writes, not a registered
  tool call, because a harness planner (ADR-0009) is a subprocess Ordewell
  does not own a tool loop for — `TASK_QUERY_PROTOCOL` is taught in
  `buildConversationBody` for both the harness and API variants, verbatim,
  the same way the `taskOps` protocol already is. A tool-call version would
  only work for the API path, forking the read channel exactly where
  ADR-0009 spent its effort keeping the two backends on one protocol.
- **Reads are free of the repair budget (T2).** `drainTaskQueries` runs before
  `repairLoop` is entered for the first reply, and is threaded through
  `first`/`resend` so a retried turn keeps draining too. A planner that reads
  a task and then fumbles its `taskOps` JSON still gets the two corrective
  retries that mistake is owed; charging the read against that budget would
  cost the model its chance to fix the edit it was trying to make correctly.
- **Reads settle even mid-run (T3).** The queue gate in `continueConversation`
  — structural edits during live execution are queued, never applied live —
  sits *after* `drainTaskQueries`, not before. A query mutates nothing, so
  parking it behind a batch boundary would strand the planner waiting on
  detail it needs to write the very edit that is about to get queued.
- **Budgeted, not unlimited (T4).** `MAX_TASK_QUERIES` (3) is the point past
  which every answer also carries `TASK_QUERY_ANSWER_OR_OPS`, an instruction
  to land the turn; `MAX_TASK_QUERIES_HARD` (6) is where the loop gives up
  and returns a message turn instead of answering again. Both budgets are
  per **user turn** (a fresh `ReadBudget` per `continueConversation` call),
  not per conversation, so a long chat is not throttled by its own history.
  A repeated identical query (`taskQuerySignature`) is treated the same as
  hitting the soft cap early — asking the same thing twice is a loop, not a
  read, and gets the landing nudge on the very next answer rather than
  waiting for three genuinely new questions to also arrive.
- **Refusing to answer was rejected as the backstop (T5).** Unlike a `bash`
  tool call (ADR-0008, T5: "absent is denial"), a read that stops being
  answered is not a safe default here — the planner has no other way to get
  the detail, so silence just relocates the fabrication problem this channel
  exists to remove. The hard cap still answers the detail; it only forces
  the *next* reply to be an edit or prose, never a silent refusal.
- **Checked before the plan key, deliberately (T6).** `classifyPlannerReply`
  tests for `taskQuery` before it tests for the `tasks` envelope key, because
  a query's own body is `{"tasks":[...]}` too — an unguarded plan check would
  read every query as a botched plan attempt and spend a corrective retry
  fixing a reply that was never wrong.
- **Answered against the same catalog an edit is checked against (T7).** The
  full-catalog answer (`renderTaskQueryAnswer`'s `<runner_catalog>` block) is
  built from the allowlist-filtered models and the manifest modes — exactly
  what `TaskEditValidator.checkModelAndModeValidity` validates a following
  `taskOps` edit against. A refusal on the edit that follows can therefore
  never name something invalid that the read just told the planner was fine,
  or vice versa.
- **One validator, an actor parameter, not two rulebooks (T8).**
  `TaskEditValidator.validateTaskEdit(actor, ...)` is the shared checker
  behind both `applyTaskOps` (`actor: 'planner'`) and `Session.updateTask`
  (`actor: 'direct'`). The lock rule (no touching an `in_progress` or
  `completed` task) applies only when `actor === 'planner'`; well-formedness
  rules — dependency validity, the AI↔MAN type-coherence check — describe the
  task rather than who is editing it, so they run for both. See CONTEXT.md,
  "Direct edit vs planner edit."
- **Works before a plan exists (T9).** `catalog: true` needs no `tasks` array
  and no committed plan — it is legal on the very first planning turn, so a
  planner unsure what a runner offers can ask instead of guessing from the
  capped `<available_models>` block, before task 1 is even drafted.

## Considered options

- **Register `read_task` as a tool call (M1).** Rejected as the transport
  (T1): only the API-backed planner has a tool loop Ordewell owns. A harness
  planner (Claude Code, Codex, OpenCode running *as* the planner) brings its
  own tools and its own loop; Ordewell can hand it appended system-prompt
  text but not a callable function. Registering a tool for one backend and a
  text protocol for the other is the fork ADR-0009 was written specifically
  to avoid.
- **An MCP server exposing `read_task`/`apply_task_ops` (M2).** The genuinely
  better end state, and deferred for the same reason ADR-0009 deferred it for
  plan submission (its M5): there is no MCP code anywhere in this repo today,
  so shipping it means standing up a stdio JSON-RPC server plus per-CLI
  registration for Claude Code, Codex and OpenCode before the first read
  works, for a channel whose text-envelope version already ships with zero
  new infrastructure.
- **Silently coerce an invalid model/mode instead of refusing (M3).**
  Rejected. `coerceAssignments` already exists as the safety net for paths
  that bypass the validator entirely (a plan committed with a stale catalog,
  for instance) — snapping a bad id to `allowlist[0]` and clearing the paired
  effort is the right move *there*, where there is no model on the other end
  of a repair loop to ask. Inside `validateTaskEdit`, a planner mid-edit gets
  the refusal instead: it names the runner and the bad id and comes back
  through the same corrective retry every other rejected edit uses. Coercing
  quietly would let a plan drift onto a model the user's allowlist forbids
  without either side ever being told it happened.
- **Require every task referenced inside one batch to carry a real UUID,
  including tasks the batch itself creates (M4).** Rejected. An `add` op's
  task does not have an id yet when a later op in the same batch wants to
  point at it — "add a task, then make the next one depend on it" is one of
  the most ordinary edits a planner makes. Forcing the model to invent an id
  up front (and Ordewell to trust an LLM-minted UUID isn't already taken) or
  forcing a round trip to learn the generated id after the `add` op is
  smaller and slower than the model an ordinary edit needs to be. Batch
  `handle`s solve exactly this: any unused name, valid only forward-declared
  within its own batch, resolved before any op runs and rejected outright if
  a later op tries to reference one that has not been defined yet.
- **Inline every task's full body in the per-turn plan block, always (M5).**
  Rejected — this is the cost this channel exists to avoid. A twenty-task
  plan resending every prompt, every set of user steps, and every verdict on
  every single turn is thousands of tokens paid on turns that touch none of
  it. The query channel pays that cost only on the turns that actually need
  the detail, and only for the tasks named.
- **No budget on reads (M6).** Rejected: a planner that misreads the protocol
  or gets stuck in an edit it cannot resolve would otherwise read forever
  with nothing to stop it. The escalating-insistence design (soft cap nudges,
  hard cap forces a landing message) was chosen over an outright refusal
  past the cap specifically because refusing reads as a hang the model has no
  way to escape (T5) — the alternative of simply cutting the model off was
  rejected for the reason ADR-0008 already established for `bash`: an
  unanswered request is worse than an answered one that comes with a nudge.
