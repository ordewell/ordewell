import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TaskCard from '../TaskCard';
import type { Task, TaskIsolation } from '@ordewell/core';

/**
 * Revert on a task's card (ADR-0054): offered only where core's isolation mark
 * says the landing can be reverted, named by the task it acts on, and a real
 * button so the keyboard reaches it. The confirmation is the host's.
 */

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1', order: 1, title: 'Parse JSON', description: 'A task', type: 'ai', status: 'completed',
    dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build',
    ...overrides,
  };
}

const landed: TaskIsolation = { state: 'integrated', branch: 'ordewell/t1', worktree: '/wt/t1', repos: ['.'] };
const revertible: TaskIsolation = { ...landed, revertible: true };

const card = (isolation: TaskIsolation | undefined, onRevert: ((taskId: string) => void) | null = () => {}) =>
  render(
    <TaskCard task={makeTask()} models={[]} isExecuting={false} expanded onExpandedChange={() => {}}
      run={isolation ? { status: 'completed', isolation } : undefined} onRevert={onRevert ?? undefined} />,
  );

describe('Revert on a task\'s card', () => {
  it('asks the host to revert that task when clicked', () => {
    const onRevert = vi.fn();
    card(revertible, onRevert);

    fireEvent.click(screen.getByRole('button', { name: 'Revert task #1 Parse JSON' }));

    expect(onRevert).toHaveBeenCalledWith('t1');
  });

  it('is named by the task it acts on, for a screen reader', () => {
    card(revertible);

    const button = screen.getByRole('button', { name: 'Revert task #1 Parse JSON' });
    expect(button.getAttribute('aria-label')).toBe('Revert task #1 Parse JSON');
  });

  it('is a real button in the tab order, so the keyboard operates it', () => {
    card(revertible);

    const button = screen.getByRole('button', { name: /^Revert task/ });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('tabindex')).toBeNull();
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it('asks the host to revert a subtask, called by its full path', () => {
    const onRevert = vi.fn();
    const subtask = makeTask({ id: 's1', order: 1, title: 'Parse the header' });
    render(
      <TaskCard task={makeTask({ subtasks: [subtask], status: 'in_progress' })} models={[]} isExecuting={false} expanded onExpandedChange={() => {}}
        runsByTask={new Map([['s1', { status: 'completed', isolation: { state: 'none', revertible: true } }]])} onRevert={onRevert} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Parse the header/, expanded: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Revert task #1.1 Parse the header' }));

    expect(onRevert).toHaveBeenCalledWith('s1');
  });

  it('is hidden for a task that landed nothing', () => {
    card({ state: 'none' });
    expect(screen.queryByRole('button', { name: /Revert/ })).toBeNull();
  });

  it('is hidden for landed work core does not say can be reverted', () => {
    card(landed);
    expect(screen.queryByRole('button', { name: /Revert/ })).toBeNull();
  });

  it('is hidden for a task with no run entry', () => {
    card(undefined);
    expect(screen.queryByRole('button', { name: /Revert/ })).toBeNull();
  });

  it('is hidden where the surface offers no revert', () => {
    card(revertible, null);
    expect(screen.queryByRole('button', { name: /Revert/ })).toBeNull();
  });
});
