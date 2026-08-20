import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import TaskCard from '../TaskCard';
import type { Task, DiscoveredModel } from '@ordewell/core';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    order: 1,
    title: 'Test task',
    description: 'A task',
    type: 'ai',
    status: 'pending',
    dependencies: [],
    subtasks: [],
    assignedRunner: 'claude-code',
    completionMarker: 'm1',
    taskMode: 'build',
    ...overrides,
  };
}

const emptyModels: DiscoveredModel[] = [];

describe('TaskCard — Run Task button', () => {
  it('shows Run Task button when not executing and onRunTask is provided', () => {
    render(
      <TaskCard
        task={makeTask()}
        models={emptyModels}
        isExecuting={false}
        onRunTask={vi.fn()}
      />,
    );
    act(() => { fireEvent.click(screen.getByText('Test task')); });
    expect(screen.getByText('Run Task')).toBeTruthy();
  });

  it('does not show Run Task button when executing', () => {
    render(
      <TaskCard
        task={makeTask()}
        models={emptyModels}
        isExecuting={true}
        onRunTask={vi.fn()}
      />,
    );
    act(() => { fireEvent.click(screen.getByText('Test task')); });
    expect(screen.queryByText('Run Task')).toBeNull();
  });

  it('calls onRunTask with task id when Run Task is clicked', () => {
    const onRunTask = vi.fn();
    render(
      <TaskCard
        task={makeTask()}
        models={emptyModels}
        isExecuting={false}
        onRunTask={onRunTask}
      />,
    );
    act(() => { fireEvent.click(screen.getByText('Test task')); });
    fireEvent.click(screen.getByText('Run Task'));
    expect(onRunTask).toHaveBeenCalledWith('t1');
  });

  it('does not show Run Task for user-type tasks', () => {
    render(
      <TaskCard
        task={makeTask({ type: 'user' })}
        models={emptyModels}
        isExecuting={false}
        onRunTask={vi.fn()}
      />,
    );
    act(() => { fireEvent.click(screen.getByText('Test task')); });
    expect(screen.queryByText('Run Task')).toBeNull();
  });

  it('shows a missing-marker failure while the plan is idle', () => {
    render(
      <TaskCard
        task={makeTask({
          status: 'failed',
          verdict: {
            outcome: 'fail',
            reason: 'Completion marker missing.',
            checks: [{ name: 'completion_marker', passed: false, skipped: false, detail: 'not detected' }],
            decidedAt: new Date().toISOString(),
          },
        })}
        models={emptyModels}
        isExecuting={false}
      />,
    );

    expect(screen.getByText('Failed')).toBeTruthy();
    fireEvent.click(screen.getByText('Test task'));
    expect(screen.getByText(/Failed verification/)).toBeTruthy();
    expect(screen.getByText('Completion Marker')).toBeTruthy();
  });

  it('calls onMarkComplete when the status circle is clicked on a pending task', () => {
    const onMarkComplete = vi.fn();
    render(
      <TaskCard
        task={makeTask({ status: 'pending' })}
        models={emptyModels}
        isExecuting={true}
        onMarkComplete={onMarkComplete}
      />,
    );
    const check = screen.getByTitle('Click to mark executed');
    fireEvent.click(check);
    expect(onMarkComplete).toHaveBeenCalledWith('t1');
  });

  it('does not call onMarkComplete when the status circle is clicked on a completed task', () => {
    const onMarkComplete = vi.fn();
    render(
      <TaskCard
        task={makeTask({ status: 'completed' })}
        models={emptyModels}
        isExecuting={true}
        onMarkComplete={onMarkComplete}
      />,
    );
    const check = screen.getByTitle('Executed');
    fireEvent.click(check);
    expect(onMarkComplete).not.toHaveBeenCalled();
  });

  it('calls onMarkIncomplete when the status circle is clicked on a completed task', () => {
    const onMarkComplete = vi.fn();
    const onMarkIncomplete = vi.fn();
    render(
      <TaskCard
        task={makeTask({ status: 'completed' })}
        models={emptyModels}
        isExecuting={true}
        onMarkComplete={onMarkComplete}
        onMarkIncomplete={onMarkIncomplete}
      />,
    );
    fireEvent.click(screen.getByTitle('Executed — click to mark not done'));
    expect(onMarkIncomplete).toHaveBeenCalledWith('t1');
    expect(onMarkComplete).not.toHaveBeenCalled();
  });

  it('offers Mark Not Done in the action row of a completed task', () => {
    const onMarkIncomplete = vi.fn();
    render(
      <TaskCard
        task={makeTask({ status: 'completed' })}
        models={emptyModels}
        isExecuting={true}
        onMarkIncomplete={onMarkIncomplete}
      />,
    );
    fireEvent.click(screen.getByText('Test task'));
    fireEvent.click(screen.getByText('Mark Not Done'));
    expect(onMarkIncomplete).toHaveBeenCalledWith('t1');
  });
});

