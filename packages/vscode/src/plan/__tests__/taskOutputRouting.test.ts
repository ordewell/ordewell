import { describe, it, expect, vi } from 'vitest';
import { handleSessionMessage } from '../PlanManager';
import type { PlanManagerDeps } from '../PlanManager';
import type { SessionMessage } from '@ordewell/core';

function deps(): PlanManagerDeps & { chatProvider: { sendTaskOutput: ReturnType<typeof vi.fn> } } {
  return {
    session: {} as PlanManagerDeps['session'],
    chatProvider: { sendTaskOutput: vi.fn(), sendNewMessage: vi.fn(), showCheckpoint: vi.fn() },
    isGeneratingPlan: () => false,
  } as unknown as PlanManagerDeps & { chatProvider: { sendTaskOutput: ReturnType<typeof vi.fn> } };
}

const output = (taskId: string, text: string): SessionMessage => ({ type: 'task_output', taskId, text });

describe('task_output routing (F8)', () => {
  it('forwards runner output to the webview instead of dropping it', () => {
    const d = deps();
    handleSessionMessage(output('t1', 'compiling…\n'), d);

    expect(d.chatProvider.sendTaskOutput).toHaveBeenCalledWith('t1', 'compiling…\n');
  });

  it('forwards every chunk, so the webview owns the tail cap', () => {
    const d = deps();
    handleSessionMessage(output('t1', 'first\n'), d);
    handleSessionMessage(output('t1', 'second\n'), d);
    handleSessionMessage(output('t2', 'other\n'), d);

    expect(d.chatProvider.sendTaskOutput.mock.calls).toEqual([
      ['t1', 'first\n'],
      ['t1', 'second\n'],
      ['t2', 'other\n'],
    ]);
  });

  it('does not claim the message as a planner-stream variant', () => {
    const d = deps();
    handleSessionMessage(output('t1', 'x'), d);

    expect(d.chatProvider.sendNewMessage).not.toHaveBeenCalled();
  });
});
