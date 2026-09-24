import { describe, it, expect, vi } from 'vitest';
import { handleSessionMessage } from '../PlanManager';
import type { PlanManagerDeps } from '../PlanManager';
import type { TaskIsolation } from '@ordewell/core';

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
