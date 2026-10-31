---
status: accepted
---

# 0009 — Coding agents as planners: the harness planner backend

*Pending:* [ADR-0055](../supervision/0055-a-delegated-task-is-a-child-plan-behind-the-runner-seam.md) — a subplanner is a harness planner that parks between turns, which this ADR rejects for the root; its token also serves `task_complete` and `checkpoint`.

## Problem

Every path into Ordewell's planner runs through an LLM vendor the user must sign
up for separately. `createAiService` branches on `aiProvider` across 26
vendor entries, and every one of them resolves an API key. Meanwhile the same
user already pays for Claude Code, Codex, or OpenCode — and Ordewell already
spawns those exact binaries as runners, with model discovery, mode resolution,
and manifest-driven invocation built out for each.

So the cheap half of the architecture is the half that demands a credential the
user may not have, while three credentials they *do* have sit unused one module
away. A first run currently reads: install Ordewell, install a coding agent CLI,
then go get a third-party API key before you can plan anything.

## Decision

**A coding agent may serve as the planner, as a second transport behind the
existing `IAiService` seam.** Its Ordewell MCP tools must attach before the
planning prompt is sent: check after spawn, respawn once, then fail on a second
attach failure (ADR-0025). Plan submission, edits and reads use the injected
tools (ADR-0022); API planners retain their JSON envelopes.

The plan contract does not move. `classifyPlannerReply`, `PlanRepair`,
`PlanValidator`, `ResearchProgress`, `ConversationTurn` and the three surfaces
are already provider-agnostic; only the thing that turns *a user message* into
*assistant text plus tool activity* is new. `CliAgentAiService implements
IAiService` sits beside `OpenAiService`/`GeminiService`, delegating to a small
per-agent adapter:

| agent | transport (verified against the installed CLI) | read-only mode |
|---|---|---|
| Claude Code | `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` | `--permission-mode default` + `--permission-prompt-tool stdio`, direct edit, shell and native plan-mode tools disallowed (ADR-0008, ADR-0026) |
| Codex | `app-server` stdio JSON-RPC: `initialize` → `thread/start` → `turn/start` | `sandbox: read-only`, `approvalPolicy: on-request` with only MCP tool approvals held for Ordewell (ADR-0026) |
| OpenCode | `serve` (headless HTTP) + SSE event stream — 1.x `/event`, 2.x `/api/event` | `agent: plan`, shell and subagent tools withheld, and Ordewell's permission policy for the server (ADR-0026) |

Three details in that table were corrected during implementation, against the
binaries themselves rather than against memory:

- **Codex's method names.** The protocol is `thread/start` + `turn/start` with
  `item/*` and `turn/*` notifications — not the `newConversation` /
  `sendUserMessage` / `codex/event` shape this ADR was first written against.
  `codex app-server generate-json-schema` emits the whole contract, and the
  adapter is written from it. Its `reasoning` items carry arrays of blocks, not
  strings.
- **Claude Code needs `--verbose`.** `--output-format stream-json` is rejected
  without it.
- **OpenCode replays the user's own message** into `/event` as text parts, with
  no role on the frame to filter by. The settled POST response (whose `info.id`
  names the assistant message) is authoritative; the event stream feeds display.
  The adapter tracks the assistant message ids the server advertises and streams
  only their text parts as `planner_text_delta` (with `plan_token` for
  envelopes); a part of any other message is the user's own words. Each
  message's reported `tokens` and `cost` feed the usage ledger (#47–#53).
- **OpenCode 2.x speaks a different API.** Its server answers every `/api` request
  without credentials with a 401, so a planner's server is started behind a
  per-process password like a task's. A session carries its agent, model and
  permission rules, a prompt is queued and returns at once, and a turn ends on a
  `session.execution.succeeded`, `failed` or `interrupted` frame, with
  `/api/session/active` behind the stream for a dropped frame. A prompt has no
  system field, so the planner prompt is a session instruction entry; the
  direct edit controls are the plan agent plus deny rules for `question` and
  `edit`; shell execution is withheld by Ordewell's permission policy, not by
  those (ADR-0026). The adapter
  takes a server for 2.x when `/api/info` names a version, and speaks the 1.x protocol otherwise.
  Letting the echo through put the user's goal in the planner's reply — and a
  goal quoting JSON would then have been parsed as the plan.

