import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RouteParams } from '../../../../shared/routes';
import { registerFrameCommands } from '../../../frame/commands';
import { Frame } from '../../../frame/Frame';
import { FrameProvider, FrameStore } from '../../../frame/store';
import { DaemonHost, daemonHost, resetDaemonHosts } from '../../../session/DaemonHost';
import { registerViews } from '../../index';
import { resetTaskViews } from '../../task/taskView';
import { fakeDaemon, ok, surfacePlan, surfaceTask } from '../../../session/__tests__/fakeDaemon';
import { fileTabId } from '../../explorer/fileTabs';
import { ChangesList } from '../ChangesSidebar';
import { HANDOFF, runTask, runView, worktree } from './fixtures';

// Monaco needs a browser; the frame's views are registered here, but none opens a file.
vi.mock('../../../monaco', async () => (await import('../../../test/monacoMock')).fakeMonacoModule());

const WORKSPACE = '/work/acme';

const TASKS = [
  runTask({ id: 't1', order: 1, title: 'Add the login button', status: 'completed', isolation: { ...worktree('integrated'), revertible: true } }),
  runTask({ id: 't2', order: 2, title: 'Read the docs', status: 'completed', isolation: { state: 'none' } }),
  runTask({ id: 't3', order: 3, title: 'Wire SSO', status: 'in_progress', isolation: worktree('active') }),
  runTask({ id: 't4', order: 4, title: 'Fix routes', status: 'failed', isolation: worktree('conflict', { repos: ['web'], conflictRepo: 'web', conflictFiles: ['routes.ts'] }) }),
  runTask({ id: 't5', order: 5, title: 'Deploy', status: 'pending', isolation: { state: 'none' }, mergeGate: ['t1'] }),
];

/** What task_diff lists for each task, as an agent reads it. */
const TASK_DIFFS: Record<string, string> = {
  t1: '[repo .] src/login.tsx: +12 -3\n',
  t3: '[repo .] src/sso.ts: +40 -0\n[repo .] README.md: +2 -2\n[repo .] logo.png: binary change\n',
  t4: '[repo web] routes.ts: +1 -1\n',
};

/** git's own diff of a scope: a worktree's or the integration branch's. */
function gitDiff(params: RouteParams | undefined) {
  if (params?.scope === 'integration') {
    return ok({ files: [{ path: 'src/login.tsx', status: 'M', added: 12, removed: 3 }] });
  }
  if (params?.taskId === 't3') {
    return ok({ files: [{ path: 'src/sso.ts', status: 'A', added: 40, removed: 0 }, { path: 'README.md', status: 'M', added: 2, removed: 2 }, { path: 'logo.png', status: 'M' }] });
  }
  // A merged task's worktree is gone: git has nothing to say about it.
  return { ok: false as const, status: 404, error: 'No worktree.' };
}

let hosts: DaemonHost[] = [];
let offs: Array<() => void> = [];
afterEach(() => {
  for (const host of hosts) host.dispose();
  for (const off of offs) off();
  hosts = [];
  offs = [];
  resetDaemonHosts();
  resetTaskViews();
  vi.restoreAllMocks();
});

function reviewDaemon(answers: Parameters<typeof fakeDaemon>[0] = {}) {
  return fakeDaemon({
    // The plan read again after an action is the same plan: the run's view of it stands.
    'sessions.load': ok({ ok: true, plan: surfacePlan(TASKS.map(({ id, order, title, status }) => surfaceTask({ id, order, title, status })), 'running'), goal: 'Ship SSO' }),
    'plans.taskDiff': (params) => ok({ available: true, text: TASK_DIFFS[String(params?.taskId)] ?? '' }),
    'git.diff': gitDiff,
    'plans.resolveConflict': ok({ plan: null }),
    ...answers,
  });
}

async function mounted() {
  const daemon = reviewDaemon();
  const host = new DaemonHost(WORKSPACE, async () => null);
  hosts.push(host);
  await act(() => host.open('s1'));
  await act(async () => {
    daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'run_snapshot', sessionId: 's1', view: runView(TASKS, HANDOFF), stream: 'd1', seq: 0 });
  });
  const store = new FrameStore({ workspace: WORKSPACE, platform: 'linux' });
  const openTab = vi.spyOn(store.api, 'openTab');
  render(<FrameProvider value={store}><ChangesList api={store.api} host={host} /></FrameProvider>);
  await screen.findByRole('button', { name: /sso\.ts/ });
  await screen.findAllByRole('button', { name: /login\.tsx/ });
  return { daemon, host, openTab };
}

