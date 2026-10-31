/**
 * The chat's slash commands, as one table: the host answers exactly these
 * (SlashParser), the input suggests them, and /help lists them. Plain data,
 * so the webview can import it as well as the host.
 */
export interface SlashCommandSpec {
  label: string;
  detail: string;
  insertText: string;
  /** Familiar spellings the host answers exactly as this command. Each is
   * offered and dispatched on its own, so there is no second implementation to
   * keep in sync — see `ALL_SLASH_COMMANDS` and `resolveSlashAlias` below. */
  aliases?: readonly string[];
}

export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  { label: '/planner', detail: 'Pick the planner: harness, model and effort in one flow', insertText: '/planner' },
  { label: '/login', detail: 'Sign the active planner in; /login <runner> signs in a named agent', insertText: '/login' },
  { label: '/key set ', detail: 'Set an API key for a provider', insertText: '/key set ' },
  { label: '/sessions', detail: 'Browse and load a saved session (not restart a task)', insertText: '/sessions', aliases: ['resume'] },
  { label: '/new', detail: 'Start a new session (clears the current plan and stops a running one)', insertText: '/new' },
  { label: '/fork', detail: 'Continue in a copy of this conversation and its tasks; the original stays as it is', insertText: '/fork' },
  { label: '/rewind', detail: 'Fork the conversation from just before one of your messages (the original is kept)', insertText: '/rewind' },
  { label: '/compact', detail: 'Condense this conversation into a summary; the last two exchanges and all tasks are kept', insertText: '/compact' },
  { label: '/allowlist', detail: 'Restrict which models the planner may auto-assign per runner', insertText: '/allowlist' },
  { label: '/refresh', detail: 'Re-discover runner models (e.g. after enabling an opencode backend)', insertText: '/refresh' },
  { label: '/settings', detail: 'Open the run settings: autonomy, supervisor, merging, autorun, parallel tasks, delegation', insertText: '/settings' },
  { label: '/help', detail: 'Show all available commands', insertText: '/help' },
];

/**
 * Every command with its aliases inline, an alias right after its target: the
 * one table the answered names, /help and the input suggestions are all built
 * from, so a synonym is discoverable wherever its target is.
 */
export const ALL_SLASH_COMMANDS: readonly SlashCommandSpec[] = SLASH_COMMANDS.flatMap((c) => [
  c,
  ...(c.aliases ?? []).map((alias) => ({
    label: `/${alias}`,
    detail: `Alias for ${c.label.trim()}: ${c.detail}`,
    insertText: `/${alias}`,
  })),
]);

/** First words the host answers. Anything else starting with '/' is a skill invocation, and goes to the planner. */
export const SLASH_COMMAND_NAMES: ReadonlySet<string> = new Set(
  ALL_SLASH_COMMANDS.map((c) => c.label.trim().slice(1).split(/\s+/)[0]),
);

/** The canonical first word a name finally runs as: an alias resolves to its target, everything else is itself. */
export function resolveSlashAlias(word: string): string {
  const key = word.replace(/^\//, '').toLowerCase();
  for (const command of SLASH_COMMANDS) {
    if ((command.aliases ?? []).some((a) => a.toLowerCase() === key)) {
      return '/' + command.label.trim().slice(1).split(/\s+/)[0];
    }
  }
  return word;
}

/**
 * Whether the text names a built-in the host answers itself, as opposed to a
 * discovered skill invocation (or unknown) that goes to the planner. Pure, so
 * the webview can share the rule without importing the host's parser.
 */
export function isBuiltinSlashCommand(text: string): boolean {
  const name = text.trim().slice(1).split(/\s+/)[0]?.toLowerCase();
  return !!name && SLASH_COMMAND_NAMES.has(name);
}

export function slashHelp(): string {
  return ALL_SLASH_COMMANDS.map((c) => `${c.label.trim()}: ${c.detail}`).join('\n');
}
