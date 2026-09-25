import { describe, it, expect, vi } from 'vitest';
import { handleSessionMessage } from '../PlanManager';
import type { PlanManagerDeps } from '../PlanManager';
import { replayIsolation } from '../isolation';
import type { IsolationView, TaskIsolation } from '@ordewell/core';

function deps() {
  const chatProvider = {
    sendTaskIdle: vi.fn(),
    sendTaskIsolation: vi.fn(),
    showIsolationHandoff: vi.fn(),
    showPlan: vi.fn(),
  };
  const plan = { status: 'draft', tasks: [] };
  const d = {
    session: { isExecuting: true, status: 'running' },
    chatProvider,
    getCurrentPlan: () => plan,
    isGeneratingPlan: () => false,
  } as unknown as PlanManagerDeps;
  return { d, chatProvider };
}

describe('worktree isolation messages (ADR-0013)', () => {
  it('forwards each task\'s isolation to the webview', () => {
    const { d, chatProvider } = deps();
    const conflict: TaskIsolation = { state: 'conflict', branch: 'ordewell/r/1-a', worktree: '/w/1-a' };

    handleSessionMessage({
      type: 'status_update',
      tasks: [
        { id: 't1', status: 'awaiting_user', verdict: null, isolation: conflict },
        { id: 't2', status: 'in_progress', verdict: null },
      ],
    }, d);

    // Only the task that has one: a shared-root plan stays quiet.
    expect(chatProvider.sendTaskIsolation.mock.calls).toEqual([['t1', conflict]]);
  });

  it('posts the end-of-run handoff to the webview', () => {
    const { d, chatProvider } = deps();
    const handoff = {
      branch: 'ordewell/r/integration',
      baseRef: 'abc123',
      landed: [{ taskId: 't1', order: 1, title: 'A' }],
    };

    handleSessionMessage({ type: 'isolation_handoff', ...handoff }, d);

    expect(chatProvider.showIsolationHandoff).toHaveBeenCalledWith(handoff);
  });
});

// The stream only reports changes, and a webview loses its state whenever it is
// disposed — so a reconnect or a loaded session is re-told from the run record.
describe('replaying isolation to a webview that was not listening', () => {
  const view: IsolationView = {
    tasks: { t2: { state: 'conflict', branch: 'ordewell/r/2-b', worktree: '/w/2-b' } },
    handoff: { branch: 'ordewell/r/integration', baseRef: 'abc123', landed: [{ taskId: 't1', order: 1, title: 'A' }] },
  };

  function replay(opts: { view: IsolationView | null; executing: boolean }) {
    const chatProvider = { sendTaskIsolation: vi.fn(), showIsolationHandoff: vi.fn() };
    replayIsolation({ isolationView: () => opts.view, isExecuting: opts.executing }, chatProvider);
    return chatProvider;
  }

  it('re-sends every task mark and the handoff card of a settled run', () => {
    const chatProvider = replay({ view, executing: false });

    expect(chatProvider.sendTaskIsolation.mock.calls).toEqual([['t2', view.tasks.t2]]);
    expect(chatProvider.showIsolationHandoff).toHaveBeenCalledWith(view.handoff);
  });

  it('holds the handoff card back while the run is still executing', () => {
    const chatProvider = replay({ view, executing: true });

    expect(chatProvider.sendTaskIsolation).toHaveBeenCalledTimes(1);
    expect(chatProvider.showIsolationHandoff).not.toHaveBeenCalled();
  });

  it('says nothing for a plan that never isolated', () => {
    const chatProvider = replay({ view: null, executing: false });

    expect(chatProvider.sendTaskIsolation).not.toHaveBeenCalled();
    expect(chatProvider.showIsolationHandoff).not.toHaveBeenCalled();
  });
});
