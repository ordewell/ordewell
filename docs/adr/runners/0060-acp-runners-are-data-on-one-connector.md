---
status: accepted
amends: ["0008", "0009", "0018", "0022", "0023", "0025", "0026", "0028", "0046"]
---

# 0060 — ACP runners are data on one connector

## Problem

Ordewell drove three coding agents, each through a connector written for its
own protocol ([ADR-0018](0018-structured-runner-transport.md)). Many more
agents now ship a native server for the Agent Client Protocol (ACP), and the
user who has one of them installed cannot hand it a task. A connector per agent
does not scale to them, but one generic connector has to hold every rule a
native connector holds: Ordewell's tools attached before any result is accepted
([ADR-0025](0025-structured-only-runners.md)), the plan's mode and model held
([ADR-0001](../routing/0001-autonomous-mode-resolution.md)), and a planner or a
read-only task that cannot write
([ADR-0026](../planner-envelope/0026-one-envelope-for-every-planner.md),
[ADR-0046](../planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md)).
ACP agents differ in exactly those places: how they take instructions, how
they are put in a mode, whether they honour a client's MCP servers and when
they connect to them, and whether their own tools can be taken away.

## Decision

**One `AcpAdapter` drives every ACP runner, and what differs between agents is
an `AcpProfile`: data, not code.** `acpConnector(profile)` turns a profile into
the runner's entry in `CONNECTORS`, so a new ACP agent is a manifest and a
profile. GitHub Copilot CLI (`copilot-cli`, `copilot --acp --stdio`) is the
reference agent. Qwen Code (`qwen-code`, `qwen --acp`) plans and runs
read-only tasks too; Cline (`cline`, `cline --acp`) takes writable tasks only.

Ordewell is the ACP client and does no I/O for the agent: it advertises no
file-system and no terminal capability, so the agent works in the worktree
itself and reaches Ordewell only through the Ordewell MCP server it is handed
in `session/new`, or in a settings file of its own where its profile says so
(R4). A start is `initialize`, then `session/new`, or
`session/resume` or `session/load` for a resume, then the plan's mode, model
and effort; a turn is one `session/prompt`. The adapter never calls
`authenticate`: a `-32000` answer is read as signed out, and signing in is the
user's, in the agent's own terminal, or Ordewell's own: a provider key
configured once in Ordewell is handed to each spawn of an agent whose profile
asks for it, in the variables that agent reads, and an agent that over ACP
ignores the key its own login stored is handed that key instead where
Ordewell holds none it can use (R9). Any other request from the agent is
answered `-32601` at once, so a turn never waits on Ordewell; a profile may
instead answer the agent's own methods that hold its turn until the client
replies (`extensionRequests`), and a request its handler cannot read keeps the
`-32601`. ACP's client namespaces (`session/`, `fs/`, `terminal/`) are never
served from a profile, so no profile can make Ordewell do I/O for the agent.

The protocol is spoken from vendored v1 types (`acpSchema.ts`, checked with
zod) on a protocol-neutral JSON-RPC peer (`jsonRpc.ts`). Every object passes
unknown fields through, an enum-like field is any string, and a message that
does not fit is reported, never thrown, because agents add fields and kinds
ahead of the specification.

