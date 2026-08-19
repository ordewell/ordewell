import { describe, it, expect, vi } from 'vitest';
import { handleSessionMessage } from '../PlanManager';
import type { PlanManagerDeps } from '../PlanManager';
import type { SessionMessage, LegacyPlanState, SerializedTaskStatus } from '@ordewell/core';

function deps(): PlanManagerDeps & { chatProvider: { sendTaskIdle: ReturnType<typeof vi.fn>; showPlan: ReturnType<typeof vi.fn> } } {
  const plan = { status: 'draft', tasks: [] } as unknown as LegacyPlanState;
  return {
    session: { isExecuting: true, status: 'running' } as unknown as PlanManagerDeps['session'],
    chatProvider: { sendTaskIdle: vi.fn(), showPlan: vi.fn() },
    getCurrentPlan: () => plan,
    isGeneratingPlan: () => false,
  } as unknown as PlanManagerDeps & { chatProvider: { sendTaskIdle: ReturnType<typeof vi.fn>; showPlan: ReturnType<typeof vi.fn> } };
}

const statusUpdate = (tasks: SerializedTaskStatus[]): SessionMessage => ({ type: 'status_update', tasks });

describe('status_update idleSince routing', () => {
  it('forwards each task\'s idleSince to the webview', () => {
    const d = deps();
    handleSessionMessage(statusUpdate([
      { id: 't1', status: 'in_progress', verdict: null, idleSince: '2026-08-18T00:00:00.000Z' },
      { id: 't2', status: 'in_progress', verdict: null, idleSince: null },
    ]), d);

    expect(d.chatProvider.sendTaskIdle.mock.calls).toEqual([
      ['t1', '2026-08-18T00:00:00.000Z'],
      ['t2', null],
    ]);
  });

  it('treats a missing idleSince as cleared, not stuck', () => {
    const d = deps();
    handleSessionMessage(statusUpdate([{ id: 't1', status: 'completed', verdict: null }]), d);

    expect(d.chatProvider.sendTaskIdle).toHaveBeenCalledWith('t1', null);
  });
});