describe('TaskCard — runner output', () => {
  const withOutput = (output: string) => render(
    <TaskCard task={makeTask({ status: 'running' })} models={emptyModels} isExecuting output={output} />,
  );

  it('shows the newest line while collapsed, so a running task reads without opening it', () => {
    withOutput('compiling\nrunning tests\n\n');
    expect(document.querySelector('.task-output-peek')!.textContent).toBe('running tests');
    expect(document.querySelector('.task-output-pre')).toBeNull();
  });

  it('opens the full tail when the peek line is clicked', () => {
    withOutput('compiling\nrunning tests');
    act(() => { fireEvent.click(document.querySelector('.task-output-peek')!); });

    expect(document.querySelector('.task-output-pre')!.textContent).toBe('compiling\nrunning tests');
    expect(document.querySelector('.task-output-peek')).toBeNull();
  });

  it('shows nothing when no output has arrived', () => {
    render(<TaskCard task={makeTask({ status: 'running' })} models={emptyModels} isExecuting />);
    expect(document.querySelector('.task-output-peek')).toBeNull();
  });
});

describe('TaskCard — subtask order labels', () => {
  it('renders a dotted order label for subtasks, prefixed with the parent order', () => {
    render(
      <TaskCard
        task={makeTask({
          order: 2,
          subtasks: [{
            id: 's1',
            order: 1,
            title: 'Subtask one',
            description: '',
            type: 'ai',
            status: 'pending',
            dependencies: [],
            subtasks: [],
            assignedRunner: 'claude-code',
            completionMarker: 'm2',
            taskMode: 'build',
          }],
        })}
        models={emptyModels}
      />,
    );
    act(() => { fireEvent.click(screen.getByText('Test task')); });
    expect(document.querySelector('.subtask-order')!.textContent).toBe('2.1.');
  });
});

describe('TaskCard — Stalled state', () => {
  it('renders Stalled instead of Running when idleSince is set on an in_progress task', () => {
    render(
      <TaskCard
        task={makeTask({ status: 'in_progress' })}
        models={emptyModels}
        isExecuting
        idleSince="2026-08-18T00:00:00.000Z"
      />,
    );

    expect(screen.getByText('Stalled')).toBeTruthy();
    expect(screen.queryByText('Running')).toBeNull();
    expect(document.querySelector('.task-status-dot.status-stalled')).toBeTruthy();
  });

  it('renders the normal Running state when idleSince is absent', () => {
    render(
      <TaskCard
        task={makeTask({ status: 'in_progress' })}
        models={emptyModels}
        isExecuting
      />,
    );

    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.queryByText('Stalled')).toBeNull();
  });

  it('reverts to Running the moment idleSince clears', () => {
    const { rerender } = render(
      <TaskCard
        task={makeTask({ status: 'in_progress' })}
        models={emptyModels}
        isExecuting
        idleSince="2026-08-18T00:00:00.000Z"
      />,
    );
    expect(screen.getByText('Stalled')).toBeTruthy();

    rerender(
      <TaskCard
        task={makeTask({ status: 'in_progress' })}
        models={emptyModels}
        isExecuting
        idleSince={null}
      />,
    );

    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.queryByText('Stalled')).toBeNull();
  });
});
