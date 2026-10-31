import { describe, expect, it } from 'vitest';
import { makeSession, saves, testWorkspace } from './sessionTestKit';
import { plan, task } from './supervisorTestKit';

/**
 * A load the orchestrator refuses (a task assigned to a runner outside the
 * plan's set) must leave the Session as it was, and must never write the old
 * plan's tasks under the picked session's id.
 */
describe('a load the orchestrator refuses', () => {
  function mismatched() {
    const loaded = plan([task('loaded-1', 1, { assignedRunner: 'gemini' })]);
    loaded.runners = ['claude-code'];
    return loaded;
  }

  it('leaves the plan, the store and the session id as they were', () => {
    const session = makeSession();
    session.loadPlan(plan([task('shown-1', 1)]), 'on screen', testWorkspace, { sessionId: 'session-on-screen' });

    expect(() => session.loadPlan(mismatched(), 'picked', testWorkspace, { sessionId: 'session-picked' })).toThrow(/runner set/);

    expect(session.planState?.tasks.map((t) => t.id)).toEqual(['shown-1']);
    expect(session.planTasks.map((t) => t.id)).toEqual(['shown-1']);
    expect(session.sessionId).toBe('session-on-screen');
  });

  it('writes nothing of the picked session', () => {
    const session = makeSession();

    expect(() => session.loadPlan(mismatched(), 'picked', testWorkspace, { sessionId: 'session-picked' })).toThrow(/runner set/);

    expect(saves(session)).not.toHaveBeenCalled();
  });

  it('does not write the plan on screen into the picked session on the next save', () => {
    const session = makeSession();
    session.loadPlan(plan([task('shown-1', 1)]), 'on screen', testWorkspace, { sessionId: 'session-on-screen' });
    expect(() => session.loadPlan(mismatched(), 'picked', testWorkspace, { sessionId: 'session-picked' })).toThrow(/runner set/);

    session.stopExecution();

    const last = saves(session).mock.calls.at(-1);
    expect(last?.[1]).toBe('on screen');
    expect(last?.[3]).toBe('session-on-screen');
    expect(last?.[0].tasks.map((t) => t.id)).toEqual(['shown-1']);
  });
});
