import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Task } from '@ordewell/core';

/*
 * A delegated task's card (ADR-0055 D16, D20): its goal, what is left of its
 * budget, where its child stands, and a Stop still winding its child down. It
 * shows only where delegation is offered (D21).
 */

const offered = vi.hoisted(() => ({ value: true }));
vi.mock('@ordewell/core/plan-utils', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ordewell/core/plan-utils')>();
  return { ...real, get DELEGATION_OFFERED() { return offered.value; } };
});

import TaskCard from '../TaskCard';

const task = (over: Partial<Task> = {}): Task => ({
  id: 'd', order: 1, title: 'Import ledger', description: 'A subtree', type: 'delegated', status: 'in_progress',
  dependencies: [], subtasks: [], goal: 'Move the importer behind the new interface', budget: { tokens: 2_000_000 }, ...over,
} as Task);

const delegation = { tasks: { completed: 2, running: 1, waiting: 0, pending: 1, failed: 0, skipped: 0 }, tokens: { budget: 2_000_000, left: 1_300_000 } };

beforeEach(() => { offered.value = true; });

describe('a delegated task\'s card', () => {
  it('says where its child stands and what is left of its budget, on the collapsed card', () => {
    render(<TaskCard task={task()} models={[]} isExecuting run={{ delegation }} />);
    const line = document.querySelector('.task-delegated-line') as HTMLElement;
    expect(line.textContent).toBe('2 of 4 done, 1 running · 1.3M of 2M tokens left');
  });

  it('shows its goal once opened', () => {
    render(<TaskCard task={task()} models={[]} isExecuting run={{ delegation }} expanded onExpandedChange={() => {}} />);
    expect(screen.getByText('Move the importer behind the new interface')).toBeTruthy();
  });

  it('says it is stopping while a Stop winds its child down, though the task reads as not started', () => {
    render(<TaskCard task={task({ status: 'pending' })} models={[]} run={{ delegation: { stopping: true } }} />);
    expect(screen.getByText('Stopping: its child plan is still winding down.')).toBeTruthy();
  });

  it('says nothing of it where delegation is not offered', () => {
    offered.value = false;
    render(<TaskCard task={task({ status: 'pending' })} models={[]} run={{ delegation: { ...delegation, stopping: true } }} />);
    expect(document.querySelector('.task-delegated-line')).toBeNull();
    expect(screen.queryByText(/winding down/)).toBeNull();
    expect(screen.queryByText(/tokens left/)).toBeNull();
  });

  it('draws no delegated line on another kind of task', () => {
    render(<TaskCard task={{ ...task(), type: 'ai', goal: undefined, budget: undefined, assignedRunner: 'claude-code' } as Task} models={[]} isExecuting />);
    expect(document.querySelector('.task-delegated-line')).toBeNull();
  });
});
