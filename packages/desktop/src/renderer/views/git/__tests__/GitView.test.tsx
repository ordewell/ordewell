import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonStatus } from '../../../../shared/bridge';
import type { RouteParams } from '../../../../shared/routes';
import { registerFrameCommands } from '../../../frame/commands';
import { Frame } from '../../../frame/Frame';
import { activeTab } from '../../../frame/layout';
import { FrameProvider, FrameStore } from '../../../frame/store';
import { daemonHost, resetDaemonHosts } from '../../../session/DaemonHost';
import { fakeDaemon, ok } from '../../../session/__tests__/fakeDaemon';
import { diffEditors } from '../../../test/monacoMock';
import { register as registerGraph } from '../CommitGraphTab';
import { register as registerDiff } from '../CommitDiffTab';
import { register as registerSidebar } from '../GitSidebar';
import { commitsTabId } from '../gitModel';

// Monaco needs a browser's layout and Vite's workers; a test gives it two strings.
vi.mock('../../../monaco', async () => (await import('../../../test/monacoMock')).fakeMonacoModule());

const WORKSPACE = '/work/acme';
const CONNECTED: DaemonStatus = { state: 'connected', port: 3700, owned: true, daemon: { version: '0.12.3', contract: 1 } };
const sha = (c: string): string => c.repeat(40);

const branch = (name: string, extra: Record<string, unknown> = {}) => ({ name, sha: sha('a'), upstream: null, ahead: 0, behind: 0, current: false, ...extra });

const BRANCHES = {
  repo: '.', current: 'main', detached: false,
  local: [
    branch('main', { current: true, upstream: 'origin/main', ahead: 2, behind: 1, landingFor: [{ sessionId: 's1', runId: 'r7' }] }),
    branch('feature/login', { sha: sha('b') }),
  ],
  ordewell: [
    branch('ordewell/r7/integration', { sha: sha('c'), owner: { sessionId: 's1', runId: 'r7' } }),
    branch('ordewell/r7/t3', { sha: sha('d'), owner: { sessionId: 's1', runId: 'r7', taskId: 't3' } }),
  ],
  remote: [branch('origin/main')],
  stashes: [{ ref: 'stash@{0}', sha: sha('e'), message: 'WIP on main' }],
  worktrees: [
    { path: '/work/acme', branch: 'main', head: sha('a'), main: true },
    { path: '/work/acme/.ordewell/worktrees/r7/t3', branch: 'ordewell/r7/t3', head: sha('d'), main: false, owner: { sessionId: 's1', runId: 'r7', taskId: 't3' } },
  ],
};

const commit = (c: string, parents: string[], subject: string, refs: string[] = []) => ({ sha: sha(c), parents: parents.map(sha), refs, subject, author: 'Ada', email: 'a@x', date: '2025-01-01T00:00:00Z' });

const LOG = [
  commit('a', ['f'], 'Merge: Wire SSO', ['HEAD', 'main', 'origin/main']),
  commit('f', [], 'Add the login button', ['ordewell/r7/integration', 'v1.0']),
];

const SESSION = {
  run: {
    tasks: [
      { id: 't1', order: 1, title: 'Wire SSO', isolation: { state: 'integrated', repos: ['.'] } },
      { id: 't3', order: 3, title: 'Add tests', isolation: { state: 'active', repos: ['.'] } },
    ],
    handoff: { repos: [{ path: '.', integrationBranch: 'ordewell/r7/integration' }] },
  },
};

const REPO_STATE = { repo: '.', branch: 'main', detached: false, head: sha('a'), upstream: 'origin/main', ahead: 2, behind: 1 };

type Answers = Parameters<typeof fakeDaemon>[0];

let store: FrameStore;
let offs: Array<() => void> = [];
beforeEach(() => { offs = []; diffEditors.length = 0; });
afterEach(() => {
  for (const off of offs) off();
  resetDaemonHosts();
  vi.restoreAllMocks();
});

async function mount(extra: Answers = {}, branches: unknown = BRANCHES) {
  const daemon = fakeDaemon({
    'git.repos': ok({ repos: [REPO_STATE] }),
    'git.switch': ok({ repo: REPO_STATE }),
    'git.branchDelete': ok({ repo: REPO_STATE }),
    'git.stashPop': ok({ repo: REPO_STATE }),
    'git.stashDrop': ok({ repo: REPO_STATE }),
    'git.pull': ok({ repo: REPO_STATE }),
    'git.push': ok({ repo: REPO_STATE }),
    'git.branches': ok(branches),
    'git.log': ok({ repo: '.', ref: 'HEAD', commits: LOG, cursor: null }),
    'sessions.list': ok([{ id: 's1', goal: 'Ship SSO', status: 'running', taskCount: 2 }]),
    'sessions.get': ok(SESSION),
    ...extra,
  });
  store = new FrameStore({ workspace: WORKSPACE, platform: 'linux' });
  offs.push(registerFrameCommands(store), registerSidebar(store.api), registerGraph(store.api), registerDiff(store.api));
  render(<FrameProvider value={store}><Frame daemon={CONNECTED} /></FrameProvider>);
  act(() => store.api.showActivity('git'));
  await screen.findByRole('button', { name: 'Switch to feature/login' });
  return daemon;
}

