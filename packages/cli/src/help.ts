import { runnerIdList } from './runnerNames';

// The `web_search:` provider names further down are search providers, named as
// an approval names them, not runner ids.
export function printHelp(): void {
  console.log(`
Ordewell: task orchestration for coding agents

Run "ordewell" with no arguments for the TUI. Where a command has a slash
command, both take the same name. The headless run-setting and planner-step
commands marked "(headless)" are set in /settings and /planner in the TUI and
VS Code.

Planning:
  ordewell                        Full-screen terminal UI (everything the VS Code extension does)
  ordewell tui                    Explicit TUI command for scripts and aliases
  ordewell plan --goal "text"     Plan a goal conversationally
  ordewell run                    Execute the last generated plan (streams status)
  ordewell approve                Sign off a plan paused for review, and continue it
  ordewell stop                   Stop execution of the last session (or --server)
  ordewell status                 List recent sessions (use --session-id for detail)
  ordewell sessions list|load|delete            Manage named sessions
  ordewell fork                   Continue in a copy of the conversation and its tasks
  ordewell compact                Condense what the planner is sent into a summary (history and tasks are kept)
  ordewell compact retry          Retry compaction of a planner paused on its context, and carry its turn on
  ordewell rewind [<n>]           Fork the conversation from before message <n> (no <n>: list them)
  ordewell resend cancel          Keep a planner turn waiting on its usage limit from going at the reset
  ordewell handoff [action]       Review, merge, discard or clean up an isolated run

Tasks (<id> is an order number or a task ID):
  ordewell add-task --title "..."  Add a task to the current plan
  ordewell remove-task <id>       Remove a task from the current plan
  ordewell complete <id>          Mark a task complete (alias: mark-complete; asks first, --yes skips the question)
  ordewell uncomplete <id>        Mark a completed task not done (asks first, --yes skips the question)
  ordewell revert <id>            Take a landed task's work back off the integration branch (lists what goes with it, asks first, --yes skips the question)
  ordewell skip <id>              Skip a task: nothing it did lands, dependents go ahead
  ordewell force-start <id>       Approve a task and start it now, or once its dependencies finish (asks past a merge gate)
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
  ordewell planner [<provider>]   Choose who plans: an API provider or a coding agent (no API key)
  ordewell model [set <id>]       (headless) Show or set the planner model; /planner covers it in the TUI and VS Code
  ordewell planner-effort [lvl]   (headless) Thinking effort for a coding-agent planner; /planner covers it
  ordewell key [set <p> <key>]    Show which providers have a key, or store one
  ordewell runners [<id> on|off]  Enable or disable runners (${runnerIdList()})
  ordewell allowlist set|clear|show       Limit which models a runner may use
  ordewell auto [full|guarded]    (headless) Autonomy level for new plans, Full or Guarded; /settings covers it
  ordewell supervisor [off|watch|act]  (headless) Whether the planner watches or acts on your runs;
                                  /settings covers it; also: supervisor retries <n>
  ordewell supervisor reads <n>   (headless) Reads the supervisor may make each wake-up; set only here or in settings.json
  ordewell automerge [on|off]     (headless) Merge at merge gates and at the end of a run; /settings covers it
  ordewell trailer [on|off]       (headless) End Ordewell's commits with "Planned-with: Ordewell"; set only here or in settings.json
  ordewell autorun [on|off]       (headless) Start each plan the planner submits, without review; /settings covers it
  ordewell parallel [<n>]         (headless) How many AI tasks run at once, a live run included; /settings covers it
  ordewell refresh                Re-check runners; reread settings and cached models
  ordewell models                 List every provider's catalog (works without a server)

Other:
  ordewell web                    Start the API server (foreground; --daemon for background)
  ordewell setup                  Write a starter .env configuration file
  ordewell skills                 List installed skills and shadowed workspace duplicates
  ordewell --help               Show this help
  ordewell --version            Print the installed version (alias: version, -v)

TUI options:
  --workspace /path   Workspace directory (default: cwd)
  --port N            Target a daemon on port N

TUI planner chat keys (in the composer):
  ctrl-s              Send now: stop the running planner turn and send this message next
                      (with the composer empty, the newest queued prompt)

TUI task view keys (enter on a task; /help in the TUI lists them all):
  ctrl-s              Send now: interrupt the running step and deliver the composer text next
                      (with the composer empty, the highlighted pending message,
                      one the runner already has included)
  ctrl-n / ctrl-p     Pick a pending message (the newest until you do); ctrl-r removes a queued one
  ctrl-x              Interrupt the running turn

Plan options:
  --goal "text"       Task description (required)
  --runner <id>       Runner to use (repeatable; default: all enabled runners)
  --workspace /path   Workspace directory (default: cwd)
  --no-chat           One-shot plan; skips the planner dialogue
  --yes               Start the plan as soon as it is generated, without a review pause
  --verbose           Show each planning step as it happens

Run options:
  --session-id <id>   Execute a specific session (default: last session)
  --workspace /path   Workspace directory (default: cwd)
  --stash             Stash a dirty tree and continue in the task's worktree
  --without-isolation Run the plan in your checkout; tasks share it

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
  --depends-on <ref>  Dependency task: an order number or a task ID (repeatable)

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
  Run "ordewell", then use /planner to choose a coding agent,
  or /key to choose an API provider and add its key.

  To plan from the command line after setup:
    ordewell plan --goal "Your task description"

  No API key? Plan with a coding agent you already pay for:
    AI_PROVIDER=<runner> ordewell plan --goal "Your task description"

Environment:
  OPENROUTER_API_KEY         OpenRouter API key
  GEMINI_API_KEY             Google Gemini API key
  AI_PROVIDER                Provider ID (auto-detected from keys); list with "ordewell planner"
                             ${runnerIdList()}: plan with that CLI,
                             no API key (uses its own subscription)
  ORDEWELL_PLANNER_EFFORT    Thinking effort for a coding-agent planner
  ORCHESTRATOR_MODEL         Planner model; no default. Required for an API planner, optional
                             for a coding-agent planner (unset: the agent's own default)
  OPENROUTER_BASE_URL        Default: https://openrouter.ai/api/v1
  ORDEWELL_AUTONOMOUS_MODE   true: Full, false: Guarded; overrides what "ordewell auto" saved
  ORDEWELL_APPROVAL_MODE     What the planner may run beyond read-only commands: auto (default:
                             web reads run; otherwise Guarded asks, Full runs only the allowlist),
                             ask, allowlist or allow. File writes are always refused
  ORDEWELL_APPROVAL_ALLOW    Extra allowlist entries, comma-separated: "gh issue list",
                             "gcloud * * list", "mcp:find-*", "https://docs.example.com/*";
                             "web_search:<provider>" covers one search provider (anthropic, openai,
                             opencode or duckduckgo); a leading ! excludes, and !web_search:* turns
                             every search off. To turn web reads off: !web_search:*, !https://*,
                             !http://*, or ORDEWELL_WEB_READ_BUDGET=0. "mcp-server:<name>@<hash>"
                             starts one exact MCP server a repository declares; !mcp-server:* starts none
  ORDEWELL_APPROVAL_DEFAULTS false: drop the built-in read-only allowlist
  ORDEWELL_WEB_READ_BUDGET   Fetches and web searches the planner may make per turn
                             (default: 40; 0 turns web reads off)
  ORDEWELL_EFFECT_ALLOW      Script tasks the planner may run unasked, comma-separated rules matched
                             against each whole command, flags included: "git push origin feature/*".
                             Every command must be covered; none is by default
  ORDEWELL_NOTIFY_COMMAND    A command to run when something new waits on you, as a JSON array:
                             '["program", "arg"]'. No shell; the escalation is in
                             ORDEWELL_ESCALATION_ID, _KIND, _TASK and _REASON. A workspace cannot set it
  ORDEWELL_PORT              Daemon port CLI commands target (default: 3742)
  ORDEWELL_DIRENV            false: agents skip the project's direnv .envrc
  ORDEWELL_RESEARCH_ENABLED  true (default) or false
  ORDEWELL_MAX_PARALLEL      Default: 5, set with "ordewell parallel"
`);
}
