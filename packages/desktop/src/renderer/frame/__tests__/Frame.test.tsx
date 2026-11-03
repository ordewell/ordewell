import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonStatus } from '../../../shared/bridge';
import type { TabRef } from '../api';
import { registerFrameCommands } from '../commands';
import { Frame } from '../Frame';
import { FrameProvider, FrameStore } from '../store';

const SIZES = { sidebar: 260, right: 360, bottom: 240 };
const CONNECTED: DaemonStatus = { state: 'connected', port: 3700, owned: true, daemon: { version: '0.12.3', contract: 1 } };

let offs: Array<() => void> = [];
afterEach(() => { for (const off of offs) off(); offs = []; });

function mount(platform = 'linux'): { store: FrameStore; persist: ReturnType<typeof vi.fn> } {
  const persist = vi.fn();
  const store = new FrameStore({ workspace: '/work/acme', platform, sizes: SIZES, persistSizes: persist });
  const { api } = store;
  offs.push(
    registerFrameCommands(store),
    api.registerTabKind({ kind: 'plan', render: () => <p>The plan</p> }),
    api.registerTabKind({ kind: 'file', render: (tab) => <p>Contents of {tab.id}</p> }),
    api.registerTabKind({ kind: 'settings', render: () => <p>Settings page</p> }),
    api.registerSidebar({ activity: 'plan', id: 'sessions', title: 'Sessions', render: () => <p>Session list</p> }),
    api.registerSidebar({ activity: 'explorer', id: 'files', title: 'Files', render: () => <p>File tree</p> }),
    api.registerPanel({ region: 'right', id: 'planner', title: 'Planner', render: () => <textarea aria-label="Message the planner" data-autofocus /> }),
  );
  render(<FrameProvider value={store}><Frame daemon={CONNECTED} /></FrameProvider>);
  return { store, persist };
}

const file = (id: string): TabRef => ({ kind: 'file', id, title: id });
const tabs = (): string[] => within(screen.getByRole('tablist', { name: 'Editor tabs' })).getAllByRole('tab').map((tab) => tab.textContent ?? '');
const views = (): HTMLElement => screen.getByRole('navigation', { name: 'Views' });

describe('the frame', () => {
  it('draws its landmarks, with every icon button named', () => {
    mount();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main', { name: 'Editor' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Plan' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Planner' })).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Daemon v0.12.3');
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    for (const button of screen.getAllByRole('button')) expect(button).toHaveAccessibleName();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('acme');
  });
});

