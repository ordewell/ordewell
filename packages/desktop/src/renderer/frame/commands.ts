import type { Command, Unregister } from './api';
import { ACTIVITIES, PLAN_GRAPH_TAB, PLANNER_TAB, shown, type ActivityId } from './layout';
import type { FrameStore } from './store';
import { THEME_CHOICES, setThemePref } from './themePref';

const ACTIVITY_TITLES: Readonly<Record<ActivityId, string>> = {
  sessions: 'Sessions',
  explorer: 'Explorer',
  changes: 'Changes',
  git: 'Git',
};

export function activityTitle(activity: ActivityId): string {
  return ACTIVITY_TITLES[activity];
}

export const SETTINGS_TAB = { kind: 'settings', id: 'settings', title: 'Settings' } as const;

const FOCUSABLE = '[data-autofocus], textarea, input, select, button, [tabindex="0"]';

/**
 * Focus the first control in a region once React has drawn it: a shortcut that
 * opens a panel lands the keyboard in it. `[data-autofocus]` lets the view say
 * which control that is.
 */
export function focusRegion(region: string, within?: string): void {
  requestAnimationFrame(() => {
    const root = document.querySelector<HTMLElement>(`[data-region="${region}"]${within ? ` ${within}` : ''}`);
    const target = root?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
  });
}

/** F6's order (docs/desktop/design.md, Keyboard): a region not drawn now is passed over. */
const REGIONS = ['title', 'sidebar', 'main', 'plan', 'terminal', 'status'] as const;

function focusNextRegion(delta: 1 | -1): void {
  const here = document.activeElement?.closest<HTMLElement>('[data-region]')?.dataset.region;
  const drawn = REGIONS.filter((region) => document.querySelector(`[data-region="${region}"]`));
  if (drawn.length === 0) return;
  const at = drawn.indexOf(here as (typeof REGIONS)[number]);
  const next = drawn[at < 0 ? (delta > 0 ? 0 : drawn.length - 1) : (at + delta + drawn.length) % drawn.length];
  const root = document.querySelector<HTMLElement>(`[data-region="${next}"]`);
  const target = root?.querySelector<HTMLElement>(FOCUSABLE) ?? root;
  if (target && target === root && !root.hasAttribute('tabindex')) root.tabIndex = -1;
  target?.focus();
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
      // Again on the activity shown hides the sidebar, as a click on its item does.
      run: () => store.dispatch({ type: 'activity', activity, toggle: true }),
    })),
    { id: 'settings.open', title: 'Open Settings', keys: 'Mod+,', run: () => api.openTab(SETTINGS_TAB) },
    // No keys: Mod+O is the File menu's accelerator, which main sees before the page does.
    { id: 'project.openFolder', title: 'Open Folder…', run: () => store.projects.open(undefined, { newWindow: false }) },
    { id: 'project.switch', title: 'Switch Project…', run: () => store.setOverlay('project') },
    ...THEME_CHOICES.map(({ value, label }): Command => ({
      id: `theme.${value}`,
      title: `Theme: ${label}`,
      // Main refuses only a value outside the three, which these never are.
      run: () => { void setThemePref(value).catch(() => undefined); },
    })),
    { id: 'sidebar.toggle', title: 'Toggle sidebar', keys: 'Mod+B', run: () => store.dispatch({ type: 'toggleSidebar' }) },
    {
      id: 'plan.toggle',
      title: 'Toggle plan panel',
      keys: 'Mod+Alt+B',
      run: () => {
        store.dispatch({ type: 'togglePlan' });
        const now = layout();
        if (shown(now).plan || now.drawer === 'plan') focusRegion('plan');
      },
    },
    {
      id: 'planner.focus',
      title: 'Go to the planner',
      keys: 'Mod+L',
      run: () => {
        api.openTab(PLANNER_TAB);
        focusRegion('main', '[data-tab-kind="planner"]');
      },
    },
    { id: 'planGraph.open', title: 'Open the plan graph', keys: 'Mod+Shift+G', run: () => api.openTab(PLAN_GRAPH_TAB) },
    {
      id: 'terminal.toggle',
      title: 'Toggle terminal',
      keys: 'Ctrl+`',
      run: () => {
        store.dispatch({ type: 'toggleTerminal' });
        if (layout().terminalOpen) focusRegion('terminal');
      },
    },
    { id: 'needsYou.open', title: 'Show what needs you', keys: 'Mod+Shift+A', run: () => store.setOverlay('needsYou') },
    {
      id: 'primary.run',
      title: 'Run the primary action',
      keys: 'Mod+Shift+Enter',
      enabled: () => { const { primary, readOnly } = store.getSnapshot(); return !!primary && !primary.disabled && !readOnly; },
      run: () => store.getSnapshot().primary?.run(),
    },
    {
      id: 'tab.close',
      title: 'Close tab',
      keys: 'Mod+W',
      // The planner tab never closes, so the shortcut does nothing on it rather than something surprising.
      enabled: () => { const group = layout().groups[layout().focusedGroup]; return !!group?.tabs.some((tab) => tab.key === group.active && !tab.fixed); },
      run: () => store.dispatch({ type: 'closeActive' }),
    },
    { id: 'tab.next', title: 'Next tab', keys: 'Ctrl+Tab', run: () => store.dispatch({ type: 'cycle', delta: 1 }) },
    { id: 'tab.previous', title: 'Previous tab', keys: 'Ctrl+Shift+Tab', run: () => store.dispatch({ type: 'cycle', delta: -1 }) },
    { id: 'editor.split', title: 'Split editor right', keys: 'Mod+\\', run: () => store.dispatch({ type: 'split' }) },
    { id: 'focus.nextRegion', title: 'Focus the next region', keys: 'F6', run: () => focusNextRegion(1) },
    { id: 'focus.previousRegion', title: 'Focus the previous region', keys: 'Shift+F6', run: () => focusNextRegion(-1) },
    {
      id: 'layout.reset',
      title: 'Reset layout',
      more: true,
      run: () => {
        store.dispatch({ type: 'reset' });
        api.announce('Layout reset');
      },
    },
  ];
  const undo = commands.map((command) => api.registerCommand(command));
  return () => { for (const off of undo) off(); };
}
