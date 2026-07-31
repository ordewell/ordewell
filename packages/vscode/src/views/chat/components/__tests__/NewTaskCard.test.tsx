import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import NewTaskCard from '../NewTaskCard';
import type { Task, DiscoveredModel } from '@ordewell/core';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1', order: 1, title: 'Setup', description: '', type: 'ai', status: 'pending',
    dependencies: [], subtasks: [], assignedRunner: 'claude-code', completionMarker: 'm1',
    ...overrides,
  };
}

const TASKS: Task[] = [makeTask(), makeTask({ id: 't2', order: 2, title: 'Build' })];

const RUNNERS = [
  { id: 'claude-code', displayName: 'Claude Code' },
  { id: 'codex', displayName: 'Codex' },
];

const MODELS_BY_RUNNER: Record<string, DiscoveredModel[]> = {
  'claude-code': [{ modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5', variants: [] }],
  codex: [{ modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex', variants: [] }],
};

const MODES_BY_RUNNER = {
  'claude-code': [{ id: 'build', label: 'Build', description: 'Edits files' }],
  codex: [{ id: 'agent', label: 'Agent', description: 'Edits files' }],
};

function open(onAdd = vi.fn()) {
  render(
    <NewTaskCard tasks={TASKS} runners={RUNNERS} models={[]}
      modelsByRunner={MODELS_BY_RUNNER} modesByRunner={MODES_BY_RUNNER} onAdd={onAdd} />,
  );
  act(() => { fireEvent.click(screen.getByText('+ Add task')); });
  return onAdd;
}

function depOption(title: string): HTMLElement | null {
  const label = [...document.querySelectorAll('.task-dep-option')].find((l) => l.textContent?.includes(title));
  return (label?.querySelector('input') as HTMLElement | undefined) ?? null;
}

describe('NewTaskCard', () => {
  it('stays out of the way until asked for', () => {
    render(<NewTaskCard tasks={TASKS} runners={RUNNERS} models={[]} onAdd={vi.fn()} />);
    expect(screen.queryByPlaceholderText('Task title')).toBeNull();
  });

  it('defaults to the first runner with that runner first model and mode', () => {
    open();

    const runner = screen.getByLabelText('Runner') as HTMLSelectElement;
    expect(runner.value).toBe('claude-code');
    // No blank row: an empty option would let a user unset the runner entirely.
    expect([...runner.options].map((o) => o.value)).toEqual(['claude-code', 'codex']);
    expect((screen.getByLabelText('Mode') as HTMLSelectElement).value).toBe('build');
    expect(screen.getByText(/Claude Sonnet 4\.5/)).toBeTruthy();
  });

  it('submits the title, prompt, assignment and dependencies together', () => {
    const onAdd = open();

    act(() => { fireEvent.change(screen.getByPlaceholderText('Task title'), { target: { value: 'Write docs' } }); });
    act(() => { fireEvent.change(screen.getByPlaceholderText(/Prompt for the runner/), { target: { value: 'do the docs' } }); });
    act(() => { fireEvent.click(depOption('Build')!); });
    act(() => { fireEvent.click(screen.getByText('Add task')); });

    expect(onAdd).toHaveBeenCalledWith({
      title: 'Write docs',
      prompt: 'do the docs',
      assignedRunner: 'claude-code',
      assignedModel: expect.objectContaining({ modelId: 'claude-sonnet-4-5' }),
      taskMode: 'build',
      dependencies: ['t2'],
    });
  });

  it('falls back to the title as the prompt', () => {
    const onAdd = open();

    act(() => { fireEvent.change(screen.getByPlaceholderText('Task title'), { target: { value: 'Write docs' } }); });
    act(() => { fireEvent.click(screen.getByText('Add task')); });

    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Write docs' }));
  });

  it('re-picks the model and mode when the runner changes, since neither exists on both', () => {
    const onAdd = open();

    act(() => { fireEvent.change(screen.getByLabelText('Runner'), { target: { value: 'codex' } }); });
    act(() => { fireEvent.change(screen.getByPlaceholderText('Task title'), { target: { value: 'Write docs' } }); });
    act(() => { fireEvent.click(screen.getByText('Add task')); });

    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({
      assignedRunner: 'codex',
      assignedModel: expect.objectContaining({ modelId: 'gpt-5-codex' }),
      taskMode: 'agent',
    }));
  });

  it('offers every existing task as a dependency, since a new task lands last', () => {
    open();
    expect(depOption('Setup')).toBeTruthy();
    expect(depOption('Build')).toBeTruthy();
  });

  it('refuses to add a task with no title', () => {
    const onAdd = open();
    expect((screen.getByText('Add task') as HTMLButtonElement).disabled).toBe(true);

    act(() => { fireEvent.click(screen.getByText('Add task')); });

    expect(onAdd).not.toHaveBeenCalled();
  });

  it('clears the form after adding, so the next task starts blank', () => {
    open();

    act(() => { fireEvent.change(screen.getByPlaceholderText('Task title'), { target: { value: 'Write docs' } }); });
    act(() => { fireEvent.click(screen.getByText('Add task')); });

    expect(screen.getByText('+ Add task')).toBeTruthy();
    act(() => { fireEvent.click(screen.getByText('+ Add task')); });
    expect((screen.getByPlaceholderText('Task title') as HTMLInputElement).value).toBe('');
  });
});
