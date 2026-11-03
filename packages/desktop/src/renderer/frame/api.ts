import type { ReactNode } from 'react';
import type { IconComponent } from '@ordewell/ui/design';
import type { ActivityId, Tab, TabRef } from './layout';

export type { ActivityId, Tab, TabRef, ViewScope } from './layout';

/** Undo a registration: a view that unmounts or a test that cleans up. */
export type Unregister = () => void;

/**
 * One section of an activity's sidebar. Several modules may add to one
 * activity, such as Needs you at the head of the Plan sidebar, and they stack
 * by `order`.
 */
export interface SidebarSection {
  activity: ActivityId;
  id: string;
  title: string;
  /** Lower first; sections with the same order keep registration order. */
  order?: number;
  render(): ReactNode;
}

/** How a kind of tab is drawn: every tab of that kind, whatever its id. */
export interface TabKind {
  kind: string;
  icon?: IconComponent;
  render(tab: Tab): ReactNode;
}

/** The planner on the right, the terminal at the bottom. */
export interface PanelView {
  region: 'right' | 'bottom';
  id: string;
  title: string;
  render(): ReactNode;
}

/** Places in the title and status bars, and the Needs you popover, that a later slice fills. */
export type SlotId =
  | 'title.breadcrumb'
  | 'title.scope'
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
  /** The workspace this window shows (ADR-0060 H6). */
  readonly workspace: string;
  readonly platform: string;

  registerSidebar(section: SidebarSection): Unregister;
  registerTabKind(kind: TabKind): Unregister;
  registerPanel(panel: PanelView): Unregister;
  registerSlot(slot: SlotView): Unregister;
  registerCommand(command: Command): Unregister;

  openTab(tab: TabRef, options?: OpenTabOptions): void;
  closeTab(tab: Pick<TabRef, 'kind' | 'id' | 'scope'>): void;
  showActivity(activity: ActivityId): void;
  runCommand(id: string): void;

  /** The one action the title bar offers, chosen by the session's state; undefined offers none. */
  setPrimaryAction(action: PrimaryAction | undefined): void;
  /** The title bar's Needs you badge; 0 hides it. */
  setNeedsYouCount(count: number): void;
  /** Shows above the main area until the returned function, or another banner with its id, replaces it. */
  showBanner(banner: Banner): () => void;
  /** Said once by the window's one polite live region. */
  announce(message: string): void;
}