Each adapter reads its agent's protocol into one `AgentEvent` union. Reply text
arrives in *runs*, each under the runner's own id for it: a Claude Code text
block as `<message id>:<block index>`, a Codex `agentMessage` item by its id, an
OpenCode text part by its id (on 2.x `<message id>:<ordinal>`, the ordinal
counting the message's text parts alone). A run's `assistant_text_delta`s and its
complete `assistant_text` carry the same `runId`, and the complete copy replaces
the deltas where the run began, so text that began before a tool call stays
above it however late its copy arrives; a read-back of what the stream missed
reuses the id of the run it recovers. No run carries the paragraph break between
it and the one before: the service joins a turn's runs with one and streams each
under a segment of its own (`TurnReply`).

Exploration is the harness's job, not Ordewell's. `BaseAiService` is deliberately
**not** the parent class here: its entire body is Ordewell executing tools on the
model's behalf, which is precisely what a coding agent replaces.

## Key properties

- **Mutation belongs to task runners (T1).** A planner reads, searches and asks,
  and writes no repository file. The one effect it performs itself is a script
  task through `run_script`, which Ordewell runs with no model and the user
  consents to as written ([ADR-0035](../supervision/0035-effects-are-consented-and-recorded.md)).
  A harness's own edit tools are denied, its commands run through Ordewell's
  `run_command` inside ADR-0008's envelope, and the one harness shell that stays
  is Codex's, inside its read-only, network-less sandbox. Enforcement comes from
  fixed spawn controls and tool denials, not prompt instructions; native plan
  mode alone cannot supply the invariant.
  - Claude runs in `default` mode with its prompt tool on stdio, and its direct
    edit and shell tools and native plan-mode transitions denied. Codex runs
    with an OS read-only sandbox and `approvalPolicy: on-request`, and keeps its
    own shell inside that sandbox; where no sandbox can start, the shell is
    switched off and `run_command` is its only one
    ([ADR-0033](../planner-envelope/0033-codex-planner-without-its-sandbox.md)).
    OpenCode runs its plan agent under Ordewell's own permission policy, which
    denies every write and shell tool, with its shell and subagents withheld
    ([ADR-0026](../planner-envelope/0026-one-envelope-for-every-planner.md)).
  - A planner's commands run through Ordewell's `run_command`, inside
    ADR-0008's envelope, and every planner's own permission requests — a user's
    MCP tool, a fetch, a read outside the workspace — are held open and decided
    against `IApproval` rather than auto-denied. An absent answer is a denial.
  - The planner's execution tools (`run_plan`, `run_task`, `stop_task`,
    `stop_run`, `retry_task`, `message_task`, `answer_approval`,
    `answer_checkpoint`, `merge_all`, `skip_task`, `run_script`) are a further explicit exception
    ([ADR-0029](../supervision/0029-the-supervisor.md)). They change what runs,
    through one core command seam that checks the supervisor level and the
    plan's approval; they edit no file. All but `run_script` run nothing outside
    the envelope. `run_script` adds a script task to the plan and starts it,
    which runs the commands it was given outside the planner's sandbox, under
    the consent rule of ADR-0035; repository files still change only in the
    runners' worktrees.
  - Adapters also have a task mode, for the structured transport
    ([ADR-0018](../runners/0018-structured-runner-transport.md)), whose
    permission mode and effort come from the runner manifest; it is an explicit
    start switch the planner path never passes, and tests assert it.
  - Read-only mode covers what the agent *does*; it does not cover what the
    agent can *ask for*, and three of those turned out to hang a turn
    indefinitely rather than fail it. Each is answered, not ignored: OpenCode's
    `question` tool is withheld at the message (`tools: {question: false, …}`)
    and its `permission.asked` events are rejected over
    `/session/{id}/permissions/{id}`; Codex gets a definite reply to *every*
    server→client request — the declining payload where its result schema can
    express one, a JSON-RPC error where it cannot (a permission profile, a
    question for a user, a client-side tool call) — rather than to the three
    approval methods that happened to be known when the adapter was written. An
    agent that ends its turn on a refusal without speaking is reported by the
    refusal, not as an empty reply.
