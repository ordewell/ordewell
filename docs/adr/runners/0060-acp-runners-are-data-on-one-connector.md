---
status: accepted
amends: ["0008", "0009", "0018", "0022", "0023", "0025", "0028", "0046"]
---

# 0060 — ACP runners are data on one connector

## Problem

Ordewell drove three coding agents, each through a connector written for its
own protocol ([ADR-0018](0018-structured-runner-transport.md)). Many more
agents now ship a native server for the Agent Client Protocol (ACP), and the
user who has one of them installed cannot hand it a task. A connector per agent
does not scale to them, but one generic connector has to hold every rule a
native connector holds: Ordewell's tools attached before the first prompt
([ADR-0025](0025-structured-only-runners.md)), the plan's mode and model held
([ADR-0001](../routing/0001-autonomous-mode-resolution.md)), and a planner or a
read-only task that cannot write
([ADR-0026](../planner-envelope/0026-one-envelope-for-every-planner.md),
[ADR-0046](../planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md)).
ACP agents differ in exactly those places: how they take instructions, how
they are put in a mode, whether they honour a client's MCP servers, and
whether their own tools can be taken away.

## Decision

**One `AcpAdapter` drives every ACP runner, and what differs between agents is
an `AcpProfile`: data, not code.** `acpConnector(profile)` turns a profile into
the runner's entry in `CONNECTORS`, so a new ACP agent is a manifest and a
profile. GitHub Copilot CLI (`copilot-cli`, `copilot --acp --stdio`) is the
reference agent; Qwen Code (`qwen-code`, `qwen --acp`) is the second, for
writable tasks only.

Ordewell is the ACP client and does no I/O for the agent: it advertises no
file-system and no terminal capability, so the agent works in the worktree
itself and reaches Ordewell only through the Ordewell MCP server it is handed
in `session/new`. A start is `initialize`, then `session/new`, or
`session/resume` or `session/load` for a resume, then the plan's mode, model
and effort; a turn is one `session/prompt`. The adapter never calls
`authenticate`: a `-32000` answer is read as signed out, and signing in is the
user's, in the agent's own terminal. Any other request from the agent is
answered `-32601` at once, so a turn never waits on Ordewell; a profile may
instead answer the agent's own methods that hold its turn until the client
replies (`extensionRequests`), and a request its handler cannot read keeps the
`-32601`.

The protocol is spoken from vendored v1 types (`acpSchema.ts`, checked with
zod) on a protocol-neutral JSON-RPC peer (`jsonRpc.ts`). Every object passes
unknown fields through, an enum-like field is any string, and a message that
does not fit is reported, never thrown, because agents add fields and kinds
ahead of the specification.

A profile holds the manifest, the ACP arguments, the minimum agent version
read from `initialize`'s `agentInfo`, the setup timeout, how the agent names
Ordewell's tools in its reports and to the model, how a model reaches it at
spawn, the instructions route, the mode route, what it loads from a
repository (ADR-0028), the roles it claims, the controls that restrict it,
and the answers to the agent's own requests.

## Key properties

- **A new agent is a profile and a manifest (R1).** The adapter holds no
  agent's name. A behaviour one agent needs becomes a profile field every
  agent can use, never a branch on a runner id.
- **Native ACP servers only (R2).** A runner is admitted only when the agent's
  own maintainers ship its ACP server. Claude Code, Codex, Amp and Pi are
  reachable over ACP only through third-party adapters, which do not qualify:
  Claude Code and Codex keep their native connectors.
