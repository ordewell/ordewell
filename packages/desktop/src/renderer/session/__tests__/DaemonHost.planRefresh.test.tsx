import { act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunActivity } from '@ordewell/core';
import { DaemonHost } from '../DaemonHost';
import type { HostToWebview } from '@ordewell/ui/protocol';
import { fakeDaemon, ok, surfacePlan, surfaceTask } from './fakeDaemon';

/**
 * The plan with its conversation is megabytes in a long session, so the host
 * reads it again when the plan changed and not when a status did: a status
 * update folds into the run view it already holds.
 */
const WORKSPACE = '/work/acme';
const TASKS = [
  surfaceTask({ id: 't1', order: 1, title: 'Parse the config', assignedRunner: 'claude-code' }),
  surfaceTask({ id: 't2', order: 2, title: 'Wire the CLI', dependencies: ['t1'] }),
];
const IDLE: RunActivity = { starting: false, running: false, scheduled: false, resumable: false, advancesOnItsOwn: false };
const WORKING: RunActivity = { starting: false, running: true, scheduled: true, resumable: false, advancesOnItsOwn: true };

let hosts: DaemonHost[] = [];
afterEach(() => { for (const host of hosts) host.dispose(); hosts = []; });

async function opened(plan: () => ReturnType<typeof surfacePlan>) {
  const daemon = fakeDaemon({ 'sessions.load': () => ok({ ok: true, plan: plan(), goal: 'Ship the parser' }) });
  const host = new DaemonHost(WORKSPACE, (async (request: { choices: Array<{ id: string }> }) => request.choices[0]?.id ?? null) as never, {});
  hosts.push(host);
  await act(() => host.open('s1'));
  await act(async () => {
    daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'run_snapshot', sessionId: 's1', view: { tasks: TASKS, runMerge: null, handoff: null, mergeResult: null, activity: IDLE }, stream: 'd1', seq: 0 });
  });
  return { daemon, host };
}

const status = (tasks: Array<{ id: string; status: string }>, activity?: RunActivity) =>
  ({ type: 'status_update', tasks: tasks.map((t) => ({ ...t, verdict: null })), ...(activity ? { activity } : {}) });
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });

describe('DaemonHost plan refresh', () => {
  it('folds a status update into the run view without reading the plan again', async () => {
    const { daemon, host } = await opened(() => surfacePlan(TASKS, 'approved'));
    const loads = daemon.calls('sessions.load').length;

    await act(async () => {
      daemon.push('s1', status([{ id: 't1', status: 'in_progress' }, { id: 't2', status: 'pending' }]));
    });
    await settle();

    expect(host.getSnapshot().state.run.tasks.find((t) => t.id === 't1')?.status).toBe('in_progress');
    expect(daemon.calls('sessions.load')).toHaveLength(loads);
  });

  it('asks about a task by the status the run holds, not the plan\'s older copy', async () => {
    const { daemon, host } = await opened(() => surfacePlan(TASKS, 'approved'));
    await act(async () => { daemon.push('s1', status([{ id: 't1', status: 'failed' }], IDLE)); });

    await act(() => host.handle({ type: 'sendSystemCommand', command: 'markComplete', taskId: 't1' }));

    expect(daemon.calls('plans.executeCommand')).toContainEqual([{ sessionId: 's1' }, { command: 'mark_complete', task: 't1', confirmed: true, seen: 'failed' }]);
  });

  it('reads the plan when a status update starts the run, so the dock says it is running', async () => {
    let plan = surfacePlan(TASKS, 'approved');
    const { daemon, host } = await opened(() => plan);
    expect(host.getSnapshot().state.isExecuting).toBe(false);

    plan = surfacePlan(TASKS, 'running');
    await act(async () => {
      daemon.push('s1', status([{ id: 't1', status: 'in_progress' }], WORKING));
    });

    await waitFor(() => expect(host.getSnapshot().state.isExecuting).toBe(true));
    const loads = daemon.calls('sessions.load').length;
    await act(async () => {
      daemon.push('s1', status([{ id: 't1', status: 'completed' }, { id: 't2', status: 'in_progress' }], WORKING));
    });
    await settle();
    expect(daemon.calls('sessions.load')).toHaveLength(loads);
  });

  it('reads the plan when the run ends', async () => {
    let plan = surfacePlan(TASKS, 'running');
    const { daemon, host } = await opened(() => plan);
    await act(async () => { daemon.push('s1', status([{ id: 't1', status: 'in_progress' }], WORKING)); });
    await waitFor(() => expect(host.getSnapshot().state.isExecuting).toBe(true));

    plan = surfacePlan(TASKS.map((t) => ({ ...t, status: 'completed' as const })), 'completed');
    await act(async () => {
      daemon.push('s1', { type: 'execution_complete', summary: { completed: 2, failed: 0, skipped: 0, total: 2 } });
    });

    await waitFor(() => expect(host.getSnapshot().state.isExecuting).toBe(false));
    expect(host.getSnapshot().state.plan?.status).toBe('completed');
  });

  it('reads the plan when the planner generates one', async () => {
    let plan = surfacePlan(TASKS, 'draft');
    const { daemon, host } = await opened(() => plan);

    plan = surfacePlan([...TASKS, surfaceTask({ id: 't3', order: 3, title: 'Add MFA' })], 'draft');
    await act(async () => { daemon.push('s1', { type: 'plan_generated', plan }); });

    await waitFor(() => expect(host.getSnapshot().state.plan?.tasks.map((t) => t.id)).toEqual(['t1', 't2', 't3']));
  });

  it('reads the plan after a plan edit', async () => {
    let plan = surfacePlan(TASKS, 'draft');
    const { daemon, host } = await opened(() => plan);

    plan = surfacePlan(TASKS.filter((t) => t.id !== 't2'), 'draft');
    await act(() => host.handle({ type: 'removeTask', taskId: 't2' }));

    await waitFor(() => expect(host.getSnapshot().state.plan?.tasks.map((t) => t.id)).toEqual(['t1']));
    expect(daemon.calls('sessions.load').length).toBeGreaterThan(1);
  });

  it('reads the plan again after a reconnect', async () => {
    let plan = surfacePlan(TASKS, 'draft');
    const { daemon, host } = await opened(() => plan);
    const loads = daemon.calls('sessions.load').length;

    plan = surfacePlan([...TASKS, surfaceTask({ id: 't3', order: 3, title: 'Add MFA' })], 'draft');
    act(() => daemon.close('s1'));
    act(() => daemon.setStatus(daemon.connected));
    await act(async () => {
      daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'run_snapshot', sessionId: 's1', view: { tasks: TASKS, runMerge: null, handoff: null, mergeResult: null, activity: IDLE }, stream: 'd2', seq: 0 });
    });

    await waitFor(() => expect(host.getSnapshot().state.plan?.tasks).toHaveLength(3));
    expect(daemon.calls('sessions.load').length).toBeGreaterThan(loads);
  });
});

