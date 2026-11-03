import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfirmationRequest } from '@ordewell/ui/host';
import { DaemonHost, type Confirm } from '../DaemonHost';
import { ChatSurface } from '../useSession';
import { fakeDaemon, ok, surfacePlan, surfaceTask } from './fakeDaemon';

const WORKSPACE = '/work/acme';
const PLAN = surfacePlan([
  surfaceTask({ id: 't1', order: 1, title: 'Parse the config', assignedRunner: 'claude-code' }),
  surfaceTask({ id: 't2', order: 2, title: 'Wire the CLI', dependencies: ['t1'] }),
]);

let hosts: DaemonHost[] = [];
afterEach(() => { for (const host of hosts) host.dispose(); hosts = []; });

/** The window's confirm, answered by `answer` with whatever choice it names: a test asks for one it offers. */
function hostWith(answer: (request: ConfirmationRequest<string>) => Promise<string | null> = async () => null): DaemonHost {
  const ask: Confirm = async <C extends string>(request: ConfirmationRequest<C>) => await answer(request) as C | null;
  const host = new DaemonHost(WORKSPACE, ask);
  hosts.push(host);
  return host;
}

/** A host that has opened s1, its first frames delivered and its load read: the daemon's snapshot is the plan's run, nothing started. */
async function opened(daemon: ReturnType<typeof fakeDaemon>, host: DaemonHost): Promise<void> {
  await act(() => host.open('s1'));
  await act(async () => {
    daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'run_snapshot', sessionId: 's1', view: { tasks: PLAN.tasks, runMerge: null, handoff: null, mergeResult: null }, stream: 'd1', seq: 0 });
  });
}

