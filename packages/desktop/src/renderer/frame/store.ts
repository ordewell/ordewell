import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ActionResult, RecentWorkspace, SavedLayout } from '../../shared/bridge';
import type {
  ActivityBadge, ActivityId, Banner, Command, FrameApi, OpenTabOptions, PanelView, PlanProgress, PrimaryAction, SidebarSection,
  SlotId, SlotView, TabKind, TabRef, Unregister,
} from './api';
import {
  besideGroup, initialLayout, reduceLayout, savedLayout, tabKey, type Layout, type LayoutAction, type Viewport,
} from './layout';

/** The frame's own overlays: one at a time, so opening one closes another. */
export type Overlay = 'palette' | 'needsYou' | 'more' | 'project' | undefined;

/**
 * The app's folders, as the title bar's project switcher reaches them. Main
 * decides what opening one does: focus the window that has it, switch this
 * one, or ask first when this one has work in progress (ADR-0063 H6).
 */
export interface ProjectsPort {
  /** Newest first, this window's own folder among them. */
  recents(): Promise<readonly RecentWorkspace[]>;
  onRecentsChange(cb: () => void): () => void;
  /** No path shows the folder picker. */
  open(path: string | undefined, options: { newWindow: boolean }): void;
  /** The welcome window, beside this one. */
  newWindow(): void;
  openDropped(file: File): Promise<ActionResult>;
}

/** A frame with no app behind it, as in a test that is not about folders. */
const NO_PROJECTS: ProjectsPort = {
  recents: async () => [],
  onRecentsChange: () => () => {},
  open: () => {},
  newWindow: () => {},
  openDropped: async () => ({ ok: false }),
};

export interface FrameState {
  layout: Layout;
  sidebars: readonly SidebarSection[];
  tabKinds: Readonly<Record<string, TabKind>>;
  panels: readonly PanelView[];
  slots: readonly SlotView[];
  commands: readonly Command[];
  primary: PrimaryAction | undefined;
  needsYou: number;
  /** What the plan panel's header and rail count; undefined while there is no plan. */
  planProgress: PlanProgress | undefined;
  badges: Readonly<Partial<Record<ActivityId, ActivityBadge>>>;
  readOnly: boolean;
  banners: readonly Banner[];
  /** `serial` changes with each message, so the same words said twice are said twice. */
  announcement: { text: string; serial: number };
  overlay: Overlay;
  /**
   * The open or closed choices the user made on the sidebars' disclosures, by
   * key, for as long as the window lives: a sidebar is drawn again after an
   * activity switch, and its folds stand. A disclosure with no entry keeps its
   * own default.
   */
  disclosures: Readonly<Record<string, boolean>>;
}

export interface FrameOptions {
  workspace: string;
  platform: string;
  /** The window's size when the frame opens; a test's default is the 1280 band's window. */
  viewport?: Viewport;
  /** How the user left this workspace's window last time. */
  layout?: SavedLayout;
  /** Where the user's layout goes when it changes, once a drag settles; the prefs store in the app. */
  persistLayout?(layout: SavedLayout): void;
  projects?: ProjectsPort;
}

const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 820 };

