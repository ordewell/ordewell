import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonCallResult } from '../../../../shared/bridge';
import type { RouteId, RouteParams } from '../../../../shared/routes';
import { FrameStore } from '../../../frame/store';
import { daemonHost, resetDaemonHosts } from '../../../session/DaemonHost';
import { fakeDaemon, ok, surfacePlan } from '../../../session/__tests__/fakeDaemon';
import { HANDOFF, runView } from '../../changes/__tests__/fixtures';
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

type Answers = Partial<Record<RouteId, DaemonCallResult | ((params: RouteParams | undefined, body: unknown) => DaemonCallResult)>>;

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
    const { daemon, off } = await mounted({ 'git.repos': ok({ repos: [repo({ ahead: 2 })] }) });

    expect(screen.getByText(/↓ 0 ↑ 2/)).toBeInTheDocument();
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
      'git.status': ok({ staged: [], unstaged: [], untracked: [], conflicted: [] }),
    });

    expect(await screen.findByText('No changes in your checkout.')).toBeInTheDocument();
    expect(screen.getByText(/↓ 3 ↑ 1/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Commit message for Your checkout' })).toBeInTheDocument();
    off();
  });
});
