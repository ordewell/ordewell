import type { PaneSizes } from '../../shared/bridge';

/** The four views the activity bar switches the sidebar between; Settings opens as a tab instead. */
export type ActivityId = 'plan' | 'explorer' | 'changes' | 'git';

export const ACTIVITIES: readonly ActivityId[] = ['plan', 'explorer', 'changes', 'git'];

/**
 * Which tree a file, diff or terminal view reads (ADR-0061 R2, CONTEXT.md
 * "View scope"). The plan never has one.
 */
export type ViewScope =
  | { kind: 'checkout' }
  | { kind: 'integration'; sessionId: string }
  | { kind: 'task'; sessionId: string; taskId: string };

/** What a view asks the frame to open: a kind a view module registered, and which one of it. */
export interface TabRef {
  kind: string;
  id: string;
  title: string;
  scope?: ViewScope;
}

export interface Tab extends TabRef {
  /** Kind, scope and id: the same file in two scopes is two tabs. */
  key: string;
  /** Shown in italics and replaced by the next preview, until a double click or an edit keeps it. */
  preview: boolean;
  /** The Plan tab: always first in the first group, never closed. */
  fixed: boolean;
}

export interface TabGroup {
  tabs: Tab[];
  active: string | undefined;
}

export interface Layout {
  activity: ActivityId;
  sidebarOpen: boolean;
  /** The planner panel. */
  rightOpen: boolean;
  /** The terminal panel: hidden until asked for. */
  bottomOpen: boolean;
  /** One group, or two side by side once split. */
  groups: TabGroup[];
  focusedGroup: number;
  sizes: PaneSizes;
}

export type Pane = keyof PaneSizes;

/** Each pane's bounds, so neither a drag nor a stored size can hide the main area or make a pane unusable. */
export const PANE_BOUNDS: Readonly<Record<Pane, { min: number; max: number }>> = {
  sidebar: { min: 180, max: 600 },
  right: { min: 260, max: 720 },
  bottom: { min: 120, max: 640 },
};

export const PLAN_TAB: TabRef = { kind: 'plan', id: 'plan', title: 'Plan' };

export function scopeKey(scope: ViewScope | undefined): string {
  if (!scope) return '';
  switch (scope.kind) {
    case 'checkout': return 'checkout';
    case 'integration': return `integration/${scope.sessionId}`;
    case 'task': return `task/${scope.sessionId}/${scope.taskId}`;
  }
}

export function tabKey(ref: Pick<TabRef, 'kind' | 'id' | 'scope'>): string {
  return `${ref.kind}:${scopeKey(ref.scope)}:${ref.id}`;
}

function clamp(pane: Pane, size: number): number {
  const { min, max } = PANE_BOUNDS[pane];
  return Math.round(Math.min(max, Math.max(min, size)));
}

export function initialLayout(sizes: PaneSizes): Layout {
  const plan: Tab = { ...PLAN_TAB, key: tabKey(PLAN_TAB), preview: false, fixed: true };
  return {
    activity: 'plan',
    sidebarOpen: true,
    rightOpen: true,
    bottomOpen: false,
    groups: [{ tabs: [plan], active: plan.key }],
    focusedGroup: 0,
    sizes: { sidebar: clamp('sidebar', sizes.sidebar), right: clamp('right', sizes.right), bottom: clamp('bottom', sizes.bottom) },
  };
}

export type LayoutAction =
  /** `toggle`: a click on the active item hides the sidebar, as a shortcut to it does not. */
  | { type: 'activity'; activity: ActivityId; toggle?: boolean }
  | { type: 'toggleSidebar' }
  | { type: 'togglePanel'; panel: 'right' | 'bottom'; open?: boolean }
  | { type: 'open'; tab: TabRef; preview?: boolean; group?: number }
  | { type: 'keep'; group: number; key: string }
  | { type: 'activate'; group: number; key: string }
  | { type: 'close'; group: number; key: string }
  | { type: 'closeActive' }
  | { type: 'move'; group: number; key: string; to: number }
  | { type: 'split' }
  | { type: 'cycle'; delta: 1 | -1 }
  | { type: 'focusGroup'; group: number }
  | { type: 'resize'; pane: Pane; size: number };

function withGroup(layout: Layout, index: number, group: TabGroup): Layout {
  const groups = layout.groups.slice();
  groups[index] = group;
  return { ...layout, groups };
}

/** The tab group to open into: an existing one, or a new second group beside the first. */
function groupAt(layout: Layout, index: number): TabGroup | undefined {
  return layout.groups[index] ?? (index === 1 && layout.groups.length === 1 ? { tabs: [], active: undefined } : undefined);
}

