import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import PlanCardGroup from '../PlanCardGroup';

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

describe('PlanCardGroup — Execute Plan / Stop', () => {
  it('renders Execute Plan button when not executing', () => {
    render(
      <PlanCardGroup
        tasks={[makeTask()]}
        models={emptyModels}
        isExecuting={false}
        onExecutePlan={vi.fn()}
      />,
    );
    expect(screen.getByText('Execute Plan')).toBeTruthy();
  });

  it('renders Stop button when executing', () => {
    render(
      <PlanCardGroup
        tasks={[makeTask()]}
        models={emptyModels}
        isExecuting={true}
        onStopExecution={vi.fn()}
      />,
    );
    expect(screen.getByText('Stop')).toBeTruthy();
  });

  it('calls onExecutePlan when Execute Plan is clicked', () => {
    const onExecutePlan = vi.fn();
    render(
      <PlanCardGroup
        tasks={[makeTask()]}
        models={emptyModels}
        isExecuting={false}
        onExecutePlan={onExecutePlan}
      />,
    );
    fireEvent.click(screen.getByText('Execute Plan'));
    expect(onExecutePlan).toHaveBeenCalledTimes(1);
  });

  it('calls onStopExecution when Stop is clicked', () => {
    const onStopExecution = vi.fn();
    render(
      <PlanCardGroup
        tasks={[makeTask()]}
        models={emptyModels}
        isExecuting={true}
        onStopExecution={onStopExecution}
      />,
    );
    fireEvent.click(screen.getByText('Stop'));
    expect(onStopExecution).toHaveBeenCalledTimes(1);
  });

  it('hides action bar when neither callback is provided', () => {
    render(
      <PlanCardGroup
        tasks={[makeTask()]}
        models={emptyModels}
        isExecuting={false}
      />,
    );
    expect(document.querySelector('.plan-action-bar')).toBeNull();
  });

  it('renders per-task Run Task button via onRunTask when not executing', () => {
    render(
      <PlanCardGroup
        tasks={[makeTask()]}
        models={emptyModels}
        isExecuting={false}
        onRunTask={vi.fn()}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByText('Test task'));
    });
    expect(screen.getByText('Run Task')).toBeTruthy();
  });
});

describe('PlanCardGroup — no reordering', () => {
  // Display order is not execution order: independent tasks fan out, so a
  // control that moves a card promised something the orchestrator never honoured.
  const twoTasks = [
    makeTask({ id: 't1', order: 1, title: 'First' }),
    makeTask({ id: 't2', order: 2, title: 'Second', dependencies: ['t1'] }),
  ];

  const renderGroup = () => render(
    <PlanCardGroup tasks={twoTasks} models={emptyModels} isExecuting={false}
      onExecutePlan={vi.fn()} onMerge={vi.fn()} onSplit={vi.fn()} />,
  );

  it('offers no drag handle', () => {
    renderGroup();
    expect(document.querySelector('.task-drag-handle')).toBeNull();
    expect(document.querySelector('[draggable="true"]')).toBeNull();
  });

  it('offers no move up/down buttons', () => {
    renderGroup();
    expect(document.querySelector('.task-order-btn')).toBeNull();
    expect(screen.queryByTitle('Move up')).toBeNull();
    expect(screen.queryByTitle('Move down')).toBeNull();
  });

  it('never explains why a task cannot be moved', () => {
    renderGroup();
    expect(document.querySelector('.reorder-error-banner')).toBeNull();
    expect(document.body.textContent).not.toMatch(/reorder/i);
  });

  // The drag handle was a 20px sibling ahead of every card, which is what pushed
  // the cards right of the action bar. Cards now start where the bar does.
  it('starts each card at the list edge, with nothing ahead of it', () => {
    renderGroup();
    const list = document.querySelector('.task-list')!;
    expect([...list.children].map((c) => c.className.split(' ')[0]))
      .toEqual(['task-card-with-actions', 'task-card-with-actions']);
  });

  it('keeps the action bar and the task list as siblings under one edge', () => {
    renderGroup();
    const group = document.querySelector('.plan-card-group')!;
    expect(document.querySelector('.plan-action-bar')!.parentElement).toBe(group);
    expect(document.querySelector('.task-list')!.parentElement).toBe(group);
  });

  it('drops the action row entirely when it would have no buttons', () => {
    render(<PlanCardGroup tasks={twoTasks} models={emptyModels} isExecuting={false} />);
    expect(document.querySelector('.task-inline-actions')).toBeNull();
  });
});