describe('DaemonHost watching a held session', () => {
  const SINCE = '2026-11-04T10:02:00.000Z';
  const heldBy = { ok: false, status: 409, error: 'Conflict', data: { ok: false, error: 'held', code: 'session_held', sessionHeld: { holder: { hostId: 'v1', pid: 1, host: { kind: 'vscode' }, since: SINCE, heartbeatAt: SINCE, runnerGroups: [] } } } } as const;
  const saved = (tasks: typeof TASKS, said: string[]) => ok({
    meta: { id: 's1', goal: 'Add SSO login' },
    plan: { status: 'approved', phase: 'planning', pendingTasks: tasks },
    conversation: { conversationHistory: said.map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content, timestamp: SINCE })) },
  });

  async function watching(read: () => ReturnType<typeof saved>) {
    const daemon = fakeDaemon({ 'sessions.load': heldBy, 'sessions.get': () => read() });
    const host = new DaemonHost(WORKSPACE, async () => null, { watchMs: 20 });
    hosts.push(host);
    const seen: HostToWebview[] = [];
    host.port('conversation').subscribe((msg) => seen.push(msg));
    await act(() => host.open('s1'));
    return { daemon, host, seen };
  }
  const count = (seen: HostToWebview[], type: HostToWebview['type']) => seen.filter((m) => m.type === type).length;
  const polls = (daemon: ReturnType<typeof fakeDaemon>) => waitFor(() => expect(daemon.calls('sessions.get').length).toBeGreaterThan(4));

  it('draws nothing again while the holder saved nothing', async () => {
    const { daemon, seen } = await watching(() => saved(TASKS, ['Add SSO login']));
    const plans = count(seen, 'planUpdated');
    const patches = count(seen, 'conversationPatch');
    expect(plans).toBeGreaterThan(0);

    await polls(daemon);

    expect(count(seen, 'planUpdated')).toBe(plans);
    expect(count(seen, 'conversationPatch')).toBe(patches);
  });

  it('redraws only the conversation when only the conversation changed', async () => {
    let said = ['Add SSO login'];
    const { daemon, host, seen } = await watching(() => saved(TASKS, said));
    const plans = count(seen, 'planUpdated');
    const baseline = host.getSnapshot().state.conversation.order.length;

    said = ['Add SSO login', 'Two tasks to start.'];
    await waitFor(() => expect(host.getSnapshot().state.conversation.order.length).toBeGreaterThan(baseline));
    await polls(daemon);

    expect(count(seen, 'planUpdated')).toBe(plans);
  });

  it('redraws only the plan when only the plan changed', async () => {
    let tasks = TASKS;
    const { daemon, host, seen } = await watching(() => saved(tasks, ['Add SSO login']));
    const patches = count(seen, 'conversationPatch');
    const plans = count(seen, 'planUpdated');

    tasks = [...TASKS, surfaceTask({ id: 't3', order: 3, title: 'Add MFA' })];
    await waitFor(() => expect(host.getSnapshot().state.plan?.tasks).toHaveLength(3));
    await polls(daemon);

    expect(count(seen, 'planUpdated')).toBeGreaterThan(plans);
    expect(count(seen, 'conversationPatch')).toBe(patches);
  });
});