function byOrder<T extends { order?: number }>(items: readonly T[]): T[] {
  // Array.prototype.sort is stable, so equal orders keep registration order.
  return items.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * Everything the frame draws, and the one place that changes it: the layout
 * through reduceLayout, the registrations through the FrameApi it hands view
 * modules. React reads it through useSyncExternalStore.
 */
export class FrameStore {
  readonly api: FrameApi;
  private state: FrameState;
  private readonly listeners = new Set<() => void>();
  private persisted: string;

  constructor(private readonly options: FrameOptions) {
    this.state = {
      layout: initialLayout(options.viewport ?? DEFAULT_VIEWPORT, options.layout),
      sidebars: [],
      tabKinds: {},
      panels: [],
      slots: [],
      commands: [],
      primary: undefined,
      needsYou: 0,
      planProgress: undefined,
      badges: {},
      readOnly: false,
      banners: [],
      announcement: { text: '', serial: 0 },
      overlay: undefined,
      disclosures: {},
    };
    this.persisted = JSON.stringify(savedLayout(this.state.layout));
    this.api = this.makeApi();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getSnapshot = (): FrameState => this.state;

  get platform(): string { return this.options.platform; }

  get projects(): ProjectsPort { return this.options.projects ?? NO_PROJECTS; }

  dispatch(action: LayoutAction): void {
    const layout = reduceLayout(this.state.layout, action);
    if (layout === this.state.layout) return;
    this.set({ layout });
    // A drag resizes many times a second: it is kept once, when it lets go (commitLayout).
    if (action.type !== 'resize') this.commitLayout();
  }

  setOverlay(overlay: Overlay): void {
    if (overlay !== this.state.overlay) this.set({ overlay });
  }

  /** Keeps a disclosure's open or closed choice; see FrameState.disclosures. */
  setDisclosure(key: string, open: boolean): void {
    if (this.state.disclosures[key] !== open) this.set({ disclosures: { ...this.state.disclosures, [key]: open } });
  }

  /** Keeps the user's layout for this workspace's next window, if it changed since it was last kept. */
  commitLayout(): void {
    const saved = savedLayout(this.state.layout);
    const json = JSON.stringify(saved);
    if (json === this.persisted) return;
    this.persisted = json;
    this.options.persistLayout?.(saved);
  }

  /** The commands the palette lists and the keyboard reaches now. */
  enabledCommands(): Command[] {
    return this.state.commands.filter((command) => command.enabled?.() ?? true);
  }

  private set(patch: Partial<FrameState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /**
   * Adds to a list, replacing an entry with the same identity: a module that
   * registers twice (React's strict effects do) leaves one. The returned undo
   * removes only that entry, so it cannot take out a later replacement.
   */
  private register<K extends 'sidebars' | 'panels' | 'slots' | 'commands', T extends FrameState[K][number]>(
    key: K, item: T, same: (other: T) => boolean, sort: (items: T[]) => T[] = (items) => items,
  ): Unregister {
    const current = this.state[key] as readonly T[];
    this.set({ [key]: sort([...current.filter((other) => !same(other)), item]) });
    return () => {
      const now = this.state[key] as readonly T[];
      if (now.includes(item)) this.set({ [key]: now.filter((other) => other !== item) });
    };
  }

  private makeApi(): FrameApi {
    const readOnly = (): boolean => this.state.readOnly;
    return {
      workspace: this.options.workspace,
      platform: this.options.platform,
      get readOnly() { return readOnly(); },

      registerSidebar: (section: SidebarSection) => {
        return this.register('sidebars', section, (o) => o.activity === section.activity && o.id === section.id, byOrder);
      },
      registerTabKind: (kind: TabKind) => {
        this.set({ tabKinds: { ...this.state.tabKinds, [kind.kind]: kind } });
        return () => {
          if (this.state.tabKinds[kind.kind] !== kind) return;
          const rest = { ...this.state.tabKinds };
          delete rest[kind.kind];
          this.set({ tabKinds: rest });
        };
      },
      registerPanel: (panel: PanelView) => {
        // One view fills a region, so a second registration replaces the first.
        return this.register('panels', panel, (o) => o.region === panel.region);
      },
      registerSlot: (slot: SlotView) => {
        return this.register('slots', slot, (o) => o.slot === slot.slot && o.id === slot.id, byOrder);
      },
      registerCommand: (command: Command) => {
        return this.register('commands', command, (o) => o.id === command.id);
      },

      openTab: (tab: TabRef, options: OpenTabOptions = {}) => {
        const { layout } = this.state;
        // A tab already open is focused where it is, so a task opened from anywhere lands on its one tab.
        const key = tabKey(tab);
        const where = layout.groups.findIndex((candidate) => candidate.tabs.some((open) => open.key === key));
        const group = options.beside ? besideGroup(layout) : where >= 0 ? where : layout.focusedGroup;
        this.dispatch({ type: 'open', tab, preview: options.preview ?? false, group });
      },
      closeTab: (tab) => {
        const key = tabKey(tab);
        this.state.layout.groups.forEach((group, index) => {
          if (group.tabs.some((candidate) => candidate.key === key)) this.dispatch({ type: 'close', group: index, key });
        });
      },
      showActivity: (activity: ActivityId) => {
        this.dispatch({ type: 'activity', activity });
      },
      showPlan: () => {
        this.dispatch({ type: 'togglePlan', open: true });
      },
      showTerminal: () => {
        this.dispatch({ type: 'toggleTerminal', open: true });
      },
      showSession: (sessionId: string) => {
        this.dispatch({ type: 'session', sessionId });
      },
      runCommand: (id: string) => {
        const command = this.enabledCommands().find((candidate) => candidate.id === id);
        command?.run();
      },

      setPrimaryAction: (action: PrimaryAction | undefined) => {
        this.set({ primary: action });
      },
      setNeedsYouCount: (count: number) => {
        const needsYou = Math.max(0, Math.floor(count));
        if (needsYou !== this.state.needsYou) this.set({ needsYou });
      },
      setPlanProgress: (progress: PlanProgress | undefined) => {
        const now = this.state.planProgress;
        if (JSON.stringify(now) !== JSON.stringify(progress)) this.set({ planProgress: progress });
      },
      setActivityBadge: (activity: ActivityId, badge: ActivityBadge | undefined) => {
        const now = this.state.badges[activity];
        if (JSON.stringify(now) === JSON.stringify(badge)) return;
        const badges = { ...this.state.badges };
        if (badge) badges[activity] = badge;
        else delete badges[activity];
        this.set({ badges });
      },
      setReadOnly: (readOnly: boolean) => {
        if (readOnly !== this.state.readOnly) this.set({ readOnly });
      },
      showBanner: (banner: Banner) => {
        const existing = this.state.banners.find((other) => other.id === banner.id);
        const banners = [...this.state.banners.filter((other) => other.id !== banner.id), banner];
        this.set({ banners });
        // A body that changes as time passes is the same banner: only a new title is said again.
        if (existing?.title !== banner.title) this.api.announce(banner.title);
        return () => {
          if (this.state.banners.includes(banner)) this.set({ banners: this.state.banners.filter((other) => other !== banner) });
        };
      },
      announce: (message: string) => {
        this.set({ announcement: { text: message, serial: this.state.announcement.serial + 1 } });
      },
    };
  }
}

/** The slot views a place in the chrome draws, in order. */
export function slotsFor(state: FrameState, slot: SlotId): SlotView[] {
  return state.slots.filter((view) => view.slot === slot);
}

const FrameContext = createContext<FrameStore | undefined>(undefined);

export const FrameProvider = FrameContext.Provider;

export function useFrameStore(): FrameStore {
  const store = useContext(FrameContext);
  if (!store) throw new Error('useFrameStore needs a FrameProvider above it.');
  return store;
}

export function useFrameState(): FrameState {
  const store = useFrameStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/**
 * A sidebar disclosure's choice, kept by the frame under `key` so it outlives
 * the component drawing it: undefined until the user opens or closes it. A key
 * names everything the choice belongs to, a session's task among them, so one
 * session's folds never land on another's.
 */
export function useDisclosure(key: string): [boolean | undefined, (open: boolean) => void] {
  const store = useFrameStore();
  const chosen = useSyncExternalStore(store.subscribe, () => store.getSnapshot().disclosures[key]);
  return [chosen, (open) => store.setDisclosure(key, open)];
}
