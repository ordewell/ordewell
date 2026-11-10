---
status: accepted
amends: ["0009", "0026"]
---

# 0066 — OpenCode planners get Ordewell's own research agent

*Pending:* the research agent is checked by unit tests and a fake provider,
not a live run, until `node bench/live/opencode-research-agent-probe.mjs`
passes against a real OpenCode 2.x planner: every attempt to make the agent
act refused, a call of several minutes returning within the turn, three at
once.

## Problem

A harness planner's own subagents serve orientation: breadth the planner
needs this turn and no later task acts on
([ADR-0009](../planner/0009-coding-agents-as-planners.md) T8). Claude Code has
its `Agent` tool and Codex its native subagents. OpenCode's `task` and
`subagent` tools start an agent with whatever permission that agent has, so
the planner envelope
([ADR-0026](0026-one-envelope-for-every-planner.md)) denies them. That left
the OpenCode planner with no in-turn agent: breadth that needs no task became
a research task.

The first answer was a scout: one read-only agent Ordewell defined, which an
OpenCode 2.x planner's `subagent` tool alone could start, behind a variable
and a check of the rules the server resolved for it. Its live probe failed.
On OpenCode 2.2.5 the scout called Ordewell's MCP tools (`run_command`, `fetch`, `web_search`, `list_runners`),
OpenCode's `opencode_*` tools and `skill`. What an agent there can call is
the server's to decide, and its resolved rules did not say what it would do.

## Decision

**An OpenCode planner gets Ordewell's own read-only research agent as the MCP
tool `spawn_research_agent`, on the model the workspace names in
`ORDEWELL_RESEARCH_AGENT_MODEL`; OpenCode's own agents stay denied.**

The agent is the API planner's research subagent
([ADR-0005](../planner/0005-parallel-research-subagents.md)), run by Ordewell
on an API provider, not by the harness. The planner's token lists the tool
(`PlannerTokenScope.research`), and OpenCode's permission allows it by exact
name, as it does Ordewell's other tools. Claude Code keeps its `Agent` tool,
Codex its native subagents, and an ACP planner has none.

## Key properties

- **One variable, per workspace (R1).**
  `ORDEWELL_RESEARCH_AGENT_MODEL=<provider>:<model>`, such as
  `openrouter:deepseek/deepseek-v4.1-flash`, read from the planner's
  environment over its workspace's `.ordewell/env`
  ([ADR-0016](../platform/0016-per-workspace-environment.md)). It splits at
  the first colon, so a model id may hold one. The provider is one Ordewell
  knows, and the agent uses that provider's existing key and base-URL
  variables; there is no key of its own.
- **Absent changes nothing (R2).** With the variable unset or blank, the
  planner's token, tools, permission and prompt are byte for byte what they
  were, and nothing is said.
- **Unavailable says why (R3).** A variable that cannot serve an agent leaves
  the tool out as R2 does, and the person sees one warning naming the reason:
  a malformed value, an unknown provider, a provider without its key, or
  Gemini, whose own API is not the OpenAI-compatible chat the agent runs on.
  The planner's prompt then says, as it does with no variable, that research
  tasks are how it delegates.
- **Confined reads only (R4).** The agent has `CONFINED_RESEARCH_TOOLS`: the
  workspace read tools, through the planner's own `IFileSystem` at the
  workspace root. No shell, sealed or not, no web, no spawn, no MCP tool and
  nothing that asks anyone, so it reaches nothing the planner's own read tools
  do not.
- **Inside the turn, three at once (R5).** A call while no turn is open is
  refused, since nothing it found could reach anyone. At most
  `SUBAGENT_LIMITS.maxConcurrent` agents run at once across the planner's
  calls, held by one bound over every call, and later ones wait for a slot or
  the call's cancellation.
- **Accounted as a subagent (R6).** Its usage is summed into the planner's
  turn, and its steps reach the timeline under its subagent id, as a harness
  subagent's do.
- **A subplanner without research gets none (R7).** A subplanner whose
  mandate withholds research has no agent, as other harnesses have none
  ([ADR-0056](../supervision/0056-a-mandate-narrows-down-the-tree.md)).

## Testing decisions

The variable's reading is a pure function, `researchAgentSetting`, tested on
plain environments. The composition root's chat is tested against a local
HTTP server that speaks a provider's streamed chat completions, asserting the
key, model and tool list it receives. The service is tested through
`CliAgentAiService` with a fake adapter: the absent case is pinned against a
service built without the dependency, starts, token scopes and handlers
alike. The live probe is the only test that runs OpenCode, under a
throwaway home.

## Considered options

- **OpenCode's own `subagent` tool, admitting Ordewell's scout alone** (the
  design on 2026-11-10). Rejected: its live probe on OpenCode 2.2.5 found the
  scout calling MCP, `opencode_*` and `skill` tools Ordewell meant it never
  to have. Its confinement held only as far as the server applied rules
  Ordewell can write but not enforce.
- **A nested harness session as the agent.** Rejected for the same reason: an
  agent the harness runs has the harness's tools, denied only by rules the
  harness merges, and Ordewell's view of its steps is whatever the harness
  reports.
- **Leave every OpenCode agent denied.** Kept where the workspace names no
  model: research tasks delegate there. Rejected as the only answer, since
  orientation then costs a task.

## Consequences

- The agent bills its provider's key, separately from the planner's login.
- Its confinement has the lexical symlink gap the API planner's subagents
  have (`pathScope`): a symlink inside the workspace that points outside it
  reads as inside.
- Each call holds one MCP tool call open while the agent works. The live
  probe checks that a long call returns within the turn without the client
  timing it out.

## History

- 2026-11-10 — accepted.
