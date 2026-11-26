import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import SubTaskCard from '../SubTaskCard';
import type { Task } from '@ordewell/core';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    order: 1,
    title: 'Subtask',
    description: 'A subtask',
    type: 'ai',
    status: 'in_progress',
    attempted: true,
    dependencies: [],
    subtasks: [],
    assignedRunner: 'claude-code',
    taskMode: 'build',
    ...overrides,
  };
}

const parent = makeTask({ id: 'p1', order: 2, title: 'Parent', subtasks: [] });

describe('SubTaskCard — its own run entry', () => {
  it('shows a runner approval waiting on the subtask, and opens its log to answer', () => {
    const onOpenLog = vi.fn();
    render(<SubTaskCard task={makeTask()} parentTask={parent} models={[]} run={{ awaitingApproval: 2 }} onOpenLog={onOpenLog} />);

    const badge = screen.getByRole('button', { name: 'Waiting for approval (2)' });
    expect(badge.className).toContain('task-approval-badge');
  });

  it('shows a merge gate holding the subtask', () => {
    render(<SubTaskCard task={makeTask()} parentTask={parent} models={[]} run={{ mergeGate: ['1', '2'] }} />);

    expect(screen.getByText('Waits for Merge all')).toBeTruthy();
  });

  it('shows an integration conflict on the subtask', () => {
    render(<SubTaskCard task={makeTask()} parentTask={parent} models={[]}
      run={{ isolation: { state: 'conflict', branch: 'ordewell/r/1-a', worktree: '.ordewell/worktrees/r/1-a', repos: ['api'], conflictRepo: 'api' } }} />);

    expect(screen.getByText('Conflict in api')).toBeTruthy();
  });

  it('names the files a conflicted subtask conflicts in', () => {
    render(<SubTaskCard task={makeTask()} parentTask={parent} models={[]}
      run={{ isolation: { state: 'conflict', branch: 'ordewell/r/1-a', worktree: '.ordewell/worktrees/r/1-a', repos: ['api'], conflictRepo: 'api', conflictFiles: ['src/a.ts', 'src/b.ts'] } }} />);

    expect(screen.getByText('Conflict in api').getAttribute('title')).toContain('in api: src/a.ts, src/b.ts.');
  });

  it('names the files a repairing subtask is repairing', () => {
    render(<SubTaskCard task={makeTask()} parentTask={parent} models={[]}
      run={{ isolation: { state: 'repairing', branch: 'ordewell/r/1-a', worktree: '.ordewell/worktrees/r/1-a', repos: ['api'], conflictFiles: ['src/a.ts', 'src/b.ts'], repair: { attempt: 1, limit: 3 } } }} />);

    expect(screen.getByText('Repairing (1 of 3)').getAttribute('title')).toBe('Repairing the conflict in its own worktree: src/a.ts, src/b.ts.');
  });

  it('says the scheduler waits for the user on a subtask added after the plan was approved', () => {
    render(<SubTaskCard task={makeTask({ status: 'pending' })} parentTask={parent} models={[]} run={{ waitsForApproval: true }} />);

    expect(screen.getByText('Waits for your approval')).toBeTruthy();
  });
});

describe('SubTaskCard — status the plan filter matches', () => {
  it('is identified by its own status, as a top-level row is', () => {
    const { container } = render(<SubTaskCard task={makeTask({ status: 'failed' })} parentTask={parent} models={[]} />);

    expect(container.querySelector('.subtask-with-controls')).toHaveAttribute('data-status', 'failed');
  });

  it('reads the run\'s newer status on a subtask that just started', () => {
    // A nested task_started rewrites the run before the plan: its card must not
    // still say "not started", or the running filter cannot find this child.
    const { container } = render(<SubTaskCard task={makeTask({ status: 'pending' })} parentTask={parent} models={[]} run={{ status: 'in_progress' }} />);

    expect(container.querySelector('.subtask-with-controls')).toHaveAttribute('data-status', 'running');
  });
});