function open(layout: Layout, ref: TabRef, preview: boolean, index: number): Layout {
  const group = groupAt(layout, index);
  if (!group) return layout;
  const key = tabKey(ref);
  const at = group.tabs.findIndex((tab) => tab.key === key);
  if (at >= 0) {
    // Opening what is open shows it; opening it for keeps keeps a preview.
    const existing = group.tabs[at];
    const tabs = group.tabs.slice();
    tabs[at] = { ...existing, title: ref.title, preview: existing.preview && preview };
    return { ...withGroup(layout, index, { tabs, active: key }), focusedGroup: index };
  }
  const tab: Tab = { ...ref, key, preview, fixed: false };
  const tabs = group.tabs.slice();
  const previewAt = preview ? tabs.findIndex((candidate) => candidate.preview) : -1;
  if (previewAt >= 0) {
    tabs[previewAt] = tab;
  } else {
    const activeAt = tabs.findIndex((candidate) => candidate.key === group.active);
    tabs.splice(activeAt >= 0 ? activeAt + 1 : tabs.length, 0, tab);
  }
  return { ...withGroup(layout, index, { tabs, active: key }), focusedGroup: index };
}

function close(layout: Layout, index: number, key: string): Layout {
  const group = layout.groups[index];
  const at = group?.tabs.findIndex((tab) => tab.key === key) ?? -1;
  if (!group || at < 0 || group.tabs[at].fixed) return layout;
  const tabs = group.tabs.filter((tab) => tab.key !== key);
  const active = group.active === key ? (tabs[at] ?? tabs[at - 1])?.key : group.active;
  if (tabs.length === 0 && layout.groups.length > 1) {
    const groups = layout.groups.filter((_, i) => i !== index);
    return { ...layout, groups, focusedGroup: Math.min(layout.focusedGroup, groups.length - 1) };
  }
  return withGroup(layout, index, { tabs, active });
}

function move(layout: Layout, index: number, key: string, to: number): Layout {
  const group = layout.groups[index];
  const from = group?.tabs.findIndex((tab) => tab.key === key) ?? -1;
  if (!group || from < 0 || group.tabs[from].fixed) return layout;
  const tabs = group.tabs.slice();
  const [tab] = tabs.splice(from, 1);
  // A fixed tab keeps the head of the strip; nothing is dropped before it.
  const floor = tabs.filter((candidate) => candidate.fixed).length;
  tabs.splice(Math.min(tabs.length, Math.max(floor, to)), 0, tab);
  return withGroup(layout, index, { ...group, tabs });
}

/** The group beside the focused one: the other of two, or a new second one. */
export function besideGroup(layout: Layout): number {
  return layout.groups.length > 1 ? 1 - layout.focusedGroup : 1;
}

/** Open the focused tab again beside it; with two groups already, in the other one. */
function split(layout: Layout): Layout {
  const source = layout.groups[layout.focusedGroup];
  const tab = source?.tabs.find((candidate) => candidate.key === source.active);
  if (!tab) return layout;
  const ref: TabRef = { kind: tab.kind, id: tab.id, title: tab.title, ...(tab.scope ? { scope: tab.scope } : {}) };
  return open(layout, ref, false, besideGroup(layout));
}

function cycle(layout: Layout, delta: 1 | -1): Layout {
  const index = layout.focusedGroup;
  const group = layout.groups[index];
  if (!group || group.tabs.length === 0) return layout;
  const at = group.tabs.findIndex((tab) => tab.key === group.active);
  const next = group.tabs[(at + delta + group.tabs.length) % group.tabs.length];
  return withGroup(layout, index, { ...group, active: next.key });
}

export function reduceLayout(layout: Layout, action: LayoutAction): Layout {
  switch (action.type) {
    case 'activity':
      if (action.toggle && layout.activity === action.activity && layout.sidebarOpen) return { ...layout, sidebarOpen: false };
      return { ...layout, activity: action.activity, sidebarOpen: true };
    case 'toggleSidebar':
      return { ...layout, sidebarOpen: !layout.sidebarOpen };
    case 'togglePanel': {
      const field = action.panel === 'right' ? 'rightOpen' : 'bottomOpen';
      return { ...layout, [field]: action.open ?? !layout[field] };
    }
    case 'open':
      return open(layout, action.tab, action.preview ?? false, action.group ?? layout.focusedGroup);
    case 'keep': {
      const group = layout.groups[action.group];
      if (!group) return layout;
      const tabs = group.tabs.map((tab) => (tab.key === action.key ? { ...tab, preview: false } : tab));
      return withGroup(layout, action.group, { ...group, tabs });
    }
    case 'activate': {
      const group = layout.groups[action.group];
      if (!group?.tabs.some((tab) => tab.key === action.key)) return layout;
      return { ...withGroup(layout, action.group, { ...group, active: action.key }), focusedGroup: action.group };
    }
    case 'close':
      return close(layout, action.group, action.key);
    case 'closeActive': {
      const active = layout.groups[layout.focusedGroup]?.active;
      return active ? close(layout, layout.focusedGroup, active) : layout;
    }
    case 'move':
      return move(layout, action.group, action.key, action.to);
    case 'split':
      return split(layout);
    case 'cycle':
      return cycle(layout, action.delta);
    case 'focusGroup':
      return action.group >= 0 && action.group < layout.groups.length ? { ...layout, focusedGroup: action.group } : layout;
    case 'resize':
      return { ...layout, sizes: { ...layout.sizes, [action.pane]: clamp(action.pane, action.size) } };
  }
}

/** The tab a group shows, if it has one. */
export function activeTab(group: TabGroup | undefined): Tab | undefined {
  return group?.tabs.find((tab) => tab.key === group.active);
}
