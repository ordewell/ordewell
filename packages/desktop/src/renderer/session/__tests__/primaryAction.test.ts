import { describe, expect, it } from 'vitest';
import type { SurfacePlan } from '@ordewell/core';
import { INITIAL_HOST_STATE, type HostState } from '@ordewell/ui';
import { primaryAction, runActions } from '../primaryAction';
import { surfacePlan, surfaceTask } from './fakeDaemon';

const TASKS = [
  surfaceTask({ id: 't1', order: 1, title: 'Parse the config' }),
  surfaceTask({ id: 't2', order: 2, title: 'Wire the CLI' }),
];

function stateOf(status: SurfacePlan['status'], changes: Partial<HostState> = {}): HostState {
  return { ...INITIAL_HOST_STATE, plan: surfacePlan(TASKS, status), ...changes };
}

const HANDOFF = { repos: [], landed: [{ taskId: 't1', order: 1, title: 'Parse the config' }] };

describe('the session\'s run actions', () => {
  it('offers nothing with no plan', () => {
    expect(runActions(INITIAL_HOST_STATE).size).toBe(0);
    expect(primaryAction(runActions(INITIAL_HOST_STATE))).toBeUndefined();
  });

  it('asks for approval of a draft before anything runs', () => {
    expect([...runActions(stateOf('draft'))]).toEqual(['approve']);
  });

  it('offers Run while an approved plan has work left, and nothing once all of it is done', () => {
    expect(primaryAction(runActions(stateOf('approved')))).toBe('run');
    const done = stateOf('approved', { plan: surfacePlan(TASKS.map((t) => ({ ...t, status: 'completed' })), 'approved') });
    expect(runActions(done).size).toBe(0);
  });

  it('offers Stop, not a start, while the run is executing', () => {
    expect([...runActions(stateOf('approved', { isExecuting: true }))]).toEqual(['stop']);
  });

  it('offers Merge all for a handoff, behind a start that is still owed', () => {
    const handedOff = stateOf('approved', { run: { ...INITIAL_HOST_STATE.run, handoff: HANDOFF } });
    expect(runActions(handedOff)).toEqual(new Set(['run', 'merge']));
    expect(primaryAction(runActions(handedOff))).toBe('run');
    const allDone = { ...handedOff, plan: surfacePlan(TASKS.map((t) => ({ ...t, status: 'completed' })), 'approved') };
    expect(primaryAction(runActions(allDone))).toBe('merge');
  });

  it('ranks Approve plan, then Run, then Stop, then Merge all', () => {
    expect(primaryAction(new Set(['merge', 'stop', 'run', 'approve']))).toBe('approve');
    expect(primaryAction(new Set(['merge', 'stop', 'run']))).toBe('run');
    expect(primaryAction(new Set(['merge', 'stop']))).toBe('stop');
    expect(primaryAction(new Set(['merge']))).toBe('merge');
  });
});
