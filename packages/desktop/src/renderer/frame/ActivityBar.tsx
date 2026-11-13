import { FileDiff, Files, GitBranch, Layers, Settings, SquareTerminal } from 'lucide-react';
import { IconButton, type IconComponent } from '@ordewell/ui/design';
import type { ActivityBadge } from './api';
import { activityTitle } from './commands';
import { formatChord, isMac, parseChord } from './keys';
import { ACTIVITIES, shown, type ActivityId } from './layout';
import { useFrameState, useFrameStore } from './store';

export const ACTIVITY_ICONS: Readonly<Record<ActivityId, IconComponent>> = {
  sessions: Layers,
  explorer: Files,
  changes: FileDiff,
  git: GitBranch,
};

/**
 * The far-left column, a vertical tablist: picks what the sidebar shows; a
 * click on the shown one hides it. Each item is 44 square with its icon at
 * the activity size, so a pointer finds it (the #33 audit's small icons).
 */
export function ActivityBar(): JSX.Element {
  const store = useFrameStore();
  const { layout, commands, needsYou, badges } = useFrameState();
  const mac = isMac(store.platform);
  const hint = (id: string): string => {
    const keys = commands.find((command) => command.id === id)?.keys;
    return keys ? ` (${formatChord(parseChord(keys), mac)})` : '';
  };
  // Sessions carries Needs you before its own badge: what waits on the user is the louder news.
  const badgeOf = (activity: ActivityId): ActivityBadge | undefined =>
    activity === 'sessions' && needsYou > 0 ? { count: needsYou, label: `${needsYou} need${needsYou === 1 ? 's' : ''} you` } : badges[activity];
  const docked = shown(layout).sidebar || layout.drawer === 'sidebar';

  return (
    <nav className="frame-activity" aria-label="Views">
      <div className="frame-activity-items" role="tablist" aria-orientation="vertical" aria-label="Views">
        {ACTIVITIES.map((activity) => {
          const selected = docked && layout.activity === activity;
          const badge = badgeOf(activity);
          const name = activityTitle(activity);
          return (
            <IconButton
              key={activity}
              role="tab"
              icon={ACTIVITY_ICONS[activity]}
              size={22}
              className="frame-activity-item"
              data-activity={activity}
              label={badge ? `${name}, ${badge.label}` : name}
              title={`${name}${hint(`view.${activity}`)}`}
              active={selected}
              aria-selected={selected}
              badge={badge?.count !== undefined ? badge.count : badge?.dot ? '' : undefined}
              onClick={() => store.dispatch({ type: 'activity', activity, toggle: true })}
            />
          );
        })}
      </div>
      <div className="frame-activity-items">
        <IconButton
          icon={SquareTerminal}
          size={22}
          className="frame-activity-item"
          label="Toggle terminal"
          title={`Toggle terminal${hint('terminal.toggle')}`}
          active={layout.terminalOpen}
          aria-pressed={layout.terminalOpen}
          onClick={() => store.api.runCommand('terminal.toggle')}
        />
        <IconButton
          icon={Settings}
          size={22}
          className="frame-activity-item"
          label="Settings"
          title={`Settings${hint('settings.open')}`}
          onClick={() => store.api.runCommand('settings.open')}
        />
      </div>
    </nav>
  );
}