- **The plan arrives as text, through the existing parser (T2).** The final
  assistant message carries the `{"tasks":[…]}` object; last-candidate
  extraction and the two-attempt repair loop handle it exactly as they do for a
  budget model on OpenRouter. The plan needs no file handoff: granting a
  filesystem write to the planner would violate the no-mutation invariant.
- **One live process per planner session (T3).** Spawned at
  `startConversation`, fed each turn over stdio, disposed by `Session.reset()`.
  Follow-up messages and corrective re-emits reuse warm context rather than
  re-paying exploration; Stop is a signal to a process already held. Crash or
  surface reload falls back to resume-by-id.
- **Ordewell's transcript remains the source of truth (T4).** The agent's native
  session id is stored as a resumption *hint* only. If resume fails, a fresh
  agent session is seeded from `conversationHistory` — the same degradation
  `restoreChat` already performs. Session boundaries stay hard: a new session
  disposes the process and forgets the id.
- **Harness tool activity is honest in the timeline (T5).** `Read`/`Grep`/
  `Glob`/`Bash` map onto the existing `ResearchToolType` members and render
  unchanged. Everything else — `Edit`, `WebFetch`, `Task`, `TodoWrite`, whatever
  ships next — maps to one new `agent_tool` member carrying the real name in
  `toolLabel`. Nothing is relabelled as something it is not, which is the point
  ADR-0008 spent effort establishing.
  The planner prompt is *appended* to the agent's own instructions, never
  substituted for them: `--append-system-prompt` for Claude Code,
  `developerInstructions` for Codex, `system` for OpenCode 1.x (an instruction entry on 2.x). Codex's
  `baseInstructions` replaces its base prompt, which takes its description of
  its own tools with it — a planner that has forgotten it can read the workspace
  researches the goal with a web search.
- **Skills work unmodified (T6).** `PlanPrompts` gains a harness variant that
  suppresses the tool-envelope and budget-countdown sections while keeping the
  plan schema, runner/mode vocabulary, model catalog and conversational
  protocol byte-identical. A harness planner gets skills as every planner does
  ([ADR-0024](0024-unified-skills.md)): `/name` beside the user's text, the
  model-invocable ones through `load_skill`, and task skills attached in the
  plan. A forked prompt would mean every future skill feature is written twice
  or silently works on one backend only.
- **The planner's own model is picked from the runner's catalog (T7).**
  `ModelDiscovery` already returns per-runner `DiscoveredModel[]` with variants
  — Claude's aliases and adaptive/low→max efforts, Codex's `model/list` with
  per-model `supportedReasoningEfforts`, OpenCode's `models`. The surfaces
  already render a model + variant picker. The cheap-planner thesis therefore
  survives on a subscription: plan with Haiku, execute with Opus.
- **Research subagents are inert on this backend (T8).** `spawn_research_agent`
  is a Ordewell-executed tool with no meaning when the agent owns its own
  subagent mechanism. It is hidden rather than silently ignored. A harness's
  own subagents are awaited before the turn ends (`MAX_AGENT_WAITS`), and
  serve orientation: what the planner needs this turn and no later task acts
  on. Evidence, what needs a worktree, another runner or model, the user's
  sight, or a later task to act on, is a task of its own: a research task
  whose report returns to the planner where the planner must decide on it, a
  plain read-only task its dependent reads otherwise ([ADR-0037](../supervision/0037-research-tasks-wake-the-planner.md), R1, R5).
- **An unusable agent fails before the goal is typed (T9).** `RunnerInstallation`
  probes the binary and, beside it, the runner's own login verdict; a planner
  picker offers only the agents that are usable, and states what to install when
  none is. A signed-out agent is usable: it stays listed, flagged, and a planner
  turn is refused before it is sent with the way to sign in
  ([ADR-0052](../routing/0052-a-signed-out-coding-agent-is-flagged-and-signs-in-from-the-chat.md)).
  A login names one installed agent and never moves the planner, and an agent's
  own login failure is still reworded where a stale verdict slips through. A turn whose process dies surfaces the stderr tail as a visible chat
  error — never an empty planner bubble, per the repo's fail-safe contract.
  What the preflight cannot know, the agent says itself: a startup warning —
  Codex's `configWarning` — reaches the timeline instead of being dropped for
  arriving before the first turn. That warning is the difference between a
  visible problem and a planner that reads nothing and plans confidently anyway.
