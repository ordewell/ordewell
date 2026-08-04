export interface ParsedCommand {
  name: string;
  args: string[];
}

export type SlashCategory = 'planning' | 'tasks' | 'models' | 'skills' | 'session' | 'system';

export interface SlashCommand {
  name: string;
  usage: string;
  description: string;
  category: SlashCategory;
}

/**
 * The TUI's command surface. This is the feature-parity contract with the
 * VS Code extension (issue #24): anything the webview can do is reachable
 * from here, so the list doubles as the `/help` output and the completion menu.
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  // Planning. There is deliberately no `/plan`: typing the goal *is* the way to
  // start planning, and an alias for it only shadowed `/planner` on completion.
  { name: 'approve', usage: '/approve', description: 'Approve the drafted plan', category: 'planning' },
  { name: 'run', usage: '/run', description: 'Execute the approved plan', category: 'planning' },
  { name: 'stop', usage: '/stop', description: 'Stop the running execution', category: 'planning' },

  // Tasks
  { name: 'add-task', usage: '/add-task <title>', description: 'Add a task to the current plan', category: 'tasks' },
  { name: 'remove-task', usage: '/remove-task <id>', description: 'Remove a task from the plan', category: 'tasks' },
  { name: 'complete', usage: '/complete <id>', description: 'Mark a task complete', category: 'tasks' },
  { name: 'uncomplete', usage: '/uncomplete <id>', description: 'Mark a completed task not done', category: 'tasks' },
  { name: 'skip', usage: '/skip <id>', description: 'Skip a task', category: 'tasks' },
  { name: 'retry', usage: '/retry <id>', description: 'Re-run a failed task', category: 'tasks' },
  { name: 'cancel', usage: '/cancel <id>', description: 'Kill a running task', category: 'tasks' },
  { name: 'force-start', usage: '/force-start <id>', description: 'Start a task now, ignoring dependencies', category: 'tasks' },
  { name: 'terminal', usage: '/terminal <id>', description: "Open a real terminal attached to a task's runner", category: 'tasks' },
  { name: 'task-runner', usage: '/task-runner <id> [runner]', description: "Choose or set a task's executor (re-picks its model and mode)", category: 'tasks' },
  { name: 'task-model', usage: '/task-model <id> [model]', description: "Choose or set a task's executor model", category: 'tasks' },
  { name: 'task-effort', usage: '/task-effort <id> [level]', description: "Choose or set a task's thinking effort", category: 'tasks' },
  { name: 'task-mode', usage: '/task-mode <id> [mode]', description: "Choose or set a task's runner mode", category: 'tasks' },
  { name: 'task-deps', usage: '/task-deps <id>', description: "Edit which earlier tasks a task waits for", category: 'tasks' },

  // Models & providers
  { name: 'planner', usage: '/planner [<provider>]', description: 'Choose who plans — an API provider or a coding agent (no API key)', category: 'models' },
  { name: 'model', usage: '/model [set <id>]', description: 'Show or set the orchestrator model', category: 'models' },
  { name: 'planner-effort', usage: '/planner-effort [<level>]', description: "Thinking effort for a coding-agent planner", category: 'models' },
  { name: 'key', usage: '/key [set <provider> <key>]', description: 'Configure API provider keys', category: 'models' },
  { name: 'allowlist', usage: '/allowlist [set <runner> <ids> | clear <runner>]', description: 'Limit which models a runner may use', category: 'models' },
  { name: 'runners', usage: '/runners [<id> on|off]', description: 'Enable or disable runners (claude-code, opencode, codex)', category: 'models' },
  { name: 'auto', usage: '/auto [on|off]', description: 'Autonomous permission mode for new plans', category: 'models' },
  { name: 'refresh', usage: '/refresh', description: 'Re-discover runners and model catalogs', category: 'models' },

  // Skills
  { name: 'grill-me', usage: '/grill-me [on|off]', description: 'Grill-Me challenge mode — the planner interrogates the goal', category: 'skills' },
  { name: 'tdd', usage: '/tdd [on|off]', description: 'Test-Driven Development mode', category: 'skills' },
  { name: 'prd', usage: '/prd [on|off]', description: 'PRD mode — write a PRD before the plan', category: 'skills' },
  { name: 'review', usage: '/review [on|off]', description: 'Review mode — final opinion-review task with human sign-off', category: 'skills' },
  { name: 'verify', usage: '/verify [on|off]', description: 'Verification mode — final evidence-based task that runs the suite', category: 'skills' },
  { name: 'research-subagents', usage: '/research-subagents [on|off]', description: 'Parallel read-only research subagents during planning', category: 'skills' },

  // Sessions
  { name: 'sessions', usage: '/sessions', description: 'List saved sessions', category: 'session' },
  { name: 'new', usage: '/new', description: 'Start a new session', category: 'session' },
  { name: 'save', usage: '/save', description: 'Save the current session', category: 'session' },
  { name: 'load', usage: '/load <id>', description: 'Load a saved session', category: 'session' },
  { name: 'delete', usage: '/delete <id>', description: 'Delete a saved session', category: 'session' },

  // System
  { name: 'help', usage: '/help', description: 'Show available commands', category: 'system' },
  { name: 'mouse', usage: '/mouse [on|off]', description: 'Wheel scrolling instead of drag-to-select text', category: 'system' },
  { name: 'quit', usage: '/quit', description: 'Exit the TUI', category: 'system' },
];

const BY_NAME = new Map(SLASH_COMMANDS.map((c) => [c.name, c]));

/** `null` when the text is ordinary chat rather than a `/command`. */
export function parseSlash(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return { name: parts[0].toLowerCase(), args: parts.slice(1) };
}

export function findCommand(name: string): SlashCommand | undefined {
  return BY_NAME.get(name.replace(/^\//, '').toLowerCase());
}

/**
 * Commands matching what the user has typed so far. Suggestions stop once a
 * space is typed — from there on the user is entering arguments, not a name.
 */
export function completions(text: string): SlashCommand[] {
  if (!text.startsWith('/')) return [];
  const typed = text.slice(1);
  if (/\s/.test(typed)) return [];
  const prefix = typed.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
}
