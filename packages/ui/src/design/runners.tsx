/**
 * The runners Ordewell knows by name, and the badge that names one. A runner's
 * colour appears on this badge and nowhere else, and always beside its name
 * (docs/desktop/design.md, Visual language, rule 3; checklist C2).
 */
export const RUNNER_NAMES: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/** The shortest a name may get in a narrow row: shortened, never dropped. */
const SHORT_NAMES: Readonly<Record<string, string>> = { 'claude-code': 'Claude' };

/** A runner's name for people; one Ordewell does not know keeps its id. */
export function runnerName(id: string, options: { short?: boolean } = {}): string {
  if (!Object.hasOwn(RUNNER_NAMES, id)) return id;
  return (options.short ? SHORT_NAMES[id] : undefined) ?? RUNNER_NAMES[id];
}

export interface RunnerBadgeProps {
  runner: string;
  /** In a narrow row: *Claude* for Claude Code. The full name stays in the tooltip. */
  short?: boolean;
  className?: string;
}

/**
 * The runner's colour as text on its own tint, with its name. A runner with no
 * colour of its own (one a later release adds) is drawn neutral rather than
 * borrowing another's.
 */
export function RunnerBadge({ runner, short, className }: RunnerBadgeProps): JSX.Element {
  const known = Object.hasOwn(RUNNER_NAMES, runner);
  const classes = ['ow-badge', 'ow-runner-badge', known ? `ow-runner-${runner}` : 'ow-runner-other', className].filter(Boolean).join(' ');
  return (
    <span className={classes} data-runner={runner} title={runnerName(runner)}>
      <span className="ow-badge-label">{runnerName(runner, { short })}</span>
    </span>
  );
}
