# Ordewell — Domain Glossary

The shared vocabulary for Ordewell. When code, issues, plans, or refactor proposals
name a domain concept, use the term as defined here. Synonyms listed under *avoid*
are deliberately not used — they blur a distinction the project cares about.

This file is the vocabulary the rest of the documentation is written in (see
[AGENTS.md](AGENTS.md)), and it grows as terms get resolved during design.

---

## Planning & execution

**PlanStore** — the deep module owning all plan-shaped state: the task tree
(`planTasks`), the flattened index (`allTasks`, `taskMap`), the completed/failed
sets, and `planRunners`. Owns structural CRUD (`add`/`remove`/`update`/`merge`/
`split`), status mutations (`markCompleted`/`markFailed`/
`markInProgress`/`retry`), the named run-preparation op (`resetForRun` — flip
AI tasks to approved, preserving completed ones unless the plan is a fresh
commit), runner-set validation, and the `rebuild` internal seam. Structural
removals prune stale completed/failed entries; `removeFromActive` deliberately
keeps them so a completed task that left the active list still satisfies its
dependents. The TaskOrchestrator is a
pure scheduler that calls `store.markCompleted(id)` instead of mutating task
state directly; Session owns the store and routes plan mutations through it.
*Avoid:* "the task list", "the plan state" — PlanStore is the module; the
plan is the artifact.

**Session** — the deep module owning one plan's full lifecycle: generation,
execution, mutation, persistence, and the orchestrator observer wiring. It
*hosts* the planner conversation but does not own it: `startPlanning`,
`continueConversation` and `isConversationActive` are thin delegations to a
**PlannerConversation**, which reaches plan state, persistence and scheduling
only through the host interface Session hands it.
Constructed with injected adapters (`config`, `runner`, `registry`,
`fsAdapter`, `broadcast`, `modelResolver`, `settings`, and optionally
`aiService`/`planner` — the constructor is the test seam; no test reaches
into private fields) so it is transport-agnostic. The orchestrator's observer is subscribed once for the
session's lifetime (not per-operation), killing the double-subscribe class of
bug — and it is the orchestrator's *only* notification channel: refresh and
queue-ready signals travel over it and become `status_update`/`queue_ready`
broadcasts (there is no separate `onRefresh` callback for a surface to wire).
Mutation is an internal seam — every structural plan mutation *and every
settled conversation turn* (plan commit, task-ops apply, planner message) runs
one `mutatePlan` ritual (store op → persist → broadcast), and so do the one-shot
`modifyPlan` and the between-batch drain of queued edits. The ritual covers plan
edits only: scheduler actions (retry, cancel, mark complete, tick) go through
the orchestrator, persist after it, and reach surfaces as `status_update` over
the observer, while `generatePlan` and `loadPlan` persist the plan they adopt
directly. Direct (non-planner) edits go one step further
through `editPlan`, which adds the reschedule they owe an armed scheduler:
nothing else wakes one after a hand edit, because a direct edit never queues,
so a task the edit unblocked would sit ready and never start. PlanStore is the single source of truth for task
state; `LegacyPlanState.tasks` is written from it at persist time and never read
back into it. The old
`syncStoreFromPlan` (plan → store direction) is removed — there is only one
direction (store → plan, at persist). Emits
**SessionMessage** (the plan-lifecycle events) through the `broadcast` seam;
catalog/config messages (`setModels`, `setRunnerList`, …) stay on the host.
The web pool and the VS Code extension are the two real adapters that justify
the seam. Planner progress is broadcast-only: `ResearchProgress` is translated
to SessionMessage inside the Session (`translateProgress`), and there is no
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
matches disk and the rollback declines. Transcript edits are whole-array
operations (`append`, `replace`), so rewinding, forking or compacting a
conversation is a transcript edit plus a `reset`.
*Avoid:* "chat" or "thread" for the module — the conversation is the thing; the
AI service only holds a disposable copy of it.