describe('DaemonHost', () => {
  it('follows a new session on its own socket, and loads nothing for it', () => {
    const daemon = fakeDaemon();
    const host = hostWith();
    expect(daemon.subscribe).toHaveBeenCalledWith(host.sessionId, expect.any(Function));
    expect(daemon.calls('sessions.load')).toEqual([]);
  });

  it('opens a saved session through its lease, and the plan list draws the frames that follow', async () => {
    // The daemon's plan as it stands: a status update cues the list to read it again.
    let plan = PLAN;
    const daemon = fakeDaemon({ 'sessions.load': () => ok({ ok: true, plan, goal: 'Ship the parser' }) });
    const host = hostWith();
    render(<ChatSurface host={host} layout="plan" />);
    await opened(daemon, host);

    expect(daemon.calls('sessions.load')[0]).toEqual([{ id: 's1', workspace: WORKSPACE }, undefined]);
    expect(host.sessionId).toBe('s1');
    expect(host.getSnapshot().goal).toBe('Ship the parser');
    expect(daemon.subscribe).toHaveBeenLastCalledWith('s1', expect.any(Function));
    expect(await screen.findByText('Parse the config')).toBeInTheDocument();
    expect(screen.getByText('Wire the CLI')).toBeInTheDocument();

    plan = surfacePlan([{ ...PLAN.tasks[0]!, status: 'in_progress' }, PLAN.tasks[1]!]);
    await act(async () => {
      daemon.push('s1',
        { type: 'task_started', taskId: 't1', order: 1, title: 'Parse the config', runner: 'claude-code', stream: 'd1', seq: 1 },
        { type: 'status_update', tasks: [{ id: 't1', status: 'in_progress', verdict: null }, { id: 't2', status: 'pending', verdict: null }], stream: 'd1', seq: 2 },
      );
    });
    await waitFor(() => expect(host.getSnapshot().state.run.tasks.find((t) => t.id === 't1')?.status).toBe('in_progress'));
    expect(await screen.findByRole('img', { name: 'Running' })).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'To do' })).toHaveLength(1);
  });

  it('posts a card\'s command to the daemon route that does it', async () => {
    const daemon = fakeDaemon({ 'sessions.load': ok({ ok: true, plan: surfacePlan(PLAN.tasks, 'draft'), goal: 'Ship the parser' }) });
    const host = hostWith();
    render(<ChatSurface host={host} layout="plan" />);
    await opened(daemon, host);
    await screen.findByText('Parse the config');

    await act(() => host.handle({ type: 'sendSystemCommand', command: 'executePlan' }));
    expect(daemon.calls('plans.execute')).toEqual([[{ sessionId: 's1' }, undefined]]);

    await act(() => host.handle({ type: 'sendSystemCommand', command: 'skip', taskId: 't2' }));
    expect(daemon.calls('plans.executeCommand')).toContainEqual([{ sessionId: 's1' }, { command: 'skip_task', task: 't2' }]);

    await act(() => host.handle({ type: 'resolveApproval', id: 'a1', granted: true }));
    expect(daemon.calls('approvals.decide')).toEqual([[{ sessionId: 's1', approvalId: 'a1' }, { granted: true }]]);
  });

  it('asks before a removal, in ui\'s words, and removes only on a yes', async () => {
    const daemon = fakeDaemon({ 'sessions.load': ok({ ok: true, plan: PLAN, goal: 'g' }) });
    const asked: ConfirmationRequest<string>[] = [];
    let answer: string | null = null;
    const host = hostWith(async (request) => { asked.push(request); return answer; });
    await opened(daemon, host);
    await waitFor(() => expect(host.getSnapshot().state.plan?.tasks).toHaveLength(2));

    await act(() => host.handle({ type: 'removeTask', taskId: 't1' }));
    expect(asked[0]?.message).toMatch(/Parse the config/);
    expect(daemon.calls('plans.deleteTask')).toEqual([]);

    answer = 'remove';
    await act(() => host.handle({ type: 'removeTask', taskId: 't1' }));
    expect(daemon.calls('plans.deleteTask')).toEqual([[{ sessionId: 's1', taskId: 't1' }, undefined]]);
  });

  it('keeps its session when another host holds the one asked for, and says who', async () => {
    const sessionHeld = { holder: { host: { kind: 'vscode', pid: 4242 }, acquiredAt: '2026-11-03T09:00:00.000Z' } };
    const daemon = fakeDaemon({
      'sessions.load': { ok: false, status: 409, error: 'Conflict', data: { ok: false, error: 'This session is open in VS Code.', code: 'session_held', sessionHeld } },
    });
    const host = hostWith();
    const before = host.sessionId;
    await act(() => host.open('s1'));
    expect(host.sessionId).toBe(before);
    expect(host.getSnapshot().held).toEqual(sessionHeld);
    expect(daemon.subscribe).toHaveBeenCalledTimes(1);
  });

  it('sends a card\'s Open chat and a file link to the frame\'s navigator', async () => {
    fakeDaemon();
    const host = hostWith();
    const navigator = { openTask: vi.fn(), openFile: vi.fn() };
    host.setNavigator(navigator);
    await act(() => host.handle({ type: 'openTaskLog', taskId: 't1' }));
    await act(() => host.handle({ type: 'openFile', path: 'src/a.ts' }));
    expect(navigator.openTask).toHaveBeenCalledWith('t1', 'chat');
    expect(navigator.openFile).toHaveBeenCalledWith('src/a.ts');
  });

  it('starts a blank session from New session, on a socket of its own', async () => {
    const daemon = fakeDaemon({ 'sessions.load': ok({ ok: true, plan: PLAN, goal: 'g' }) });
    const host = hostWith();
    render(<ChatSurface host={host} layout="plan" />);
    await opened(daemon, host);
    await screen.findByText('Parse the config');
    act(() => host.newSession());
    expect(host.sessionId).not.toBe('s1');
    expect(daemon.subscribe).toHaveBeenLastCalledWith(host.sessionId, expect.any(Function));
    await waitFor(() => expect(screen.queryByText('Parse the config')).toBeNull());
  });

  it('answers a planner message by starting the planner on the daemon', async () => {
    const daemon = fakeDaemon({ 'plans.converseStart': ok({ ok: true, sessionId: 'p1', turnId: 'turn-1' }) });
    const host = hostWith();
    render(<ChatSurface host={host} layout="conversation" />);
    const box = await screen.findByRole('textbox', { name: 'Message the planner' });
    fireEvent.change(box, { target: { value: 'Add a parser' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(daemon.calls('plans.converseStart')).toHaveLength(1));
    expect(daemon.calls('plans.converseStart')[0]?.[1]).toMatchObject({ goal: 'Add a parser' });
  });
});
