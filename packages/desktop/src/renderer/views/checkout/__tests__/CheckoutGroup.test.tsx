import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonCallResult } from '../../../../shared/bridge';
import type { RouteId, RouteParams } from '../../../../shared/routes';
import { FrameStore } from '../../../frame/store';
import { daemonHost, resetDaemonHosts } from '../../../session/DaemonHost';
import { fakeDaemon, ok, surfacePlan } from '../../../session/__tests__/fakeDaemon';
import { HANDOFF, runView } from '../../changes/__tests__/fixtures';
import { gitStoreFor } from '../../git/gitStore';
import { CheckoutChanges, register } from '../CheckoutGroup';

const WORKSPACE = '/work/acme';

const STATUS = {
  staged: [{ path: 'README.md', status: 'M' }],
  unstaged: [{ path: 'src/app.ts', status: 'M' }],
  untracked: ['notes.txt'],
  conflicted: [],
};

function repo(over: Record<string, unknown> = {}) {
  return { repo: '.', branch: 'main', detached: false, head: 'abc123', upstream: 'origin/main', ahead: 0, behind: 0, ...over };
}

// The sync line reads the remotes from the branches; without an answer it stays "Reading the remotes…".
const sha = 'a'.repeat(40);
const BRANCHES = {
  repo: '.', current: 'main', detached: false,
  local: [{ name: 'main', sha, upstream: 'origin/main', ahead: 0, behind: 2, current: true }],
  ordewell: [], remote: [{ name: 'origin/main', sha, upstream: null, ahead: 0, behind: 0, current: false }], stashes: [], worktrees: [],
};

type Result = DaemonCallResult | Promise<DaemonCallResult>;
type Answers = Partial<Record<RouteId, Result | ((params: RouteParams | undefined, body: unknown) => Result)>>;

async function mounted(answers: Answers = {}) {
  const daemon = fakeDaemon({
    'git.repos': ok({ repos: [repo()] }),
    'git.status': ok(STATUS),
    'git.stage': ok({}),
    'git.unstage': ok({}),
    'git.commit': ok({}),
    'git.discard': ok({}),
    ...answers,
  });
  const store = new FrameStore({ workspace: WORKSPACE, platform: 'linux' });
  const openTab = vi.spyOn(store.api, 'openTab');
  const off = register(store.api);
  render(<CheckoutChanges api={store.api} />);
  await screen.findByRole('textbox', { name: 'Commit message for Your checkout' });
  return { daemon, store, openTab, off };
}

afterEach(() => {
  resetDaemonHosts();
  vi.restoreAllMocks();
});

