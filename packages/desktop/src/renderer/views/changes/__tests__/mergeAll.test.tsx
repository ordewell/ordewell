import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MergePreflightResponse } from '@ordewell/core';
import type { ConfirmationRequest } from '@ordewell/ui/host';
import { FrameStore } from '../../../frame/store';
import { DaemonHost, daemonHost, resetDaemonHosts } from '../../../session/DaemonHost';
import { fakeDaemon, ok, surfacePlan } from '../../../session/__tests__/fakeDaemon';
import { register } from '../ChangesSidebar';
import { FOCUS_COMMIT_COMMAND, mergeAll } from '../mergeAll';
import type { PreflightChoice } from '../preflight';
import { HANDOFF, runTask, runView, worktree } from './fixtures';

const WORKSPACE = '/work/acme';
const SIZES = { sidebar: 260, right: 360, bottom: 240 };
const SHA = '9c1e5b7d2a4f60318e5d7c9b1a2f3e4d5c6b7a80';

const CLEAN: MergePreflightResponse = { runId: 'r1', stashMessage: 'ordewell: before merging r1', repos: [{ repo: '.', branch: 'main', overlap: [], otherDirty: false }] };
const OVERLAP: MergePreflightResponse = { ...CLEAN, repos: [{ repo: '.', branch: 'main', overlap: ['src/login.tsx'], otherDirty: true }] };

let hosts: DaemonHost[] = [];
afterEach(() => { for (const host of hosts) host.dispose(); hosts = []; resetDaemonHosts(); vi.restoreAllMocks(); });

async function setup(preflight: MergePreflightResponse | null, choice: PreflightChoice | null, extra: Parameters<typeof fakeDaemon>[0] = {}) {
  const daemon = fakeDaemon({
    'sessions.load': ok({ ok: true, plan: surfacePlan([]), goal: 'Ship SSO' }),
    'plans.mergePreflight': preflight ? ok(preflight) : { ok: false, status: 409, error: 'The run has nothing to merge.' },
    'git.stash': (_params, body) => ok({ repo: { repo: '.', branch: 'main' }, stash: { sha: SHA, message: (body as { message: string }).message } }),
    'git.stashPop': ok({ repo: { repo: '.', branch: 'main' } }),
    ...extra,
  });
  const host = new DaemonHost(WORKSPACE, async () => null);
  hosts.push(host);
  await act(() => host.open('s1'));
  await act(async () => {
    daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'run_snapshot', sessionId: 's1', view: runView([runTask({ id: 't1', order: 1, title: 'Add the login button', status: 'completed', isolation: worktree('integrated') })], HANDOFF), stream: 'd1', seq: 0 });
  });
  const store = new FrameStore({ workspace: WORKSPACE, platform: 'linux', sizes: SIZES });
  const asked: Array<{ request: ConfirmationRequest<PreflightChoice>; body: JSX.Element }> = [];
  const ask = async (request: ConfirmationRequest<PreflightChoice>, body: JSX.Element) => { asked.push({ request, body }); return choice; };
  const run = () => act(() => mergeAll(store.api, host, ask));
  return { daemon, host, store, asked, run };
}

function banner(store: FrameStore, id: string) {
  return store.getSnapshot().banners.find((b) => b.id === id);
}

