import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TaskCard from '../TaskCard';
import SubTaskCard from '../SubTaskCard';
import type { Task } from '@ordewell/core';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't2', order: 2, title: 'Build the API', description: 'A task', type: 'ai',
    status: 'pending', dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build',
    ...overrides,
  };
}

describe('remove buttons — accessible names', () => {
  it('names the task in the card variant, hides the glyph, keeps the tooltip', () => {
    const onRemoveTask = vi.fn();
    const onExpandedChange = vi.fn();
    render(<TaskCard task={makeTask()} models={[]} onRemoveTask={onRemoveTask} onExpandedChange={onExpandedChange} />);

    const btn = screen.getByRole('button', { name: 'Remove task Build the API' });
    expect(btn.getAttribute('title')).toBe('Remove task');
    expect(btn.querySelector('[aria-hidden="true"]')?.textContent).toBe('✕');
    fireEvent.click(btn);
    expect(onRemoveTask).toHaveBeenCalledWith('t2');
    expect(onExpandedChange).not.toHaveBeenCalled();
  });

  it('names the task in the row variant', () => {
    const onRemoveTask = vi.fn();
    render(<TaskCard task={makeTask()} models={[]} variant="row" expanded onRemoveTask={onRemoveTask} />);

    const btn = screen.getByRole('button', { name: 'Remove task Build the API' });
    fireEvent.click(btn);
    expect(onRemoveTask).toHaveBeenCalledWith('t2');
  });

  it('names the subtask, and clicking it does not toggle the card', () => {
    const onRemoveTask = vi.fn();
    const parent = makeTask({ id: 'p1', title: 'Parent' });
    render(<SubTaskCard task={makeTask({ id: 's1', title: 'Nested step' })} parentTask={parent} models={[]} onRemoveTask={onRemoveTask} />);

    const btn = screen.getByRole('button', { name: 'Remove subtask Nested step' });
    expect(btn.getAttribute('title')).toBe('Remove subtask');
    expect(btn.querySelector('[aria-hidden="true"]')?.textContent).toBe('✕');
    const heading = screen.getByRole('button', { name: /Nested step/, expanded: false });
    fireEvent.click(btn);
    expect(onRemoveTask).toHaveBeenCalledWith('s1');
    expect(heading.getAttribute('aria-expanded')).toBe('false');
  });
});
