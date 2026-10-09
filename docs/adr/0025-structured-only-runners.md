# 0025 — Structured-only runners

**Status:** accepted, implemented — supersedes [ADR-0007](0007-tmux-backed-runners.md)

## Problem

Terminal fallback made every runner feature carry two contracts: protocol events
and messages, or scraped screens and injected keystrokes. Completion and
checkpoint markers also allowed a broken MCP attachment to go unnoticed. All
three built-in runners now have structured connectors, and the offline pipeline
and VS Code integration harnesses exercise them with a fake `claude` executable
on PATH. Keeping the obsolete path no longer serves a supported runner.

## Decision

**Ordewell drives runners only through structured connectors: `claude-code`,
`codex` and `opencode`. Ordewell's MCP tools must be connected for every
coding-agent session, both task runners and coding-agent planners.**

- Check the runner's MCP attach state after spawn, before sending its task or
  planning prompt. If attachment fails, dispose the process and its token and
  respawn once with a fresh token. If that attempt also fails, fail the task or
  planner turn with the attach error. Never send the prompt without tools.
- Completion evidence is only a `task_complete` call bound to the attempt's
  token. `VerdictEngine` checks the current generation; only `done` passes.
  `blocked` and `failed` end without a pass and carry a reason. A process exit,
  even with code zero, cannot imply completion. Manual Mark complete remains
  the user's explicit override.
- Checkpoints use only `checkpoint({question})`; the call remains open until
  answered or withdrawn. No completion or checkpoint text markers are parsed.
- `IRunner` and `IRunnerSession` are the single runner contracts. Events,
  messages, interrupt, approvals, native session id and task tools are mandatory
  session methods. Mid-turn steering remains an optional adapter feature;
  an adapter without it uses the turn-end queue (ADR-0023).
- Remove terminal transport, PTY/tmux machinery, plugin runners and their
  install/list commands. Built-in manifests hold identity, command, discovery
  and mode settings; terminal-only invocation fields are absent. Leftover
  manifests in `~/.ordewell/plugins/` are ignored, with one notice at host
  startup. No unknown runner is silently routed to a terminal.
- Task logs are the inspection surface: Enter on a task in the TUI's plan pane,
  and Open log in VS Code. `ordewell terminal`, `/terminal`, `t` and
  Structured/Terminal badges are removed. tmux is not required.

API planners keep their existing validated JSON plan, edit and query envelopes;
these are not completion-marker fallbacks. This decision does not widen the
planner exploration envelope (ADR-0008).

## Expected successor: a generic Agent Client Protocol (ACP) connector

A generic **Agent Client Protocol (ACP) connector** is the expected successor
for third-party harnesses. It is not implemented by this decision and does not
replace the native built-in connectors yet. The following findings were checked
on 2026-10-09.

ACP uses JSON-RPC 2.0 over stdio. Protocol v1 is stable; the Rust and TypeScript
SDKs reached 1.0 on 2026-06-25. Zed and JetBrains maintain the protocol.
[Transports](https://agentclientprotocol.com/protocol/transports),
[updates](https://agentclientprotocol.com/updates).

`session/new` accepts client-supplied `mcpServers`. Stdio MCP support is required;
HTTP is optional and capability-negotiated. `session/load` restores a session
with history replay; `session/resume` reconnects without replay. Both require
the corresponding advertised capabilities. Agents **SHOULD** connect to the
client's supplied MCP servers, so protocol support alone does not prove that
Ordewell's tools attached. Every agent must be verified against the same
attachment constraint before admission.
[Session setup](https://agentclientprotocol.com/protocol/session-setup).

A turn is `session/prompt` plus streamed `session/update` notifications, with
`stopReason` in the final response. Permissions arrive through
`session/request_permission` and must be answered; ignoring a request can stall
the agent. `session/cancel` cancels work, and pending permission requests must
receive a cancelled outcome. An ACP stop reason describes a turn, not evidence
that an Ordewell task is complete.
[Prompt turn](https://agentclientprotocol.com/protocol/prompt-turn).

The published directory lists 37 agents at this check. It lists native implementations in Cline, Cursor, Copilot CLI
(public preview), Gemini CLI, Goose, Kiro and OpenCode, plus adapters for Claude
Code/Claude Agent and Codex. Gemini's CLI reference still labels
`--experimental-acp` experimental, while its dedicated ACP guide documents
`--acp`; a connector must check the installed version rather than assume the
flag. Directory membership does not establish MCP or permission compatibility.
[Agents](https://agentclientprotocol.com/overview/agents),
[Gemini CLI reference](https://geminicli.com/docs/cli/cli-reference/),
[Gemini ACP mode](https://geminicli.com/docs/cli/acp-mode/).

Protocol v1 has no standard mid-turn message injection. Our inference is that
ADR-0023 would degrade to queue-until-turn-end on a generic v1 connector, with
cancel and a new prompt for force send. The v2 prompt lifecycle remains an
unsettled proposal: it separates prompt acceptance from processing but does not
yet specify queueing or steering. Do not promise native-connector delivery
semantics from that draft.
[v1 prompt turn](https://agentclientprotocol.com/protocol/prompt-turn),
[v2 prompt lifecycle](https://agentclientprotocol.com/rfds/v2/prompt).

Antigravity adapters also carry a terms risk: Google's additional terms restrict
third-party software accessing the service and allow account suspension or
termination. ACP availability alone is not authorization to use such an adapter;
its supported access path and applicable terms need checking before adoption.
[Antigravity terms, section 6](https://www.antigravity.google/terms).

## Considered options

- **Keep terminal as fallback.** Previously adopted; rejected because screen
  scraping, keystroke delivery and a second session lifecycle burden every
  runner feature, with no supported runner needing them.
- **Keep markers as the no-tools fallback.** Previously adopted; rejected
  because an attach failure would silently downgrade completion, checkpoints
  and planner tools. Respawn once, then fail visibly.
- **Keep plugin runners but refuse to run them.** Rejected because installation,
  registry entries and pickers would advertise an unusable choice. Ignore old
  manifests with a notice instead.
- **Build a generic connector first.** Rejected as a prerequisite: native
  connectors already cover the supported runners. ACP is the expected next
  route for third-party harnesses, subject to the gaps above; retaining terminal
  and markers while waiting would preserve the ambiguity this decision removes.

## Consequences

One process/session contract owns every task. A missing tool connection fails
before the coding agent receives work. The fake `claude` harness verifies the
real connector and tool path without a model or API key. Supporting another
runner requires a structured connector and verified Ordewell tool attachment;
a manifest alone is insufficient. Native Windows runner execution needs no
tmux; the TUI remains unverified on native Windows (ADR-0010).

## History

- 2026-10-09 — accepted and implemented.
- 2026-10-10 — the TUI task-log surface corrected to Enter on a task in the plan pane.
