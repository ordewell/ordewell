export function printHelp(): void {
  console.log(`
Ordewell — task orchestration for coding agents

Run "ordewell" with no arguments for the TUI. Every command below has a TUI
slash command of the same name, where each one opens a picker instead of taking
an id.

Planning:
  ordewell                        Full-screen terminal UI (everything the VS Code extension does)
  ordewell tui                    The same thing, named — for scripts and aliases
  ordewell plan --goal "text"     Plan a goal conversationally
  ordewell run                    Execute the last generated plan (streams status)
  ordewell approve                Sign off a plan paused for review, and continue it
  ordewell stop                   Stop execution of the last session (or --server)
  ordewell status                 List recent sessions (use --session-id for detail)
  ordewell sessions list|load|delete            Manage named sessions
  ordewell fork                   Continue in a copy of the conversation and its tasks
  ordewell compact                Condense the conversation into a summary (tasks are kept)
  ordewell rewind [<n>]           Fork the conversation from before message <n> (no <n>: list them)
  ordewell handoff [action]       Review, merge, discard or clean up an isolated run

Tasks (<id> is an order number or a task ID):
  ordewell add-task --title "..."  Add a task to the current plan
  ordewell remove-task <id>       Remove a task from the current plan
  ordewell complete <id>          Mark a task complete (alias: mark-complete)
  ordewell uncomplete <id>        Mark a completed task not done
  ordewell skip <id>              Skip a task (marks it complete so dependents can run)
  ordewell force-start <id>       Start a task now, ignoring dependencies (asks past a merge gate)
  ordewell run-task <id>          Run only one task
  ordewell retry <id>             Re-run a failed task
  ordewell continue <id> <msg>    Continue a finished task in its saved runner session
  ordewell checkpoint <id> approve|reject [reason]  Answer the checkpoint a task waits at
  ordewell cancel <id>            Kill a running task

Per-task assignment (omit the value to list the options):
  ordewell task-runner <id> [runner]   Set a task's executor (re-picks its model, effort and mode)
  ordewell task-model <id> [model]     Set a task's executor model
  ordewell task-effort <id> [level]    Set a task's thinking effort ("default" to clear)
  ordewell task-mode <id> [mode]       Set a task's runner mode
  ordewell task-deps <id> [a,b|none]   Set which earlier tasks a task waits for
  ordewell task-skills <id> [a,b|none] Set the skills attached to a task (applies-to: task); none clears them
  ordewell task-ops <id> [on|off]      Make a task an ops task (runs in your checkout once its dependencies are merged) or a change task

Planner, models and runners:
  ordewell planner [<provider>]   Choose who plans — an API provider or a coding agent (no API key)
  ordewell model [set <id>]       Show or set the planner model (applies without a restart)
  ordewell planner-effort [lvl]   Thinking effort for a coding-agent planner
  ordewell key [set <p> <key>]    Show which providers have a key, or store one
  ordewell runners [<id> on|off]  Enable or disable runners (claude-code, opencode, codex)
  ordewell allowlist set|clear|show       Limit which models a runner may use
  ordewell auto [full|guarded]    Autonomy level for new sessions: Full or Guarded
  ordewell parallel [<n>]         How many AI tasks run at once (default 3; applies to a live run)
  ordewell refresh                Re-discover runners and model catalogs
  ordewell models                 List every provider's catalog (works without a server)

Other:
  ordewell web                    Start the API server (foreground; --daemon for background)
  ordewell setup                  Interactive first-run setup wizard
  ordewell skills                 List installed skills and shadowed workspace duplicates
  ordewell --help               Show this help
  ordewell --version            Print the installed version (alias: version, -v)

TUI options:
  --workspace /path   Workspace directory (default: cwd)
  --port N            Target a daemon on port N

TUI task view keys (t on a structured task; /help in the TUI lists them all):
  ctrl-s              Send now: interrupt the running step and deliver the composer text next
                      (with the composer empty, the selected queued message)
  ctrl-n / ctrl-p     Select a queued message; ctrl-r removes it
  ctrl-x              Interrupt the running turn

Plan options:
  --goal "text"       Task description (required)
  --runner <id>       Runner to use (repeatable; default: all enabled runners)
  --workspace /path   Workspace directory (default: cwd)
  --no-chat           One-shot plan; skips the planner dialogue

Run options:
  --session-id <id>   Execute a specific session (default: last session)

Status options:
  --session-id <id>   Show full detail for one session
  --json              Output as JSON
  --output <file>     Write the JSON to a file (implies --json)

Sessions options:
  --workspace /path   Workspace to list sessions from (default: cwd)
  --json              Output the list as JSON

Skills options:
  --workspace /path   Workspace to read skills from (default: cwd)
  --json              Output resolved skills and shadowed duplicates as JSON

Task options (add-task):
  --title "text"      Task title (required)
  --description "..." Task description (default: the title)
  --prompt "..."      AI instructions (AI tasks only; default: the description)
  --type ai|user      Task type (default: ai)
  --depends-on <id>   Dependency task ID (repeatable)

Stop options:
  --server            Stop the background server daemon
  --session-id <id>   Stop a specific execution

Web options:
  --port N            Listen on port N (default: 3742)
  --daemon            Run server in background

Global options:
  --port N            Target a daemon on port N (default: ORDEWELL_PORT, else 3742)
  --session-id <id>   Session to act on (default: last planned session)

Quick Start:
  Set OPENROUTER_API_KEY or GEMINI_API_KEY in your environment,
  then run: ordewell plan --goal "Your task description"

  No API key? Plan with a coding agent you already pay for:
    AI_PROVIDER=claude-code ordewell plan --goal "Your task description"

Environment:
  OPENROUTER_API_KEY         OpenRouter API key (recommended)
  GEMINI_API_KEY             Google Gemini API key (alternative)
  AI_PROVIDER                openrouter, google — auto-detected from keys
                             claude-code, codex, opencode — plan with that CLI,
                             no API key (uses its own subscription)
  ORDEWELL_PLANNER_EFFORT    Thinking effort for a coding-agent planner
  ORCHESTRATOR_MODEL         Default: deepseek/deepseek-v4-flash
  OPENROUTER_BASE_URL        Default: https://openrouter.ai/api/v1
  ORDEWELL_AUTONOMOUS_MODE   true: Full, false: Guarded, for new sessions (see "ordewell auto")
  ORDEWELL_PORT              Daemon port CLI commands target (default: 3742)
  ORDEWELL_DIRENV            false: agents skip the project's direnv .envrc
  ORDEWELL_RESEARCH_ENABLED  true (default) or false
  ORDEWELL_MAX_PARALLEL      Default: 3 — set with "ordewell parallel"
`);
}
