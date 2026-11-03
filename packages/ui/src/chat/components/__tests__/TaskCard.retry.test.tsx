import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TaskCard from '../TaskCard';
import SubTaskCard from '../SubTaskCard';
import type { Task } from '@ordewell/core';

/**
 * A failed task's own recovery is a fresh retry (core's `retry_task` from
 * `fresh`), not a plain start: `prepareStart` refuses `run_task` on a failed
 * task with "…failed. Retry it first." The TUI carries it as `/retry <id>`.
 *
 * The case that matters is the idle plan: a run that failed has ended, so the
 * card is drawn with `isExecuting` false. A control drawn only while a run is
 * live would never be reachable after the failure.
 */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1', order: 1, title: 'Test task', description: 'A task', type: 'ai', status: 'failed',
    dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build',
    ...overrides,
  };
}

const buttons = (): string[] =>
  Array.from(document.querySelectorAll('.task-actions button')).map((b) => b.textContent ?? '');

describe('retrying a failed task from its card', () => {
  it('offers Retry on a failed task after its run ended, and asks for the fresh retry by id', () => {
    const onRetry = vi.fn();
    render(
      <TaskCard task={makeTask()} models={[]} isExecuting={false} expanded onExpandedChange={() => {}} onRetry={onRetry} onSkip={() => {}} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^retry$/i }));

    expect(onRetry).toHaveBeenCalledWith('t1');
  });

  it('offers Retry then Skip, and no Run Task core would refuse', () => {
    render(
      <TaskCard task={makeTask()} models={[]} isExecuting={false} expanded onExpandedChange={() => {}}
        onRetry={() => {}} onSkip={() => {}} onRunTask={() => {}} />,
    );

    expect(buttons()).toEqual(['Retry', 'Skip']);
    expect(screen.queryByText('Run Task')).toBeNull();
  });

  it('offers Retry while the run is still live too', () => {
    render(
      <TaskCard task={makeTask()} models={[]} isExecuting expanded onExpandedChange={() => {}} onRetry={() => {}} onSkip={() => {}} />,
    );

    expect(buttons()).toEqual(['Retry', 'Skip']);
  });

  it('offers no Retry on a task that has not failed', () => {
    render(
      <TaskCard task={makeTask({ status: 'pending' })} models={[]} isExecuting={false} expanded onExpandedChange={() => {}}
        onRetry={() => {}} onRunTask={() => {}} />,
    );

    expect(screen.queryByRole('button', { name: /^retry$/i })).toBeNull();
    expect(screen.getByText('Run Task')).toBeTruthy();
  });

  it('offers Retry on a failed subtask after its run ended', () => {
    const onRetry = vi.fn();
    render(
      <SubTaskCard task={makeTask({ id: 's1' })} parentTask={makeTask({ id: 'p1', status: 'pending' })} models={[]}
        isExecuting={false} onRetry={onRetry} onSkip={() => {}} onRunTask={() => {}} />,
    );
    fireEvent.click(document.querySelector('.subtask-card-header')!);

    expect(buttons()).toEqual(['Retry', 'Skip']);
    expect(screen.queryByText('Run Task')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^retry$/i }));
    expect(onRetry).toHaveBeenCalledWith('s1');
  });
});
