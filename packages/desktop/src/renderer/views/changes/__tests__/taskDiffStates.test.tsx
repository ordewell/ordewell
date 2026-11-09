import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RouteParams } from '../../../../shared/routes';
import type { DaemonCallResult } from '../../../../shared/bridge';
import { startAttemptUsage, type RunTask } from '@ordewell/core';
import { FrameStore } from '../../../frame/store';
import { DaemonHost } from '../../../session/DaemonHost';
import { fakeDaemon, ok, surfacePlan, surfaceTask } from '../../../session/__tests__/fakeDaemon';
import { ChangesList, TaskChanges } from '../ChangesSidebar';
import { HANDOFF, runTask, runView, worktree } from './fixtures';

/*
 * What the Changes view says of a task's diff in each state the daemon names
 * (`plans.taskDiff`'s cause), read against the live task: a run's save trails
 * what it broadcasts, so a running task's record can reach the disk after its
 * row stops changing.
 */

const WORKSPACE = '/work/acme';
const NO_RECORD = { available: false, cause: 'no-record', reason: 'Task diff is not available yet: the saved run holds no worktree record for this task.' };
const SSO = '[repo .] src/sso.ts: +40 -0\n';

let hosts: DaemonHost[] = [];
afterEach(() => { for (const host of hosts) host.dispose(); hosts = []; vi.useRealTimers(); vi.restoreAllMocks(); });

type Answer = (params: RouteParams | undefined) => DaemonCallResult;

async function hostWith(task: RunTask, taskDiff: Answer) {
  const daemon = fakeDaemon({
    'sessions.load': ok({ ok: true, plan: surfacePlan([surfaceTask({ id: task.id, order: task.order, title: task.title, status: task.status })], 'running'), goal: 'g' }),
    'plans.taskDiff': taskDiff,
    'git.diff': { ok: false, status: 404, error: 'No worktree.' },
  });
  const host = new DaemonHost(WORKSPACE, async () => null);
  hosts.push(host);
  await act(() => host.open('s1'));
  const show = async (shown: RunTask): Promise<void> => {
    await act(async () => {
      daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'run_snapshot', sessionId: 's1', view: runView([shown], HANDOFF), stream: 'd1', seq: 0 });
    });
  };
  await show(task);
  return { daemon, host, show, api: new FrameStore({ workspace: WORKSPACE, platform: 'linux' }).api };
}

/** Let the retry's wait pass, and the read it starts settle. */
const elapse = (ms: number): Promise<void> => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

const running = runTask({ id: 't3', order: 3, title: 'Wire SSO', status: 'in_progress', isolation: worktree('active') });
const unavailable = (cause: string, reason = `Not available: ${cause}.`) => ok({ available: false, cause, reason });

/**
 * Hold the next task-diff read until the test lets it answer, as a slow
 * daemon would; reads after it answer as the route says.
 */
function holdNextRead(daemon: ReturnType<typeof fakeDaemon>): (answer: DaemonCallResult) => Promise<void> {
  const answer = daemon.call.getMockImplementation()!;
  let release!: (result: DaemonCallResult) => void;
  const held = new Promise<DaemonCallResult>((resolve) => { release = resolve; });
  let taken = false;
  daemon.call.mockImplementation(async (route, params, body) => {
    if (route !== 'plans.taskDiff' || taken) return answer(route, params, body);
    taken = true;
    return held;
  });
  return (result) => act(async () => { release(result); await held; });
}

/** The task tab's Changes view, which shows any live task, of whatever kind. */
async function tabFor(task: RunTask, taskDiff: Answer) {
  const made = await hostWith(task, taskDiff);
  const view = render(<TaskChanges api={made.api} host={made.host} task={task} label={String(task.order)} />);
  return { ...made, view, region: within(screen.getByRole('region', { name: 'Changed files' })) };
}

describe('a task diff the saved run has not caught up with', () => {
  it('reads quietly as no changes yet, and shows the files once the record is saved, though the row never changed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let saved = false;
    const { daemon, host, api } = await hostWith(running, () => ok(saved ? { available: true, text: SSO } : NO_RECORD));
    render(<ChangesList api={api} host={host} />);

    const group = within(await screen.findByRole('region', { name: 'Task #3: Wire SSO' }));
    expect(await group.findByText('No changes yet.')).toBeInTheDocument();
    expect(group.queryByRole('alert')).not.toBeInTheDocument();

    saved = true;
    await elapse(1000);
    expect(await group.findByRole('button', { name: /sso\.ts/ })).toBeInTheDocument();
    expect(daemon.calls('plans.taskDiff').length).toBeGreaterThan(1);
  });
});

