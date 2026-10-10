# Ordewell — Domain Glossary

The shared vocabulary for Ordewell. When code, issues, plans, or refactor proposals
name a domain concept, use the term as defined here. Synonyms listed under *avoid*
are deliberately not used — they blur a distinction the project cares about.

This file is the vocabulary the rest of the documentation is written in (see
[AGENTS.md](AGENTS.md)), and it grows as terms get resolved during design.

---

## Planning & execution

**PlanStore** — the deep module owning all plan-shaped state: the task tree
(`planTasks`), the flattened index (`allTasks`, `taskMap`), and `planRunners`.
Owns structural CRUD (`add`/`remove`/`update`/`merge`/
`split`), status mutations (`markCompleted`/`markFailed`/
`markInProgress`/`retry`), the named run-preparation op (`resetForRun` — flip
AI tasks to approved, preserving completed ones unless the plan was freshly
generated), runner-set validation, and the `rebuild` internal seam. Completed
and failed are read from `task.status` alone — there is no second record — so
`isCompleted`, `completedCount`, `isAllComplete` and the scheduler's
dependency checks always agree. The store owns its task objects: `load` copies
what it is given, the getters return readonly views, and `snapshot()` is the
detached copy a caller may keep or persist. The TaskOrchestrator is a
pure scheduler that calls `store.markCompleted(id)` instead of mutating task
state directly; Session owns the store and routes plan mutations through it.
*Avoid:* "the task list", "the plan state" — PlanStore is the module; the
plan is the artifact.

