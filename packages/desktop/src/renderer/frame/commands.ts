import type { Command, Unregister } from './api';
import { ACTIVITIES, type ActivityId } from './layout';
import type { FrameStore } from './store';
import { THEME_CHOICES, setThemePref } from './themePref';

const ACTIVITY_TITLES: Readonly<Record<ActivityId, string>> = {
  plan: 'Plan',
  explorer: 'Explorer',
  changes: 'Changes',
  git: 'Git',
};

export function activityTitle(activity: ActivityId): string {
  return ACTIVITY_TITLES[activity];
}

export const SETTINGS_TAB = { kind: 'settings', id: 'settings', title: 'Settings' } as const;

/**
 * Focus the first control in a region once React has drawn it: a shortcut that
 * opens a panel lands the keyboard in it. `[data-autofocus]` lets the view say
 * which control that is.
 */
export function focusRegion(region: string): void {
  requestAnimationFrame(() => {
    const root = document.querySelector<HTMLElement>(`[data-region="${region}"]`);
    const target = root?.querySelector<HTMLElement>('[data-autofocus], textarea, input, select, button, [tabindex="0"]');
    target?.focus();
  });
}

/**
 * The frame's own commands, with the keys docs/desktop/design.md gives them.
 * A view slice adds its own through FrameApi.registerCommand.
 */
export function registerFrameCommands(store: FrameStore): Unregister {
  const { api } = store;
  const layout = () => store.getSnapshot().layout;
  const commands: Command[] = [
    { id: 'palette.open', title: 'Show all commands', keys: 'Mod+K', run: () => store.setOverlay('palette') },
    ...ACTIVITIES.map((activity, index): Command => ({
      id: `view.${activity}`,
      title: `Show ${activityTitle(activity)}`,
      keys: `Mod+${index + 1}`,
      run: () => api.showActivity(activity),
    })),
    { id: 'settings.open', title: 'Open Settings', keys: 'Mod+,', run: () => api.openTab(SETTINGS_TAB) },
    ...THEME_CHOICES.map(({ value, label }): Command => ({
      id: `theme.${value}`,
      title: `Theme: ${label}`,
      // Main refuses only a value outside the three, which these never are.
      run: () => { void setThemePref(value).catch(() => undefined); },
    })),
    { id: 'sidebar.toggle', title: 'Toggle sidebar', keys: 'Mod+B', run: () => store.dispatch({ type: 'toggleSidebar' }) },
    {
      id: 'planner.toggle',
      title: 'Toggle planner',
      keys: 'Mod+L',
      run: () => {
        const open = !layout().rightOpen;
        store.dispatch({ type: 'togglePanel', panel: 'right', open });
        if (open) focusRegion('right');
      },
    },
    {
      id: 'terminal.toggle',
      title: 'Toggle terminal',
      keys: 'Ctrl+`',
      run: () => {
        const open = !layout().bottomOpen;
        store.dispatch({ type: 'togglePanel', panel: 'bottom', open });
        if (open) focusRegion('bottom');
      },
    },
    { id: 'needsYou.open', title: 'Show what needs you', keys: 'Mod+Shift+A', run: () => store.setOverlay('needsYou') },
    {
      id: 'primary.run',
      title: 'Run the primary action',
      keys: 'Mod+Shift+Enter',
      enabled: () => { const primary = store.getSnapshot().primary; return !!primary && !primary.disabled; },
      run: () => store.getSnapshot().primary?.run(),
    },
    {
      id: 'tab.close',
      title: 'Close tab',
      keys: 'Mod+W',
      // The Plan tab never closes, so the shortcut does nothing on it rather than something surprising.
      enabled: () => { const group = layout().groups[layout().focusedGroup]; return !!group?.tabs.some((tab) => tab.key === group.active && !tab.fixed); },
      run: () => store.dispatch({ type: 'closeActive' }),
    },
    { id: 'tab.next', title: 'Next tab', keys: 'Ctrl+Tab', run: () => store.dispatch({ type: 'cycle', delta: 1 }) },
    { id: 'tab.previous', title: 'Previous tab', keys: 'Ctrl+Shift+Tab', run: () => store.dispatch({ type: 'cycle', delta: -1 }) },
    { id: 'editor.split', title: 'Split editor right', keys: 'Mod+\\', run: () => store.dispatch({ type: 'split' }) },
  ];
  const undo = commands.map((command) => api.registerCommand(command));
  return () => { for (const off of undo) off(); };
}
