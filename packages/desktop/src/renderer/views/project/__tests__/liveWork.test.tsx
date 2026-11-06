import type { Escalation } from '@ordewell/core';
import { INITIAL_HOST_STATE, type HostState } from '@ordewell/ui';
import { act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { daemonHost, resetDaemonHosts } from '../../../session/DaemonHost';
import { fakeDaemon, ok, surfacePlan, surfaceTask } from '../../../session/__tests__/fakeDaemon';
import { liveWorkKinds, register } from '../liveWork';

const APPROVAL: Escalation = {
  id: 'approval:t2:1:a1',
  kind: 'approval',
  task: { id: 't2', ref: '#2', title: 'Add SAML callback route' },
  attempt: 1,
  approval: 'a1',
  reason: 'Its runner asks: npm i saml2-js',
  options: [{ id: 'allow', label: 'Allow' }],
};

const state = (changes: Partial<HostState>): HostState => ({ ...INITIAL_HOST_STATE, ...changes });

describe('what a window says it has live', () => {
  it('has nothing live in a fresh session', () => {
    expect(liveWorkKinds(INITIAL_HOST_STATE)).toEqual([]);
  });

  it('names a run, a wait in Needs you, an open checkpoint and a planner turn', () => {
    expect(liveWorkKinds(state({ isExecuting: true }))).toEqual(['run']);
    expect(liveWorkKinds(state({ run: { ...INITIAL_HOST_STATE.run, activity: { ...INITIAL_HOST_STATE.activity, scheduled: true } } }))).toEqual(['run']);
    expect(liveWorkKinds(state({ run: { ...INITIAL_HOST_STATE.run, escalations: [APPROVAL] } }))).toEqual(['needsYou']);
    expect(liveWorkKinds(state({ checkpoint: { taskId: 't1', taskTitle: 'Plan', summary: 's', pausedAt: 1, delegated: false } }))).toEqual(['checkpoint']);
    expect(liveWorkKinds(state({ isResearchActive: true }))).toEqual(['planner']);
  });

  it('lists every kind at once in a fixed order', () => {
    expect(liveWorkKinds(state({ isResearchActive: true, isExecuting: true, run: { ...INITIAL_HOST_STATE.run, escalations: [APPROVAL] } })))
      .toEqual(['run', 'needsYou', 'planner']);
  });
});

describe('the live-work report', () => {
  afterEach(() => resetDaemonHosts());

  it('tells main what the window has live, and again only when that changes', async () => {
    const plan = surfacePlan([surfaceTask({ id: 't1', order: 1, title: 'Read the auth module' })], 'running');
    const daemon = fakeDaemon({ 'sessions.load': ok({ ok: true, plan, goal: 'Add SSO login' }) });
    const off = register({ workspace: '/work/acme' } as Parameters<typeof register>[0]);
    try {
      // Main starts each window with nothing live, so there is nothing to say yet.
      expect(daemon.reportLiveWork).not.toHaveBeenCalled();
      const host = daemonHost('/work/acme');
      await act(() => host.open('s1'));
      await act(async () => {
        daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'run_snapshot', sessionId: 's1', view: { tasks: plan.tasks, runMerge: null, handoff: null, mergeResult: null, escalations: [APPROVAL] }, stream: 'd1', seq: 0 });
      });
      expect(daemon.reportLiveWork.mock.calls.at(-1)).toEqual([['run', 'needsYou']]);
      const reports = daemon.reportLiveWork.mock.calls.length;
      await act(async () => { daemon.push('s1', { type: 'connected', sessionId: 's1' }); });
      expect(daemon.reportLiveWork.mock.calls).toHaveLength(reports);
    } finally {
      off();
    }
  });
});