describe('the Changes sidebar', () => {
  it('puts conflicts first, then each task\'s files, then the whole run', async () => {
    await mounted();
    const sections = screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'));
    expect(sections).toEqual([
      'Conflicts', 'Waiting for a merge', 'Task #1: Add the login button', 'Task #3: Wire SSO', 'Task #4: Fix routes', 'Whole run vs base',
    ]);

    const conflict = within(screen.getByRole('region', { name: 'Conflicts' }));
    expect(conflict.getByRole('button', { name: '#4 Fix routes' })).toBeInTheDocument();
    expect(conflict.getByText('web: routes.ts')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Waiting for a merge' })).getByText(/waits for #1 Add the login button to be merged/)).toBeInTheDocument();
  });

  it('marks each file with its kind of change and its line counts', async () => {
    await mounted();
    const sso = within(screen.getByRole('region', { name: 'Task #3: Wire SSO' }));
    expect(within(sso.getByRole('button', { name: /sso\.ts/ })).getByLabelText('Added')).toHaveTextContent('A');
    expect(sso.getByLabelText('40 added, 0 removed')).toBeInTheDocument();
    expect(within(sso.getByRole('button', { name: /README\.md/ })).getByLabelText('Modified')).toHaveTextContent('M');
    expect(within(sso.getByRole('button', { name: /logo\.png/ })).getByText('binary')).toBeInTheDocument();

    // A merged task's worktree is gone: its counts stand without a letter.
    const login = within(screen.getByRole('region', { name: 'Task #1: Add the login button' }));
    expect(login.getByLabelText('12 added, 3 removed')).toBeInTheDocument();
    expect(login.queryByLabelText('Modified')).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Whole run vs base' })).getByLabelText('Modified')).toBeInTheDocument();
  });

  it('filters on file or task, and a task named shows all its files', async () => {
    await mounted();
    const filter = screen.getByRole('searchbox', { name: 'Filter changed files' });

    fireEvent.change(filter, { target: { value: 'LOGIN' } });
    expect(screen.queryByRole('region', { name: 'Task #3: Wire SSO' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Task #1: Add the login button' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Whole run vs base' })).getByRole('button', { name: /login\.tsx/ })).toBeInTheDocument();

    fireEvent.change(filter, { target: { value: 'sso' } });
    const sso = within(screen.getByRole('region', { name: 'Task #3: Wire SSO' }));
    expect(sso.getAllByRole('button', { name: /\.(ts|md|png)/ })).toHaveLength(3);
    expect(screen.queryByRole('region', { name: 'Task #1: Add the login button' })).not.toBeInTheDocument();
  });

  it('opens a file as a diff in the scope it was changed in', async () => {
    const { openTab } = await mounted();
    fireEvent.click(within(screen.getByRole('region', { name: 'Task #3: Wire SSO' })).getByRole('button', { name: /sso\.ts/ }));
    expect(openTab).toHaveBeenLastCalledWith(
      { kind: 'diff', id: fileTabId('.', 'src/sso.ts'), title: 'sso.ts (Task #3)', scope: { kind: 'task', sessionId: 's1', taskId: 't3' } },
      { preview: true },
    );
    fireEvent.doubleClick(within(screen.getByRole('region', { name: 'Whole run vs base' })).getByRole('button', { name: /login\.tsx/ }));
    expect(openTab).toHaveBeenLastCalledWith(
      { kind: 'diff', id: fileTabId('.', 'src/login.tsx'), title: 'login.tsx (Integration)', scope: { kind: 'integration', sessionId: 's1' } },
      { preview: false },
    );
  });

  it('reaches resolve-conflict, revert and a start past the gate from here', async () => {
    const { daemon } = await mounted();
    // Revert shows what it takes with it before it asks (ADR-0054): the preview is read first.
    fireEvent.click(within(screen.getByRole('region', { name: 'Task #1: Add the login button' })).getByRole('button', { name: 'Revert…' }));
    await waitFor(() => expect(daemon.calls('plans.revertPreview')).toEqual([[{ sessionId: 's1', taskId: 't1' }, undefined]]));

    fireEvent.click(screen.getByRole('button', { name: 'Start anyway…' }));
    await waitFor(() => expect(daemon.calls('plans.mergeGate')).toEqual([[{ sessionId: 's1', taskId: 't5' }, undefined]]));

    fireEvent.click(within(screen.getByRole('region', { name: 'Conflicts' })).getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(daemon.calls('plans.resolveConflict')).toEqual([[{ sessionId: 's1', taskId: 't4' }, undefined]]));
  });

  it('starts a long group closed, opens it on a click and closes it on the next; Show in plan is separate', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ path: `src/f${i}.ts`, status: 'M', added: 1, removed: 0 }));
    const sso = runTask({ id: 't3', order: 3, title: 'Wire SSO', status: 'in_progress', isolation: worktree('active') });
    const daemon = fakeDaemon({
      'sessions.load': ok({ ok: true, plan: surfacePlan([surfaceTask({ id: 't3', order: 3, title: 'Wire SSO', status: 'in_progress' })], 'running'), goal: 'g' }),
      'plans.taskDiff': ok({ available: true, text: many.map((f) => `[repo .] ${f.path}: +1 -0\n`).join('') }),
      'git.diff': (params) => (params?.taskId === 't3' ? ok({ files: many }) : { ok: false as const, status: 404, error: 'No worktree.' }),
    });
    const host = new DaemonHost(WORKSPACE, async () => null);
    hosts.push(host);
    await act(() => host.open('s1'));
    await act(async () => {
      daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'run_snapshot', sessionId: 's1', view: runView([sso], HANDOFF), stream: 'd1', seq: 0 });
    });
    const reveal = vi.spyOn(host, 'revealTask');
    const store = new FrameStore({ workspace: WORKSPACE, platform: 'linux' });
    render(<FrameProvider value={store}><ChangesList api={store.api} host={host} /></FrameProvider>);

    const group = within(await screen.findByRole('region', { name: 'Task #3: Wire SSO' }));
    await group.findByLabelText('9 files');
    expect(group.queryByRole('button', { name: /f0\.ts/ })).not.toBeInTheDocument();

    const head = group.getByRole('button', { expanded: false });
    fireEvent.click(head);
    expect(await group.findByRole('button', { name: /f0\.ts/ })).toBeInTheDocument();
    fireEvent.click(group.getByRole('button', { expanded: true }));
    expect(group.queryByRole('button', { name: /f0\.ts/ })).not.toBeInTheDocument();
    expect(reveal).not.toHaveBeenCalled();

    fireEvent.click(group.getByRole('button', { name: 'Show in plan' }));
    expect(reveal).toHaveBeenCalledWith('t3');
  });

  it('opens and closes a task by its chevron or its title alike, and never by its own actions', async () => {
    const { daemon, host } = await mounted();
    const reveal = vi.spyOn(host, 'revealTask');
    const region = screen.getByRole('region', { name: 'Task #1: Add the login button' });
    const group = within(region);
    const title = group.getByRole('button', { name: /^#1 Add the login button/ });
    // Its glyph is redrawn as it turns, so it is found again each time.
    const chevron = (): Element | null => region.querySelector('.changes-chevron');
    expect(chevron()).not.toBeNull();
    const shown = (): boolean => group.queryByRole('button', { name: /login\.tsx/ }) !== null;
    expect(title).toHaveAttribute('aria-expanded', 'true');
    expect(shown()).toBe(true);

    // The chevron and the title are one control: each click turns the same state over, whichever was clicked last.
    for (const [target, open] of [['chevron', false], ['chevron', true], ['title', false], ['chevron', true], ['title', false], ['title', true]] as const) {
      fireEvent.click((target === 'chevron' ? chevron() : title) as Element);
      expect(title).toHaveAttribute('aria-expanded', String(open));
      expect(shown()).toBe(open);
    }

    // Revert and Show in plan do their own work and leave the group as it was.
    fireEvent.click(group.getByRole('button', { name: 'Revert…' }));
    fireEvent.click(group.getByRole('button', { name: 'Show in plan' }));
    expect(reveal).toHaveBeenCalledWith('t1');
    await waitFor(() => expect(daemon.calls('plans.revertPreview')).toHaveLength(1));
    expect(title).toHaveAttribute('aria-expanded', 'true');
    expect(shown()).toBe(true);
  });

  it('opens and closes a task from the keyboard, with a native button that takes Enter and Space', async () => {
    await mounted();
    const group = within(screen.getByRole('region', { name: 'Task #3: Wire SSO' }));
    const title = group.getByRole('button', { name: /^#3 Wire SSO/ });
    // A native button turns Enter and Space into a click; jsdom does not, so the click stands in for the key.
    expect(title.tagName).toBe('BUTTON');
    expect(title).toHaveAttribute('aria-expanded', 'true');
    title.focus();
    expect(title).toHaveFocus();
    fireEvent.keyDown(title, { key: 'Enter' });
    fireEvent.click(title);
    expect(title).toHaveAttribute('aria-expanded', 'false');
    expect(title).toHaveFocus();
    fireEvent.keyDown(title, { key: ' ' });
    fireEvent.click(title);
    expect(title).toHaveAttribute('aria-expanded', 'true');
    expect(group.getByRole('button', { name: /sso\.ts/ })).toBeInTheDocument();
    // No control is nested in another, so each is reached and named on its own.
    expect(screen.getByRole('region', { name: 'Task #3: Wire SSO' }).querySelector('button button')).toBeNull();
  });

  it('keeps a group the user closed closed while a filter matches in it, and says how many match', async () => {
    await mounted();
    const group = within(screen.getByRole('region', { name: 'Task #3: Wire SSO' }));
    fireEvent.click(group.getByRole('button', { name: /^#3 Wire SSO/ }));

    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter changed files' }), { target: { value: 'readme' } });
    expect(group.getByRole('button', { name: /^#3 Wire SSO/ })).toHaveAttribute('aria-expanded', 'false');
    expect(group.queryByRole('button', { name: /README\.md/ })).not.toBeInTheDocument();
    expect(group.getByLabelText('1 of 3 files match')).toHaveTextContent('1/3');

    // A group the user never turned opens to show what matches.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter changed files' }), { target: { value: 'login' } });
    expect(within(screen.getByRole('region', { name: 'Task #1: Add the login button' })).getByRole('button', { name: /login\.tsx/ })).toBeInTheDocument();
  });

  it('says where matches are while Review is folded', async () => {
    await mounted();
    fireEvent.click(screen.getByRole('button', { name: /^Review/ }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter changed files' }), { target: { value: 'sso' } });
    expect(screen.getByText('Review is folded: open it to see the tasks that match.')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter changed files' }), { target: { value: '' } });
    expect(screen.queryByText(/Review is folded/)).not.toBeInTheDocument();
  });

  it('keeps each group as it was across a refresh, without opening a long one while it reads again', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ path: `src/f${i}.ts`, status: 'M', added: 1, removed: 0 }));
    const daemon = reviewDaemon({
      'plans.taskDiff': (params) => ok({ available: true, text: params?.taskId === 't1' ? many.map((f) => `[repo .] ${f.path}: +1 -0\n`).join('') : TASK_DIFFS[String(params?.taskId)] ?? '' }),
    });
    const host = new DaemonHost(WORKSPACE, async () => null);
    hosts.push(host);
    await act(() => host.open('s1'));
    await act(async () => {
      daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'run_snapshot', sessionId: 's1', view: runView(TASKS, HANDOFF), stream: 'd1', seq: 0 });
    });
    const store = new FrameStore({ workspace: WORKSPACE, platform: 'linux' });
    render(<FrameProvider value={store}><ChangesList api={store.api} host={host} /></FrameProvider>);
    const login = within(screen.getByRole('region', { name: 'Task #1: Add the login button' }));
    const sso = within(screen.getByRole('region', { name: 'Task #3: Wire SSO' }));
    await login.findByLabelText('9 files');
    await sso.findByRole('button', { name: /sso\.ts/ });
    fireEvent.click(sso.getByRole('button', { name: /^#3 Wire SSO/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh changes' }));
    expect(login.getByRole('button', { name: /^#1 Add the login button/ })).toHaveAttribute('aria-expanded', 'false');
    expect(login.queryByRole('status', { name: 'Loading changes' })).not.toBeInTheDocument();
    await waitFor(() => expect(login.getByLabelText('9 files')).toBeInTheDocument());
    expect(login.getByRole('button', { name: /^#1 Add the login button/ })).toHaveAttribute('aria-expanded', 'false');
    expect(sso.getByRole('button', { name: /^#3 Wire SSO/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('never folds one session\'s task because the same task was folded in another', async () => {
    const daemon = reviewDaemon();
    const host = new DaemonHost(WORKSPACE, async () => null);
    hosts.push(host);
    const store = new FrameStore({ workspace: WORKSPACE, platform: 'linux' });
    const show = async (sessionId: string): Promise<void> => {
      await act(() => host.open(sessionId));
      await act(async () => {
        daemon.push(sessionId, { type: 'connected', sessionId }, { type: 'run_snapshot', sessionId, view: runView(TASKS, HANDOFF), stream: `d-${sessionId}`, seq: 0 });
      });
    };
    await show('s1');
    render(<FrameProvider value={store}><ChangesList api={store.api} host={host} /></FrameProvider>);
    const title = (): HTMLElement => within(screen.getByRole('region', { name: 'Task #3: Wire SSO' })).getByRole('button', { name: /^#3 Wire SSO/ });
    await screen.findByRole('button', { name: /sso\.ts/ });
    fireEvent.click(title());
    expect(title()).toHaveAttribute('aria-expanded', 'false');

    await show('s2');
    expect(title()).toHaveAttribute('aria-expanded', 'true');
    await show('s1');
    expect(title()).toHaveAttribute('aria-expanded', 'false');
  });

  it('folds the task list under its one Review heading, while the whole run, conflicts, gates and Merge all stay usable', async () => {
    const daemon = reviewDaemon();
    const store = new FrameStore({ workspace: WORKSPACE, platform: 'linux' });
    offs.push(registerFrameCommands(store), registerViews(store.api));
    const openTab = vi.spyOn(store.api, 'openTab');
    const host = daemonHost(WORKSPACE);
    render(<FrameProvider value={store}><Frame daemon={{ state: 'connected', port: 3700, owned: true, daemon: { version: '0.12.3', contract: 1 } }} /></FrameProvider>);
    await act(() => host.open('s1'));
    await act(async () => {
      daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'run_snapshot', sessionId: 's1', view: runView(TASKS, HANDOFF), stream: 'd1', seq: 0 });
    });
    act(() => store.api.showActivity('changes'));
    const sidebar = (): ReturnType<typeof within> => within(screen.getByRole('navigation', { name: 'Changes' }));
    await sidebar().findByRole('button', { name: /sso\.ts/ });
    expect(sidebar().getAllByRole('heading', { name: /^Review/ })).toHaveLength(1);
    const review = (): HTMLElement => sidebar().getByRole('button', { name: /^Review/ });
    expect(review()).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(review());
    expect(review()).toHaveAttribute('aria-expanded', 'false');
    expect(sidebar().queryByRole('region', { name: /^Task #/ })).not.toBeInTheDocument();
    expect(sidebar().getByRole('button', { name: 'Resolve' })).toBeInTheDocument();
    expect(sidebar().getByRole('button', { name: 'Start anyway…' })).toBeInTheDocument();
    expect(sidebar().getByRole('button', { name: 'Merge all…' })).toBeInTheDocument();
    const run = within(sidebar().getByRole('region', { name: 'Whole run vs base' }));
    fireEvent.click(run.getByRole('button', { name: /login\.tsx/ }));
    expect(openTab).toHaveBeenLastCalledWith(
      { kind: 'diff', id: fileTabId('.', 'src/login.tsx'), title: 'login.tsx (Integration)', scope: { kind: 'integration', sessionId: 's1' } },
      { preview: true },
    );
    fireEvent.click(run.getByRole('button', { name: /Whole run vs base/ }));
    expect(run.queryByRole('button', { name: /login\.tsx/ })).not.toBeInTheDocument();

    // The fold is the user's: it stands when the sidebar is drawn again.
    act(() => store.api.showActivity('explorer'));
    act(() => store.api.showActivity('changes'));
    expect(review()).toHaveAttribute('aria-expanded', 'false');
    expect(sidebar().queryByRole('region', { name: /^Task #/ })).not.toBeInTheDocument();
    expect(within(sidebar().getByRole('region', { name: 'Whole run vs base' })).getByRole('button', { name: /Whole run vs base/ })).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(review());
    expect(await sidebar().findByRole('region', { name: 'Task #3: Wire SSO' })).toBeInTheDocument();
  });

  it('says so when no task has changes yet', async () => {
    fakeDaemon({ 'sessions.load': ok({ ok: true, plan: surfacePlan([]), goal: 'g' }) });
    const host = new DaemonHost(WORKSPACE, async () => null);
    hosts.push(host);
    const store = new FrameStore({ workspace: WORKSPACE, platform: 'linux' });
    render(<FrameProvider value={store}><ChangesList api={store.api} host={host} /></FrameProvider>);
    expect(screen.getByText(/No changes to review yet/)).toBeInTheDocument();
  });
});