describe('the checkout group', () => {
  it('lists each repository staged and changed files, and opens each as the diff pair it belongs to', async () => {
    const { openTab, off } = await mounted();

    const staged = within(screen.getByRole('region', { name: 'Staged in Your checkout' }));
    expect(staged.getByLabelText('Modified')).toHaveTextContent('M');
    fireEvent.click(staged.getAllByTitle('README.md')[0]!);
    expect(openTab).toHaveBeenLastCalledWith(
      { kind: 'diff', id: 'staged:README.md', title: 'README.md (Staged)', scope: { kind: 'checkout' } },
      { preview: true },
    );

    const changes = within(screen.getByRole('region', { name: 'Changes in Your checkout' }));
    expect(changes.getByLabelText('Untracked')).toHaveTextContent('?');
    fireEvent.doubleClick(changes.getAllByTitle('src/app.ts')[0]!);
    expect(openTab).toHaveBeenLastCalledWith(
      { kind: 'diff', id: 'unstaged:src/app.ts', title: 'app.ts (Changes)', scope: { kind: 'checkout' } },
      { preview: false },
    );
    off();
  });

  it('stages and unstages one file and all changes through the daemon routes', async () => {
    const { daemon, off } = await mounted();

    fireEvent.click(screen.getByRole('button', { name: 'Stage src/app.ts' }));
    await waitFor(() => expect(daemon.calls('git.stage')).toEqual([[
      {}, { workspace: WORKSPACE, repo: '.', paths: ['src/app.ts'] },
    ]]));

    fireEvent.click(screen.getByRole('button', { name: 'Unstage README.md' }));
    await waitFor(() => expect(daemon.calls('git.unstage')).toEqual([[
      {}, { workspace: WORKSPACE, repo: '.', paths: ['README.md'] },
    ]]));

    fireEvent.click(screen.getByRole('button', { name: 'Stage all' }));
    await waitFor(() => expect(daemon.calls('git.stage').at(-1)).toEqual([
      {}, { workspace: WORKSPACE, repo: '.', paths: ['notes.txt', 'src/app.ts'] },
    ]));
    off();
  });

  it('commits the message, and offers Amend only when the last commit is unpushed', async () => {
    const { daemon, off } = await mounted();
    expect(screen.queryByRole('checkbox', { name: 'Amend the last commit' })).not.toBeInTheDocument();
    expect(screen.getByText('Amend unavailable: the last commit is pushed')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message for Your checkout' }), { target: { value: '  Fix setup instructions  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));
    await waitFor(() => expect(daemon.calls('git.commit')).toEqual([[
      {}, { workspace: WORKSPACE, repo: '.', message: 'Fix setup instructions' },
    ]]));
    off();
  });

  it('amends with the commit it was shown when the branch is ahead of its upstream', async () => {
    const { daemon, off } = await mounted({ 'git.repos': ok({ repos: [repo({ ahead: 2 })] }), 'git.branches': ok(BRANCHES) });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Push' })).toHaveAccessibleDescription('Push 2 commits to origin/main'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Amend the last commit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message for Your checkout' }), { target: { value: 'Fix setup instructions, again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Amend' }));

    await waitFor(() => expect(daemon.calls('git.commit')).toEqual([[
      {}, { workspace: WORKSPACE, repo: '.', message: 'Fix setup instructions, again', amend: true, confirm: { head: 'abc123' } },
    ]]));
    off();
  });

  it('hides Amend when the route says the commit was pushed after all', async () => {
    const { daemon, off } = await mounted({
      'git.repos': ok({ repos: [repo({ ahead: 2 })] }),
      'git.commit': () => ({ ok: false, status: 400, error: 'pushed', data: { code: 'pushed', error: 'The last commit is on origin/main already.' } }),
    });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Amend the last commit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message for Your checkout' }), { target: { value: 'Rewrite it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Amend' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already pushed/);
    expect(screen.queryByRole('checkbox', { name: 'Amend the last commit' })).not.toBeInTheDocument();
    expect(daemon.calls('git.commit')).toHaveLength(1);
    off();
  });

  it('asks before discarding, lists the files, and echoes them back to the route', async () => {
    const { daemon, off } = await mounted();

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes to src/app.ts' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Discard the changes to src/app.ts?');
    expect(within(dialog).getByText('src/app.ts')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(daemon.calls('git.discard')).toEqual([[
      {}, { workspace: WORKSPACE, repo: '.', paths: ['src/app.ts'], confirm: { files: ['src/app.ts'] } },
    ]]));
    off();
  });

  it("puts the cursor in the commit box from Merge all's Commit first command", async () => {
    const { store, off } = await mounted();
    act(() => store.api.runCommand('checkout.focusCommit'));
    expect(screen.getByRole('textbox', { name: 'Commit message for Your checkout' })).toHaveFocus();
    off();
  });

  it('says when a live run will land on the branch, and that actions reach its timeline', async () => {
    const daemon = fakeDaemon({
      'git.repos': ok({ repos: [repo()] }),
      'git.status': ok(STATUS),
      'sessions.load': ok({ ok: true, plan: surfacePlan([]), goal: 'Ship it' }),
    });
    const host = daemonHost(WORKSPACE);
    await act(() => host.open('s1'));
    const running = { ...runView([], HANDOFF), activity: { starting: false, running: true, scheduled: false, resumable: false, advancesOnItsOwn: true } };
    await act(async () => {
      daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'run_snapshot', sessionId: 's1', view: running, stream: 'd1', seq: 0 });
    });
    const store = new FrameStore({ workspace: WORKSPACE, platform: 'linux' });
    const off = register(store.api);
    render(<CheckoutChanges api={store.api} />);

    expect(await screen.findByText(/main is a live run’s landing branch/)).toBeInTheDocument();
    expect(screen.getByText(/actions here are noted in its timeline/)).toBeInTheDocument();
    off();
  });

  it('says a repository has no changes, and keeps the commit box and its tracking arrows', async () => {
    const ranked = repo({ ahead: 1, behind: 3 });
    const { off } = await mounted({
      'git.repos': ok({ repos: [ranked] }),
      'git.branches': ok(BRANCHES),
      'git.status': ok({ staged: [], unstaged: [], untracked: [], conflicted: [] }),
    });

    expect(await screen.findByText('No changes in your checkout.')).toBeInTheDocument();
    // Behind before ahead, as Pull comes before Push; the count is drawn in the button, its words in the description.
    const sync = within(screen.getByRole('group', { name: /^Sync/ }));
    expect(sync.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Pull3', 'Push1', 'Fetch']);
    await waitFor(() => expect(sync.getByRole('button', { name: 'Pull' })).toHaveAccessibleDescription('Pull 3 commits from origin/main'));
    expect(sync.getByRole('button', { name: 'Push' })).toHaveAccessibleDescription('Push 1 commit to origin/main');
    expect(screen.getByRole('textbox', { name: 'Commit message for Your checkout' })).toBeInTheDocument();
    off();
  });

  describe('the sync line while git works', () => {
    const button = (name: RegExp) => within(screen.getByRole('group', { name: /^Sync/ })).getByRole('button', { name });

    async function mountedWithRemote(answers: Answers) {
      const result = await mounted({ 'git.repos': ok({ repos: [repo({ behind: 2 })] }), 'git.branches': ok(BRANCHES), ...answers });
      await waitFor(() => expect(button(/^Fetch/)).toBeEnabled());
      return result;
    }

    it('turns the Fetch icon from the first click to the answer, and restores every button', async () => {
      let settle!: (r: DaemonCallResult) => void;
      await mountedWithRemote({ 'git.fetch': new Promise<DaemonCallResult>((resolve) => { settle = resolve; }) });
      fireEvent.click(button(/^Fetch/));
      await waitFor(() => expect(button(/^Fetch/)).toHaveAttribute('aria-busy', 'true'));
      expect(button(/^Fetch/).querySelector('svg')).toHaveClass('ow-spin');
      expect(button(/^Pull/)).toBeDisabled();
      expect(button(/^Pull/).querySelector('svg')).not.toHaveClass('ow-spin');
      await act(async () => { settle(ok({ repo: repo() })); });
      await waitFor(() => expect(button(/^Fetch/)).not.toHaveAttribute('aria-busy'));
      expect(button(/^Fetch/)).toBeEnabled();
      expect(button(/^Pull/)).toBeEnabled();
    });

    it('shows a sync another surface started, and is restored when it is refused', async () => {
      const { store } = await mountedWithRemote({});
      let fail!: () => void;
      const started = gitStoreFor(store.api).sync('.', 'fetch', () => new Promise<void>((_, reject) => { fail = () => reject(new Error('no route to host')); }));
      await waitFor(() => expect(button(/^Fetch/)).toHaveAttribute('aria-busy', 'true'));
      expect(button(/^Push/)).toBeDisabled();
      fail();
      await expect(started).rejects.toThrow('no route to host');
      await waitFor(() => expect(button(/^Fetch/)).not.toHaveAttribute('aria-busy'));
      expect(button(/^Fetch/)).toBeEnabled();
    });

    // The Changes sidebar names the branch in its own head: the sync line adds no second one.
    it('draws only the buttons here, with no branch line and no note while the branch tracks its upstream', async () => {
      await mountedWithRemote({});
      const group = screen.getByRole('group', { name: /^Sync/ });
      expect(group.querySelector('.sync-head')).toBeNull();
      expect(group.querySelector('.sync-note')).toBeNull();
      expect(button(/^Pull/)).toHaveAccessibleDescription('Pull 2 commits from origin/main');
      expect(button(/^Push/)).toHaveAccessibleDescription('Nothing to push: origin/main has every commit');
    });

    it('says a branch with no upstream is not published, and lets Push publish it', async () => {
      await mounted({ 'git.repos': ok({ repos: [repo({ upstream: null })] }), 'git.branches': ok(BRANCHES) });
      expect(await screen.findByText('Not published: Push publishes it.')).toBeInTheDocument();
      await waitFor(() => expect(button(/^Push/)).toBeEnabled());
      expect(button(/^Pull/)).toHaveAccessibleDescription('Nothing to pull: this branch has no upstream yet');
    });
  });
});
