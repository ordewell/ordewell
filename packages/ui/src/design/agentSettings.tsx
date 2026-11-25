import { isAgentSettingsPath } from '@ordewell/core/plan-utils';
import { Badge } from './Badge';

export const AGENT_SETTINGS_LABEL = 'agent settings';
export const AGENT_SETTINGS_HINT = 'Agents load this file when they start. Review it before you merge.';

export interface AgentSettingsBadgeProps {
  /** The changed file, as its list names it. */
  path: string;
  /** The workspace's folder from the repository's top, when `path` is named from the top (ADR-0028). */
  workspace?: string;
  className?: string;
}

/**
 * The mark a list of changed files puts on runner configuration a task
 * changed: a person reviewing the run sees at a glance what agents will load.
 * Neutral, as it says what a file is, not a task's state. Nothing for any
 * other file.
 */
export function AgentSettingsBadge({ path, workspace, className }: AgentSettingsBadgeProps): JSX.Element | null {
  if (!isAgentSettingsPath(path, workspace)) return null;
  return (
    <Badge className={['ow-agent-settings', className].filter(Boolean).join(' ')} title={AGENT_SETTINGS_HINT} aria-description={AGENT_SETTINGS_HINT}>
      {AGENT_SETTINGS_LABEL}
    </Badge>
  );
}
