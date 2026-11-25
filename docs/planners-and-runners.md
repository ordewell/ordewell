# Planners and runners

Ordewell uses a model in two roles. The **planner** reads your repository and writes
the plan; it never writes code. A **runner** runs one task of the plan in its own session: either a coding-agent
CLI, such as Claude Code, Codex or OpenCode, or Ordewell's own
[built-in runner](#the-built-in-runner), which needs only a provider key. The two
get their models and credentials in different ways, described below.
[CONTEXT.md](../CONTEXT.md) defines these terms.

## Who plans

`ordewell planner` lists the two kinds of planner. `/planner` (or `/model`, its alias) in the terminal UI or in
VS Code, or the planner bar in VS Code, picks one. `/task-model` is a different command: it sets one task's model.

A **harness planner** is a coding agent planning: pick a runner such as `claude-code`,
`codex`, `opencode` or `pi`, and the planner conversation runs through that agent
([ADR-0009](adr/planner/0009-coding-agents-as-planners.md)). Ordewell asks for no API
key, because the agent is signed in on its own and the account you already use with
it pays for planning. The planner's models and effort levels come from the same list
Ordewell discovers for that runner's tasks, described below.

A harness planner explores with its own subagents within its turn: Claude Code's
`Agent` tool, Codex's subagents. OpenCode's own would run with whatever permission their
agent has, so Ordewell denies them and offers its own read-only research agent instead,
as the tool `spawn_research_agent`. The agent only reads the workspace: no shell, web or
MCP tool, and no agent of its own
([ADR-0066](adr/planner-envelope/0066-opencode-planners-get-ordewells-research-agent.md)).
A Pi planner has no agents of its own, so it delegates exploration through research tasks, as the ACP planners do.

On OpenCode 2.x it needs no setting: it runs on your own OpenCode login and the
planner's model, in a second `opencode serve` that Ordewell starts on the planner's
first call and closes when the planner session ends. That serve loads none of your
OpenCode configuration, MCP servers or plugins, and Ordewell checks what it loaded
before using it. Each call is a session in your OpenCode history, titled
`Ordewell research: …`. If the serve fails that check or cannot start, or your login
cannot run the planner's model, the chat says why once and the planner delegates with
research tasks for the rest of the session
([troubleshooting](troubleshooting.md#the-research-agent-is-unavailable-on-opencode)).
On OpenCode 1.x the planner always delegates with research tasks.

To run it on an API provider instead, on OpenCode 1.x or 2.x, name its model:

```bash
# .ordewell/env, or exported where the daemon starts
ORDEWELL_RESEARCH_AGENT_MODEL=openrouter:deepseek/deepseek-v4.1-flash
```

The value is `<provider>:<model>`, the provider one `ordewell planner` lists, and the
agent pays with that provider's own key, `OPENROUTER_API_KEY` here, billed apart from
the planner's login. Google Gemini cannot serve it. Set, the variable wins over the
login; with a value that cannot serve an agent, such as a provider whose key is
missing, the planner delegates with research tasks and the chat says why.

An **API planner** calls a provider's API, with your key where the provider needs
one. It reaches Anthropic natively through the Messages API, with prompt caching and
extended thinking at the planner's effort, and OpenAI through the Responses API;
Google Gemini and every other provider have their own paths, all through one
provider-neutral client that also retries and reports usage limits. Providers include OpenRouter, Google Gemini, DeepSeek, Moonshot / Kimi and xAI;
`ordewell planner` shows the full list and marks each provider whose key is missing
with the environment variable it reads, such as `(no DEEPSEEK_API_KEY)`. The
planner's model is one of that provider's models.

Until you pick a planner, an installed coding agent that is signed in plans, ahead
of any provider key Ordewell finds in your shell or saved in Ordewell: a key on its
own never switches planning to its provider, or spends its credit. That provider
plans when you pick it with `/planner` (or `ordewell planner <id>`), when you saved a
planner model for it, or when no coding agent is installed. When a key is passed
over, the first screen says so once
([ADR-0076](adr/planner/0076-an-installed-coding-agent-outranks-a-found-api-key.md)).

A provider key adds an API planner and also lets the built-in runner run tasks on
that provider's models; an installed coding-agent CLI is separate. A `DEEPSEEK_API_KEY` or
`MOONSHOT_API_KEY` lets DeepSeek or Kimi models plan, and the built-in runner run
tasks on them. An installed Qwen Code or Cline does run on that key, though, so neither
needs a login of its own: the key of the provider `AI_PROVIDER` names, else the first
one configured, is handed to it at each start, its start as the planner included.
Qwen Code takes any OpenAI-compatible provider's key; Cline takes the key of a
provider it offers at the same address, such as OpenRouter. Gemini CLI can also use a Google Gemini key saved in Ordewell; it is handed
to Gemini CLI as `GEMINI_API_KEY` unless an explicit Gemini credential route
is already configured. Where Ordewell holds no applicable key, each agent uses
its own sign-in.

## Who runs tasks

Every AI task runs on a runner. A coding-agent CLI is set up outside Ordewell, and the
[built-in runner](#the-built-in-runner) needs only a provider key:

- **Installed.** The runner's CLI must be on your PATH. `ordewell runners` lists the
  runners and marks the ones offered to the planner.
- **Signed in.** A runner uses its own login, set up with its own CLI. `/login`, in
  the terminal UI or VS Code, runs the sign-in command of an agent that has one.
- **Its own models.** A task's model comes from its runner's choices. Ordewell
  discovers each runner's models from the runner itself where it can. When it cannot,
  or when the runner leaves some out, the list can include the runner's cached catalog
  or Ordewell's built-in defaults for that runner, and a model that reports no effort
  levels can get Ordewell's built-in effort levels for that runner. The model pickers
  group the models by runner and by the backend that serves them, such as
  `OpenCode · openrouter`.

In VS Code, `/refresh` discovers runner models again. In the terminal UI and the CLI,
`/refresh` and `ordewell refresh` re-read the daemon's catalog, so a list that loaded
successfully stays until the daemon restarts or a provider key or base URL changes.

The planner gives each AI task a runner, a model, a thinking effort and a mode, and
you can change any of them before the run. A model an API planner can use is not
thereby one a runner offers: pick a task's model from its runner's choices.

## Pi

[Pi](https://pi.dev/docs/latest) 1.5.2 or later runs tasks and plans, driven over
its RPC mode (`pi --mode rpc`). Its models are the ones `pi --list-models` lists,
from every provider you signed it in to (`pi auth login <provider>`, or the
provider's own API key), named `<provider>/<model>`, with Pi's thinking levels as
the efforts of a model that thinks.

Pi asks before nothing, so a writable Pi task runs Pi's own tools, its shell and
its file edits included, without a per-tool approval, under Full and Guarded
alike: there is no Pi request for Ordewell to put to you. Pick a read-only mode,
or another runner, for a task that should not change anything on its own.

A Pi planner, and a read-only Pi task, start with Pi's `read`, `grep`, `find` and
`ls` and Ordewell's tools alone, without your Pi extensions, the repository's
`.pi/` settings, extensions and MCP servers, or Pi's own context files: Ordewell
hands them the repository's `AGENTS.md` and `CLAUDE.md` files as text instead,
none from above the repository root or through a link out of it. Pi still starts
the MCP servers in your own Pi `mcp.json` on these starts, but offers none of
their tools. Each read asks Ordewell first. A
planner's read inside the workspace runs; one outside it follows the approval
policy for reads outside the workspace, which may allow it, ask you or refuse it.
A read-only task reads inside its worktree and the session workspace, and a read
outside both is refused with the reason, never asked. Links are followed before
a read is judged.

Pi's `grep` and `find` run ripgrep and fd. Pi uses its own copies from its tools
directory (`~/.pi/agent/bin`) and otherwise the `rg` and `fd` on your PATH; with
neither, Pi may download them on first use. Windows looks for a program
started by name in the current directory before PATH, so a repository that
ships an `rg.exe` or `fd.exe` could otherwise have it run by Pi's search. On
Windows, Ordewell starts every Pi process with `NoDefaultCurrentDirectoryInExePath`
set, which takes the current directory out of that search for Pi and what it
starts.

Ordewell hands Pi its MCP server, and the read checks, in a small extension it
writes for each Pi process into a private directory outside the repository and
loads with `-e`. It removes the file when the process ends, with Pi's
compilation cache for it turned off, installs nothing into Pi and changes none of
your Pi settings. A server named `ordewell` in your own Pi `mcp.json` would take
the place of Ordewell's, so a Pi start fails at once and names that file until
you rename or remove it.

Every Pi start names its session directory: Pi's default for the directory it
starts in, under its agent directory (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`),
so a repository's `.pi/settings.json` cannot send the transcript elsewhere.
Pi resumes a session by id only from the directory it was saved in, and a
Continue after its run ended works in a new worktree, so there Ordewell has Pi
fork the latest saved copy of the session into the new worktree under the same
id (`--fork`); the old worktree need not still exist. Pi does not run in a
container: a session that runs its tasks in containers refuses a Pi task and
names the runners that do. A Continue, or a planner picked up again, checks that Pi
found the saved session; a session Pi no longer has, or whose file it cannot
read, fails the Continue, and the planner picks the conversation up from its
transcript.

## When a task's context compacts

Compaction is a capacity guard, not a quality tool: a runner replaces its
conversation with a summary so the task can go on, and the task may read again
what it had read. So by default Ordewell makes no task compact before its
harness would near the model's true window. The one exception is Haiku on Claude
Code, which compacts just under the prompt size above which Haiku's prices rise.

One setting, `taskCompactAt`, names where compaction starts for every runner. It
lives in the global `settings.json` (`~/.ordewell/settings.json`);
`ORDEWELL_TASK_COMPACT_AT` wins when it is set. Each runner maps it onto what it
offers, and a planner never reads it.

- `"auto"`, the default, leaves compaction where the runner puts it.
- A whole number of tokens above zero is the context size at which compaction
  starts. A runner that cannot start exactly there uses the nearest size it can
  and logs one line saying so.
- `"off"` sets nothing. The built-in runner cannot go without compaction (its
  conversation would outgrow the model), so it compacts as `auto` does and says so
  in the task's log.

Any other value (not a number, zero or negative) stops a task from starting, with
a message saying what is accepted.

| Harness | Default start (`auto`) | A number N | `off` | What you see |
| --- | --- | --- | --- | --- |
| Claude Code | The CLI's own, near the model's window; Haiku just under 100,000 tokens (window 125,000, start 93,000) | Sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW` to N + 32,000, N held to 68,000–968,000 (a log line if it moves) | Sets none, Haiku's included; a value inherited from Ordewell's own environment is dropped under every setting | Meter `compacts at` the window less 32,000; a `compaction` line in the task log; the running-long badge |
| Codex | Its own | Sets `model_auto_compact_token_limit` to N (scope total) when the thread starts, N at least 16,000; Codex compacts at 90% of its window at most, so once it reports the window a larger N is held there (a log line if either moves) | Sets nothing | Meter `compacts at N`; the log line; the badge |
| OpenCode 1.x and 2.x | Its own | Sets `compaction.reserved` to the window less N, N held to 16,000 up to the window less 16,000; nothing, with a warning, when the model's window is unknown, as it is for a model with no input limit that only the bundled snapshot describes, of a provider some of whose models state one (the snapshot keeps no input limits); 1.x applies it only to models with an input limit, and for any other one line says N is not applied and OpenCode keeps its own start | Sets nothing; compaction room inherited in `OPENCODE_CONFIG_CONTENT` is dropped | Meter `compacts at N`; the log line; the badge |
| ACP runners | The agent's own | Nothing to set: one warning that it cannot be honoured | Nothing | No `compacts at` (no window known); a compaction is inferred from a fall of more than half in the reported context from above 32,000 tokens (or half the window, if smaller), outside the agent's own commands, and logged; the badge |
| Pi | Its own | Nothing to set: one warning that it cannot be honoured | Nothing | No `compacts at` (no window known); Pi's own compaction, with the sizes it reports, logged; the badge |
| Built-in runner | The model's window less the runner's reserve (108,800 under the assumed 128,000) | Start N, held to between 32,000 (or the default, if lower) and the default (a log line if it moves) | Not honoured: compacts as `auto` does, with a line in the task log | Meter `compacts at N` under a number (lower once a refused request shrinks the window); the model's window otherwise; one `compaction` line per step; the badge |

Whatever the harness, a compaction does the same three things. The runner gets a
reminder of its brief, once. The supervisor's running-long count goes up: under a
window below 200,000 tokens a task compacts a few times in ordinary work, so
the badge shows from the third compaction, otherwise from the first. The window in
force is the start plus 32,000 tokens on every harness, so one number counts
alike whichever runner holds it. And the
context meter resets to the size the runner left, or to nothing until its next
call.

A task whose context grows large is flagged on its own, without compacting: at the
larger of 150,000 tokens and 40% of its effective window, then at each doubling.
The decision is recorded in
[ADR-0018](adr/runners/0018-structured-runner-transport.md) (rule C4), and
`compactionPerHarness.test.ts` in core pins the table above to the code.

## The built-in runner

The built-in runner is a coding-agent loop that runs inside Ordewell itself and
calls a provider's API with the key Ordewell holds for it
([ADR-0070](adr/runners/0070-the-built-in-ordewell-runner-runs-in-process.md)). It
needs no CLI installed and no sign-in. Every provider with a key is a runner of its
own, under the provider's id and name, but for Perplexity, whose models cannot be
listed, so its key plans and runs no task: an OpenRouter key adds the runner
`openrouter` ("OpenRouter"), an Anthropic key the runner `anthropic`
("Anthropic"), and a custom OpenAI-compatible endpoint the runner
`openai_compatible` once `OPENAI_COMPATIBLE_BASE_URL` names it, which `/key-set`
asks for first when you choose Custom, its key then optional;
`ordewell key set openai_compatible <base-url> [<key>]` sets both at once. Saving
Custom with no key removes the key saved for it before, so it is not sent to the
new endpoint. Save a key with
`/key-set` or `ordewell key set <provider> <key>` (see
[where keys live](#where-keys-live)) and the runner is listed at once, signed in; a
provider with no key is not listed at all. Until you choose your runners, every
provider runner whose key is in Ordewell's own environment is enabled beside the
installed coding agents: the shell Ordewell started from, `~/.ordewell/.env`, and in
VS Code its secret storage. A key only in a project's `.ordewell/env` or `.envrc`
lists the runner in that project, and its tasks run on that key, but you turn the
runner on yourself: the enabled list is one per machine, and those files differ by
project. It runs tasks only: the planner of the same name is the API planner on the
same key.
`ordewell runners` and `/runners` list it with the others.

**Models.** A provider runner's models are its own provider's, and a task's model is
written `<provider>:<model>`; a model of another provider belongs to that
provider's runner. A provider's own listing decides which models exist. Ordewell
fills in each model's context window, reply cap, prices and capabilities from the
[models.dev](https://models.dev) catalog; a model known to take no tools is not
offered, and thinking efforts are offered only for models known to reason. The
catalog is read with one `GET https://models.dev/api.json`, at most once a day in the
background, and sends no data about you. It is cached in `models-dev.json` in
Ordewell's data directory, and a snapshot bundled with Ordewell serves when it
cannot be fetched. `ORDEWELL_NO_MODELS_DEV=1` turns the fetch off, and
`ORDEWELL_MODELS_DEV_URL` points it at another address; set either in
`~/.ordewell/.env` or where the daemon starts.

**Modes.**

| Mode | What it means |
| --- | --- |
| Full | Every tool runs without asking. File edits stay inside the task's worktree, and the shell's environment carries none of your provider keys. |
| Guarded | Reads and edits inside the worktree go ahead. Every shell command asks you: *Allow*, *Allow for this task*, or *Deny* with a note the model reads. *Allow for this task* grants a command prefix for the rest of that attempt; it covers a command only when the whole line is the prefix, or the prefix and plain arguments, never a line with `;`, `&`, `|`, a backtick, `$(`, `>`, `<` or a line break. |
| Read-only | For read-only tasks. No edit or shell tool; the task reads files and runs sealed commands only ([ADR-0046](adr/planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md)). |

In Full and Guarded the shell is not sandboxed: it runs as you and can reach what you
can, Ordewell's own daemon included. See
[what a task's agent can reach](../SECURITY.md#what-a-tasks-agent-can-reach).

**Step limit.** An attempt may make a limited number of model calls; the last one is
told so and must report with `task_complete`. The limit is `ordewellStepLimit` in
`settings.json` in Ordewell's data directory (`~/.ordewell`), a whole number of at
least 1, and defaults to 200. No surface sets it. The runner also stops an attempt
whose model makes the same tool call with the same arguments four times in a row.

**Stream timeouts.** A model request whose reply stops arriving is abandoned and
sent again, as any other passing failure is, with a line in the task log. It may
wait 180 seconds for its first event and 60 between events; set them as
`"ordewellStreamTimeouts": { "firstEventSeconds": 180, "idleSeconds": 60 }` in the
same file. A reply cut after a tool call has run is not sent again: the call's
result is kept and the model goes on from it.

**Context windows.** The runner compacts a conversation as it nears the model's
context window. It takes that window from, in order: `ordewellContextWindows` in the
same file, the model catalog, and the provider's own model listing where it states
one (OpenRouter's does, and so do some compatible servers'). Where none states it,
the runner assumes 128,000 tokens; the context meter then reads "of an assumed
128k" and the task log's first line says so. Set a model's window, by its
`<provider>:<model>` id, in tokens, as
`"ordewellContextWindows": { "openrouter:acme/model": 200000 }`. The setting wins
over the catalog and the listing. When a provider refuses a request as too long, the
runner compacts further and keeps the smaller window for the rest of that attempt.

**Earlier reasoning.** A reasoning model's turns go back to it with the reasoning
each produced, so every call re-sends all the reasoning before it. The
`taskReasoningKept` setting, in the same file (`ORDEWELL_TASK_REASONING_KEPT` wins
when it is set), lets a call leave the oldest of it out. It applies to the built-in
runner only; other runners ignore it.

- `"all"`, the default, sends every turn's reasoning: requests are as they always
  were.
- A whole number N above zero keeps the reasoning of at least the latest N calls.
  The boundary before which reasoning may go moves forward in steps of 2N calls,
  so between two moves every call starts with the call before's prompt and reads it
  from the provider's cache; the kept span runs from N to 3N - 1 calls. The latest
  call's reasoning is always kept, and a compaction starts the count over.

Any other value (not a number, zero or negative) stops a task from starting, with a
message saying what is accepted. Whether reasoning is actually left out is each
provider's to decide, and a call sends everything wherever that is not known to be
safe:

| Dialect | With a number N |
| --- | --- |
| Chat-completions through OpenRouter | Honoured only for a model a probe has checked (DeepSeek V4.1 Flash today), when the upstream that served the call before is one the probe found takes it; the call then names those upstreams as its only fallbacks. An unknown upstream, any other upstream or model, and a `:nitro` or `:floor` model id send everything. |
| Chat-completions to DeepSeek directly | Ignored: DeepSeek refuses a request with tools that leaves out any turn's reasoning, so every turn carries it. |
| Chat-completions to any other vendor (Kimi included) | Ignored. |
| Anthropic Messages | Ignored: a task is one tool-use turn, whose thinking blocks Anthropic asks to have back. |
| Gemini | Ignored: its thought signatures are checked across the turn's calls, and thought text is not sent back. |
| OpenAI Responses | Ignored: the reasoning items of a function-call loop are to be passed back, and the API drops earlier turns' itself. |

Whether a model works as well without its older reasoning is not something the
probe could show: try a number on a task you can compare before relying on it.

**Resuming and messages.** The runner keeps each attempt's conversation in a
transcript under Ordewell's data directory, outside your repository, so a resumed
task continues from it, and compacts a long conversation itself.

**Smoke test.** `bench/live/runner-smoke.mjs` runs one small fix-the-test task per
provider dialect through a real session and reports the verdict and tokens. It
**spends API credit** and is run by hand, never by CI:

```bash
npm run build -w packages/core && node bench/live/runner-smoke.mjs
```

It reads provider keys from your shell and `~/.ordewell/.env`. A dialect with no key
prints UNVERIFIED, never a pass. `ORDEWELL_SMOKE_MODELS=<provider>:<model>,…` runs
exactly those models, and `ORDEWELL_SMOKE_TIMEOUT_MS` sets the time per task.

## See and change what is configured

| What | Terminal UI | CLI | VS Code |
| --- | --- | --- | --- |
| Who plans | `/planner` | `ordewell planner [<provider>]` | The planner bar, or `/planner` |
| The planner's model and effort | `/planner` (Harness › Model › Effort) | `ordewell model`, `ordewell planner-effort` | The planner bar, or `/planner` |
| Provider keys | `/key-set` | `ordewell key`, `ordewell key set <provider> <key>`, `ordewell key set openai_compatible <base-url> [<key>]` | `/key-set`, or **Ordewell: Configure API Key** |
| Which runners are on | `/runners` | `ordewell runners [<id> on\|off]` | **Ordewell: Toggle Runner** |
| Sign a runner in | `/login` | The runner's own CLI | `/login` |
| A task's runner, model and effort | `/task-runner <id>`, `/task-model <id>`, `/task-effort <id>` | `ordewell task-runner <id> [runner]`, `ordewell task-model <id> [model]`, `ordewell task-effort <id> [level]`; leave out the last value to list the choices | The task's card |
| Which of a runner's models tasks may be given | `/allowlist` | `ordewell allowlist set\|clear\|show` | `/allowlist`, or **Ordewell: Configure Model Allowlist** |
| A newly installed runner | `/refresh` | `ordewell refresh` | `/refresh` |
| A runner's models, discovered again | When the daemon restarts or a provider key or base URL changes | The same | `/refresh` |

The desktop app's planner chat takes the same `/key-set`, `/login` and `/refresh`, and
its Settings tab holds the planner, the runners and each runner's models. **Set API
key…** opens its key entry, with every provider to choose from, in Settings' Runners
heading, under the Welcome window's runner cards and in the command palette. While no
provider key is set, the tips the empty planner composer cycles through, in the desktop
app and VS Code, include one to add a key with `/key-set`.

## Where keys live

The terminal UI, the CLI and the desktop app save a key to `~/.ordewell/.env` and
hand it to the running daemon, which also loads the keys saved there when it starts.
A variable already exported in your shell takes precedence over that file, and is
never written to it. A key typed after `ordewell key set` can stay in your shell
history, which `/key-set` avoids. `/key` still opens the same key entry.

VS Code keeps keys in its secret storage, through `/key-set` or **Ordewell: Configure API
Key**. Without one there, it reads its API key settings, such as
`ordewell.openAiApiKey`, then exported variables, and last the keys the other surfaces
saved to `~/.ordewell/.env`. It reads that file when the window starts and again on each
model refresh, so a key saved, replaced or removed there shows the next time the model
list refreshes. A key from that file goes only to the endpoint saved with it, or to the
provider's default: a workspace setting or a project's `.ordewell/env` cannot send it
elsewhere. VS Code never copies it into its secret storage. Custom's endpoint goes in the
`ordewell.openaiCompatibleBaseUrl` user setting, which a workspace cannot set, since
the endpoint is sent your key.

Each runner starts with Ordewell's environment, so a key exported in your shell, or
saved with `/key-set` or `ordewell key set` in the terminal UI or CLI, reaches the runners
too. A key in VS Code's secret storage or settings is never put in the extension host's
environment: the built-in runner on its provider runs on it, and a coding agent does not
generally get it. Ordewell
hands applicable saved keys to Qwen Code, Cline and Gemini CLI for their starts
and model discovery. Claude Code and Codex can
also sign in with `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, so such a key saved for
the Anthropic or OpenAI planner can change which account they use.

## Get told when a run waits on you

Ordewell can run a command of yours whenever something new waits on you, so a run
can reach you away from the screen: a desktop notification, a chat message, a
webhook. Ordewell sends nothing itself. Set the command once, as a list with the
program first, either in `~/.ordewell/.env` or your shell (restart the daemon with
`ordewell stop --server` to pick up a change), or as `ordewell.notifyCommand` in
VS Code's user settings.

On macOS, in `~/.ordewell/.env`:

```bash
ORDEWELL_NOTIFY_COMMAND=["osascript","-e","display notification (do shell script \"printenv ORDEWELL_ESCALATION_REASON\") with title \"Ordewell\""]
```

On Linux, with `notify-send`:

```bash
ORDEWELL_NOTIFY_COMMAND=["sh","-c","notify-send -- \"Ordewell: $ORDEWELL_ESCALATION_TASK\" \"$ORDEWELL_ESCALATION_REASON\""]
```

In an `export` in your shell, put single quotes around the list.

Ordewell runs the command with no shell, in your home directory, and tells it what
is waiting in four environment variables:

| Variable | Holds |
| --- | --- |
| `ORDEWELL_ESCALATION_ID` | What this wait is called; it does not repeat |
| `ORDEWELL_ESCALATION_KIND` | What sort of wait it is, such as `failed` or `approval` |
| `ORDEWELL_ESCALATION_TASK` | The task's number and title; empty for a wait of the run itself |
| `ORDEWELL_ESCALATION_REASON` | Why it waits, in plain words |

Part of that text comes from the runners, so treat it as untrusted. Ordewell strips
control characters and caps its length, but a shell you add is yours to keep safe:
keep each variable in double quotes, as above, and never pass one to `eval`.

The command runs once for each new wait. What already waits when a session opens
counts as told, so a restart sends nothing. It can never affect a run: it has a
short time limit, and a failure is logged once, to `~/.ordewell/server.log` (or
the extension host's log in VS Code), and otherwise ignored. Ordewell refuses it
from a repository's `.ordewell/env`, from what direnv exports for its runners, and
from VS Code workspace settings. It does read it from the shell it started in, so
an `.envrc` you have allowed can set it there, as that `.envrc` can already run
anything as you
([ADR-0053](adr/supervision/0053-what-waits-on-a-person-is-derived-and-answered-in-one-call.md)).

## Adding a coding agent

Only a built-in runner (one declared in Ordewell's own manifests) can run tasks or plan as a harness planner. To add one, see
[Adding a runner](../CONTRIBUTING.md#adding-a-runner).
