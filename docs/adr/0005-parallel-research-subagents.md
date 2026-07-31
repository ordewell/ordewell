# 0005 — Parallel read-only research subagents for the planner

**Status:** accepted

The planner's research loop is strictly sequential — one tool round at a time in `BaseAiService`. The 2026-07-18 routing-pilot benchmark showed two consequences: planning latency is Ordewell's one losing wall-time metric on quick tasks, and a strong planner model is priced out because it personally reads the repo ($12.75/27 min for a Sonnet-class planner on a 900-file repo vs $0.03–0.10 for Flash). Issue #34.

We decided to add a `spawn_research_agent` tool the planner *may* call during research: each call launches one stateless read-only research agent (opencode's `agent` tool is the design reference — `reference_projects/opencode/internal/llm/agent/agent-tool.go`, design only, no code reuse). The agent runs its own bounded tool loop on the cheap subagent model, and only its final digest returns to the planner. The feature is gated by the `researchSubagents` settings toggle, **default off**.

## Key properties

- **One agent per call, threads followed as they emerge (opencode shape).** The issue's original sketch batched N briefs into one call. Rejected in favor of opencode's single-`prompt` shape: the planner can spawn an agent at any research round — including a second wave prompted by the first wave's digests — instead of committing to one up-front fan-out. Parallelism comes from the planner batching several spawn calls in one reply.
- **Concurrency lives in the service layer, bounded at 3.** `BaseAiService.executeToolCalls` runs all spawn calls of a round concurrently in chunks of `SUBAGENT_LIMITS.maxConcurrent` (3); extra calls wait for a slot rather than being refused. Non-spawn tools keep their sequential order.
- **Flag off ⇒ bit-for-bit today's behavior.** The tool spec lives outside `RESEARCH_TOOLS`; the default projections (`toOpenAiTools()`, `toGeminiToolDeclarations()`) are unchanged, so with the toggle off the tool is never declared and the prompt never mentions it. The benchmark harness pins the toggle alongside the other five (`arms.py` `MODE_KEYS`).
- **No new write surface, no recursion, no fetch.** Subagents get `subagentToolSpecs()` = the research toolset minus `fetch` (it can pause on user URL confirmation — a background agent must never block on a human) and minus the spawn tool itself. Inside the subagent loop, any tool call outside that allowlist is answered with a synthetic refusal — never dispatched — so the API history stays valid and nothing executes. `IFileSystem` itself has no write methods; `BaseFileSystem.bash` enforces the read-only command allowlist for both parent and subagents.
- **A subagent can never fail a plan.** `runResearchAgent` never throws: spawn errors, provider crashes, step-cap exhaustion, and aborts all degrade to a failed/partial tool result telling the planner to continue sequentially. Flag off, unsupported provider (Gemini, for now), and empty prompt all return steering text through the same path.
- **Cheap model always.** The subagent chat uses `config.researchSubagentModel` = `ORDEWELL_SUBAGENT_MODEL || orchestratorModel`. The planner model is the cheap class by design; the env override exists for the strong-planner scenario the benchmark motivated (strong orchestrator + Flash subagents).
- **Bounded everything.** `SUBAGENT_LIMITS`: 3 concurrent, 10 tool rounds per agent (with one synthetic wrap-up nudge, mirroring the parent loop), 20 k chars per tool result, 6 k chars per digest.
- **Module seam kept acyclic.** `ResearchSubagents.ts` imports `executeTool` and type-only `ResearchChat`; it never imports the services. The chat factory is injected (`BaseAiService.createSubagentChat()`, overridden by `OpenAiService`, null = unsupported), so spawn execution lives at the service layer, not in `executeTool`'s dispatcher.

## Considered options

- **N-briefs-per-call batching (issue sketch).** One call carries up to 3 briefs, fanned out internally — robust for budget models that rarely emit parallel tool calls. Rejected by user direction: it forces the planner to pre-plan the fan-out and cannot follow threads that emerge mid-research. The prompt instead explicitly teaches "put several spawn calls in one reply to run them concurrently".
- **Refusing spawn calls beyond the cap.** Rejected: chunked waiting is strictly friendlier and keeps the ≤3 bound without teaching the model that spawning can hard-fail.
- **Dispatch in `executeTool.ts`.** Rejected: `BaseAiService` imports `executeTool`; spawning needs a `ResearchChat`, which only services can build — dispatching there would cycle `BaseAiService → executeTool → BaseAiService`.
- **Gemini support now.** Deferred: `createSubagentChat()` returns null in the base class, so Gemini degrades gracefully (tool never declared; hallucinated calls get steering text). The seam is one override away when wanted.
- **Subagents inherit the planner conversation.** Rejected (opencode agrees): stateless agents with self-contained prompts keep the context window flat — the whole point is digests instead of raw exploration in the planner's history.
