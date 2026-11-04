---
status: accepted
amends: ["0008", "0026", "0027"]
---

# 0028 — Planners never run the repository's config

## Problem

A planner researches a repository before anyone has approved anything about
it (ADR-0008). ADR-0026 bounds what it may *do*: commands through
`run_command`, its runner's own requests through one envelope, no file
writes. It says nothing about what its runner *loads* from the repository at
start, and each runner loads code from there.

Checked live on 2026-10-11, each in a throwaway repository that was never
trusted unless stated:

- **Claude Code 2.1.296**, launched as a planner is (`-p`, stream-json,
  `default` mode, Ordewell's `--settings` ask rules): the project
  `.claude/settings.json`'s `SessionStart` and `UserPromptSubmit` hooks ran,
  its `apiKeyHelper` ran, its `env` block applied (an `HTTPS_PROXY` in it
  broke the API call), and a stdio server in `.mcp.json` was started before
  the first turn. Claude Code's documentation says as much
  ([permissions, "What runs before you trust a folder"](https://code.claude.com/docs/en/permissions)):
  the trust dialog guards interactive sessions, and `-p` skips it.
  ADR-0026's History, which says only a *trusted* repository's hooks and
  `enableAllProjectMcpServers` apply, is wrong.
- **Codex 0.162.0**: in a repository the user's config marks trusted, a stdio
  server in its `.codex/config.toml` was started for a planner's thread
  (`read-only` sandbox, `on-request`). Codex's own users trust their
  repositories as a matter of course: this machine's config trusts its home
  directory and every Ordewell worktree it has run in.
- **OpenCode 2.0.26**: a plugin in the repository's `.opencode/plugin/` ran
  when `opencode serve` started, before any session, and a local server in
  its `opencode.json` started with the planner's session. Ordewell's
  `OPENCODE_CONFIG_CONTENT` is the last config layer, so its permission policy
  wins for tools, but a later layer cannot unload a plugin or a server an
  earlier one declared.

Each is the repository choosing a command that runs as the user, with the
user's credentials, before the planner reads a line. The ask rules ADR-0026
added (c1db0bd) decide tool calls; none of this is a tool call.

Two smaller gaps sit beside them. Claude Code's `Read`, `Grep`, `Glob` and
`LS` have no ask rule, so an allow rule from a trusted folder's settings — an
`additionalDirectories` entry, a `Read(…)` rule, a project skill's
`allowed-tools` — lets a path read outside the workspace skip
`can_use_tool` and the envelope. And `pathScope.ts` judges containment
lexically, so a symlink the repository ships, pointing outward, reads as
inside: acceptable while Claude decided in-workspace reads itself, not once
Ordewell decides them.

## Decision

**A planner runs nothing the repository's config names: no hook, no settings
environment, no helper command, no plugin, and no MCP server the user has not
approved. Instruction files are text, and Ordewell gives them to the planner
itself. Change and ops tasks keep their native configuration; read-only tasks
use these same restrictions (ADR-0046).**

### Claude Code planners

- **User settings only.** The planner is launched with `--setting-sources
  user`, so neither `.claude/settings.json` nor `.claude/settings.local.json`
  is read: their hooks, `env`, helper commands (`apiKeyHelper`,
  `awsAuthRefresh`, `awsCredentialExport`, `otelHeadersHelper`), allow rules,
  `additionalDirectories`, plugins and MCP switches are gone, and so are the
  project's skills, agents and commands, which can carry hooks and
  `allowed-tools` of their own. Checked live: with it, none of the probes
  above ran.
- **No hooks at all.** `--settings` carries `disableAllHooks: true`. A user's
  own hook is not the repository's, but it runs on the planner's tool calls
  and can write files, which the envelope forbids every planner.
- **Every read reaches the envelope.** `--settings` asks for `WebFetch`,
  `WebFetch(domain:*)`, `WebSearch`, `mcp__*`, `Read`, `Grep`, `Glob` and
  `LS`. An ask rule beats an allow rule from any source (ADR-0026, History).
  A path tool's request is allowed at once when its target is inside the
  workspace — a `Grep` or `Glob` without a path searches the workspace — and
  asked as `external_path` otherwise, as today. Containment of an existing
  target is judged on its resolved path, so a symlink pointing outward asks.
- **The project's instructions are text.** User-only settings also drop the
  project's `CLAUDE.md`. Ordewell reads `CLAUDE.md`, `.claude/CLAUDE.md` and
  `CLAUDE.local.md` at the workspace root, with the files their `@` imports
  name inside the workspace, and appends them to the planner's system prompt,
  bounded in size. The user's own `~/.claude/CLAUDE.md` still loads.
- **The user's own servers stay.** User-scope servers and claude.ai
  connectors still load (checked live). Local-scope servers — the user's own
  entries for this project in `.claude.json`, under the planner's
  `CLAUDE_CONFIG_DIR` — are dropped by user-only settings; they are the
  user's, not the repository's, so Ordewell passes them back explicitly in
  the planner's `--mcp-config`.

### Project MCP servers, every runner

A project MCP server is one the repository declares: `.mcp.json` for Claude
Code; the `mcp` entries of the project's `opencode.json`/`opencode.jsonc` or
`.opencode/opencode.json[c]` for OpenCode; the `mcp_servers` of the project's
`.codex/config.toml` for Codex. Each runner is stopped from reading them for a
planner (above and below), and Ordewell reads them itself:

- **Not started unless approved.** Before the planner's first spawn, each
  server is put to the session's approval policy as kind `mcp_server`. The
  card names the server, its transport and exactly what would run: the
  command and arguments with any environment it sets, or the URL with the
  names of the headers it sends. Variables written as `${VAR}` are shown as
  written, and the card says the runner fills them in from the user's
  environment.
- **Remembered per repository and definition.** The scope is
  `mcp-server:<name>@<hash>`, where the hash covers the whole definition. A
  person's approval is remembered across sessions in Ordewell's own data
  directory (`~/.ordewell`), never in the repository, keyed by the repository
  root, the server's name and that hash; a changed definition hashes
  differently and asks again. A mode's answer is not remembered (ADR-0026).
- **Passed as approved.** An approved server is handed to the runner as the
  definition Ordewell parsed and showed — in the planner's `--mcp-config` for
  Claude Code, in `OPENCODE_CONFIG_CONTENT` for OpenCode, in the thread's
  `mcp_servers` for Codex — so what starts is what was shown, never what the
  runner would re-read from the file. Its tools then reach the envelope as
  any MCP tool does (`mcp_tool`, ADR-0026).
- **Full asks nobody.** Under `auto` in Full, and under `allowlist`, an
  unremembered server is not started. The refusal is recorded like any other
  decision, so every surface shows it, and its detail names the allowlist
  entry that would start it. A Guarded session's approval is remembered and
  also starts it in Full later. Under `allow`, it starts. Either way the
  planner is told which of the repository's servers it does not have, so
  work that needs them goes into the plan's tasks.
- **The allowlist names a definition, not a name.** `mcp-server:<name>@<hash>`
  in the planner allowlist starts that exact definition in every mode. A name
  alone would start whatever command the next repository puts under it. A
  `!mcp-server:…` exclusion wins over a remembered approval, and
  `!mcp-server:*` turns project servers off.
- **Remote servers follow the same rule.** A URL the repository chose can
  receive the user's headers and the planner's tool arguments.
- **A name cannot stand in for Ordewell's.** OpenCode names a tool
  `<server>_<tool>`, so a server named `ordewell` or `ordewell_task` could
  put a tool under one of Ordewell's names, which runs without asking
  (ADR-0022, S3). For Claude Code and Codex only `ordewell` itself clashes,
  and Ordewell's own entry is written over it, so an approval of it would
  never take effect. Every reader reports such a server as unreadable: it is
  never put to approval or started, and the planner is told it was left out.
- **Decided once per conversation.** The answer is kept for the
  conversation's respawns and resumes; a new conversation decides again, and
  remembered approvals answer it without asking. A one-shot plan has no
  approval channel, so only remembered approvals start a server for it.
- **A file Ordewell cannot read is a server it does not start.** A
  definition it cannot parse is skipped, and the planner is told which file
  and why.

### OpenCode planners

- **No project config.** The planner's server runs with
  `OPENCODE_DISABLE_PROJECT_CONFIG=1`. Checked live on 2.0.26: no project
  plugin loaded, no project server started, and `AGENTS.md` was not read;
  1.18.35's source skips the same: project `opencode.json[c]`, every project
  `.opencode` directory (plugins, custom tools, commands, agents) and the
  `AGENTS.md`/`CLAUDE.md`/`CONTEXT.md` walk-up.
- **No language servers.** The planner's config sets `lsp: false`. A
  language server started for a file the planner reads can run the
  repository's toolchain (`rust-analyzer` builds, an ESLint config is code).
  2.0.26 started none on a read, with a `tsserver.js` planted in
  `node_modules`; 1.18.35's `read` warms each file it reads in its language
  servers (by source).
- **Instructions as text.** Ordewell gives the planner the first of
  `AGENTS.md`, `CLAUDE.md` and `CONTEXT.md` found from the workspace up to its
  repository root, in OpenCode's order.

### Codex planners

- **The repository is untrusted for the planner's thread.** The thread's
  config marks the workspace and every directory above it
  `trust_level = "untrusted"`. Codex keys trust on the project root, not the
  working directory, so marking the working directory alone does not hold
  in a subdirectory (checked live); every ancestor covers whatever root
  Codex settles on. Checked live: a trusted repository's project server was
  not started and its `AGENTS.md` was not read. Its hooks ran in neither
  case: Codex runs a project hook only once the user's config records its
  hash as trusted, which untrusted also turns off.
- **Instructions as text.** Ordewell puts the repository's `AGENTS.md` files
  — `AGENTS.override.md` where present, from the repository root down to the
  workspace, as Codex orders them — into the thread's developer
  instructions.

### Copilot CLI planners

- **Started outside the repository.** Under ACP, GitHub Copilot CLI 1.0.105
  runs the shell hooks in `.github/hooks/` of the directory it starts in,
  from the first prompt, trusted or not and with `disableAllHooks` set, and no
  flag turns them off. A planner's Copilot, and a read-only task's, starts in
  an empty private directory of its own instead, which is also its session's
  `cwd` and its temp directory, and reaches the worktree only by asking for
  each path ([ADR-0060](../runners/0060-acp-runners-are-data-on-one-connector.md)
  R3). Checked live with a hook planted in the worktree that writes a marker
  for each event: a writable task's start ran it, and neither restricted
  start did (`repo-hooks.jsonl`, `planner.jsonl`, `read-only.jsonl`).
- **Nothing read for it.** Copilot's profile has no repository-config reader,
  so none of the repository's servers is offered to it, and its instruction
  files reach the planner only as files it reads.

### What the repository's config can do, and how the planner launch stops it

| runner | item | can | planner launch |
| --- | --- | --- | --- |
| Claude Code | hooks (settings, skill and agent frontmatter, plugins) | run commands | user-only settings, `disableAllHooks` |
| Claude Code | `env` | redirect traffic (`HTTPS_PROXY`, `ANTHROPIC_BASE_URL`), change the runtime | user-only settings |
| Claude Code | `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `otelHeadersHelper` | run commands | user-only settings |
| Claude Code | `.mcp.json`, `enableAllProjectMcpServers`, `enabledMcpjsonServers` | start a command, reach a URL | not read; approval |
| Claude Code | allow rules, `additionalDirectories`, `allowed-tools` | skip `can_use_tool` | user-only settings; ask rules |
| Claude Code | `enabledPlugins`, `extraKnownMarketplaces` | install and run plugin code | user-only settings |
| Claude Code | `statusLine`, `fileSuggestion` | run commands (interactive only) | user-only settings |
| Claude Code | `CLAUDE.md`, imports | text | injected by Ordewell |
| OpenCode | `plugin`, `.opencode/plugin(s)` | run code in the server at start | project config off |
| OpenCode | `mcp` | start a command, reach a URL | project config off; approval |
| OpenCode | `.opencode/tool(s)` | define tools that run code | project config off |
| OpenCode | `provider` options, `formatter`, `lsp` | redirect traffic, run commands | project config off; `lsp: false` |
| OpenCode | commands, agents, modes | prompts and permissions | project config off |
| OpenCode | `instructions`, `AGENTS.md` | text | `AGENTS.md` injected; other instruction files not read |
| Codex | `mcp_servers` | start a command, reach a URL | untrusted; approval |
| Codex | hooks, `notify` | run commands | untrusted |
| Codex | `model_provider`, `model_providers`, base URLs, `otel` | redirect traffic | untrusted |
| Codex | `shell_environment_policy`, profiles, exec policies | shape the shell | untrusted; the shell stays sandboxed |
| Codex | `AGENTS.md` | text | injected by Ordewell |
| Copilot CLI | `.github/hooks/` | run commands | started in a private directory |
| Copilot CLI | MCP config, instruction files | start a command, reach a URL; text | started in a private directory |

The workspace's own environment (ADR-0016) is unchanged: it holds only what
direnv was allowed to export and an untracked `.ordewell/env`.

### Task configuration

A change or ops task keeps its runner's native configuration, because it runs
the repository's code by design (ADR-0020) and its runner stays fully native
(ADR-0018, R1). The repository's `.claude/settings.json` and
`.claude/settings.local.json` load with their hooks, helper commands (`env`,
`apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `otelHeadersHelper`),
allow rules and plugins; its `.mcp.json` servers, `.claude/hooks/`,
`.claude/plugins/`, `.claude-plugin/` and the plugin and marketplace manifests
under `.claude/` arrive as Claude Code reads them; OpenCode's project config
and Codex's `.codex/config.toml` load as their runners read them. They act at
launch, before a tool call exists for the approval policy to see. A read-only
task instead withholds project configuration and native writes as ADR-0046
specifies.

- **That is deliberate.** A task is where the repository's own tools run: its
  formatter, its lint rules, its test harness, the skills and commands its
  authors set up, and the servers that reach the systems they work with. A
  launch that stripped them would run another runner from the one the user
  types into (ADR-0018, R1), on the repository the plan named. The consent to
  that launch is the plan's approval and the task's start.
- **A gate on tool calls is not a gate on hooks or server startup.**
  ADR-0018 A1 sends a runner's tool request to a person; a hook, an `env`
  block, a helper command, plugin code and a server's startup happen before
  the first tool call and outside that channel, so A1 neither sees nor decides
  them. In Full with autorun no person approves anything: a task the planner
  writes starts on the approved plan and loads its runner's configuration as
  the user. ADR-0035 accepts the same asymmetry — in Full with autorun its
  consent rule reroutes an effect into a task rather than preventing it — and
  what holds is the approved plan, the record an attempt leaves (a log, a
  verdict, a landing) and the two launch boundaries below. Ordewell claims no
  launch-time consent it does not have.
- **Where the boundary sits.** Configuration introduced during a run reaches a
  later launch only after the user consents to it. Before a change or ops
  task's runner is spawned, the directories it reads are compared with where
  the run started, untracked and ignored files included, for the paths that
  can run code or redirect the runner: `.mcp.json`, `.claude/settings.json`,
  `.claude/settings.local.json`, `.claude/hooks/`, `.claude/plugins/`,
  `.claude-plugin/`, a `plugin.json` or `marketplace.json` under `.claude/`,
  OpenCode's `opencode.json` and its plugin, tool and agent directories, and `.codex/`
  (the list is the runners', and holds a start for any of them whichever
  runner it launches). A difference holds the start with a reason naming each
  path, so a landing that added one stops the run's later starts.
  - *A worktree* is compared with the base commit the run recorded, at the
    repository's top and, when the workspace is below it, in the directory the
    runner starts in. The `.claude` and `.opencode` directories a worktree
    links from the main checkout, and a group's loose entries shared live
    with the real workspace, are compared as the checkout is: git sees a
    link, not what a task wrote through it.
  - *The checkout* an ops task or a shared run works in has no base commit,
    and its personal files (an ignored `.claude/settings.local.json`) predate
    the run, so it is compared with its own contents when the run first
    launched a task of any kind, before a landing can reach it, at the
    workspace root and each level above it up to the repository's top, which
    the runner reads too. A run that never isolates is held the same way. The
    baseline is kept in memory for the run: a restarted daemon takes it anew at
    its next launch. A Merge all that changes the checkout holds the next ops
    start, which the user lifts by removing the configuration or starting a new
    run.
  - The baseline does not move, so a hold stands for the run: the user
    consents by reviewing the configuration and starting a run whose base holds
    it, and one they do not keep is removed. Committing it does not lift the
    hold. A run with no recorded base, and a diff git cannot take, lets the
    start through: an old saved run may have neither. A conflict repair is
    checked before its attempt reopens, and a held start keeps its worktree. A
    script task has no runner and a read-only task withholds project
    configuration (ADR-0046), so neither is checked.
- **A name cannot be taken over.** A Claude change or ops task launch reads
  the working directory's `.mcp.json` and refuses to start when it declares a
  server named `ordewell`. Claude takes MCP servers from that file and the
  user's own config and ignores an `mcpServers` key in a settings file, so
  those are not read. Claude's precedence between the files it reads and
  the `--mcp-config` Ordewell passes is undocumented, so the collision has no
  known answer: the repository's entry could replace the server the attempt's
  token travels through, and the task would lose its completion route, or run
  against a server the repository chose. The repository renames or removes the
  entry; the launch does not guess. A planner's own readers refuse such a
  server too, so it is never put to approval or started there (ADR-0022, S3).
  The file is read before the spawn, so a change made after it is outside
  this.

## Key properties

- **Nothing runs before a person or a standing rule says so.** A planner on a
  repository nobody has looked at runs the user's own configuration and
  Ordewell's, nothing else.
- **What runs is what was shown.** An approved server is passed as parsed,
  and a changed definition is a new question.
- **Instructions stay, as text.** The planner still reads the project's
  conventions; it no longer runs anything they come with.
- **One residual per runner's own reading.** Ordewell reads the files the
  runners would have read; a runner version that adds another source of
  project config is outside this until the live check covers it, which is
  why the History records the versions checked.

## Considered options

- **Keep project settings and add deny rules.** Rejected: hooks, `env`,
  helpers and `.mcp.json` are not permissions, and no rule reaches them.
- **Point Claude Code at an empty `CLAUDE_CONFIG_DIR`.** Rejected: it drops
  the user's login, settings and servers with the repository's.
- **Start project servers in Full without asking.** Rejected: a server is a
  command the repository chose, which is the thing this ADR stops; Full's
  allowance is for web reads alone (ADR-0027).
- **Approve a server by name.** Rejected: the name is the repository's to
  choose, so it would approve whatever the next repository puts under it.
- **Let the runner re-read an approved server from the file.** Rejected: the
  file can change between the approval and the start.
- **Untrusted for Codex by `CODEX_HOME`.** Rejected: a fresh home loses the
  user's login and config with the repository's.
- **`--bare` for a task launch.** Rejected: it skips the hooks, skills, custom
  commands, subagents, plugins, MCP servers and `CLAUDE.md` a repository ships,
  which is the toolchain the task was started to use; it makes a scripted call
  start faster, not a task.
- **`--safe-mode` for a task launch.** Rejected: the same strip, for
  troubleshooting a broken setup. A task that cannot load the repository's
  configuration fails the work the plan asked for, and the failure reads as
  the task's own.
- **`--strict-mcp-config` for a task launch.** Rejected: it narrows MCP
  servers alone, while hooks, `env`, helper commands, plugins and allow rules
  still load and still act first, so it is not this ADR's boundary; it would
  also drop the repository's own servers, which the task is meant to have.
- **Hold a task's first launch in a repository for a person to approve its
  configuration.** Rejected: a card cannot show what a hook does, the plan's
  approval is already the consent to the task, and in Full with autorun there
  is no person to ask.
- **Refuse a repository server named `ordewell` for planners only.** That was
  the rule. Rejected for tasks: a Claude task launch has the same collision,
  and the task could lose the very server its completion call needs.

## History

- 2026-10-11 — proposed after the live finding above; Claude Code 2.1.296,
  codex-cli 0.162.0, OpenCode 2.0.26 (and 1.18.35 by source).
- 2026-10-11 — implemented and checked live through Ordewell's own planner
  and task launches, on Claude Code 2.1.296, codex-cli 0.162.0 and OpenCode
  2.0.26, in one throwaway repository holding a project hook and an
  `apiKeyHelper` that each write a marker, an `HTTPS_PROXY` in the settings
  `env` pointing at a recording proxy, a stdio server in `.mcp.json`,
  `.codex/config.toml` and `opencode.json` that writes a marker, and an
  OpenCode plugin that writes one; Codex ran with the repository trusted.
  For every planner with the servers refused: no marker, the proxy unused,
  and the planner quoted a secret word from the repository's `CLAUDE.md`
  (Claude) or `AGENTS.md` (Codex, OpenCode), which it now has only as text.
  With the server approved, each planner started exactly it. For every task:
  the server started again; Claude's task ran both hooks and the
  `apiKeyHelper` and went through the proxy (it then failed on the helper's
  empty key, as that fixture meant it to); OpenCode's task loaded the plugin;
  the Codex and OpenCode tasks answered. Codex's trust entry in its config
  was unchanged after the planner's untrusted thread.
- 2026-10-11 — OpenCode 2.x finding and fix. On 2.0.26 an approved project
  server started, but the planner's call to its tool failed ("Unable to
  execute"): the server is passed in the 1.x config shape, which drops
  `codemode`, so 2.x listed its tools only inside code mode's `execute`, and
  the planner's request was not read as that server's tool. Now a 2.x
  planner's approved servers are replaced at runtime with `codemode: false`,
  as Ordewell's own server already was, from the transport fields of the
  definition shown (a local server's command and environment, a remote one's
  URL and headers); held servers are never sent. Replaced before anything
  lists the servers, a local one starts once; replaced later, OpenCode stops
  it and starts the new one. Its tools are then asked about as `mcp_tool`, as
  on 1.x, Claude Code and Codex. `execute` stays refused for planners: it runs
  model-written code over every MCP tool, past per-tool approval, and its
  refusal says to call the tool directly. On a 2.x without the runtime route,
  the planner is told the server is not usable on its OpenCode version, and
  the timeline shows it refused as `unsupported`. Checked live on 2.0.26:
  Guarded, approved — the server started once and the planner's call went
  through the approval and returned; Full with no allowlist entry — not
  started, no marker.
- 2026-10-11 — OpenCode 2.x `execute` finding and fix. A re-check on 2.0.26
  found `execute` running unasked: 2.x raises no permission for it, so the
  refusal described above never fired, and a planner's model-written code,
  which can call every tool and make HTTP requests, ran past the envelope.
  Every 2.x planner session is now created with an `execute: deny` rule,
  which also hides the tool from the model; the refusal note is gone. An
  OpenCode 2.x without the runtime route can offer Ordewell's own tools only
  through `execute`, so it is refused as a planner: the start fails with an
  error naming the version and asking for an update or another planner
  runner, and no session is created. Its approved project servers would stay
  unusable, never reachable through `execute`. A session's rules are fixed
  when it is created, so a planner session without the deny rule is not
  resumed; a fresh one is started instead, as for a stale session. Task
  sessions are unchanged. Checked live on 2.0.26 through Ordewell's planner:
  the model listed its tools without `execute`, a direct call to an approved
  project server's tool was asked about and returned, and `submit_plan`
  committed the plan.
- 2026-10-13 — a runner's own memory is off for planners and tasks, and a
  Claude planner's reads of its session's saved tool results, asked since
  this ADR's read rules, are allowed again
  ([ADR-0032](0032-runner-state-outside-the-workspace.md)).
- 2026-10-13 — an OpenCode project server whose name could give a tool one of Ordewell's names is not offered.
- 2026-10-13 — a Claude Code or Codex project server named `ordewell` is not offered either.

- 2026-10-21 — read-only tasks use the same repository-config restrictions as planners (ADR-0046).
- 2026-10-29 — a change or ops task's launch keeps its runner's configuration
  and states the boundary: a start whose tree differs from the run's base in a
  configuration path is held for consent, and a Claude task launch refuses a
  repository server named `ordewell`.
- 2026-10-29 — the launch check reads the runner's own directory (a workspace
  below its repository's top, a group's shared entries, the checkout an ops or
  shared task runs in), covers OpenCode's and Codex's configuration, skips
  read-only tasks, and no longer reads settings files for an `ordewell` server.
- 2026-11-04 — a Copilot CLI planner or read-only task starts in a private directory, out of reach of the repository's hooks (ADR-0060).
