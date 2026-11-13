import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerFrameCommands } from '../../../frame/commands';
import { Frame } from '../../../frame/Frame';
import { FrameProvider, FrameStore } from '../../../frame/store';
import { CONNECTED, installBridge, refusal, type Call, type Harness } from '../../../test/explorerHarness';
import { editors, type FakeEditor } from '../../../test/monacoMock';
import { daemonHost } from '../../../session/DaemonHost';
import { selectedTask } from '../../../session/selection';
import { scopeStoreFor } from '../../scope/scopeStore';
import { registerViews } from '../../index';
import { clearDraft } from '../drafts';

// Monaco needs a browser's layout and Vite's workers; a test gives it a string and two callbacks.
vi.mock('../../../monaco', async () => (await import('../../../test/monacoMock')).fakeMonacoModule());


const ROOT = [
  { name: 'src', path: 'src', kind: 'directory', ignored: false },
  { name: 'dist', path: 'dist', kind: 'directory', ignored: true },
  { name: 'README.md', path: 'README.md', kind: 'file', ignored: false, status: 'M' },
  { name: 'new.ts', path: 'new.ts', kind: 'file', ignored: false, status: '?' },
];
const SRC = [{ name: 'a.ts', path: 'src/a.ts', kind: 'file', ignored: false, taskId: 't3' }];
const RUN = {
  meta: { id: 's1' },
  run: {
    tasks: [{ id: 't3', order: 3, title: 'Add the parser', status: 'done', isolation: { state: 'integrated', branch: 'b', worktree: 'w', repos: ['.'] } }],
    handoff: { repos: [{ path: '.', integrationBranch: 'ordewell/s1', landed: [] }], landed: [] },
  },
};

interface Disk { text: string; hash: string }

/** A workspace with one repo, a finished run, and a file on disk that a test can change under the editor. */
function workspace(disk: Disk = { text: 'const a = 1;\n', hash: 'h1' }, extra: Partial<Record<string, (call: Call) => unknown>> = {}): { harness: Harness; disk: Disk } {
  const harness = installBridge({
    'git.repos': () => ({ repos: [{ repo: '.', branch: 'main', detached: false }] }),
    'sessions.list': () => [{ id: 's1', goal: 'Ship the parser', status: 'done', taskCount: 1, updatedAt: '2026-11-03T09:00:00.000Z' }],
    'sessions.get': () => RUN,
    'files.tree': ({ params }) => ({ at: {}, dir: params.dir, entries: params.dir === 'src' ? SRC : ROOT }),
    'files.content': ({ params }) => ({ kind: 'text', text: params.scope === 'checkout' ? disk.text : `// ${params.scope}\n`, hash: disk.hash, size: 10 }),
    'files.find': ({ params }) => ({ matches: [{ path: 'src/a.ts', line: params.text ? 7 : undefined, preview: params.text ? 'const a = 1;' : undefined }], truncated: false }),
    'files.save': () => ({ ok: true }),
    ...extra,
  });
  return { harness, disk };
}

let store: FrameStore;
let offs: Array<() => void> = [];
beforeEach(() => { offs = []; editors.length = 0; });
afterEach(() => {
  for (const off of offs) off();
  clearDraft('file:checkout:src/a.ts');
  vi.restoreAllMocks();
});

async function mount(): Promise<void> {
  store = new FrameStore({ workspace: '/work/acme', platform: 'linux' });
  offs.push(registerFrameCommands(store), registerViews(store.api));
  render(<FrameProvider value={store}><Frame daemon={CONNECTED} /></FrameProvider>);
  act(() => store.api.showActivity('explorer'));
  await screen.findByRole('tree', { name: 'Files in Your checkout' });
}

const tabs = () => store.getSnapshot().layout.groups.flatMap((g) => g.tabs).filter((t) => t.kind !== 'planner');
const tree = () => screen.getByRole('tree');
const row = (name: string) => within(tree()).getByRole('treeitem', { name });

async function openScopeMenu(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: /Your checkout|Integration branch|Task #\d/, description: undefined, expanded: false }));
  return screen.findByRole('menu');
}