describe('Merge all', () => {
  it('asks the preflight first, and on Cancel moves nothing', async () => {
    const { daemon, asked, run } = await setup(OVERLAP, null);
    await run();
    expect(daemon.calls('plans.mergePreflight')).toEqual([[{ sessionId: 's1', workspace: WORKSPACE }, undefined]]);
    expect(asked).toHaveLength(1);
    expect(daemon.calls('git.stash')).toEqual([]);
    expect(daemon.calls('plans.isolationMerge')).toEqual([]);
  });

  it('merges straight away when nothing of the person\'s is in the way, saying where it lands', async () => {
    const { daemon, asked, run } = await setup(CLEAN, 'merge');
    await run();
    expect(asked[0]!.request.choices.map((c) => c.id)).toEqual(['merge']);
    render(asked[0]!.body);
    expect(screen.getByRole('list', { name: 'Where it lands' })).toHaveTextContent('Lands on main in the workspace');
    expect(daemon.calls('plans.isolationMerge')).toEqual([[{ sessionId: 's1' }, {}]]);
  });

  it('stashes only the overlapping files, merges, then gives them back by the stash it made', async () => {
    const { daemon, store, asked, run } = await setup(OVERLAP, 'stash');
    await run();
    expect(asked[0]!.request.choices.map((c) => c.id)).toEqual(['stash', 'commit']);
    render(asked[0]!.body);
    expect(screen.getByRole('list', { name: 'Your uncommitted files in the workspace the run also changed' })).toHaveTextContent('src/login.tsx');

    expect(daemon.calls('git.stash')).toEqual([[{}, { workspace: WORKSPACE, repo: '.', paths: ['src/login.tsx'], message: 'ordewell: before merging r1' }]]);
    expect(daemon.calls('plans.isolationMerge')).toEqual([[{ sessionId: 's1' }, {}]]);
    const restore = banner(store, 'changes.restoreStash');
    expect(restore?.title).toBe('The run merged. Your uncommitted changes are stashed.');

    await act(async () => { await restore!.actions![0]!.run(); });
    expect(daemon.calls('git.stashPop')).toEqual([[{}, { workspace: WORKSPACE, repo: '.', stash: SHA }]]);
    expect(banner(store, 'changes.restoreStash')).toBeUndefined();
  });

  it('stops before the merge when the stash fails, and says so', async () => {
    const { daemon, store, run } = await setup(OVERLAP, 'stash', { 'git.stash': { ok: false, status: 500, error: 'index.lock exists' } });
    await run();
    expect(daemon.calls('plans.isolationMerge')).toEqual([]);
    expect(banner(store, 'changes.mergeAll')?.title).toBe('Merge all stopped: your changes could not be stashed');
  });

  it('hands Commit first over to the checkout\'s commit box', async () => {
    const { daemon, store, run } = await setup(OVERLAP, 'commit');
    const runCommand = vi.spyOn(store.api, 'runCommand');
    const showActivity = vi.spyOn(store.api, 'showActivity');
    await run();
    expect(showActivity).toHaveBeenCalledWith('changes');
    expect(runCommand).toHaveBeenCalledWith(FOCUS_COMMIT_COMMAND);
    expect(daemon.calls('plans.isolationMerge')).toEqual([]);
  });

  it('shows a preflight it could not run, and merges nothing', async () => {
    const { daemon, store, asked, run } = await setup(null, 'merge');
    await run();
    expect(asked).toEqual([]);
    expect(banner(store, 'changes.mergeAll')?.title).toBe('Merge all could not check your checkout');
    expect(daemon.calls('plans.isolationMerge')).toEqual([]);
  });
});

describe('the session\'s Review & Merge all', () => {
  it('opens the Changes view, and sends every Merge all through the preflight once the view is registered', async () => {
    const daemon = fakeDaemon({ 'sessions.load': ok({ ok: true, plan: surfacePlan([]), goal: 'g' }), 'plans.mergePreflight': ok(CLEAN) });
    const store = new FrameStore({ workspace: WORKSPACE, platform: 'linux', sizes: SIZES });
    const showActivity = vi.spyOn(store.api, 'showActivity');
    const host = daemonHost(WORKSPACE);
    expect(host.reviewing).toBe(false);
    const off = register(store.api);
    expect(host.reviewing).toBe(true);

    await act(() => host.handle({ type: 'isolationAction', action: 'reviewDiff' }));
    expect(showActivity).toHaveBeenCalledWith('changes');

    // The window's own confirm is a dialog: the preflight reached is what this checks.
    void host.handle({ type: 'isolationAction', action: 'merge' });
    await vi.waitFor(() => expect(daemon.calls('plans.mergePreflight')).toHaveLength(1));
    expect(daemon.calls('plans.isolationMerge')).toEqual([]);

    off();
    expect(host.reviewing).toBe(false);
  });
});
