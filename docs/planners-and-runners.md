# Planners and runners

Ordewell uses a model in two roles. The **planner** reads your repository and writes
the plan; it never writes code. A **runner** runs one task of the plan in its own session: either a coding-agent
CLI, such as Claude Code, Codex or OpenCode, or Ordewell's own
[built-in runner](#the-built-in-runner), which needs only a provider key. The two
get their models and credentials in different ways, described below.
[CONTEXT.md](../CONTEXT.md) defines these terms.

## Who plans

`ordewell planner` lists the two kinds of planner. `/planner` in the terminal UI or in
VS Code, or the planner bar in VS Code, picks one.

A **harness planner** is a coding agent planning: pick a runner such as `claude-code`,
`codex` or `opencode`, and the planner conversation runs through that agent
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

## The built-in runner

The built-in runner is a coding-agent loop that runs inside Ordewell itself and
calls a provider's API with the key Ordewell holds for it
([ADR-0070](adr/runners/0070-the-built-in-ordewell-runner-runs-in-process.md)). It
needs no CLI installed and no sign-in. Every provider with a key is a runner of its
own, under the provider's id and name: an OpenRouter key adds the runner
`openrouter` ("OpenRouter"), an Anthropic key the runner `anthropic`
("Anthropic"), and a custom OpenAI-compatible endpoint the runner
`openai_compatible` once `OPENAI_COMPATIBLE_BASE_URL` names it. Save a key with
`/key-set` or `ordewell key set <provider> <key>` (see
[where keys live](#where-keys-live)) and the runner is listed at once, signed in; a
provider with no key is not listed at all. Until you choose your runners, every
keyed provider's runner is enabled beside the installed coding agents. It runs tasks
only: the planner of the same name is the API planner on the same key.
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

In Full and Guarded the shell is not sandboxed.

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
| Provider keys | `/key-set` | `ordewell key`, `ordewell key set <provider> <key>` | `/key-set`, or **Ordewell: Configure API Key** |
| Which runners are on | `/runners` | `ordewell runners [<id> on\|off]` | **Ordewell: Toggle Runner** |
| Sign a runner in | `/login` | The runner's own CLI | `/login` |
| A task's runner, model and effort | `/task-runner <id>`, `/task-model <id>`, `/task-effort <id>` | `ordewell task-runner <id> [runner]`, `ordewell task-model <id> [model]`, `ordewell task-effort <id> [level]`; leave out the last value to list the choices | The task's card |
| Which of a runner's models tasks may be given | `/allowlist` | `ordewell allowlist set\|clear\|show` | `/allowlist`, or **Ordewell: Configure Model Allowlist** |
| A newly installed runner | `/refresh` | `ordewell refresh` | `/refresh` |
| A runner's models, discovered again | When the daemon restarts or a provider key or base URL changes | The same | `/refresh` |

## Where keys live

The terminal UI, the CLI and the desktop app save a key to `~/.ordewell/.env` and
hand it to the running daemon, which also loads the keys saved there when it starts.
A variable already exported in your shell takes precedence over that file, and is
never written to it. A key typed after `ordewell key set` can stay in your shell
history, which `/key-set` avoids. `/key` still opens the same key entry.

VS Code keeps keys in its secret storage, through `/key-set` or **Ordewell: Configure API
Key**. Without one there, it reads its API key settings, such as
`ordewell.openAiApiKey`, and then exported variables.

Each runner starts with Ordewell's environment, so a key exported in your shell, or
saved with `/key-set` or `ordewell key set` in the terminal UI or CLI, reaches the runners
too; a key in VS Code's secret storage or settings does not generally reach runners. Ordewell
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