A profile holds the manifest, the ACP arguments, the minimum agent version
read from `initialize`'s `agentInfo`, the setup timeout, how the agent names
Ordewell's tools in its reports and to the model, how a model reaches it at
spawn, the instructions route, the route Ordewell's MCP server takes where
it is not `session/new`, when the agent first uses its token (R5), the mode
route, what it loads from a repository
(ADR-0028), the roles it claims, the controls that restrict it, the
answers to the agent's own requests, and where an agent needs one, the reader
of its provider credential and the sign-in route that reader adds.

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
    write and shell tools, or makes the agent ask before every use of them
    so that Ordewell's refusal below decides each one, and is shown to hold
    under ACP;
  - Ordewell refuses every `edit`, `delete`, `move` and `execute` permission
    request, and every switch of mode, on those starts (`decideRestricted`),
    by the kind the request names or the kind the turn reported for the same
    call, except Ordewell's own tools, pre-allowed by exact name (R7);
  - a recorded live run shows a write attempt and a shell attempt refused,
    with nothing left behind.

  A planner or a read-only task also runs nothing the repository's config
  names (ADR-0028). An agent that loads configuration from the directory it
  starts in, with no switch of its own to stop it, starts there in a private
  directory instead (`restricted.privateCwd`): owner-only and holding only
  what the start hands it, its instructions, its MCP settings file where the
  profile has one (R4), and the restriction's own files and config homes,
  the session's `cwd` and its temp directory too. It then
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

  The restriction is data on the profile, whatever form the agent's own
  controls take. For an agent with a deny list they are arguments and
  variables, as Copilot's are. For an agent with no deny list that can be
  made to ask before every write, edit and command, they are the arguments
  that put it in that mode, as Qwen's are, and Ordewell's refusal by kind is
  what denies. An agent that defers an MCP tool until the model loads it
  names its loading tool (`restricted.toolSearch`), and a restricted start's
  first prompt tells the model to load each Ordewell tool with it. For an
  agent whose controls are a settings file or a hook, they are also files and
  config homes in the process's private directory:
  - `restricted.files`: each written 0600 into that directory, never the
    worktree, and named to the agent by a variable, by a flag, or by another
    of these files, as a hook's settings name its script. A file is rendered
    from the directory's path alone, so neither the provider key (R9) nor the
    token reaches it and none holds a secret; a hook that must reach Ordewell
    does so with the attempt's token as the MCP settings file holds it (R4).
    Nothing there is executable, so a hook's settings name its interpreter.
  - `restricted.configDirs`: variables that move the agent's home of
    configuration, each set to an empty 0700 directory of its own in the
    private directory, so the user's global rules, hooks, plugins and skills
    do not load in a planner or a read-only task.

  Both apply on a planner's start and a read-only task's alone, share the
  private directory's life (R4), and are refused under a placement, whose
  container would be handed variables naming paths it does not have. They
  are a layer beneath Ordewell's refusal by kind, never in its place, and
  neither is a role's evidence: a role still needs the recording above. A
  profile without them spawns exactly as before.
- **Ordewell's tools go over HTTP, with the token in `session/new` or in the
  agent's own settings file (R4).** To an agent whose `initialize` advertises
  `mcpCapabilities.http`, the server is given as one `http` entry in
  `mcpServers`, its token as a header, so the token reaches the agent over
  stdin and never as an argument (ADR-0022 A5). It is given again on every
  resume and load, since the agent keeps no session's servers between
  processes. An agent can accept `mcpServers` and never connect to them, yet
  load MCP servers from a settings file of its own, as Cline 3.0.74 does. Its
  profile then has an
  `mcpConfig` route: a file name, how to render the agent's settings format
  from the server's name, URL and headers, and the environment variable that
  names the file's path to the agent. The adapter writes that file for each
  process, and it holds Ordewell's server alone, its token in the headers.
  The file is:
  - the process's own, so two attempts running at once have two files, each
    holding only its own attempt's token;
  - written 0600 into the process's private directory, which is 0700, in the
    temp directory and never in the worktree, the same directory that holds a
    file-route's instructions (R6) and a restricted start's own files and
    config homes (R3);
  - removed with that directory when the process ends, or when it is
    disposed;
  - swept at a later start if Ordewell died before removing it. The private
    directory's name carries the process id of the Ordewell that made it
    (`ordewell-acp-<pid>-XXXXXX`). Making a private directory first removes
    those directories whose maker is no longer running, that this user owns,
    and that are directories, not links, and nothing else in the temp
    directory;
  - not evidence of an attach. The attach is still read from the server (R5),
    so an agent that is handed the file and never uses it is refused, as an
    agent that never connects is.

  ACP asks a client to check `mcpCapabilities.http` before it hands an HTTP
  server, so `session/new` gives an agent that advertises no HTTP an empty
  `mcpServers`. A profile with `mcpConfig` is refused under a placement:
  a container receives only files named in the arguments, so the variable
  would name a path it does not have. An agent that advertises no HTTP and
  whose profile has no `mcpConfig` is refused in plain words: it "cannot take
  Ordewell's tools over HTTP, so it cannot run tasks or plan here".
