import { describe, expect, it } from 'vitest';
import { buildGraph } from '../graphModel';
import { nodeCommands } from '../nodeCommands';
import { runTask } from './fixtures';
import type { RunTask } from '@ordewell/core';

function commandsOf(task: RunTask, expanded = false): string[] {
  const model = buildGraph([task], { expanded: new Set(), executing: true, handoffPending: false });
  if (!model.ok) throw new Error(model.reason);
  return nodeCommands(model.nodes[0]!, expanded).map((c) => c.id);
}

describe('nodeCommands', () => {
  it('offers a running task Message and Stop', () => {
    const ids = commandsOf(runTask({ id: 'a', order: 1, type: 'ai', assignedRunner: 'claude-code', status: 'in_progress', attempted: true }));
    expect(ids).toContain('stop');
    expect(ids).not.toContain('retry');
  });

  it('offers a failed AI task Retry and Skip', () => {
    const ids = commandsOf(runTask({ id: 'a', order: 1, type: 'ai', assignedRunner: 'claude-code', status: 'failed', attempted: true }));
    expect(ids).toContain('retry');
    expect(ids).toContain('skip');
    expect(ids).not.toContain('stop');
  });

  it('offers a task that has not started neither Stop nor Retry', () => {
    const ids = commandsOf(runTask({ id: 'a', order: 1, type: 'ai', assignedRunner: 'claude-code' }));
    expect(ids).not.toContain('stop');
    expect(ids).not.toContain('retry');
  });

  it('offers the diff of a task that worked in isolation', () => {
    expect(commandsOf(runTask({ id: 'a', order: 1, status: 'completed', isolation: { state: 'integrated' } as never }))).toContain('diff');
    expect(commandsOf(runTask({ id: 'a', order: 1, status: 'completed' }))).not.toContain('diff');
  });

  it('offers a fold only to a node that holds something, worded by its state', () => {
    const task = runTask({ id: 'p', order: 1, subtasks: [runTask({ id: 'p1', order: 1 })] });
    const model = buildGraph([task], { expanded: new Set(), executing: false, handoffPending: false });
    if (!model.ok) throw new Error('fixture');
    expect(nodeCommands(model.nodes[0]!, false).find((c) => c.id === 'fold')?.label).toBe('Expand subtasks');
    expect(nodeCommands(model.nodes[0]!, true).find((c) => c.id === 'fold')?.label).toBe('Fold subtasks');
    expect(commandsOf(runTask({ id: 'a', order: 1 }))).not.toContain('fold');
  });
});