**SessionMessage** — the single union every delivery surface consumes: the
plan-lifecycle events (`plan_generated`, `planner_message`, `status_update`, …)
plus the four planner streaming variants (`plan_token`, `plan_thinking`,
`research_step`, `research_step_done`). Produced only behind the Session's
`broadcast` seam; the core-internal `ResearchProgress` union never crosses
into a surface. Surfaces adapt it to their own presentation protocol (VS Code:
`PlannerStreamRouter` → webview messages; web: raw JSON over WS) but never
re-map `ResearchProgress` themselves.
Isolated execution (ADR-0013) travels on it too: each `status_update` task
carries `isolation` (`state: none | active | integrated | conflict | kept`, plus
its branch and worktree) — absent altogether while the plan has no isolation
run, so a shared-root plan's updates are exactly what they were;
`isolation_blocked` says a run did not start on a dirty tree; and
`isolation_handoff` (integration branch, base ref, landed tasks) is sent when an
isolated run settles, *before* `execution_complete`.
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
JsonExtractor) plus every corrective prompt text. The conversation loop in
BaseAiService keeps its own driver (it also runs the tool rounds) but
delegates classification and prompts here. Policies (PRD nudge, ops
validation, abort guards) stay at the call sites — inputs to the loop, not
part of it.
*Avoid:* hand-rolling a retry loop or a corrective prompt at a call site —
adapt `repairLoop` instead.

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
on every backend alike. The summary must arrive inside `<conversation_summary>`
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
**PlannerConversation**: conversation turns, the one-shot `modifyPlan`
exchange (request plus a `plan_generated` marker), and queued mid-run edits
once `processQueuedMessages` applies them (a `system` entry, so the transcript
and the plan do not drift apart), a **Rewind**, which cuts it short, and a
**Compaction**, which replaces it with a summary and its last two exchanges. Every
write is persisted and broadcast through Session's `mutatePlan` ritual.

**Rewind** (`Session.rewindConversation(index)`) — cut the conversation back to
just before one of the user's messages, discarding it and everything after it;
the planner's `researchLog` goes back to the same point. `index` is the
message's position in `conversationHistory`, and `rewindTargets()` lists the
candidates with a one-line preview — every user message except the opening
goal, since a conversation without its goal is a new session (after a
**Compaction**, the summary entry stands where the goal did). The task list
is untouched, including tasks the discarded turns created, and so is any run
executing it: a rewind moves where the conversation resumes, not what the plan
is (ADR-0002, update of 2026-09-25). The planner's live context is reset, so
the next message replays from the shortened transcript on every backend alike.
Refused while a planner turn is in flight (`ConversationBusyError`), because
the turn's reply would land on a transcript that no longer holds the message
it answers. TUI and VS Code `/rewind` (picker) or `/rewind <n>` (VS Code also
"Ordewell: Rewind Conversation"); CLI `ordewell rewind [n]`.
*Avoid:* "undo" — nothing about the plan is undone.

**Fork** (`Session.forkConversation()`) — copy the conversation and its task
list into a new persisted session and continue there; the original, its file
and its live planner context are untouched, so either side can be forked
again. The fork carries no run: tasks caught in progress or at a checkpoint
become pending, finished ones keep their status, and queued mid-run edits and
any other per-run record stay behind. What travels is decided in one place,
`forkPlanState`, which lists fields rather than spreading the plan, so a field
added to the plan later stays behind until someone decides it should travel.
The daemon adopts the fork immediately (see **Adopt**); its first message
replays the copied transcript. Refused mid-turn like a rewind; allowed while
the original executes. TUI `/fork` switches to the fork; `ordewell fork` makes
it the current session; VS Code `/fork` ("Ordewell: Fork Conversation") loads
it like a saved session, which replaces the extension's one in-process
`Session` — so it asks first when a run is executing, since loading stops it.
*Avoid:* "branch" — that word belongs to git and to worktree isolation.

**PRD (prdMarkdown)** — with the PRD toggle on, the planner previews the PRD in
prose, and after the user agrees writes the full markdown wrapped in
`ORDEWELL_PRD_START/END` markers; core saves it to `.scratch/<slug>/PRD.md`
(the Matt Pocock to-prd convention) and keeps `prdMarkdown` on the plan.
*Avoid:* "PrdArtifact", "PRD status machine" — deleted; the PRD is a message
plus a saved file, not a typed state.