- **The attach is read from the server's first contact, before any result is
  accepted (R5).** ACP has no MCP status notification. The attach state is the
  Ordewell MCP server's own record (`McpContact`): connected once a request
  carrying the token has passed every check, failed when the agent refused the
  session or the process is gone, pending until then (ADR-0022 S2, S4). The
  profile's `attach` says when that contact can come:
  - `sessionNew`, the default: while the session opens, so the task is sent
    only once the server was contacted, as for a native runner (ADR-0025).
  - `firstTurn`: only once a prompt starts the agent's runtime, for an agent
    that connects its MCP servers then, as Cline 3.0.74 does. An agent that
    made contact by the time its session opened goes on as under
    `sessionNew`. Otherwise the task's prompt is the check: the attach passes
    only if the server is contacted before that turn ends, within the attach
    timeout counted from the turn's start. Until it passes the session's
    listeners hear nothing of the turn; its events, text, requests and report
    are held, then heard in order. A turn that ends or runs out of time
    without contact fails the check: its process is killed, its token revoked
    and everything it said dropped, then the respawn and the hold follow as
    for any missed attach, with the same "Could not start <name> with
    Ordewell's tools, so the task was not sent to it." A held task gives up
    its worktree, and the discarded turns' edits with it. A contact after the
    turn ended is refused, since its token was revoked first.

  So the invariant is that no result is accepted from an agent without
  Ordewell's tools, not that no prompt reaches one: a `task_complete` counts
  only through the token-bound tool, so a turn that never reached the server
  can report nothing. Its cost is a wasted model turn per missed attach, two
  when the respawn misses too. The respawn works in the same worktree, so it
  finds what the discarded turn changed there, and what it keeps of that is
  its own result. A `firstTurn` agent cannot plan, and `acpRoles` refuses the
  claim at load: a planner's first turn is the goal, never sent without tools.
  Nor can it be re-attached after an ignored interrupt killed its process,
  since that restart has no prompt to check with, so the task fails then. The
  discarded turn stays in the agent's own history should that session ever be
  resumed.

  A restricted start's own files and config homes (R3) change none of this:
  none carries the token, so the attach is read from the server as on any
  start, and a config home that hides the route by which the agent finds
  Ordewell's server shows as a missed attach, never as one that passed.
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
- **An agent's provider key comes from Ordewell, else from its own store, for
  one spawn (R9).** A key configured once in Ordewell, with `/key` or the
  variable it writes, serves the agents as it serves the planner, so no agent
  needs a login of its own. And an agent can ignore over ACP the login its own
  CLI stored: Cline 3.0.74 answers `session/new` with `-32000` though `cline
  auth` saved an OpenRouter key, and runs when `CLINE_PROVIDER`,
  `CLINE_API_KEY` and `CLINE_MODEL` are in its environment. Such a profile has
  a `credentials` hook, which answers, under the host's and the workspace's
  variables, the variables to add to that spawn's environment. In order:
  1. **The user's own variables for the agent.** Where they already hand it a
     provider (`CLINE_API_KEY` for Cline, `OPENAI_BASE_URL` for Qwen), the
     hook adds nothing and reads nothing.
  2. **Ordewell's provider** (`ordewellProvider.ts`): the vendor `AI_PROVIDER`
     names, else the first configured in `PROVIDER_PRIORITY`, read by the same
     key and base-URL rules the planner's config uses (`vendorApiKeyIn`,
     `vendorBaseUrlIn`). Only an OpenAI-compatible vendor with a key
     qualifies, and `openai_compatible` only with its base URL named, and
     only one the agent reaches at the endpoint Ordewell reaches it at: a key
     is never sent anywhere its owner did not send it. Qwen reads any
     OpenAI-compatible endpoint, so it is handed `OPENAI_API_KEY` and
     `OPENAI_BASE_URL`. Cline takes no endpoint from its environment, so it
     is handed `CLINE_PROVIDER` and `CLINE_API_KEY` only for a vendor whose
     Cline provider id defaults to Ordewell's endpoint (OpenRouter is
     `openrouter`, OpenAI `openai-native`; `clineCredentials.ts` lists them),
     and not for one behind a proxy or on another region's host. The model
     (`OPENAI_MODEL`, `CLINE_MODEL`) is the planner's, prefix stripped, only
     when `AI_PROVIDER` named that vendor, since no other model of Ordewell's
     is that vendor's for certain; the plan's model still reaches the agent
     at spawn or as a config option, so this is only the agent's default.
     This route comes before the agent's own store: the key the person gave
     Ordewell is their choice for every agent.
  3. **The agent's own store**, where it has one and ignores it over ACP: read
     as [ADR-0051](../platform/0051-opencode-go-limits-from-the-selected-login-read-in-place.md)
     reads OpenCode's, from the store the agent itself names and nowhere else
     (its G2), with nothing refreshed, written, copied or kept beyond the
     read. For Cline that is `CLINE_PROVIDER_SETTINGS_PATH`, else
     `~/.cline/data/settings/providers.json`, and the provider, key and model
     of the entry it last used. Qwen reads its own settings and sign-in
     itself, so its hook answers nothing here.
  4. **A refusal naming both routes.** Cline's hook refuses the start before
     anything is spawned, naming the store and the routes: "Set the key of a
     provider Cline offers, such as OpenRouter, in Ordewell with `/key`, or
     sign in with `cline auth` (a Cline or ClinePass account, or a provider's
     key), or set CLINE_PROVIDER and CLINE_API_KEY in Ordewell's
     environment." Qwen learns it is signed out from its own `-32000`, and its
     profile's `signInRoute` adds Ordewell's route to the login the message
     names: "Qwen Code is not signed in. Run `qwen`, or set the key of an
     OpenAI-compatible provider, such as OpenRouter, in Ordewell with `/key`."

  A model the user's environment chooses for the agent stays theirs. What the
  hook answers holds a secret and goes into that spawn's environment, the
  only place the key goes, under ADR-0051's rules:
  - read afresh at each spawn and held by nothing after it, so two attempts
    running at once each have their own, and a sign-in or `/key` between two
    spawns is the second's;
  - never logged, never in an error, never written to disk, never in the
    arguments, and never sent over ACP, so not to a model, the planner or a
    webview;
  - not read, and nothing added, under a placement: a container holds the
    lease's stand-in for a key, never the user's own
    ([ADR-0059](../isolation/0059-an-execution-lease-reserves-in-the-claim-and-opens-after-it.md) L7);
  - read for model discovery's start too, which the manifest's
    `modelDiscovery.acp` gives the profile's own `env` and hook: the agent is
    asked as it runs, and a hook that finds no key is no answer, so nothing is
    spawned and the miss is not cached past a sign-in.

  A profile without the hook spawns exactly as before, whatever Ordewell holds.

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
| mode | the `mode` config option, set after `session/new` (`default`, `auto-edit`, `yolo`) on a task's start; the manifest offers no `auto`, Qwen's default, because an LLM classifier decides there. Its read-only mode `plan` is Ordewell's, set as Qwen's `default` (`permissionModeValues`), never Qwen's own `plan` |
| model | `--model` at spawn and the `model` config option, whose ids carry a provider suffix (`openai/gpt-4.1-mini(openai)`) |
| Ordewell's tools | `_meta.toolName` of the permission request, `mcp__ordewell__<tool>`; the title is the call's arguments, which the model writes, and the kind is a guess, so neither is read |
| restriction | `--approval-mode default`, so Qwen asks before every write, edit and command, and a private start directory that is also its temp directory; `tool_search` named as the loader of Ordewell's deferred tools |
| repository | no reader: a restricted start is handed none of the repository's instruction files |
| roles | the planner, and a read-only mode (`plan`) |

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
that is how a signed-out Qwen is learned. Its profile's `credentials` hands
it the provider key configured in Ordewell through the `OPENAI_*` variables
its `openai` sign-in reads, and its `signInRoute` names that route (R9).

