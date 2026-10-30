import { findRunnerCommand, type RunnerCommand } from '@ordewell/core';
import { runnerIdList } from '../runnerNames';

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
  /** Set on commands registered from a discovered skill, never on a built-in. */
  source?: 'skill';
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
  { name: 'stop', usage: '/stop', description: 'Stop the planner or the running execution, whichever is active', category: 'planning' },
  { name: 'resend', usage: '/resend cancel', description: "Keep what waits on the planner's usage limit from being sent at the reset: it goes with your next message", category: 'planning' },
  { name: 'handoff', usage: '/handoff [review|merge|discard|cleanup]', description: "Land an isolated run's branch: review it, merge it into yours, or discard it", category: 'planning' },

  // Tasks
  { name: 'add-task', usage: '/add-task <title>', description: 'Add a task to the current plan', category: 'tasks' },
  { name: 'remove-task', usage: '/remove-task <id>', description: 'Remove a task from the plan', category: 'tasks' },
  { name: 'complete', usage: '/complete <id>', description: 'Mark a task complete (asks first)', category: 'tasks' },
  { name: 'uncomplete', usage: '/uncomplete <id>', description: 'Mark a completed task not done (asks first)', category: 'tasks' },
  { name: 'skip', usage: '/skip <id>', description: 'Skip a task', category: 'tasks' },
  { name: 'retry', usage: '/retry <id>', description: 'Re-run a failed task', category: 'tasks' },
  { name: 'cancel', usage: '/cancel <id>', description: 'Kill a running task', category: 'tasks' },
  { name: 'force-start', usage: '/force-start <id>', description: 'Approve a task and start it now, or once its dependencies finish', category: 'tasks' },
  { name: 'continue', usage: '/continue <id> <message>', description: 'Continue a finished task in its saved runner session, with your message', category: 'tasks' },
  { name: 'open', usage: '/open <id>', description: "Open a started task's chat: its view, and the keys that answer its checkpoint or tool request", category: 'tasks' },
  { name: 'checkpoint', usage: '/checkpoint <id> approve|reject [reason]', description: 'Answer the checkpoint a task waits at: approve lets it go on, reject tells it why not', category: 'tasks' },
  { name: 'inbox', usage: '/inbox', description: 'List everything waiting on you, and answer it or open its task', category: 'tasks' },
  { name: 'task-runner', usage: '/task-runner <id> [runner]', description: "Choose or set a task's executor (re-picks its model and mode)", category: 'tasks' },
  { name: 'task-model', usage: '/task-model <id> [model]', description: "Choose or set a task's executor model", category: 'tasks' },
  { name: 'task-effort', usage: '/task-effort <id> [level]', description: "Choose or set a task's thinking effort", category: 'tasks' },
  { name: 'task-mode', usage: '/task-mode <id> [mode]', description: "Choose or set a task's runner mode", category: 'tasks' },
  { name: 'task-deps', usage: '/task-deps <id>', description: "Edit which earlier tasks a task waits for", category: 'tasks' },
  { name: 'task-skills', usage: '/task-skills <id> [a,b|none]', description: 'Choose or set the skills attached to a task; none clears them', category: 'tasks' },
  { name: 'task-ops', usage: '/task-ops <id> [on|off]', description: 'Choose between an ops task (runs in your checkout once its dependencies are merged) and a change task', category: 'tasks' },

  // Models & providers
  { name: 'planner', usage: '/planner [<provider>]', description: 'Pick the planner: harness, model and effort in one go', category: 'models' },
  { name: 'key', usage: '/key [set <provider> <key>]', description: 'Configure API provider keys', category: 'models' },
  { name: 'allowlist', usage: '/allowlist [set <runner> <ids> | clear <runner>]', description: 'Limit which models a runner may use', category: 'models' },
  { name: 'runners', usage: '/runners [<id> on|off]', description: `Enable or disable runners (${runnerIdList()})`, category: 'models' },
  { name: 'login', usage: '/login [<runner>]', description: 'Sign the active coding agent in, or the one named, in this terminal', category: 'models' },
  { name: 'settings', usage: '/settings', description: 'Run settings: autonomy, supervisor, merging, autorun and parallel tasks', category: 'models' },
  { name: 'refresh', usage: '/refresh', description: 'Re-check runners; reread settings and cached models', category: 'models' },

  // Sessions
  { name: 'sessions', usage: '/sessions', description: 'List saved sessions', category: 'session' },
  { name: 'fork', usage: '/fork', description: 'Continue in a copy of this conversation and its tasks; the original stays as it is', category: 'session' },
  { name: 'compact', usage: '/compact [retry]', description: 'Condense what the planner is sent into a summary; the full conversation, the last two exchanges and all tasks are kept. retry: retry compaction of a planner paused on its context', category: 'session' },
  { name: 'rewind', usage: '/rewind [<message>]', description: 'Fork the conversation from just before one of your messages, after a confirmation (the original is kept)', category: 'session' },
  { name: 'new', usage: '/new', description: 'Start a new session', category: 'session' },
  { name: 'save', usage: '/save', description: 'Save the current session', category: 'session' },
  { name: 'load', usage: '/load <id>', description: 'Load a saved session', category: 'session' },
  { name: 'delete', usage: '/delete <id>', description: 'Delete a saved session', category: 'session' },

  // System
  { name: 'help', usage: '/help', description: 'Show available commands', category: 'system' },
  { name: 'mouse', usage: '/mouse [on|off]', description: "Wheel scrolling and drag-select, per-pane in the body and full-width in the composer (on), or the terminal's own selection (off)", category: 'system' },
  { name: 'quit', usage: '/quit', description: 'Exit the TUI', category: 'system' },
];

