import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TaskCard from '../TaskCard';
import SubTaskCard from '../SubTaskCard';
import type { Task, TaskIsolation } from '@ordewell/core';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1', order: 1, title: 'Test task', description: 'A task', type: 'ai', status: 'pending',
    dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build',
    ...overrides,
  };
}

const noop = () => {};
const handlers = {
  onCancel: noop, onSkip: noop, onForceStart: noop, onMarkComplete: noop, onMarkIncomplete: noop, onOpsChange: noop,
};
const isolated = { branch: 'ordewell/t1', worktree: '/wt/t1', repos: ['.'] };
const buttons = (): string[] =>
  Array.from(document.querySelectorAll('.task-actions button')).map((b) => b.textContent ?? '');
const badge = (): Element | null => document.querySelector('.task-status-badge');

describe('a task card, pinned before its rules move to core', () => {
  it.each([
    ['completed', 'Done', 'status-completed'],
    ['failed', 'Failed', 'status-failed'],
    ['in_progress', 'Running', 'status-running'],
    ['blocked', 'Blocked', 'status-blocked'],
    ['pending', 'To do', 'status-pending'],
    ['approved', 'To do', 'status-pending'],
    ['awaiting_user', 'Awaiting User', 'status-blocked'],
  ] as const)('%s reads "%s"', (status, label, cls) => {
    render(<TaskCard task={makeTask({ status })} models={[]} isExecuting />);
    expect(badge()?.textContent).toBe(label);
    expect(badge()?.className).toBe(`task-status-badge ${cls}`);
  });

  it('reads Stalled while running with no recent output', () => {
    render(<TaskCard task={makeTask({ status: 'in_progress' })} models={[]} isExecuting idleSince="2026-01-01T00:00:00Z" />);
    expect(badge()?.textContent).toBe('Stalled');
    expect(badge()?.className).toBe('task-status-badge status-stalled');
    expect(document.querySelector('.task-check')?.getAttribute('title')).toBe('Stalled — no output recently');
  });

  it.each([
    ['completed', 'Executed'],
    ['in_progress', 'Running'],
    ['pending', 'To do'],
    ['failed', 'To do'],
  ] as const)('the check on a %s task is titled "%s"', (status, title) => {
    render(<TaskCard task={makeTask({ status })} models={[]} />);
    expect(document.querySelector('.task-check')?.getAttribute('title')).toBe(title);
  });

  it('labels an ops task that changed tracked files, and says what to do', () => {
    render(<TaskCard task={makeTask({ status: 'awaiting_user', awaitingReason: 'files-changed', ops: true })} models={[]} isExecuting expanded onExpandedChange={noop} />);
    expect(badge()?.textContent).toBe('Changed tracked files');
    expect(document.querySelector('.task-ops-note.warn')?.textContent)
      .toBe('This ops task changed tracked files in your checkout, and nothing was committed. Check the changes, then mark it complete or retry it.');
  });

  it('counts approvals beyond one', () => {
    render(<TaskCard task={makeTask({ status: 'in_progress' })} models={[]} isExecuting awaitingApproval={3} />);
    expect(document.querySelector('.task-approval-badge')?.textContent).toBe('Waiting for approval (3)');
  });

  it('badges an ops task, never a manual one', () => {
    const { unmount } = render(<TaskCard task={makeTask({ ops: true })} models={[]} />);
    expect(document.querySelector('.task-type-badge.ops')?.textContent).toBe('Ops');
    unmount();
    render(<TaskCard task={makeTask({ ops: true, type: 'user' })} models={[]} />);
    expect(document.querySelector('.task-type-badge.ops')).toBeNull();
  });

  it('names what a merge gate waits on', () => {
    render(<TaskCard task={makeTask({ id: 'o2', order: 2 })} models={[]} mergeGate={['t1', 'ghost']} taskOrderMap={new Map([['t1', 1]])} />);
    const gate = document.querySelector('.task-isolation-badge.gate');
    expect(gate?.textContent).toBe('Waits for Merge all');
    expect(gate?.getAttribute('title')).toBe('The work of #1, ghost is not merged into your branch yet. Merge all lets this task go on.');
  });

  it.each([
    ['api', 'Conflict in api', 'Integrating this task conflicted in api: a.ts, b.ts. Its worktree and branch are kept.'],
    ['.', 'Conflict', 'Integrating this task conflicted: a.ts, b.ts. Its worktree and branch are kept.'],
  ])('badges a conflict in %s', (conflictRepo, text, title) => {
    const isolation: TaskIsolation = { ...isolated, state: 'conflict', conflictRepo, conflictFiles: ['a.ts', 'b.ts'] };
    render(<TaskCard task={makeTask({ status: 'awaiting_user' })} models={[]} isolation={isolation} />);
    const el = document.querySelector('.task-isolation-badge.conflict');
    expect(el?.textContent).toBe(text);
    expect(el?.getAttribute('title')).toBe(title);
  });

  it.each([
    [{ attempt: 1, limit: 3 }, 'Repairing (1 of 3)'],
    [undefined, 'Repairing'],
  ])('badges a repair in flight', (repair, text) => {
    const isolation: TaskIsolation = { ...isolated, state: 'repairing', conflictFiles: ['a.ts'], repair };
    render(<TaskCard task={makeTask({ status: 'in_progress' })} models={[]} isolation={isolation} />);
    const el = document.querySelector('.task-isolation-badge.repairing');
    expect(el?.textContent).toBe(text);
    expect(el?.getAttribute('title')).toBe('Repairing the conflict in its own worktree: a.ts.');
  });

  it('notes the files a repair was for in the details', () => {
    const isolation: TaskIsolation = { ...isolated, state: 'integrated', repairedFiles: ['a.ts'] };
    render(<TaskCard task={makeTask({ status: 'completed' })} models={[]} isolation={isolation} expanded onExpandedChange={noop} />);
    expect(document.querySelector('.task-isolation-repaired-note')?.textContent).toBe('Landed after repairing a conflict in a.ts.');
  });

  it('notes a force start past the merge gate', () => {
    render(<TaskCard task={makeTask({ status: 'in_progress', forcedPastGate: ['Fix', 'Bump'] })} models={[]} expanded onExpandedChange={noop} />);
    expect(screen.getByText('Force-started before the work of Fix, Bump was merged into your branch.')).toBeTruthy();
  });

  it('names dependencies by order, and an unknown one by its id', () => {
    render(<TaskCard task={makeTask({ id: 't3', order: 3, dependencies: ['t1', 'ghost'] })} models={[]} isExecuting
      taskOrderMap={new Map([['t1', 1]])} expanded onExpandedChange={noop} />);
    expect(document.querySelector('.task-dep-badge.dep-in')?.getAttribute('title')).toBe('Depends on: #1, ghost');
    expect(document.querySelector('.task-deps')?.textContent).toBe('Depends on: #1, ghost');
  });

  it.each([
    ['in_progress', 'ai', ['Cancel']],
    ['blocked', 'ai', ['Skip', 'Start']],
    ['pending', 'ai', ['Start']],
    ['approved', 'ai', ['Start']],
    ['awaiting_user', 'ai', ['Mark Complete']],
    ['completed', 'ai', ['Mark Not Done']],
    ['failed', 'ai', []],
    ['pending', 'user', ['Mark Complete']],
    ['blocked', 'user', ['Skip', 'Mark Complete']],
    ['completed', 'user', ['Mark Complete', 'Mark Not Done']],
  ] as const)('a running plan offers a %s %s task %j', (status, type, offered) => {
    render(<TaskCard task={makeTask({ status, type })} models={[]} isExecuting expanded onExpandedChange={noop} {...handlers} />);
    expect(buttons()).toEqual(offered);
  });

  it.each([
    ['pending', true],
    ['approved', true],
    ['blocked', true],
    ['in_progress', false],
    ['awaiting_user', false],
    ['completed', false],
    ['failed', false],
  ] as const)('offers the ops toggle on a %s task: %s', (status, offered) => {
    render(<TaskCard task={makeTask({ status })} models={[]} expanded onExpandedChange={noop} {...handlers} />);
    expect(document.querySelector('.task-ops-toggle') !== null).toBe(offered);
  });
});

