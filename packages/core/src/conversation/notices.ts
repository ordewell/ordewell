/**
 * The built-in runners by the names people know them by. Kept here rather than
 * read from the manifests, which pull in Node-only discovery code this
 * browser-safe module cannot load.
 */
const RUNNER_NAMES: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/** The conversation line for a task starting, worded the same on every surface. */
export function taskStartedNotice(title: string, runner?: string): string {
  if (!runner) return `Started "${title}"`;
  // A runner Ordewell does not ship keeps its id: that is the only name it has.
  return `Started "${title}" · ${Object.hasOwn(RUNNER_NAMES, runner) ? RUNNER_NAMES[runner] : runner}`;
}
