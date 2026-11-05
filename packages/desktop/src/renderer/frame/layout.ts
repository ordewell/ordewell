import type { SavedLayout } from '../../shared/bridge';

/** The four views the activity bar switches the sidebar between; Settings opens as a tab instead. */
export type ActivityId = 'sessions' | 'explorer' | 'changes' | 'git';

export const ACTIVITIES: readonly ActivityId[] = ['sessions', 'explorer', 'changes', 'git'];

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
  /** The Planner tab: always first in the first group, never closed. */
  fixed: boolean;
}

export interface TabGroup {
  tabs: Tab[];
  active: string | undefined;
}

/** The three panes a sash resizes: two widths and the terminal's height. */
export type Pane = 'sidebar' | 'plan' | 'terminal';

export type PaneSizes = Record<Pane, number>;

export interface Viewport {
  width: number;
  height: number;
}

/** The fixed parts of the window (docs/desktop/design.md, Sizing and responsive rules). */
export const ACTIVITY_BAR = 52;
export const TITLE_BAR = 40;
export const STATUS_BAR = 24;
export const TAB_STRIP = 36;
export const RAIL = 44;
/** The centre never goes narrower than this: the panels give way first. */
export const CENTRE_MIN = 560;
/** The tab content keeps this much height; the terminal gives way first. */
export const TAB_CONTENT_MIN = 240;
/** How much wider than the threshold a window must be before a squeezed panel comes back, so a resize across it does not flicker. */
export const HYSTERESIS = 24;

/** The panels' sizes the first time a window of this width opens, before the user drags any of them. */
export function bandDefaults(width: number): PaneSizes {
  if (width <= 1400) return { sidebar: 240, plan: 340, terminal: 240 };
  if (width <= 1700) return { sidebar: 260, plan: 360, terminal: 240 };
  return { sidebar: 280, plan: 380, terminal: 280 };
}

/** A pane's own bounds: the terminal's top one follows the window, so the tab content keeps its height. */
export function paneBounds(pane: Pane, viewport: Viewport): { min: number; max: number } {
  switch (pane) {
    case 'sidebar': return { min: 200, max: 480 };
    case 'plan': return { min: 300, max: 560 };
    case 'terminal': {
      const room = viewport.height - TITLE_BAR - STATUS_BAR - TAB_STRIP - TAB_CONTENT_MIN;
      return { min: 120, max: Math.max(120, Math.min(Math.floor(viewport.height * 0.6), room)) };
    }
  }
}

export interface Layout {
  activity: ActivityId;
  /** The user's choice; `squeezed.sidebar` hides it for now without changing it. */
  sidebarOpen: boolean;
  /** The plan panel docked open, as the user left it; false is the rail. */
  planOpen: boolean;
  terminalOpen: boolean;
  /** One group, or two side by side once split. */
  groups: TabGroup[];
  focusedGroup: number;
  /** Only the sizes the user dragged to: the rest follow the window's band. */
  userSizes: Partial<PaneSizes>;
  viewport: Viewport;
  /** What the window's width takes away for now, given back as it widens (Collapse order). */
  squeezed: { sidebar: boolean; plan: boolean };
  /** A squeezed panel opened over the centre: the sidebar from the activity bar, the plan from its rail. */
  drawer: 'sidebar' | 'plan' | undefined;
  /** The status the rail's count asked the plan drawer to show. */
  planFilter: string | undefined;
  /** The session the tabs are shown for; undefined until a session is open. */
  session: string | undefined;
  /** Each other session's own tabs, put away by a switch until that session is open again. */
  parked: Readonly<Record<string, readonly ParkedTab[]>>;
}

/** A tab a session switch put away, with where it was. */
export interface ParkedTab {
  tab: Tab;
  group: number;
  active: boolean;
}