describe('a task diff read as its task stands', () => {
  it('shows a running task with no files changed yet as quiet, not as an error', async () => {
    const { region } = await tabFor(running, () => ok({ available: true, text: 'No files changed since this task started.\n' }));
    expect(await region.findByText('No changes in this task.')).toBeInTheDocument();
    expect(region.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    ['an ops task', runTask({ id: 't4', order: 4, title: 'Bump deps', status: 'in_progress', ops: true }), unavailable('not-attributable'), /ops task works in the checkout/],
    ['a script that writes', runTask({ id: 't4', order: 4, title: 'Format', status: 'completed', type: 'script' }), unavailable('not-attributable'), /ops task works in the checkout/],
    ['a read-only task', runTask({ id: 't4', order: 4, title: 'Audit', status: 'in_progress', isolation: worktree('active') }), unavailable('read-only'), /read-only task lands no changes/],
    ['a task the live run gave no worktree', runTask({ id: 't4', order: 4, title: 'Wire SSO', status: 'in_progress' }), unavailable('no-run'), /shares the checkout/],
    ['an ended task with no record', runTask({ id: 't4', order: 4, title: 'Wire SSO', status: 'completed' }), unavailable('no-record'), /holds no worktree record/],
  ])('explains %s with no diff of its own as unavailable, not failed', async (_kind, task, answer, says) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { daemon, region } = await tabFor(task, () => answer);
    const note = await region.findByText(says);
    expect(note).toHaveClass('changes-note', 'unavailable');
    expect(region.queryByRole('alert')).not.toBeInTheDocument();
    expect(region.queryByText('No changes yet.')).not.toBeInTheDocument();
    // A task whose answer cannot change by waiting is read once.
    await elapse(60_000);
    expect(daemon.calls('plans.taskDiff')).toHaveLength(1);
  });

  it('shows a saved patch as files', async () => {
    const ended = runTask({ id: 't4', order: 4, title: 'Wire SSO', status: 'completed' });
    const { region } = await tabFor(ended, () => ok({ available: true, text: SSO }));
    expect(await region.findByRole('button', { name: /sso\.ts/ })).toBeInTheDocument();
  });

  it.each([
    ['a failed read', unavailable('error', 'The saved patch for this task is missing.')],
    ['a daemon from before causes', ok({ available: false, reason: 'Task diff is not available yet.' })],
    ['a cause this window does not know', ok({ available: false, cause: 'misplaced', reason: 'Task diff is not available yet.' })],
    ['a malformed answer', ok({ available: false })],
    ['a transport failure', { ok: false, status: 500, error: 'The daemon failed.' } as DaemonCallResult],
  ])('keeps %s an error', async (_kind, answer) => {
    const { region } = await tabFor(running, () => answer);
    expect(await region.findByRole('alert')).toBeInTheDocument();
    expect(region.queryByText('No changes yet.')).not.toBeInTheDocument();
  });
});

