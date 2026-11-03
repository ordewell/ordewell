import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import TaskCard from '../TaskCard';
import SubTaskCard from '../SubTaskCard';
import type { Task } from '@ordewell/core';

const RUNNERS = [{ id: 'codex', displayName: 'Codex' }, { id: 'claude-code', displayName: 'Claude Code' }];
const task = (over: Partial<Task> = {}): Task => ({
  id: 't', order: 1, title: 'Work', description: '', type: 'ai', status: 'in_progress', dependencies: [], subtasks: [],
  assignedRunner: 'codex', taskMode: 'build', assignedModel: { modelId: 'openai/gpt', modelLabel: 'GPT', thinkingEffort: 'high' },
  ...over,
});
const pickers = { runners: RUNNERS, onRunnerChange: vi.fn(), onModeChange: vi.fn() };

describe('the assignment while a plan executes', () => {
  beforeEach(cleanup);

  it('replaces the runner, model and mode pickers with a read-only runner · model · variant on a task card', () => {
    const { container } = render(<TaskCard task={task()} models={[]} isExecuting {...pickers} />);
    fireEvent.click(screen.getByText('Work'));

    expect(screen.queryByLabelText('Runner')).toBeNull();
    expect(screen.queryByLabelText(/^Mode/)).toBeNull();
    expect(container.querySelector('.task-assignment-readonly')?.textContent).toBe('Assignedcodex · GPT · high');
    // The header line under the title is there in every state.
    expect(container.querySelector('.task-heading-block .task-assignment')?.textContent).toBe('codex · GPT · high');
  });

  it('replaces them on a subtask card too', () => {
    const sub = task({ id: 'sub' });
    const { container } = render(<SubTaskCard task={sub} parentTask={task({ subtasks: [sub] })} models={[]} isExecuting {...pickers} />);
    fireEvent.click(screen.getByText('Work'));

    expect(screen.queryByLabelText('Runner')).toBeNull();
    expect(container.querySelector('.task-assignment-readonly')?.textContent).toBe('Assignedcodex · GPT · high');
    expect(container.querySelector('.task-heading .task-assignment')?.textContent).toBe('codex · GPT · high');
  });

  it('keeps the pickers, and no read-only copy, before execution', () => {
    const { container } = render(<TaskCard task={task({ status: 'pending' })} models={[]} {...pickers} />);
    fireEvent.click(screen.getByText('Work'));

    expect(screen.getByLabelText('Runner')).toBeTruthy();
    expect(container.querySelector('.task-assignment-readonly')).toBeNull();
    expect(container.querySelector('.task-heading-block .task-assignment')).not.toBeNull();
  });

  it('shows nothing for a manual task, which no runner executes', () => {
    const { container } = render(<TaskCard task={task({ type: 'user' })} models={[]} isExecuting {...pickers} />);
    fireEvent.click(screen.getByText('Work'));

    expect(container.querySelector('.task-assignment-readonly')).toBeNull();
  });
});

describe('a script or manual card names no runner, whatever runner the plan stores for it', () => {
  beforeEach(cleanup);

  it.each([
    ['script', { type: 'script' as const, commands: [['git', 'push']], assignedModel: undefined }],
    ['manual', { type: 'user' as const, assignedModel: undefined }],
  ])('on a %s task, running or not, collapsed or open', (_kind, over) => {
    for (const isExecuting of [false, true]) {
      const { container } = render(<TaskCard task={task({ status: 'pending', ...over })} models={[]} isExecuting={isExecuting} {...pickers} />);
      expect(container.textContent).not.toContain('codex');
      fireEvent.click(screen.getByText('Work'));
      expect(container.textContent).not.toContain('codex');
      expect(screen.queryByLabelText('Runner')).toBeNull();
      cleanup();
    }
  });
});

describe('the assignment flag on a subtask card', () => {
  beforeEach(cleanup);

  it('words the consequence by where the subtask stands', () => {
    const sub = task({ id: 'sub', status: 'failed' });
    render(<SubTaskCard task={sub} parentTask={task({ subtasks: [sub] })} models={[]} isExecuting runnerScope={{ enabledRunners: ['claude-code'], allowlist: {} }} {...pickers} />);

    expect(screen.getByText('codex is switched off').getAttribute('title')).toMatch(/^Failed; a retry would run it there unless moved\./);
  });
});

// The card and the host's edit guard read one run fact: an editor the card
// offers is one the host accepts.
describe('the editors follow whether the run could still move the plan on, not only a live attempt', () => {
  beforeEach(cleanup);

  it('holds a settled task read-only while the scheduler waits on a manual task, with nothing live', () => {
    const { container } = render(<TaskCard task={task({ status: 'completed' })} models={[]} runActive {...pickers} />);
    fireEvent.click(screen.getByText('Work'));

    expect(screen.queryByLabelText('Runner')).toBeNull();
    expect(container.querySelector('.task-assignment-readonly')?.textContent).toBe('Assignedcodex · GPT · high');
  });

  it('still lets a task that has not started keep its editors then', () => {
    render(<TaskCard task={task({ status: 'pending' })} models={[]} runActive {...pickers} />);
    fireEvent.click(screen.getByText('Work'));

    expect(screen.getByLabelText('Runner')).toBeTruthy();
  });

  it('holds a settled subtask read-only the same way', () => {
    const sub = task({ id: 'sub', status: 'completed' });
    render(<SubTaskCard task={sub} parentTask={task({ subtasks: [sub] })} models={[]} runActive {...pickers} />);
    fireEvent.click(screen.getByText('Work'));

    expect(screen.queryByLabelText('Runner')).toBeNull();
  });

  it('keeps the failed task editable once a run has ended on it, so it can be fixed and retried', () => {
    render(<TaskCard task={task({ status: 'failed' })} models={[]} runActive={false} {...pickers} />);
    fireEvent.click(screen.getByText('Work'));

    expect(screen.getByLabelText('Runner')).toBeTruthy();
  });
});