**Session** — the deep module owning one plan's full lifecycle: generation,
execution, mutation and persistence. It
*hosts* the planner conversation but does not own it: `startPlanning`,
`continueConversation`, `isConversationActive`, and the **Planner turn**'s
`isPlannerBusy` and `abortPlannerTurn` are thin delegations to a
**PlannerConversation**, which reaches plan state, persistence and scheduling
only through the host interface Session hands it.
**`createSession(deps)` is the composition root**: hosts pass injected adapters
(`config`, `runner`, `registry`, `fsAdapter`, `broadcast`, `modelResolver`,
`settings`, and optionally `aiService`/`planner`/`isolation`/`taskOutput`/
`saveSession`) and it builds every collaborator — PlanStore, the
TaskOrchestrator, the **SessionCatalog**, the approval chain, the web fetcher, the
**SessionEventRelay**, the live planner transport — and wires them, so the
Session constructor only receives them. The deps are the test seam
(`makeSession` builds through `createSession` with a persistence fake); no test
reaches into private fields, and none spies on a module export. The Session is
transport-agnostic. The orchestrator's observer is subscribed once for the
session's lifetime (not per-operation), killing the double-subscribe class of
bug — and it is the orchestrator's *only* notification channel: refresh
signals travel over it and become `status_update` broadcasts (there is no
separate `onRefresh` callback for a surface to wire). The queue-ready signal
is the Session's alone: it drains its own **Pending plan edits** when the
scheduler parks behind them, so no surface is told or has to act.
The Session adds to the relay's observer only the saves some events owe, each
made before the event is announced: a task that settles on its own
(`onTaskSettled` — completed, failed or awaiting the user) is saved as it
settles, so a shared run does not wait for its end to record a verdict.
These execution-event saves are *background* saves: one that lands in the
middle of a planner turn does not settle that turn (see *PlannerConversation*).
Mutation is an internal seam — every structural plan mutation *and every
settled conversation turn* (plan commit, task-ops apply, planner message) runs
one `mutatePlan` ritual (store op → persist → broadcast), and so does the
between-batch drain of queued edits. The ritual covers plan
edits only. User controls that change task state through the orchestrator
(execute, approve the review, reschedule, stop, retry, cancel, mark complete or
not done, force start, run one task, continue a task, the two ways past a dirty
tree, Merge all, clean up or discard a run, a task message, force sending or
withdrawing a queued one, interrupting a structured turn, a checkpoint answer)
are saved before any surface hears of them too: a synchronous one holds its
`status_update` until the save, and an asynchronous one (`withSave`) saves
before each `status_update` announced while it runs, and once more when it
ends — a hold across its spawns and git work would stall every task's status
and let an `execution_complete` it causes overtake the update held back. The
saves made while it runs are background saves, as are a task control's own;
so is the run going on after a drain of **Pending plan edits**, which is
saved before its statuses go out the same way. `generatePlan` and `loadPlan` persist
the plan they adopt directly. Direct (non-planner) edits go one step further
through `editPlan`, which adds the reschedule they owe an armed scheduler:
nothing else wakes one after a hand edit, because a direct edit never queues,
so a task the edit unblocked would sit ready and never start. PlanStore is the single source of truth for task
state; `LegacyPlanState.tasks` is written from it (a `snapshot()`, never the
live tree) at persist and status-broadcast time and never read back into it. The old
`syncStoreFromPlan` (plan → store direction) is removed — there is only one
direction (store → plan, at persist). Emits
**SessionMessage** (the plan-lifecycle events) through the `broadcast` seam;
catalog/config messages (`setModels`, `setRunnerList`, …) stay on the host.
The web pool and the VS Code extension are the two real adapters that justify
the seam. Planner progress is broadcast-only: `ResearchProgress` is translated
to SessionMessage by the Session's relay, and there is no
per-call progress override for a surface to bypass it with. The web pool
itself holds only what earns its keep — the session registry
(`Map<sessionId, Session>`), the WS fan-out, and the session-creating
operations; routes reach a session's interface via `pool.session(id)` instead
of per-verb forwarders, and the pool never caches plan state (the Session is
the plan's owner).
Session boundaries are hard: `startPlanning`/`generatePlan` begin from zero
(`beginFreshPlan` drops any live conversation and every leftover task, log,
and queued message), `loadPlan` of a *different* plan drops the live LLM
conversation plus the old plan's log/queue (the first user send reseeds from
the adopted plan's own transcript), and hosts call `Session.reset()` on "new
session" for a full wipe with a freshly minted identity. Nothing from one
session may surface in another — a long-lived Session (VS Code hosts exactly
one) otherwise presents the previous session's tasks to the planner as the
current plan.
*Avoid:* "the pool" (that's the web transport host), "the session manager" —
Session is the lifecycle owner, not a registry.

**SessionCatalog** (`services/SessionCatalog.ts`) — what one session may
assign, behind one interface: the enabled runners, their manifest modes, the
models discovery found for them, and the allowlist narrowing those. Built in
`createSession` and handed to the Session and the *PlanEditor*, so the
planner's per-turn block (`queryCatalog`), its tools (`live`), a user's direct
edit (`edit`, `runner`) and planning (`planning`) all read the same state —
settings are read live at each call, never captured, so a runner enabled or an
allowlist edited mid-session counts (#69). The per-runner discovered models are
**merged into, never replaced**: discovering one runner must not forget
another's, because coercion clamps thinking efforts against whatever was last
found. `admit(runner, models)` is how an admitted runner keeps its models there
(an empty discovery never displaces what is known), which `PlanEditor.admitRunner`
calls alongside adding the runner to the plan. `reset()` drops it all at a
session boundary. The default runner set (`DEFAULT_RUNNERS`, `models/Task.ts`)
is defined once for the store, the orchestrator and the Session.
*Avoid:* "model cache" for the whole thing — the cache is one part of it, and
the *ModelResolver*'s own cache is a different one that this overlays.

**SessionEventRelay** — the one place a surface's view of a Session is made:
it turns orchestrator events (task changes, ticks, review, checkpoints,
isolation, execution complete) and planner progress into **SessionMessage**
broadcasts, holds status updates back while a mutation is in flight, and
gathers a turn's subagent runs until the Session's next persist folds them
into the research log. It never persists; where an event owes a save, the
Session saves before handing the event on. Built by `createSession`, tested
directly against a fake broadcast.
*Avoid:* "the broadcaster" — `SessionBroadcaster` is the transport callback the
relay sends through, not the relay.

**PlannerConversation** — the deep module owning the planner conversation
(ADR-0002) end to end: the persisted dialogue record (`conversationHistory` and
the planner's `researchLog`), the live model context behind it, and every turn
from the user's message to a settled outcome. Planner turns settle through one
path: the first turn and every later turn get the same read draining (the
task-query channel), task-ops validation and bounded corrective retries, and
commit through the host's `mutatePlan` ritual. It builds the per-turn prompt
blocks (the always-on catalog block and the current-plan block, whose edit
protocol prose lives beside the applier as `taskOpsProtocol` in `TaskOps.ts`).
The live model context — a vendor service's message list, a harness planner's
process and native session id — is disposable: `reset()` drops it, and the
next turn is replayed from the transcript (`reset` runs before every replay,
so a harness planner never resumes its own memory on top of the replayed
one). A turn that throws before anything was persisted rolls its own writes
back (`snapshot`/`restore`); once anything has been persisted, memory already
matches disk and the rollback declines. A background save — a task settling
mid-turn — does not count: the turn still rolls back, and the undo is saved
through the mutation ritual so disk follows memory. Transcript edits are whole-array
operations (`append`, `replace`), so compacting a conversation is a
transcript edit plus a `reset`; forking and rewinding copy it instead
(`clone`, `cloneBefore`) and leave it as it was. It owns the **Planner turn**
too, so no surface keeps its own abort controller or busy flag, and a turn that
settles after its plan was swapped out never writes into the new one.
*Avoid:* "chat" or "thread" for the module — the conversation is the thing; the
AI service only holds a disposable copy of it.

**Planner turn** (`PlannerTurn`; `Session.isPlannerBusy`,
`Session.abortPlannerTurn()`) — the one piece of planner work holding a
session's conversation at a time: a reply (merge and split requests included),
a compaction, the conversation's opening, or one-shot plan generation.
Starting one creates its abort signal, and a caller's own signal is relayed
into it. A turn that continues the dialogue is refused while another is live
(`ConversationBusyError`, 409 from the daemon); one that starts a fresh plan
supersedes it. `abortPlannerTurn` *stops* the turn: it still settles, with
whatever the backend had, as `stopped`. A turn whose plan is dropped under it —
a new plan, another session adopted, the session closed — is *abandoned*:
stopped, the conversation freed at once, and whatever it settles is discarded
(`PlannerTurnDiscardedError`) instead of committed. So is a reply cut off by
something other than its own stop (an `IAiService.reset`), since what such a
call hands back is a fragment.
A turn that throws while stopped or abandoned surfaces as a typed error whatever
the backend named its own — `PlannerTurnStoppedError` or
`PlannerTurnDiscardedError`, the original kept as `cause` — one-shot generation
included, so a surface checks the type, never an SDK's abort error. The daemon
answers both as 409 (`planner_turn_stopped`, `planner_turn_discarded`) without
logging a fault.
*Avoid:* "planning abort" or "generating" for it — both named a surface's copy
of this state, and the copies drifted; *Avoid:* confusing it with **Turn**, the
streamed span a surface draws under one `turnId`: every user turn is a planner
turn, but a compaction or a one-shot generation streams no Turn.

**SessionMessage** — the single union every delivery surface consumes: the
plan-lifecycle events (`plan_generated`, `planner_message`, `status_update`, …)
plus the planner streaming variants (`planner_text_delta`,
`planner_thinking_delta`, `plan_token`, `research_step`, `research_step_done`,
…). Each meaning has one message: all planner thinking, whatever the backend,
is `planner_thinking_delta`, and `plan_token` is only the "building plan"
display of a streaming JSON envelope, never reply prose. Produced only behind the Session's
`broadcast` seam; the core-internal `ResearchProgress` union never crosses
into a surface. Surfaces adapt it to their own presentation protocol (VS Code:
`ConversationViewHost` folds it into core's conversation view and sends the
webview block patches; web: raw JSON over WS) but never
re-map `ResearchProgress` themselves.
Isolated execution (ADR-0013) travels on it too: each `status_update` task
carries `isolation` (`state: none | active | integrated | conflict | kept`, plus
its branch and worktree) — absent altogether while the plan has no isolation
run, so a shared-root plan's updates are exactly what they were;
`isolation_blocked` says a run did not start on a dirty tree; and
`isolation_handoff` (integration branch, base ref, landed tasks) is sent when an
isolated run settles, *before* `execution_complete`.
Under ADR-0014 a task's `isolation` also names the `repos` it changed and, while
it is conflicted or failed to land, the `conflictRepo` that stopped it;
`isolation_blocked` names the dirty `repos` of a group; and `isolation_merge`
carries what *Merge all* did, blocked repos and all, to every surface.
*Avoid:* "event", "progress callback" for this concept — and do not add a
per-call progress override; the broadcast seam is the only channel.

**ResearchStep outcome** — how one research tool call ended, as data:
`success | failure | refused | denied | not_executed`, derived once by
`classifyOutcome` and carried on every `research_step_done` alongside the
model's `toolCallId`. A surface renders the outcome and matches a result to its
pending call **by id** — never by tool name, which crosses results in a parallel
tool round, and never by re-parsing refusal text. See ADR-0008.
*Avoid:* treating `success: false` as one undifferentiated failure — a refused
`rm`, a denied path, and a broken command are three different things to a user.

**Planner** — the cheap, read-only model that researches the repo and emits *the
plan*. Never writes code. See `docs/why-a-separate-planner.md`. Interactive
surfaces talk to it through the **conversation loop** (ADR-0002): one persisted
dialogue where the model thinks, executes read-only commands, or sends
messages, until its final message IS the plan JSON. There are no question
tags, phase sentinels, or question quotas — the model decides transitions,
like a normal chat session.
*Avoid:* "the AI", "the agent" (ambiguous with executors).

**PlanRepair** — the one owner of "the model emitted something unusable —
correct it and retry". `repairLoop` is the bounded driver (first reply →
interpret → corrective re-send) behind plan generation
(`generatePlanWithRepair`), the Session's task-ops settlement, and
`Planner.modifyDuringExecution`; `classifyPlannerReply` decides what a planner
reply *is* (plan, task ops, a botched attempt at either, or prose) and owns
the envelope keys (`PLAN_ENVELOPE_KEY`/`TASK_OPS_ENVELOPE_KEY`, defined in
JsonExtractor) plus every corrective prompt text. A conversation turn's
reply settles through `settleReply`, built on `repairLoop` beside it, on
both planner families (see **Corrective retry**). Policies (PRD nudge, ops
validation, abort guards) stay at the call sites — inputs to the loop, not
part of it.
*Avoid:* hand-rolling a retry loop or a corrective prompt at a call site —
adapt `repairLoop` instead.

**Corrective retry** — a re-send a planner reply is owed when it cannot
settle as it stands, made by `settleReply` in the same way for an API planner
and a harness planner (ADR-0009): one nudge per turn for an empty reply
(naming the call that was denied, if one was), and up to `MAX_JSON_REPAIRS`
(2) re-emits for a botched envelope — for a plan cut off by the output limit,
the terser re-emit, after freeing context where Ordewell holds it. What the
discarded attempt streamed is retracted before the retry answers, the plan
display included. The families differ in exactly two explicit options: only
an API planner can compact its context (`compactHistory`), and only a harness
planner's reply joins every segment of its call, so it retracts them before
settling as prose (`replyJoinsSegments`). How one call runs — tool rounds, or
an agent's turn — is the caller's `send`.
*Avoid:* counting a harness planner's wait for its backgrounded subagents as
one — that turn is continued on the user's behalf, and its text stays in the
reply; *Avoid:* counting a task-ops validation retry (the conversation's own
`repairLoop`) against this budget — it is a separate, later loop.

**Context compaction** (`contextCompaction.ts`) — comes in two kinds that share
a name and nothing else: this entry's *reactive/proactive* compaction, which
Ordewell triggers on its own, and the *user-triggered* **Compaction** below,
which the user asks for. This one is the recovery for a plan
emission cut off by the output-token limit (a long research phase, especially
with subagents, bloats the planner context until the final JSON no longer
fits). Truncation is detected two ways — the unbalanced-JSON heuristic
(`PlanParseError.truncated`) and the provider's `finish_reason === 'length'`
(`ResearchTurn.finishReason`) — and the retry then differs from a normal JSON
repair: `ResearchChat.compactHistory()` prunes raw tool transcripts in place
(subagent digests are kept whole — a digest already *is* the compressed
research thread) before `truncatedPlanReEmitPrompt` asks for a terser
re-emit. The one-shot fallback prompt is bounded the same way by
`compactResearchResults`. Compaction also runs proactively
(`withProactiveCompaction`, wrapped around the chat by both planner loops):
providers report exact prompt tokens per turn (`ResearchTurn.promptTokens`,
via `stream_options.include_usage` / Gemini `usageMetadata`), and a turn at or
past `COMPACTION_LIMITS.proactivePromptTokens` compacts immediately so the
plan emission is never the first moment context pressure surfaces — the
reactive repair is the backstop, not the primary path.
*Avoid:* a truncation retry that re-sends the same context — it will be cut
at the same point again.

**Compaction** (`Session.compactConversation()`) — the user-triggered kind: the
user decides a planner conversation has grown unwieldy and asks for it to be
condensed, on a live turn rather than after a cut-off. One hidden planner turn,
through whichever planner is configured, asks for a summary of the goal,
decisions, constraints, open questions, key file and code findings and where the
plan stands. The live context is pruned of bulky tool output first
(`IAiService.pruneContext`, the same pruning **Context compaction** does), or
the whole transcript is replayed into the turn when no live context matches. The
transcript then becomes a `compaction` entry — the summary, visible, always
first — followed by the last two user messages and their replies verbatim, and
the live context is reset so the next message replays from that shorter record
on every backend alike — unless the compaction was abandoned with its plan,
whose drop already reset it, and a second reset would cut off the turn that
has the backend since. The summary must arrive inside `<conversation_summary>`
tags: a harness planner reports a failure as an ordinary reply, and the tags are
how a dead agent is told apart from a summary. Anything else the turn emits —
task ops included — is discarded, so the task list is untouched, and nothing is
written until the summary is in hand, so a failed or stopped turn leaves the
conversation as it was. Refused while a planner turn is in flight and when the
conversation has two user messages or fewer; a message sent while it runs is
refused in turn (`ConversationBusyError`, 409 from the daemon), since the reply
would share the live context the compaction resets. **Rewind** stops at the summary
(its entry plays the part the goal did) and **Fork** copies the compacted
transcript. Only the planner conversation compacts, never a runner. TUI and
VS Code `/compact` (VS Code also "Ordewell: Compact Conversation", cancellable
from its progress notification, with the chat input locked while it runs); CLI
`ordewell compact`; the daemon route is
`POST /api/plans/:id/conversation/compact`. It announces itself with a
`planner_message` carrying the summary.
*Avoid:* "summarize" for the operation — the result replaces the transcript; and
"clear", which loses what was decided.

**conversationHistory** — the planner dialogue persisted on the plan state:
`{ role: 'user' | 'assistant', content, timestamp, kind? }[]`. The single source of
truth for UI redisplay. Tool-call results are NOT stored here — they live in
the AI service's in-memory tool-use history; `researchLog` remains the
persisted tool trace. A reloaded session resumes by replaying this transcript
into a fresh model context; the tool history is gone. Written only by
**PlannerConversation**: conversation turns, queued mid-run edits
once the Session's drain applies them (a `system` entry, so the transcript
and the plan do not drift apart), and a **Compaction**, which replaces it with
a summary and its last two exchanges. A **Rewind** never writes it: the
shortened copy goes to a new session. Every
write is persisted and broadcast through Session's `mutatePlan` ritual.

**Rewind** (`Session.rewindConversation(index)`) — fork the conversation from
just before one of the user's messages: a new persisted session holds the
transcript up to that message (`conversationHistory.slice(0, index)`), the
planner's `researchLog` up to the same point, and the current task list, taken
through the same `forkPlanState` as a **Fork**. The original session, its
file, its transcript and its live planner context are untouched, so nothing
said is lost and the user can go back. `index` is the message's position in
`conversationHistory`, and `rewindTargets()` lists the candidates with a
one-line preview — every user message except the opening goal, since a
conversation without its goal is a new session (after a **Compaction**, the
summary entry stands where the goal did). The task list rides along as it is
now, including tasks created after that message: a rewind moves where the
conversation resumes, not what the plan is (ADR-0002, updates of 2026-09-25).
The rewound message's full text comes back with the fork (`rewoundMessage`) so
a surface can offer it for resending or editing. The fork has no native
planner session, so its first message replays the shortened transcript on
every backend alike. The daemon adopts it at once (see **Adopt**) and answers
`{ sessionId, goal, plan, rewoundMessage }`. Refused while a planner turn is in
flight (`ConversationBusyError`, 409), because the copy would hold a message
without its reply; allowed while the original executes, since the fork carries
no run. TUI and VS Code `/rewind` (picker) or `/rewind <n>` (VS Code also
"Ordewell: Rewind Conversation") switch to the fork; CLI `ordewell rewind [n]`
makes it the current session and prints the rewound message.
*Avoid:* "undo" — nothing about the plan is undone, and the original is kept.

**Fork** (`Session.forkConversation()`) — copy the conversation and its task
list into a new persisted session and continue there; the original, its file
and its live planner context are untouched, so either side can be forked
again. The fork carries no run: tasks caught in progress or at a checkpoint
become pending, finished ones keep their status, and queued mid-run edits and
any other per-run record stay behind. What travels is decided in one place,
`forkPlanState`, which lists fields rather than spreading the plan, so a field
added to the plan later stays behind until someone decides it should travel.
The daemon adopts the fork immediately (see **Adopt**); its first message
replays the copied transcript. A **Rewind** is a fork made from an earlier
point in the conversation. Refused mid-turn like a rewind; allowed while the
original executes. TUI `/fork` switches to the fork; `ordewell fork` makes
it the current session; VS Code `/fork` ("Ordewell: Fork Conversation") loads
it like a saved session, which replaces the extension's one in-process
`Session` — so it asks first when a run is executing, since loading stops it.
*Avoid:* "branch" — that word belongs to git and to worktree isolation.

**PRD (prdMarkdown)** — a planner reply that wraps the full markdown in an
`ORDEWELL_PRD_START/END` block (with a slug). Core saves it to
`.scratch/<slug>/PRD.md` (the Matt Pocock to-prd convention) and keeps
`prdMarkdown` on the plan. No built-in skill or prompt asks for the block; the
`to-spec` skill writes its spec straight to `.ordewell/spec.md` instead.
*Avoid:* "PrdArtifact", "PRD status machine" — deleted; the PRD is a message
plus a saved file, not a typed state.

**Skill** — a folder with a `SKILL.md` (the Agent Skills format) read by one
loader (`SkillsService`), and the only thing Ordewell calls a skill (ADR-0024).
The folder name is the skill's identity (`/name`, the names in a plan,
`ordewell skills`); frontmatter carries `name` (which should match the folder),
`description`, `applies-to: planner | task` (default `planner`) and Claude
Code's `disable-model-invocation` and `user-invocable` (unmarked = both). It lives in one of two scopes: **global**
`~/.ordewell/skills/` (built-in seeds plus the user's own; tasks never write
it) or **workspace** `.ordewell/skills/` (committed, so it reaches worktrees
through git). On a name clash global wins and the workspace copy is reported
as shadowed. Every built-in is user-only. Ordewell never ships, reads, or
references runner-native skill mechanisms (`.claude/skills`, OpenCode plugins,
etc.) to deliver a skill. Research subagents (`spawn_research_agent`, ADR-0005)
are always-on for the planner, not a skill.
*Avoid:* "mode toggle", "skill toggle" — a skill is chosen per message or per
task, never switched on in settings; "skill file", "slash command" for these —
those are runner-side concepts.

**Planner skill** — a skill with `applies-to: planner`: instructions for the
planning conversation. The user loads it with `/name`; the message text stays
as typed and the planner is sent the body beside it. A model-invocable one can
also be loaded by the planner through the `load_skill` MCP tool, which is
tool-only: the catalog appears in the prompt only when tools are attached.
*Avoid:* "mode", "persona".

**Task skill** — a skill with `applies-to: task`: instructions for a runner
working one task. It reaches a runner only by being named in the task's
`skills` in the plan; Ordewell injects its body into the task prompt at spawn,
for any runner, and snapshots it on the attempt. Unresolved names are a warning
at submit and a failed start before the runner is spawned. A task's skills are
listed in the planner's `<current_plan>` block and returned by `task_query`.
`/name` on a task skill is a directive to the planner to attach it, not a
load. The built-in `tdd` is one; TDD applies to a task only when the skill is
attached.
*Avoid:* "task toggle", "augmentation" for the skill itself.

**Skill-load entry** (`SkillLoad`) — the transcript entry recording that a skill
was loaded into the planner conversation: invoker (`user` or `planner`), name,
scope, path, and a snapshot of the body as loaded, so a resume, fork or rewind
replays what the live conversation was given. Surfaces show it as a one-line
notice with the path. For a task skill named by `/name` it carries no body, only
the directive to attach.
*Avoid:* "skill message", "skill event".

**Executor / Runner** — an external coding-agent CLI (Claude Code, Codex,
OpenCode) that runs *one task* in its own session through a structured
connector. `RunnerRegistry` holds their built-in manifests: identity, command,
model discovery and mode settings. External plugin manifests are ignored with
one notice at host startup.
*Avoid:* "backend", "provider" (provider means the LLM vendor, below).

**Runner connector** (`RunnerConnector`, in the `CONNECTORS` registry) — what
Ordewell holds for a runner it drives over the runner's own protocol: the
adapter that serves it as a harness planner (ADR-0009) and as a structured
task's runner (ADR-0018), and its *Ordewell tool binding*. The registry is
keyed by runner id; a runner without a connector cannot run. Adding a runner
to it is the one place a runner's planner, task connector and Ordewell tools are
declared, so none of the three can drift apart.
*Avoid:* conflating it with `RunnerRegistry`, which holds *manifests* (identity
and mode/discovery settings for the built-in runners); "adapter table".

**Runner process** (`RunnerProcess`, `harness/runnerProcess.ts`) — the one OS
process a connector's adapter drives, whatever its protocol: launched under the
cleaned runner environment in its own process group, its output decoded as
UTF-8, its stderr tail kept for the failure message, its end observable, and
its whole tree killed on dispose (**Kill tree**). Its `start` runs the
adapter's handshake and takes the process down if that throws. The stdio
adapters and OpenCode's server both build on it, so a lifecycle fix lands once;
the protocol stays in the adapter.
*Avoid:* spawning or killing a runner in an adapter directly.

**Ordewell tool binding** (`OrdewellToolBinding`) — how one connector hands its
runner the Ordewell MCP server (ADR-0022). It covers the runner's names for the
server's tools (`toolName`/`toolNames`), which of the runner's permission
requests are for them and so are never refused or left waiting
(`isOrdewellAsk`), what the runner's own status word for the server means
(`attachState`), and the runner-specific injection that writes the server into
its launch or configuration. Every supported connector has one. Task runners
and coding-agent planners must connect their tools before receiving a prompt;
a failed attach is respawned once, then fails (ADR-0025).
*Avoid:* "MCP adapter", "tool prefix" (a prefix is how two of the runners happen
to name a tool, not the concept).

**Attach state** (`AttachState`: `connected | pending | failed`) — a runner's
report on the Ordewell server's connection, in one vocabulary for every runner.
`pending` is the only state worth waiting through; `awaitAttach` polls until the
runner says `connected` or `failed` or the deadline passes, and a runner that
never attaches is respawned once before the task or planner turn fails.
*Avoid:* "healthy", "ready" (this is a report by the runner, not a probe of ours).

**OpenCode server API** (`openCodeTransport`) — the HTTP protocol work OpenCode's
two server APIs share: 1.x (`/event`, `OpenCodeAdapter`) and 2.x (`/api/event`,
`OpenCodeV2`). The event names and shapes differ, so each version reads its own
frames; how a turn is streamed, how a permission request is answered, how a
child session is tied to the call that spawned it (held until named, then
replayed tagged with that subagent) and how a turn is settled are one
implementation, so a behaviour fixed for one version is fixed for both.
*Avoid:* "transport" alone for this — **Transport** is the runner session
contract, and OpenCode's HTTP protocol is one implementation of it.

**Transport** — how Ordewell drives a task's runner: its programmatic
protocol, with structured events in and messages out. Every `IRunnerSession`
has this contract; runners without a task connector cannot run tasks. There
is no transport setting, discriminator or terminal fallback. Every coding-agent
session requires Ordewell MCP attachment, checked after spawn with one respawn
before failure (ADR-0025).
*Avoid:* "mode" (that is permission mode, ADR-0001), "backend", "provider".

**Waiting for input** — a structured task whose turn ended without a `task_complete`
call: `awaiting_user` with a saved reason, `input | checkpoint | conflict |
files-changed` (a checkpoint wins over input; `files-changed` is an *ops task*
that changed tracked files, ADR-0020). No verdict and no automatic nudge; the user
answers or marks the task complete. A pending runner approval is *not* waiting
for input — it arrives mid-turn, leaves the status alone, and "waiting for
approval" is derived from the task's pending approvals.
*Avoid:* "idle" (a silence guess, and its timer still runs during a turn),
"paused", "blocked" (a dependency term).

**Continue** — a retry of a completed or failed structured task that resumes
its saved runner session (Claude's `--resume`, Codex's `thread/resume`) with
the user's message as the next turn.
It is verified and landed like any attempt, is not offered on conflicts, and
leaves dependents alone, as retry does. `continuability` is the one rule, and
a status carries only whether it holds (`continuable`), never the session id.
The first turn is the message plus a short reminder of the done and checkpoint
protocol — the required `task_complete`/`checkpoint` tools
(`composeContinuationPrompt`) — not the original prompt.
A session the runner
cannot find fails the attempt with a message that suggests Retry; a fresh
session is never started in its place.
*Avoid:* "resume" for the user action (that is the protocol flag), and "retry"
for it — a retry starts a fresh attempt with no message.

**Task log** (`TaskLogEvent`, `reduceTaskLog`, `TaskLogRecorder`) — what a
structured task did, at full fidelity (ADR-0018, O1b/P1): normalized events —
text and thinking, tool calls with their results (long ones trimmed to head
and tail), subagents, usage, turns, the message queue and runner approvals
(requested, decided, withdrawn) — streamed live as
`task_log` and appended to `.ordewell/sessions/<session>/tasks/<task>/<attempt>.jsonl`,
one file per attempt, numbered from what is on disk. `reduceTaskLog` folds the
same events into display blocks live and on reload, so the two draw alike. The
file goes with its session. Every task attempt uses this log.
*Avoid:* "transcript" (the planner conversation's saved record), "output"
(the lossy plain-text channel `VerdictEngine` reads — nothing that needs
fidelity reads it), and reading a verdict from the log.

**Runner approval** (`runner_tool`, `RunnerApprovals`) — a structured task's
runner asking to use a tool its mode does not cover (ADR-0018, A1). It rides
the planner's approval seam (`PendingApprovals`, `resolveApproval`) carrying
the task id, with no timeout, and shows as a card in the task log — never in
the planner conversation. The answers are *Allow*, *Allow for this task* (the
runner's own session-scoped grant, offered only when it proposed one) and
*Deny* with an optional note the agent reads; `resolveApproval` takes the
whole decision from any answerer, a person or later the supervisor (#28). The
task stays `in_progress`: "waiting for approval" is derived from its pending
requests. Cancel, stop and retry deny them before the runner goes; one the
runner cancels itself, or whose process ends, is *withdrawn*. OpenCode's `build` mode (`--auto` on 2.x)
answers its own requests: they are logged as requested and decided, never
carded.
*Avoid:* "permission prompt" for Ordewell's side (that is Claude's protocol),
and "awaiting approval" as a task status.

**Task message** (`sendMessage`, `QueuedTaskMessage`) — a message sent to a
structured task while its attempt lives (ADR-0018 M1, ADR-0023). Ordewell owns
the queue, and a message is in exactly one state: *queued* — waiting in
Ordewell's queue for the running turn to end, removable; *handed over* — the
runner accepted it into the running turn and owes a delivery, no longer
removable, since no runner can recall one; *delivered* — the runner reported
that the model has it, mid-turn (`message_delivered`) or as the message that
opened a turn (`turn_start`); or *undelivered*. Sent with no turn running, it
opens a turn at once. The queue lists queued and handed-over messages until
delivery; a message handed over and then let go of by the runner is queued
again. Completion evidence that arrives while one is undelivered is held, and
a message the runner reads voids it.
*Avoid:* "queued prompt" (the planner conversation's hold) and "pending plan
edit" (a run's plan-edit queue); "sent" or "delivered" for a handed-over
message — the write or POST succeeding is not delivery.

**Mid-turn delivery** — a task message reaching the model at the runner's next
step boundary, after the tool call in flight and inside the same turn
(ADR-0023): Claude Code by a `user` line on stdin, read when echoed; Codex by
`turn/steer`; OpenCode 1.x by `prompt_async` while busy. It is a per-adapter
optional adapter capability (`steer`); without it — OpenCode 2.x — messages
wait for the turn to end, the *turn-end queue*. Offered
one message at a time, in the order sent; a refusal leaves the rest for the
turn's end.
*Avoid:* "interrupt" (nothing in flight is stopped — that is *force send*),
"injection" (the rejected hook route), and "steer" outside the adapter seam
and Codex's protocol (it names the call, not the delivery).

**Force send** (`forceSend`, `forceSendQueued`; "Send now" on the surfaces) — interrupt
the running turn, stopping the tool call in flight, and deliver a message as
the turn that replaces it, ahead of everything still queued (ADR-0023,
F1–F4). The task stays `in_progress` through the switch. With no turn running
it is a plain send; a handed-over message cannot be force sent. On Codex the interrupt stops the agent waiting,
not the command, which runs to its end. TUI `ctrl-s`, VS Code *Send now* /
`Ctrl+Enter`.
*Avoid:* "force-start" (starting a task past its dependencies), "priority" or
"urgent" message, and "interrupt" for the whole action — a plain interrupt
ends in waiting for input, a force send does not.

**Undelivered message** (`message_undelivered`) — a task message that can no
longer reach the runner: its process exited, its turn failed, or it was sent
to a session already ended. Every surface reports it with its text; a message
is never removed from the queue without being delivered, taken back, or
reported undelivered.
*Avoid:* "dropped" — that is an adapter reporting that a handed-over message
went unread at the turn's end (`message_dropped`), which puts it back in the
queue, not out of it; and "lost".

**Checkpoint** (task) — a task asking a person to approve its work before it
goes on: the `checkpoint` tool call. The task is `awaiting_user` with reason
`checkpoint`, and its status carries the whole question (`checkpoint`).
Answered with approve — which carries no note — or reject with a reason: the
TUI task view's *checkpoint card* (`ctrl-y` / `ctrl-g`, composer text as the
reason), `/checkpoint <id> approve|reject [reason]`, `ordewell checkpoint`,
or the VS Code card. A runner approval waiting in the same task is answered
first. The turn that asked it ending — an interrupt, a force send — withdraws
it, and the task goes back to in progress.
*Avoid:* "runner approval" (a tool request mid-turn, not a question about the
work), "pause", and "merge gate" (a scheduling wait).

**Ordewell MCP server** — the one MCP server Ordewell runs (ADR-0022):
Streamable HTTP on `127.0.0.1` at a random port, started on first
use by the process that owns the session (the daemon or the VS Code extension
host) and shared by every session in it. Its configuration is injected into a
runner when Ordewell spawns it — structured task runners and the three harness
planners only — with its tools pre-authorized so no call ever prompts. Who sees
which tools is decided by the caller's *task token* or *planner token*, never
by running separate servers. Attachment is checked after spawn, with one
respawn before failure. API planners use JSON envelopes instead of this server.
*Avoid:* "the task server" / "the planner server" (there is one server; the
token decides the role), "MCP bridge", "plugin".

**Task token** — the credential that binds one structured task attempt to the
*Ordewell MCP server*: one session, one task, one attempt generation (the
generations `VerdictEngine` tracks). It lists only `task_complete` and
`checkpoint`, is revoked when the attempt ends, and a call carrying it after
that is refused. It reaches the runner only in the injected MCP configuration,
as an HTTP header — never in a prompt and never on a command line.
*Avoid:* "session token" (*Session* is the plan's lifecycle module, and the
token is narrower than a session), "attempt id", "API key".

**Planner token** — the credential that binds one session's harness planner
conversation to the *Ordewell MCP server*. It lists only the planner tools:
`list_runners`, `list_models`, `task_query`, `task_output` and `load_skill`,
which read Ordewell state and the planner skill catalog; `run_command`, the
planner's research shell, inside the planner's envelope (ADR-0026); and
`submit_plan` and `edit_plan`, the only writes, which
go through the same validation and commit path as the plan and `taskOps`
envelopes. Revoked when the planner process is disposed.
*Avoid:* "session token", "admin token", and describing the planner as
write-capable — it writes nothing but the plan, and only through validation.

**Planner allowlist** — the planner's standing approvals (ADR-0026): command
rules (`gh issue list`, `gcloud * * list`), MCP tool rules (`mcp:find-*`) and
scope patterns, with `!` exclusions that always win. What it covers runs
without asking anyone, in every *approval mode*; file writes are refused
whatever it says. The built-in list holds read-only families only.
*Avoid:* "whitelist", "pre-approved scopes" for the rules (a rule names an
operation by its words, a scope is what one approval remembers).

**Approval mode** — what happens to a planner request the *planner allowlist*
does not cover: `ask` the user, refuse it (`allowlist`), or run it (`allow`).
The default, `auto`, follows the autonomy level: Guarded asks, Full refuses
and the plan carries the change as an *ops task*.
*Avoid:* conflating it with a task's mode or the autonomy level itself.

**Completion call** — a `task_complete({status, summary, reason?})` call made
with a task's *task token*: the only runner completion evidence. It is handed
to `VerdictEngine`, which alone produces the verdict after checking the current
generation. Evidence held behind an undelivered message is superseded when
that message is read. Only `done` passes; `blocked` and `failed` carry their
reason. The
`summary` is the output handed to dependent tasks.
*Avoid:* "self-report" or "the model says it's done" (it is the runner's
explicit signal bound to the attempt, not a judgement anyone weighs), and
"tool verdict" (the tool produces no verdict).

**Spawn toolkit** — the shared process policy behind the runner adapters:
`planDirectLaunch` (`utils/launch.ts`), runner environment cleanup
(`services/harness/runnerEnv.ts`), and process-group launch and disposal
(`utils/processTree.ts`). `StructuredRunner` drives the connectors through
these seams; `PoolAwareRunner` (web) wraps it behind the full `IRunner`
interface, including per-session `stop`. `utils/shell.ts` retains the shared
ANSI stripping helper (`stripAnsi`). Tests hit the pure functions and injected
process seams.
*Avoid:* re-declaring launch, environment or process helpers inside an adapter.

**Runner interface** (`IRunner`, `interfaces/IRunner.ts`) — spawns one
`IRunnerSession` per task attempt and owns stopping sessions and counting
active ones. Every session supplies its turn state, structured events, message
queue, interrupt, approvals, native session id and task tools alongside plain
output and exit notifications. `AbstractRunner` and `AbstractRunnerSession`
share lifecycle plumbing; `FakeRunnerSession` is the test seam. Structured
methods are mandatory, with no optional capability or transport discriminator.
*Avoid:* "terminal runner", "terminal session" for these interfaces.

**Task attempt** (`TaskAttempt`, inside TaskOrchestrator) — one run of one
task, from the moment the scheduler claims it to the moment it ends. It holds
everything that has to die with the run: the attempt number, the phase
(`starting` while the async spawn is in flight, `running` once the runner is
up, `integrating` while *Landing* settles its verdict), the live
`IRunnerSession`, and the runner, working directory and start
time — plus its *attempt kind* and,
in an isolated run, whether that directory is its worktree and the landing in
flight. The orchestrator keeps one
`Map<taskId, TaskAttempt>`, and every way a run ends — verdict, cancel, release,
mark complete, retry, a failed spawn, stop, plan load — goes through the one
`endAttempt`, which also clears the verifier state an interrupted run leaves
behind. Ending an attempt is also what invalidates a spawn still in flight: the
late session is compared by identity against the task's *current* attempt, so
it is killed rather than resurrecting a stopped task or displacing a newer run,
and it takes back only its own claim — a task marked complete meanwhile stays
complete. A verdict obeys the same identity rule: the attempt stays live while
its summary is read, and the verdict lands only if that attempt is still the
task's current one, so a cancel, retry, mark complete, stop or plan load in that
window is never overwritten by a stale verdict. A verdict whose settling throws
fails its attempt and says why; nothing it raises goes unhandled. The scheduler
judges each task again right before claiming it — every readiness gate and a
free slot — because a start it awaited, a user control or a concurrent tick may
have changed either, so it never starts held, finished or newly blocked work,
nor more than `maxParallelSessions` at once.
The working directory is decided in one place (`attemptKind.attemptCwd`): the
workspace root for an attempt that acts from the checkout, else what the
`IsolationRunController` gives it — the workspace root when the run does not
isolate, or in an isolated run the worktree `WorktreeIsolation.prepare` made for
the attempt. A passed verdict keeps the attempt live through its merge,
so the task completes — and frees its dependents — only once its work is on the
integration branch. Holds, retry counts and spawn counts are
deliberately *not* on the record — they describe the task across attempts and
must survive one ending. Surfaces read an attempt through `getAttempt`;
`activeSessionMap` is derived from it. Runner session ids
are unique per spawn for the same reason: a retry reuses its task id, and a
registry keyed by task let the old attempt's exit unregister the new one.
*Avoid:* "session" for this concept — the session is the runner's process, one
field of the attempt. Do not add another per-task map to the orchestrator for
state that ends with the run; put it on the attempt.

**Attempt kind** (`AttemptKind`, `attemptKind.ts`) — what one attempt of a task
is: `change`, `ops`, `repair` (a *conflict repair*, ADR-0015) or `continuation`
(a *Continue*, ADR-0018, which carries whether its task is ops). Everything that
differs between attempts is read from it, never from loose flags: where the
attempt runs (`attemptCwd`), the prompt (`attemptPrompt`), whether the run
decides to isolate when it starts (`decidesIsolation` — not for work in the checkout),
whether the workspace's tracked files are compared across it (`checksTree` —
ops work in the checkout, which can be caught writing but not stopped), and
whether it keeps *Merge all* out (`mergeExcludes`, the one rule both the
attempt's start and the merge's start read). A repair outranks the ops mark, as
its work already sits in a kept worktree. A task's own `ops` mark has one
reading, `opsFlag` (only a literal `true`, only on an AI task), and a merge or
split derives its result's mark with `inheritedOps`.
*Avoid:* "mode" (permission mode, ADR-0001), "type" (`ai | user` on a task),
"phase" (an attempt's `starting | running | integrating` progress).

**Isolated execution** — running each *change task* in its own *worktree*
instead of the shared workspace root, then integrating the results
deterministically (ADR-0013, amended by ADR-0014 and ADR-0020). Available when the workspace forms a *repo
group* — a git repository, or a folder of them — with a clean tracked tree in
each repository and `worktreeIsolation` on; otherwise every task runs in the
workspace root exactly as before, and `WorktreeIsolation.isActive` says which of
`disabled`, `git-missing`, `not-git`, `no-commits` or `dirty`
applied (the last two may name the repositories behind them). `not-git` is
left for a folder with no repository in it. A group's task integrates by an
atomic *landing*. An *ops task* runs at the workspace root instead, and a run
decides whether it isolates when its first change task starts, so a run of only
ops tasks never asks. The
Runner is only ever handed a `cwd` (ADR-0007) — git never enters
`IRunner`, `RunnerRegistry` or a runner adapter.
*Avoid:* "sandbox" (an OS-level runner sandbox is a separate concern, ADR-0011),
"clone" (a worktree shares the repository's object store).

**WorktreeIsolation** — the deep module owning every git and filesystem
operation isolated execution needs: worktree creation, the artifact bootstrap,
committing a task's work, the serialized integration merge, conflict detection,
release, orphan pruning, and the end-of-run handoff (diff, merge, discard).
`GitWorktreeIsolation` is the implementation; the orchestrator's tests use
`FakeWorktreeIsolation` from `@ordewell/core/testing`, and git behavior is
tested only against real temporary repositories. Under ADR-0014 it owns them for
every repository of the repo group.

**Worktree** — a linked git checkout on its own branch, created for one task at
`.ordewell/worktrees/<run-id>/<order>-<slug>` on branch
`ordewell/<run-id>/<order>-<slug>`. It is where that task's Runner executes.
Created when the task starts, removed when it integrates cleanly. A failed or
conflicted task's worktree is kept so its work can be inspected; a retry
discards it and starts a fresh one from the current integration tip. Ignored
artifacts (`node_modules`, `.env*`, `.claude`, …) are linked in from the main
worktree so it is runnable at once — never `.ordewell/`, which stays at the main
root. `node_modules` (the root's and each workspace package's) is a real
directory whose entries are linked one by one, and whose own links are
recreated, so a workspace package resolves to the worktree's code rather than
the main checkout's (ADR-0013). Under ADR-0014 a task has one worktree per repo of the group, gathered in
its *task workspace*; each is bootstrapped from its own repo, with the
`worktreeLinks` matches linked beside the defaults, and `worktreeSetupCommand`
runs once per repo with `ORDEWELL_REPO` and `ORDEWELL_MAIN_REPO` set.
*Avoid:* "workspace" for a worktree — the workspace is the user's checkout.

**Repo group** — the git repositories isolated together for one workspace
(ADR-0014). A folder that is not itself a repository forms one from the
repositories directly inside it, or, when `workspaceRepos` is set, from exactly
the repositories it lists, at any depth; a workspace
that is one repository is a group of one, with the repo at path `.`, so there is
one code path. A repository that contains repositories nested inside it that
are not submodules is still a group of one: the nested repositories cannot be
isolated with it, so they are shared live and named, never silently dropped
(ADR-0019). Repo names and roles are arbitrary and nothing may depend on them;
a group is a set of paths.
*Avoid:* "monorepo" (one repository holding many projects — a group is many
repositories), "multi-root workspace" (a VS Code notion, a later slice), "project"
or "package" for a repo.

**Shared path** — a loose file or folder in the workspace root that is in no repo
of the group, or a repo that cannot be isolated (no commits, or git refuses a
worktree), linked live into every task workspace (ADR-0014). For a repository
that is the workspace, the repositories nested inside it that are not submodules
are shared paths too, linked live at their real relative paths (ADR-0019); one
that the workspace's own repository ignores is shared like any other, so a nested
repository never vanishes from a task without a word. Edits to a shared path are
live and not reviewable, so the planner prompt lists them and does not run
parallel tasks that edit one. `.ordewell/` is never one. Symlinks on POSIX;
junctions for directories and hard links for files on Windows, with a copy and a
notice where a hard link is impossible. A directory that holds a deeper repo of
the group is recreated in the task workspace rather than linked, and its other
entries are shared one by one. A link that leads nowhere (an editor's lock file)
is not shared: there is nothing to share, and linking it would fail every task.
Every link points at the same path in the real workspace, never where a user's
own link leads, so a task workspace reaches nothing the workspace does not and
the planner's envelope (ADR-0008) is unchanged. Recorded in the run as `shared`,
with the repos among them in `sharedRepos`.
*Avoid:* "ignored file" — a shared path need not be ignored; "linked artifact"
for the per-repo bootstrap links (`node_modules`, `.env*`), which are recorded
and kept out of the task's commit.

**Task workspace** — `.ordewell/worktrees/<run-id>/<order>-<slug>/`, the
directory a task's Runner starts in under ADR-0014: one worktree per isolated
repo at the same relative path as in the real workspace, plus the shared paths
linked in, so the agent sees the real layout. Every worktree in it is on the same
branch name, `ordewell/<run-id>/<order>-<slug>`. For a group of one it is the
worktree.
*Avoid:* "workspace" bare — that is the user's real folder; "sandbox".

**Integration branch** — `ordewell/<run-id>/integration`, the one branch a run's
work lands on (in each repo of the group, under ADR-0014, where landing a task is
atomic across the repos it changed). Each task that passes its Verdict is merged into it with
`git merge --no-ff`, one at a time, lowest plan order first among the tasks
waiting, so the history is reproducible and each task is attributable to a merge
commit. A merge conflict is aborted and reported; before it reaches the user it
gets a bounded, evidenced *conflict repair* (ADR-0015), and only an unrepaired
or exhausted conflict is left for a person to resolve by hand, or as
`resolveConflictAsTask`. In a group, a conflict undoes the task's whole
*landing*. It is never merged into the checked-out branch until the
user asks. It outlives its run's worktrees (clean-up keeps it) and is deleted
only when given up (discard), or once it is merged into the checked-out branch:
right after a *Merge all* that merged everything, or at a later run's start,
which sweeps each repo for other runs' `ordewell/<run-id>/…` branches that HEAD
contains (`git merge-base --is-ancestor`), leaving any run that still has a
worktree. The decision is per repo: in a group, one repo's may go while
another's stays. One that holds work the user has not merged is never deleted
unasked.
*Avoid:* "result branch", "staging branch".

**Landing** — integrating one task under ADR-0014: its branch merged into the
integration branch of every repo it changed, or of none. Only repos where the
task branch has commits ahead of the integration tip are merged; a task that
changed nothing merges nothing and lands. Before the first merge each changed
repo's tip is recorded on the run as `landing` and the run is saved, so a
conflict or failure in any repo — or a crash, finished by `pruneOrphans` —
resets the merges already made back to those tips. The reset only ever touches
an Ordewell-owned integration branch, and only where what sits on the tip is
that one merge; a tip that has moved otherwise is left alone and the landing
stays recorded, which blocks further landings and *Merge all* (`partial-landing`)
rather than building on part of a task. `merged` always means the whole task
landed, and a dependent starts only then. `conflictRepo` names the repo that
stopped it. A landing that does not go through never fails the task and never
halts the run: a conflict gets a *conflict repair* or waits on the user, and
one git refuses (`failed`) leaves the task `awaiting_user` with its verdict,
worktree and branch kept (ADR-0013).
The `Landing` module (`services/Landing.ts`) owns it, and conflict repair,
between the scheduler and the *isolation run controller*: given a passed
attempt it lands through the controller and answers `landed`,
`nothing-to-land`, `repair-needed` or `awaiting_user` (`conflict`,
`landing-failed`, `repair-failed`) with the words the user is told. It never
marks a task, starts an attempt or emits — TaskOrchestrator applies the answer.
It also builds the task `resolveConflictAsTask` adds (`conflictResolverTask`).
*Avoid:* "merge" for the whole of it — a landing is one merge per changed repo;
"rollback" for anything done to a user's branch — Ordewell never resets one.

**Conflict repair** — a bounded, automatic response to a conflicted landing
(ADR-0015): a new attempt of the same task, in its kept worktree, on its own
runner, model and mode (ADR-0001 — a repair is not a new task, so nothing
about it is rewritten). Its prompt is to `git merge` the current integration
tip into the task's branch, resolve the named files so both sides' intent
survives, build, test, commit, and report the task done (the `task_complete`
tool bound to the attempt's token). It counts as having
repaired the conflict only once all of: the done signal arrives;
the task branch now contains the tip the repair started from
(`git merge-base --is-ancestor`); `git diff --check` finds no leftover
conflict markers; and the landing that follows goes through clean — a repair
that fails that last check is a fresh conflict, not a claim taken at its word.
Capped per task by `conflictRepairAttempts` (default 2, persisted on the run
so a restart cannot re-spend it; 0 turns repair off). While one runs the task
is `in_progress` and its record `repairing`; each repair is counted when it
starts, and the files every repair was started for gather in `repairedFiles`. A repair that fails
evidence or exhausts its cap goes back to an unrepaired conflict — `awaiting_user`,
worktree and refs kept, every existing way out still open — and never halts
the run on its own. Every repair is logged as a notice, and a landed one is
named, with its files, in the *Isolation handoff*.
*Avoid:* "auto-merge" (there is still a real merge conflict to resolve, not a
fast-forward); "resolver" (that names `resolveConflictAsTask`, the explicit
`x` action a person asks for — a repair runs before anyone is asked); "auto-resolve" (implies the model's word stands in for the Verdict, which it never does).

**Merge all** — the handoff's one merge, `mergeRun`: every repo's integration
branch into what the user has checked out there, all or nothing. Each repo with
work (commits ahead of its base ref) is preflighted without touching its tree —
no merge of the user's in progress, `git merge-tree --write-tree` against HEAD
shows no conflict, no uncommitted tracked edit to a file the integration branch
changes — and if any fails, nothing is merged and the answer is `blocked`, with
each repo, its reason and its files. A merge that still fails part-way is
aborted where it failed, and the answer names the repos that landed before it,
which stay merged. On git older than 2.38 there is no preflight: repo by repo,
stopping at the first failure. A group of one needs none either, since its one
merge lands or is aborted whole, so it answers `merged`, `conflict` or `failed`
as it always has. `merged` on a settled run clears it up like a discard, except
that each integration branch goes only where HEAD contains it, and the plan
forgets it; any other answer deletes nothing. During a run, Merge all is what
opens a *merge gate*: it merges what has landed so far and the run goes on, its
branches kept for the tasks still to land (ADR-0020). It never runs while an
*ops task* does (`mergeExcludes`, read by both sides), and takes turns with
landings.
*Avoid:* per-repo merge — there is none, by design (ADR-0014).

**Change task** — a task whose result is a change to repository files: it runs
in a worktree and lands on the integration branch. Every task is one unless it
is marked `ops` (ADR-0020).
*Avoid:* "code task" — docs and config edits are changes too.

**Ops task** — an AI task marked `ops: true` (ADR-0020): it changes no repository files, acting instead on systems outside the repo (a
cloud CLI, a deployment, a pipeline) or on the git refs and history of the
user's branch (push, tag, reword). It runs at the workspace root, never in a
worktree, in the session's mode, and in parallel as its dependencies allow;
never while a Merge all runs (the flag is read through `opsFlag`). If it leaves a new tracked change in any repo of
the group, it waits on the user (`awaitingReason: 'files-changed'`) rather than
completing. A retry is told what the attempt before it did, since its effects
are never rolled back. The planner sets the mark and splits a mixed request into
a change task and an ops task; the user can flip it until the task starts. A
subtask runs with its top-level task.
*Avoid:* "operation" as the term (used loosely everywhere), "external effects
task", "checkout task" — it runs at the workspace root, which in a group is not
one checkout.

**Merge gate** — where an ops task or a user task that depends on change tasks
waits until their work is merged into the user's branch (ADR-0020): until the
checked-out HEAD contains the integration tip each of them landed at. The
user's Merge all opens it, as does a merge made by hand; Force start passes it
after a confirmation naming what is not merged, and the task keeps that choice
(`forcedPastGate`). A run with nothing else to do is *paused* at its gates.
There is no gate without isolation.
*Avoid:* "checkpoint" — that is a task asking the user to approve its work.

**Base ref** — the commit the user's checked-out branch pointed at when a run
minted its record, resolved once at that moment. The integration branch forks from it and
the review diff is taken against it, so switching or advancing the user's branch
mid-run does not retarget the run.

**Isolation run** — one Execute-Plan click or one manual task run's worth of
isolation: the `IsolationRun` record holding the run id, the repo group (`repos`:
each repo's path, root, base ref and integration branch; a single repository is
one repo at `.`), the shared paths, each task's branch, task workspace,
per-repo worktree and status, and the *landing* in flight, if any. It is plain JSON so it
can persist with the plan state, and a new run mints a new record. Task ids are
only unique within one plan, so every operation that acts on a task takes the run
it belongs to.
It persists as `LegacyPlanState.isolation` (`{ run, resolvers }`), written from
the orchestrator at persist time and saved whenever it changes; adopting a saved
plan prunes the run's orphans. A plan's record is *continued* rather than
replaced while anything has landed on it — a resumed plan's dependents need
their predecessors' work, which a fresh branch from the checked-out commit does
not have — and a record with nothing landed is discarded whole when the next run
mints its own. One with landed work that cannot be continued (it ran from another
workspace path) loses its worktrees, and its integration branch in each repo
whose HEAD already contains it; it keeps the others. A run closes
when its last attempt ends, however it ends — verdict, cancel, Mark complete or a
failed spawn — so the next one decides its own mode. The field belongs to one
plan: a fork must not copy it.
A record saved in the ADR-0013 shape (the refs on the run itself, one `worktree`
per task) is converted to a group of one when plan state is loaded, so a session
saved by 0.4.23 resumes and hands off as it would have.
The record and the open run's lifecycle are owned by the *isolation run
controller*.

**Isolation run controller** (`IsolationRunController`) — the module between
TaskOrchestrator and `WorktreeIsolation` that owns an *isolation run*'s
lifecycle: deciding at a run's start whether it isolates, shares the workspace
root or is a *blocked run*; continuing a plan's run or minting a new one; the
working directory of each attempt that is not already in the checkout (the
*attempt kind* decides which); a task's integration and a repair's evidence
check, with the record reported changed before the first merge; releasing a
worktree once any landing in flight settles; closing the run with its
*isolation handoff*; and Merge all, clean-up and discard afterwards. It holds the run record, the open run's mode, the
parked start of a blocked run and the resolver links, and reports through a
listener (changed, blocked, handoff, notice, worktrees about to go) — it never
emits orchestrator events or schedules work itself. A blocked start is handed
back to the caller to replay. An activation a Stop interrupts opens nothing: one
interrupted while git mints its run never installs that run over a newer
activation's, and discards it. The scheduler reads isolation state only through
it (`openRecord`, `isolating`, `current`). Session and the event relay reach its
Merge all, review, clean-up and discard directly — there is no pass-through on
the orchestrator — and its `requireRun` is the one guard for "no isolated run
to act on", throwing `PlanEditError`. Git stays in `WorktreeIsolation`.
*Avoid:* "isolation run" for the controller — that is the record it holds;
"WorktreeIsolation" for it — that is the git layer beneath it.

**Isolation handoff** — the end of an isolated run: for each repo, its integration
branch and base ref, and the tasks that landed, broadcast as `isolation_handoff`. What
follows is the user's: `reviewRunDiff`, `mergeRun` (a normal `git merge` into the
checked-out branch, only ever on that explicit call; once everything merged, the
run is cleared up and forgotten, so no surface offers its handoff again), `cleanupRun` (worktrees and
task branches go, the integration branch stays) and `discardRun` (everything
goes, and the plan forgets the run; task statuses are left as they are). A
conflicted task's first way out is automatic: a *conflict repair* (ADR-0015)
runs on the task's own attempt before anyone is asked, up to
`conflictRepairAttempts`. Only a conflict that repair does not clear leaves by
a hand resolution plus Mark complete, a retry, or `resolveConflictAsTask` — an
added task that merges the branch by hand and through whose landing the
conflicted task lands, if it is still conflicted by then (a retry in the
meantime replaces the conflict with a new attempt).
*Avoid:* "result", "output branch" for the handoff — it is a branch to review,
not an outcome.
Under ADR-0014 the handoff covers every repo of the group: one *Merge all*, and a
review diff with one section per repo that has changes, each headed by the repo's
path and with its paths rooted at the workspace (a repo that is the workspace
reads as before). A resolver task merges the conflicted branch in every repo
the task changed, since the conflict in one rolled back all of them.
In the terminal the same four steps are the handoff overlay (`/handoff`, opened
by `isolation_handoff` on a screen with nothing else open) and
`ordewell handoff [review|merge|discard|cleanup]`. Merge and discard are asked
about first, in both — the CLI takes `--yes` as having asked. A reloaded session
gets its handoff and its per-task marks from the plan's persisted run record, not
from a stream: the terminal reads it off the saved plan, and VS Code asks
`Session.isolationView` whenever its webview reconnects or a session is loaded
(the handoff card waits while a run executes). A conflicted task carries a **conflict mark** in the plan pane;
every other isolation state stays out of the row and appears, with the task's
branch, only in the expanded detail.

**Blocked run** — a run `isolation_blocked` turned away because tracked files are
modified (in any repo of the group, under ADR-0014, which the notice names). The daemon parks the start until it hears `continueWithStash` or
`continueWithoutIsolation`, so the run's execution stream stays open through the block, showing the ops
tasks still running, and the choice's own stream replaces it. Cancelling is `stopExecution`, not a dismissal: a
parked start swallows a re-run. A stash that succeeded is always said, with
how to get the changes back, even when a Stop came while it ran. The TUI asks with a three-way picker (Stash and
continue / Run without isolation / Cancel); `ordewell run` takes `--stash` and
`--without-isolation`, and without either releases the run and says so. The block
is broadcast from inside the call that starts the run, so every surface opens its
execution stream before making that call — one opened after it never hears the
block.

**The plan** — the typed, editable, diffable artifact the planner emits: an ordered
list of tasks with per-task model, thinking effort, runner, and mode. It is data,
not a running agent's internal state.

**Runner set** — the ordered `runners: RunnerId[]` a plan may execute across,
carried on *the plan* and the session. Every task carries an `assignedRunner`
drawn from the set (always present, even for single-runner plans). Size is the
semantics, not a sentinel: size 1 means a single-runner plan, size >1 means a
multi-runner plan. Empty is invalid and rejected before planning.

**PlanEditor** — the module behind Session's direct plan edits: `updateTask`,
`setTaskDependencies`, `setTaskRunner`, `addTask`, `removeTask`, the
conflict-resolver task, and the requests that ask the planner to merge or split
tasks. `Session`'s methods of those names are one-line delegations; the rules (the lock on settled tasks, the runner retarget,
the derived assignment of a hand-added task, the ops mark) live here, reaching
the plan only through the session's `mutate` ritual, so every edit saves and
announces once. A refused edit throws `PlanEditError`, which a surface reads as
"you asked for something invalid" rather than "something broke"; the same error
type is what `IsolationRunController.requireRun` throws for an isolation action
on a plan with no run.
*Avoid:* "plan manager", "task editor" (the *TaskEditValidator* below only
checks); "Session" for the owner of these rules — Session hosts them.

**Runner retarget (`TaskRetarget` + `Session.setTaskRunner`)** — a task's runner
is the one assignment that cannot be edited as a single field. Its model,
thinking effort and mode are all scoped to the runner, so `claude-sonnet-4-5` on
Codex or `acceptEdits` on OpenCode are not degraded choices but unspawnable
ones. `retargetTaskRunner` (pure) preserves each of the three when the new
runner also offers it and otherwise snaps to that runner's preferred entry —
discovery already sorts models by the manifest's `preferredPatterns`, `modes[0]`
is the manifest's own first choice, and the effort goes through
`clampThinkingEffort`. An empty catalog means discovery failed, not that the
runner offers nothing, so that field is left untouched and the runner validates
last (as in `coerceAssignments`). `Session.setTaskRunner` is the one entry
point, and the *PlanEditor* behind it the one owner: async because it needs discovery, guarded before that call because listing
models spawns the runner's own CLI, and it admits the runner into `plan.runners`
— without which the next planner turn's `coerceAssignments` would treat it as
disallowed and silently snap the task back. Both surfaces route through it
(`PUT /api/plans/:s/tasks/:t` dispatches an `assignedRunner` in the body to it
rather than writing the field), so no surface owns a second copy of the clamp.

**Dependency edit (`dependencyCandidates` + `canSetDependencies` +
`Session.setTaskDependencies`)** — a hand-edited dependency list is the one task
edit that can leave a plan unschedulable, so like the runner it is not a field
write. The rule is that dependencies point *backwards in display order*, the same
invariant `applyTaskOps`' post-pass owns (its sole owner — `order` itself
is not user-editable, since independent tasks fan out and position was never the
schedule); with that, a cycle cannot be expressed and no cycle check is needed at
the edit site. On the planner path that post-pass *repairs* rather than refuses:
a batch declares dependencies and `repairOrder` re-slots whatever the graph now
demands, keeping unrelated tasks in their relative order and every running or
completed task in the exact slot it already holds — a batch that could only be
satisfied by shifting one of those is what gets refused, naming it. The `reorder`
op therefore survives only as deliberate re-prioritising of *independent* tasks;
nobody has to re-declare a whole plan to move one dependency.
`dependencyCandidates` is what a picker offers (earlier tasks only; omit the id
for a task that does not exist yet, since a new task lands last) and
`canSetDependencies` is what the API refuses — one rule, two readings of it, so a
picker can never offer an edit the server rejects. Both are typed structurally
(`TaskRef`) rather than over `Task`, because the TUI projects tasks into its own
`TaskView`: a `Task`-only signature is what would have forced a second copy of
the rule into the reducer. `Session.setTaskDependencies` throws rather than
returning null so the surface can say *why* (`PUT` maps it to 400, VS Code to a
warning, and both then re-show the accepted list — a refused edit must not leave
an optimistic checkbox on screen).

**Hand-added task (`Session.addTask`, done by *PlanEditor*)** — async, and for the same reason
`setTaskRunner` is: a task with no model or mode is not a lighter task but an
unspawnable one, so an unset assignment is derived from the runner's catalog
through the same `runnerAssignment` the runner retarget uses. The runner defaults
to `plan.runners[0]` and is admitted into the plan (`admitRunner`, shared with
`setTaskRunner`) — `createTask`'s own `'claude-code'` fallback would otherwise
fail `validateAssignedRunners` on the next load of a plan that disabled it.
Dependencies naming tasks that no longer exist are dropped, not rejected: the
caller is a picker over the current plan, so a stale id means the plan moved on.
Because the derive lives here, both surfaces' add flows can send only what the
user actually typed — the TUI sends just a title.

**Direct edit vs planner edit** — the same task change is governed differently
depending on who asks. The planner path (`applyTaskOps`) refuses to modify or
remove a task that is `in_progress` or `completed`: the model does not get to
reach into work that is running or already finished. The direct path — the TUI's
`a`/`d` keys, the webview's task card, `PUT`/`DELETE /tasks/:taskId` — is the
user editing their own plan, so it allows both, and pays what that costs:
removing a running task cancels its runner first (`releaseTask` → `cancelTask`,
which bumps the verifier generation before the process dies), because a plan
that simply dropped the task could never reach the runner session again and the
orchestrator went on counting it as active — one of the ways "Execution is
running" became permanent. Removing a `completed` task drops it from the
completed set, which is safe because `removeTaskFromPlan` detaches the
dependents in the same op; `PlanStore.remove` additionally releases any
dependent parked at `blocked`, whose status `isBlocked` reads on its own and
which nothing else would ever unblock.
The asymmetry itself is expressed as one `actor` parameter (`'planner' |
'direct'`) on **TaskEditValidator**'s single `validateTaskEdit`, not as two
separate rule implementations — see below.
*Avoid:* adding a second copy of a rule to one side. A hand-set dependency list,
a type flip, and a model/mode assignment are all validated by
`validateTaskEdit` — the one guard the pickers, the API and the planner all
read, `canSetDependencies` included as one of the checks it runs.

**Planner rewrite** (`keepExecutionState(current, rewrite)`) — a planner
answering an edit with a whole task list instead of task ops: a `plan` turn on
a plan that already exists, or the between-batch drain of queued edits
(`modifyDuringExecution`). The rewrite is laid over the plan's execution
state, never swapped in for it — the same rule `applyTaskOps` enforces, for
the path that has no ops to check. A *settled* task (`completed`,
`in_progress`, `awaiting_user`) is kept exactly as it stands where the rewrite
names it and put back beside its old neighbour where the rewrite leaves it out;
every other task keeps its status, and one the rewrite adds starts `pending`. A
planner restates tasks, it never witnessed one run, so no status is ever read
from a rewrite. Without this, a planner that answered "add a task" with the
full plan echoed finished tasks as `pending` and they ran again. The drain
shows the planner only unfinished tasks as pending and every finished one —
earlier runs' too — in the execution log.
*Avoid:* "regenerating" the plan for an edit — only `generatePlan` and the
first plan commit start from zero, and only `rearm` or Mark not done re-runs a
finished task.

**TaskEditValidator** (`validateTaskEdit(actor, tasks, taskId, changes,
catalog?)`) — the one checker behind both edit paths described above:
`applyTaskOps` calls it with `actor: 'planner'`, `PlanEditor.updateTask` (behind
`Session.updateTask`) calls it with `actor: 'direct'`. Only the lock rule (no touching `in_progress` or
`completed`) reads the actor; every other rule — a hand-set dependency list
(`canSetDependencies`), coherence on an AI↔MAN `type` flip, and whether an
`assignedModel`/`taskMode` is something the target runner actually offers —
describes the *task*, not who is editing it, so both actors run the same
check. A flip that is well-formed returns which fields the new type stripped
of meaning (`TaskEditCheck.clear`) — `assignedModel`/`thinkingEffort`/
`taskMode`/`autonomy` going to `user`, `userSteps` going to `ai` — named so the
caller can force-clear them and say what was lost, rather than leaving stale
values that describe a type the task no longer has. The `EditCatalog` a
model/mode check runs against is deliberately the same discovered models and
manifest modes the planner was already shown, in the per-turn catalog block
and in a Task query catalog answer (below) — a refusal here can never name
something invalid that the planner was never told about, or the reverse.
*Avoid:* calling `coerceAssignments` from here — that function is the silent
safety net for paths that never reach this validator (a plan committed under a
now-stale catalog); this validator refuses instead of coercing, because a
planner mid-edit has a repair loop to answer to and a coerced value it never
asked for would drift the plan without telling either side.

**Task query** (`{"taskQuery":{"tasks":[...],"fields"?:[...],"catalog"?:true}}`)
— the planner's read channel, alongside the plan and `taskOps` envelopes
`classifyPlannerReply` already recognizes (see ADR-0012). An MCP-capable
planner reaches the same reads as the `task_query` and `task_output` tools
(*Planner token*, ADR-0022), which answer the same fields from the same live
state and spend the same per-turn budget; this envelope is the fallback for an
API planner. A harness planner must attach its Ordewell tools — respawned once,
then failed before any prompt is sent (ADR-0025) — so it has no envelope path. The per-turn
plan block is short-fields-only by design (title, status, runner, model, mode,
deps — never a task's `prompt`, `userSteps`, `verdict`, `outputSummary`, or
`userStoriesCovered`), so a query is how the planner reads what the block
leaves out before rewriting it, instead of fabricating content it never saw.
`PlannerConversation.drainTaskQueries` answers it — from live state, never
persisted to `conversationHistory` — in its own loop *before* `repairLoop`, so
a read never spends the corrective-retry budget a fumbled edit is owed, and
*before* the live-execution queue gate, so a read still lands mid-run (it
mutates nothing). One field reads execution state: `output` (with top-level
`outputLines`, default 80 capped at 400, and `outputSince`, a previous
answer's next offset) returns the clean-rendered tail of a task that is
running right now, from `TaskOrchestrator.getLiveOutput` through the
conversation host — the planner's way to diagnose a stuck task mid-execution.
An ended task is pointed at its `outputSummary`/`verdict` instead. The answer
is kept within a character budget, trimming the tail's oldest lines and saying
so. Budgeted per user turn: three reads before every answer also nudges the
model to land the turn, six before the loop stops answering and returns a
message turn instead; a repeated identical query (`taskQuerySignature`) is
treated as already at the soft cap. `catalog: true` needs no plan yet, so it is
legal on the very first planning turn.
*Avoid:* inlining full task bodies into the per-turn plan block to sidestep
this — that is the token cost the channel exists to avoid paying on every
turn regardless of whether the turn needs it. *Avoid:* disclosing task log
file paths to the planner as a second read mechanism — it would carve `.ordewell/`
out of ADR-0008's path confinement and put the read outside the query budget;
the envelope read is bounded by construction.

**Webview modals are host modals** — `window.confirm`/`alert`/`prompt` are inert
in a VS Code webview: it is sandboxed without `allow-modals`, so Chromium ignores
the call and `confirm()` returns `false`. A `confirm()` guarding the Remove Task
button therefore swallowed every click silently. Destructive confirmation belongs
to the host (`vscode.window.showWarningMessage({ modal: true })`), which is also
the side that can name what the removal will change — `removalPrompt` lists the
dependents that `removeTaskFromPlan` is about to detach, because counting them
tells a user nothing about which edges they are losing.

**Provider** — an LLM vendor/API (OpenAI-compatible via OpenRouter, or Google
Gemini). Distinct from *runner*.

---

## Models & routing

**ModelResolver** — the single deep module owning everything the surfaces need to
know about models. Three responsibilities behind one interface: (a) per-runner
executor model discovery for the planner (`modelsForRunners`), (b) the
orchestrator/review **picker catalog** (`pickerOptions` — fetched provider
catalogs only; shortcuts are a curated label/ordering overlay on fetched ids,
never injected as standalone entries), and (c) building the **provider model lists** that drive
routing (`refresh`). Constructed with `(registry, config)`; owns all model caches
behind one `invalidate()`. Discovery (formerly the `ModelDiscovery` class), the
OpenRouter catalog fetch, and Gemini discovery are its *implementation*, not its
interface. `fetch` and `exec` are injectable so the subsystem is testable without
network or child processes.
*Avoid:* "model service", "model manager" — and do not let callers re-assemble
`modelsByRunner` or the routing lists themselves; that leverage belongs to the
resolver.

**Harness planner** — a *runner* serving as the *planner* (ADR-0009). Selecting
`claude-code`, `codex`, or `opencode` in the provider dropdown runs the planner
conversation through that coding agent's own programmatic transport, so no API
key is requested and the user's existing subscription pays for planning. This
deliberately puts three runners into the `AiProvider` axis, against the
Provider/Runner split the rest of this glossary keeps: "what plans for me?" is
one user question and belongs in one setting. `isCliProvider()` is the single
predicate that tells the two kinds apart, and it guards exactly three things —
API-key resolution (skipped), provider routing (skipped), and the planner-model
picker (fed by per-runner discovery instead of the vendor catalog). The
transport lives behind the existing `IAiService` seam (`CliAgentAiService` plus
one adapter per agent); everything above it — reply classification, the repair
loop, `ResearchProgress`, the four surfaces — is untouched. Read-only is
enforced at spawn *and* at the request surface: whatever an agent can ask a
human for is either withheld (OpenCode's `question` tool) or answered with a
refusal (its `permission.asked` events; every Codex server→client request,
including the ones whose result schema cannot express "no" and so get a
JSON-RPC error). Unanswered is not a denial to these agents — it is a hang. The
planner prompt is always *appended* to the agent's own instructions, never
substituted for them, or the agent forgets what its tools are. A planner must
also be *able* to read: Codex's sandbox is probed before its handshake
(`codexSandbox.ts`), because a bubblewrap that cannot create user namespaces
leaves it answering from memory rather than from the repository. A harness
planner also gets the *Planner token* and its tools (ADR-0022): `list_runners`
and `list_models` read the live catalog, `task_query` and `task_output` read
tasks, and `submit_plan`/`edit_plan` are the only writes, all pre-authorized.
A harness planner that cannot attach its tools is respawned once and, if that
also fails, the planner turn fails before any prompt is sent (ADR-0025); it
never falls back to a prompt-and-JSON-envelope path. API planners use the
validated plan, `taskOps` and `taskQuery` envelopes instead of this server.
*Avoid:* "CLI provider" — the thing on the other end is not a vendor. Do not
call the coding agent a "provider" in prose; it is a runner being used as the
planner.

**agent_tool** — the `ResearchToolType` member for a harness planner's own tools
that Ordewell has no equivalent for (`Edit`, `TodoWrite`, `Task`, whatever ships
next). The agent's real name travels in `ResearchStep.toolLabel`, so a timeline
never claims a web fetch was a shell command. Well-known agent tools (`Read`,
`Grep`, `Glob`, `Bash`, `shell`) map onto the existing members instead and
render through the code path that is already there.
*Avoid:* widening `ResearchToolType` to arbitrary strings — the closed union is
what gives the surfaces' icon/label switches their exhaustiveness checking.

**runnerProvider** — the runner-internal backend a discovered model belongs to, exactly as that runner's own catalog prints it. It was `"opencode"`/`"opencode-go"` when OpenCode namespaced by backend; today most of its 414 models come back as `"openrouter"`, because the prefix names the *serving* provider. Carried on `DiscoveredModel`. Distinct from the Ordewell concept of *Provider* (LLM vendor).
*Avoid:* "provider" for this concept — use `runnerProvider`. And do not use it alone as a group header: it cannot say which agent Ordewell would spawn.

**runnerId / runnerLabel** — the runner whose catalog listed a model, stamped once at `ModelDiscovery.discover` (the only place that knows both the output and the agent that produced it). Model pickers group on the pair — `OpenCode · openrouter`, `Claude Code · anthropic` — so the header names the agent that runs the model and the backend that serves it. `runnerProvider` alone answered neither question in a flat cross-runner list.

**Planner model & effort** — the harness planner's own model and thinking effort (ADR-0009, stories 7–9), distinct from the per-task assignments the plan carries. Stored as `orchestratorModel` + `plannerThinkingEffort`; the candidates are the *runner's* `DiscoveredModel[]` and the selected model's own `variants`, never a fixed low/medium/high the agent may not declare. One control per surface: VS Code's planner bar (backend pills + model/effort selector), the TUI's `/planner`, `/model`, `/planner-effort`. Each backend's last pick is remembered per AiProvider under the settings file's `plannerModels` key — the same file as `modelAllowlist`, so the TUI, CLI and VS Code extension share one memory. Switching back to a backend restores the model (and effort, when that model still declares the variant) it remembers; with nothing remembered it falls back to the first model in that backend's catalog, and only a catalog that discovers no models leaves the planner model unset. Clearing a model always clears its effort — an effort is a variant of a specific model, and one that outlives its model reaches the agent as a level it never offered.

**ModelAllowlistResolver** — the deep module owning the planner-visibility allowlist policy: narrowing what `modelsByRunner` the planner sees in its prompt (the nudge) and rewriting any emitted `assignedModel.modelId` outside the allowlist to `allowlist[0]` for that runner, wiping the paired `thinkingEffort` (the coerce). `coerceAssignments` also clamps each `thinkingEffort` to a variant the assigned model actually offers (per the discovered catalog, when passed): invalid efforts snap to the nearest rung of the known effort ladder (`clampThinkingEffort`), or to undefined — the runner default — when no mapping exists. Symmetric to `ModeResolver` — both own a planner policy paired with a post-parse fix. Reads its state from `SettingsService` (`UserSettings.modelAllowlist`, keyed by `RunnerId`, id-level not variant-level). The restriction is advice to the planner only: the per-task dropdown stays full (manual override is sovereign), `loadPlan` is untouched, and the orchestrator never consults it. A set allowlist is a hard bound on what the planner sees: allowlisted ids not covered by discovery are synthesized into the prompt list rather than falling back to the full discovered list (which would leak non-allowlisted models to the planner).
*Avoid:* "model filter", "model restriction service" — and do not collapse into `ModelResolver`; the discovery/routing module stays unaware of the policy, the same way `ModeResolver` stays separate from `ModelResolver`.

**Provider model lists** — the canonical `{ openrouter[], google[] }` id lists
`resolveProvider` matches a chosen model id against to pick its serving API. The
ModelResolver is the **sole producer**: native Gemini ids are always minted with
the `gemini:` qualifier (`geminiOptionId`) so a stored `gemini:<id>` routes to
the Gemini API, never to OpenRouter's `google/<id>` namespace. Built in one place to
keep the two surfaces from diverging.

---

## Modes

**ModeResolver** — the deep module owning ADR-0001 mode resolution: the
planner-nudged, parser-validated policy that picks each AI task's runner mode
(`build`/`acceptEdits`/`plan`/…) from manifest `autonomous`/`safe` tags and the
global autonomy toggle — two named levels, **Full** (the `autonomous`-tagged
mode, today's ON) and **Guarded** (the `safe`-tagged mode, today's OFF), carried as
the boolean `autonomousMode` (`autonomousDefault`, TUI `autonomous`) and named for
users by `autonomyLevelLabel`; `/auto full|guarded` selects one, with `on`/`off` and `auto` as
aliases (`parseAutonomyLevel`). Three operations behind one interface:
`resolveDefaultMode` (tag-based default per toggle), `buildModeGuide` (the
mode list the planner's prompt shows, DEFAULT-tagged, opposite-toggle modes
hidden), and `resolveTaskMode` (the parser's validator — fixes invalid or
toggle-conflicting emissions, never overrides a valid `plan`). The policy is
planner-nudged, never runtime-overridden; what the plan says is what runs.
*Avoid:* "mode service", "mode manager", "auto mode" for either level, and "Full auto" /
"Auto" (the levels' old names) — Claude Code has a real `auto` permission mode
(its classifier), which is Ordewell's *Guarded* level on that runner, not a
synonym for Full — and do not confuse with
**ModelResolver** (model discovery/routing). The names differ by one letter on
purpose: ModeResolver resolves *runner modes*; ModelResolver resolves *models*.
*Avoid:* "the parser" for this policy — it lives in `ModeResolver.ts`, not the
plan parser, even though `resolveTaskMode` is the parser's validator.

---

## Verification

**Verdict** — the single structured outcome of verifying a finished task:
`{ outcome: 'pass' | 'fail', reason, checks[] }`. Produced by the
**VerdictEngine** (the deep verification module), applied by the orchestrator.
The verdict is owned *entirely* behind the VerdictEngine's interface; the
orchestrator schedules on the outcome, it does not re-derive it.
*Avoid:* "review result", "verification result" as separate concepts — they were
two redundant shapes for the same fact and collapse into the Verdict.

**Mark complete** — the user action of force-completing any task regardless of
runner state. Promotes the task to `status: 'completed'`, records a synthetic
`pass` Verdict with a `manual` verification check, archives the task to the
execution log, and unblocks dependents so the scheduler can advance. Distinct
from `cancelTask` (which returns a task to `pending` and places it on hold) and
from automatic completion (which is produced by the VerdictEngine when the
runner makes a **Completion call**).
A clean runner exit without a completion call is a failed verdict, never implicit
completion.
*Avoid:* "skip" for this concept in backend code — the VS Code `skip`
affordance is implemented as Mark complete.

**Mark not done** — the inverse user action, and the only way back out of a
completion: `markTaskIncomplete` returns a `completed` task to `pending`, drops
its Verdict and output summary, and *removes its execution-log snapshot* —
dependents are prompted from that log, so a left-behind snapshot would keep
feeding them a result that no longer exists. The task is placed on hold like a
cancel, so a running plan does not immediately re-spawn the work just un-marked
(Retry / Force Start / Run release the hold), and a plan whose status had
reached `completed` returns to `approved`. It is a no-op on any task that is not
completed. Both directions are one affordance per surface, never two: the VS
Code task-check ring toggles, and the TUI's `m` picks its direction from the
selected task's status (footer hint follows: `m done` / `m undone`).
*Avoid:* "un-skip", "reopen" — and do not model it as `retryTask`, which counts
a retry attempt and releases the hold.

**VerdictEngine** — the deep module owning the verification state machine:
**Completion calls** from token-bound handlers, `checkpoint` tool calls and
answers, idle tracking, exit-code normalization, verdict production and the
manual "Mark complete" override. The orchestrator hands each spawned session
to `watch(task, session)` and receives verdicts through `onVerdict`; it never
re-derives them. `markComplete`, `clear` and `reset` route through the same
owner. Each callback carries its attempt's generation, from a counter that
`reset` never rewinds, so a stale callback cannot settle a later attempt. A
completion call held behind an undelivered message is invalidated when the
runner reads that message. Output only refreshes advisory idle tracking; it
is never scanned for completion or checkpoint markers. A fake `IRunnerSession`
is the test seam.
*Avoid:* "the verifier", "TaskVerifier" — use VerdictEngine.

**TaskOutputSource** (`interfaces/TaskOutputSource.ts`, default
`BufferedTaskOutputSource`) — the one owner of a task attempt's output,
injected into TaskOrchestrator through `SessionDeps.taskOutput`. It keeps a
bounded buffer fed by the session and answers `finalText` (the completion
call's summary, falling back to clean plain output for the current turn) and
`liveTail` (a bounded diagnostic window with an absolute `nextOffset`). A new
turn or a message read mid-turn clears the earlier summary and advances the
output boundary. It does not discover transcripts or render a runner's PTY.
*Avoid:* "the output buffer", "transcript capture" as the owner — a transcript
is a separate artifact, not completion evidence.

**Check** — one deterministic signal inside a verdict. `task_complete` is the
required completion check, with `exit_code` as supporting diagnostic evidence.
A manual completion has a `manual` check. `model_review`, `workspace_changes`
and `verify_command` were removed because they conflated evidence with opinion.
Verification never asks a model to break a tie. A runner exit without a
completion call fails, even with exit code zero.

**Testing strategy** — *removed.* Verification is completion-evidence based;
the planner no longer assigns a testing strategy per task. The `user_verify`
strategy is gone — a human who must confirm is modeled directly as a
`type: 'user'` task, not as an AI task awaiting verdict promotion.

---

## Planner conversation display

**Turn** — one exchange with the planner, from the user's prompt (or an
internal trigger) to a settled outcome, streamed between `planner_turn_started`
and `planner_turn_ended` under one `turnId`. Every turn-scoped message carries
that id; a message without a `turnId` does not belong to a streamed turn.
Turns settle through one classification (`PlannerTurnOutcome`: `message`,
`plan`, `task_ops`, `stopped`, `error`) and the settled message is
authoritative over anything streamed inside the turn.
*Avoid:* "the reply" for the whole turn — the turn includes tool calls,
thinking and possibly subagents; *Avoid:* overloading with the model's own
providers' "turns" — a harness planner may open turns of its own, and only ones
Ordewell opened are one of these.

**Segment** — a stream of reply text inside one turn a surface can show as one
growing message, keyed by `segmentId` on `planner_text_delta`. A backend that
streams prose, then an envelope, then more prose, hands over several segments;
the turn's final segment is the one a settled `planner_message` replaces.
*Avoid:* calling the segment "the reply" — only a settled `planner_message` is
that; *Avoid:* numbering segments by arrival — ids are given by the session,
not derived.

**Retraction** — `planner_text_retracted` saying streamed text was thrown away
for good: the reply it belonged to was discarded (a corrective retry, an
aborted segment). Everything a segment had streamed is dropped unless a later
`planner_message` or a later segment of the same turn replaces it; the block
the text was accumulating in ends and never returns from reload, because
retracted text is saved nowhere. A segment that streamed to the plan display
takes the turn's building plan with it, so a re-emitted plan never builds on
the botched one.
*Avoid:* "edit" — the text is not corrected, it is withdrawn whole;
*Avoid:* treating it as an error — a retracted segment is what a bounded
repair loop looks like to a viewer.

**Display block** (`core/src/conversation/blocks.ts`) — one thing a surface
draws for the planner conversation or a structured task's log: a `message`
(user, planner, agent, system or error), `thinking`, `tool`, `subagent`,
`approval`, `plan` or the `usage` token line. Built once in core by
`reduceConversation` from the `SessionMessage` stream plus the surface's own
`LocalEntry` lines, or by `reduceTaskLog` from a task's log; a block's `id` is stable for
as long as the block exists, so a surface can key its UI state on it.
*Avoid:* deriving a per-surface block shape from raw `SessionMessage`s again —
the block list is the contract (ADR-0017); *Avoid:* storing per-block UI state
(expanded/collapsed) in the block — it is the surface's.

**Conversation view** (`reduceConversation`, `EMPTY_CONVERSATION`) — the
stateful accumulator behind the blocks: every `SessionMessage` in and the view
out. Pure and reusable per surface, including `fromTranscript`, which rebuilds
the saved subset for a reloaded session. The newest transcript entry the view
accounts for (`transcriptAt`) is what tells a reconnecting surface what is new.
*Avoid:* calling it a chat log or a message list — it is a reducer over
messages to a drawing, and streamed semi-states live in it;
*Avoid:* a surface holding its own parallel mirror of the view.

**Turn gate** (`TurnGate`, `followTurn`, `stopTurn`) — the stop rule, beside
the conversation view: which planner turn a surface has open and which one
its user stopped. A stop ends the turn on screen at once, and whatever the
stopped turn still streams until the backend notices the abort is dropped;
usage, approvals and transcript markers are facts and still land. Both
surfaces fold session messages through `followTurn`, so a stopped reply looks
the same in the TUI and VS Code.
*Avoid:* keeping a stopped turn's late deltas "until the daemon answers" —
that was one surface's rule and the two drifted.

**Detail view (detail-all)** — the single expand-all toggle per surface: the
TUI's ctrl+o and VS Code's header button flip one `detailAll` flag that decides
whether tool blocks show their arguments and full output, subagent blocks show
their children and digest, and so on. Collapsed is the default: a row per call
(`Name(keyArg)`) and one preview line. There are deliberately no per-block
expanded states (see ADR-0017's rejected options). The TUI's ctrl+L clears the
conversation but keeps the token line.
*Avoid:* "expandable row" per block — one toggle, one place, per surface;
*Avoid:* claiming the surfaces share the flag's key — ctrl+o is the TUI's
spelling, not the concept.

**Usage record** (`UsageRecord`) — what one model call consumed, as its
provider or runner *reported* it: token counts, cached input share, the
context window when the reporter states one, and `reportedCost` only when the
source itself billed one. Every measure is optional because backends report
different subsets; absent means "not reported", never zero.
*Avoid:* filling a missing number from a price table or an estimate — prices
go stale and a subscription runner has no per-token price at all (ADR-0017);
*Avoid:* treating a record as a statement about *who* called — it says nothing.

**Usage totals** (`UsageTotals`, `PlannerUsage`) — the running sum of usage
records for the session. Token counts stay absent until some record reports
them; cost is kept per currency because two runners may bill in different ones
and no honest exchange rate folds them together. `bySubagent` holds each
research subagent's own share, which is already counted in `totals` — never
added twice. Surfaced as the one `usage` block, the token line, always last.
*Avoid:* merging currencies; *Avoid:* a "grand total" that mixes the planner's
own calls in with per-subagent sums shown alongside.

**Context fill** (`plannerContextFill`) — how full the planner's own context
window is, from its last prompt's reported input tokens against the window the
runner reports. Derived only for the planner's own calls: a subagent runs its
own model, whose window says nothing about the planner's. A reported window of
0 means "not known", and then the fill is simply omitted — never shown against
a guessed zero.
*Avoid:* calling it a percentage when either half is unknown.

**Subagent lifecycle** — a research subagent as a first-class block: announced
by `subagent_started` (brief and model), running its calls tagged with its
`subagentId`, ended by `subagent_finished` with an outcome
(`done | failed | stopped`) and the digest it handed back. The planner's
`spawn` tool call becomes the subagent's own block — the two never show as
separate rows. Usage is folded through the same events, tagged
`subagentId`. Persisted in the research log; a reload regroups child steps
under the subagent's block rather than duplicating them.
*Avoid:* "child session" for the concept (that is OpenCode's mechanism, not the
contract); *Avoid:* a finished subagent without an outcome claiming success —
omit or failed, never guessed.

**Queued prompt** — a message the user sent while a planner turn was in
flight, held and sent as the next turn's input rather than bounced (the
`ConversationBusyError` path stays for operations that would share the live
context, such as a Compaction). One module owns it:
`core/src/conversation/promptHold.ts`, a pure hold both surfaces keep — the TUI
in its reducer state, VS Code on the host (`ConversationViewHost`). Prompts go
out **oldest first**, one per settled turn; **unsend takes the newest** back
into the drafting input, above any draft, and the planner keeps running. A
stopped turn gives every held prompt back to the input, in the order typed; a
new or reloaded session drops them. Drawn after the conversation, never in it:
a prompt joins the conversation only once it is sent.
*Avoid:* "pending message" (that names the whole queue's existence, not one
entry); *Avoid:* treating unsend as cancel — nothing in flight is stopped; the
prompt simply never goes; *Avoid:* "queued" for a **Pending plan edit**.

**Pending plan edit** — a structural edit the user sent while a *run* was live:
the Session's run-time edit queue (`getQueuedMessages`), which VS Code lists
above the input with a way to withdraw each one. The Session drains it itself
at the next batch boundary — when the scheduler, parked behind the queue with
nothing live, signals queue-ready — and announces the plan the edits made
(`plan_generated`, carrying what is still queued); no surface triggers the
drain. It waits on a run, not on a planner
turn, and is applied to the plan rather than sent as a prompt — a different
concept from a queued prompt, which is why the surfaces name it apart. An edit
stays queued until the planner's answer is applied, so the run starts nothing
while the drain is out; once the planner has it, it can no longer be
withdrawn. One drain runs at a time: an edit sent during it is drained after,
before the run goes on. Like a planner turn, a drain answers the plan it was
asked about: one that settles after that plan was swapped out is dropped, not
reconciled into its successor, and wakes no run.
*Avoid:* "queued message" or "queued prompt" in UI text for it.

---

## Surfaces

**Surface** — a client that drives Ordewell: the **VS Code extension**
(webview), the per-command **CLI**, and the **TUI**. All of them consume the same
`SessionMessage` union and none holds orchestration logic, but they reach a
`Session` two ways. The CLI and the TUI talk to the **local daemon**
(`packages/web`, HTTP + WebSocket on `127.0.0.1`, with no frontend of its own);
the VS Code extension runs core's `Session` in-process and never connects to the
daemon. A session planned on one surface opens unchanged on another through the
saved-session store in `.ordewell/sessions/`, not through a shared transport
(ADR-0006).
*Avoid:* "web UI" — there is none; the web package is the daemon.

**TUI** — `ordewell tui`, the full-screen terminal surface (ADR-0006). Its core
is pure: `reduce(state, action)` returns `{ state, effects }` and `render(state)`
returns exactly one string per terminal row, so commands and layout are asserted
without a daemon or a tty. Only `terminal.ts` touches the real terminal.

**Task row view** (`taskRowView`, `core/src/taskRow/`) — what a row shows about
one task, decided once in core and drawn by both the TUI and VS Code: its
*status kind* (`TaskStatusKind`, including `quiet` — `in_progress` with a silent
runner, which VS Code words "Stalled" and the TUI marks "~"), the *row actions*
it offers (`taskRowActions`, differing by *placement*: a task or a subtask), its
ops and isolation state, and its merge gate. Task references are shared too
(`#2.1`, `#2 Deploy`). A **mark request** (`markRequestFor`) is the one reading
of Mark complete and Skip: skip has no request of its own and marks the task
complete. A surface chooses words, glyphs and casing and nothing else; a row
state a surface needs and the view lacks is added to the view, not branched on
in the surface.
*Avoid:* "idle" (a silence guess, and the name of a state that is not this
one — see *Waiting for input*), "task card" (VS Code's component) and "task
line" (the TUI's) for the view itself — they are drawings of it.

**Command surface** — the set of things a user can ask for by name. It is one set
with two spellings: a TUI slash command (`SLASH_COMMANDS` in `tui/slash.ts`) and
an `ordewell` subcommand (`COMMANDS` in `commands/registry.ts`), and
`commands/__tests__/parity.test.ts` fails if a name exists in one and not the
other without a stated reason. What differs is only how a target is named — the
TUI opens a picker, the CLI takes an argument, and a CLI command given no
argument prints the options the picker would have shown. There is deliberately no
`/plan` slash command: typing the goal *is* how planning starts there, and an
alias for it only shadowed `/planner` on tab-completion. `ordewell plan --goal`
remains, because it is the only non-interactive way in.

**Catalog** (`catalog.ts`) — the one owner of the `/api/models` body's shape, for
every client of it. `normalizeCatalog` is what tags each model with the runners
that offered it, and that tagging is a rule rather than a formatting step: model
ids are scoped to the agent that listed them, so `runners` is what every
downstream scoping check reads (`runnerServes`, the allowlist guard, the
per-task model check). A second copy of the loop would be a second answer to
"can this runner spawn this id".
*Avoid:* reading `modelsByRunner` at a call site.

**Pane geometry** (`tui/geometry.ts`) — the one owner of how wide the panes are:
`planPaneWidth`, `chatPaneWidth`, `paneTextRoom`, `taskEditorRoom`,
`chatEditorRoom`. Both the reducer and the renderer ask it. They used to each
carry a copy and the copies drifted — the reducer wrapped an expanded task's
prompt at the terminal width while the renderer wrapped it inside the plan pane,
so `up` moved the caret to a position computed for a line twice as wide as the
one on screen.
*Avoid:* recomputing `cols - 4` at a call site.

**Pane layout** (`tui/layout.ts`) — the same idea one level up: the one owner of
what each pane's content *is*, and therefore how far it scrolls. `bodyRows`,
`chatLayout`/`chatScrollMax`, `planLayout`/`planScrollExtent`, `helpLayout`.
`render.ts` paints, fits and joins what comes back; the reducer imports only the
bounds, and clamps every offset where it is written. The bug that produced this
seam was a dead zone, not a lost keystroke: the offsets grew unbounded (chat) or
against a deliberate over-estimate (plan) while the renderer clamped to the real
content, so every notch back the other way was swallowed until the counter fell
under the bound. `planScroll` is an **absolute** offset that persists across
arrow presses — the cursor walks inside the viewport and it scrolls only when
the selected task's lines would leave it (`revealOffset`); `null` just means it
has not been positioned yet. A page key or wheel notch scrolls first and drags
the selection along only as far as keeping it on screen needs.
*Avoid:* estimating rows-per-task, or clamping a scroll offset only at paint time.

**Effect** (TUI) — a description of work the TUI wants done (`setModel`,
`taskAction`, `loadSessions`), returned by the reducer and executed by
`effects.ts` against `ApiClient`. Results come back as **actions**. *Avoid:*
calling these "commands" — a **slash command** is what the user types; the
effects it produces are a separate layer.

**Daemon contract** (`packages/core/src/daemonContract.ts`) — every HTTP body the
local daemon sends, as types in core: one response type per shape, plus
`ErrorBody` and its `DaemonErrorCode`. The routes build their bodies against it
(`satisfies`), `ApiClient` reads them back, and the TUI's `OrdewellApi` and the
catalog's `RawCatalog` derive from it, so a field changed on one side fails to
compile on the other. It lives in core because both packages already depend on
it; the CLI must never import the daemon's runtime. A refusal travels as a stable
`code`, mapped from core's typed errors (`SessionNotFoundError`, `NoPlanError`,
`AlreadyExecutingError`, `ConversationBusyError`, `PlannerTurnStoppedError`, …) in one table
(`routes/errors.ts`) and surfaced to callers as `DaemonError.code`. The REST plan
is the session's own plan state, not the `SerializedPlan` a socket carries.
`PATCH /api/settings` also answers `switchRecall` — which model a planner switch
landed on and why — only when the write changed the planner.
`daemonContract.test.ts` drives `ApiClient` against the real `createApp` and
`OrchestratorPool`.
*Avoid:* branching on a daemon error's message text — the message is for display,
the `code` is the contract. *Avoid:* a hand-written response type in a client or
route; add it to the contract.

**Daemon revive** (`EffectDeps.reviveDaemon`) — the TUI's answer to a server
that went away mid-session. `ensureDaemonOwned` runs once, at launch, but the
TUI outlives its daemon in every direction: the daemon crashes, another client
runs `ordewell stop --server`, a rebuild is followed by a manual restart.
Before this, the first refused connection ended the session — every later
action reported `connect ECONNREFUSED 127.0.0.1:3742` and nothing brought it
back. `runEffect` restarts the daemon and replays the effect exactly once.
*Avoid:* widening the retry past `isConnectionRefused`. Refused at the
handshake is the one errno that proves the request was never delivered, so
replay cannot be a second execution; `ECONNRESET` and `EPIPE` can arrive after
the server read the request, and retrying those starts a second run.
*Avoid:* a revive that prints. It runs with the full-screen frame on the
terminal, so `startDaemon` takes `quiet` — which also makes it throw where it
would otherwise `process.exit`, since exiting drops the user out of a
full-screen app with a half-restored terminal.

**Settings write order** — the daemon accepts a settings change *before*
`.env` records it (`persistAfterDaemon`). The reverse looks harmless and is
not: `.env` is the disk, and a failed call left it holding a choice neither the
daemon nor the screen ever saw. A planner switch writes `AI_PROVIDER` with
`ORCHESTRATOR_MODEL` and `ORDEWELL_PLANNER_EFFORT` set to whatever the daemon
resolved — the backend's remembered model, its catalog default, or nothing — so
one refused connection would have persisted a provider paired with the model of
the backend it just left, and the next daemon started from that file, silently,
with the TUI still showing the old planner.
*Avoid:* `setEnvVar` before an `await api.*` in an effect.

**Adopt** (a session) — register a session persisted in `.ordewell/sessions/`
with the running server's `OrchestratorPool`, via `POST /api/sessions/:id/load`.
Reading a session (`GET /api/sessions/:id`) yields its plan but no orchestrator;
only an *adopted* session can be executed or edited. Re-adopting a session that
is already live is a no-op — the in-memory session wins over the file, because
`Session.loadPlan` would otherwise clear its execution log (ADR-0006).
*Avoid:* "load" alone for this — the TUI's `/sessions` and `ordewell sessions
load` both *read* and *adopt*, and the distinction is what the bug was.

## Platform

**Launch plan** (`utils/launch.ts`) — the answer to "how do I start this agent
CLI on this OS", shared by structured runners, harness planners and model
discovery. `planDirectLaunch` serves every `spawn` caller and is identity on
POSIX: execvp already searches PATH. Windows resolves PATH × PATHEXT in order:
a native executable, a batch shim through `cmd.exe /d /s /c` with verbatim
arguments, then a PowerShell shim through `powershell.exe -File` (ADR-0010).
*Avoid:* calling `spawn('claude', …)` directly on Windows; CreateProcess does
not perform PATHEXT lookup. A batch command line needs the outer quote pair
that `cmd /s /c` strips. Capacity does not reorder the routes: an overflowing
batch shim still raises, whereas a line break may fall through to PowerShell.
PowerShell shims are considered even when PATHEXT omits `.ps1`.

**Well-known bin dirs** (`utils/shellPath.ts`, `wellKnownBinDirs`) — where a
runner might be, when PATH does not say. On Windows there is no login shell to
query, so this list is the entire safety net, and a directory missing from it is
a runner the picker greys out while the user looks at the install that just
succeeded. It covers the PowerShell one-liner installers (`~\.local\bin`,
`~\.opencode\bin`), the Node package managers (npm, pnpm, Yarn, bun — no shared
prefix), the Windows package managers (Scoop, Chocolatey, WinGet `Links`), and
Volta's Windows home. Pure in `(platform, env, home)` so a Linux box can pin it.
*Avoid:* assuming a POSIX location transfers. Volta is `~/.volta` there and
`%LOCALAPPDATA%\Volta` here; `WindowsApps` holds MSIX aliases only and is not a
substitute for WinGet's `Links`.

**Research shell** (`services/researchShell.ts`) — the interpreter the planner's
`bash` tool runs in, and the **dialect** it will be read as. POSIX resolves to
`{ file: null }`, meaning "use `shell: true`", unchanged. Windows looks for the
POSIX shell Git for Windows ships — so `AUTO_COMMANDS` (`ls`, `cat`, `wc`,
`grep`, `find`) works as written instead of needing a second Windows vocabulary —
and falls back to cmd.exe *while saying so*. `C:\Windows\System32\bash.exe` is
excluded deliberately: that is the WSL launcher, whose `/mnt/c/...` view would
make every workspace path name a different file than the one confinement checks.
*Avoid:* treating the shell choice as an adapter detail. `BaseFileSystem` owns it
because `classifyCommand` has to be told the same answer.

**Dialect** (`shellLexer.Dialect`) — what the interpreter that will run a
command treats as syntax: escape character, whether that escape survives inside
quotes, quote characters, expansion syntax, stripped executable extensions.
`escapeInQuotes` is load-bearing — cmd.exe reads `^` inside a quoted run as an
ordinary character, and honouring it as an escape let `echo "a^"b^" & del x"`
classify `auto` and run. Keyed to the **interpreter, not the OS**, so a
Windows host with Git Bash classifies as POSIX. Lexing cmd.exe input with POSIX
rules inverted specific answers rather than merely blurring them — `\` is an
escape in `sh` and a separator in cmd, so `rg pattern C:\repo\src` tokenized to
`C:reposrc` and failed containment against the workspace it named.
*Avoid:* a `platform` parameter here. The question is which language, and a
Windows box can answer POSIX.

**Kill tree** (`utils/processTree.ts`) — the one way an agent process is stopped.
On POSIX a runner is spawned as the leader of its own process group
(`spawnInOwnGroup`), and SIGTERM → SIGKILL goes to the whole group: signalling
only the direct child left the shells, MCP servers, test runs and dev servers it
started running after Stop. Having left the terminal's foreground group, a
runner no longer hears Ctrl-C, so the host passes SIGINT/SIGTERM/SIGHUP and its
own exit on to the groups it leads. Windows has no signals and the direct child
may be a cmd.exe shim rather than the agent, so `taskkill /T` walks the tree;
without it "stop" terminated the shim and left the agent running, still holding
the workspace and the subscription. One limit follows from how a runner is
started. A detached runner is a session leader (`setsid`) with no controlling
tty, so anything it does that opens `/dev/tty` — a password or confirmation
prompt — fails rather than prompting. After the leader exits, the
SIGKILL follow-up is sent only while the group still has members, since an
empty group's id may have been recycled.
*Avoid:* `proc.kill('SIGTERM')` at a dispose site — or a bare `proc.kill()`,
which was the last one left, in `ModelDiscovery`'s Codex app-server probe.

**Platform support** — the VS Code extension and the local daemon run on Linux,
macOS, and native Windows. The **TUI is not verified on Windows**; WSL remains
the supported answer for
that surface. Runner execution needs no tmux or per-task terminal windows
(ADR-0025). Two things about Windows are explicitly unverified rather than
claimed — Codex's read-only sandbox enforcement and `%VAR%` expansion on the
cmd.exe shim route. Argument fidelity on the PowerShell shim route was measured
on a Windows host. See ADR-0010.
