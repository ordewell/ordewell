import type { ReactNode } from 'react';
import type { IconComponent, StatusId } from '@ordewell/ui/design';
import type { ActivityId, Tab, TabRef } from './layout';

export type { ActivityId, Tab, TabRef, ViewScope } from './layout';
export { PLANNER_TAB, PLAN_GRAPH_TAB } from './layout';

/** Undo a registration: a view that unmounts or a test that cleans up. */
export type Unregister = () => void;

/**
 * One section of an activity's sidebar. Several modules may add to one
 * activity, such as Needs you at the head of the Sessions sidebar, and they
 * stack by `order`.
 */
export interface SidebarSection {
  activity: ActivityId;
  id: string;
  title: string;
  /** Lower first; sections with the same order keep registration order. */
  order?: number;
  /** Shown beside the section's title, such as Needs you's "(2)"; read each time the frame redraws. */
  count?(): number | undefined;
  /** The section's header folds it away, as Needs you's and Sessions' do; the user's choice outlives an activity switch. */
  collapsible?: boolean;
  /**
   * The section draws its own heading (Sidebar's SectionHead) and the frame
   * draws none: Review folds its task list under it while the whole run and
   * Merge all stay below. `title` still names the section's region.
   */
  ownsHeading?: boolean;
  /** Icon buttons at the right of the section's header, such as Sessions' +. */
  actions?(): ReactNode;
  render(): ReactNode;
}

/** How a kind of tab is drawn: every tab of that kind, whatever its id. */
export interface TabKind {
  kind: string;
  icon?: IconComponent;
  render(tab: Tab): ReactNode;
}

/** The plan panel's list on the right, the terminal at the bottom; one view fills each. */
export interface PanelView {
  region: 'plan' | 'terminal';
  id: string;
  title: string;
  render(): ReactNode;
}

/** Places in the title and status bars, and the Needs you popover, that a later slice fills. */
export type SlotId =
  | 'title.breadcrumb'
  | 'title.scope'
  | 'status.daemon'
  | 'status.lease'
  | 'status.runners'
  | 'status.usage'
  | 'popover.needsYou';

export interface SlotView {
  slot: SlotId;
  id: string;
  order?: number;
  render(): ReactNode;
}

export interface Command {
  /** Dotted, owner first: "plan.toggleView", "git.fetch". */
  id: string;
  title: string;
  /** A chord in parseChord's syntax, "Mod+Shift+A"; shown in the palette and bound while registered. */
  keys?: string;
  /** Listed in the title bar's ⋯ menu too: the session's secondary actions. */
  more?: boolean;
  /** Hidden from the palette and its keys unbound while this says no. */
  enabled?(): boolean;
  run(): void;
}

export interface PrimaryAction {
  label: string;
  icon?: IconComponent;
  disabled?: boolean;
  run(): void;
}

export interface BannerAction {
  label: string;
  run(): void | Promise<void>;
}

export interface Banner {
  id: string;
  tone: 'info' | 'warning' | 'error';
  title: string;
  body?: string;
  actions?: BannerAction[];
}

/** The plan panel header's progress and its rail's counts. */
export interface PlanProgress {
  done: number;
  total: number;
  /** How many tasks are in each status, for the rail; a status with none is left out. */
  counts: Partial<Record<StatusId, number>>;
}

/** What an activity bar item shows beside its icon: a count, or a dot for something live. */
export interface ActivityBadge {
  count?: number;
  dot?: boolean;
  /** Said with the item's name: "2 changed files", "a run is live". */
  label: string;
}

export interface OpenTabOptions {
  /** Open as a preview: italic, and replaced by the next preview. */
  preview?: boolean;
  /** Open in the group beside the focused one, splitting when there is none. */
  beside?: boolean;
}

/**
 * Everything a view module may do to the frame. A later slice registers its
 * views and opens tabs through this alone, so it never edits the frame's files.
 */
export interface FrameApi {
  /** The workspace this window shows (ADR-0063 H6). */
  readonly workspace: string;
  readonly platform: string;
  /** Whether the daemon is away (setReadOnly): no command of a session's can act until it is back (W15). */
  readonly readOnly: boolean;

  registerSidebar(section: SidebarSection): Unregister;
  registerTabKind(kind: TabKind): Unregister;
  registerPanel(panel: PanelView): Unregister;
  registerSlot(slot: SlotView): Unregister;
  registerCommand(command: Command): Unregister;

  openTab(tab: TabRef, options?: OpenTabOptions): void;
  closeTab(tab: Pick<TabRef, 'kind' | 'id' | 'scope'>): void;
  showActivity(activity: ActivityId): void;
  /** Dock the plan panel, or open it as a drawer where the window is too narrow to dock it. */
  showPlan(): void;
  /** Open the terminal panel where it is hidden, so a terminal opened there (a login, one of its own) is seen. */
  showTerminal(): void;
  /** The session now open: its own task and diff tabs come back, and the last one's are put away until it is open again. */
  showSession(sessionId: string): void;
  runCommand(id: string): void;

  /** The one action the title bar offers, chosen by the session's state; undefined offers none. */
  setPrimaryAction(action: PrimaryAction | undefined): void;
  /** The title bar's Needs you chip and the Sessions badge; 0 hides both. */
  setNeedsYouCount(count: number): void;
  /** The plan panel's progress; undefined while there is no plan. */
  setPlanProgress(progress: PlanProgress | undefined): void;
  /** An activity bar item's badge; Sessions shows the Needs you count before its own. */
  setActivityBadge(activity: ActivityId, badge: ActivityBadge | undefined): void;
  /**
   * The plan and every control become read-only while the daemon is away. The
   * frame keeps the last known state drawn, dimmed, and stops the keyboard
   * reaching it.
   */
  setReadOnly(readOnly: boolean): void;
  /** Shows above the main area until the returned function, or another banner with its id, replaces it. */
  showBanner(banner: Banner): () => void;
  /** Said once by the window's one polite live region. */
  announce(message: string): void;
}