/**
 * Familiar spellings the planner chat answers the same way as a built-in. Kept
 * as data rather than extra `SLASH_COMMANDS` rows so one canonical command owns
 * the behaviour: an alias is a name and a target, never a second
 * implementation, so the pair cannot drift and a further synonym is one line.
 * An alias also joins `BY_NAME` below, which is what `registerSkillCommands`
 * checks first — a skill may never silently shadow it.
 */
export interface CommandAlias {
  name: string;
  target: string;
  description: string;
}

export const COMMAND_ALIASES: CommandAlias[] = [
  // Editors call reopening a saved session "resume"; here it must open the same
  // saved-session picker as /sessions, not restart a task or a runner.
  { name: 'resume', target: 'sessions', description: 'Alias for /sessions: open a saved session, not restart a task' },
];

/**
 * The built-in table with each alias placed right after the command it spells,
 * so `/help` and the completion menu group a synonym with its target. This is
 * what user-facing listings read; `SLASH_COMMANDS` stays the canonical,
 * one-entry-per-behaviour list the parity test checks.
 */
export function slashCommandTable(): SlashCommand[] {
  const table: SlashCommand[] = [];
  for (const command of SLASH_COMMANDS) {
    table.push(command);
    for (const alias of COMMAND_ALIASES) {
      if (alias.target !== command.name) continue;
      table.push({ name: alias.name, usage: `/${alias.name}`, description: alias.description, category: command.category });
    }
  }
  return table;
}

const BY_NAME = new Map(slashCommandTable().map((c) => [c.name, c]));

