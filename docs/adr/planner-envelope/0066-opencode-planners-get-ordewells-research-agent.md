---
status: accepted
amends: ["0009", "0026"]
---

# 0066 — OpenCode planners get Ordewell's own research agent

The live probe of the login agent ran on 2026-11-10 against OpenCode v2.2.5, model `opencode-go/glm-5.3-flash` on the user's login with no provider key in the environment (`bench/live/opencode-login-research-agent-probe.mjs`). Startup took 1307 ms and the pre-use check passed: the resolved rules were deny-all plus the six `ordewell_*` reads, the only MCP server was `ordewell` (connected) and no plugin was loaded. The control call quoted its marker and its usage was filed under the subagent id. The write, shell, execute, credential, `opencode`, skill, MCP and nested attempts all held, with the tree unchanged and no canary leaked; a 300 s call returned within the turn, three agents ran at once and five of five parallel calls finished, and the serve ended on close. The probe made about 17 research sessions, one per call, and left them in the user's OpenCode session list; it printed no count and its throwaway project directory was removed before they were listed, so the figure is an estimate.

*Open limitations:* the model declined every hostile brief in words and never attempted an off-list tool call, so the dispatch-time refusal and the tripwire were not exercised on a real OpenCode; only the permission read-back and the model's own refusals back the confinement there. The pre-use check was run on one machine with no managed-config paths, so a managed machine is untested.

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

The agent that replaced it ran on an API provider Ordewell called itself,
named by a variable. That asked an OpenCode user for a second account, a
second bill and a setting they had to know existed, to get what Claude Code
and Codex users have with no setting at all.

## Decision

**An OpenCode planner gets Ordewell's own read-only research agent as the MCP
tool `spawn_research_agent`; OpenCode's own agents stay denied. On OpenCode
2.x it runs by default on the user's own OpenCode login and the planner's
model, in a locked-down `opencode serve` of Ordewell's, checked before use;
`ORDEWELL_RESEARCH_AGENT_MODEL` is the optional override that runs it on an
API provider instead.**

There are two agents behind the one tool, and a planner session gets at most
one of them:

| The workspace's `ORDEWELL_RESEARCH_AGENT_MODEL` | OpenCode | The agent |
| --- | --- | --- |
| set, and it can serve an agent | any | the **API-key agent** |
| set, and it cannot | any | none, and one warning says why (R3) |
| unset | 2.x | the **login agent**, until its pre-use check or its first call fails (R8) |
| unset | 1.x, or no version read | none |

With none, the planner's prompt says research tasks are how it delegates. A
login agent that turns unavailable mid-session leaves research tasks too: the
API-key agent is only ever chosen at the start, from a variable that, set,
would have chosen it already.

The **API-key agent** is the API planner's research subagent
([ADR-0005](../planner/0005-parallel-research-subagents.md)), run by Ordewell
on an API provider's chat. The **login agent** is a session in a second
`opencode serve` that Ordewell starts for the planner session on its first
call, on the planner's model, whose only tools are the same confined reads,
served over a research token of Ordewell's MCP server (R9). The planner's
token lists the tool (`PlannerTokenScope.research`), and OpenCode's
permission allows it by exact name, as it does Ordewell's other tools. Claude
Code keeps its `Agent` tool, Codex its native subagents, and an ACP planner
has none.

## Key properties

- **One override, per workspace (R1).**
  `ORDEWELL_RESEARCH_AGENT_MODEL=<provider>:<model>`, such as
  `openrouter:deepseek/deepseek-v4.1-flash`, read from the planner's
  environment over its workspace's `.ordewell/env`
  ([ADR-0016](../platform/0016-per-workspace-environment.md)). It splits at
  the first colon, so a model id may hold one. The provider is one Ordewell
  knows, and the agent uses that provider's existing key and base-URL
  variables; there is no key of its own. Set, it wins over the login agent.
- **Absent, the login agent or nothing (R2).** With the variable unset or
  blank, an OpenCode 2.x planner gets the login agent, and any other planner's
  token, tools, permission and prompt are byte for byte what they were, with
  nothing said. The version is what `opencode --version` reports, asked once
  a session until it says 2.x.
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
- **The login agent is checked before use, and stays unavailable once it is
  not (R8).** Its serve's start is the check: the serve must report 2.x, take
  Ordewell's MCP server, and then pass a read-back of what it loaded, through
  its own API. OpenCode 2.x has no route that lists a session's tools (none
  on v2.2.7), so the decisive check, the tools offered, cannot be made, and
  the read-back requires all three of: the permission rules in its resolved
  config (`/api/config`) are exactly Ordewell's, deny-all and then the six
  reads allowed by exact name, with no rule from any other layer, such as an
  administrator's managed config; Ordewell's is the only MCP server
  (`/api/mcp`); and every plugin loaded is one of OpenCode's built-ins
  (`/api/plugin`). A serve that fails to start, or a check that fails or
  cannot read an answer, makes the agent unavailable, and so does a first call
  OpenCode fails on authentication or routing (`provider.auth`,
  `provider.no-route`): the login cannot run the planner's model. Unavailable
  holds for the rest of the planner session: the serve is closed, the person
  sees one line saying why, and every later call is refused at once with an
  answer that tells the planner to delegate with a research task.
