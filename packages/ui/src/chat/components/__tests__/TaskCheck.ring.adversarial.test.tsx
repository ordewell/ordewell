import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import TaskCard from '../TaskCard';
import SubTaskCard from '../SubTaskCard';
import type { Task } from '@ordewell/core';

/**
 * Adversarial check of the sweeping progress ring: the class each state hands
 * `TaskCheck` decides what the ring draws, and only a running task may sweep.
 * A quiet one is stalled (purple, still), a done one is the filled check, and a
 * task that resumes stops reading as stalled.
 */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1', order: 1, title: 'Test task', description: 'A task', type: 'ai', status: 'pending',
    dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build',
    ...overrides,
  };
}

const check = () => document.querySelector('.task-check')!;

describe('the ring a task state draws', () => {
  it('sweeps on a running task and never draws the done check into it', () => {
    render(<TaskCard task={makeTask({ status: 'in_progress' })} models={[]} isExecuting />);

    expect(check().classList.contains('task-check')).toBe(true);
    expect(check().classList.contains('running')).toBe(true);
    expect(check().getAttribute('title')).toBe('Running');
    expect(check().querySelector('svg')).toBeNull();
  });

  it('holds still on a stalled task: no running class, no sweep', () => {
    render(<TaskCard task={makeTask({ status: 'in_progress' })} models={[]} isExecuting run={{ idleSince: '2026-01-01T00:00:00Z' }} />);

    expect(check().classList.contains('stalled')).toBe(true);
    expect(check().classList.contains('running')).toBe(false);
    expect(check().getAttribute('title')).toBe('Stalled: no output recently');
  });

  it('swaps stalled back to running when output resumes (same element, new run view)', () => {
    const { rerender } = render(<TaskCard task={makeTask({ status: 'in_progress' })} models={[]} isExecuting run={{ idleSince: '2026-01-01T00:00:00Z' }} />);
    expect(check().className).toContain('stalled');

    rerender(<TaskCard task={makeTask({ status: 'in_progress' })} models={[]} isExecuting run={{ idleSince: null }} />);
    expect(check().className).toContain('running');
    expect(check().className).not.toContain('stalled');
  });

  it('keeps the same 15px box class across pending, running and done', () => {
    const states = [makeTask({ status: 'pending' }), makeTask({ status: 'in_progress' }), makeTask({ status: 'completed' })];
    const classes: string[] = [];
    for (const task of states) {
      const { unmount } = render(<TaskCard task={task} models={[]} />);
      expect(check().classList.contains('task-check')).toBe(true);
      classes.push(check().querySelector('svg') ? 'svg' : 'no-svg');
      unmount();
    }
    expect(classes).toEqual(['no-svg', 'no-svg', 'svg']);
  });

  it('draws the same ring on a running subtask', () => {
    const parent = makeTask({ id: 'p1', order: 2 });
    render(<SubTaskCard task={makeTask({ id: 's1', status: 'in_progress' })} parentTask={parent} models={[]} isExecuting />);

    expect(document.querySelector('.subtask-card')!.contains(check())).toBe(true);
    expect(check().className).toContain('running');
    expect(check().getAttribute('title')).toBe('Running');
  });
});