/** The confirm dialog, which draws into the body outside the frame. */
async function dialog(): Promise<HTMLElement> {
  return screen.findByRole('dialog');
}

const answer = (name: string | RegExp): void => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name })); };

describe('the Git sidebar', () => {
  it('lists the branches, the stashes and the worktrees, with the checkout’s upstream marks', async () => {
    await mount();
    expect(screen.getByLabelText('2 commits ahead, 1 commit behind')).toHaveTextContent('↑2 ↓1');
    expect(screen.getByRole('button', { name: 'origin/main' })).toBeInTheDocument();
    expect(screen.getByTitle('stash@{0}: WIP on main')).toBeInTheDocument();
    expect(screen.getByText('Your checkout')).toBeInTheDocument();
  });

  it('links each Ordewell worktree to its task, and the integration branch to its run', async () => {
    const daemon = await mount();
    const host = daemonHost(WORKSPACE);
    const open = vi.spyOn(host, 'open').mockResolvedValue(undefined);
    const reveal = vi.spyOn(host, 'revealTask').mockReturnValue(undefined);
    // The task's worktree and its branch both belong to it.
    const [link] = await screen.findAllByRole('button', { name: 'run r7 · task #3' });
    expect(daemon.calls('sessions.get').length).toBeGreaterThan(0);
    expect(screen.getByText('integration')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'run r7' })).toBeInTheDocument();
    fireEvent.click(link!);
    await waitFor(() => expect(reveal).toHaveBeenCalledWith('t3'));
    expect(open).toHaveBeenCalledWith('s1');
    // The plan panel already shows the run's plan: the sidebar stays on Git.
    expect(store.getSnapshot().layout.activity).toBe('git');
  });

  it('has no switch or delete on a branch Ordewell owns, nor on the checked-out one', async () => {
    await mount();
    expect(screen.queryByRole('button', { name: /Switch to ordewell/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete ordewell/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete main' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete feature/login' })).toBeInTheDocument();
    expect(screen.getByText('read-only')).toBeInTheDocument();
  });

  it('closes the new-branch form on Esc and keeps that Esc from closing anything under it', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'New branch' }));
    const form = screen.getByRole('form', { name: 'New branch' });
    const unhandled = fireEvent.keyDown(within(form).getByRole('textbox'), { key: 'Escape' });
    expect(unhandled).toBe(false);
    expect(screen.queryByRole('form', { name: 'New branch' })).toBeNull();
  });

  it('shows the lock a live run puts on its landing branch', async () => {
    await mount();
    expect(screen.getByTitle('A live run lands on main')).toHaveTextContent('run r7');
  });
});