Qwen has no flag that takes its write or shell tools away, and its own
`plan` mode cannot be the control: live, it refused a write itself but
refused `task_complete` too, and a request to switch modes leaves it. Under
`default` it asks before every write, edit and command, and Ordewell refuses
each by its kind, a mode switch included. Started in its worktree under that
control, Qwen ran a hook planted in the repository's `.qwen/settings.json`,
with nobody asked, and rewrote that file (ADR-0028). Started in a private
directory that is also its temp directory, it ran no hook and reached the
worktree only by asking for each path, so every read went to the envelope or
to the read-only task's rules.

The recordings of the restricted starts show it holding, each started in an
empty private directory with nothing left behind and no hook run:
- `restricted-write.jsonl`: a `write_file` request, kind `edit`, refused, and
  no file written;
- `restricted-shell.jsonl`: a `run_shell_command` request, kind `execute`,
  refused, and no command run;
- `planted-hook.jsonl`: a read-only task in a workspace whose
  `.qwen/settings.json` plants a hook, which did not run;
- `planner.jsonl`: a planner that loaded each Ordewell tool with
  `tool_search`, then called `list_runners`, `list_models`, `submit_plan`
  and `run_plan`, each pre-allowed by name;
- `read-only.jsonl`: a read-only task that read a file in the worktree by
  asking and reported with `task_complete`.

