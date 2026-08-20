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
existing `IAiService` seam.**

The plan contract does not move. `classifyPlannerReply`, `PlanRepair`,
`PlanValidator`, `ResearchProgress`, `ConversationTurn` and the four surfaces
are already provider-agnostic; only the thing that turns *a user message* into
*assistant text plus tool activity* is new. `CliAgentAiService implements
IAiService` sits beside `OpenAiService`/`GeminiService`, delegating to a small
per-agent adapter:

| agent | transport (verified against the installed CLI) | read-only mode |
|---|---|---|
| Claude Code | `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` | `--permission-mode plan` + `--disallowedTools Edit,Write,…` |
| Codex | `app-server` stdio JSON-RPC: `initialize` → `thread/start` → `turn/start` | `sandbox: read-only`, `approvalPolicy: never` |
| OpenCode | `serve` (headless HTTP) + `/event` SSE | `agent: plan` |

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
  no role on the frame to filter by. Prose is therefore taken from the settled
  POST response (whose `info.id` names the assistant message) and the event
  stream is used for tool activity only. Letting the echo through put the
  user's goal in the planner's reply — and a goal quoting JSON would then have
  been parsed as the plan.

Exploration is the harness's job, not Ordewell's. `BaseAiService` is deliberately
**not** the parent class here: its entire body is Ordewell executing tools on the
model's behalf, which is precisely what a coding agent replaces.

## Key properties

- **The planner cannot mutate the workspace (T1).** Every adapter spawns in its
  agent's read-only mode, and any permission request that still arrives is
  auto-denied and surfaced as a `refused` step. ADR-0008's envelope does not
  apply — `commandPolicy`, `BaseFileSystem` confinement and the `IApproval` seam
  are all bypassed, because the agent brings its own tools and its own approval
  machinery. What survives is the *invariant*, not the mechanism: mutation
  belongs to the runners, and an absent answer is a denial. Enforced by the mode
  flag at spawn, not by prompt instruction.
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
- **The plan arrives as text, through the existing parser (T2).** The final
  assistant message carries the `{"tasks":[…]}` object; last-candidate
  extraction and the two-attempt repair loop handle it exactly as they do for a
  budget model on OpenRouter. Nothing is written to disk by the agent, which is
  what lets T1 hold — a file handoff would require granting workspace writes to
  the one component the architecture says must never have them.
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
  `developerInstructions` for Codex, `system` for OpenCode. Codex's
  `baseInstructions` replaces its base prompt, which takes its description of
  its own tools with it — a planner that has forgotten it can read the workspace
  researches the goal with a web search.
- **The mode toggles keep working, unmodified (T6).** `PlanPrompts` gains a
  harness variant that suppresses the tool-envelope and budget-countdown
  sections while keeping the plan schema, runner/mode vocabulary, model catalog
  and conversational protocol byte-identical. The toggles *are* the skills; a
  forked prompt would mean every future toggle is written twice or silently
  works on one backend only.
- **The planner's own model is picked from the runner's catalog (T7).**
  `ModelDiscovery` already returns per-runner `DiscoveredModel[]` with variants
  — Claude's aliases and adaptive/low→max efforts, Codex's `model/list` with
  per-model `supportedReasoningEfforts`, OpenCode's `models`. The surfaces
  already render a model + variant picker. The cheap-planner thesis therefore
  survives on a subscription: plan with Haiku, execute with Opus.
- **Research subagents are inert on this backend (T8).** `spawn_research_agent`
  is a Ordewell-executed tool with no meaning when the agent owns its own
  subagent mechanism. It is hidden rather than silently ignored.
- **An unusable agent fails before the goal is typed (T9).** `RunnerInstallation`
  probes the binary and credentials; unusable agents appear greyed-out with the
  reason. A turn whose process dies surfaces the stderr tail as a visible chat
  error — never an empty planner bubble, per the repo's fail-safe contract.
  What the preflight cannot know, the agent says itself: a startup warning —
  Codex's `configWarning` — reaches the timeline instead of being dropped for
  arriving before the first turn. That warning is the difference between a
  visible problem and a planner that reads nothing and plans confidently anyway.
