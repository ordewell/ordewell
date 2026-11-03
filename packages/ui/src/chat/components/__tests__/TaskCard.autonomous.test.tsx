import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import TaskCard from '../TaskCard';
import type { RunnerMode } from '../TaskCard';
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
    taskMode: 'bypassPermissions',
    ...overrides,
  };
}

const emptyModels: DiscoveredModel[] = [];
const noop = () => {};

const modes: RunnerMode[] = [
  { id: 'default', label: 'Ask before edits', description: 'Standard mode' },
  { id: 'bypassPermissions', label: 'Bypass permissions', description: 'Skips all permission prompts', autonomous: true },
];

describe('TaskCard — autonomous mode marking', () => {
  it('marks a task whose resolved mode is tagged autonomous in the manifest', () => {
    render(<TaskCard task={makeTask()} models={emptyModels} modes={modes} isExecuting={false} expanded onModeChange={noop} />);
    expect(screen.getByTitle(/Full: runs without permission prompts. \/settings changes the level/)).toBeTruthy();
  });

  it('puts the marking on the mode editor, not the collapsed header', () => {
    const { container } = render(<TaskCard task={makeTask()} models={emptyModels} modes={modes} isExecuting={false} onModeChange={noop} />);
    expect(container.querySelector('.task-card-header')?.textContent).not.toContain('⚡');
  });

  it('shows no marking for a task whose mode carries no autonomous tag', () => {
    render(<TaskCard task={makeTask({ taskMode: 'default' })} models={emptyModels} modes={modes} isExecuting={false} expanded onModeChange={noop} />);
    expect(screen.queryByTitle(/Full: runs without permission prompts/)).toBeNull();
  });

  it('shows no marking when no manifest mode data is available at all', () => {
    render(<TaskCard task={makeTask()} models={emptyModels} isExecuting={false} expanded onModeChange={noop} />);
    expect(screen.queryByTitle(/Full: runs without permission prompts/)).toBeNull();
  });
});