describe('PlanCardGroup — per-task model list fallback', () => {
  const flatModels: DiscoveredModel[] = [
    { modelId: 'claude-code/opus', modelLabel: 'Opus', runnerProvider: 'claude-code', variants: [] },
    { modelId: 'claude-code/sonnet', modelLabel: 'Sonnet', runnerProvider: 'claude-code', variants: [] },
  ];

  // An empty array is truthy — the old `?? models` guard would have handed the
  // picker `[]` and rendered nothing. The length check must fall back to the
  // flat merged list so a degraded/empty runner never shows an empty picker.
  it('falls back to the flat model list when the runner discovered zero models', () => {
    render(
      <PlanCardGroup
        tasks={[makeTask({ assignedRunner: 'claude-code' })]}
        models={flatModels}
        modelsByRunner={{ 'claude-code': [] }}
        isExecuting={false}
        onModelChange={vi.fn()}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByText('Test task'));
    });
    act(() => {
      fireEvent.click(screen.getByText('Select model...'));
    });
    expect(screen.getByText('Opus')).toBeTruthy();
    expect(screen.getByText('Sonnet')).toBeTruthy();
  });
});

describe('PlanCardGroup — planner-driven split', () => {
  it('calls onSplit(taskId) directly with no manual spec dialog', () => {
    const onSplit = vi.fn();
    render(
      <PlanCardGroup
        tasks={[makeTask({ id: 't1', order: 1 }), makeTask({ id: 't2', order: 2, title: 'Other' })]}
        models={emptyModels}
        isExecuting={false}
        onSplit={onSplit}
      />,
    );
    // The split button for the first task.
    const splitBtn = screen.getAllByTitle(/Split this task/)[0];
    fireEvent.click(splitBtn);
    expect(onSplit).toHaveBeenCalledWith('t1');
    // No manual spec dialog is rendered.
    expect(document.querySelector('.split-dialog-overlay')).toBeNull();
  });

  it('shows an inline error and does not call onSplit for a completed task', () => {
    const onSplit = vi.fn();
    render(
      <PlanCardGroup
        tasks={[makeTask({ id: 't1', order: 1, status: 'completed' })]}
        models={emptyModels}
        isExecuting={false}
        onSplit={onSplit}
      />,
    );
    fireEvent.click(screen.getAllByTitle(/Split this task/)[0]);
    expect(onSplit).not.toHaveBeenCalled();
    expect(document.querySelector('.merge-validation-error-banner')).toBeTruthy();
  });
});

describe('PlanCardGroup — planner-driven merge', () => {
  function chain() {
    return [
      makeTask({ id: 't1', order: 1, title: 'A' }),
      makeTask({ id: 't2', order: 2, title: 'B', dependencies: ['t1'] }),
      makeTask({ id: 't3', order: 3, title: 'C', dependencies: ['t2'] }),
    ];
  }

  it('calls onMerge with the selected consecutive task ids', () => {
    const onMerge = vi.fn();
    render(
      <PlanCardGroup tasks={chain()} models={emptyModels} isExecuting={false} onMerge={onMerge} />,
    );
    fireEvent.click(screen.getAllByTitle(/Select tasks to merge/)[0]); // t1
    fireEvent.click(screen.getAllByTitle(/Select task to merge/)[0]);  // t2
    fireEvent.click(screen.getByText('Merge 2 tasks'));
    expect(onMerge).toHaveBeenCalledWith(['t1', 't2']);
  });

  it('shows an inline error for a non-consecutive selection and does not call onMerge', () => {
    const onMerge = vi.fn();
    render(
      <PlanCardGroup tasks={chain()} models={emptyModels} isExecuting={false} onMerge={onMerge} />,
    );
    fireEvent.click(screen.getAllByTitle(/Select tasks to merge/)[0]); // t1
    fireEvent.click(screen.getAllByTitle(/Select task to merge/)[1]);  // t3 (skips t2)
    fireEvent.click(screen.getByText('Merge 2 tasks'));
    expect(onMerge).not.toHaveBeenCalled();
    expect(document.querySelector('.merge-validation-error-banner')).toBeTruthy();
  });

  it('shows an inline error when a selected task is running (canMergeTasks)', () => {
    const onMerge = vi.fn();
    const tasks = [
      makeTask({ id: 't1', order: 1, title: 'A', status: 'in_progress' }),
      makeTask({ id: 't2', order: 2, title: 'B' }),
    ];
    render(
      <PlanCardGroup tasks={tasks} models={emptyModels} isExecuting={false} onMerge={onMerge} />,
    );
    fireEvent.click(screen.getAllByTitle(/Select tasks to merge/)[0]); // t1
    fireEvent.click(screen.getAllByTitle(/Select task to merge/)[0]);  // t2
    fireEvent.click(screen.getByText('Merge 2 tasks'));
    expect(onMerge).not.toHaveBeenCalled();
    expect(document.querySelector('.merge-validation-error-banner')).toBeTruthy();
  });
});
