import { describe, it, expect, vi } from 'vitest';
import { handleSessionMessage } from '../PlanManager';
import type { PlanManagerDeps } from '../PlanManager';
import type { SessionMessage } from '@ordewell/core';
import { SessionView } from '@ordewell/ui/host';
import type { HostToWebview } from '@ordewell/ui/protocol';

function deps(): PlanManagerDeps & { posted: () => [string, string][] } {
  const post = vi.fn<(msg: HostToWebview) => void>();
  return {
    session: {} as PlanManagerDeps['session'],
    chatProvider: { view: new SessionView(post) },
    isGeneratingPlan: () => false,
    posted: () => post.mock.calls.flatMap(([msg]) => (msg.type === 'taskOutput' ? [[msg.taskId, msg.text] as [string, string]] : [])),
  } as unknown as PlanManagerDeps & { posted: () => [string, string][] };
}

const output = (taskId: string, text: string): SessionMessage => ({ type: 'task_output', taskId, text });

describe('task_output routing (F8)', () => {
  it('forwards runner output to the webview instead of dropping it', () => {
    const d = deps();
    handleSessionMessage(output('t1', 'compiling…\n'), d);

    expect(d.posted()).toEqual([['t1', 'compiling…\n']]);
  });

  it('forwards every chunk, so the webview owns the tail cap', () => {
    const d = deps();
    handleSessionMessage(output('t1', 'first\n'), d);
    handleSessionMessage(output('t1', 'second\n'), d);
    handleSessionMessage(output('t2', 'other\n'), d);

    expect(d.posted()).toEqual([
      ['t1', 'first\n'],
      ['t1', 'second\n'],
      ['t2', 'other\n'],
    ]);
  });
});