export const PLANNER_TAB: TabRef = { kind: 'planner', id: 'planner', title: 'Planner' };
export const PLAN_GRAPH_TAB: TabRef = { kind: 'plan-graph', id: 'plan-graph', title: 'Plan graph' };

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

function isActivity(value: unknown): value is ActivityId {
  return typeof value === 'string' && (ACTIVITIES as readonly string[]).includes(value);
}

/** Whether the sidebar and the plan panel are drawn docked, after the window has had its say. */
export function shown(layout: Layout): { sidebar: boolean; plan: boolean } {
  return { sidebar: layout.sidebarOpen && !layout.squeezed.sidebar, plan: layout.planOpen && !layout.squeezed.plan };
}

/** The sizes the panes are drawn at: the user's, else the band's, inside their bounds. */
export function paneSizes(layout: Pick<Layout, 'userSizes' | 'viewport'>): PaneSizes {
  const band = bandDefaults(layout.viewport.width);
  const size = (pane: Pane): number => {
    const { min, max } = paneBounds(pane, layout.viewport);
    return Math.round(Math.min(max, Math.max(min, layout.userSizes[pane] ?? band[pane])));
  };
  return { sidebar: size('sidebar'), plan: size('plan'), terminal: size('terminal') };
}

/** What the centre is left with, given which panels are docked. */
function centreWidth(layout: Layout, sidebar: boolean, plan: boolean): number {
  const sizes = paneSizes(layout);
  return layout.viewport.width - ACTIVITY_BAR - (sidebar ? sizes.sidebar : 0) - (plan ? sizes.plan : RAIL);
}

/**
 * The collapse order: the sidebar gives way first, then the plan panel
 * becomes its rail. A panel already squeezed needs HYSTERESIS more before it
 * comes back. Only `squeezed` changes: the user's own choices are kept for
 * when the window widens.
 */
function fit(layout: Layout): Layout {
  const need = (was: boolean): number => CENTRE_MIN + (was ? HYSTERESIS : 0);
  const sidebar = layout.sidebarOpen && centreWidth(layout, true, layout.planOpen) < need(layout.squeezed.sidebar);
  const plan = layout.planOpen && centreWidth(layout, layout.sidebarOpen && !sidebar, true) < need(layout.squeezed.plan);
  const squeezed = sidebar === layout.squeezed.sidebar && plan === layout.squeezed.plan ? layout.squeezed : { sidebar, plan };
  // A drawer is only for a squeezed panel: once it docks again the drawer has nothing to be.
  const drawer = layout.drawer === 'sidebar' && !(layout.sidebarOpen && sidebar)
    ? undefined
    : layout.drawer === 'plan' && layout.planOpen && !plan ? undefined : layout.drawer;
  if (squeezed === layout.squeezed && drawer === layout.drawer) return layout;
  return { ...layout, squeezed, drawer };
}

/** The largest a width pane may be now: its own max, and no more than leaves the centre its minimum. */
export function widthLimit(layout: Layout, pane: 'sidebar' | 'plan'): number {
  const sizes = paneSizes(layout);
  const { sidebar, plan } = shown(layout);
  const others = ACTIVITY_BAR + (pane === 'sidebar' ? (plan ? sizes.plan : RAIL) : (sidebar ? sizes.sidebar : 0));
  const { min, max } = paneBounds(pane, layout.viewport);
  return Math.max(min, Math.min(max, layout.viewport.width - others - CENTRE_MIN));
}

