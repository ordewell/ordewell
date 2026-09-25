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
    status: 'awaiting_user',
    dependencies: [],
    subtasks: [],
    assignedRunner: 'claude-code',
    completionMarker: 'm1',
    taskMode: 'build',
    ...overrides,
  };
}

const emptyModels: DiscoveredModel[] = [];

describe('TaskCard — isolation conflict (ADR-0013)', () => {
  it('shows a conflict indicator on the collapsed card', () => {
    render(
      <TaskCard
        task={makeTask()}
        models={emptyModels}
        isExecuting={false}
        isolation={{ state: 'conflict', branch: 'ordewell/r/1-a', worktree: '.ordewell/worktrees/r/1-a', repos: ['.'], conflictRepo: '.' }}
      />,
    );

    expect(screen.getByText('Conflict')).toBeTruthy();
  });

  it('keeps a non-conflict run quiet in the header', () => {
    render(
      <TaskCard
        task={makeTask({ status: 'in_progress' })}
        models={emptyModels}
        isExecuting={false}
        isolation={{ state: 'active', branch: 'ordewell/r/1-a', worktree: '.ordewell/worktrees/r/1-a', repos: ['.'] }}
      />,
    );

    expect(screen.queryByText('Conflict')).toBeNull();
    expect(document.querySelector('.task-isolation-badge')).toBeNull();
  });

  it('shows the branch and worktree in the task details', () => {
    render(
      <TaskCard
        task={makeTask()}
        models={emptyModels}
        isExecuting={false}
        isolation={{ state: 'active', branch: 'ordewell/r/1-a', worktree: '.ordewell/worktrees/r/1-a', repos: ['.'] }}
      />,
    );

    expect(screen.queryByText('ordewell/r/1-a')).toBeNull();
    act(() => { fireEvent.click(screen.getByText('Test task')); });
    expect(screen.getByText('ordewell/r/1-a')).toBeTruthy();
    expect(screen.getByText('.ordewell/worktrees/r/1-a')).toBeTruthy();
  });

  it('offers resolving the conflict as a task, and only then calls back', () => {
    const onResolveConflict = vi.fn();
    render(
      <TaskCard
        task={makeTask()}
        models={emptyModels}
        isExecuting={false}
        isolation={{ state: 'conflict', branch: 'ordewell/r/1-a', worktree: '.ordewell/worktrees/r/1-a', repos: ['.'], conflictRepo: '.' }}
        onResolveConflict={onResolveConflict}
      />,
    );

    act(() => { fireEvent.click(screen.getByText('Test task')); });
    fireEvent.click(screen.getByText('Resolve'));
    expect(onResolveConflict).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Resolve as a task'));
    expect(onResolveConflict).toHaveBeenCalledWith('t1');
  });

  it('renders no isolation details when there is none', () => {
    render(<TaskCard task={makeTask()} models={emptyModels} isExecuting={false} />);
    act(() => { fireEvent.click(screen.getByText('Test task')); });

    expect(document.querySelector('.task-isolation')).toBeNull();
  });
});

describe('TaskCard — repo group (ADR-0014)', () => {
  it('names the conflicting repo on a group conflict badge', () => {
    render(
      <TaskCard
        task={makeTask()}
        models={emptyModels}
        isExecuting={false}
        isolation={{ state: 'conflict', branch: 'ordewell/r/1-a', worktree: '.ordewell/worktrees/r/1-a', repos: ['api', 'web'], conflictRepo: 'api' }}
      />,
    );

    expect(screen.getByText(/Conflict.*api/)).toBeTruthy();
  });

  it('lists the repos the task changed in the details', () => {
    render(
      <TaskCard
        task={makeTask()}
        models={emptyModels}
        isExecuting={false}
        isolation={{ state: 'active', branch: 'ordewell/r/1-a', worktree: '.ordewell/worktrees/r/1-a', repos: ['api', 'web'] }}
      />,
    );

    act(() => { fireEvent.click(screen.getByText('Test task')); });
    expect(screen.getByText('api, web')).toBeTruthy();
  });

  it('does not list repos for a lone repository at the workspace root', () => {
    render(
      <TaskCard
        task={makeTask()}
        models={emptyModels}
        isExecuting={false}
        isolation={{ state: 'active', branch: 'ordewell/r/1-a', worktree: '.ordewell/worktrees/r/1-a', repos: ['.'] }}
      />,
    );

    act(() => { fireEvent.click(screen.getByText('Test task')); });
    expect(document.querySelector('.task-isolation-repos')).toBeNull();
  });
});