describe('the file tree', () => {
  it('reads the root lazily, marks status and ignored files, and reads a folder when it opens', async () => {
    const { harness } = workspace();
    await mount();
    await screen.findByRole('treeitem', { name: 'README.md' });
    expect(within(row('README.md')).getByLabelText('Modified')).toBeInTheDocument();
    expect(within(row('new.ts')).getByLabelText('Untracked')).toBeInTheDocument();
    expect(row('dist')).toHaveClass('ex-ignored');
    expect(harness.callsTo('files.tree').map((c) => c.params.dir)).toEqual(['']);
    expect(harness.callsTo('files.tree')[0]?.params).toMatchObject({ workspace: '/work/acme', repo: '.', scope: 'checkout' });

    fireEvent.click(row('src'));
    await screen.findByRole('treeitem', { name: 'a.ts' });
    expect(harness.callsTo('files.tree').map((c) => c.params.dir)).toEqual(['', 'src']);
    expect(row('src')).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens a file as a preview on click and keeps it on double click', async () => {
    workspace();
    await mount();
    fireEvent.click(await screen.findByRole('treeitem', { name: 'README.md' }));
    await waitFor(() => expect(tabs().map((t) => [t.title, t.preview])).toEqual([['README.md', true]]));
    fireEvent.doubleClick(row('README.md'));
    await waitFor(() => expect(tabs().find((t) => t.title === 'README.md')?.preview).toBeFalsy());
  });

  it('walks with the arrow keys and opens with Enter', async () => {
    workspace();
    await mount();
    fireEvent.focus(await screen.findByRole('treeitem', { name: 'README.md' }));
    fireEvent.keyDown(tree(), { key: 'ArrowUp' });
    fireEvent.keyDown(tree(), { key: 'Enter' });
    await waitFor(() => expect(tabs().some((t) => t.title === 'new.ts')).toBe(true));
  });

  it('shows the task that changed a file, and a click shows that task in the plan', async () => {
    workspace();
    await mount();
    fireEvent.click(await screen.findByRole('treeitem', { name: 'src' }));
    await screen.findByRole('treeitem', { name: 'a.ts' });
    await waitFor(() => expect(scopeStoreFor(store.api).getSnapshot().session?.tasks).toHaveLength(1));
    fireEvent.click(within(row('a.ts')).getByRole('button', { name: /Changed by Task #3/ }));
    await waitFor(() => expect(selectedTask(daemonHost('/work/acme'))).toBe('t3'));
    expect(store.getSnapshot().layout.planOpen).toBe(true);
    expect(tabs().some((t) => t.kind === 'task')).toBe(false);
  });

  it('puts "Open in editor" and Reveal on the checkout\'s rows, through the shell', async () => {
    const { harness } = workspace();
    await mount();
    await screen.findByRole('treeitem', { name: 'README.md' });
    fireEvent.click(within(row('README.md')).getByRole('button', { name: 'Open in editor: README.md' }));
    expect(harness.shell.openInEditor).toHaveBeenCalledWith({ repo: '.', path: 'README.md' });
    fireEvent.click(within(row('README.md')).getByRole('button', { name: 'Show in file manager: README.md' }));
    expect(harness.shell.reveal).toHaveBeenCalledWith({ repo: '.', path: 'README.md' });
  });

  it('says what the shell refused', async () => {
    const { harness } = workspace();
    harness.shell.openInEditor.mockResolvedValueOnce({ ok: false, message: 'No editor is set.' });
    await mount();
    await screen.findByRole('treeitem', { name: 'README.md' });
    fireEvent.click(within(row('README.md')).getByRole('button', { name: 'Open in editor: README.md' }));
    await waitFor(() => expect(screen.getByText(/No editor is set\./)).toBeInTheDocument());
  });
});

describe('searching', () => {
  it('finds files by name and opens one', async () => {
    const { harness } = workspace();
    await mount();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search file names' }), { target: { value: 'a.ts' } });
    const result = await screen.findByRole('button', { name: /a\.ts/ });
    expect(harness.callsTo('files.find')[0]?.params).toMatchObject({ query: 'a.ts', scope: 'checkout' });
    expect(harness.callsTo('files.find')[0]?.params.text).toBeUndefined();
    fireEvent.click(result);
    await waitFor(() => expect(tabs()[0]?.title).toBe('a.ts'));
  });

  it('searches the text of files, and a line opens the file there', async () => {
    const { harness } = workspace();
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Search the text of files' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search text in files' }), { target: { value: 'const' } });
    const result = await screen.findByRole('button', { name: /a\.ts\s*:7/ });
    // The file's name is its own element, the folder the muted context after it, and the tooltip has both whole.
    expect(within(result).getByText('a.ts')).toBeInTheDocument();
    expect(within(result).getByText('src')).toBeInTheDocument();
    expect(result.querySelector('[title="src/a.ts:7"]')).not.toBeNull();
    expect(harness.callsTo('files.find')[0]?.params.text).toBe('1');
    fireEvent.click(result);
    await waitFor(() => expect(editors).toHaveLength(1));
    await waitFor(() => expect(editors[0]?.revealLine).toHaveBeenCalledWith(7));
  });

  it('is reached with Go to file, which focuses the search box', async () => {
    workspace();
    await mount();
    act(() => store.api.runCommand('explorer.quickOpen'));
    await waitFor(() => expect(screen.getByRole('searchbox')).toHaveFocus());
  });
});

