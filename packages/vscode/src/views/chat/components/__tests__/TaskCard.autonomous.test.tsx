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
    completionMarker: 'm1',
    taskMode: 'bypassPermissions',
    ...overrides,
  };
}

const emptyModels: DiscoveredModel[] = [];

const modes: RunnerMode[] = [
  { id: 'default', label: 'Ask before edits', description: 'Standard mode' },
  { id: 'bypassPermissions', label: 'Auto mode', description: 'Skips all permission prompts', autonomous: true },
];

describe('TaskCard — autonomous mode marking', () => {
  it('marks a task whose resolved mode is tagged autonomous in the manifest', () => {
    render(<TaskCard task={makeTask()} models={emptyModels} modes={modes} isExecuting={false} />);
    expect(screen.getByTitle(/ordewell\.autonomousMode/)).toBeTruthy();
  });

  it('shows no marking for a task whose mode carries no autonomous tag', () => {
    render(<TaskCard task={makeTask({ taskMode: 'default' })} models={emptyModels} modes={modes} isExecuting={false} />);
    expect(screen.queryByTitle(/ordewell\.autonomousMode/)).toBeNull();
  });

  it('shows no marking when no manifest mode data is available at all', () => {
    render(<TaskCard task={makeTask()} models={emptyModels} isExecuting={false} />);
    expect(screen.queryByTitle(/ordewell\.autonomousMode/)).toBeNull();
  });
});