describe('activity switching', () => {
  it('switches the sidebar, marks the pressed view, and hides the sidebar on a second click', () => {
    mount();
    const plan = within(views()).getByRole('button', { name: 'Plan' });
    const explorer = within(views()).getByRole('button', { name: 'Explorer' });
    expect(plan).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Session list')).toBeInTheDocument();

    fireEvent.click(explorer);
    expect(explorer).toHaveAttribute('aria-pressed', 'true');
    expect(plan).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('complementary', { name: 'Explorer' })).toHaveTextContent('File tree');
    expect(screen.queryByText('Session list')).not.toBeInTheDocument();

    fireEvent.click(explorer);
    expect(screen.queryByRole('complementary', { name: 'Explorer' })).not.toBeInTheDocument();
    expect(explorer).toHaveAttribute('aria-pressed', 'false');
  });

  it('switches by shortcut, which shows the sidebar rather than hiding it', () => {
    mount();
    fireEvent.keyDown(window, { key: '3', code: 'Digit3', ctrlKey: true });
    expect(screen.getByRole('complementary', { name: 'Changes' })).toHaveTextContent('Nothing here yet.');
    fireEvent.keyDown(window, { key: '3', code: 'Digit3', ctrlKey: true });
    expect(screen.getByRole('complementary', { name: 'Changes' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'b', code: 'KeyB', ctrlKey: true });
    expect(screen.queryByRole('complementary', { name: 'Changes' })).not.toBeInTheDocument();
  });

  it('opens Settings as a tab from the gear', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('tab', { name: /Settings/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Settings page');
  });
});

describe('tabs', () => {
  it('pins Plan first: selected, and with no close button', () => {
    mount();
    expect(tabs()).toEqual(['Plan']);
    expect(screen.getByRole('tab', { name: /Plan/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: 'Close Plan' })).not.toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('The plan');
  });

  it('replaces a preview with the next one, and keeps a tab on a double click', () => {
    const { store } = mount();
    act(() => store.api.openTab(file('a.ts'), { preview: true }));
    act(() => store.api.openTab(file('b.ts'), { preview: true }));
    expect(tabs()).toEqual(['Plan', 'b.ts']);
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Contents of b.ts');

    fireEvent.doubleClick(screen.getByRole('tab', { name: /b\.ts/ }));
    act(() => store.api.openTab(file('c.ts'), { preview: true }));
    expect(tabs()).toEqual(['Plan', 'b.ts', 'c.ts']);
    expect(screen.getByRole('tab', { name: /c\.ts/ })).toHaveClass('frame-tab-preview');
    expect(screen.getByRole('tab', { name: /b\.ts/ })).not.toHaveClass('frame-tab-preview');
  });

  it('closes by its button and by Mod+W, never the Plan tab', () => {
    const { store } = mount();
    act(() => store.api.openTab(file('a.ts')));
    act(() => store.api.openTab(file('b.ts')));
    fireEvent.click(screen.getByRole('button', { name: 'Close a.ts' }));
    expect(tabs()).toEqual(['Plan', 'b.ts']);
    fireEvent.keyDown(window, { key: 'w', code: 'KeyW', ctrlKey: true });
    expect(tabs()).toEqual(['Plan']);
    fireEvent.keyDown(window, { key: 'w', code: 'KeyW', ctrlKey: true });
    expect(tabs()).toEqual(['Plan']);
  });

  it('splits right into a second group, opens beside into the other, and drops a group left empty', () => {
    const { store } = mount();
    act(() => store.api.openTab(file('a.ts')));
    fireEvent.click(screen.getByRole('button', { name: 'Split right' }));
    const right = screen.getByRole('tablist', { name: 'Editor tabs, right group' });
    expect(within(right).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['a.ts']);
    act(() => store.api.openTab(file('b.ts'), { beside: true }));
    expect(tabs()).toEqual(['Plan', 'a.ts', 'b.ts']);
    // Closed everywhere it is open: the right group, left empty, goes.
    act(() => store.api.closeTab(file('a.ts')));
    expect(tabs()).toEqual(['Plan', 'b.ts']);
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
    expect(tabs()).toEqual(['Plan', 'b.ts', 'a.ts']);

    fireEvent.keyDown(screen.getByRole('tab', { name: /a\.ts/ }), { key: 'Delete' });
    expect(tabs()).toEqual(['Plan', 'b.ts']);
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
    expect(tabs()).toEqual(['Plan', 'b.ts', 'a.ts']);
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
    const explorer = within(views()).getByRole('button', { name: 'Explorer' });
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
  it('toggles the terminal on Ctrl+` and the planner from its button', () => {
    mount('darwin');
    expect(screen.queryByRole('region', { name: 'Terminal' })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: '`', code: 'Backquote', ctrlKey: true });
    expect(screen.getByRole('region', { name: 'Terminal' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide terminal' }));
    expect(screen.queryByRole('region', { name: 'Terminal' })).not.toBeInTheDocument();

    const planner = screen.getByRole('button', { name: 'Planner' });
    expect(planner).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(planner);
    expect(screen.queryByRole('complementary', { name: 'Planner' })).not.toBeInTheDocument();
    expect(planner).toHaveAttribute('aria-pressed', 'false');
  });

  it('resizes a pane from the keyboard and keeps the size', () => {
    const { persist } = mount();
    const sash = screen.getByRole('separator', { name: 'Resize sidebar' });
    fireEvent.keyDown(sash, { key: 'ArrowRight' });
    expect(sash).toHaveAttribute('aria-valuenow', '276');
    expect(persist).toHaveBeenLastCalledWith({ sidebar: 276, right: 360, bottom: 240 });
    fireEvent.keyDown(sash, { key: 'Home' });
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ sidebar: 180 }));
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
    expect(screen.getByRole('button', { name: 'Needs you: 3' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run plan' }));
    expect(go).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Needs you: 3' }));
    expect(screen.getByRole('dialog', { name: 'Needs you' })).toHaveTextContent('Nothing needs you.');
  });
});
