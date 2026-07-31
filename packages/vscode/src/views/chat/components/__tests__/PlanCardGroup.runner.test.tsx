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

const RUNNERS = [
  { id: 'claude-code', displayName: 'Claude Code' },
  { id: 'codex', displayName: 'Codex' },
];

const CODEX_MODELS: DiscoveredModel[] = [{ modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex', variants: [] }];
const CLAUDE_MODELS: DiscoveredModel[] = [{ modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5', variants: [] }];

describe('PlanCardGroup — per-task runner', () => {
  it('forwards a runner change up with the task id', () => {
    const onRunnerChange = vi.fn();
    render(<PlanCardGroup tasks={[makeTask()]} models={[]} runners={RUNNERS} onRunnerChange={onRunnerChange} />);
    act(() => { fireEvent.click(screen.getByText('Test task')); });

    act(() => { fireEvent.change(screen.getByLabelText('Runner'), { target: { value: 'codex' } }); });

    expect(onRunnerChange).toHaveBeenCalledWith('t1', 'codex');
  });

  it('scopes the model list to the task own runner, not the plan first runner', () => {
    // The model and mode lists a card shows must follow that card's runner —
    // two tasks on different runners cannot share one catalog.
    render(
      <PlanCardGroup
        tasks={[makeTask({ assignedRunner: 'codex' })]}
        models={CLAUDE_MODELS}
        modelsByRunner={{ 'claude-code': CLAUDE_MODELS, codex: CODEX_MODELS }}
        modesByRunner={{ 'claude-code': [{ id: 'default', label: 'Default', description: 'd' }], codex: [{ id: 'agent', label: 'Agent', description: 'd' }] }}
        runners={RUNNERS}
        onRunnerChange={vi.fn()}
        onModelChange={vi.fn()}
        onModeChange={vi.fn()}
      />,
    );
    act(() => { fireEvent.click(screen.getByText('Test task')); });

    const mode = screen.getByLabelText('Mode') as HTMLSelectElement;
    expect([...mode.options].map((o) => o.value)).toEqual(['agent']);
  });
});