A refused request ends Qwen's turn, so a read-only task that asks to write
stops there and is reminded to call `task_complete`
([ADR-0018](0018-structured-runner-transport.md) W1). A planner given no
model sets no config option: Qwen stays in the `default` its arguments set.
Qwen still loads its user's own `~/.qwen/settings.json`, hooks included,
since the profile moves no config home, and loads none of the repository's
`QWEN.md` or `AGENTS.md` from a private directory, which no reader hands it
instead.

Its models come from ACP discovery alone: `session/new` lists the models its
settings configure, and there is no command to fall back to.

## Cline

Checked against Cline 3.0.74, the profile's `minVersion`, and the recordings
in `packages/core/src/services/__tests__/fixtures/acp/cline/`, made with an
OpenRouter model and its key handed in the spawn's environment (R9):

| profile field | Cline |
|---|---|
| instructions | the first prompt: no instruction file or `_meta` slot outside the worktree is read by an ACP start |
| mode | `--auto-approve true` under `autoApprove`, `--auto-approve false` under `default`, passed on every start because Cline's default is `true`; its `plan` session mode is not used, and every start stays in `act`, the mode `session/new` reports |
| model | the `model` config option, set after `session/new` and read back; its ids are the provider's (`openai/gpt-4.1-mini`) |
| Ordewell's tools | the permission request's title up to its first colon, `ordewell__<tool>`: Cline titles a call with its tool's name, then a summary of the model's arguments, and gives the kind `other` to its own edits and to MCP calls alike, so the kind is not read |
| MCP server | `mcpConfig`: `cline_mcp_settings.json`, one `streamableHttp` entry with the token in its headers, named by `CLINE_MCP_SETTINGS_PATH`; `session/new` and `session/load` carry an empty `mcpServers`, since Cline advertises no HTTP |
| attach | `firstTurn` |
| credentials | the provider configured in Ordewell where Cline reaches it, else Cline's own store (R9) |
| environment | `CLINE_SESSION_BACKEND_MODE=local`, so the session lives in the process Ordewell starts and stops, never in a hub daemon that outlives it |
| restriction | none |
| roles | none: Cline is task-only, since it has no shell allow or deny list and no recording shows its `plan` mode refusing a write and a command (R3) |

In every recording of a new session Cline has not contacted the server when
`session/new` answers, and contacts it from the settings file once the prompt
runs, before its first tool call: the first turn is the attach (R5). A
`session/load` contacts it while the load runs (`load.jsonl`), so a resume is
attached before its turn, as under `sessionNew`; the load first replays the
session's history as updates, which come outside a turn and are dropped. Two
attempts at once each read only their own file and token
(`concurrent-a.jsonl`, `concurrent-b.jsonl`), and no recording leaves a private
directory or a Cline process behind.

Under `--auto-approve false` Cline asks about every edit, every command and
every MCP call, Ordewell's own included, with the options `allow_once`,
`allow_always` and `reject_once`; Ordewell's tools are allowed by name
(`ordewell-tool.jsonl`), an edit waits for the plan's answer (`edit.jsonl`),
and a refused edit leaves nothing (`deny.jsonl`). Just before a request the
turn sends a `tool_call_update` under the same title for a call it has not yet
reported, and reports the call itself only once the request is answered. Under
`--auto-approve true` Cline asks about nothing (`allow-all.jsonl`). A cancel
ends the turn `cancelled` and the pending request is answered `cancelled`; the
command it asked to run did not run (`cancel.jsonl`).

