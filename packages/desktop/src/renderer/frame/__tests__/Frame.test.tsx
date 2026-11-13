import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonStatus } from '../../../shared/bridge';
import type { TabRef } from '../api';
import { registerFrameCommands } from '../commands';
import { Frame } from '../Frame';
import { FrameProvider, FrameStore } from '../store';

const CONNECTED: DaemonStatus = { state: 'connected', port: 3700, owned: true, daemon: { version: '0.12.3', contract: 1 } };

let offs: Array<() => void> = [];
afterEach(() => { for (const off of offs) off(); offs = []; });

/** The frame reads the window's size on mount (useViewport), so a test sets it the way a window would. */
function sizeWindow(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}
beforeEach(() => sizeWindow(1512, 982));

function mount(platform = 'linux'): { store: FrameStore; persist: ReturnType<typeof vi.fn> } {
  const persist = vi.fn();
  const store = new FrameStore({ workspace: '/work/acme', platform, viewport: { width: window.innerWidth, height: window.innerHeight }, persistLayout: persist });
  const { api } = store;
  offs.push(
    registerFrameCommands(store),
    api.registerTabKind({ kind: 'planner', render: () => <textarea aria-label="Message the planner" /> }),
    api.registerTabKind({ kind: 'plan-graph', render: () => <p>The graph</p> }),
    api.registerTabKind({ kind: 'file', render: (tab) => <p>Contents of {tab.id}</p> }),
    api.registerTabKind({ kind: 'settings', render: () => <p>Settings page</p> }),
    api.registerSidebar({ activity: 'sessions', id: 'sessions', title: 'Sessions', render: () => <p>Session list</p> }),
    api.registerSidebar({ activity: 'explorer', id: 'files', title: 'Files', render: () => <p>File tree</p> }),
    api.registerPanel({ region: 'plan', id: 'plan', title: 'Plan', render: () => <p>The task list</p> }),
  );
  render(<FrameProvider value={store}><Frame daemon={CONNECTED} /></FrameProvider>);
  return { store, persist };
}

const file = (id: string): TabRef => ({ kind: 'file', id, title: id });
const tabs = (): string[] => within(screen.getByRole('tablist', { name: 'Editor tabs' })).getAllByRole('tab').map((tab) => tab.textContent ?? '');
const views = (): HTMLElement => screen.getByRole('tablist', { name: 'Views' });

describe('the frame', () => {
  it('draws its landmarks, with every icon button named', () => {
    mount();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main', { name: 'Centre' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Plan' })).toHaveTextContent('The task list');
    expect(screen.getByRole('navigation', { name: 'Sessions' })).toHaveTextContent('Session list');
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Daemon v0.12.3');
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    for (const button of screen.getAllByRole('button')) expect(button).toHaveAccessibleName();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('acme');
  });

  it('keeps Needs you, the primary action and More actions in the title bar', () => {
    const { store } = mount();
    act(() => store.api.setPrimaryAction({ label: 'Run plan', run: () => {} }));
    const title = screen.getByRole('banner');
    expect(within(title).getByRole('button', { name: 'Needs you' })).toBeInTheDocument();
    expect(within(title).getByRole('button', { name: 'Run plan' })).toBeInTheDocument();
    fireEvent.click(within(title).getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: 'Reset layout' })).toBeInTheDocument();
  });

  it('puts focus on the ⋯ menu\'s first drawn item, past a scope chip the bar has room for, and closes on Escape', () => {
    const { store } = mount();
    offs.push(store.api.registerSlot({ slot: 'title.scope', id: 'scope', render: () => <button type="button">This session</button> }));
    // What the stylesheet does above its breakpoint: the menu's copy of the chip is not drawn.
    const drawn = vi.fn(function (this: HTMLElement) { return !this.closest('.frame-more-scope'); });
    HTMLElement.prototype.checkVisibility = drawn;
    try {
      const more = within(screen.getByRole('banner')).getByRole('button', { name: 'More actions' });
      fireEvent.click(more);
      expect(screen.getByRole('menuitem', { name: /in Explorer/ })).toHaveFocus();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      expect(screen.queryByRole('menu', { name: 'More actions' })).not.toBeInTheDocument();
      expect(more).toHaveFocus();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'checkVisibility');
    }
  });
});