/** A freshly opened window: the user's saved layout for this workspace if there is one, on the Planner tab. */
export function initialLayout(viewport: Viewport, saved?: SavedLayout): Layout {
  const planner: Tab = { ...PLANNER_TAB, key: tabKey(PLANNER_TAB), preview: false, fixed: true };
  const userSizes: Partial<PaneSizes> = {};
  if (saved?.sidebar !== undefined) userSizes.sidebar = saved.sidebar;
  if (saved?.plan !== undefined) userSizes.plan = saved.plan;
  if (saved?.terminal !== undefined) userSizes.terminal = saved.terminal;
  return fit({
    activity: isActivity(saved?.activity) ? saved.activity : 'sessions',
    sidebarOpen: saved?.sidebarOpen ?? true,
    planOpen: saved?.planOpen ?? true,
    terminalOpen: saved?.terminalOpen ?? false,
    groups: [{ tabs: [planner], active: planner.key }],
    focusedGroup: 0,
    userSizes,
    viewport,
    squeezed: { sidebar: false, plan: false },
    drawer: undefined,
    planFilter: undefined,
    session: undefined,
    parked: {},
  });
}

/** What is kept for the next window of this workspace: the user's choices, never what the width did. */
export function savedLayout(layout: Layout): SavedLayout {
  return {
    ...layout.userSizes,
    activity: layout.activity,
    sidebarOpen: layout.sidebarOpen,
    planOpen: layout.planOpen,
    terminalOpen: layout.terminalOpen,
  };
}

export type LayoutAction =
  /** `toggle`: a click on the active item hides the sidebar, as a shortcut to it does not. */
  | { type: 'activity'; activity: ActivityId; toggle?: boolean }
  | { type: 'toggleSidebar' }
  | { type: 'togglePlan'; open?: boolean }
  | { type: 'toggleTerminal'; open?: boolean }
  /** Open a squeezed panel over the centre; `filter` is the status a rail count asked for. */
  | { type: 'drawer'; drawer: 'sidebar' | 'plan'; filter?: string }
  | { type: 'closeDrawer' }
  | { type: 'viewport'; viewport: Viewport }
  | { type: 'reset' }
  | { type: 'open'; tab: TabRef; preview?: boolean; group?: number }
  | { type: 'keep'; group: number; key: string }
  | { type: 'activate'; group: number; key: string }
  | { type: 'close'; group: number; key: string }
  | { type: 'closeActive' }
  | { type: 'move'; group: number; key: string; to: number }
  | { type: 'split' }
  | { type: 'cycle'; delta: 1 | -1 }
  | { type: 'focusGroup'; group: number }
  | { type: 'resize'; pane: Pane; size: number }
  | { type: 'session'; sessionId: string };

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

function resize(layout: Layout, pane: Pane, size: number): Layout {
  const { min, max } = paneBounds(pane, layout.viewport);
  const limit = pane === 'terminal' ? max : widthLimit(layout, pane);
  const next = Math.round(Math.min(limit, Math.max(min, size)));
  if (layout.userSizes[pane] === next) return layout;
  return { ...layout, userSizes: { ...layout.userSizes, [pane]: next } };
}

/** The session a tab belongs to: a task's or an integration branch's; a file, the commit graph and the planner belong to the workspace. */
function sessionOf(tab: Tab): string | undefined {
  return tab.scope && tab.scope.kind !== 'checkout' ? tab.scope.sessionId : undefined;
}

/**
 * A session switch (design.md, Centre): the tabs of every other session are
 * put away, keyed by their session, and the new one's come back where they were.
 */
function showSession(layout: Layout, sessionId: string): Layout {
  if (layout.session === sessionId) return layout;
  const parked: Record<string, ParkedTab[]> = {};
  for (const [id, tabs] of Object.entries(layout.parked)) if (id !== sessionId) parked[id] = [...tabs];
  const groups = layout.groups.map((group, index): TabGroup => {
    const tabs: Tab[] = [];
    for (const tab of group.tabs) {
      const owner = sessionOf(tab);
      if (owner === undefined || owner === sessionId) tabs.push(tab);
      else (parked[owner] ??= []).push({ tab, group: index, active: tab.key === group.active });
    }
    return { tabs, active: tabs.some((tab) => tab.key === group.active) ? group.active : tabs[0]?.key };
  });
  for (const { tab, group, active } of layout.parked[sessionId] ?? []) {
    // A split the switch closed opens again for the tabs that were in it.
    if (group === groups.length && group === 1) groups.push({ tabs: [], active: undefined });
    const into = groups[Math.min(group, groups.length - 1)];
    if (into.tabs.some((candidate) => candidate.key === tab.key)) continue;
    into.tabs.push(tab);
    if (active) into.active = tab.key;
  }
  const kept = groups.filter((group, index) => index === 0 || group.tabs.length > 0);
  return { ...layout, groups: kept, focusedGroup: Math.min(layout.focusedGroup, kept.length - 1), session: sessionId, parked };
}

