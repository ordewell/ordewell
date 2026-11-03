import { Files, GitBranch, GitCompare, Settings } from 'lucide-react';
import { IconButton, PlanGlyph, type IconComponent } from '@ordewell/ui/design';
import { activityTitle } from './commands';
import { formatChord, isMac, parseChord } from './keys';
import { ACTIVITIES, type ActivityId } from './layout';
import { useFrameState, useFrameStore } from './store';

const ICONS: Readonly<Record<ActivityId, IconComponent>> = {
  plan: PlanGlyph,
  explorer: Files,
  changes: GitCompare,
  git: GitBranch,
};

/** The far-left column: picks what the sidebar shows; a click on the shown one hides it. */
export function ActivityBar(): JSX.Element {
  const store = useFrameStore();
  const { layout, commands } = useFrameState();
  const mac = isMac(store.platform);
  const hint = (id: string): string => {
    const keys = commands.find((command) => command.id === id)?.keys;
    return keys ? ` (${formatChord(parseChord(keys), mac)})` : '';
  };

  return (
    <nav className="frame-activity" aria-label="Views">
      <div className="frame-activity-items">
        {ACTIVITIES.map((activity) => {
          const shown = layout.sidebarOpen && layout.activity === activity;
          return (
            <IconButton
              key={activity}
              icon={ICONS[activity]}
              size={20}
              label={activityTitle(activity)}
              title={`${activityTitle(activity)}${hint(`view.${activity}`)}`}
              active={shown}
              aria-pressed={shown}
              onClick={() => store.dispatch({ type: 'activity', activity, toggle: true })}
            />
          );
        })}
      </div>
      <IconButton
        icon={Settings}
        size={20}
        label="Settings"
        title={`Settings${hint('settings.open')}`}
        onClick={() => store.api.runCommand('settings.open')}
      />
    </nav>
  );
}
