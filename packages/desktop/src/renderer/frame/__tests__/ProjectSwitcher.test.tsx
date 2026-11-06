import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionResult, DaemonStatus, RecentWorkspace } from '../../../shared/bridge';
import { registerFrameCommands } from '../commands';
import { Frame } from '../Frame';
import { FrameProvider, FrameStore, type ProjectsPort } from '../store';

const CONNECTED: DaemonStatus = { state: 'connected', port: 3700, owned: true, daemon: { version: '0.12.3', contract: 1 } };

function recent(path: string, extra: Partial<RecentWorkspace> = {}): RecentWorkspace {
  const name = path.split('/').pop() ?? path;
  return { path, name, displayPath: path.replace('/home/me', '~'), openedAt: '2026-11-03T00:00:00.000Z', missing: false, ...extra };
}

/** main's side of the switcher: its recents, newest first, and what it was asked to open. */
function fakeProjects(initial: RecentWorkspace[]) {
  let list = initial;
  const listeners = new Set<() => void>();
  const port = {
    recents: vi.fn(async () => list),
    onRecentsChange: vi.fn((cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; }),
    open: vi.fn((_path: string | undefined, _options: { newWindow: boolean }) => {}),
    openDropped: vi.fn(async (_file: File): Promise<ActionResult> => ({ ok: true })),
  } satisfies ProjectsPort;
  return {
    port,
    change(next: RecentWorkspace[]): void {
      list = next;
      for (const cb of [...listeners]) cb();
    },
  };
}

let offs: Array<() => void> = [];
afterEach(() => { for (const off of offs) off(); offs = []; });

const HERE = '/home/me/acme';

function mount(recents: RecentWorkspace[], platform = 'linux') {
  const projects = fakeProjects(recents);
  const store = new FrameStore({ workspace: HERE, platform, projects: projects.port });
  offs.push(registerFrameCommands(store));
  render(<FrameProvider value={store}><Frame daemon={CONNECTED} /></FrameProvider>);
  return { store, projects };
}

const RECENTS = [
  recent(HERE),
  recent('/home/me/billing'),
  recent('/home/me/gone', { missing: true }),
  recent('/srv/www/docs'),
];

const switcher = (): HTMLElement => within(screen.getByRole('banner')).getByRole('button', { name: /Switch project/ });
const items = (): string[] => [...screen.getByRole('menu', { name: 'Switch project' }).querySelectorAll('[role^="menuitem"]')]
  .map((item) => item.getAttribute('aria-label') ?? item.textContent ?? '');