/** An activity picked while the sidebar is squeezed opens it as a drawer; otherwise it docks. */
function activity(layout: Layout, id: ActivityId, toggle: boolean): Layout {
  if (layout.squeezed.sidebar && layout.sidebarOpen) {
    if (toggle && layout.drawer === 'sidebar' && layout.activity === id) return { ...layout, drawer: undefined };
    return { ...layout, activity: id, drawer: 'sidebar' };
  }
  if (toggle && layout.activity === id && layout.sidebarOpen) return { ...layout, sidebarOpen: false };
  return { ...layout, activity: id, sidebarOpen: true };
}

function reduce(layout: Layout, action: LayoutAction): Layout {
  switch (action.type) {
    case 'activity':
      return activity(layout, action.activity, action.toggle ?? false);
    case 'toggleSidebar':
      if (layout.squeezed.sidebar && layout.sidebarOpen) return { ...layout, drawer: layout.drawer === 'sidebar' ? undefined : 'sidebar' };
      return { ...layout, sidebarOpen: !layout.sidebarOpen };
    case 'togglePlan': {
      const open = action.open ?? !(layout.planOpen && !layout.squeezed.plan);
      // A squeezed panel cannot dock: asking for it opens it over the centre instead.
      if (open && layout.planOpen && layout.squeezed.plan) return { ...layout, drawer: 'plan', planFilter: undefined };
      const next: Layout = { ...layout, planOpen: open, drawer: layout.drawer === 'plan' ? undefined : layout.drawer };
      // Opened in a window too narrow to dock it: the user still sees it, over the centre.
      return open && fit(next).squeezed.plan ? { ...next, drawer: 'plan', planFilter: undefined } : next;
    }
    case 'toggleTerminal':
      return { ...layout, terminalOpen: action.open ?? !layout.terminalOpen };
    case 'drawer':
      return { ...layout, drawer: action.drawer, planFilter: action.drawer === 'plan' ? action.filter : layout.planFilter };
    case 'closeDrawer':
      return layout.drawer ? { ...layout, drawer: undefined, planFilter: undefined } : layout;
    case 'viewport':
      return action.viewport.width === layout.viewport.width && action.viewport.height === layout.viewport.height
        ? layout
        : { ...layout, viewport: action.viewport };
    case 'reset':
      return {
        ...layout,
        activity: 'sessions',
        sidebarOpen: true,
        planOpen: true,
        terminalOpen: false,
        userSizes: {},
        squeezed: { sidebar: false, plan: false },
        drawer: undefined,
        planFilter: undefined,
      };
    case 'open': {
      const next = open(layout, action.tab, action.preview ?? false, action.group ?? layout.focusedGroup);
      // Picking something from a drawer closes it (Collapse order).
      return next.drawer ? { ...next, drawer: undefined, planFilter: undefined } : next;
    }
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
      return resize(layout, action.pane, action.size);
    case 'session':
      return showSession(layout, action.sessionId);
  }
}

export function reduceLayout(layout: Layout, action: LayoutAction): Layout {
  const next = reduce(layout, action);
  return next === layout ? layout : fit(next);
}

/** The tab a group shows, if it has one. */
export function activeTab(group: TabGroup | undefined): Tab | undefined {
  return group?.tabs.find((tab) => tab.key === group.active);
}