**Mode toggle (grilling / PRD / TDD / verify)** — a
per-pool user setting whose *only* effect is a prompt block injected into the
planner system prompt (`PlanPrompts.ts`) or into a runner task's prompt
(`promptAugment.ts`). Skills live inside Ordewell as these injected prompt
blocks; Ordewell never ships, reads, or references runner-native skill
mechanisms (`.claude/skills`, OpenCode plugins, etc.) to deliver them.
Research subagents (the `spawn_research_agent` tool, see ADR-0005) are
always-on for the planner — not a mode toggle.
The set is data, in `plannerModes.ts`: each toggle carries its id, its settings
key, its runtime key, and the **scopes** that honour it (`chat` / `one-shot` /
`task`). Every field is load-bearing, not documentation — `modesFor(scope,
modes)` clears what a path cannot honour, `plannerRuntimeToggles(settings)`
reads the whole set off disk under the names a Session expects, and the
planner-facing booleans travel as one `PlannerModes` value rather than a
positional tail. A toggle's disk and runtime names (`verify` / `verificationEnabled`)
therefore meet in one row. Its *display* name does not yet: the webview still
hand-writes the labels and passes them as positional booleans
(`setSkillToggles` in `extension.ts`), which is the next seam to fold in. Grilling and PRD are `chat` only because
both interview the user and the one-shot prompt states there is nobody to ask.
Before scopes existed, a toggle used to be silently dropped by the one-shot
planner while every surface still displayed it as ON, and nothing distinguished
that from a deliberate omission.
*Avoid:* "skill file", "slash command" for these — those are runner-side
concepts; in Ordewell a skill is a toggle plus its prompt block. Do not add a
toggle as another boolean parameter, and do not hand-map its settings key to its
runtime key when building `SessionRuntimeSettings`: add a row to `MODE_TOGGLES`
and a field to `PlannerModes`.

**Executor / Runner** — an external coding-agent CLI (Claude Code, Codex,
OpenCode, or a plugin) that runs *one task* in its own session. Identity and
invocation flow through the `RunnerRegistry` + manifest engine.
*Avoid:* "backend", "provider" (provider means the LLM vendor, below).

**Spawn toolkit** — the pure OS/shell policy behind the runner adapters
(`core/src/utils/shell.ts`): ANSI stripping (`stripAnsi`), POSIX/PowerShell
quoting, the login-shell invocation (`buildShellInvocation`), and the
`script`-based PTY wrap (`wrapWithPty`). Three adapters consume it —
`HeadlessRunner` (core; every OS touchpoint injectable via
`HeadlessRunnerDeps`), `VsCodeTerminalRunner`, `PoolAwareRunner` (web,
composes HeadlessRunner and must conform to the full `ITerminalRunner`
interface, including per-session `stop`). Tests hit the pure functions and the
injected seams, never a real PTY.
*Avoid:* re-declaring quoting/ANSI helpers inside an adapter — that
duplication is exactly what this module deleted.

