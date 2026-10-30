# Planners and runners

Ordewell uses a model in two roles. The **planner** reads your repository and writes
the plan; it never writes code. A **runner** is a coding-agent CLI, such as Claude
Code, Codex or OpenCode, that runs one task of the plan in its own session. The two
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

An **API planner** calls a provider's API, with your key where the provider needs
one. Providers include OpenRouter, Google Gemini, DeepSeek, Moonshot / Kimi and xAI;
`ordewell planner` shows the full list and marks each provider whose key is missing
with the environment variable it reads, such as `(no DEEPSEEK_API_KEY)`. The
planner's model is one of that provider's models.

A provider key adds a planner, never a runner. A `DEEPSEEK_API_KEY` or
`MOONSHOT_API_KEY` lets DeepSeek or Kimi models plan; tasks still run on the built-in
runners.

## Who runs tasks

Every AI task runs on a runner, and each runner is set up outside Ordewell:

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

## See and change what is configured

| What | Terminal UI | CLI | VS Code |
| --- | --- | --- | --- |
| Who plans | `/planner` | `ordewell planner [<provider>]` | The planner bar, or `/planner` |
| The planner's model and effort | `/planner` (Harness › Model › Effort) | `ordewell model`, `ordewell planner-effort` | The planner bar, or `/planner` |
| Provider keys | `/key` | `ordewell key`, `ordewell key set <provider> <key>` | `/key`, or **Ordewell: Configure API Key** |
| Which runners are on | `/runners` | `ordewell runners [<id> on\|off]` | **Ordewell: Toggle Runner** |
| Sign a runner in | `/login` | The runner's own CLI | `/login` |
| A task's runner, model and effort | `/task-runner <id>`, `/task-model <id>`, `/task-effort <id>` | `ordewell task-runner <id> [runner]`, `ordewell task-model <id> [model]`, `ordewell task-effort <id> [level]`; leave out the last value to list the choices | The task's card |
| Which of a runner's models tasks may be given | `/allowlist` | `ordewell allowlist set\|clear\|show` | `/allowlist`, or **Ordewell: Configure Model Allowlist** |
| A newly installed runner | `/refresh` | `ordewell refresh` | `/refresh` |
| A runner's models, discovered again | When the daemon restarts or a provider key or base URL changes | The same | `/refresh` |

## Where keys live

The terminal UI and the CLI save a key to `~/.ordewell/.env` and hand it to the
running daemon. When Ordewell starts, a variable already exported in your shell takes
precedence over that file. A key typed after `ordewell key set` can stay in your shell
history, which `/key` avoids.

VS Code keeps keys in its secret storage, through `/key` or **Ordewell: Configure API
Key**. Without one there, it reads its API key settings, such as
`ordewell.openAiApiKey`, and then exported variables.

Each runner starts with Ordewell's environment, so a key exported in your shell, or
saved with `/key` or `ordewell key set` in the terminal UI or CLI, reaches the runners
too; a key in VS Code's secret storage or settings does not. Claude Code and Codex can
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
the extension host's log in VS Code), and otherwise ignored. Only you can set it:
Ordewell refuses it from a repository's `.ordewell/env` and `.envrc`, and from VS
Code workspace settings
([ADR-0053](adr/supervision/0053-what-waits-on-a-person-is-derived-and-answered-in-one-call.md)).

## Adding a coding agent

Only a built-in runner can run tasks or plan as a harness planner. To add one, see
[Adding a runner](../CONTRIBUTING.md#adding-a-runner).
