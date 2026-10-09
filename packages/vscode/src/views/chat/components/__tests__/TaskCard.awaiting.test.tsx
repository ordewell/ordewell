import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TaskCard from '../TaskCard';
import SubTaskCard from '../SubTaskCard';
import type { Task } from '@ordewell/core';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1', order: 1, title: 'Test task', description: 'A task', type: 'ai', status: 'awaiting_user',
    dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build',
    ...overrides,
  };
}

describe('what an awaiting task waits on (ADR-0018, W1)', () => {
  it.each([
    ['input', 'Waiting for your input'],
    ['checkpoint', 'Checkpoint'],
    ['conflict', 'Merge conflict'],
  ] as const)('a task card waiting on %s says "%s"', (awaitingReason, label) => {
    render(<TaskCard task={makeTask({ awaitingReason })} models={[]} isExecuting />);
    expect(screen.getByText(label, { selector: '.task-status-badge' })).toBeTruthy();
  });

  it('keeps the generic label for a wait with no saved reason', () => {
    render(<TaskCard task={makeTask()} models={[]} isExecuting />);
    expect(screen.getByText('Awaiting User', { selector: '.task-status-badge' })).toBeTruthy();
  });

  it('still offers Mark Complete on a task waiting for input', () => {
    render(<TaskCard task={makeTask({ awaitingReason: 'input' })} models={[]} isExecuting onMarkComplete={() => {}} expanded onExpandedChange={() => {}} />);
    expect(screen.getByText('Mark Complete')).toBeTruthy();
  });

  it('does not require a running plan to show the wait — a stopped run leaves it held', () => {
    render(<TaskCard task={makeTask({ awaitingReason: 'input' })} models={[]} />);
    expect(screen.getByText('Waiting for your input', { selector: '.task-status-badge' })).toBeTruthy();
  });

  it('shows the reason on a subtask card too', () => {
    const parent = makeTask({ id: 'p1', status: 'in_progress' });
    render(<SubTaskCard task={makeTask({ id: 's1', awaitingReason: 'checkpoint' })} parentTask={parent} models={[]} isExecuting />);
    expect(screen.getByText('Checkpoint', { selector: '.task-status-badge' })).toBeTruthy();
  });

  it('badges a task whose runner waits on an approval, and the badge opens its log (A1)', () => {
    const opened: string[] = [];
    render(<TaskCard task={makeTask({ status: 'in_progress', transport: { kind: 'structured' } })} models={[]} isExecuting
      awaitingApproval={1} onOpenLog={(id) => opened.push(id)} />);
    fireEvent.click(screen.getByText('Waiting for approval', { selector: '.task-approval-badge' }));
    expect(opened).toEqual(['t1']);
    // The status itself is left alone: the turn is still running.
    expect(screen.queryByText('Awaiting User')).toBeNull();
  });

  it('shows no approval badge when nothing waits', () => {
    render(<TaskCard task={makeTask({ status: 'in_progress', transport: { kind: 'structured' } })} models={[]} isExecuting />);
    expect(document.querySelector('.task-approval-badge')).toBeNull();
  });
});