/** The canonical command a name finally runs as: an alias resolves to its target, everything else is itself. */
export function canonicalCommandName(name: string): string {
  const key = name.replace(/^\//, '').toLowerCase();
  return COMMAND_ALIASES.find((a) => a.name === key)?.target ?? key;
}

export interface SkillCommandSource {
  name: string;
  description: string;
  appliesTo?: 'planner' | 'task';
  /** False hides the skill: only the model may invoke it. */
  userInvocable?: boolean;
}

/**
 * Skill-backed commands discovered at startup (SkillsService), kept separate
 * from `SLASH_COMMANDS` so the built-in list — and anything that renders it,
 * like the help sheet — stays untouched by what a workspace happens to have
 * under .ordewell/skills/.
 */
let skillCommands: SlashCommand[] = [];
let skillByName = new Map<string, SlashCommand>();

/** A name already taken by a built-in is dropped — the built-in always wins. */
export function registerSkillCommands(skills: SkillCommandSource[]): void {
  const map = new Map<string, SlashCommand>();
  for (const skill of skills) {
    if (BY_NAME.has(skill.name) || skill.userInvocable === false) continue;
    map.set(skill.name, {
      name: skill.name,
      usage: `/${skill.name}`,
      description: skill.appliesTo === 'task' ? `task skill · ${skill.description}` : skill.description,
      category: 'skills',
      source: 'skill',
    });
  }
  skillByName = map;
  skillCommands = [...map.values()];
}

/** `null` when the text is ordinary chat rather than a `/command`. */
export function parseSlash(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return { name: parts[0].toLowerCase(), args: parts.slice(1) };
}

export function findCommand(name: string): SlashCommand | undefined {
  const key = name.replace(/^\//, '').toLowerCase();
  return BY_NAME.get(key) ?? skillByName.get(key);
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
  return [...slashCommandTable(), ...skillCommands].filter((c) => c.name.startsWith(prefix));
}

/** A `/word` token found anywhere in a prompt, whitespace- (or string-edge-) bounded. */
export interface SlashToken {
  /** Offset of this token's leading `/` in the buffer. */
  start: number;
  /** Offset immediately after the raw non-whitespace run following the `/`. */
  end: number;
  /** `name` lower-cased, with trailing `, . ! ? ; :` peeled off — what actually gets matched. */
  name: string;
  /** Offset immediately after `name`, i.e. before any trailing punctuation — where a highlight span should stop. */
  nameEnd: number;
}

const TRAILING_PUNCT = /[,.!?;:]+$/;

/**
 * Every `/word` token in `text`, bounded by whitespace or the string edges —
 * the same shape `resolveSkillInvocation` (core) resolves, so a token the TUI
 * offers to complete or highlights is exactly one core will load.
 */
export function slashTokens(text: string): SlashToken[] {
  const tokens: SlashToken[] = [];
  const re = /(^|\s)\/(\S*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const start = match.index + match[1].length;
    const raw = match[2];
    const punct = raw.match(TRAILING_PUNCT)?.[0] ?? '';
    const nameLen = raw.length - punct.length;
    tokens.push({
      start,
      end: start + 1 + raw.length,
      name: raw.slice(0, nameLen).toLowerCase(),
      nameEnd: start + 1 + nameLen,
    });
  }
  return tokens;
}

/** The token the caret is actively composing — immediately after it, nothing typed past it yet. */
export function activeToken(text: string, cursor: number): SlashToken | null {
  return slashTokens(text).find((t) => t.end === cursor) ?? null;
}

/**
 * Whether `name` names a *discovered* skill exactly, or is a live prefix of
 * one — never a built-in, since only a discovered skill is ever loaded by a
 * token in a message (see resolveSkillInvocation in core).
 */
export function skillMatchKind(name: string): 'exact' | 'prefix' | null {
  if (name.length === 0) return null;
  if (skillByName.has(name)) return 'exact';
  for (const key of skillByName.keys()) {
    if (key.startsWith(name)) return 'prefix';
  }
  return null;
}

/**
 * A task chat's `/name args`, for its runner (#66): the name as typed and
 * the rest of the message whole, since the runner parses its own arguments.
 * No command name has a `/` in it, so a message opening with a path is text.
 */
export function parseRunnerCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1], args: (match[2] ?? '').trim() } : null;
}

/** The runner's own command a task chat's `/name` names, by its name or another it answers to. */
export function runnerCommandFor(commands: readonly RunnerCommand[], name: string): RunnerCommand | undefined {
  return findRunnerCommand(commands, name) ?? findRunnerCommand(commands, name.toLowerCase());
}

/**
 * What a token completes to: in a task chat, the runner's commands alone,
 * and only at the start of the message, the one place a runner reads one
 * (#66); in the planner chat, Ordewell's.
 */
export function composerCompletions(token: SlashToken, runner: readonly RunnerCommand[] | null): string[] {
  if (runner) return token.start === 0 ? runner.filter((c) => c.name.toLowerCase().startsWith(token.name)).map((c) => c.name) : [];
  return tokenCompletions(token).map((c) => c.name);
}

/**
 * Commands matching a token being composed at `token.start`: the combined
 * built-in+skill list at the very start of the buffer (unchanged contract —
 * `completions` above), skills only anywhere else, since a mid-prompt token
 * only ever loads a discovered skill, never a built-in.
 */
export function tokenCompletions(token: SlashToken): SlashCommand[] {
  const pool = token.start === 0 ? [...slashCommandTable(), ...skillCommands] : skillCommands;
  return pool.filter((c) => c.name.startsWith(token.name));
}
