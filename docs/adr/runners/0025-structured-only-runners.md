---
status: accepted
supersedes: ["0007"]
folds:
  - "0007 — Runners execute inside tmux, terminals open on demand"
---

# 0025 — Structured-only runners

## Problem

Terminal fallback made every runner feature carry two contracts: protocol events
and messages, or scraped screens and injected keystrokes. Completion and
checkpoint markers also allowed a broken MCP attachment to go unnoticed. All
three built-in runners now have structured connectors, and the offline pipeline
and VS Code integration harnesses exercise them with a fake `claude` executable
on PATH. Keeping the obsolete path no longer serves a supported runner.

## Decision

**Ordewell drives runners only through structured connectors: the native
`claude-code`, `codex` and `opencode` connectors, and the one ACP connector
that drives `copilot-cli`
([ADR-0060](0060-acp-runners-are-data-on-one-connector.md)). Ordewell's MCP
tools must be connected for every coding-agent session, both task runners and
coding-agent planners.**

- Check the runner's MCP attach state after spawn, and a coding-agent planner's
  again before every turn. If attachment fails, dispose the process and its
  token and respawn once with a fresh token; a planner respawn resumes the
  conversation from its native session id. A task whose runner stays alive and
  still reports `pending` is held with that reason after the wait's generous
  cap, not failed, so its dependents stay on the plan; a runner that reports the
  server `failed` still fails the task. A coding-agent planner turn fails
  either way, and a planner that cannot be re-attached fails its turn without
  its answer being heard. Never accept a result from a runner without tools:
  the prompt is sent only once they are attached, except to an ACP runner
  that connects them only when a prompt starts it (ADR-0060 R5). That
  runner's first turn is the check, a task's prompt or a planner's goal or
  message, kept only if the server was contacted before it ended, and
  otherwise discarded with its process and token: a task is then held and its
  worktree given up, and a planner's turn fails with nothing left running.
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
  and Open chat in VS Code (once an attempt has started). `ordewell terminal`, `/terminal`, `t` and
  Structured/Terminal badges are removed. tmux is not required.

API planners keep their existing validated JSON plan, edit and query envelopes;
these are not completion-marker fallbacks. This decision does not widen the
planner exploration envelope (ADR-0008).

## Key properties

Two rules hold for every transport, and other ADRs rely on them. ADR-0013 and
ADR-0014 cited ADR-0007 (folded in under *Considered options*) for them; D2 is
its rule T7:

- **A runner is handed a `cwd` and nothing more (D1).** Git never enters
  `IRunner`, `RunnerRegistry` or a runner adapter: isolation prepares a
  directory ([ADR-0013](../isolation/0013-worktree-isolation.md)) and
  `IRunner.spawn` takes it as `cwd`.
- **Task ids are scoped by plan session (D2).** Task ids are only unique within
  one plan — every planner names its first task `task-1` — and one daemon serves
  many plans through one shared runner. `PoolAwareRunner` therefore tags each
  spawn with its plan session id (`planSessionId`), which keeps two plans'
  identically named tasks apart wherever something is keyed by task, the
  attempt's MCP token among them. For the same reason a plan's stop-all and its
  count of running sessions come from the sessions that plan spawned, never from
  the shared runner, so one plan's stop cannot kill another plan's tasks.

## The Agent Client Protocol connector

Agents that ship a native Agent Client Protocol (ACP) server run through one
generic connector, `AcpAdapter`, with each agent's differences held in its
profile ([ADR-0060](0060-acp-runners-are-data-on-one-connector.md)). It is a
structured connector like the others, under every rule above: Ordewell's tools
attach before any result is accepted, read from the server's first contact
before the first prompt or, for an agent that connects only on its first
turn, before that turn ends (ADR-0060 R5), and only a `task_complete` call is
evidence. GitHub Copilot CLI (`copilot-cli`) is the
reference agent and the one ACP runner admitted so far; Claude Code, Codex and
OpenCode keep their native connectors. The following findings were first
checked on 2026-10-09 and rechecked on 2026-11-03.