describe('activity switching', () => {
  it('switches the sidebar, marks the selected view, and hides the sidebar on a second click', () => {
    mount();
    const sessions = within(views()).getByRole('tab', { name: 'Sessions' });
    const explorer = within(views()).getByRole('tab', { name: 'Explorer' });
    expect(sessions).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(explorer);
    expect(explorer).toHaveAttribute('aria-selected', 'true');
    expect(sessions).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('navigation', { name: 'Explorer' })).toHaveTextContent('File tree');
    expect(screen.queryByText('Session list')).not.toBeInTheDocument();

    fireEvent.click(explorer);
    expect(screen.queryByRole('navigation', { name: 'Explorer' })).not.toBeInTheDocument();
    expect(explorer).toHaveAttribute('aria-selected', 'false');
  });

  it('switches by shortcut, and hides the sidebar on the same shortcut again', () => {
    mount();
    fireEvent.keyDown(window, { key: '3', code: 'Digit3', ctrlKey: true });
    expect(screen.getByRole('navigation', { name: 'Changes' })).toHaveTextContent('Nothing here yet.');
    fireEvent.keyDown(window, { key: '3', code: 'Digit3', ctrlKey: true });
    expect(screen.queryByRole('navigation', { name: 'Changes' })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'b', code: 'KeyB', ctrlKey: true });
    expect(screen.getByRole('navigation', { name: 'Changes' })).toBeInTheDocument();
  });

  it('opens the sidebar as a drawer over the centre in a narrow window, and Escape closes it', () => {
    sizeWindow(1100, 800);
    mount();
    expect(screen.queryByRole('navigation', { name: 'Sessions' })).not.toBeInTheDocument();
    fireEvent.click(within(views()).getByRole('tab', { name: 'Sessions' }));
    expect(screen.getByRole('navigation', { name: 'Sessions' })).toHaveClass('frame-drawer');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('navigation', { name: 'Sessions' })).not.toBeInTheDocument();
  });

  it('leaves a drawer open when a control inside already used the Escape (a task chat taking back a queued message)', () => {
    sizeWindow(900, 800);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Show the plan' }));
    const used = (event: KeyboardEvent): void => event.preventDefault();
    document.body.addEventListener('keydown', used);
    try {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
      expect(screen.getByRole('complementary', { name: 'Plan' })).toBeInTheDocument();
    } finally {
      document.body.removeEventListener('keydown', used);
    }
  });

  it('moves focus into a drawer as it opens and back to its opener as Escape closes it', () => {
    sizeWindow(900, 800);
    mount();
    const opener = screen.getByRole('button', { name: 'Show the plan' });
    opener.focus();
    fireEvent.click(opener);
    const drawer = screen.getByRole('complementary', { name: 'Plan' });
    expect(drawer).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: 'Plan' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });

  it('opens Settings as a tab from the gear', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('tab', { name: /Settings/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Settings page');
  });
});

describe('the plan panel', () => {
  it('opens the plan graph as a tab beside the planner', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Open the plan graph' }));
    expect(tabs()).toEqual(['Planner', 'Plan graph']);
    expect(screen.getByRole('tabpanel')).toHaveTextContent('The graph');
  });

  it('collapses to the rail and expands again, and keeps the choice', () => {
    const { persist } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse the plan panel' }));
    expect(screen.queryByRole('complementary', { name: 'Plan' })).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Plan, collapsed' })).toBeInTheDocument();
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ planOpen: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand the plan panel' }));
    expect(screen.getByRole('complementary', { name: 'Plan' })).toHaveTextContent('The task list');
  });

  it('is a rail with counts in a narrow window, whose count opens the plan over the centre', () => {
    sizeWindow(900, 800);
    const { store } = mount();
    act(() => store.api.setPlanProgress({ done: 1, total: 4, counts: { passed: 1, running: 1, 'not-started': 2 } }));
    expect(screen.queryByRole('complementary', { name: 'Plan' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '1 running' }));
    const drawer = screen.getByRole('complementary', { name: 'Plan' });
    expect(drawer).toHaveAttribute('data-filter', 'running');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close the plan' }));
    expect(screen.queryByRole('complementary', { name: 'Plan' })).not.toBeInTheDocument();
  });
});

