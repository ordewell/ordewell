import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import TaskCard from '../TaskCard';
import type { Task, DiscoveredModel } from '@ordewell/core';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't2',
    order: 2,
    title: 'Build',
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

const SIBLINGS: Task[] = [
  makeTask({ id: 't1', order: 1, title: 'Setup' }),
  makeTask({ id: 't2', order: 2, title: 'Build' }),
  makeTask({ id: 't3', order: 3, title: 'Test' }),
];

const noModels: DiscoveredModel[] = [];

function expand() {
  act(() => { fireEvent.click(document.querySelector('.task-title-text')!); });
}

function depOption(title: string): HTMLElement | null {
  const label = [...document.querySelectorAll('.task-dep-option')].find((l) => l.textContent?.includes(title));
  return (label?.querySelector('input') as HTMLElement | undefined) ?? null;
}

describe('TaskCard — remove button', () => {
  // The regression: a `confirm()` guard here never passed, because VS Code
  // sandboxes the webview without `allow-modals`. The host modal is the confirm.
  it('reports the removal straight to the host, ungated by a webview dialog', () => {
    const onRemoveTask = vi.fn();
    const blocked = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<TaskCard task={makeTask()} models={noModels} onRemoveTask={onRemoveTask} />);

    act(() => { fireEvent.click(screen.getByTitle('Remove task')); });

    expect(onRemoveTask).toHaveBeenCalledWith('t2');
    expect(blocked).not.toHaveBeenCalled();
    blocked.mockRestore();
  });

  it('is hidden while the plan is executing', () => {
    render(<TaskCard task={makeTask()} models={noModels} onRemoveTask={vi.fn()} isExecuting />);
    expect(screen.queryByTitle('Remove task')).toBeNull();
  });
});

describe('TaskCard — dependency editor', () => {
  it('offers only the tasks that come before this one', () => {
    render(
      <TaskCard task={makeTask()} models={noModels} siblings={SIBLINGS} onDependenciesChange={vi.fn()} />,
    );
    expand();
    act(() => { fireEvent.click(screen.getByTitle('Edit dependencies')); });

    expect(depOption('Setup')).toBeTruthy();
    expect(depOption('Test')).toBeNull();
  });

  it('reports the new list when a dependency is checked', () => {
    const onDependenciesChange = vi.fn();
    render(
      <TaskCard task={makeTask()} models={noModels} siblings={SIBLINGS} onDependenciesChange={onDependenciesChange} />,
    );
    expand();
    act(() => { fireEvent.click(screen.getByTitle('Edit dependencies')); });
    act(() => { fireEvent.click(depOption('Setup')!); });

    expect(onDependenciesChange).toHaveBeenCalledWith('t2', ['t1']);
  });

  it('reports the remaining list when a dependency is unchecked', () => {
    const onDependenciesChange = vi.fn();
    render(
      <TaskCard task={makeTask({ dependencies: ['t1'] })} models={noModels} siblings={SIBLINGS}
        onDependenciesChange={onDependenciesChange} />,
    );
    expand();
    act(() => { fireEvent.click(screen.getByTitle('Edit dependencies')); });
    act(() => { fireEvent.click(depOption('Setup')!); });

    expect(onDependenciesChange).toHaveBeenCalledWith('t2', []);
  });

  it('opens from the dependency badge, which is where a user looks for it', () => {
    render(
      <TaskCard task={makeTask({ dependencies: ['t1'] })} models={noModels} siblings={SIBLINGS}
        taskOrderMap={new Map([['t1', 1]])} onDependenciesChange={vi.fn()} />,
    );

    act(() => { fireEvent.click(screen.getByTitle(/click to edit/i)); });

    expect(depOption('Setup')).toBeTruthy();
  });

  it('says so rather than showing an empty list when nothing can precede the task', () => {
    render(
      <TaskCard task={makeTask({ id: 't1', order: 1, title: 'Build' })} models={noModels}
        siblings={[makeTask({ id: 't1', order: 1, title: 'Build' })]} onDependenciesChange={vi.fn()} />,
    );
    expand();
    act(() => { fireEvent.click(screen.getByTitle('Edit dependencies')); });

    expect(screen.getByText(/no possible dependencies/i)).toBeTruthy();
  });

  it('stays read-only while the plan is executing', () => {
    render(
      <TaskCard task={makeTask({ dependencies: ['t1'] })} models={noModels} siblings={SIBLINGS}
        onDependenciesChange={vi.fn()} isExecuting />,
    );
    expand();

    expect(screen.queryByTitle('Edit dependencies')).toBeNull();
  });
});

describe('SubTaskCard — remove button', () => {
  // Same sandboxed-`confirm()` regression as the parent card.
  it('reports a subtask removal straight to the host', () => {
    const onRemoveTask = vi.fn();
    const blocked = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      <TaskCard task={makeTask({ subtasks: [makeTask({ id: 's1', order: 1, title: 'Nested' })] })}
        models={noModels} onRemoveTask={onRemoveTask} />,
    );
    expand();

    act(() => { fireEvent.click(screen.getByTitle('Remove subtask')); });

    expect(onRemoveTask).toHaveBeenCalledWith('s1');
    expect(blocked).not.toHaveBeenCalled();
    blocked.mockRestore();
  });
});