**Task attempt** (`TaskAttempt`, inside TaskOrchestrator) — one run of one
task, from the moment the scheduler claims it to the moment it ends. It holds
everything that has to die with the run: the attempt number, the phase
(`starting` while the async spawn is in flight, `running` once the runner is
up, `integrating` while a passed verdict's worktree merges), the live
`ITerminalSession`, and the runner, working directory and start
time the transcript reader needs at verdict time — plus, in an isolated run,
whether that directory is its worktree and the merge in flight. The orchestrator keeps one
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
window is never overwritten by a stale verdict.
The working directory is decided in one place (`resolveAttemptCwd`): the
workspace root, or in an isolated run the worktree `WorktreeIsolation.prepare`
made for the attempt. A passed verdict keeps the attempt live through its merge,
so the task completes — and frees its dependents — only once its work is on the
integration branch. Holds, retry counts and spawn counts are
deliberately *not* on the record — they describe the task across attempts and
must survive one ending. Surfaces read an attempt through `getAttempt` /
`getAttemptSession`; `activeSessionMap` is derived from it. Runner session ids
are unique per spawn for the same reason: a retry reuses its task id, and a
registry keyed by task let the old attempt's exit unregister the new one.
*Avoid:* "session" for this concept — the session is the runner's process, one
field of the attempt. Do not add another per-task map to the orchestrator for
state that ends with the run; put it on the attempt.

**Isolated execution** — running each AI task in its own *worktree* instead of
the shared workspace root, then integrating the results deterministically
(ADR-0013). Available only when the workspace is a git repository with a clean
tracked tree and `worktreeIsolation` on; otherwise every task runs in the
workspace root exactly as before, and `WorktreeIsolation.isActive` says which
of `disabled`, `git-missing`, `not-git`, `no-commits` or `dirty` applied. The
Runner is only ever handed a `cwd` (ADR-0007) — git never enters
`ITerminalRunner`, `RunnerRegistry` or a runner adapter.
*Avoid:* "sandbox" (an OS-level runner sandbox is a separate concern, ADR-0011),
"clone" (a worktree shares the repository's object store).

**WorktreeIsolation** — the deep module owning every git and filesystem
operation isolated execution needs: worktree creation, the artifact bootstrap,
committing a task's work, the serialized integration merge, conflict detection,
release, orphan pruning, and the end-of-run handoff (diff, merge, discard).
`GitWorktreeIsolation` is the implementation; the orchestrator's tests use
`FakeWorktreeIsolation` from `@ordewell/core/testing`, and git behavior is
tested only against real temporary repositories.

**Worktree** — a linked git checkout on its own branch, created for one task at
`.ordewell/worktrees/<run-id>/<order>-<slug>` on branch
`ordewell/<run-id>/<order>-<slug>`. It is where that task's Runner executes.
Created when the task starts, removed when it integrates cleanly. A failed or
conflicted task's worktree is kept so its work can be inspected; a retry
discards it and starts a fresh one from the current integration tip. Ignored
artifacts (`node_modules`, `.env*`, `.claude`, …) are linked in from the main
worktree so it is runnable at once — never `.ordewell/`, which stays at the main
root.
*Avoid:* "workspace" for a worktree — the workspace is the user's checkout.

**Integration branch** — `ordewell/<run-id>/integration`, the one branch a run's
work lands on. Each task that passes its Verdict is merged into it with
`git merge --no-ff`, one at a time, lowest plan order first among the tasks
waiting, so the history is reproducible and each task is attributable to a merge
commit. A merge conflict is aborted and reported, never resolved for the user
and never by a model. It is never merged into the checked-out branch until the
user asks; it survives a discarded run until it is explicitly given up.
*Avoid:* "result branch", "staging branch".

**Base ref** — the commit the user's checked-out branch pointed at when a run
started, resolved once at that moment. The integration branch forks from it and
the review diff is taken against it, so switching or advancing the user's branch
mid-run does not retarget the run.

**Isolation run** — one Execute-Plan click or one manual task run's worth of
isolation: the `IsolationRun` record holding the run id, base ref, integration
branch name and each task's branch, worktree and status. It is plain JSON so it
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
workspace path) loses its worktrees but keeps its integration branch. A run closes
when its last attempt ends, however it ends — verdict, cancel, Mark complete or a
failed spawn — so the next one decides its own mode. The field belongs to one
plan: a fork must not copy it.

**Isolation handoff** — the end of an isolated run: the integration branch, the
base ref and the tasks that landed, broadcast as `isolation_handoff`. What
follows is the user's: `reviewRunDiff`, `mergeRun` (a normal `git merge` into the
checked-out branch, only ever on that explicit call), `cleanupRun` (worktrees and
task branches go, the integration branch stays) and `discardRun` (everything
goes, and the plan forgets the run; task statuses are left as they are). A
conflicted task leaves by a hand resolution plus Mark complete, a retry, or
`resolveConflictAsTask` — an added task that merges the branch by hand and
through whose landing the conflicted task lands, if it is still conflicted by
then (a retry in the meantime replaces the conflict with a new attempt).
*Avoid:* "result", "output branch" for the handoff — it is a branch to review,
not an outcome.
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
modified. The daemon parks the start until it hears `continueWithStash` or
`continueWithoutIsolation`, so the run's execution stream ends at the block and
the choice opens its own. Cancelling is `stopExecution`, not a dismissal: a
parked start swallows a re-run. The TUI asks with a three-way picker (Stash and
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
last (as in `coerceAssignments`). `Session.setTaskRunner` is the one owner:
async because it needs discovery, guarded before that call because listing
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

**Hand-added task (`Session.addTask`)** — async, and for the same reason
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
that simply dropped the task could never reach the tmux session again and the
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

**TaskEditValidator** (`validateTaskEdit(actor, tasks, taskId, changes,
catalog?)`) — the one checker behind both edit paths described above:
`applyTaskOps` calls it with `actor: 'planner'`, `Session.updateTask` calls it
with `actor: 'direct'`. Only the lock rule (no touching `in_progress` or
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
`classifyPlannerReply` already recognizes (see ADR-0012). The per-turn plan
block is short-fields-only by design (title, status, runner, model, mode,
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
leaves it answering from memory rather than from the repository.
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
global autonomous toggle. Three operations behind one interface:
`resolveDefaultMode` (tag-based default per toggle), `buildModeGuide` (the
mode list the planner's prompt shows, DEFAULT-tagged, opposite-toggle modes
hidden), and `resolveTaskMode` (the parser's validator — fixes invalid or
toggle-conflicting emissions, never overrides a valid `plan`). The policy is
planner-nudged, never runtime-overridden; what the plan says is what runs.
*Avoid:* "mode service", "mode manager" — and do not confuse with
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
runner emits the completion marker). A clean runner exit without the marker is
a failed verdict, never implicit completion.
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

**VerdictEngine** — the deep module owning the whole verification state
machine: the completion-marker lifecycle (detect in session output, track),
the checkpoint protocol, idle tracking, exit-code normalization, verdict
production, and the manual "Mark complete" override. The orchestrator hands
each spawned session to `watch(task, session)` and receives the verdict via
`onVerdict`; it never re-derives a verdict, though it drops one whose attempt
has already ended (see **Task attempt**). `markComplete`, `clear` (every user
interruption of a task: cancel, retry, mark complete, removal, mark not done),
and `reset` (stop/loadPlan) route through here too — one producer of every
verdict. It does not render or capture output: it keeps only a bounded raw
tail to scan for the marker (on the exit path too, never the runner's
ANSI-stripped `getOutput()`) and a small carry so a checkpoint split across
chunks still assembles; rendering is **Terminal render**'s and what a task
printed or answered is **TaskOutputSource**'s. Every callback carries the
generation its `watch` was given, and generations come from one counter that
`reset` never rewinds, so a terminal that outlives a stop or plan load (an open
VS Code terminal, a tmux exit seen on the next poll) cannot speak for the task's
next attempt. The old two-branch `verifyTask` function and the marker tracking
that used to live in `TaskOrchestrator` are its *implementation*, not its
interface; a fake `ITerminalSession` is the test seam.
*Avoid:* "the verifier", "TaskVerifier" (the old shallow pass-through, now
deleted) — use VerdictEngine.

**Terminal render** (`terminalRender.ts`) — the pure functions that turn raw
PTY bytes into what a user would see: `renderTerminalOutput` replays the
cursor/erase subset coding-agent TUIs use onto a small virtual screen,
`flattenTerminalOutput` strips escapes, box-drawing and whitespace for marker
scanning, and `renderCleanCapture` renders and cuts at the completion-marker
row, dropping the TUI chrome below it. No state, no I/O. It needs *raw* output:
the cursor escapes it replays are exactly what a runner's stripped buffer has
lost.

**TaskOutputSource** (`interfaces/TaskOutputSource.ts`, default
`BufferedTaskOutputSource`) — the one owner of a task attempt's output,
injected into TaskOrchestrator (through `SessionDeps.taskOutput` when a Session
builds it, which is how no test reads the real home directory). It keeps one bounded raw buffer per attempt,
fed from the attempt's session, and answers two questions: `finalText` — the
durable summary, taken from the agent's own transcript when one matches and
from the clean **Terminal render** otherwise — and `liveTail` — the last lines
of what a task printed, rendered clean, with an absolute `nextOffset` to read
only what follows (`TaskOrchestrator.getLiveOutput`). Transcripts come through
an injected **TranscriptReader** (`HomeTranscriptReader`, home directory
injectable) that binds a transcript to a task by content: the startedAt cutoff
only narrows the candidates, and the transcript must carry the task's
completion marker UUID, which its prompt contains. Directory and recency alone
hand task A task B's answer when parallel attempts share a cwd — and for Claude
Code the directory is not even unique: past 200 characters it keeps a prefix of
the munged cwd plus a hash, so every directory with that prefix is a candidate. The binding holds
only while no other task's prompt carries that id, which is why a dependent's
prompt quotes its predecessor's output with the marker id dropped
(`defuseMarkers` in `promptAugment.ts`).
*Avoid:* "the output buffer", "transcript capture" as the owner — the runners'
`getOutput()` buffers are transport detail, and the transcript is one input.

**Check** — one deterministic signal inside a verdict. The VerdictEngine
requires `completion_marker` and records `exit_code` as supporting diagnostic
evidence. `model_review`, `workspace_changes`, and `verify_command` were
deliberately removed (see `docs/adr/`): they produced false failures on non-file
tasks and conflated evidence with opinion. Verification is evidence-based, not
opinion-based; the model is never a tie-breaker because it is never consulted.

**Completion marker** — the `task.completionMarker` UUID the orchestrator appends
to every agent prompt as `<<<ORDEWELL_DONE_<uuid>>>>`. The **VerdictEngine** owns
the marker lifecycle: it detects the marker in session output (via `watch`),
and produces a `pass` verdict immediately with `exit_code` bypassed
(marker-seen), while leaving an interactive terminal open. Cursor-positioned
TUI output is rendered into a small virtual screen (**Terminal render**) so
split OpenCode repaints are scanned as the token visible to the user. If the marker never appears and
the process exits — even with code 0 — the verdict fails and dependent tasks
stay blocked. A stuck task (no marker, no exit) is advanced manually via "Mark
complete", which calls `VerdictEngine.markComplete` for a `pass` verdict.

**Testing strategy** — *removed.* Verification is completion-marker based;
the planner no longer assigns a testing strategy per task. The `user_verify`
strategy is gone — a human who must confirm is modeled directly as a
`type: 'user'` task, not as an AI task awaiting verdict promotion.

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
(ADR-0006, update of 2026-09-24).
*Avoid:* "web UI" — there is none; the web package is the daemon.

**TUI** — `ordewell tui`, the full-screen terminal surface (ADR-0006). Its core
is pure: `reduce(state, action)` returns `{ state, effects }` and `render(state)`
returns exactly one string per terminal row, so commands and layout are asserted
without a daemon or a tty. Only `terminal.ts` touches the real terminal.

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
under the bound. `planScroll` is an **absolute** offset with `null` meaning
"follow the selection" — as a delta on top of the auto-anchor it could never
scroll *above* the selected task.
*Avoid:* estimating rows-per-task, or clamping a scroll offset only at paint time.

**Effect** (TUI) — a description of work the TUI wants done (`setModel`,
`taskAction`, `loadSessions`), returned by the reducer and executed by
`effects.ts` against `ApiClient`. Results come back as **actions**. *Avoid:*
calling these "commands" — a **slash command** is what the user types; the
effects it produces are a separate layer.

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
CLI on this OS", asked by every surface that starts one: the VS Code terminal,
the headless runner, each harness-planner adapter, Codex's app-server discovery.
`planDirectLaunch` serves `spawn` callers; `planShellLaunch` serves surfaces that
hand an executable to a terminal. Both are **identity on POSIX** — `execvp`
already searches PATH, so resolving there would only be a new way for a working
install to break. The Windows branch resolves against PATH × PATHEXT across three
routes, best first: a native `.exe` spawned directly, a `.cmd` shim through
`cmd.exe /d /s /c` with verbatim arguments, a `.ps1` shim through
`powershell.exe -File`. See ADR-0010.
*Avoid:* calling `spawn('claude', …)` directly — that is ENOENT on Windows, where
CreateProcess performs no PATHEXT lookup and an npm-installed agent is
`claude.cmd`.
*Avoid:* handing `cmd /s /c` a bare command line. It strips the first quote on
the line and the last one, so a shim under `C:\Program Files\…` loses its opening
quote and the final argument loses its closing one. The outer pair `cmdArgs` adds
is what cmd removes.
*Avoid:* reordering the routes by capacity. They are ordered by availability, so
a `.ps1` beside an overflowing `.cmd` still raises `CommandLineTooLongError` —
a large prompt is where `-File` fidelity is least worth betting on, and a held
task beats a mangled one.
*Avoid:* filtering `.ps1` against PATHEXT. Windows' default PATHEXT omits it
because PowerShell resolves scripts itself, so the filter would disable the tier
on exactly the machines it exists for.

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

**Dialect** (`commandPolicy.Dialect`) — what the interpreter that will run a
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
POSIX keeps SIGTERM → SIGKILL. Windows has no signals and the direct child may be
a cmd.exe shim rather than the agent, so `taskkill /T` walks the tree; without it
"stop" terminated the shim and left the agent running, still holding the
workspace and the subscription.
*Avoid:* `proc.kill('SIGTERM')` at a dispose site — or a bare `proc.kill()`,
which was the last one left, in `ModelDiscovery`'s Codex app-server probe.

**Platform support** — the VS Code extension and the web surface run on Linux,
macOS, and native Windows. The **TUI does not run on Windows**: it is tmux-backed
(ADR-0007) and `hasTmux` feature-detects rather than assuming, so WSL is the
answer there. Three things about Windows are explicitly unverified rather than
claimed — Codex's read-only sandbox enforcement, `%VAR%` expansion on the
cmd.exe shim route, and argument fidelity on the PowerShell shim route. See
ADR-0010.
