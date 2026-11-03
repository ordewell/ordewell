import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonHost } from '../../../session/DaemonHost';
import { fakeDaemon, ok, surfacePlan, surfaceTask } from '../../../session/__tests__/fakeDaemon';
import { Sessions } from '../PlanSidebar';

let hosts: DaemonHost[] = [];
afterEach(() => { for (const host of hosts) host.dispose(); hosts = []; });

const TASKS = [surfaceTask({ id: 't1', order: 1, title: 'Parse the config' })];

describe('Sessions', () => {
  it('shows the open session\'s row as its plan moves on, not as it was first listed', async () => {
    let status = 'draft';
    const daemon = fakeDaemon({
      'sessions.load': () => ok({ ok: true, plan: surfacePlan(TASKS, status === 'draft' ? 'draft' : 'running'), goal: 'Ship the parser' }),
      'sessions.list': () => ok([{ id: 's1', goal: 'Ship the parser', status, taskCount: 1, updatedAt: '2026-11-03T09:00:00.000Z' }]),
    });
    const host = new DaemonHost('/work/acme');
    hosts.push(host);
    await act(() => host.open('s1'));
    render(<Sessions host={host} />);
    expect(await screen.findByRole('button', { name: /Ship the parser draft/ })).toBeInTheDocument();

    // Approving starts the run: the daemon's row says so, and nothing about the session or its goal changed.
    status = 'running';
    await act(async () => {
      daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'status_update', tasks: [{ id: 't1', status: 'in_progress', verdict: null }], stream: 'd1', seq: 1 });
    });
    expect(await screen.findByRole('button', { name: /Ship the parser running/ })).toBeInTheDocument();
  });
});
