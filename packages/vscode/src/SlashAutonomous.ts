import type { RunnerModeInfo } from '@ordewell/core';

export type ModeTag = 'autonomous' | 'safe';

export interface AutonomousQuickPickItem {
  label: string;
  detail: string;
  description?: string;
  picked: boolean;
  value: boolean;
}

function findTaggedMode(
  modes: RunnerModeInfo[] | undefined,
  tag: ModeTag,
): RunnerModeInfo | undefined {
  if (!modes) return undefined;
  return modes.find((m) => (tag === 'autonomous' ? m.autonomous : m.safe));
}

/** Resolve the mode ID a runner will use under the given toggle value. */
export function resolveRunnerMode(
  runnerId: string,
  modes: RunnerModeInfo[] | undefined,
  autonomous: boolean,
): string {
  const tagged = findTaggedMode(modes, autonomous ? 'autonomous' : 'safe')
    ?? findTaggedMode(modes, autonomous ? 'safe' : 'autonomous');
  if (tagged) return tagged.id;
  if (modes && modes.length > 0) return modes.find((m) => m.id !== 'plan')?.id ?? modes[0].id;
  return '(default)';
}

function detailFor(runners: string[], modesByRunner: Record<string, RunnerModeInfo[]>, autonomous: boolean): string {
  return runners
    .map((r) => `${r}: ${resolveRunnerMode(r, modesByRunner[r], autonomous)}`)
    .join(', ');
}

export function resolveAutonomousQuickPickItems(
  runners: string[],
  modesByRunner: Record<string, RunnerModeInfo[]>,
  currentValue: boolean = true,
): AutonomousQuickPickItem[] {
  return [
    {
      label: 'Autonomous (recommended)',
      detail: detailFor(runners, modesByRunner, true),
      picked: currentValue === true,
      value: true,
    },
    {
      label: 'Standard',
      detail: detailFor(runners, modesByRunner, false),
      picked: currentValue === false,
      value: false,
    },
  ];
}

export function applyAutonomousChoice(
  choice: boolean,
  runners: string[],
  modesByRunner: Record<string, RunnerModeInfo[]>,
): string {
  const resolved = detailFor(runners, modesByRunner, choice);
  const head = choice ? 'Autonomous mode enabled.' : 'Autonomous mode disabled.';
  return `${head} New plans will default to: ${resolved}`;
}