describe('the confirms', () => {
  it('names repository, branch and worktree before it switches, and sends nothing on Cancel', async () => {
    const daemon = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to feature/login' }));
    const confirm = within(await dialog());
    expect(confirm.getByText('Switch main to feature/login?')).toBeInTheDocument();
    expect(confirm.getByText('Repository').nextElementSibling).toHaveTextContent('acme /work/acme');
    expect(confirm.getByText('Branch').nextElementSibling).toHaveTextContent('main → feature/login');
    expect(confirm.getByText('Worktree').nextElementSibling).toHaveTextContent('your checkout /work/acme');
    answer('Cancel');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(daemon.calls('git.switch')).toEqual([]);
  });

  it('switches once confirmed, and reads the branches again', async () => {
    const daemon = await mount();
    const before = daemon.calls('git.branches').length;
    fireEvent.click(screen.getByRole('button', { name: 'Switch to feature/login' }));
    await dialog();
    answer('Switch to feature/login');
    await waitFor(() => expect(daemon.calls('git.switch')).toHaveLength(1));
    expect(daemon.calls('git.switch')[0]![1]).toEqual({ workspace: WORKSPACE, repo: '.', branch: 'feature/login' });
    await waitFor(() => expect(daemon.calls('git.branches').length).toBeGreaterThan(before));
  });

  it('deletes with the branch named, and says when its commits are not merged', async () => {
    const daemon = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Delete feature/login' }));
    const confirm = within(await dialog());
    expect(confirm.getByText('Delete branch feature/login?')).toBeInTheDocument();
    // Its tip is not in main's history, so the confirm warns, and the daemon is told it did.
    expect(confirm.getByText(/commits not merged into main/)).toBeInTheDocument();
    answer('Delete feature/login');
    await waitFor(() => expect(daemon.calls('git.branchDelete')).toHaveLength(1));
    expect(daemon.calls('git.branchDelete')[0]![1]).toEqual({ workspace: WORKSPACE, repo: '.', branch: 'feature/login', confirm: { branch: 'feature/login', unmerged: true } });
  });

  it('asks again, with what is true now, when the repository changed under a delete', async () => {
    let tries = 0;
    const daemon = await mount({
      'git.branchDelete': () => (++tries === 1
        ? { ok: false as const, status: 409, error: 'The branch changed.', data: { code: 'confirm_stale', confirmStale: { field: 'unmerged', shown: true, now: false } } }
        : ok({ repo: REPO_STATE })),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete feature/login' }));
    await dialog();
    answer('Delete feature/login');
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent(/It changed since you looked/));
    expect(screen.getByRole('dialog')).toHaveTextContent('merged into main');
    answer('Delete feature/login');
    await waitFor(() => expect(daemon.calls('git.branchDelete')).toHaveLength(2));
    expect(daemon.calls('git.branchDelete')[1]![1]).toMatchObject({ confirm: { branch: 'feature/login', unmerged: false } });
  });

  it('names the remote and branch a pull and a push act on', async () => {
    const daemon = await mount();
    fireEvent.click(screen.getByRole('button', { name: /Pull/ }));
    let confirm = within(await dialog());
    expect(confirm.getByText('Pull origin/main into main?')).toBeInTheDocument();
    expect(confirm.getByText('Branch').nextElementSibling).toHaveTextContent('1 commit behind origin/main');
    answer('Pull from origin');
    await waitFor(() => expect(daemon.calls('git.pull')).toHaveLength(1));
    expect(daemon.calls('git.pull')[0]![1]).toEqual({ workspace: WORKSPACE, repo: '.', confirm: { remote: 'origin', branch: 'main' } });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /Push/ }));
    confirm = within(await dialog());
    expect(confirm.getByText('Push main to origin/main?')).toBeInTheDocument();
    expect(confirm.getByText('Branch').nextElementSibling).toHaveTextContent('2 commits ahead of origin/main');
    answer('Push to origin');
    await waitFor(() => expect(daemon.calls('git.push')).toHaveLength(1));
    expect(daemon.calls('git.push')[0]![1]).toMatchObject({ confirm: { remote: 'origin', branch: 'main' } });
  });

  it('confirms a stash pop and a drop by the stash’s name', async () => {
    const daemon = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Pop stash@{0}' }));
    expect(within(await dialog()).getByText('Pop stash@{0}?')).toBeInTheDocument();
    answer('Pop stash@{0}');
    await waitFor(() => expect(daemon.calls('git.stashPop')).toHaveLength(1));
    expect(daemon.calls('git.stashPop')[0]![1]).toEqual({ workspace: WORKSPACE, repo: '.', stash: 'stash@{0}' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Drop stash@{0}' }));
    expect(within(await dialog()).getByText('Drop stash@{0}?')).toBeInTheDocument();
    answer('Cancel');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(daemon.calls('git.stashDrop')).toEqual([]);
  });

  it('shows git’s own refusal in a banner, in git’s words', async () => {
    await mount({ 'git.switch': () => ({ ok: false as const, status: 500, error: 'Your local changes would be overwritten.', data: { code: 'git_failed' } }) });
    fireEvent.click(screen.getByRole('button', { name: 'Switch to feature/login' }));
    await dialog();
    answer('Switch to feature/login');
    await waitFor(() => expect(screen.getByText('Your local changes would be overwritten.')).toBeInTheDocument());
    expect(screen.getAllByText(/Git could not switch away from main/).length).toBeGreaterThan(0);
  });
});