- **A planner that cannot run a command does not plan (T11).** Codex's Linux
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
- **All four surfaces get it for free (T10).** VS Code, web, CLI and TUI consume
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

- **ACP for every agent (M1).** AionUI's model: one Agent Client Protocol
  client, N agents. Rejected as the v1 transport. Only OpenCode ships an ACP
  server (`opencode acp`); Claude Code and Codex require third-party adapter
  packages spawned over npx, reintroducing exactly the install step this feature
  exists to remove, on a dependency chain we do not control. Kept as a *fourth
  adapter* behind the same interface, where it earns its keep on the long tail
  (Gemini CLI, Qwen, Cursor) rather than on the three agents Ordewell already
  ships manifests for.
- **One-shot respawn per turn (M2).** Spawn with `--resume`/`exec resume`/
  `--session` each message, exit after. Trivial lifecycle, nothing to leak.
  Rejected: 1–3s cold start on every message *including each corrective
  re-emit*, and three different resume semantics that can diverge from what
  Ordewell believes the history is.
- **Respawn with full transcript replay (M3).** Uniform across agents, and makes
  Ordewell's transcript unambiguously authoritative. Rejected: the agent re-reads
  the repository from scratch every turn, so a five-message conversation pays
  exploration five times — slow and expensive on the surface users touch most.
- **`.ordewell/plan.draft.json` file handoff (M4).** Robust against long plans
  and fence mangling. Rejected because it forces the planner out of read-only
  mode into a write-capable one to solve a problem the existing repair loop
  already handles. Available later as a fallback if truncation proves real, at
  the cost of T1.
- **Ordewell as an MCP server now (M5).** `submit_plan` / `apply_task_ops` /
  `ask_user` as tools, registered with all three CLIs — the plan arrives as
  validated structured input and "question or commit?" stops being a parsing
  problem. Genuinely the right end state, and deferred rather than rejected:
  there is no MCP code anywhere in the repo today, so it is a stdio JSON-RPC
  server plus per-CLI registration standing between the user and the first plan.
- **A separate `plannerBackend` setting (M6).** See above — better typing, worse
  product, more UI.
- **Implicit planner = the first selected runner (M7).** A single "plan with my
  coding agent" toggle, no picker. Rejected: it silently couples planner choice
  to runner choice, making "Claude plans, OpenCode executes" impossible — which
  is one of the more interesting things this backend enables.
- **Full permission bypass for speed (M8).** `--dangerously-skip-permissions` /
  `danger-full-access` / `--auto`. Rejected: a planning turn could then rewrite
  the repository with no plan, no verdict and no record, which is the exact
  failure mode the plan/execute split exists to prevent.
- **Runner-native skill files for the planner prompt (M9).** Ship
  `.claude/skills/ordewell-plan`, an OpenCode agent, a Codex profile. Rejected on
  a standing decision: Ordewell never ships or reads runner-native skill
  mechanisms, and the old `to-prd`/`to-issues`/`tdd` skill files were folded into
  these prompts and deleted precisely to keep one source.
- **Widening `ResearchToolType` to arbitrary strings (M10).** Most future-proof.
  Rejected for now: the closed union gives exhaustiveness checking in
  `researchStepSummary` and four surfaces' icon/label switches, and one new
  member with a label field buys the same honesty without turning every one of
  those into a runtime default branch.
- **Live CLI runs as the test suite (M11).** Tests only what ships. Rejected as
  the default: every turn costs subscription quota and tens of seconds, it
  cannot run in CI without credentials, and a rate-limited account becomes a red
  build that is not a real failure. Recorded JSONL fixtures driven through a
  faked process boundary carry the suite; one opt-in live smoke test per agent
  (`ORDEWELL_LIVE_AGENTS=…`) guards schema drift. The three corrections in the
  transport table above all came from running that check, which is the argument
  for keeping it.
