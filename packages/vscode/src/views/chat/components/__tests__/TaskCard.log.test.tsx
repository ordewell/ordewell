import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TaskCard from '../TaskCard';
import SubTaskCard from '../SubTaskCard';
import type { Task } from '@ordewell/core';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1', order: 1, title: 'Test task', description: 'A task', type: 'ai', status: 'in_progress',
    dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build',
    ...overrides,
  };
}

describe('task log access', () => {
  it.each(['pending', 'in_progress', 'completed', 'failed'] as const)('offers Open log for a %s task without transport info', (status) => {
    render(<TaskCard task={makeTask({ status })} models={[]} isExecuting onOpenLog={() => {}} />);
    expect(screen.getByText('Open log')).toBeTruthy();
    expect(screen.queryByText('Structured')).toBeNull();
  });

  it('opens the task log without expanding the card', () => {
    const onOpenLog = vi.fn();
    const { container } = render(<TaskCard task={makeTask()} models={[]} isExecuting onOpenLog={onOpenLog} />);
    fireEvent.click(screen.getByText('Open log'));
    expect(onOpenLog).toHaveBeenCalledWith('t1');
    expect(container.querySelector('.task-card.expanded')).toBeNull();
  });

  it('opens a subtask log without transport info or expanding the card', () => {
    const onOpenLog = vi.fn();
    const { container } = render(<SubTaskCard task={makeTask()} parentTask={makeTask({ id: 'parent' })} models={[]} isExecuting onOpenLog={onOpenLog} />);
    fireEvent.click(screen.getByText('Open log'));
    expect(onOpenLog).toHaveBeenCalledWith('t1');
    expect(container.querySelector('.subtask-card.expanded')).toBeNull();
  });
});