The turn reports a call under the same title, so the transcript names
Ordewell's call with its arguments' summary
(`ordewell__task_complete: {"status":"done",…}`). Cline signs in with
`cline auth`, which has no status command: with no key from Ordewell, a store
with no key refuses the start before anything is spawned (R9), and a `-32000` from `session/new` is
read as signed out. Its models come from ACP discovery alone: started with
the profile's environment and the key its reader finds (R9), `session/new`
lists its provider's models, and there is no command to fall back to. Without
the key it refuses `session/new` with `-32000`, so a store with no key lists
no models.

Cline loads its user's own configuration in every attempt:
`CLINE_DIR`, else `~/.cline`, and the global `~/Documents/Cline` with its
`Rules`, `Hooks`, `Workflows` and `Skills`. The profile sets neither
`CLINE_DIR` nor `CLINE_DATA_DIR`, so a user's global rules and hooks run inside
Ordewell's attempts.

## Testing decisions

- **Recorded fixtures are the agent's evidence.** A recording is the JSONL of
  every line each side sent, with notes for the spawn arguments and what the
  live run left behind. `copilotCli.test.ts` replays the agent's side against a
  live adapter and Ordewell server, and `qwenCode.test.ts` and
  `clineCode.test.ts` do the same for Qwen and Cline; a claim about the agent
  cites a recording. Cline's replay also answers the MCP calls the recording
  shows from the file it was handed, with the attempt's own token, so its
  first-turn attach, its resume and its concurrent attempts are judged by the
  server as live.
- **`fakeAcpAgent`** scripts an agent for the adapter's own tests
  (`acpAdapter.test.ts`, `acpCancelRace.adversarial.test.ts`), and
  `fakeRunners.ts` gives the connector contract tests an ACP runner. It can
  read its MCP servers from a settings file its environment names, and records
  each read, so the tests show the `mcpConfig` route's file read, its lifetime,
  one token per concurrent attempt, the sweep, and the refusal of an agent
  that ignores the file, without a live agent. It also records what each
  variable its `loads` names held at spawn, a file's text or a directory's
  entries, so the tests show a restricted start's own files 0600 at the paths
  the variables name, outside the worktree, and its config homes empty; both
  gone with the process and swept after a crash; two attempts with two
  directories; a writable task and Copilot's restricted starts spawned as
  before; a placement refused; and a start so restricted still refusing a
  write and a command by kind.
- **The credential hook** is tested in `acpAdapter.test.ts` with a scripted
  hook, with Cline's reader on a store in a temporary home, and with Qwen's
  and Cline's hooks on a key configured in Ordewell: the spawn's environment
  carries the key; the log, the events, the arguments, the agent's transcript
  and the start's errors do not; a profile without the hook spawns as before,
  a key in Ordewell or not; two attempts at once each get their own key; and a
  placement gets none. The tests blank the host's provider variables
  (`ordewellProviderEnv.ts`), so a developer's own key decides nothing.
  `clineCredentials.test.ts` covers the precedence, Ordewell's vendors Cline
  is and is not handed, the store path, the last-used entry, and each
  refusal; `qwenCredentials.test.ts` covers Qwen's precedence and variables;
  and `qwenCode.test.ts` replays Qwen's recordings with Ordewell's key in the
  spawn and signed out, and its restricted recordings as a planner and a
  read-only task: the spawn's arguments and private directory, the write and
  the command refused by kind, the reads and Ordewell's tools allowed, and
  the instructions naming `tool_search`. `ModelDiscovery.acp.test.ts`
  covers discovery's env and hook, and `clineCode.test.ts` runs discovery
  against a Cline stand-in that refuses `session/new` without the key from a
  store.
- `acpEvents` is a pure reducer from `session/update` to Ordewell's agent
  events, tested on its own.

## Out of scope

- **A stdio-to-HTTP MCP bridge.** An agent that takes only stdio MCP servers
  would need a local process carrying the token; it is refused instead, until
  such an agent is worth the bridge.