- **A planner whose shell cannot start reads through Ordewell's (T10).** Codex's Linux
  sandbox is bubblewrap, which needs unprivileged user namespaces; Ubuntu 24.04
  restricts those through AppArmor and ships no `bwrap` profile, so every
  command dies with `bwrap: loopback: Failed RTM_NEWADDR` and Codex answers from
  memory and web search instead (openai/codex#15496, #16334). `codexSandbox.ts`
  asks the binary — one ~40ms `codex sandbox … /bin/true` — rather than
  inferring from `/proc`. A recognized user-namespace failure opts the thread
  into `use_legacy_landlock`, the pre-bubblewrap backend, which needs no
  namespace and still denies writes; an unrecognized failure changes nothing,
  because that backend is deprecated upstream and a healthy Codex must not be
  moved onto it on weak evidence. With both backends failing, the planner
  starts with Codex's own shell switched off and reads through `run_command`
  alone, and a note names the two documented fixes
  ([ADR-0033](../planner-envelope/0033-codex-planner-without-its-sandbox.md)). A Codex that
  explores nothing is still the silent success this repo forbids, so a
  planner without Ordewell's tools is refused at handshake.
- **All three surfaces get it for free (T11).** VS Code, the CLI and the TUI consume
  `SessionMessage` and `ResearchProgress`; the harness planner emits the same
  events from the same `Session`. No surface learns that a coding agent is on
  the other end.

## A runner in the provider axis

The glossary is explicit that **provider** means the LLM vendor and **runner**
means the coding-agent CLI, and this decision deliberately puts runners into
the planner setting beside the vendors. The alternative — a separate
`plannerBackend` setting — types better and reads worse: it splits one user
question ("what plans for me?") across two settings and needs new UI in four
surfaces instead of new entries in a dropdown that already exists.

The setting holds a `PlannerBackendId`: an `AiProvider`, the closed union of
API vendors, or a runner id. The runner half is open because every built-in
runner with a connector can plan — its manifest and its `CONNECTORS` entry are
the whole of declaring it — so the harness planners, their labels and the
planner lists are derived from those two, and an id is checked against them at
runtime rather than by the compiler. One `isCliProvider()` guard covers key
resolution, provider routing and the model picker (which reads
`ModelDiscovery` instead of `ModelCatalog`); `isApiProvider()` narrows an id to
a vendor wherever a key or base URL is read.

The term for the resulting arrangement is **harness planner**: a runner
serving as the planner. Not "CLI provider" — the thing on the other end is not
a vendor.

## Cost, stated plainly

A harness planning turn is slower and more expensive in tokens than a budget
model doing the same research over HTTP. This backend does not make planning
cheap; it makes planning *free at the margin* for someone whose subscription is
already paid for. Both halves of "planning is a different workload from
execution" still hold — different model, different mode, different budget — but
the cost asymmetry that motivated the split is smaller here, and users choosing
this backend should understand they are trading speed for not holding a key.

## Considered options

- **ACP for every agent immediately.** Deferred: the built-in agents already
  have native connectors without extra adapter installations.
  [ADR-0025](../runners/0025-structured-only-runners.md) records a generic ACP connector
  as the expected successor for third-party harnesses, with the protocol gaps
  that must be addressed before adoption.
- **One-shot respawn per turn.** Spawn with `--resume`/`exec resume`/
  `--session` each message, exit after. Trivial lifecycle, nothing to leak.
  Rejected: 1–3s cold start on every message *including each corrective
  re-emit*, and three different resume semantics that can diverge from what
  Ordewell believes the history is.
- **Respawn with full transcript replay.** Uniform across agents, and makes
  Ordewell's transcript unambiguously authoritative. Rejected: the agent re-reads
  the repository from scratch every turn, so a five-message conversation pays
  exploration five times — slow and expensive on the surface users touch most.
- **`.ordewell/plan.draft.json` file handoff.** Robust against long plans
  and fence mangling. Rejected because it forces the planner out of read-only
  mode into a write-capable one to solve a problem the existing repair loop
  already handles. Available later as a fallback if truncation proves real, at
  the cost of the no-mutation guarantee.
- **Plan submission only through reply parsing.** Previously adopted while
  MCP injection was absent; rejected for coding-agent planners because the
  server now supplies validated submission and read tools (ADR-0022). API
  planners retain envelopes. Coding-agent planners must attach their tools,
  with one respawn before failing (ADR-0025).
- **A separate `plannerBackend` setting.** See above — better typing, worse
  product, more UI.
- **The harness planners as members of `AiProvider`.** Previously adopted, so
  the compiler checked every switch over the union. Dropped because each new
  runner then had to be added by hand to the union, the label tables and the
  planner list, and a missed one failed quietly by leaving the runner off a
  surface (#72).
- **Implicit planner = the first selected runner.** A single "plan with my
  coding agent" toggle, no picker. Rejected: it silently couples planner choice
  to runner choice, making "Claude plans, OpenCode executes" impossible — which
  is one of the more interesting things this backend enables.
- **Full permission bypass for speed.** `--dangerously-skip-permissions` /
  `danger-full-access` / `--auto`. Rejected: a planning turn could then rewrite
  the repository with no plan, no verdict and no record, which is the exact
  failure mode the plan/execute split exists to prevent.
- **Runner-native skill files for the planner prompt.** Ship
  `.claude/skills/ordewell-plan`, an OpenCode agent, a Codex profile. Rejected on
  a standing decision: Ordewell never ships or reads runner-native skill
  mechanisms, and the old `to-prd`/`to-issues`/`tdd` skill files were folded into
  these prompts and deleted precisely to keep one source.
- **Widening `ResearchToolType` to arbitrary strings.** Most future-proof.
  Rejected for now: the closed union gives exhaustiveness checking in
  `researchStepSummary` and three surfaces' icon/label switches, and one new
  member with a label field buys the same honesty without turning every one of
  those into a runtime default branch.
- **The paragraph break inside the reply text.** Previously adopted: each
  adapter opened a later run of a turn with `\n\n` in the text it sent, so
  runs concatenated into paragraphs. Dropped because every adapter, and every
  consumer, then worked out by its own rule which run a piece of text belonged
  to, and the rules disagreed: Codex's deltas carried no break while its
  complete message did, so a task's plain text wrote the message twice; a run
  whose copy arrived after a tool call joined the reply a second time; and an
  OpenCode read-back under a key of its own showed its text twice.
- **OpenCode's event stream for tool activity only.** It was, while the echo
  was filtered by dropping all prose from the stream. Rejected: filtering the
  user's message by message id keeps the echo out and the reply streaming.
- **Live CLI runs as the test suite (M11).** Tests only what ships. Rejected as
  the default: every turn costs subscription quota and tens of seconds, it
  cannot run in CI without credentials, and a rate-limited account becomes a red
  build that is not a real failure. Recorded JSONL fixtures driven through a
  faked process boundary carry the suite; one opt-in live smoke test per agent
  (`ORDEWELL_LIVE_AGENTS=…`) guards schema drift. The three corrections in the
  transport table above all came from running that check, which is the argument
  for keeping it.
- **Unusable harness planners stay listed, greyed-out with their reason.**
  Previously adopted, so a missing CLI is explained where the planner is picked.
  Dropped for the pickers: on an interactive surface a struck-through row beside
  live ones reads as clutter and invites a click whose only outcome is why it
  did nothing. A picker now offers only the agents that can plan and states what
  to install when none can — the send-time preflight still names every agent, so
  the missing-CLI explanation survives where it bites. A signed-out agent can
  plan once signed in, so it stays listed, flagged, with the login action beside
  it rather than vanishing
  ([ADR-0052](../routing/0052-a-signed-out-coding-agent-is-flagged-and-signs-in-from-the-chat.md)).
  Filtering inside `plannerBackendEntries` was rejected too: the webview names the
  agents in its install hint from that full list, which filtering there would
  erase.

## History

- 2026-07-31 — accepted.
- 2026-09-27 — OpenCode streams the assistant's reply and reports usage, with the user's echo filtered by message id.
- 2026-09-29 — adapters gain a task mode for the structured transport (ADR-0018); the planner path stays read-only.
- 2026-10-04 — OpenCode 2.x supported beside 1.x.
- 2026-10-09 — harness planners get skills through the unified loader (ADR-0024): `/name`, `load_skill`, task skills.
- 2026-10-09 — Claude planners use `dontAsk` with edit, shell and native plan-mode tools denied; OpenCode shell limitations are made explicit (ADR-0008).
- 2026-10-09 — aligned with [ADR-0025](../runners/0025-structured-only-runners.md).
- 2026-10-10 — harness planners research inside ADR-0008's envelope (ADR-0026).
- 2026-10-11 — execution tools through the command seam, a further exception to read-only planners ([ADR-0029](../supervision/0029-the-supervisor.md)).
- 2026-10-12 — the terminal UI's `/planner` saves each step on enter, with the later steps at their pre-selection, instead of applying nothing until the last step; esc closes and keeps what was saved. Users wanted to see a choice take effect and leave with esc. A harness is never saved without a model to go with it.
- 2026-10-13 — a Codex planner on a host where no sandbox starts plans with its own shell off, through `run_command`, instead of being refused ([ADR-0033](../planner-envelope/0033-codex-planner-without-its-sandbox.md)).
- 2026-10-14 — `skip_task` joins the execution tools ([ADR-0029](../supervision/0029-the-supervisor.md)).
- 2026-10-14 — harness planners are derived from the runner manifests and connectors; `AiProvider` names vendors only and the setting is a `PlannerBackendId` (#72).
- 2026-10-16 — with no planner chosen and no vendor key, the first usable installed coding agent, in the planner list's order, plans; it is derived on each start and not saved, so a key added later or a `/planner` pick still wins.
- 2026-10-16 — that derived agent plans with an inherited model only when it is one of its stable aliases, else with its remembered model and effort; inherited settings are never saved as picks.
- 2026-10-16 — a model pick belongs to the planner it was made for: once routing moves off that planner (its key removed), the model stays configured for its return but is not the detected agent's. A vendor that needs a key is detected by its key, never by a base URL alone (openai_compatible, which needs none, still is by its endpoint), and a key held outside the environment selects its own vendor.
- 2026-10-16 — naming a coding agent (AI_PROVIDER, `aiProvider`, `/planner`) does not choose the vendor model left configured: one that is plainly a vendor's, or for OpenCode a slug its discovered catalog does not list, gives way to the agent's remembered model and effort, else its default. A pick for one planner is not another's, vendors included.
- 2026-10-17 — the detected agent is derived again on a runner-list refresh, so a coding agent installed while a host runs becomes the planner without a restart ([ADR-0039](../routing/0038-runner-install-verdicts-expire.md#the-detected-planner-is-derived-again-on-a-refresh-adr-0039)).
- 2026-10-17 — a planner picker offers only usable coding agents and configured vendors, with a one-line hint when none is, instead of listing unusable agents greyed-out; a signed-out agent is usable and stays listed, flagged with its login.
- 2026-10-17 — a planner switch is shown at once and no longer waits on the target's model discovery; a failed discovery is remembered briefly instead of re-run on every switch ([ADR-0040](../routing/0040-a-slow-model-discovery-never-gates-the-planner-pick.md)).
- 2026-10-18 — reply text arrives in runs under the runner's own ids, with no paragraph break inside the text; consumers join runs themselves.
- 2026-10-21 — the planner performs an exact effect itself as a script task through `run_script`, a further execution tool; T1 now says repository files are the runners' alone ([ADR-0035](../supervision/0035-effects-are-consented-and-recorded.md)).

- 2026-10-21 — research that outlives a turn uses research tasks; harness subagents stay awaited inside the turn (ADR-0037 R5).
- 2026-10-23 — harness subagents serve orientation and research tasks evidence, decided by what the result is rather than how long it takes (ADR-0037 R5).
- 2026-10-24 — `answer_checkpoint` joins the execution tools, for the supervisor at Act ([ADR-0029](../supervision/0029-the-supervisor.md)).
- 2026-10-24 — the surface list corrected: there is no web surface, so three (VS Code, the CLI and the TUI) consume the planner's events (ADR-0006).
- 2026-10-24 — evidence a later task acts on is a plain read-only task it depends on; only evidence the planner decides on is a research task (ADR-0037 R5).
- 2026-10-27 — a signed-out harness planner is flagged in the welcome line, the picker and the planner pills; its turn is refused before it is sent with the way to sign in, and `/login` or the chat's Log in runs the runner's own login ([ADR-0052](../routing/0052-a-signed-out-coding-agent-is-flagged-and-signs-in-from-the-chat.md)).