describe('a subtask card, pinned before its rules move to core', () => {
  const parent = makeTask({ id: 'p1', order: 2 });
  const open = (sub: Task) => {
    render(<SubTaskCard task={sub} parentTask={parent} models={[]} isExecuting {...handlers} />);
    fireEvent.click(document.querySelector('.subtask-card-header')!);
  };

  it.each([
    ['in_progress', 'ai', ['Cancel', 'Mark Complete']],
    ['pending', 'ai', ['Force Start', 'Skip']],
    ['approved', 'ai', ['Force Start', 'Skip']],
    ['pending', 'user', ['Skip']],
    ['awaiting_user', 'ai', ['Verify / Mark Complete']],
    ['completed', 'ai', ['Mark Not Done']],
    ['blocked', 'ai', []],
    ['failed', 'ai', []],
  ] as const)('a running plan offers a %s %s subtask %j', (status, type, offered) => {
    open(makeTask({ id: 's1', status, type }));
    expect(buttons()).toEqual(offered);
  });

  it.each([
    ['completed', 'Done'],
    ['in_progress', 'Running'],
    ['awaiting_user', 'Awaiting User'],
    ['pending', 'To do'],
  ] as const)('a %s subtask reads "%s", and is never stalled', (status, label) => {
    render(<SubTaskCard task={makeTask({ id: 's1', status })} parentTask={parent} models={[]} isExecuting />);
    expect(badge()?.textContent).toBe(label);
  });

  it('labels itself by its dotted order', () => {
    render(<SubTaskCard task={makeTask({ id: 's1', order: 1 })} parentTask={parent} models={[]} />);
    expect(document.querySelector('.subtask-order')?.textContent).toBe('2.1.');
  });
});