describe('tabs', () => {
  it('pins the Planner first: selected, and with no close button', () => {
    mount();
    expect(tabs()).toEqual(['Planner']);
    expect(screen.getByRole('tab', { name: /Planner/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: 'Close Planner' })).not.toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toContainElement(screen.getByRole('textbox', { name: 'Message the planner' }));
  });

  it('goes back to the planner on Mod+L, from any tab', () => {
    const { store } = mount();
    act(() => store.api.openTab(file('a.ts')));
    fireEvent.keyDown(window, { key: 'l', code: 'KeyL', ctrlKey: true });
    expect(screen.getByRole('tab', { name: /Planner/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps the Planner drawn, its draft and all, across a look at another tab', () => {
    const { store } = mount();
    const box = screen.getByRole('textbox', { name: 'Message the planner' });
    fireEvent.change(box, { target: { value: 'half-typed draft' } });
    act(() => store.api.openTab(file('a.ts')));
    fireEvent.click(screen.getByRole('tab', { name: /Planner/ }));
    expect(screen.getByRole('textbox', { name: 'Message the planner' })).toBe(box);
    expect(box).toHaveValue('half-typed draft');
  });

  it('scrolls a tab opened past the strip\'s edge into view', () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const { store } = mount();
    act(() => store.api.openTab(file('a.ts')));
    expect(scrolled.mock.contexts.at(-1)).toBe(screen.getByRole('tab', { name: /a\.ts/ }));
  });

  it('brings the active tab back into view when the strip narrows', () => {
    const resized: (() => void)[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized.push(callback); }
      observe(): void {}
      disconnect(): void {}
    });
    try {
      const scrolled = vi.fn();
      Element.prototype.scrollIntoView = scrolled;
      const { store } = mount();
      act(() => store.api.openTab(file('a.ts')));
      scrolled.mockClear();
      act(() => { for (const callback of resized) callback(); });
      expect(scrolled.mock.contexts).toContain(screen.getByRole('tab', { name: /a\.ts/ }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('scrolls the strip sideways on a wheel, and fades each edge with tabs past it', () => {
    mount();
    const strip = screen.getByRole('tablist', { name: 'Editor tabs' });
    Object.defineProperties(strip, { clientWidth: { configurable: true, value: 300 }, scrollWidth: { configurable: true, value: 900 } });
    fireEvent.scroll(strip);
    expect(strip).toHaveClass('frame-tabs-past-end');
    expect(strip).not.toHaveClass('frame-tabs-past-start');

    fireEvent.wheel(strip, { deltaY: 120 });
    expect(strip.scrollLeft).toBe(120);
    fireEvent.scroll(strip);
    expect(strip).toHaveClass('frame-tabs-past-start');
    expect(strip).toHaveClass('frame-tabs-past-end');
  });

  it('replaces a preview with the next one, and keeps a tab on a double click', () => {
    const { store } = mount();
    act(() => store.api.openTab(file('a.ts'), { preview: true }));
    act(() => store.api.openTab(file('b.ts'), { preview: true }));
    expect(tabs()).toEqual(['Planner', 'b.ts']);
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Contents of b.ts');

    fireEvent.doubleClick(screen.getByRole('tab', { name: /b\.ts/ }));
    act(() => store.api.openTab(file('c.ts'), { preview: true }));
    expect(tabs()).toEqual(['Planner', 'b.ts', 'c.ts']);
    expect(screen.getByRole('tab', { name: /c\.ts/ })).toHaveClass('frame-tab-preview');
    expect(screen.getByRole('tab', { name: /b\.ts/ })).not.toHaveClass('frame-tab-preview');
  });

  it('closes by its button and by Mod+W, never the Planner tab', () => {
    const { store } = mount();
    act(() => store.api.openTab(file('a.ts')));
    act(() => store.api.openTab(file('b.ts')));
    fireEvent.click(screen.getByRole('button', { name: 'Close a.ts' }));
    expect(tabs()).toEqual(['Planner', 'b.ts']);
    fireEvent.keyDown(window, { key: 'w', code: 'KeyW', ctrlKey: true });
    expect(tabs()).toEqual(['Planner']);
    fireEvent.keyDown(window, { key: 'w', code: 'KeyW', ctrlKey: true });
    expect(tabs()).toEqual(['Planner']);
  });

  it('splits right into a second group, opens beside into the other, and drops a group left empty', () => {
    const { store } = mount();
    act(() => store.api.openTab(file('a.ts')));
    fireEvent.click(screen.getByRole('button', { name: 'Split right' }));
    const right = screen.getByRole('tablist', { name: 'Editor tabs, right group' });
    expect(within(right).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['a.ts']);
    act(() => store.api.openTab(file('b.ts'), { beside: true }));
    expect(tabs()).toEqual(['Planner', 'a.ts', 'b.ts']);
    // Closed everywhere it is open: the right group, left empty, goes.
    act(() => store.api.closeTab(file('a.ts')));
    expect(tabs()).toEqual(['Planner', 'b.ts']);
    expect(screen.queryByRole('tablist', { name: 'Editor tabs, right group' })).not.toBeInTheDocument();
  });

  it('moves between tabs with the arrows, reorders with Mod+Shift+arrow, and closes with Delete', async () => {
    const { store } = mount();
    act(() => store.api.openTab(file('a.ts')));
    act(() => store.api.openTab(file('b.ts')));
    const b = screen.getByRole('tab', { name: /b\.ts/ });
    b.focus();
    fireEvent.keyDown(b, { key: 'ArrowLeft' });
    const a = screen.getByRole('tab', { name: /a\.ts/ });
    expect(a).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(a).toHaveFocus());
    expect(a).toHaveAttribute('tabindex', '0');
    expect(b).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(a, { key: 'ArrowRight', ctrlKey: true, shiftKey: true });
    expect(tabs()).toEqual(['Planner', 'b.ts', 'a.ts']);

    fireEvent.keyDown(screen.getByRole('tab', { name: /a\.ts/ }), { key: 'Delete' });
    expect(tabs()).toEqual(['Planner', 'b.ts']);
    await waitFor(() => expect(screen.getByRole('tab', { name: /b\.ts/ })).toHaveFocus());
  });

  it('reorders by drag and drop', () => {
    const { store } = mount();
    act(() => store.api.openTab(file('a.ts')));
    act(() => store.api.openTab(file('b.ts')));
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
      get types() { return [...data.keys()]; },
      effectAllowed: 'move',
      dropEffect: 'move',
    };
    fireEvent.dragStart(screen.getByRole('tab', { name: /b\.ts/ }), { dataTransfer });
    fireEvent.dragOver(screen.getByRole('tab', { name: /a\.ts/ }), { dataTransfer });
    fireEvent.drop(screen.getByRole('tab', { name: /a\.ts/ }), { dataTransfer });
    expect(tabs()).toEqual(['Planner', 'b.ts', 'a.ts']);
  });
});

describe('the command palette', () => {
  it('opens on Mod+K, filters, runs the chosen command on Enter, and closes', () => {
    const { store } = mount('darwin');
    const ran = vi.fn();
    act(() => { offs.push(store.api.registerCommand({ id: 'git.fetch', title: 'Fetch from remote', run: ran })); });
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true });
    const input = screen.getByRole('combobox', { name: 'Search commands' });
    expect(input).toHaveFocus();
    expect(screen.getByRole('option', { name: /Toggle sidebar/ })).toHaveTextContent('⌘B');

    fireEvent.change(input, { target: { value: 'fetch rem' } });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Fetch from remote']);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(ran).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
  });

  it('lists a command for each theme and saves the one chosen', async () => {
    const set = vi.fn(async () => ({}));
    Object.defineProperty(window, 'ordewell', { configurable: true, value: { prefs: { get: vi.fn(), set } } });
    mount();
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true });
    const input = screen.getByRole('combobox', { name: 'Search commands' });
    fireEvent.change(input, { target: { value: 'theme' } });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Theme: Dark', 'Theme: Light', 'Theme: System']);

    fireEvent.change(input, { target: { value: 'theme: light' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(set).toHaveBeenCalledWith('theme', 'light'));
  });

  it('moves the choice with the arrows and says when nothing matches', () => {
    mount();
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true });
    const input = screen.getByRole('combobox');
    const [first, second] = screen.getAllByRole('option');
    expect(first).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(second).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', second.id);
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.getByText('No command matches.')).toBeInTheDocument();
  });

  it('gives focus back on Escape', () => {
    mount();
    const explorer = within(views()).getByRole('tab', { name: 'Explorer' });
    explorer.focus();
    fireEvent.keyDown(explorer, { key: 'k', code: 'KeyK', ctrlKey: true });
    expect(screen.getByRole('combobox')).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(explorer).toHaveFocus();
  });

  it('leaves out a command while it is disabled', () => {
    const { store } = mount();
    let ready = false;
    act(() => { offs.push(store.api.registerCommand({ id: 'session.merge', title: 'Merge all', enabled: () => ready, run: () => {} })); });
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'merge' } });
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    ready = true;
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'merge' } });
    expect(screen.getByRole('option', { name: 'Merge all' })).toBeInTheDocument();
  });
});

