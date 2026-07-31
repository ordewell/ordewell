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

const RUNNERS = [
  { id: 'claude-code', displayName: 'Claude Code' },
  { id: 'codex', displayName: 'Codex' },
  { id: 'opencode', displayName: 'OpenCode' },
];

const emptyModels: DiscoveredModel[] = [];

function expand() {
  act(() => { fireEvent.click(screen.getByText('Test task')); });
}

describe('TaskCard — runner selector', () => {
  it('offers every installed runner and marks the task current one', () => {
    render(<TaskCard task={makeTask()} models={emptyModels} runners={RUNNERS} onRunnerChange={vi.fn()} />);
    expand();

    const select = screen.getByLabelText('Runner') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['claude-code', 'codex', 'opencode']);
    expect(select.value).toBe('claude-code');
  });

  it('reports the chosen runner for this task', () => {
    const onRunnerChange = vi.fn();
    render(<TaskCard task={makeTask()} models={emptyModels} runners={RUNNERS} onRunnerChange={onRunnerChange} />);
    expand();

    act(() => { fireEvent.change(screen.getByLabelText('Runner'), { target: { value: 'codex' } }); });

    expect(onRunnerChange).toHaveBeenCalledWith('t1', 'codex');
  });

  it('puts runner before model and mode, since it constrains both', () => {
    render(
      <TaskCard task={makeTask()} models={[{ modelId: 'm1', modelLabel: 'M1', variants: [] }]}
        runners={RUNNERS} onRunnerChange={vi.fn()} onModelChange={vi.fn()} onModeChange={vi.fn()} />,
    );
    expand();

    const labels = [...document.querySelectorAll('.model-selector label')].map((l) => l.textContent);
    expect(labels).toEqual(['Runner', 'Model', 'Mode']);
  });

  it('hides the runner selector while the plan is executing', () => {
    render(<TaskCard task={makeTask()} models={emptyModels} runners={RUNNERS} onRunnerChange={vi.fn()} isExecuting />);
    expand();

    expect(screen.queryByLabelText('Runner')).toBeNull();
  });

  it('is absent for a manual task, which no runner executes', () => {
    render(<TaskCard task={makeTask({ type: 'user' })} models={emptyModels} runners={RUNNERS} onRunnerChange={vi.fn()} />);
    expand();

    expect(screen.queryByLabelText('Runner')).toBeNull();
  });

  it('is absent when the host has not sent a runner list yet', () => {
    render(<TaskCard task={makeTask()} models={emptyModels} runners={[]} onRunnerChange={vi.fn()} />);
    expand();

    expect(screen.queryByLabelText('Runner')).toBeNull();
  });

  it('still lists a runner the plan uses but discovery did not report installed', () => {
    // Hiding it would silently misreport which runner the task actually runs on.
    render(<TaskCard task={makeTask({ assignedRunner: 'aider' })} models={emptyModels} runners={RUNNERS} onRunnerChange={vi.fn()} />);
    expand();

    const select = screen.getByLabelText('Runner') as HTMLSelectElement;
    expect(select.value).toBe('aider');
    expect([...select.options].map((o) => o.value)).toContain('aider');
  });
});