ACP uses JSON-RPC 2.0 over stdio. Protocol v1 is stable; the Rust and TypeScript
SDKs reached 1.0 on 2026-06-25. Zed and JetBrains maintain the protocol.
[Transports](https://agentclientprotocol.com/protocol/transports),
[updates](https://agentclientprotocol.com/updates).

`session/new` accepts client-supplied `mcpServers`. Stdio MCP support is required;
HTTP is optional and capability-negotiated. `session/load` restores a session
with history replay; `session/resume` reconnects without replay. Both require
the corresponding advertised capabilities. Agents **SHOULD** connect to the
client's supplied MCP servers, so protocol support alone does not prove that
Ordewell's tools attached, and every agent is probed live before admission.
[Session setup](https://agentclientprotocol.com/protocol/session-setup).

A turn is `session/prompt` plus streamed `session/update` notifications, with
`stopReason` in the final response. Permissions arrive through
`session/request_permission` and must be answered; ignoring a request can stall
the agent. `session/cancel` cancels work, and pending permission requests must
receive a cancelled outcome. An ACP stop reason describes a turn, not evidence
that an Ordewell task is complete.
[Prompt turn](https://agentclientprotocol.com/protocol/prompt-turn).

On 2026-11-03 the published directory lists about 52 agents, and the registry's
daily protocol matrix probes 39 of them. Native servers include Gemini CLI
(0.66.0, `--acp`), Qwen Code, Goose, Copilot CLI (public preview), Cursor,
Cline, Kiro, Grok Build, Mistral Vibe, Auggie, Factory Droid, Junie, Kilo,
OpenHands, Qoder and OpenCode. Claude Code, Codex, Amp and Pi are reachable only
through third-party adapters, which do not qualify (ADR-0060 R2). Gemini's CLI
reference may still show `--experimental-acp` while the ACP guide documents
`--acp`, so its profile must check the installed version rather than assume
the flag. No probed agent implements `session/stop`, and the matrix does not
record `mcpCapabilities`. Directory membership does not establish MCP or
permission compatibility.
[Agents](https://agentclientprotocol.com/overview/agents),
[Registry matrix](https://github.com/agentclientprotocol/registry/blob/main/.protocol-matrix/latest.md),
[Gemini CLI reference](https://geminicli.com/docs/cli/cli-reference/),
[Gemini ACP mode](https://geminicli.com/docs/cli/acp-mode/).

Honouring client-supplied `mcpServers` varies. Gemini CLI advertises
`mcpCapabilities` `http` and `sse` and merges client servers, including HTTP
headers, into the session (checked in its source). The legacy Python Kimi CLI
also advertises HTTP and honours them, but its repository is archived in favour
of Kimi Code. Cline 3.0.74 stores the servers, never uses them and advertises no
`mcpCapabilities` (cline#15504). Kiro silently ignored them until April 2026
(Kiro#7349). Cursor documents only `.cursor/mcp.json` servers that the user has
approved, yet over ACP its CLI connects the HTTP servers `session/new` hands it
(ADR-0060, Cursor). In Goose, one unreachable client server stopped every configured
extension from loading (goose#11493, not planned). Gemini CLI, Qwen Code and
Goose are the next candidates, each admitted only after a live probe shows
Ordewell's HTTP MCP tools attached, as Copilot CLI 1.0.105's did.

Protocol v1 has no standard mid-turn message injection, so an ACP runner takes
ADR-0023's turn-end queue, with cancel and a new prompt for force send
(ADR-0060 R8). The v2 prompt lifecycle remains an unsettled proposal: it
separates prompt acceptance from processing but does not yet specify queueing
or steering, and nothing relies on it.
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
- **Runners execute inside tmux, terminals open on demand (ADR-0007).** The
  terminal transport's last design, and what this decision removes. Every AI
  runner had run headlessly (`HeadlessRunner`: piped stdio, one-shot, prompt
  baked into argv), with the orchestrator scanning raw output for
  `<<<ORDEWELL_CHECKPOINT>>>` and `<<<ORDEWELL_DONE_...>>>` markers
  (`VerdictEngine`); the TUI dropped `task_output` outright, so a user could not
  see what a runner was doing, let alone type into it. The ask (the #24
  follow-up): every spawned runner a real, interactive terminal a user can open
  and type into, while Ordewell keeps watching and still advances the dependency
  graph. Tasks ran in a **tmux window** instead of a piped subprocess
  (`TmuxRunner`, beside `HeadlessRunner`, both behind
  `ITerminalSession`/`ITerminalRunner`): one shared tmux session per port
  (`ordewell-<port>`), one window per task attempt, and `ordewell tui` opened a
  real OS terminal window attached to a task's window on demand (`t` in the plan
  pane, or `/terminal <id>`), computing the tmux target itself from port and task
  id because the daemon is always local. Output was captured by `tmux pipe-pane`
  into a per-session log tailed by byte offset; windows outlived the task (a
  login shell after the exit code) until a cancel, a retry or daemon shutdown;
  tmux was automatic with no setting, and a host without it fell back to
  `HeadlessRunner` with a notice. It went with the whole terminal transport
  (*Keep terminal as fallback*, above). Its full text, including the
  interactive-versus-headless permission-flag rules (`-a never` and a
  `projects.<cwd>.trust_level` override on Codex's interactive shape only), is in
  git history: `git log --follow -- docs/adr/runners/0007-tmux-backed-runners.md`.
  Its three rejected alternatives stay here, because a take-over feature would
  meet them again:
  - **A pty-multiplexer built into the TUI's own render loop (M2).** Rejected:
    the TUI's whole render model is pure `render(state) → string[]`,
    home-and-overwrite (ADR-0006); attaching a live runner needs raw ANSI
    passthrough, a fundamentally different mode. Doing this over the daemon's
    WebSocket (since a runner may not be spawned from the same process as any
    given TUI client) would also mean building bidirectional binary streaming
    plus resize propagation from scratch — reimplementing tmux, worse.
  - **Capture-pane polling with prefix-diffing (M3).** Rejected in favor of
    `pipe-pane` + file tailing: diffing periodic snapshots needs a resync
    heuristic whenever the pane's scrollback is exceeded between polls, which can
    re-emit already-seen content and double-count a checkpoint marker.
    `pipe-pane` gives an exact append-only byte stream tmux is already designed
    to produce.
  - **Spawn a real OS terminal emulator as the *only* transport (M4, no tmux
    underneath).** Rejected: it would only work with a local GUI, failing
    silently on every SSH/headless box — which is a large fraction of where a
    terminal-based TUI actually runs. tmux underneath means the daemon-side
    execution and the checkpoint/verdict machinery keep working identically
    whether or not a GUI is ever attached; opening a terminal is a pure
    convenience on top, not a requirement for the pipeline to run.
- **Keep markers as the no-tools fallback.** Previously adopted; rejected
  because an attach failure would silently downgrade completion, checkpoints
  and planner tools. Respawn once, then hold the task (or fail the planner
  turn) visibly.
- **Keep plugin runners but refuse to run them.** Rejected because installation,
  registry entries and pickers would advertise an unusable choice. Ignore old
  manifests with a notice instead.
- **Build a generic connector first.** Rejected as a prerequisite: native
  connectors already covered the supported runners, and retaining terminal and
  markers while waiting would have preserved the ambiguity this decision
  removes. The ACP connector came later, beside the native connectors rather
  than in their place
  ([ADR-0060](0060-acp-runners-are-data-on-one-connector.md)).

## Consequences

One process/session contract owns every task. A missing tool connection fails
before any of the coding agent's work is kept: before it receives work, or,
for an ACP agent that connects only on its first turn, task or planner, with
that turn discarded at the cost of a model turn. The fake `claude` harness verifies the
real connector and tool path without a model or API key. Supporting another
runner requires a structured connector and verified Ordewell tool attachment;
a manifest alone is insufficient. For an agent with a native ACP server, the
connector is a profile on the ACP connector
([ADR-0060](0060-acp-runners-are-data-on-one-connector.md)). Native Windows runner execution needs no
tmux; the TUI remains unverified on native Windows (ADR-0010).

## History

- 2026-07-31 — ADR-0007 accepted: tmux automatic, no setting.
- 2026-09-29 — ADR-0007: the transport became a setting (ADR-0018); tmux stays automatic within the terminal transport.
- 2026-10-02 — ADR-0007: structured the default; the terminal transport, and tmux with it, a fallback.
- 2026-10-04 — ADR-0007: a runner manifest may carry a command line per major version; OpenCode 2.x uses one.
- 2026-10-09 — ADR-0007: the transport setting removed; terminal is only the per-connector fallback (ADR-0018).
- 2026-10-09 — accepted and implemented; supersedes ADR-0007.
- 2026-10-10 — the TUI task-log surface corrected to Enter on a task in the plan pane.
- 2026-10-17 — ADR-0007 folded in under Considered options; D1 and D2, the two rules other ADRs cited to it, are Key properties here (D2 was its T7).
- 2026-10-21 — a task whose runner never reports the server connected is held with a reason instead of failed, while a `failed` report still fails it; a planner turn fails either way.
- 2026-10-25 — the VS Code control reads "Open chat", not "Open log".
- 2026-10-27 — a coding-agent planner's attach is checked before every turn, not only after spawn: a live process whose tools are gone is respawned once on a fresh token and resumed, and a turn that cannot re-attach fails without being sent.
- 2026-11-03 — the ACP successor findings were rechecked: about 52 agents are listed, `mcpServers` handling varies by agent, and the first wave is Gemini CLI (reference), Qwen Code, Goose and Copilot CLI.
- 2026-11-04 — the ACP connector is implemented ([ADR-0060](0060-acp-runners-are-data-on-one-connector.md)); `copilot-cli` is its reference agent, not Gemini CLI.
- 2026-11-04 — the rule is that no result is accepted without tools, not that no prompt is sent without them: an ACP runner that attaches on its first turn is sent the task as the check, and that turn is discarded unless the server was contacted before it ended (ADR-0060 R5).
- 2026-11-04 — Cursor's CLI was found to connect the servers `session/new` hands it over ACP, beyond the `.cursor/mcp.json` servers it documents.
- 2026-11-05 — a coding-agent planner on an ACP runner that attaches on its first turn sends its goal or message as the check, its turn discarded unheard and failed when the server was not contacted before it ended (ADR-0060 R5).
