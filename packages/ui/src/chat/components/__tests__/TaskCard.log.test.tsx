import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TaskCard from '../TaskCard';
import SubTaskCard from '../SubTaskCard';
import type { AttemptUsage, Task } from '@ordewell/core';

const ledger: AttemptUsage = { attempt: 1, runner: 'claude-code', startedAt: '2026-10-01T00:00:00Z', wallTimeMs: 0, totals: {}, byModel: [] };

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1', order: 1, title: 'Test task', description: 'A task', type: 'ai', status: 'pending',
    dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build',
    ...overrides,
  };
}

const openChat = () => screen.queryByRole('button', { name: 'Open chat' });

describe('task chat availability', () => {
  it.each(['pending', 'completed', 'failed', 'skipped'] as const)('offers no chat for a never-started %s task, and reserves no space', (status) => {
    const { container } = render(<TaskCard task={makeTask({ status })} models={[]} isExecuting onOpenLog={() => {}} />);
    expect(openChat()).toBeNull();
    expect(container.querySelector('.task-heading-block-with-log')).toBeNull();
  });

  it('offers a chat as soon as an attempt starts, with no output or usage yet', () => {
    const onOpenLog = vi.fn();
    const { container } = render(
      <TaskCard task={makeTask({ status: 'in_progress', attempted: true })} models={[]} isExecuting onOpenLog={onOpenLog} />,
    );
    expect(openChat()).toBeTruthy();
    expect(container.querySelector('.task-heading-block-with-log')).not.toBeNull();
    fireEvent.click(openChat()!);
    expect(onOpenLog).toHaveBeenCalledWith('t1');
  });

  it.each([
    ['a cancelled task back to pending', { status: 'pending', attempted: true }],
    ['a failed one', { status: 'failed', attempted: true }],
    ['a completed one', { status: 'completed', attempted: true }],
    ['a skipped one that ran', { status: 'skipped', attempted: true }],
  ] as const)('keeps it for %s', (_name, task) => {
    render(<TaskCard task={makeTask(task)} models={[]} isExecuting onOpenLog={() => {}} />);
    expect(openChat()).toBeTruthy();
  });

  it('reads a live attempt before the plan is refreshed', () => {
    render(<TaskCard task={makeTask()} run={{ attempted: true }} models={[]} isExecuting onOpenLog={() => {}} />);
    expect(openChat()).toBeTruthy();
  });

  it('reads the attempt ledger of a plan saved before the mark', () => {
    render(<TaskCard task={makeTask({ status: 'completed', attemptUsage: [ledger] })} models={[]} isExecuting onOpenLog={() => {}} />);
    expect(openChat()).toBeTruthy();
  });

  it('gives a manual task no chat, and no handoff link into one', () => {
    const handoff = { summary: 'Steps done', findings: [], findingCount: 0 };
    const onOpenLog = vi.fn();
    render(<TaskCard task={makeTask({ type: 'user', status: 'completed', handoff })} models={[]} isExecuting
      onOpenLog={onOpenLog} expanded onExpandedChange={() => {}} />);
    expect(openChat()).toBeNull();
    expect(screen.getByText('Steps done')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Read full handoff' })).toBeNull();
  });

  it('keeps a nested handoff hidden until its task is expanded', () => {
    const handoff = { summary: 'Nested result', findings: [], findingCount: 0 };
    render(<SubTaskCard task={makeTask({ id: 'child', status: 'completed', handoff })}
      parentTask={makeTask({ id: 'parent' })} models={[]} />);
    expect(screen.queryByText('Nested result')).toBeNull();
    fireEvent.click(screen.getByText('Test task'));
    expect(screen.getByText('Nested result')).toBeTruthy();
    fireEvent.click(screen.getByText('Test task'));
    expect(screen.queryByText('Nested result')).toBeNull();
  });

  it('keeps the prompt and details openable before the task starts', () => {
    const { container } = render(<TaskCard task={makeTask({ prompt: 'Do the thing' })} models={[]} onOpenLog={() => {}} />);
    fireEvent.click(screen.getByText('Test task'));
    expect(container.querySelector('.task-card.expanded')).not.toBeNull();
    expect(screen.getByText('Do the thing')).toBeTruthy();
    expect(openChat()).toBeNull();
  });

  it('keeps detail expansion working whether or not its chat exists', () => {
    const { container, rerender } = render(
      <TaskCard task={makeTask()} models={[]} isExecuting onOpenLog={() => {}} expanded onExpandedChange={() => {}} />,
    );
    expect(container.querySelector('.task-card.expanded')).not.toBeNull();
    rerender(<TaskCard task={makeTask({ attempted: true })} models={[]} isExecuting onOpenLog={() => {}} expanded onExpandedChange={() => {}} />);
    expect(container.querySelector('.task-card.expanded')).not.toBeNull();
  });

  it('names the stacked control Open chat on two lines', () => {
    render(<TaskCard task={makeTask({ status: 'in_progress', attempted: true })} models={[]} isExecuting onOpenLog={() => {}} />);
    const button = openChat();
    expect(button).not.toBeNull();
    expect(Array.from(button!.querySelectorAll('span')).map((s) => s.textContent)).toEqual(['Open', 'chat']);
    expect(button!.getAttribute('title')).toBe("Open this task's chat in an editor tab");
  });
});

describe('subtask chat availability', () => {
  const parent = makeTask({ id: 'parent', order: 2, attempted: true });

  it('does not give its parent\'s chat to a never-run subtask', () => {
    const withChild = { ...parent, subtasks: [makeTask({ id: 'child', order: 1 })] };
    const { container } = render(<TaskCard task={withChild} models={[]} isExecuting onOpenLog={() => {}} />);
    expect(openChat()).toBeTruthy();
    expect(container.querySelectorAll('.task-log-open-btn')).toHaveLength(1);
  });

  it('draws its own once it started, and opens its own task only', () => {
    const onOpenLog = vi.fn();
    render(<SubTaskCard task={makeTask({ id: 'child', order: 1, status: 'in_progress', attempted: true })}
      parentTask={parent} models={[]} isExecuting onOpenLog={onOpenLog} />);
    fireEvent.click(openChat()!);
    expect(onOpenLog).toHaveBeenCalledWith('child');
  });

  it('shows no empty Open chat for a completed or skipped subtask that never ran', () => {
    for (const status of ['completed', 'skipped'] as const) {
      const { container, unmount } = render(
        <SubTaskCard task={makeTask({ id: 'child', order: 1, status })} parentTask={parent} models={[]} isExecuting onOpenLog={() => {}} />,
      );
      expect(container.textContent).not.toContain('Open chat');
      unmount();
    }
  });
});