- **Agents beyond Copilot CLI, Qwen Code and Cline.** Gemini CLI and Goose wait
  for the same live probe those passed before they are admitted at all.
- **A key kept outside the environment.** The hook reads the host's and the
  workspace's variables, where the CLI's `/key` writes; a key VS Code keeps in
  its secret store, and its `aiProvider` setting, reach no agent until the
  extension hands them to the runner's environment.
- **Cline signed in to a Cline or ClinePass account.** The recordings use a
  provider's key. No recording shows what an account's sign-in stores or a
  task run on it; where the reader finds no key in the entry Cline last used,
  the start is refused with both routes (R9).
- **A resumed restricted start.** A resume begins in a new private directory
  and hands it to `session/load`; no recording yet shows Copilot or Qwen resuming a
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
- **Ordewell's server added to the agent's own settings, in the user's
  config directory.** Rejected for an agent that ignores `session/new`'s
  servers: that file is shared by every process and attempt of the agent, the
  user's own included, so two attempts would race on it and one could read the
  other's token, and a crash would leave a token in the user's settings. The
  route's file is one process's own, named to it by a variable.
- **A restricted start's hook or settings in the worktree or the user's
  config home.** Rejected for the same reasons: the worktree's files land with
  the task, and the user's home is shared by every process of the agent, the
  user's own included. The private directory is the process's own and goes
  with it.
- **A restriction written as code for each agent.** Rejected by R1: an agent
  whose controls are a hook or a settings file differs from one with a deny
  list only in which files and variables it needs, which a profile can state.
- **The token or the provider key rendered into a restricted file.**
  Rejected: a hook needs neither to refuse a write or a command, and a file is
  one more place a secret sits on disk (R9). A file is rendered from the
  directory's path alone.
- **Leftovers left to the system's temp cleaning.** Rejected: a token would
  sit on disk for as long as the system keeps its temp files. The sweep
  removes only what a dead Ordewell made, by the name and owner it gave it,
  so a running Ordewell's directory and anything not Ordewell's are never
  touched.