describe('reading a task diff again', () => {
  it('shows loading on the first read, and keeps the last list drawn while it reads again', async () => {
    const { daemon, region } = await tabFor(running, () => ok({ available: true, text: SSO }));
    expect(await region.findByRole('button', { name: /sso\.ts/ })).toBeInTheDocument();

    const answer = holdNextRead(daemon);
    fireEvent.click(region.getByRole('button', { name: 'Refresh changes' }));
    await waitFor(() => expect(daemon.calls('plans.taskDiff')).toHaveLength(2));
    expect(region.getByRole('button', { name: /sso\.ts/ })).toBeInTheDocument();
    expect(region.queryByRole('status', { name: 'Loading changes' })).not.toBeInTheDocument();
    await answer(ok({ available: true, text: '[repo .] src/okta.ts: +2 -0\n' }));
    expect(region.getByRole('button', { name: /okta\.ts/ })).toBeInTheDocument();
  });

  it('never draws another task\'s files, nor a read that answers after it was superseded', async () => {
    const other = runTask({ id: 't5', order: 5, title: 'Add docs', status: 'in_progress', isolation: worktree('active') });
    const { daemon, api, host, view, region } = await tabFor(running, (params) => ok({ available: true, text: params?.taskId === 't5' ? '[repo .] docs/sso.md: +5 -0\n' : SSO }));
    expect(await region.findByRole('button', { name: /sso\.ts/ })).toBeInTheDocument();

    const late = holdNextRead(daemon);
    view.rerender(<TaskChanges api={api} host={host} task={other} label="5" />);
    expect(region.getByRole('status', { name: 'Loading changes' })).toBeInTheDocument();
    expect(region.queryByRole('button', { name: /sso\.ts/ })).not.toBeInTheDocument();

    view.rerender(<TaskChanges api={api} host={host} task={running} label="3" />);
    expect(await region.findByRole('button', { name: /sso\.ts/ })).toBeInTheDocument();
    // t5's read answers only now, after the tab moved back to t3.
    await late(ok({ available: true, text: '[repo .] docs/sso.md: +5 -0\n' }));
    expect(region.queryByRole('button', { name: /sso\.md/ })).not.toBeInTheDocument();
    expect(region.getByRole('button', { name: /sso\.ts/ })).toBeInTheDocument();
  });

  it('starts a new attempt\'s list afresh', async () => {
    const { daemon, api, host, view, region } = await tabFor(running, () => ok({ available: true, text: SSO }));
    expect(await region.findByRole('button', { name: /sso\.ts/ })).toBeInTheDocument();
    holdNextRead(daemon);
    const again: RunTask = { ...running, attemptUsage: [startAttemptUsage(1, 'claude-code', ''), startAttemptUsage(2, 'claude-code', '')] };
    view.rerender(<TaskChanges api={api} host={host} task={again} label="3" />);
    expect(region.getByRole('status', { name: 'Loading changes' })).toBeInTheDocument();
    expect(region.queryByRole('button', { name: /sso\.ts/ })).not.toBeInTheDocument();
  });
});

describe('waiting for a running task\'s record', () => {
  it('recovers in the task tab too', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let saved = false;
    const { region } = await tabFor(running, () => ok(saved ? { available: true, text: SSO } : NO_RECORD));
    expect(await region.findByText('No changes yet.')).toBeInTheDocument();
    saved = true;
    await elapse(1000);
    expect(await region.findByRole('button', { name: /sso\.ts/ })).toBeInTheDocument();
  });

  it('stops after a few reads, and Refresh reads again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { daemon, region } = await tabFor(running, () => ok(NO_RECORD));
    expect(await region.findByText('No changes yet.')).toBeInTheDocument();
    for (const ms of [1000, 2000, 4000, 8000, 16000]) await elapse(ms);
    expect(daemon.calls('plans.taskDiff')).toHaveLength(6);
    await elapse(60_000);
    expect(daemon.calls('plans.taskDiff')).toHaveLength(6);

    fireEvent.click(region.getByRole('button', { name: 'Refresh changes' }));
    await waitFor(() => expect(daemon.calls('plans.taskDiff')).toHaveLength(7));
    // A refresh is a fresh start: its own quiet answer is read again too.
    await elapse(1000);
    expect(daemon.calls('plans.taskDiff')).toHaveLength(8);
  });

  it('waits while the daemon is away or the window hidden, and reads nothing once closed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const { daemon, view, region } = await tabFor(running, () => ok(NO_RECORD));
    expect(await region.findByText('No changes yet.')).toBeInTheDocument();

    act(() => daemon.setStatus({ state: 'connecting', port: 3700 }));
    await elapse(5000);
    expect(daemon.calls('plans.taskDiff')).toHaveLength(1);
    act(() => daemon.setStatus({ state: 'connected', port: 3700, owned: true, daemon: { version: '0.12.3', contract: 1 } }));
    await waitFor(() => expect(daemon.calls('plans.taskDiff')).toHaveLength(2));

    hidden = true;
    await elapse(5000);
    expect(daemon.calls('plans.taskDiff')).toHaveLength(2);
    hidden = false;
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(daemon.calls('plans.taskDiff')).toHaveLength(3));

    view.unmount();
    await elapse(60_000);
    expect(daemon.calls('plans.taskDiff')).toHaveLength(3);
  });
});