describe('the project switcher', () => {
  it('names the project, shows its full path as its tooltip and says it opens a menu', () => {
    mount(RECENTS);
    const button = switcher();
    expect(button).toHaveTextContent('acme');
    expect(button).toHaveAccessibleName('acme, Switch project');
    expect(button).toHaveAttribute('title', HERE);
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('lists the other recent folders newest first, then Open Folder… and Open in new window', async () => {
    mount(RECENTS);
    fireEvent.click(switcher());
    expect(switcher()).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(items()).toEqual(['billing', 'docs', 'Open Folder…', 'Open in new window']));
    const menu = screen.getByRole('menu', { name: 'Switch project' });
    // This window's own folder is not a place to go, and a missing one cannot be opened.
    expect(within(menu).queryByText('acme')).not.toBeInTheDocument();
    expect(within(menu).queryByText('gone')).not.toBeInTheDocument();
    const docs = within(menu).getByRole('menuitem', { name: 'docs' });
    expect(docs).toHaveAttribute('title', '/srv/www/docs');
    expect(docs).toHaveTextContent('/srv/www/docs');
    expect(within(menu).getByRole('menuitem', { name: 'Open Folder…' })).toHaveTextContent('Ctrl+O');
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Open in new window' })).toHaveAttribute('aria-checked', 'false');
  });

  it('switches to a recent folder in this window, closes and gives focus back', async () => {
    const { projects } = mount(RECENTS);
    fireEvent.click(switcher());
    const billing = await screen.findByRole('menuitem', { name: 'billing' });
    expect(billing).toHaveFocus();
    fireEvent.click(billing);
    expect(projects.port.open).toHaveBeenCalledWith('/home/me/billing', { newWindow: false });
    expect(screen.queryByRole('menu', { name: 'Switch project' })).not.toBeInTheDocument();
    expect(switcher()).toHaveFocus();
  });

  it('works from the keyboard: arrows open and move, Home and End jump, the new-window option holds, Escape closes', async () => {
    const { projects } = mount(RECENTS, 'darwin');
    switcher().focus();
    fireEvent.keyDown(switcher(), { key: 'ArrowDown' });
    const billing = await screen.findByRole('menuitem', { name: 'billing' });
    expect(billing).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: 'Open Folder…' })).toHaveTextContent('⌘O');

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    const option = screen.getByRole('menuitemcheckbox', { name: 'Open in new window' });
    expect(option).toHaveFocus();
    fireEvent.click(option);
    expect(option).toHaveAttribute('aria-checked', 'true');
    // Ticking it is not a choice: the menu stays for the folder.
    expect(screen.getByRole('menu', { name: 'Switch project' })).toBeInTheDocument();

    fireEvent.keyDown(option, { key: 'Home' });
    expect(billing).toHaveFocus();
    fireEvent.keyDown(billing, { key: 'End' });
    expect(option).toHaveFocus();
    fireEvent.keyDown(option, { key: 'ArrowDown' });
    expect(billing).toHaveFocus();
    fireEvent.keyDown(billing, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    const pick = screen.getByRole('menuitem', { name: 'Open Folder…' });
    expect(pick).toHaveFocus();
    fireEvent.click(pick);
    expect(projects.port.open).toHaveBeenCalledWith(undefined, { newWindow: true });

    fireEvent.keyDown(switcher(), { key: 'ArrowDown' });
    await screen.findByRole('menu', { name: 'Switch project' });
    // The option holds for the window until it is unticked.
    expect(screen.getByRole('menuitemcheckbox', { name: 'Open in new window' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Switch project' })).not.toBeInTheDocument();
    expect(switcher()).toHaveFocus();
  });

  it('redraws when the recents change elsewhere, and says when there is nowhere else to go', async () => {
    const { projects } = mount([recent(HERE)]);
    fireEvent.click(switcher());
    await waitFor(() => expect(screen.getByRole('menu', { name: 'Switch project' })).toHaveTextContent('No other recent folders'));
    act(() => projects.change([recent('/home/me/billing'), recent(HERE)]));
    await waitFor(() => expect(items()).toEqual(['billing', 'Open Folder…', 'Open in new window']));
  });

  it('opens a folder from the palette', async () => {
    const { store, projects } = mount(RECENTS);
    act(() => store.api.runCommand('project.openFolder'));
    expect(projects.port.open).toHaveBeenCalledWith(undefined, { newWindow: false });
    act(() => store.api.runCommand('project.switch'));
    expect(await screen.findByRole('menu', { name: 'Switch project' })).toBeInTheDocument();
  });
});

describe('a folder dropped on a project window', () => {
  function drop(target: Element, files: File[]): void {
    const event = createEvent.drop(target);
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['Files'], files: { length: files.length, item: (i: number) => files[i] ?? null } },
    });
    fireEvent(target, event);
  }

  it('goes to main, which decides what opening it does', async () => {
    const { projects } = mount(RECENTS);
    const folder = new File([], 'billing');
    drop(screen.getByRole('main', { name: 'Centre' }), [folder]);
    await waitFor(() => expect(projects.port.openDropped).toHaveBeenCalledWith(folder));
  });

  it('shows main\'s refusal, and asks for one folder when several are dropped', async () => {
    const { projects } = mount(RECENTS);
    projects.port.openDropped.mockResolvedValueOnce({ ok: false, message: 'Only a folder can be opened.' });
    drop(screen.getByRole('main', { name: 'Centre' }), [new File(['x'], 'notes.txt')]);
    const banner = await screen.findByRole('region', { name: 'Could not open the folder' });
    expect(banner).toHaveTextContent('Only a folder can be opened.');
    drop(screen.getByRole('main', { name: 'Centre' }), [new File([], 'a'), new File([], 'b')]);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Could not open the folder' })).toHaveTextContent('Drop one folder.'));
    expect(projects.port.openDropped).toHaveBeenCalledTimes(1);
    fireEvent.click(within(screen.getByRole('region', { name: 'Could not open the folder' })).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('region', { name: 'Could not open the folder' })).not.toBeInTheDocument();
  });
});