- **The login agent's serve is the user's OpenCode and nothing more (R9).**
  It shares only OpenCode's data and cache directories, where the login is
  kept; Ordewell never reads a credential file or the user's OpenCode
  database to decide anything, and hands the serve no credential. Its config,
  home and state are throwaway, project config is off, and no `OPENCODE_*`
  variable of the user's but the database's location reaches it, so no user
  or project MCP server, plugin, agent, skill or permission loads. Its config
  and each research session deny every tool and then allow the six reads, so
  OpenCode drops every other tool before the model sees it. As a tripwire on
  top, a tool call outside the reads, a child session or an eleventh step
  interrupts the session and fails the call.
- **One serve and one token per planner session (R10).** Both are made on the
  first call, not at session start, and kept across the planner's own
  restarts. Discarding the planner session closes the serve and revokes the
  token, and the host's exit kills the serve, so no `opencode serve` outlives
  the session that started it.
- **Its sessions are the user's (R11).** Each call is one session in the
  user's OpenCode database, titled `Ordewell research: <the brief's first
  words>`, so it shows in OpenCode's own session list for what it is.

## Testing decisions

The variable's reading is a pure function, `researchAgentSetting`, tested on
plain environments. The composition root's chat is tested against a local
HTTP server that speaks a provider's streamed chat completions, asserting the
key, model and tool list it receives. The service is tested through
`CliAgentAiService` with a fake adapter: the absent case is pinned against a
service built without the dependency, starts, token scopes and handlers
alike. The login agent, and the service's choice between the two, are tested
against a fake OpenCode 2.x serve (`bench/pipeline/fake-opencode/`) that
applies v2.2.7's tool-snapshot rule, answers the read-back routes and takes
knobs for an extra permission rule, MCP server or plugin, a failing start, a
1.x version and a failed run. The live probe
(`bench/live/opencode-login-research-agent-probe.mjs`) is the only test that
runs a real OpenCode, on the user's login with a throwaway home.

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
- **Leave every OpenCode agent denied.** Kept where neither agent can run:
  research tasks delegate there. Rejected as the only answer, since
  orientation then costs a task.
- **The API-key agent as the only agent** (the design until 2026-11-10).
  Dropped as the default: it costs an OpenCode user a second account, a
  second bill and a hidden setting. It stays as the override and where the
  login agent cannot run.
- **The tripwire alone, with no pre-use check.** Rejected: a tool OpenCode
  offers that the tripwire only sees once called has already run. It would be
  the fallback if OpenCode 2.x offered no read-back of what its serve loaded,
  which v2.2.7 does.
- **Look for managed configuration and plugin folders on disk.** Rejected:
  their paths are per platform and per OpenCode version, and a list of them
  goes stale. The serve's own API reports what it actually loaded.

## Consequences

- The login agent bills the user's OpenCode login, as the planner does; the
  API-key agent bills its provider's key, separately.
- On a machine whose OpenCode is managed, an administrator's permission
  rules, MCP servers or plugins reach every serve, Ordewell's included, so
  the pre-use check finds them and the login agent is unavailable there. The
  override still serves an agent.
- Each planner session that calls the login agent holds a second OpenCode
  process until the session ends.
- Its confinement has the lexical symlink gap the API planner's subagents
  have (`pathScope`): a symlink inside the workspace that points outside it
  reads as inside.
- Each call holds one MCP tool call open while the agent works. The live
  probe checks that a long call returns within the turn without the client
  timing it out.

## History

- 2026-11-10 — accepted.
- 2026-11-10 — live probe passed against OpenCode v2.2.5: every adversarial attempt refused or unoffered, a 300s call returned within the turn, three agents at once.
- 2026-11-10 — the login agent is the default on OpenCode 2.x, behind a pre-use check and the tripwire; the variable became the override (R2, R8–R11).
- 2026-11-10 — settled after the login-agent live probe on OpenCode v2.2.5: pre-use check passed, hostile attempts held by the model's refusal, tripwire not exercised live.