describe('a refused switch or delete', () => {
  const held = {
    ok: false as const, status: 409, error: 'A run holds this branch.',
    data: { code: 'landing_branch_held', landingBranchHeld: { sessionId: 's1', runId: 'r7', repo: '.', branch: 'main' } },
  };

  it('says which run holds the branch, in words, and opens it from a link', async () => {
    await mount({ 'git.switch': () => held });
    const host = daemonHost(WORKSPACE);
    const open = vi.spyOn(host, 'open').mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to feature/login' }));
    await dialog();
    answer('Switch to feature/login');
    await waitFor(() => expect(screen.getByText('Can’t switch away from main main')).toBeInTheDocument());
    const refusal = screen.getByRole('dialog');
    expect(refusal).toHaveTextContent('Run r7 of “Ship SSO” is live, and it lands on main.');
    fireEvent.click(within(refusal).getByRole('button', { name: 'Open run' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('s1'));
    // A run with no one task to show opens on its planner conversation.
    expect(activeTab(store.getSnapshot().layout.groups[0])?.kind).toBe('planner');
  });
});

describe('the commit graph', () => {
  async function openGraph() {
    act(() => store.api.openTab({ kind: 'commits', id: commitsTabId('.'), title: 'Commits' }));
    return screen.findByRole('list', { name: 'Commits' });
  }

  it('draws a row per commit with its refs, and marks Ordewell’s integration branch as Ordewell’s', async () => {
    await mount();
    const list = within(await openGraph());
    const head = await list.findByRole('button', { name: /Commit aaaaaaa: Merge: Wire SSO/ });
    expect(within(head).getByText('HEAD')).toBeInTheDocument();
    expect(within(head).getByText('main')).toBeInTheDocument();
    expect(within(head).getByText('origin/main')).toBeInTheDocument();
    const root = list.getByRole('button', { name: /Commit fffffff: Add the login button/ });
    expect(within(root).getByText('Ordewell · ordewell/r7/integration')).toBeInTheDocument();
    expect(within(root).getByText('v1.0')).toBeInTheDocument();
  });

  it('links a commit landed from a task to that task', async () => {
    await mount();
    const list = within(await openGraph());
    const head = await list.findByRole('button', { name: /Commit aaaaaaa/ });
    await waitFor(() => expect(within(head).getByText('task #1')).toBeInTheDocument());
    // The root commit is on the integration branch too, but no landed task has its title.
    expect(within(list.getByRole('button', { name: /Commit fffffff/ })).queryByText(/task #/)).toBeNull();
  });

  it('pages the history by cursor', async () => {
    const pages: Array<RouteParams | undefined> = [];
    await mount({
      'git.log': (params) => {
        pages.push(params);
        return params?.cursor
          ? ok({ repo: '.', ref: 'HEAD', commits: [commit('9', [], 'Initial commit')], cursor: null })
          : ok({ repo: '.', ref: 'HEAD', commits: [commit('a', ['9'], 'Second')], cursor: 'next-page' });
      },
    });
    const list = within(await openGraph());
    await list.findByRole('button', { name: /Second/ });
    fireEvent.click(list.getByRole('button', { name: 'Load more' }));
    await list.findByRole('button', { name: /Initial commit/ });
    expect(pages.some((p) => p?.cursor === 'next-page')).toBe(true);
    expect(list.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('says so for a repository with no commits', async () => {
    await mount({ 'git.log': ok({ repo: '.', ref: 'HEAD', commits: [], cursor: null }) });
    await openGraph();
    expect(await screen.findByText('This repository has no commits yet.')).toBeInTheDocument();
  });

  it('shows git’s error text in place of the graph', async () => {
    await mount({ 'git.log': () => ({ ok: false as const, status: 500, error: 'fatal: bad revision', data: { code: 'git_failed' } }) });
    act(() => store.api.openTab({ kind: 'commits', id: commitsTabId('.', 'nope'), title: 'Commits: nope' }));
    expect(await screen.findByText('fatal: bad revision')).toBeInTheDocument();
  });

  it('lists a selected commit’s files, and a file opens in a diff tab', async () => {
    const PATCH = ['diff --git a/src/sso.ts b/src/sso.ts', '--- a/src/sso.ts', '+++ b/src/sso.ts', '@@ -1,3 +1,3 @@', ' export function login() {', '-  return null;', '+  return okta();', ' }', ''].join('\n');
    const daemon = await mount({
      'git.show': (params) => ok({
        commit: { ...LOG[0]!, body: 'Why it changed.' },
        files: [{ path: 'src/sso.ts', status: 'M', added: 1, removed: 1 }, { path: 'logo.png', status: 'A', added: null, removed: null }],
        ...(params?.path ? { patch: PATCH } : {}),
      }),
    });
    const list = within(await openGraph());
    fireEvent.click(await list.findByRole('button', { name: /Commit aaaaaaa/ }));
    const detail = within(await screen.findByRole('complementary', { name: 'Commit' }));
    expect(await detail.findByText('Why it changed.')).toBeInTheDocument();
    expect(detail.getByText('binary')).toBeInTheDocument();
    fireEvent.click(detail.getByRole('button', { name: /src\/sso\.ts/ }));
    await waitFor(() => expect(diffEditors).toHaveLength(1));
    expect(daemon.calls('git.show').some(([p]) => p?.path === 'src/sso.ts' && p.sha === sha('a'))).toBe(true);
    expect(diffEditors[0]!.options.modified.text).toContain('okta()');
    expect(screen.getByRole('tab', { name: /sso\.ts @ aaaaaaa/ })).toBeInTheDocument();
  });
});