- **The attach taken from the agent's own word.** Rejected: ACP has no MCP
  status notification, and an agent may accept `mcpServers` and never use them
  (Cline 3.0.74, cline#15504; Kiro before April 2026, Kiro#7349). The server's
  first contact is evidence; an accepted `session/new` is not.
- **A throwaway first prompt that starts the agent's runtime before the
  task.** Rejected for a `firstTurn` agent: it costs a model turn on every
  start rather than on a missed attach, and leaves a prompt that is not the
  task in the agent's history, which a resume replays.
- **A `firstTurn` agent's result accepted without contact.** Rejected: an
  agent that never reached the server has no token-bound `task_complete`, so
  its stop reason or its word would be the verdict (ADR-0025).
- **A contact after the first turn ended accepted.** Rejected: that turn is
  the check, and waiting past it would only hold every missed attach for the
  whole timeout. A turn's end decides it.
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
- **Qwen's `plan` mode as the control for its roles.** Rejected: live, it
  refused a write itself but refused Ordewell's `task_complete` too, so a
  planner or a read-only task could not report, and a request to switch
  modes leaves it. Qwen's `default`, asking before every write and command,
  with Ordewell refusing each by kind, is the control. Cline's `plan` mode is
  not offered for want of evidence, and Cline has no control that takes its
  shell away.
- **A Qwen `PreToolUse` hook refusing writes and commands, through
  `QWEN_CODE_SYSTEM_SETTINGS_PATH`.** Not used: live, it held even under
  `yolo` and let Ordewell's tools through, so `restricted.files` could hand
  it as a second layer. It is left out while the refusal by kind holds alone
  in every recording, since each layer is one more file per start.
- **Cline's `--auto-approve` left to its default under `default`.** Rejected:
  its default is `true`, so a plan that asks for approval would run every edit
  and command unasked (ADR-0001). The profile passes the flag on every start.
- **Cline's session left to its own backend.** Rejected: left to choose, Cline
  may start or join a hub daemon that outlives the attempt and serves other
  sessions, so the session would not end with the process Ordewell stops.
  `CLINE_SESSION_BACKEND_MODE=local` keeps it in that process.
- **Ordewell calling `authenticate` with the stored key.** Rejected: ACP's
  auth methods are the agent's to name and differ by agent, signing in stays
  the user's
  ([ADR-0052](../routing/0052-a-signed-out-coding-agent-is-flagged-and-signs-in-from-the-chat.md)),
  and the key would cross the protocol, where a recording keeps it. The
  spawn's environment is the route the agent documents.
- **The key copied into a settings file for the agent, as `mcpConfig` does
  for the token.** Rejected: a file is one more place the key sits on disk,
  where the variables the agent already reads hold it only for the process.
- **The store read once and the key kept for later spawns.** Rejected: a held
  key outlives the spawn that needed it, and a sign-in or a switch of provider
  in between would not be seen.
- **Steering through a prompt sent mid-turn.** Rejected: v1 defines no
  injection, and a second `session/prompt` during a turn is not specified to
  join it. The turn-end queue is what v1 supports.

- **The agent's own store before the key configured in Ordewell.** Rejected:
  the person configured that key for Ordewell's work, and a store left by an
  earlier sign-in would decide otherwise without their seeing it. The cost is
  that a key in Ordewell also moves an agent signed in to its own account onto
  that key's billing; the user's own agent variables still win.
- **Handing Cline the key of any vendor Ordewell reaches.** Rejected: Cline
  takes no endpoint from its environment, so a key Ordewell sends to a proxy,
  another region's host or a custom endpoint would go to Cline's default
  host for that provider instead.

## Consequences

- Admitting an ACP agent is a probe, a recording, a manifest and a profile,
  with no adapter code. What the probe must show is in CONTRIBUTING.md's ACP
  section.
- A runner can be task-only: where a profile claims no planner role, `plans`
  is false, and the runner runs tasks, is listed and signs in like any runner
  but never appears among the planners. Copilot CLI and Qwen Code claim the
  role, so they plan like the native runners.
- A restricted Copilot names the worktree's files by their full path, since
  its own relative paths name the private directory; its instructions tell it
  where the workspace is.
- An agent that connects its MCP servers only on its first turn can run
  tasks, but each missed attach costs a model turn, and a discarded turn may
  have changed the worktree the respawn starts in.
- A runner id shares the planner setting's namespace with the API vendors'
  ids, so an ACP runner id must not equal one (`kimi-cli`, not `kimi`;
  `qwen-code`, because `qwen` is DashScope's; `cline` is no vendor's).
- Cline's transcript names each call with its arguments' summary, since that
  is the title it reports the call under.
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
- 2026-11-04 — R4: an agent that takes Ordewell's server only from a settings
  file of its own is handed one per process (`mcpConfig`), and `session/new`
  carries the server only to an agent that advertises HTTP.
- 2026-11-04 — R9: an agent that ignores its own stored login over ACP is
  handed its provider key at spawn by the profile's `credentials` hook, read
  from the agent's own store as ADR-0051 reads OpenCode's; Cline's reader is
  written, for a profile not yet admitted.
- 2026-11-04 — R5: a profile may attach on the first turn (`attach:
  'firstTurn'`), the task's prompt as the check, kept only when the server
  was contacted before it ended; such a profile cannot plan.
- 2026-11-04 — Cline (`cline`) is admitted on its recordings, for writable
  tasks only, through `mcpConfig`, `attach: 'firstTurn'` and `credentials`.
- 2026-11-04 — R9: model discovery starts an ACP agent with its profile's
  `env` and credential hook, so Cline lists its models with its key in its
  store only.
- 2026-11-04 — R9: the provider key configured in Ordewell comes before the
  agent's own store, handed to Qwen and Cline in the variables each reads;
  a signed-out message names that route (`signInRoute`).
- 2026-11-04 — R3: a restricted start may hand the agent owner-only files and
  empty config homes in its private directory (`restricted.files`,
  `restricted.configDirs`), for an agent whose controls are a hook or a
  settings file; no profile uses them yet.
- 2026-11-04 — R3: Qwen Code plans and runs read-only tasks from a private
  directory under `--approval-mode default`, Ordewell refusing each write and
  command it asks for; a restricted start names the agent's deferred-tool
  loader (`restricted.toolSearch`).