- **A role is claimed on evidence, never by mode alone (R3).** A profile's
  `roles` decides whether the runner may plan (the connector's `plans`) and
  whether its manifest has a read-only mode. Absent, the runner takes writable
  tasks only. A profile may claim the planner role or a read-only mode only
  when all of these hold:
  - a spawn-level control (`restricted`) removes or denies the agent's own
    write and shell tools, and is shown to hold under ACP;
  - Ordewell refuses every `edit`, `delete`, `move` and `execute` permission
    request, and every switch of mode, on those starts (`decideRestricted`),
    by the kind the request names or the kind the turn reported for the same
    call, except Ordewell's own tools, pre-allowed by exact name (R7);
  - a recorded live run shows a write attempt and a shell attempt refused,
    with nothing left behind.

  A planner or a read-only task also runs nothing the repository's config
  names (ADR-0028). An agent that loads configuration from the directory it
  starts in, with no switch of its own to stop it, starts there in a private
  directory instead (`restricted.privateCwd`): owner-only and empty but for
  its instructions, the session's `cwd` and its temp directory too. It then
  reaches the worktree only by asking, so every read goes to the planner's
  envelope or to the read-only task's rules (ADR-0046). Since it loads none
  of the repository's instruction files there, the profile's reader
  (`repoConfig`) reads them and they follow Ordewell's own in its
  instructions, bounded as every planner's are (ADR-0028). Such a start is
  refused under a placement, since a container starts its runner in the
  worktree. `acpRoles` refuses at load a profile whose claimed read-only role
  and manifest disagree, or that claims a role with no restriction;
  `AcpAdapter` refuses a planner or a read-only start its profile does not
  claim. A restricted session that leaves the mode it settled in fails, and
  its process is disposed.
- **Ordewell's tools go over HTTP, with the token in `session/new` (R4).** The
  server is given as one `http` entry in `mcpServers`, its token as a header,
  so the token reaches the agent over stdin and never as an argument or a file
  (ADR-0022 A5). It is given again on every resume and load, since the agent
  keeps no session's servers between processes. An agent whose `initialize`
  does not advertise `mcpCapabilities.http` is refused in plain words: it
  "cannot take Ordewell's tools over HTTP, so it cannot run tasks or plan
  here".
- **The attach is read from the server's first contact (R5).** ACP has no MCP
  status notification. The attach state is the Ordewell MCP server's own
  record (`McpContact`): connected once a request carrying the token has
  passed every check, failed when the agent refused the session or the process
  is gone, pending until then (ADR-0022 S2, S4).
- **Instructions never land in the worktree (R6).** ACP has no system-prompt
  field. The completion contract (and a planner's system prompt) goes through
  the agent's own channel outside the worktree where it has one: an
  owner-only file named by a flag or a variable, or found in a private
  directory a variable lists or the private directory a restricted start
  begins in (R3), or a documented `_meta` field of `session/new`. An agent with none gets it as a preamble on the first prompt
  of every new process, a resumed one included. This is ADR-0018 C2's ACP
  exception.
- **The plan's mode reaches the agent at spawn (R7).** A mode route maps it to
  the agent's own allow-all flag or session mode where it has one; without one
  the adapter answers each permission request as the manifest's mode settings
  say. Ordewell's own tools are pre-allowed by exact name only, as the profile
  reads it from the permission request and the turn's report of the same
  call (ADR-0022 S3). The name is decided before any kind is read: an agent
  guesses an MCP tool's kind from its name, so a planner's or a read-only
  task's refusal by kind would otherwise turn Ordewell's tools away. The model and
  effort are set through the session's config options and read back
  (ADR-0018 B2): a model with no setting to read back is taken on the agent's
  word at spawn only when the profile passes it by argument.
- **A message for a running ACP task waits for the turn's end (R8).** ACP v1
  has no mid-turn injection, so the adapter offers no steer and messages take
  the turn-end queue (ADR-0023). A force send is `session/cancel`, the
  prompt's own response, then a new `session/prompt`; requests still pending
  at the cancel are answered `cancelled`. Only the `session/prompt` response
  ends a turn: no streamed update and no timer does.

## GitHub Copilot CLI

Checked against Copilot CLI 1.0.105, the profile's `minVersion`, and the
recordings in `packages/core/src/services/__tests__/fixtures/acp/copilot-cli/`:

| profile field | Copilot CLI |
|---|---|
| instructions | an owner-only `AGENTS.md` in a private directory named by `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` |
| mode | `--allow-all` under `allowAll`, nothing under `default`; its `autopilot` session mode is not used, because it changes how Copilot works, not only whether it asks |
| model | `--model` at spawn; 1.0.105 exposes no model or effort setting over ACP |
| Ordewell's tools | a request titled with the bare tool name whose call the turn reported as `ordewell-<tool>`; neither title alone, and never the kind, which Copilot guesses (`run_plan` as `execute`, `list_runners` as `read`) |
| restriction | `--deny-tool=write`, `--deny-tool=shell`, `--deny-tool=url`, `--disable-builtin-mcps`, `COPILOT_ALLOW_ALL=false`, and a private start directory that is also `TMPDIR`, `TMP` and `TEMP` and holds the instructions as its own `AGENTS.md` |
| repository | a restricted start is handed the instruction files Copilot would load from the repository, and no hook, setting or MCP server (ADR-0028) |
| roles | the planner, and a read-only mode (`plan`) |

A native call's two titles are Copilot's own fixed words ("Create file",
"Creating <path>") or the one description the model wrote, the same on both,
so only a call to the server named `ordewell` carries the pair.

Under ACP Copilot 1.0.105 runs the shell hooks in `.github/hooks/` of the
directory it starts in, from the first prompt, trusted or not and with
`disableAllHooks` set, and no flag turns them off (`repo-hooks.jsonl`). Under
ACP `--add-dir` grants no access and `--disallow-temp-dir` takes none away, and
Copilot reads its temp directory without asking, so the private directory is
its temp directory too. Started there it runs no hook, and asks for each path
in the worktree ("Access paths outside trusted directories").

The recordings of both restricted starts (`planner.jsonl`, `read-only.jsonl`)
show no hook run and nothing left behind. In `planner.jsonl` a shell attempt is
refused by Copilot itself under `--deny-tool=shell`, with no request, and a
write attempt arrives as a request to read the path it would create, which the
turn reported as an `edit`, and Ordewell refuses it. A refused request ends
Copilot's turn: the planner goes on in its next turn, and a read-only task
whose turn so ends without `task_complete` is reminded of it like any task
([ADR-0018](0018-structured-runner-transport.md) W1).

Started there, Copilot loads none of the repository's instruction files, so a
restricted start is handed them after Ordewell's own. Checked live on 1.0.105
with `gpt-5-mini`: a planner in a scratch repository whose `AGENTS.md` asked
for a title prefix called only `list_runners`, `list_models` and
`submit_plan`, and its one task carried the prefix.

Its models come from ACP discovery (`initialize` and `session/new` in a scratch
directory) first; an empty answer falls through to `copilot help config`
(ADR-0004). It has no sign-in status command, so a signed-out Copilot is
learned from `-32000` and shown with its `copilot login`
([ADR-0052](../routing/0052-a-signed-out-coding-agent-is-flagged-and-signs-in-from-the-chat.md)).

## Qwen Code

Checked against Qwen Code 0.26.6, the profile's `minVersion`, and the
recordings in `packages/core/src/services/__tests__/fixtures/acp/qwen-code/`,
made with an OpenRouter model:

| profile field | Qwen Code |
|---|---|
| instructions | the first prompt: Qwen has no instruction file or `_meta` slot outside the worktree |
| mode | the `mode` config option, set after `session/new` (`default`, `auto-edit`, `yolo`); the manifest offers no `auto`, Qwen's default, because an LLM classifier decides there, and no `plan`, whose refusal of a write and a command has no recording |
| model | `--model` at spawn and the `model` config option, whose ids carry a provider suffix (`openai/gpt-4.1-mini(openai)`) |
| Ordewell's tools | `_meta.toolName` of the permission request, `mcp__ordewell__<tool>`; the title is the call's arguments, which the model writes, and the kind is a guess, so neither is read |
| restriction | none |
| roles | none: Qwen is task-only, since no recording shows its `plan` mode, or any control, refusing a write and a command (R3) |

Qwen contacts the server while `session/new` runs, which is the attach (R5).
It defers an MCP tool's schema: the model must find a tool with `tool_search`
before it can call it, and a bare call of `task_complete` is refused by Qwen
itself and completes nothing (`deferred-refused.jsonl`). A call is first
reported under the placeholder title `ToolCall`, so the transcript names the
call only from its in-progress update, whose `_meta.toolName` carries the
tool. In `yolo` Qwen asks about nothing (`allow-all.jsonl`); the pending
request of a cancelled turn is answered `cancelled`. It has no login or
status command: it signs in from its settings file or its provider's key, a
signed-out `session/new` fails with `-32000` "Authentication required", and
that is how a signed-out Qwen is learned.

Its models come from ACP discovery alone: `session/new` lists the models its
settings configure, and there is no command to fall back to.

## Testing decisions

- **Recorded fixtures are the agent's evidence.** A recording is the JSONL of
  every line each side sent, with notes for the spawn arguments and what the
  live run left behind. `copilotCli.test.ts` replays the agent's side against a
  live adapter and Ordewell server, and `qwenCode.test.ts` does the same for
  Qwen; a claim about the agent cites a recording.
- **`fakeAcpAgent`** scripts an agent for the adapter's own tests
  (`acpAdapter.test.ts`, `acpCancelRace.adversarial.test.ts`), and
  `fakeRunners.ts` gives the connector contract tests an ACP runner.
- `acpEvents` is a pure reducer from `session/update` to Ordewell's agent
  events, tested on its own.

## Out of scope

- **A stdio-to-HTTP MCP bridge.** An agent that takes only stdio MCP servers
  would need a local process carrying the token; it is refused instead, until
  such an agent is worth the bridge.
- **Agents beyond Copilot CLI and Qwen Code.** Gemini CLI and Goose wait for
  the same live probe those passed before they are admitted at all.
- **A resumed restricted start.** A resume begins in a new private directory
  and hands it to `session/load`; no recording yet shows Copilot resuming a
  session whose `cwd` has changed.
- **ACP v2.** Its prompt lifecycle separates acceptance from processing and
  does not yet specify queueing or steering; nothing here relies on it.

## Considered options

- **Third-party ACP shims for Claude Code, Codex and other agents.** Rejected:
  ADR-0009's objection to ACP for every agent holds, since a shim is one more
  install between Ordewell and the agent, maintained by neither, and the
  native connectors already work.
- **The `@agentclientprotocol/sdk` package at runtime.** Rejected: it is
  ESM-only and core also ships CommonJS, so a runtime import would break
  `require('@ordewell/core')`. The v1 types are vendored instead.
- **The token on the command line, or in a config file in the worktree.**
  Rejected by ADR-0022 A5. `session/new` carries the server with its headers
  over stdin, which every ACP agent reads anyway.
- **The attach taken from the agent's own word.** Rejected: ACP has no MCP
  status notification, and an agent may accept `mcpServers` and never use them
  (Cline 3.0.74, cline#15504; Kiro before April 2026, Kiro#7349). The server's
  first contact is evidence; an accepted `session/new` is not.
- **Roles enforced by the agent's mode alone.** Rejected: a mode's name is the
  agent's promise. A plan or ask mode does not show that a write or a command
  is refused.
- **Ordewell's tools recognised by the report's title alone.** Rejected: the
  request is what is answered, and Copilot asks for an MCP call by the bare
  tool name, which a native call's model-written description can equal. The
  pair is what only the `ordewell` server's calls carry.
- **A restricted Copilot started in the worktree, with `--add-dir` or a trust
  setting holding it to the workspace.** Rejected: hooks run from the start
  directory whatever Copilot is told, and under ACP neither `--add-dir` nor
  `--disallow-temp-dir` has any effect. The roles were withheld until the
  private start directory, which keeps the repository's hooks and config out of
  the process without a switch of Copilot's.
- **Roles enforced by withholding Ordewell's capabilities.** Advertising no
  file-system or terminal capability is how Ordewell stays out of the agent's
  I/O, not a restriction: the agent writes and runs commands with its own
  tools. Rejected as the evidence; R3 asks for the agent's own controls,
  Ordewell's refusals and a recording.
- **Instructions in a file in the worktree.** Rejected: the task would commit
  it or land it (ADR-0018 C2), and a concurrent task would read another's.
- **A stdio-to-HTTP MCP bridge now.** Deferred: no admitted agent needs it,
  and it is one more process holding the token.
- **Copilot's `autopilot` session mode for `allowAll`.** Rejected: it changes
  how Copilot works, not only whether it asks; `--allow-all` is the permission
  switch alone.
- **Autonomous modes answered by the adapter alone.** Rejected where the agent
  has its own switch: the agent would still ask, and each ask is a round trip
  the mode already settled. The adapter answers only for an agent without one.
- **Qwen's own `auto` mode as its default mode.** Rejected: an LLM
  classifier decides what runs there, which leaves a plan's mode to a model
  (ADR-0001). Every start sets one of the three modes the manifest offers.
- **Qwen's `plan` mode as a read-only mode.** Rejected for want of evidence:
  no recording shows it refusing a write and a command, and R3 asks for one.
- **Steering through a prompt sent mid-turn.** Rejected: v1 defines no
  injection, and a second `session/prompt` during a turn is not specified to
  join it. The turn-end queue is what v1 supports.

## Consequences

- Admitting an ACP agent is a probe, a recording, a manifest and a profile,
  with no adapter code. What the probe must show is in CONTRIBUTING.md's ACP
  section.
- A runner can be task-only: where a profile claims no planner role, `plans`
  is false, and the runner runs tasks, is listed and signs in like any runner
  but never appears among the planners. Copilot CLI claims the role, so it
  plans like the native runners.
- A restricted Copilot names the worktree's files by their full path, since
  its own relative paths name the private directory; its instructions tell it
  where the workspace is.
- A runner id shares the planner setting's namespace with the API vendors'
  ids, so an ACP runner id must not equal one (`kimi-cli`, not `kimi`;
  `qwen-code`, because `qwen` is DashScope's).
- Each agent's ACP server is young and changes between releases; the profile's
  `minVersion` and its recordings name the version each claim was checked on.

## History

- 2026-11-04 — accepted and implemented: `copilot-cli` is the reference ACP
  runner, for writable tasks only.
- 2026-11-04 — Copilot CLI plans and runs read-only tasks: a restricted start
  begins in a private directory, and Ordewell's tools are named by the
  request and report pair before any kind is read.
- 2026-11-04 — a restricted start is handed the repository's instruction
  files after Ordewell's own, from Copilot's repository-config reader.
- 2026-11-04 — a profile may answer the agent's own client-bound requests
  (`extensionRequests`); Cursor's are written, for a profile not yet admitted.
- 2026-11-04 — Qwen Code (`qwen-code`) is admitted on its recordings, for
  writable tasks only.