describe('panels, banners and the title bar', () => {
  it('toggles the terminal on Ctrl+` and hides it from its button', () => {
    mount('darwin');
    expect(screen.queryByRole('region', { name: 'Terminal' })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: '`', code: 'Backquote', ctrlKey: true });
    expect(screen.getByRole('region', { name: 'Terminal' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide terminal' }));
    expect(screen.queryByRole('region', { name: 'Terminal' })).not.toBeInTheDocument();
  });

  it('opens the terminal from the activity bar button, outside the Views tablist', () => {
    mount('darwin');
    const toggle = screen.getByRole('button', { name: 'Toggle terminal' });
    expect(toggle).toHaveAttribute('title', 'Toggle terminal (⌃`)');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(within(views()).queryByRole('button', { name: 'Toggle terminal' })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByRole('region', { name: 'Terminal' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toggle terminal' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Hide terminal' })).toHaveAttribute('title', 'Hide terminal (Ctrl+`)');
  });

  it('resizes a pane from the keyboard and keeps the size', () => {
    const { persist } = mount();
    const sash = screen.getByRole('separator', { name: 'Resize sidebar' });
    fireEvent.keyDown(sash, { key: 'ArrowRight' });
    expect(sash).toHaveAttribute('aria-valuenow', '276');
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ sidebar: 276, activity: 'sessions' }));
    fireEvent.keyDown(sash, { key: 'Home' });
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ sidebar: 200 }));
  });

  it('bounds the plan panel so the centre keeps its minimum', () => {
    mount();
    const sash = screen.getByRole('separator', { name: 'Resize plan panel' });
    expect(sash).toHaveAttribute('aria-valuenow', '360');
    fireEvent.keyDown(sash, { key: 'ArrowLeft' });
    expect(sash).toHaveAttribute('aria-valuenow', '376');
    fireEvent.keyDown(sash, { key: 'End' });
    // 1512 wide: 52 activity bar, 260 sidebar and a 560 centre leave the plan 640, past its own 560.
    expect(sash).toHaveAttribute('aria-valuenow', '560');
  });

  it('shows a banner, says its title once, and runs its action', async () => {
    const { store } = mount();
    const retry = vi.fn();
    let dismiss = (): void => {};
    act(() => { dismiss = store.api.showBanner({ id: 'daemon', tone: 'warning', title: 'Reconnecting', actions: [{ label: 'Retry now', run: retry }] }); });
    expect(screen.getByRole('heading', { name: 'Reconnecting' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting');
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(retry).toHaveBeenCalledOnce();
    await act(async () => { await Promise.resolve(); });
    act(() => dismiss());
    expect(screen.queryByRole('heading', { name: 'Reconnecting' })).not.toBeInTheDocument();
  });

  it('badges Needs you and runs the primary action', () => {
    const { store } = mount();
    const go = vi.fn();
    act(() => { store.api.setNeedsYouCount(3); store.api.setPrimaryAction({ label: 'Run plan', run: go }); });
    expect(screen.getByRole('button', { name: 'Needs you, 3' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run plan' }));
    expect(go).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Needs you, 3' }));
    expect(screen.getByRole('dialog', { name: 'Needs you' })).toHaveTextContent('Nothing needs you.');
    expect(within(views()).getByRole('tab', { name: 'Sessions, 3 need you' })).toBeInTheDocument();
  });

  it('folds an empty Needs you section to its header with a 0, and opens it when something waits (W7)', () => {
    let waiting = 0;
    const { store } = mount();
    act(() => { offs.push(store.api.registerSidebar({ activity: 'sessions', id: 'needs-you', title: 'Needs you', order: 0, collapsible: true, count: () => waiting, render: () => <p>The waits</p> })); });
    const toggle = (): HTMLElement => screen.getByRole('button', { name: /^Needs you\s*\(\d+\)$/ });
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(toggle()).toHaveTextContent('(0)');
    expect(screen.queryByText('The waits')).not.toBeInTheDocument();

    waiting = 2;
    act(() => store.api.setNeedsYouCount(2));
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('The waits')).toBeInTheDocument();
  });
});
