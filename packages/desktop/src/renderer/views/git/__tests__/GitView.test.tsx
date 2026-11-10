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

async function mount(extra: Answers = {}, branches: unknown = BRANCHES, ready: string | RegExp = 'Switch to feature/login') {
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
  await screen.findByRole('button', { name: ready });
  return daemon;
}

/** An answer the test hands over when it chooses, to hold a read in flight. */
const deferred = () => {
  let settle!: (result: ReturnType<typeof ok>) => void;
  const promise = new Promise<ReturnType<typeof ok>>((resolve) => { settle = resolve; });
  return { promise, settle };
};

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

describe('the Branches and History views', () => {
  const views = () => within(screen.getByRole('group', { name: 'Git sidebar view' }));

  it('draws no section heading of its own: the repository row is the only heading, on Branches and History alike', async () => {
    await mount();
    expect(screen.queryByRole('heading', { name: 'Branches' })).toBeNull();
    expect(screen.queryByText('Branches', { selector: '.frame-section-title, .frame-section-title *' })).toBeNull();
    expect(document.querySelector('.frame-section-head')).toBeNull();
    fireEvent.click(views().getByRole('button', { name: 'History' }));
    expect(await screen.findByRole('list', { name: 'History' })).toBeInTheDocument();
    expect(document.querySelector('.frame-section-head')).toBeNull();
  });

  it('starts on Branches, and History keeps the branch and sync controls while it reads the history once', async () => {
    const daemon = await mount();
    expect(views().getByRole('button', { name: 'Branches' })).toHaveAttribute('aria-pressed', 'true');
    expect(views().getByRole('button', { name: 'History' })).toHaveAttribute('aria-pressed', 'false');
    expect(daemon.calls('git.log')).toHaveLength(0);
    fireEvent.click(views().getByRole('button', { name: 'History' }));
    expect(views().getByRole('button', { name: 'History' })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByRole('list', { name: 'History' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Switch to feature/login' })).toBeNull();
    expect(screen.getByRole('group', { name: /^Sync/ })).toBeInTheDocument();
    // The history is here in the sidebar: there is no second, centre graph to open.
    expect(screen.queryByRole('button', { name: 'Show the commit graph' })).toBeNull();
    expect(daemon.calls('git.log')).toHaveLength(1);
  });

  it('keeps the view across an activity switch, and going back and forth reads the history no more', async () => {
    const daemon = await mount();
    fireEvent.click(views().getByRole('button', { name: 'History' }));
    await screen.findByRole('button', { name: /Commit aaaaaaa/ });
    act(() => store.api.showActivity('explorer'));
    act(() => store.api.showActivity('git'));
    expect(await screen.findByRole('list', { name: 'History' })).toBeInTheDocument();
    expect(views().getByRole('button', { name: 'History' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(views().getByRole('button', { name: 'Branches' }));
    expect(screen.getByRole('button', { name: 'Switch to feature/login' })).toBeInTheDocument();
    fireEvent.click(views().getByRole('button', { name: 'History' }));
    expect(screen.getByRole('button', { name: /Commit aaaaaaa/ })).toBeInTheDocument();
    expect(daemon.calls('git.log')).toHaveLength(1);
  });

  it('draws the graph’s lanes beside each subject and its refs, and opens a commit in a tab of its own that its files open beside', async () => {
    await mount({
      'git.show': (params) => ok({
        commit: { ...LOG[0]!, body: 'Why it changed.' },
        files: [{ path: 'src/sso.ts', status: 'M', added: 1, removed: 1 }],
        ...(params?.path ? { patch: 'diff --git a/src/sso.ts b/src/sso.ts\n' } : {}),
      }),
    });
    fireEvent.click(views().getByRole('button', { name: 'History' }));
    const row = await screen.findByRole('button', { name: /^Commit aaaaaaa: Merge: Wire SSO/ });
    expect(row.querySelector('svg.git-lanes circle')).not.toBeNull();
    // The row names the short sha; its tooltip has the full one, to read or compare (design W11).
    expect(row).toHaveAttribute('title', expect.stringContaining(`${sha('a')} · Ada`));
    expect(within(row).getByText('main')).toHaveAttribute('title', expect.stringMatching(/^main: /));
    expect(within(row).queryByText('HEAD')).not.toBeInTheDocument();

    fireEvent.click(row);
    expect(await screen.findByRole('tab', { name: /Commit aaaaaaa/ })).toBeInTheDocument();
    expect(row).toHaveAttribute('aria-current', 'true');
    const detail = within(await screen.findByRole('complementary', { name: 'Commit' }));
    expect(await detail.findByText('Why it changed.')).toBeInTheDocument();
    // The subject leads; the sha, author and a readable date are its own supporting line, and a file names itself before its folder.
    expect(detail.getByRole('heading', { name: 'Merge: Wire SSO' })).toBeInTheDocument();
    expect(detail.getByText('aaaaaaa')).toBeInTheDocument();
    expect(detail.getByText('Ada')).toBeInTheDocument();
    const file = detail.getByRole('button', { name: /sso\.ts/ });
    expect(file).toHaveAttribute('title', 'src/sso.ts');
    expect(within(file).getByText('sso.ts')).toBeInTheDocument();
    expect(within(file).getByText('src')).toBeInTheDocument();
    fireEvent.click(file);
    expect(await screen.findByRole('tab', { name: /sso\.ts @ aaaaaaa/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Commit aaaaaaa/ })).toBeInTheDocument();
  });

  it('reads one page, then the next only when asked, and offers no more at the root', async () => {
    const daemon = await mount({
      'git.log': (params) => ok(params?.cursor
        ? { repo: '.', ref: 'HEAD', commits: [commit('f', [], 'Add the login button')], cursor: null }
        : { repo: '.', ref: 'HEAD', commits: [commit('a', ['f'], 'Merge: Wire SSO', ['HEAD', 'main'])], cursor: sha('f') }),
    });
    fireEvent.click(views().getByRole('button', { name: 'History' }));
    await screen.findByRole('button', { name: /Commit aaaaaaa/ });
    expect(daemon.calls('git.log')[0]![0]).toMatchObject({ limit: '50' });
    expect(daemon.calls('git.log')[0]![0]).not.toHaveProperty('cursor');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('button', { name: /Commit fffffff/ })).toBeInTheDocument();
    expect(daemon.calls('git.log')[1]![0]).toMatchObject({ cursor: sha('f'), limit: '50' });
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(daemon.calls('git.log')).toHaveLength(2);
  });

  it('says when the history cannot be read and reads it again on Try again', async () => {
    let fail = true;
    const daemon = await mount({
      'git.log': () => (fail
        ? { ok: false as const, status: 500, error: 'fatal: not a git repository', data: { code: 'git_failed' } }
        : ok({ repo: '.', ref: 'HEAD', commits: LOG, cursor: null })),
    });
    fireEvent.click(views().getByRole('button', { name: 'History' }));
    expect(await screen.findByText('fatal: not a git repository')).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /Commit aaaaaaa/ })).toBeInTheDocument();
    expect(screen.queryByText('fatal: not a git repository')).not.toBeInTheDocument();
    expect(daemon.calls('git.log')).toHaveLength(2);
  });

  it('shows one ref chip with the rest counted, a branch and its remote as one, and names everything', async () => {
    const refs = ['HEAD', 'release/2.4', 'feature/sso', 'origin/feature/sso', 'origin/main', 'v2.0'];
    const branches = { ...BRANCHES, local: [...BRANCHES.local, branch('release/2.4', { sha: sha('a') }), branch('feature/sso', { sha: sha('a') })], remote: [branch('origin/main'), branch('origin/feature/sso')] };
    await mount({ 'git.log': ok({ repo: '.', ref: 'HEAD', commits: [{ ...LOG[0]!, refs }], cursor: null }) }, branches);
    fireEvent.click(views().getByRole('button', { name: 'History' }));
    const row = await screen.findByRole('button', { name: /^Commit aaaaaaa: Merge: Wire SSO/ });
    // release/2.4 leads (no branch here is checked out at this commit); feature/sso folds in its remote, so feature/sso, origin/main and v2.0 are the +3.
    expect(row.querySelectorAll('.git-hrow-refs .git-chip:not(.git-chip-more)')).toHaveLength(1);
    expect(within(row).getByText('release/2.4')).toBeInTheDocument();
    expect(within(row).getByText('+3')).toBeInTheDocument();
    expect(row).toHaveAccessibleName(/by Ada, .+ ago, refs release\/2\.4, feature\/sso, origin\/feature\/sso, origin\/main, v2\.0$/);
    expect(row).toHaveAttribute('title', expect.stringContaining('release/2.4, feature/sso, origin/feature/sso, origin/main, v2.0'));
  });

  it('marks a branch that its remote-tracking ref shares the commit with, and leads with the checked-out branch', async () => {
    await mount();
    fireEvent.click(views().getByRole('button', { name: 'History' }));
    const row = await screen.findByRole('button', { name: /^Commit aaaaaaa: Merge: Wire SSO/ });
    const chip = within(row).getByText('main');
    expect(chip.querySelector('.git-chip-mark')).not.toBeNull();
    expect(chip).toHaveAttribute('title', expect.stringContaining('Also on origin/main'));
    expect(within(row).queryByText(/^\+\d/)).toBeNull();
  });

  it('orders the metadata age, author, then the sha that the ellipsis cuts last', async () => {
    await mount();
    fireEvent.click(views().getByRole('button', { name: 'History' }));
    const row = await screen.findByRole('button', { name: /^Commit aaaaaaa: Merge: Wire SSO/ });
    expect(row.querySelector('.git-hrow-info')?.textContent).toMatch(/^\d+(mo|d|h|m) · Ada · aaaaaaa$/);
  });

  it('says in words, not only by a fade, that the lanes are cut off', async () => {
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 5, height: 44, x: 0, y: 0, top: 0, left: 0, right: 5, bottom: 44, toJSON: () => ({}) });
    try {
      await mount();
      fireEvent.click(views().getByRole('button', { name: 'History' }));
      const list = await screen.findByRole('list', { name: 'History' });
      await waitFor(() => expect(list).toHaveClass('git-hlist-clipped'));
      expect(list).toHaveAccessibleDescription(/further lanes are cut off/);
    } finally { rect.mockRestore(); }
  });

  it('says a repository with no commits has no history', async () => {
    await mount({ 'git.log': ok({ repo: '.', ref: 'HEAD', commits: [], cursor: null }) });
    fireEvent.click(views().getByRole('button', { name: 'History' }));
    expect(await screen.findByText('No commits yet')).toBeInTheDocument();
    // One line (design S2): no second sentence under the title.
    expect(screen.queryByText(/Commit something/)).toBeNull();
  });

  it('reads the history again once a fetch moves a branch, and drops the answer that read overtook', async () => {
    const first = deferred();
    let reads = 0;
    const moved = { ...BRANCHES, remote: [branch('origin/main', { sha: sha('f') })] };
    let branches: unknown = BRANCHES;
    const daemon = await mount({
      'git.branches': () => ok(branches),
      'git.fetch': ok({ repo: REPO_STATE }),
      'git.log': () => (++reads === 1 ? first.promise : ok({ repo: '.', ref: 'HEAD', commits: [commit('a', ['f'], 'After the fetch', ['HEAD', 'main'])], cursor: null })),
    });
    fireEvent.click(views().getByRole('button', { name: 'History' }));
    await waitFor(() => expect(daemon.calls('git.log')).toHaveLength(1));
    branches = moved;
    fireEvent.click(within(screen.getByRole('group', { name: /^Sync/ })).getByRole('button', { name: /^Fetch/ }));
    expect(await screen.findByRole('button', { name: /^Commit aaaaaaa: After the fetch/ })).toBeInTheDocument();
    await act(async () => { first.settle(ok({ repo: '.', ref: 'HEAD', commits: LOG, cursor: null })); });
    expect(screen.getByRole('button', { name: /^Commit aaaaaaa: After the fetch/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Commit fffffff/ })).not.toBeInTheDocument();
    expect(daemon.calls('git.log')).toHaveLength(2);
  });

  it('drops a page that a read again overtook', async () => {
    const page = deferred();
    let branches: unknown = BRANCHES;
    const daemon = await mount({
      'git.branches': () => ok(branches),
      'git.fetch': ok({ repo: REPO_STATE }),
      'git.log': (params) => (params?.cursor
        ? page.promise
        : ok({ repo: '.', ref: 'HEAD', commits: [commit('a', ['f'], 'Merge: Wire SSO', ['HEAD', 'main'])], cursor: sha('f') })),
    });
    fireEvent.click(views().getByRole('button', { name: 'History' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(daemon.calls('git.log')).toHaveLength(2));
    branches = { ...BRANCHES, remote: [branch('origin/main', { sha: sha('f') })] };
    fireEvent.click(within(screen.getByRole('group', { name: /^Sync/ })).getByRole('button', { name: /^Fetch/ }));
    await waitFor(() => expect(daemon.calls('git.log')).toHaveLength(3));
    await act(async () => { page.settle(ok({ repo: '.', ref: 'HEAD', commits: [commit('9', [], 'A stale page')], cursor: null })); });
    expect(screen.queryByRole('button', { name: /A stale page/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load more' })).not.toHaveAttribute('aria-busy');
  });

  it('keeps a page in flight when the view is switched away and back', async () => {
    const page = deferred();
    const daemon = await mount({
      'git.log': (params) => (params?.cursor
        ? page.promise
        : ok({ repo: '.', ref: 'HEAD', commits: [commit('a', ['f'], 'Merge: Wire SSO', ['HEAD', 'main'])], cursor: sha('f') })),
    });
    fireEvent.click(views().getByRole('button', { name: 'History' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    fireEvent.click(views().getByRole('button', { name: 'Branches' }));
    fireEvent.click(views().getByRole('button', { name: 'History' }));
    await act(async () => { page.settle(ok({ repo: '.', ref: 'HEAD', commits: [commit('f', [], 'Add the login button')], cursor: null })); });
    expect(await screen.findByRole('button', { name: /Commit fffffff/ })).toBeInTheDocument();
    expect(daemon.calls('git.log')).toHaveLength(2);
  });

  it('reads nothing again when a fetch moves no branch', async () => {
    const daemon = await mount({ 'git.fetch': ok({ repo: REPO_STATE }) });
    fireEvent.click(views().getByRole('button', { name: 'History' }));
    await screen.findByRole('button', { name: /Commit aaaaaaa/ });
    const before = daemon.calls('git.branches').length;
    fireEvent.click(within(screen.getByRole('group', { name: /^Sync/ })).getByRole('button', { name: /^Fetch/ }));
    await waitFor(() => expect(daemon.calls('git.branches').length).toBeGreaterThan(before));
    expect(daemon.calls('git.log')).toHaveLength(1);
  });

  it('reads a detached checkout’s history again only when its head or a branch moved', async () => {
    const detached = { ...BRANCHES, current: null, detached: true, local: BRANCHES.local.map((b) => ({ ...b, current: false })) };
    let head = sha('a');
    const daemon = await mount({
      'git.repos': () => ok({ repos: [{ ...REPO_STATE, branch: null, detached: true, head }] }),
      'git.fetch': () => ok({ repo: { ...REPO_STATE, branch: null, detached: true, head } }),
    }, detached, 'Switch to main');
    fireEvent.click(views().getByRole('button', { name: 'History' }));
    await screen.findByRole('button', { name: /Commit aaaaaaa/ });
    const fetch = (): void => { fireEvent.click(within(screen.getByRole('group', { name: /^Sync/ })).getByRole('button', { name: /^Fetch/ })); };
    let before = daemon.calls('git.branches').length;
    fetch();
    await waitFor(() => expect(daemon.calls('git.branches').length).toBeGreaterThan(before));
    expect(daemon.calls('git.log')).toHaveLength(1);

    head = sha('9');
    before = daemon.calls('git.branches').length;
    fetch();
    await waitFor(() => expect(daemon.calls('git.log')).toHaveLength(2));
    expect(daemon.calls('git.branches').length).toBeGreaterThan(before);
  });

  it('reads a tag that moved no branch in on an explicit Refresh, keeping the rows on screen meanwhile', async () => {
    const later = deferred();
    let reads = 0;
    const daemon = await mount({
      'git.log': () => (++reads === 1 ? ok({ repo: '.', ref: 'HEAD', commits: LOG, cursor: null }) : later.promise),
    });
    fireEvent.click(views().getByRole('button', { name: 'History' }));
    const row = await screen.findByRole('button', { name: /^Commit aaaaaaa: Merge: Wire SSO/ });
    expect(row).not.toHaveAccessibleName(/v2\.0/);
    fireEvent.click(screen.getByRole('button', { name: 'Reload branches and history' }));
    await waitFor(() => expect(daemon.calls('git.log')).toHaveLength(2));
    expect(screen.getByRole('button', { name: /^Commit aaaaaaa: Merge: Wire SSO/ })).toBeInTheDocument();
    await act(async () => { later.settle(ok({ repo: '.', ref: 'HEAD', commits: [{ ...LOG[0]!, refs: [...LOG[0]!.refs, 'v2.0'] }, LOG[1]!], cursor: null })); });
    // One chip leads; a new tag is counted in the +N and named in the row's name and tooltip.
    const tagged = screen.getByRole('button', { name: /^Commit aaaaaaa: Merge: Wire SSO/ });
    expect(tagged).toHaveAccessibleName(/v2\.0/);
    expect(within(tagged).getByText('+1')).toBeInTheDocument();
  });

  it('holds Load more while the history is read again, and while that read failed, so a click is never lost', async () => {
    const later = deferred();
    let reads = 0;
    const daemon = await mount({
      'git.log': (params) => {
        if (params?.cursor) return ok({ repo: '.', ref: 'HEAD', commits: [commit('f', [], 'Add the login button')], cursor: null });
        reads += 1;
        if (reads === 2) return later.promise;
        if (reads === 3) return { ok: false as const, status: 500, error: 'fatal: bad object', data: { code: 'git_failed' } };
        return ok({ repo: '.', ref: 'HEAD', commits: [commit('a', ['f'], 'Merge: Wire SSO', ['HEAD', 'main'])], cursor: sha('f') });
      },
    });
    fireEvent.click(views().getByRole('button', { name: 'History' }));
    expect(await screen.findByRole('button', { name: 'Load more' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Reload branches and history' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeDisabled());
    await act(async () => { later.settle(ok({ repo: '.', ref: 'HEAD', commits: [commit('a', ['f'], 'Merge: Wire SSO', ['HEAD', 'main'])], cursor: sha('f') })); });
    expect(screen.getByRole('button', { name: 'Load more' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Reload branches and history' }));
    expect(await screen.findByText('fatal: bad object')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('button', { name: /Commit fffffff/ })).toBeInTheDocument();
    expect(daemon.calls('git.log').filter(([params]) => params?.cursor)).toHaveLength(1);
  });

  it('keeps each repository’s history and pick its own, and drops a late answer for the one no longer shown', async () => {
    const lib = deferred();
    const libBranches = { ...BRANCHES, repo: 'libs/ui', local: [branch('main', { current: true, sha: sha('9') })], ordewell: [], remote: [], stashes: [], worktrees: [] };
    const daemon = await mount({
      'git.repos': ok({ repos: [REPO_STATE, { ...REPO_STATE, repo: 'libs/ui', head: sha('9') }] }),
      'git.branches': (params) => ok(params?.repo === 'libs/ui' ? libBranches : BRANCHES),
      'git.log': (params) => (params?.repo === 'libs/ui' ? lib.promise : ok({ repo: '.', ref: 'HEAD', commits: LOG, cursor: null })),
    });
    fireEvent.click(views().getByRole('button', { name: 'History' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Commit fffffff: Add the login button/ }));
    expect(screen.getByRole('button', { name: /^Commit fffffff: Add the login button/ })).toHaveAttribute('aria-current', 'true');

    const picker = await screen.findByRole('combobox', { name: 'Repository' });
    fireEvent.change(picker, { target: { value: 'libs/ui' } });
    await waitFor(() => expect(daemon.calls('git.log').some(([p]) => p?.repo === 'libs/ui')).toBe(true));
    expect(await screen.findByText('Loading the history…')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'History' })).not.toBeInTheDocument();

    fireEvent.change(picker, { target: { value: '.' } });
    expect(await screen.findByRole('button', { name: /^Commit fffffff: Add the login button/ })).toHaveAttribute('aria-current', 'true');
    await act(async () => { lib.settle(ok({ repo: 'libs/ui', ref: 'HEAD', commits: [commit('9', [], 'Start the UI kit', ['HEAD', 'main'])], cursor: null })); });
    expect(screen.queryByRole('button', { name: /Start the UI kit/ })).not.toBeInTheDocument();
    expect(daemon.calls('git.log').filter(([p]) => p?.repo === '.')).toHaveLength(1);

    fireEvent.change(picker, { target: { value: 'libs/ui' } });
    expect(await screen.findByRole('button', { name: /^Commit 9999999: Start the UI kit/ })).toBeInTheDocument();
    expect(daemon.calls('git.log').filter(([p]) => p?.repo === 'libs/ui')).toHaveLength(1);
  });
});

describe('browsing a branch in the sidebar', () => {
  const views = () => within(screen.getByRole('group', { name: 'Git sidebar view' }));
  const side = () => within(screen.getByRole('navigation', { name: 'Git' }));
  /** The centre's tabs and which one is shown: what browsing must never touch. */
  const centre = () => store.getSnapshot().layout.groups.map((g) => ({ tabs: g.tabs.map((t) => t.key), active: g.active }));
  const FEATURE_LOG = [commit('b', ['f'], 'Sign in with a magic link', ['feature/login']), LOG[1]!];
  const byRef = (params: RouteParams | undefined) => ok({
    repo: '.', ref: params?.ref ?? 'HEAD', commits: params?.ref === 'feature/login' ? FEATURE_LOG : LOG, cursor: null,
  });

  it('shows a local branch’s history in the sidebar, read at that branch, and opens no tab', async () => {
    const daemon = await mount({ 'git.log': byRef });
    const before = centre();
    fireEvent.click(screen.getByRole('button', { name: 'feature/login' }));
    expect(views().getByRole('button', { name: 'History' })).toHaveAttribute('aria-pressed', 'true');
    expect(await side().findByRole('button', { name: /^Commit bbbbbbb: Sign in with a magic link/ })).toBeInTheDocument();
    expect(daemon.calls('git.log')).toHaveLength(1);
    expect(daemon.calls('git.log')[0]![0]).toMatchObject({ ref: 'feature/login', limit: '50' });
    expect(centre()).toEqual(before);
  });

  it('browses an Ordewell branch, its integration branch and a remote one read-only, with nothing to switch to or delete', async () => {
    const daemon = await mount({ 'git.log': byRef });
    const before = centre();
    const scope = (): HTMLElement => side().getByRole('combobox', { name: 'History of' });
    fireEvent.click(screen.getByRole('button', { name: 'origin/main' }));
    expect(scope()).toHaveValue('origin/main');
    expect(side().getByText('A remote branch, read-only here.')).toBeInTheDocument();
    await side().findByRole('button', { name: /Commit aaaaaaa/ });

    fireEvent.click(views().getByRole('button', { name: 'Branches' }));
    fireEvent.click(screen.getByRole('button', { name: 'ordewell/r7/integration, integration' }));
    expect(scope()).toHaveValue('ordewell/r7/integration');
    expect(side().getByText('Ordewell’s branch, read-only here.')).toBeInTheDocument();
    expect(side().queryByRole('button', { name: /^(Switch to|Delete) / })).toBeNull();

    fireEvent.click(views().getByRole('button', { name: 'Branches' }));
    fireEvent.click(screen.getByRole('button', { name: 'ordewell/r7/t3, read-only' }));
    expect(scope()).toHaveValue('ordewell/r7/t3');
    await waitFor(() => expect(daemon.calls('git.log').map(([p]) => p?.ref)).toEqual(['origin/main', 'ordewell/r7/integration', 'ordewell/r7/t3']));
    expect(daemon.calls('git.switch')).toHaveLength(0);
    expect(centre()).toEqual(before);
  });

  it('names the checkout apart from the branch browsed, and keeps Fetch, Pull and Push on the checkout', async () => {
    const daemon = await mount({ 'git.log': byRef });
    fireEvent.click(screen.getByRole('button', { name: 'feature/login' }));
    await side().findByRole('button', { name: /Commit bbbbbbb/ });
    expect(within(screen.getByRole('group', { name: 'Your checkout' })).getByText('main')).toBeInTheDocument();
    expect(side().getByText('Browsing only: your checkout stays on main.')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('group', { name: /^Sync/ })).getByRole('button', { name: /^Pull/ }));
    expect(within(await dialog()).getAllByText(/origin/).length).toBeGreaterThan(0);
    answer(/^Pull/);
    await waitFor(() => expect(daemon.calls('git.pull')).toHaveLength(1));
    expect(daemon.calls('git.pull')[0]![1]).toMatchObject({ confirm: { remote: 'origin', branch: 'main' } });
    expect(daemon.calls('git.switch')).toHaveLength(0);
  });

  it('marks the branch shown in History in the list, apart from the checked-out one', async () => {
    await mount({ 'git.log': byRef });
    fireEvent.click(screen.getByRole('button', { name: 'feature/login' }));
    fireEvent.click(views().getByRole('button', { name: 'Branches' }));
    expect(screen.getByRole('button', { name: 'feature/login' })).toHaveAccessibleDescription('Shown in History');
    expect(screen.getByRole('button', { name: 'main' })).not.toHaveAccessibleDescription('Shown in History');
    expect(screen.getByRole('button', { name: 'main' }).closest('li')).toHaveAttribute('aria-current', 'true');
    fireEvent.click(views().getByRole('button', { name: 'History' }));
    expect(await side().findByRole('list', { name: 'History of feature/login' })).toBeInTheDocument();
  });

  it('changes or resets what History shows from the sidebar, and a history already read is not read again', async () => {
    const daemon = await mount({ 'git.log': byRef });
    fireEvent.click(screen.getByRole('button', { name: 'feature/login' }));
    await side().findByRole('button', { name: /Commit bbbbbbb/ });
    fireEvent.click(side().getByRole('button', { name: 'Show your checkout’s history' }));
    expect(side().getByRole('combobox', { name: 'History of' })).toHaveValue('');
    expect(await side().findByRole('button', { name: /Commit aaaaaaa/ })).toBeInTheDocument();
    expect(side().queryByRole('button', { name: 'Show your checkout’s history' })).toBeNull();
    fireEvent.change(side().getByRole('combobox', { name: 'History of' }), { target: { value: 'feature/login' } });
    expect(await side().findByRole('button', { name: /Commit bbbbbbb/ })).toBeInTheDocument();
    expect(daemon.calls('git.log').map(([p]) => p?.ref)).toEqual(['feature/login', undefined]);
  });

  it('shows the checked-out branch as the checkout’s own history', async () => {
    const daemon = await mount({ 'git.log': byRef });
    fireEvent.click(screen.getByRole('button', { name: 'main' }));
    expect(side().getByRole('combobox', { name: 'History of' })).toHaveValue('');
    await side().findByRole('button', { name: /Commit aaaaaaa/ });
    expect(daemon.calls('git.log')[0]![0]).not.toHaveProperty('ref');
  });

  it('opens the checkout’s history in the sidebar from the palette, with Git closed, and opens no tab', async () => {
    const daemon = await mount({ 'git.log': byRef });
    fireEvent.click(screen.getByRole('button', { name: 'feature/login' }));
    await side().findByRole('button', { name: /Commit bbbbbbb/ });
    act(() => store.api.showActivity('explorer'));
    expect(screen.queryByRole('navigation', { name: 'Git' })).toBeNull();
    const before = centre();
    act(() => store.api.runCommand('git.showGraph'));
    expect(store.getSnapshot().layout.activity).toBe('git');
    expect(views().getByRole('button', { name: 'History' })).toHaveAttribute('aria-pressed', 'true');
    expect(side().getByRole('combobox', { name: 'History of' })).toHaveValue('');
    expect(await side().findByRole('button', { name: /Commit aaaaaaa/ })).toBeInTheDocument();
    expect(daemon.calls('git.log').map(([p]) => p?.ref)).toEqual(['feature/login', undefined]);
    expect(centre()).toEqual(before);
  });

  it('opens History from the palette in a window that has not shown Git yet', async () => {
    const daemon = fakeDaemon({
      'git.repos': ok({ repos: [REPO_STATE] }),
      'git.branches': ok(BRANCHES),
      'git.log': ok({ repo: '.', ref: 'HEAD', commits: LOG, cursor: null }),
      'sessions.list': ok([]),
    });
    store = new FrameStore({ workspace: WORKSPACE, platform: 'linux' });
    offs.push(registerFrameCommands(store), registerSidebar(store.api), registerGraph(store.api), registerDiff(store.api));
    render(<FrameProvider value={store}><Frame daemon={CONNECTED} /></FrameProvider>);
    const before = centre();
    act(() => store.api.runCommand('git.showGraph'));
    expect(await side().findByRole('button', { name: /Commit aaaaaaa/ })).toBeInTheDocument();
    expect(views().getByRole('button', { name: 'History' })).toHaveAttribute('aria-pressed', 'true');
    expect(daemon.calls('git.log')).toHaveLength(1);
    expect(centre()).toEqual(before);
  });

  it('keeps the branch browsed across an activity switch, reading it no more', async () => {
    const daemon = await mount({ 'git.log': byRef });
    fireEvent.click(screen.getByRole('button', { name: 'feature/login' }));
    await side().findByRole('button', { name: /Commit bbbbbbb/ });
    act(() => store.api.showActivity('explorer'));
    act(() => store.api.showActivity('git'));
    expect(side().getByRole('combobox', { name: 'History of' })).toHaveValue('feature/login');
    expect(side().getByRole('button', { name: /Commit bbbbbbb/ })).toBeInTheDocument();
    expect(daemon.calls('git.log')).toHaveLength(1);
  });

  it('pages a browsed branch’s history at that branch', async () => {
    const daemon = await mount({
      'git.log': (params) => ok(params?.cursor
        ? { repo: '.', ref: 'feature/login', commits: [LOG[1]!], cursor: null }
        : { repo: '.', ref: 'feature/login', commits: [FEATURE_LOG[0]!], cursor: sha('f') }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'feature/login' }));
    fireEvent.click(await side().findByRole('button', { name: 'Load more' }));
    expect(await side().findByRole('button', { name: /Commit fffffff/ })).toBeInTheDocument();
    expect(daemon.calls('git.log')[1]![0]).toMatchObject({ ref: 'feature/login', cursor: sha('f'), limit: '50' });
  });

  it('never shows a branch’s late answer under another branch, first page or next', async () => {
    const feature = deferred();
    const page = deferred();
    const daemon = await mount({
      'git.log': (params) => {
        if (params?.ref === 'feature/login') return feature.promise;
        if (params?.cursor) return page.promise;
        return ok({ repo: '.', ref: 'HEAD', commits: [LOG[0]!], cursor: sha('f') });
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'feature/login' }));
    await waitFor(() => expect(daemon.calls('git.log')).toHaveLength(1));
    fireEvent.change(side().getByRole('combobox', { name: 'History of' }), { target: { value: '' } });
    fireEvent.click(await side().findByRole('button', { name: 'Load more' }));
    fireEvent.change(side().getByRole('combobox', { name: 'History of' }), { target: { value: 'feature/login' } });
    await act(async () => { page.settle(ok({ repo: '.', ref: 'HEAD', commits: [commit('9', [], 'The checkout’s next page')], cursor: null })); });
    expect(side().queryByRole('button', { name: /The checkout’s next page/ })).toBeNull();
    await act(async () => { feature.settle(ok({ repo: '.', ref: 'feature/login', commits: FEATURE_LOG, cursor: null })); });
    expect(side().getByRole('button', { name: /Commit bbbbbbb/ })).toBeInTheDocument();
    fireEvent.change(side().getByRole('combobox', { name: 'History of' }), { target: { value: '' } });
    expect(side().queryByRole('button', { name: /Commit bbbbbbb/ })).toBeNull();
    expect(side().getByRole('button', { name: /The checkout’s next page/ })).toBeInTheDocument();
    expect(daemon.calls('git.log')).toHaveLength(3);
  });

  it('goes back to the checkout’s history once the branch browsed is deleted, and drops its late answer', async () => {
    const late = deferred();
    let branches: unknown = BRANCHES;
    const daemon = await mount({
      'git.branches': () => ok(branches),
      'git.log': (params) => (params?.ref === 'feature/login' ? late.promise : ok({ repo: '.', ref: 'HEAD', commits: LOG, cursor: null })),
    });
    fireEvent.click(screen.getByRole('button', { name: 'feature/login' }));
    await waitFor(() => expect(daemon.calls('git.log')).toHaveLength(1));
    branches = { ...BRANCHES, local: [BRANCHES.local[0]!] };
    fireEvent.click(screen.getByRole('button', { name: 'Reload branches and history' }));
    expect(await side().findByRole('button', { name: /Commit aaaaaaa/ })).toBeInTheDocument();
    expect(side().getByRole('combobox', { name: 'History of' })).toHaveValue('');
    await act(async () => { late.settle(ok({ repo: '.', ref: 'feature/login', commits: FEATURE_LOG, cursor: null })); });

    // Made again, it is a new branch: it is browsed afresh, not shown from the answer the deletion dropped.
    branches = BRANCHES;
    fireEvent.click(screen.getByRole('button', { name: 'Reload branches and history' }));
    await waitFor(() => expect(daemon.calls('git.branches').length).toBeGreaterThan(2));
    expect(side().getByRole('combobox', { name: 'History of' })).toHaveValue('');
    fireEvent.change(side().getByRole('combobox', { name: 'History of' }), { target: { value: 'feature/login' } });
    await waitFor(() => expect(daemon.calls('git.log').filter(([p]) => p?.ref === 'feature/login')).toHaveLength(2));
  });

  it('browses a branch from a detached or unborn checkout, naming the checkout as it is', async () => {
    const detached = { ...BRANCHES, current: null, detached: true, local: BRANCHES.local.map((b) => ({ ...b, current: false })) };
    const daemon = await mount({
      'git.repos': ok({ repos: [{ ...REPO_STATE, branch: null, detached: true }] }),
      'git.log': byRef,
    }, detached, 'Switch to main');
    fireEvent.click(screen.getByRole('button', { name: 'main' }));
    expect(side().getByRole('combobox', { name: 'History of' })).toHaveValue('main');
    expect(side().getByRole('option', { name: 'Your checkout (detached HEAD)' })).toBeInTheDocument();
    expect(side().getByText('Browsing only: your checkout stays on detached HEAD.')).toBeInTheDocument();
    await waitFor(() => expect(daemon.calls('git.log')[0]![0]).toMatchObject({ ref: 'main' }));
  });
});

describe('branch folders', () => {
  const folder = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name} \\d+ branch`) });

  it('folds a slash-named branch under its prefix, by click or by arrow, and keeps the fold across an activity switch', async () => {
    await mount();
    const feature = folder('feature');
    expect(feature).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('list', { name: 'feature' })).toContainElement(screen.getByRole('button', { name: 'Switch to feature/login' }));

    fireEvent.click(feature);
    expect(feature).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Switch to feature/login' })).not.toBeInTheDocument();

    fireEvent.keyDown(feature, { key: 'ArrowRight' });
    expect(feature).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(feature, { key: 'ArrowLeft' });
    expect(feature).toHaveAttribute('aria-expanded', 'false');

    act(() => store.api.showActivity('explorer'));
    act(() => store.api.showActivity('git'));
    expect(await screen.findByRole('button', { name: /^feature \d+ branch/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps a branch named like a folder beside it, each action on its full name', async () => {
    const daemon = await mount({}, { ...BRANCHES, local: [branch('main', { current: true }), branch('feature', { sha: sha('b') }), branch('feature/login', { sha: sha('c') })] });
    const inFolder = within(screen.getByRole('list', { name: 'feature' }));
    expect(inFolder.getByRole('button', { name: 'feature/login' })).toHaveTextContent('login');
    expect(inFolder.queryByRole('button', { name: 'Switch to feature' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to feature' }));
    await dialog();
    answer('Switch to feature');
    await waitFor(() => expect(daemon.calls('git.switch')).toHaveLength(1));
    expect(daemon.calls('git.switch')[0]![1]).toEqual({ workspace: WORKSPACE, repo: '.', branch: 'feature' });
  });

  it('marks the current branch and keeps Ordewell’s read-only inside their folders', async () => {
    await mount();
    expect(screen.getByRole('button', { name: 'main' }).closest('li')).toHaveAttribute('aria-current', 'true');
    const run = within(screen.getByRole('list', { name: 'ordewell/r7' }));
    expect(run.getByRole('button', { name: 'ordewell/r7/t3, read-only' })).toHaveTextContent('t3');
    expect(screen.queryByRole('button', { name: /^(Switch to|Delete) ordewell\// })).not.toBeInTheDocument();
  });

  it('starts a long group folded but for the folder that holds the checkout, and names each row in full', async () => {
    const long = 'a-very-long-branch-name-that-cannot-fit-in-a-narrow-sidebar';
    const local = [
      ...Array.from({ length: 10 }, (_, i) => branch(`chore/c${i}`, { sha: sha('b') })),
      branch(`wip/${long}`, { current: true }),
    ];
    await mount({}, { ...BRANCHES, local }, /^Local/);
    fireEvent.click(screen.getByRole('button', { name: /^Local/ }));
    expect(screen.getByRole('button', { name: /^chore 10 branches/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: /^wip 1 branch/ })).toHaveAttribute('aria-expanded', 'true');
    const row = screen.getByRole('button', { name: `wip/${long}` });
    expect(row).toHaveAttribute('title', `wip/${long}`);
    expect(row).toHaveTextContent(long);
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

  it('draws the checkout as its branch and upstream, then Pull, Push and an icon-only Fetch, each saying what it moves', async () => {
    await mount();
    const checkout = within(screen.getByRole('group', { name: 'Your checkout' }));
    expect(checkout.getByTitle(/^Your checkout: /)).toHaveTextContent(/^main\s*origin\/main$/);
    const sync = within(screen.getByRole('group', { name: /^Sync/ }));
    expect(sync.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.querySelector('.sync-word')?.textContent)).toEqual(['Pull', 'Push', 'Fetch']);
    expect(sync.getByRole('button', { name: 'Pull' })).toHaveAccessibleDescription('Pull 1 commit from origin/main');
    expect(sync.getByRole('button', { name: 'Push' })).toHaveAccessibleDescription('Push 2 commits to origin/main');
    expect(sync.queryByText(/↓|↑/)).toBeNull();
    expect(screen.getByRole('group', { name: /^Sync/ }).querySelector('.sync-note')).toBeNull();
  });

  describe('a fetch in flight', () => {
    // The confirm dialog has a "Pull from origin" button of its own: scope to the sync bar.
    const syncButton = (name: RegExp) => within(screen.getByRole('group', { name: /^Sync/ })).getByRole('button', { name });
    const fetchButton = () => syncButton(/^Fetch/);
    const pullButton = () => syncButton(/^Pull/);
    it('turns only the Fetch icon, says it is busy, and holds the other sync buttons', async () => {
      const pending = deferred();
      await mount({ 'git.fetch': pending.promise });
      expect(fetchButton()).not.toHaveAttribute('aria-busy');
      fireEvent.click(fetchButton());
      await waitFor(() => expect(fetchButton()).toHaveAttribute('aria-busy', 'true'));
      expect(fetchButton().querySelector('svg')).toHaveClass('ow-spin');
      expect(fetchButton()).toBeDisabled();
      for (const name of [/^Pull/, /^Push/]) {
        expect(syncButton(name)).toBeDisabled();
        expect(syncButton(name)).not.toHaveAttribute('aria-busy');
        expect(syncButton(name).querySelector('svg')).not.toHaveClass('ow-spin');
        expect(syncButton(name).querySelector('svg')).not.toHaveClass('ow-glide');
      }
      await act(async () => { pending.settle(ok({ repo: REPO_STATE })); });
      await waitFor(() => expect(fetchButton()).not.toHaveAttribute('aria-busy'));
      expect(fetchButton().querySelector('svg')).not.toHaveClass('ow-spin');
      expect(fetchButton()).toBeEnabled();
      expect(pullButton()).toBeEnabled();
    });

    it('is restored when git refuses, with the refusal still in the banner', async () => {
      const pending = deferred();
      await mount({ 'git.fetch': pending.promise });
      fireEvent.click(fetchButton());
      await waitFor(() => expect(fetchButton()).toHaveAttribute('aria-busy', 'true'));
      await act(async () => { pending.settle({ ok: false, status: 500, error: 'Could not resolve host.', data: { code: 'git_failed' } }); });
      await waitFor(() => expect(fetchButton()).not.toHaveAttribute('aria-busy'));
      expect(fetchButton()).toBeEnabled();
      expect(screen.getByText('Could not resolve host.')).toBeInTheDocument();
    });

    it('shows a palette fetch on the sidebar button, and a second one sends nothing', async () => {
      const pending = deferred();
      const daemon = await mount({ 'git.fetch': pending.promise });
      act(() => store.api.runCommand('git.fetch'));
      await waitFor(() => expect(fetchButton()).toHaveAttribute('aria-busy', 'true'));
      expect(fetchButton()).toBeDisabled();
      act(() => store.api.runCommand('git.fetch'));
      expect(daemon.calls('git.fetch')).toHaveLength(1);
      await act(async () => { pending.settle(ok({ repo: REPO_STATE })); });
      await waitFor(() => expect(fetchButton()).not.toHaveAttribute('aria-busy'));
    });

    it('does not move while a pull waits to be confirmed, and restores the buttons on Cancel', async () => {
      const daemon = await mount();
      fireEvent.click(pullButton());
      await dialog();
      expect(pullButton()).not.toHaveAttribute('aria-busy');
      expect(pullButton().querySelector('svg')).not.toHaveClass('ow-glide');
      answer('Cancel');
      await waitFor(() => expect(pullButton()).toBeEnabled());
      expect(daemon.calls('git.pull')).toEqual([]);
    });

    // A turned arrow points backwards half the time: Pull's and Push's glide their way instead, the line held still.
    it.each([
      { kind: 'pull' as const, name: /^Pull/, confirm: 'Pull from origin', way: 'down' },
      { kind: 'push' as const, name: /^Push/, confirm: 'Push to origin', way: 'up' },
    ])('glides the $kind arrow $way, never turning it, only once the confirmed $kind is sent', async ({ kind, name, confirm, way }) => {
      const pending = deferred();
      await mount({ [`git.${kind}`]: pending.promise });
      fireEvent.click(syncButton(name));
      await dialog();
      answer(confirm);
      await waitFor(() => expect(syncButton(name)).toHaveAttribute('aria-busy', 'true'));
      expect(syncButton(name)).toBeDisabled();
      const icon = syncButton(name).querySelector('svg')!;
      expect(icon).toHaveClass('ow-glide');
      expect(icon).not.toHaveClass('ow-spin');
      const arrow = icon.querySelector(`.ow-glide-${way}`)!;
      expect(arrow).not.toBeNull();
      // The line is the svg's own child, outside the group that moves.
      expect(arrow.contains(icon.querySelector(':scope > path'))).toBe(false);
      expect(fetchButton().querySelector('svg')).not.toHaveClass('ow-spin');
      await act(async () => { pending.settle(ok({ repo: REPO_STATE })); });
      await waitFor(() => expect(syncButton(name)).not.toHaveAttribute('aria-busy'));
      expect(syncButton(name).querySelector('svg')).not.toHaveClass('ow-glide');
    });
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
