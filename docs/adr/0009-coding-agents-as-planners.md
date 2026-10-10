# 0009 — Coding agents as planners: the harness planner backend

**Status:** accepted

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
`PlanValidator`, `ResearchProgress`, `ConversationTurn` and the four surfaces
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
  `edit`; these do not enforce read-only shell execution (ADR-0008). The adapter
  takes a server for 2.x when `/api/info` names a version, and speaks the 1.x protocol otherwise.
  Letting the echo through put the user's goal in the planner's reply — and a
  goal quoting JSON would then have been parsed as the plan.

Exploration is the harness's job, not Ordewell's. `BaseAiService` is deliberately
**not** the parent class here: its entire body is Ordewell executing tools on the
model's behalf, which is precisely what a coding agent replaces.

## Key properties

- **Mutation belongs to task runners.** Claude planners deny direct edit and
  shell tools and native plan-mode transitions; Codex planners
  use an OS read-only sandbox with approvals disabled. OpenCode uses its plan
  agent and edit-tool denials, which leave a shell enforcement gap (ADR-0008).
  Adapters also have a task mode, for the structured transport
  ([ADR-0018](0018-structured-runner-transport.md)),
  whose permission mode and effort come from the runner manifest; it is an
  explicit start switch the planner path never passes, and tests assert it.
  *Amended by [ADR-0026](0026-one-envelope-for-every-planner.md):* a planner's
  commands run through Ordewell's `run_command`, inside ADR-0008's envelope,
  and every planner's own permission requests — a user's MCP tool, a fetch, a
  read outside the workspace — are held open and decided against `IApproval`
  rather than auto-denied. Claude runs in `default` mode with its prompt tool
  on stdio, Codex with `approvalPolicy: on-request`, and OpenCode under
  Ordewell's own permission policy with its shell and subagents withheld. The
  invariant holds: mutation belongs to the runners, and an absent answer is a
  denial. Enforcement comes
  from fixed spawn controls and tool denials, not prompt instructions; native
  plan mode alone cannot supply the invariant.
  Read-only mode covers what the agent *does*; it does not cover what the agent
  can *ask for*, and three of those turned out to hang a turn indefinitely
  rather than fail it. Each is answered, not ignored: OpenCode's `question` tool
  is withheld at the message (`tools: {question: false, …}`) and its
  `permission.asked` events are rejected over `/session/{id}/permissions/{id}`;
  Codex gets a definite reply to *every* server→client request — the declining
  payload where its result schema can express one, a JSON-RPC error where it
  cannot (a permission profile, a question for a user, a client-side tool call)
  — rather than to the three approval methods that happened to be known when
  the adapter was written. An agent that ends its turn on a refusal without
  speaking is reported by the refusal, not as an empty reply.
- **The plan arrives as text, through the existing parser.** The final
  assistant message carries the `{"tasks":[…]}` object; last-candidate
  extraction and the two-attempt repair loop handle it exactly as they do for a
  budget model on OpenRouter. The plan needs no file handoff: granting a
  filesystem write to the planner would violate the no-mutation invariant.
- **One live process per planner session.** Spawned at
  `startConversation`, fed each turn over stdio, disposed by `Session.reset()`.
  Follow-up messages and corrective re-emits reuse warm context rather than
  re-paying exploration; Stop is a signal to a process already held. Crash or
  surface reload falls back to resume-by-id.
- **Ordewell's transcript remains the source of truth.** The agent's native
  session id is stored as a resumption *hint* only. If resume fails, a fresh
  agent session is seeded from `conversationHistory` — the same degradation
  `restoreChat` already performs. Session boundaries stay hard: a new session
  disposes the process and forgets the id.
- **Harness tool activity is honest in the timeline.** `Read`/`Grep`/
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
- **Skills work unmodified.** `PlanPrompts` gains a harness variant that
  suppresses the tool-envelope and budget-countdown sections while keeping the
  plan schema, runner/mode vocabulary, model catalog and conversational
  protocol byte-identical. A harness planner gets skills as every planner does
  ([ADR-0024](0024-unified-skills.md)): `/name` beside the user's text, the
  model-invocable ones through `load_skill`, and task skills attached in the
  plan. A forked prompt would mean every future skill feature is written twice
  or silently works on one backend only.
- **The planner's own model is picked from the runner's catalog.**
  `ModelDiscovery` already returns per-runner `DiscoveredModel[]` with variants
  — Claude's aliases and adaptive/low→max efforts, Codex's `model/list` with
  per-model `supportedReasoningEfforts`, OpenCode's `models`. The surfaces
  already render a model + variant picker. The cheap-planner thesis therefore
  survives on a subscription: plan with Haiku, execute with Opus.
