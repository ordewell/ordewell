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
    showIsolationMergeResult: vi.fn(),
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
    const conflict: TaskIsolation = { state: 'conflict', branch: 'ordewell/r/1-a', worktree: '/w/1-a', repos: [], conflictRepo: '.' };

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
    const landed = [{ taskId: 't1', order: 1, title: 'A' }];
    const handoff = {
      repos: [{ path: '.', integrationBranch: 'ordewell/r/integration', baseRef: 'abc123', landed }],
      landed,
    };

    handleSessionMessage({ type: 'isolation_handoff', ...handoff }, d);

    expect(chatProvider.showIsolationHandoff).toHaveBeenCalledWith(handoff);
  });

  it('posts a repo group handoff with each repo its own work', () => {
    const { d, chatProvider } = deps();
    const apiLanded = [{ taskId: 't1', order: 1, title: 'A' }];
    const webLanded = [{ taskId: 't2', order: 2, title: 'B' }];
    const handoff = {
      repos: [
        { path: 'api', integrationBranch: 'ordewell/r/integration', baseRef: 'aaa111', landed: apiLanded },
        { path: 'web', integrationBranch: 'ordewell/r/integration', baseRef: 'bbb222', landed: webLanded },
      ],
      landed: [...apiLanded, ...webLanded],
    };

    handleSessionMessage({ type: 'isolation_handoff', ...handoff }, d);

    expect(chatProvider.showIsolationHandoff).toHaveBeenCalledWith(handoff);
  });

  it('forwards a blocked Merge all result with every repo it names', () => {
    const { d, chatProvider } = deps();
    const result = {
      outcome: 'blocked' as const,
      blocked: [
        { repo: 'api', reason: 'conflict' as const, files: ['src/a.ts'] },
        { repo: 'web', reason: 'uncommitted-changes' as const, files: ['src/b.ts'] },
      ],
    };

    handleSessionMessage({ type: 'isolation_merge', result }, d);

    expect(chatProvider.showIsolationMergeResult).toHaveBeenCalledWith(result);
  });
});

// The stream only reports changes, and a webview loses its state whenever it is
// disposed — so a reconnect or a loaded session is re-told from the run record.
describe('replaying isolation to a webview that was not listening', () => {
  const view: IsolationView = {
    tasks: { t2: { state: 'conflict', branch: 'ordewell/r/2-b', worktree: '/w/2-b', repos: [], conflictRepo: '.' } },
    handoff: {
      repos: [{ path: '.', integrationBranch: 'ordewell/r/integration', baseRef: 'abc123', landed: [{ taskId: 't1', order: 1, title: 'A' }] }],
      landed: [{ taskId: 't1', order: 1, title: 'A' }],
    },
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

  it('replays a repo group mark and handoff, naming each repo', () => {
    const group: IsolationView = {
      tasks: { t1: { state: 'conflict', branch: 'ordewell/r/1-a', worktree: '/w/1-a', repos: ['api', 'web'], conflictRepo: 'api' } },
      handoff: {
        repos: [
          { path: 'api', integrationBranch: 'ordewell/r/integration', baseRef: 'aaa111', landed: [{ taskId: 't1', order: 1, title: 'A' }] },
          { path: 'web', integrationBranch: 'ordewell/r/integration', baseRef: 'bbb222', landed: [] },
        ],
        landed: [{ taskId: 't1', order: 1, title: 'A' }],
      },
    };
    const chatProvider = replay({ view: group, executing: false });

    expect(chatProvider.sendTaskIsolation.mock.calls).toEqual([['t1', group.tasks.t1]]);
    expect(chatProvider.showIsolationHandoff).toHaveBeenCalledWith(group.handoff);
  });
});
