import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TaskCard, { type RunnerSignInView } from '../TaskCard';
import type { Task } from '@ordewell/core';

/**
 * A task that failed because its agent is signed out is fixed by signing that
 * agent in, so its card offers the way in beside Retry (ADR-0052).
 */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1', order: 1, title: 'Test task', description: 'A task', type: 'ai', status: 'failed',
    dependencies: [], subtasks: [], assignedRunner: 'cursor-agent', taskMode: 'build',
    ...overrides,
  };
}

const CURSOR = 'Cursor is not signed in. Sign in with /login cursor-agent, or run cursor-agent login.';

const buttons = (): string[] =>
  Array.from(document.querySelectorAll('.task-actions button')).map((b) => b.textContent ?? '');

function card(task: Task, signIn: Record<string, RunnerSignInView>) {
  return render(
    <TaskCard task={task} models={[]} isExecuting={false} expanded onExpandedChange={() => {}}
      onRetry={() => {}} onSkip={() => {}} runnerSignIn={signIn} />,
  );
}

describe('a task whose agent is signed out', () => {
  it('offers Log in first on a failed task, naming the way in, and runs it', () => {
    const logIn = vi.fn();
    card(makeTask(), { 'cursor-agent': { label: 'Cursor', hint: CURSOR, logIn } });

    expect(buttons()).toEqual(['Log in', 'Retry', 'Skip']);
    const button = screen.getByRole('button', { name: 'Log in to Cursor' });
    expect(button.getAttribute('title')).toBe(CURSOR);

    fireEvent.click(button);

    expect(logIn).toHaveBeenCalledTimes(1);
  });

  it('offers no Log in where Ordewell can run no way in', () => {
    card(makeTask(), { 'cursor-agent': { label: 'Cursor', hint: CURSOR } });

    expect(buttons()).toEqual(['Retry', 'Skip']);
  });

  it('offers no Log in on a task that has not failed, or whose agent is signed in', () => {
    card(makeTask({ status: 'completed' }), { 'cursor-agent': { label: 'Cursor', hint: CURSOR, logIn: () => {} } });
    expect(screen.queryByRole('button', { name: 'Log in to Cursor' })).toBeNull();
  });

  it('offers no Log in for a failed task on another agent', () => {
    card(makeTask({ assignedRunner: 'codex' }), { 'cursor-agent': { label: 'Cursor', hint: CURSOR, logIn: () => {} } });

    expect(buttons()).toEqual(['Retry', 'Skip']);
  });
});
