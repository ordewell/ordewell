import { act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunActivity } from '@ordewell/core';
import { DaemonHost } from '../DaemonHost';
import { fakeDaemon, ok, surfacePlan, surfaceTask } from './fakeDaemon';

const WORKSPACE = '/work/acme';
const TASKS = [
  surfaceTask({ id: 't1', order: 1, title: 'Parse the config', assignedRunner: 'claude-code' }),
  surfaceTask({ id: 't2', order: 2, title: 'Wire the CLI', dependencies: ['t1'] }),
];
const IDLE: RunActivity = { starting: false, running: false, scheduled: false, resumable: false, advancesOnItsOwn: false };
let hosts: DaemonHost[] = [];
afterEach(() => { for (const host of hosts) host.dispose(); hosts = []; });

describe('an edit made on another surface', () => {
  it('shows the new title once the daemon announces it', async () => {
    let plan = surfacePlan(TASKS, 'approved');
    const daemon = fakeDaemon({ 'sessions.load': () => ok({ ok: true, plan, goal: 'Ship the parser' }) });
    const host = new DaemonHost(WORKSPACE, (async () => null) as never, {});
    hosts.push(host);
    await act(() => host.open('s1'));
    await act(async () => {
      daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'run_snapshot', sessionId: 's1', view: { tasks: TASKS, runMerge: null, handoff: null, mergeResult: null, activity: IDLE }, stream: 'd1', seq: 0 });
    });
    // The TUI renames t2: core saves, then broadcasts a status_update and task_updated (no plan_generated).
    plan = surfacePlan(TASKS.map((t) => (t.id === 't2' ? { ...t, title: 'Wire the CLI, renamed' } : t)), 'approved');
    await act(async () => {
      daemon.push('s1',
        { type: 'status_update', tasks: [{ id: 't1', status: 'pending', verdict: null }, { id: 't2', status: 'pending', verdict: null }], activity: IDLE },
        { type: 'task_updated', taskId: 't2', changes: { title: 'Wire the CLI, renamed' } });
    });
    await waitFor(() => expect(host.getSnapshot().state.plan?.tasks.find((t) => t.id === 't2')?.title).toBe('Wire the CLI, renamed'), { timeout: 2000 });
  });
});