- **Research subagents are inert on this backend.** `spawn_research_agent`
  is a Ordewell-executed tool with no meaning when the agent owns its own
  subagent mechanism. It is hidden rather than silently ignored.
- **An unusable agent fails before the goal is typed.** `RunnerInstallation`
  probes the binary and credentials; unusable agents appear greyed-out with the
  reason. A turn whose process dies surfaces the stderr tail as a visible chat
  error — never an empty planner bubble, per the repo's fail-safe contract.
  What the preflight cannot know, the agent says itself: a startup warning —
  Codex's `configWarning` — reaches the timeline instead of being dropped for
  arriving before the first turn. That warning is the difference between a
  visible problem and a planner that reads nothing and plans confidently anyway.
- **A planner that cannot run a command does not plan.** Codex's Linux
  sandbox is bubblewrap, which needs unprivileged user namespaces; Ubuntu 24.04
  restricts those through AppArmor and ships no `bwrap` profile, so every
  command dies with `bwrap: loopback: Failed RTM_NEWADDR` and Codex answers from
  memory and web search instead (openai/codex#15496, #16334). `codexSandbox.ts`
  asks the binary — one ~40ms `codex sandbox … /bin/true` — rather than
  inferring from `/proc`. A recognized user-namespace failure opts the thread
  into `use_legacy_landlock`, the pre-bubblewrap backend, which needs no
  namespace and still denies writes; an unrecognized failure changes nothing,
  because that backend is deprecated upstream and a healthy Codex must not be
  moved onto it on weak evidence. Both backends failing is fatal at handshake,
  naming the two documented fixes: a Codex that explores nothing is the silent
  success this repo forbids, and it is worth more as a visible error than as a
  confident blind plan.
- **All four surfaces get it for free.** VS Code, web, CLI and TUI consume
  `SessionMessage` and `ResearchProgress`; the harness planner emits the same
  events from the same `Session`. No surface learns that a coding agent is on
  the other end.

## A runner in the provider axis

The glossary is explicit that **provider** means the LLM vendor and **runner**
means the coding-agent CLI, and this decision deliberately puts three runners
into `AiProvider`. The alternative — a separate `plannerBackend` axis — types
better and reads worse: it splits one user question ("what plans for me?")
across two settings and needs new UI in four surfaces instead of three new
entries in a dropdown that already exists.

The union stays exhaustive, so `PROVIDER_LABEL` and every switch over
`AiProvider` are updated by the compiler rather than at runtime. One
`isCliProvider()` guard covers key resolution, provider routing and the model
picker (which reads `ModelDiscovery` instead of `ModelCatalog`).

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
  [ADR-0025](0025-structured-only-runners.md) records a generic ACP connector
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
  `researchStepSummary` and four surfaces' icon/label switches, and one new
  member with a label field buys the same honesty without turning every one of
  those into a runtime default branch.
- **OpenCode's event stream for tool activity only.** It was, while the echo
  was filtered by dropping all prose from the stream. Rejected: filtering the
  user's message by message id keeps the echo out and the reply streaming.
- **Live CLI runs as the test suite.** Tests only what ships. Rejected as
  the default: every turn costs subscription quota and tens of seconds, it
  cannot run in CI without credentials, and a rate-limited account becomes a red
  build that is not a real failure. Recorded JSONL fixtures driven through a
  faked process boundary carry the suite; one opt-in live smoke test per agent
  (`ORDEWELL_LIVE_AGENTS=…`) guards schema drift. The three corrections in the
  transport table above all came from running that check, which is the argument
  for keeping it.

## History

- 2026-07-31 — accepted.
- 2026-09-27 — OpenCode streams the assistant's reply and reports usage, with the user's echo filtered by message id.
- 2026-09-29 — adapters gain a task mode for the structured transport (ADR-0018); the planner path stays read-only.
- 2026-10-04 — OpenCode 2.x supported beside 1.x.
- 2026-10-09 — harness planners get skills through the unified loader (ADR-0024): `/name`, `load_skill`, task skills.
- 2026-10-09 — Claude planners use `dontAsk` with edit, shell and native plan-mode tools denied; OpenCode shell limitations are made explicit (ADR-0008).
- 2026-10-09 — aligned with [ADR-0025](0025-structured-only-runners.md).
- 2026-10-10 — harness planners research inside ADR-0008's envelope (ADR-0026).