describe('scope switching', () => {
  it('offers the checkout, the integration branch and the task worktrees, and the Explorer follows', async () => {
    const { harness } = workspace();
    await mount();
    await waitFor(() => expect(scopeStoreFor(store.api).getSnapshot().session?.tasks).toHaveLength(1));
    const menu = await openScopeMenu();
    const items = within(menu).getAllByRole('menuitemradio').map((i) => i.textContent);
    expect(items).toEqual([expect.stringContaining('Your checkout'), expect.stringContaining('Integration branch'), expect.stringContaining('Task #3 worktree')]);
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /Task #3 worktree/ }));

    await screen.findByRole('tree', { name: 'Files in Task #3' });
    const read = harness.callsTo('files.tree').at(-1);
    expect(read?.params).toMatchObject({ scope: 'task', sessionId: 's1', taskId: 't3', repo: '.', dir: '' });
    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(within(row('README.md')).queryByRole('button', { name: /Open in editor/ })).not.toBeInTheDocument();
  });

  it('opens a file of another scope as its own read-only tab, titled with the scope', async () => {
    workspace();
    await mount();
    await waitFor(() => expect(scopeStoreFor(store.api).getSnapshot().session?.tasks).toHaveLength(1));
    fireEvent.doubleClick(await screen.findByRole('treeitem', { name: 'README.md' }));
    await waitFor(() => expect(tabs().map((t) => t.title)).toEqual(['README.md']));

    scopeStoreFor(store.api).select('.', { kind: 'integration', sessionId: 's1' });
    fireEvent.click(await screen.findByRole('treeitem', { name: 'README.md' }));
    await waitFor(() => expect(tabs().map((t) => t.title)).toContain('README.md (Integration)'));
    expect(tabs()).toHaveLength(2);

    await screen.findByText(/Read-only: this is Integration branch/);
    await waitFor(() => expect(editors[0]?.readOnly).toBe(true));
    const fileTab = document.querySelector<HTMLElement>('.ft') as HTMLElement;
    expect(within(fileTab).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(within(fileTab).queryByRole('button', { name: 'Open in editor' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open Your checkout' }));
    await waitFor(() => expect(tabs().map((t) => t.title).sort()).toEqual(['README.md', 'README.md (Integration)']));
    expect(tabs().find((t) => t.title === 'README.md')?.preview).toBeFalsy();
  });

  it('opens a task worktree file\'s task in that task\'s session, switching to it first', async () => {
    workspace();
    await mount();
    await waitFor(() => expect(scopeStoreFor(store.api).getSnapshot().session?.tasks).toHaveLength(1));
    const host = daemonHost('/work/acme');
    let open = 'another';
    vi.spyOn(host, 'sessionId', 'get').mockImplementation(() => open);
    const switched = vi.spyOn(host, 'open').mockImplementation(async (sessionId) => { open = sessionId; });

    scopeStoreFor(store.api).select('.', { kind: 'task', sessionId: 's1', taskId: 't3' });
    fireEvent.click(await screen.findByRole('treeitem', { name: 'README.md' }));
    const fileTab = await waitFor(() => document.querySelector<HTMLElement>('.ft') as HTMLElement);
    fireEvent.click(await within(fileTab).findByTitle('Open the task'));

    await waitFor(() => expect(tabs().find((t) => t.kind === 'task')?.id).toBe('t3'));
    expect(switched).toHaveBeenCalledWith('s1');
  });

  it('draws the new scope\'s rows after a switch made while the tree was scrolled', async () => {
    workspace();
    await mount();
    await waitFor(() => expect(scopeStoreFor(store.api).getSnapshot().session?.tasks).toHaveLength(1));
    await screen.findByRole('treeitem', { name: 'README.md' });
    // Scrolled far past what the new scope will have: a window kept from here would draw nothing.
    fireEvent.scroll(tree(), { target: { scrollTop: 5_000 } });
    act(() => scopeStoreFor(store.api).select('.', { kind: 'integration', sessionId: 's1' }));
    await screen.findByRole('tree', { name: 'Files in Integration branch' });
    expect(await screen.findByRole('treeitem', { name: 'README.md' })).toBeInTheDocument();
  });

  it('falls back to the checkout, and says why, when a scope is gone', async () => {
    workspace(undefined, {
      'files.tree': ({ params }) => {
        if (params.scope === 'task') return refusal('gone', 'The worktree of Task #3 is gone.');
        return { at: {}, dir: params.dir, entries: ROOT };
      },
    });
    await mount();
    act(() => scopeStoreFor(store.api).select('.', { kind: 'task', sessionId: 's1', taskId: 't3' }));
    await waitFor(() => expect(scopeStoreFor(store.api).getSnapshot().notice).toMatch(/gone/));
    expect(scopeStoreFor(store.api).scopeOf()).toEqual({ kind: 'checkout' });
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(scopeStoreFor(store.api).getSnapshot().notice).toBeUndefined();
  });
});

describe('a workspace folder of several repositories (plan task 14\'s reproduction)', () => {
  const FOLDER = [
    { name: 'api', path: 'api', kind: 'repository', ignored: false },
    { name: 'docs', path: 'docs', kind: 'directory', ignored: false },
    { name: 'web', path: 'web', kind: 'repository', ignored: false },
    { name: 'notes.md', path: 'notes.md', kind: 'file', ignored: false },
  ];
  const API = [{ name: 'x.txt', path: 'x.txt', kind: 'file', ignored: false, status: 'M' }];
  const GROUP_RUN = {
    meta: { id: 's1' },
    run: {
      tasks: [{ id: 't3', order: 3, title: 'Add the parser', status: 'done', isolation: { state: 'integrated', branch: 'b', worktree: 'w', repos: ['api'] } }],
      handoff: { repos: [{ path: 'api', integrationBranch: 'ordewell/s1', landed: [] }], landed: [] },
    },
  };
  const group = () => workspace(undefined, {
    'git.repos': () => ({ repos: [{ repo: 'api', branch: 'main', detached: false }, { repo: 'web', branch: 'dev', detached: false }] }),
    'sessions.get': () => GROUP_RUN,
    'files.tree': ({ params }) => ({ at: {}, dir: params.dir, entries: params.repo === '.' ? FOLDER : API }),
  });
  const picker = () => screen.getByRole('combobox', { name: 'Repository' }) as HTMLSelectElement;

  it('opens on the selected folder, plain folders and loose files included, not on the first repository', async () => {
    const { harness } = group();
    await mount();
    await waitFor(() => expect(scopeStoreFor(store.api).getSnapshot().repos).toHaveLength(2));
    expect(scopeStoreFor(store.api).getSnapshot().repo).toBe('.');
    await screen.findByRole('treeitem', { name: 'notes.md' });
    expect(within(tree()).getAllByRole('treeitem').map((r) => r.getAttribute('aria-label'))).toEqual(['api', 'docs', 'web', 'notes.md']);
    expect(harness.callsTo('files.tree').every((c) => c.params.repo === '.')).toBe(true);
    expect(picker().value).toBe('.');
    expect([...picker().options].map((o) => o.textContent)).toEqual(['Workspace folder', 'api (main)', 'web (dev)']);
  });

  it('browses a repository from its row or the picker, and comes back to the folder', async () => {
    const { harness } = group();
    await mount();
    fireEvent.click(await screen.findByRole('treeitem', { name: 'api' }));
    await screen.findByRole('treeitem', { name: 'x.txt' });
    expect(scopeStoreFor(store.api).getSnapshot().repo).toBe('api');
    expect(harness.callsTo('files.tree').at(-1)?.params).toMatchObject({ repo: 'api', scope: 'checkout', dir: '' });

    fireEvent.change(picker(), { target: { value: '.' } });
    await screen.findByRole('treeitem', { name: 'notes.md' });
    fireEvent.change(picker(), { target: { value: 'web' } });
    await waitFor(() => expect(harness.callsTo('files.tree').at(-1)?.params.repo).toBe('web'));
  });

  it('offers the folder only its own files, and each repository its branch and worktrees', async () => {
    group();
    await mount();
    await waitFor(() => expect(scopeStoreFor(store.api).getSnapshot().session?.tasks).toHaveLength(1));
    const menu = await openScopeMenu();
    const folder = within(menu).getByRole('group', { name: 'Workspace folder' });
    expect(within(folder).getAllByRole('menuitemradio').map((i) => i.textContent)).toEqual(['Workspace folder']);
    const api = within(menu).getByRole('group', { name: 'api' });
    expect(within(api).getAllByRole('menuitemradio').map((i) => i.textContent)).toEqual([
      expect.stringContaining('Your checkout'), expect.stringContaining('Integration branch'), expect.stringContaining('Task #3 worktree'),
    ]);
    fireEvent.click(within(api).getByRole('menuitemradio', { name: /Task #3 worktree/ }));
    await screen.findByRole('tree', { name: 'Files in Task #3' });
    expect(scopeStoreFor(store.api).getSnapshot().repo).toBe('api');
  });

  it('opens a loose file of the folder for editing in the folder\'s own scope', async () => {
    const { harness } = group();
    await mount();
    fireEvent.doubleClick(await screen.findByRole('treeitem', { name: 'notes.md' }));
    await waitFor(() => expect(tabs().map((t) => t.title)).toEqual(['notes.md']));
    await waitFor(() => expect(harness.callsTo('files.content').at(-1)?.params).toMatchObject({ repo: '.', scope: 'checkout', path: 'notes.md' }));
  });
});

describe('a file in your checkout', () => {
  async function openReadme(): Promise<FakeEditor> {
    fireEvent.doubleClick(await screen.findByRole('treeitem', { name: 'README.md' }));
    await waitFor(() => expect(editors).toHaveLength(1));
    return editors[0] as FakeEditor;
  }

  it('is an editor: typing marks the tab and the file, and Save writes against the hash it read', async () => {
    const { harness, disk } = workspace();
    harness.shell.reveal.mockClear();
    await mount();
    const editor = await openReadme();
    expect(editor.readOnly).toBe(false);
    expect(editor.getText()).toBe('const a = 1;\n');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    act(() => editor.type('const a = 2;\n'));
    await waitFor(() => expect(tabs()[0]?.title).toBe('● README.md'));
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    disk.hash = 'h2';
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(tabs()[0]?.title).toBe('README.md'));
    expect(harness.callsTo('files.save')[0]?.body).toEqual({ workspace: '/work/acme', repo: '.', path: 'README.md', text: 'const a = 2;\n', baseHash: 'h1' });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves with the keyboard shortcut', async () => {
    const { harness } = workspace();
    await mount();
    const editor = await openReadme();
    act(() => editor.type('x'));
    await act(async () => { editor.save(); });
    await waitFor(() => expect(harness.callsTo('files.save')).toHaveLength(1));
  });

  it('asks before it loses a change made on disk: reload takes the disk\'s version', async () => {
    const { harness } = workspace(undefined, { 'files.save': () => refusal('stale', 'The file changed.', 409) });
    await mount();
    const editor = await openReadme();
    act(() => editor.type('mine'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('changed on disk');
    expect(editor.getText()).toBe('mine');

    fireEvent.click(within(alert).getByRole('button', { name: 'Reload from disk' }));
    await waitFor(() => expect(editor.getText()).toBe('const a = 1;\n'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(tabs()[0]?.title).toBe('README.md');
    expect(harness.callsTo('files.save')).toHaveLength(1);
  });

  it('can overwrite the file on a conflict, against what is on disk now', async () => {
    let refuse = true;
    const { harness, disk } = workspace(undefined, { 'files.save': () => (refuse ? refusal('stale', 'The file changed.', 409) : { ok: true }) });
    await mount();
    const editor = await openReadme();
    act(() => editor.type('mine'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    refuse = false;
    disk.hash = 'h9';
    fireEvent.click(within(alert).getByRole('button', { name: 'Overwrite the file' }));
    await waitFor(() => expect(harness.callsTo('files.save')).toHaveLength(2));
    expect(harness.callsTo('files.save')[1]?.body).toMatchObject({ text: 'mine', baseHash: 'h9' });
  });

  it('reloads quietly when the file changed on disk and nothing is unsaved', async () => {
    const { disk } = workspace();
    await mount();
    const editor = await openReadme();
    disk.text = 'from elsewhere\n';
    disk.hash = 'h5';
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(editor.getText()).toBe('from elsewhere\n'));
    expect(screen.getByRole('status', { name: '' })).toBeDefined();
  });

  it('warns instead when there are unsaved changes', async () => {
    const { disk } = workspace();
    await mount();
    const editor = await openReadme();
    act(() => editor.type('mine'));
    disk.hash = 'h5';
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(await screen.findByRole('alert')).toHaveTextContent('while you have unsaved changes');
    expect(editor.getText()).toBe('mine');
  });

  it('keeps unsaved text when its tab is looked away from', async () => {
    workspace();
    await mount();
    const editor = await openReadme();
    act(() => editor.type('mine'));
    fireEvent.doubleClick(await screen.findByRole('treeitem', { name: 'new.ts' }));
    await waitFor(() => expect(tabs()).toHaveLength(2));
    const readme = tabs().find((t) => t.title.endsWith('README.md'));
    expect(readme?.title).toBe('● README.md');
    act(() => store.dispatch({ type: 'activate', group: 0, key: tabs().find((t) => t.title === 'new.ts')?.key ?? '' }));
    act(() => store.dispatch({ type: 'activate', group: 0, key: readme?.key ?? '' }));
    await waitFor(() => expect(editors.at(-1)?.getText()).toBe('mine'));
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('shows the size of a binary file or a large one instead of an editor, with the OS\'s editor for it', async () => {
    const { harness } = workspace(undefined, { 'files.content': ({ params }) => (params.path === 'README.md' ? { kind: 'binary', size: 2048 } : { kind: 'too-large', size: 9 * 1024 * 1024, limit: 1024 * 1024 }) });
    await mount();
    fireEvent.doubleClick(await screen.findByRole('treeitem', { name: 'README.md' }));
    expect(await screen.findByText('This is a binary file (2.0 KB), so it is not shown.')).toBeInTheDocument();
    expect(editors).toHaveLength(0);
    fireEvent.click(within(document.querySelector<HTMLElement>('.fv-state') as HTMLElement).getByRole('button', { name: 'Open in editor' }));
    expect(harness.shell.openInEditor).toHaveBeenCalledWith({ repo: '.', path: 'README.md' });

    fireEvent.doubleClick(row('new.ts'));
    expect(await screen.findByText('This file is 9.0 MB, over the 1.0 MB the viewer opens.')).toBeInTheDocument();
  });

  it('reveals the file in the file manager from its toolbar', async () => {
    const { harness } = workspace();
    await mount();
    await openReadme();
    fireEvent.click(within(document.querySelector<HTMLElement>('.ft') as HTMLElement).getByRole('button', { name: 'Show in file manager' }));
    expect(harness.shell.reveal).toHaveBeenCalledWith({ repo: '.', path: 'README.md' });
  });
});
