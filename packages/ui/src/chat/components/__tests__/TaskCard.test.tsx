import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import TaskCard from '../TaskCard';
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
    taskMode: 'build',
    ...overrides,
  };
}

const emptyModels: DiscoveredModel[] = [];

describe('TaskCard — Run Task button', () => {
  it('shows Run Task button when not executing and onRunTask is provided', () => {
    render(
      <TaskCard
        task={makeTask()}
        models={emptyModels}
        isExecuting={false}
        onRunTask={vi.fn()}
      />,
    );
    act(() => { fireEvent.click(screen.getByText('Test task')); });
    expect(screen.getByText('Run Task')).toBeTruthy();
  });

  it('does not show Run Task button when executing', () => {
    render(
      <TaskCard
        task={makeTask()}
        models={emptyModels}
        isExecuting={true}
        onRunTask={vi.fn()}
      />,
    );
    act(() => { fireEvent.click(screen.getByText('Test task')); });
    expect(screen.queryByText('Run Task')).toBeNull();
  });

  it('calls onRunTask with task id when Run Task is clicked', () => {
    const onRunTask = vi.fn();
    render(
      <TaskCard
        task={makeTask()}
        models={emptyModels}
        isExecuting={false}
        onRunTask={onRunTask}
      />,
    );
    act(() => { fireEvent.click(screen.getByText('Test task')); });
    fireEvent.click(screen.getByText('Run Task'));
    expect(onRunTask).toHaveBeenCalledWith('t1');
  });

  it('does not show Run Task for user-type tasks', () => {
    render(
      <TaskCard
        task={makeTask({ type: 'user' })}
        models={emptyModels}
        isExecuting={false}
        onRunTask={vi.fn()}
      />,
    );
    act(() => { fireEvent.click(screen.getByText('Test task')); });
    expect(screen.queryByText('Run Task')).toBeNull();
  });

  it('shows a missing-marker failure while the plan is idle', () => {
    render(
      <TaskCard
        task={makeTask({
          status: 'failed',
          verdict: {
            outcome: 'fail',
            reason: 'Completion marker missing.',
            checks: [{ name: 'completion_marker', passed: false, skipped: false, detail: 'not detected' }],
            decidedAt: new Date().toISOString(),
          },
        })}
        models={emptyModels}
        isExecuting={false}
      />,
    );

    expect(screen.getByText('Failed')).toBeTruthy();
    fireEvent.click(screen.getByText('Test task'));
    expect(screen.getByText(/Failed verification/)).toBeTruthy();
    expect(screen.getByText('Completion Marker')).toBeTruthy();
  });

  it.each(['pending', 'failed', 'skipped', 'completed'] as const)('never changes completion when the status circle of a %s task is clicked', (status) => {
    const onMarkComplete = vi.fn();
    const onMarkIncomplete = vi.fn();
    const { container } = render(
      <TaskCard task={makeTask({ status })} models={emptyModels} onMarkComplete={onMarkComplete} onMarkIncomplete={onMarkIncomplete} />,
    );
    const check = container.querySelector('.task-check') as HTMLElement;

    fireEvent.click(check);
    fireEvent.keyDown(check, { key: 'Enter' });
    fireEvent.keyDown(check, { key: ' ' });

    expect(onMarkComplete).not.toHaveBeenCalled();
    expect(onMarkIncomplete).not.toHaveBeenCalled();
    expect(check.classList.contains('clickable')).toBe(false);
    expect(check.getAttribute('title')).not.toMatch(/click/i);
    expect(check.getAttribute('tabindex')).toBeNull();
  });

  it('offers no Mark complete on a collapsed card', () => {
    render(<TaskCard task={makeTask({ status: 'pending' })} models={emptyModels} onMarkComplete={vi.fn()} onMarkIncomplete={vi.fn()} />);

    expect(screen.queryByText('Mark complete')).toBeNull();
    expect(screen.queryByText('Mark not done')).toBeNull();
  });

  it('puts Mark complete last in the expanded details, below everything else', () => {
    const onMarkComplete = vi.fn();
    const { container } = render(
      <TaskCard task={makeTask({ status: 'failed' })} models={emptyModels} onMarkComplete={onMarkComplete} />,
    );
    fireEvent.click(screen.getByText('Test task'));

    const body = container.querySelector('.task-card-body') as HTMLElement;
    const button = screen.getByText('Mark complete');
    expect(body.lastElementChild?.contains(button)).toBe(true);
    fireEvent.click(button);
    expect(onMarkComplete).toHaveBeenCalledWith('t1');
  });

  it('offers Mark not done, and only that, at the bottom of a completed task', () => {
    const onMarkIncomplete = vi.fn();
    const onMarkComplete = vi.fn();
    render(
      <TaskCard task={makeTask({ status: 'completed' })} models={emptyModels} isExecuting={false} onMarkComplete={onMarkComplete} onMarkIncomplete={onMarkIncomplete} />,
    );
    fireEvent.click(screen.getByText('Test task'));

    expect(screen.queryByText('Mark complete')).toBeNull();
    fireEvent.click(screen.getByText('Mark not done'));
    expect(onMarkIncomplete).toHaveBeenCalledWith('t1');
    expect(onMarkComplete).not.toHaveBeenCalled();
  });

  it('holds an AI task\'s override back, and says why, while the run goes on', () => {
    const onMarkComplete = vi.fn();
    render(<TaskCard task={makeTask({ status: 'pending' })} models={emptyModels} isExecuting onMarkComplete={onMarkComplete} />);
    fireEvent.click(screen.getByText('Test task'));

    const button = screen.getByText('Mark complete') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Stop the run first/)).toBeTruthy();
    fireEvent.click(button);
    expect(onMarkComplete).not.toHaveBeenCalled();
  });

  it('holds an AI task\'s override back for a queued start or a usage-limit hold, though nothing executes', () => {
    const onMarkComplete = vi.fn();
    render(<TaskCard task={makeTask({ status: 'pending' })} models={emptyModels} isExecuting={false} runActive onMarkComplete={onMarkComplete} />);
    fireEvent.click(screen.getByText('Test task'));

    const button = screen.getByText('Mark complete') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Stop the run first/)).toBeTruthy();
    fireEvent.click(button);
    expect(onMarkComplete).not.toHaveBeenCalled();
  });

  it('lets a manual task be signed off during a run', () => {
    const onMarkComplete = vi.fn();
    render(<TaskCard task={makeTask({ status: 'pending', type: 'user', assignedRunner: undefined })} models={emptyModels} isExecuting onMarkComplete={onMarkComplete} />);
    fireEvent.click(screen.getByText('Test task'));

    fireEvent.click(screen.getByText('Mark complete'));

    expect(onMarkComplete).toHaveBeenCalledWith('t1');
  });

  it('waits for a manual task\'s steps before it can be signed off', () => {
    render(
      <TaskCard
        task={makeTask({ status: 'pending', type: 'user', assignedRunner: undefined, userSteps: [{ order: 1, instruction: 'Rotate the key', completed: false }] })}
        models={emptyModels}
        isExecuting
        onMarkComplete={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Test task'));

    expect((screen.getByText('Mark complete') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Complete all steps above first')).toBeTruthy();
  });

  it('offers no override on a task that is running', () => {
    render(<TaskCard task={makeTask({ status: 'running' })} models={emptyModels} isExecuting onMarkComplete={vi.fn()} />);
    fireEvent.click(screen.getByText('Test task'));

    expect(screen.queryByText('Mark complete')).toBeNull();
  });
});

describe('TaskCard — runner output', () => {
  const withOutput = (output: string) => render(
    <TaskCard task={makeTask({ status: 'running' })} models={emptyModels} isExecuting output={output} />,
  );

  it('shows the newest line while collapsed, so a running task reads without opening it', () => {
    withOutput('compiling\nrunning tests\n\n');
    expect(document.querySelector('.task-output-peek')!.textContent).toBe('running tests');
    expect(document.querySelector('.task-output-pre')).toBeNull();
  });

  it('opens the full tail when the peek line is clicked', () => {
    withOutput('compiling\nrunning tests');
    act(() => { fireEvent.click(document.querySelector('.task-output-peek')!); });

    expect(document.querySelector('.task-output-pre')!.textContent).toBe('compiling\nrunning tests');
    expect(document.querySelector('.task-output-peek')).toBeNull();
  });

  it('shows nothing when no output has arrived', () => {
    render(<TaskCard task={makeTask({ status: 'running' })} models={emptyModels} isExecuting />);
    expect(document.querySelector('.task-output-peek')).toBeNull();
  });
});

describe('TaskCard — subtask order labels', () => {
  it('renders a dotted order label for subtasks, prefixed with the parent order', () => {
    render(
      <TaskCard
        task={makeTask({
          order: 2,
          subtasks: [{
            id: 's1',
            order: 1,
            title: 'Subtask one',
            description: '',
            type: 'ai',
            status: 'pending',
            dependencies: [],
            subtasks: [],
            assignedRunner: 'claude-code',
            taskMode: 'build',
          }],
        })}
        models={emptyModels}
      />,
    );
    act(() => { fireEvent.click(screen.getByText('Test task')); });
    expect(document.querySelector('.subtask-order')!.textContent).toBe('2.1.');
  });
});

describe('TaskCard — a subtask on a different runner than its parent', () => {
  it('scopes the subtask\'s model dropdown to ITS OWN runner\'s catalog via modelsByRunner, not the parent\'s', () => {
    const subtask: Task = {
      id: 's1', order: 1, title: 'Subtask one', description: '', type: 'ai', status: 'pending',
      dependencies: [], subtasks: [], assignedRunner: 'opencode', taskMode: 'build',
    };
    render(
      <TaskCard
        task={makeTask({ assignedRunner: 'claude-code', subtasks: [subtask] })}
        // The parent-scoped flat list intentionally carries no models, so the
        // parent's own selector doesn't render — only `modelsByRunner['opencode']`
        // can be the source of the subtask's options.
        models={emptyModels}
        modelsByRunner={{
          opencode: [{ modelId: 'opencode/x', modelLabel: 'X Model', runnerProvider: 'opencode', variants: [] }],
        }}
        onModelChange={vi.fn()}
      />,
    );
    act(() => { fireEvent.click(screen.getByText('Test task')); });
    act(() => { fireEvent.click(screen.getByText('Subtask one')); });
    const trigger = document.querySelector('.model-picker-trigger');
    expect(trigger).toBeTruthy();
    act(() => { fireEvent.click(trigger!); });
    expect(document.querySelector('.model-picker-item-label')?.textContent).toBe('X Model');
  });
});

describe('TaskCard — Stalled state', () => {
  it('renders Stalled instead of Running when idleSince is set on an in_progress task', () => {
    render(
      <TaskCard
        task={makeTask({ status: 'in_progress' })}
        models={emptyModels}
        isExecuting
        run={{ idleSince: '2026-08-18T00:00:00.000Z' }}
      />,
    );

    expect(screen.getByText('Stalled')).toBeTruthy();
    expect(screen.queryByText('Running')).toBeNull();
    expect(document.querySelector('.task-status-badge.status-stalled')).toBeTruthy();
  });

  it('renders the normal Running state when idleSince is absent', () => {
    render(
      <TaskCard
        task={makeTask({ status: 'in_progress' })}
        models={emptyModels}
        isExecuting
      />,
    );

    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.queryByText('Stalled')).toBeNull();
  });

  it('reverts to Running the moment idleSince clears', () => {
    const { rerender } = render(
      <TaskCard
        task={makeTask({ status: 'in_progress' })}
        models={emptyModels}
        isExecuting
        run={{ idleSince: '2026-08-18T00:00:00.000Z' }}
      />,
    );
    expect(screen.getByText('Stalled')).toBeTruthy();

    rerender(
      <TaskCard
        task={makeTask({ status: 'in_progress' })}
        models={emptyModels}
        isExecuting
        run={{ idleSince: null }}
      />,
    );

    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.queryByText('Stalled')).toBeNull();
  });
});

describe('TaskCard — origin', () => {
  it('leaves the supervisor origin in the planner conversation', () => {
    render(<TaskCard task={makeTask({ addedBy: 'supervisor' })} models={emptyModels} isExecuting={false} />);
    expect(screen.queryByText('Added by supervisor')).toBeNull();
    expect(screen.getByRole('button', { name: /Test task/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('marks no task the user planned', () => {
    render(<TaskCard task={makeTask()} models={emptyModels} isExecuting={false} />);
    expect(screen.queryByText('Added by supervisor')).toBeNull();
  });
});

describe('TaskCard — the assignment flag', () => {
  const scope = { enabledRunners: ['claude-code'], allowlist: { 'claude-code': ['claude-sonnet-4'] } };
  const card = (task: Task, runnerScope = scope) => (
    <TaskCard task={task} models={emptyModels} isExecuting={false} runnerScope={runnerScope} />
  );

  it('says the task\'s runner is switched off, while the task stays runnable', () => {
    render(card(makeTask({ assignedRunner: 'codex' })));
    expect(screen.getByText('codex is switched off')).toBeTruthy();
  });

  it('says the task\'s model is not in the allowlist', () => {
    render(card(makeTask({ assignedModel: { modelId: 'claude-opus-4', modelLabel: 'Opus 4' } })));
    expect(screen.getByText('Opus 4 is not in the allowlist')).toBeTruthy();
  });

  it('reads an allowlist as the planner\'s catalog does: ids only another runner lists limit nothing', () => {
    const models = { 'claude-code': [{ modelId: 'claude-opus-4', modelLabel: 'Opus 4', variants: [] }], codex: [{ modelId: 'gpt-5', modelLabel: 'GPT-5', variants: [] }] };
    render(card(makeTask({ assignedModel: { modelId: 'claude-opus-4', modelLabel: 'Opus 4' } }), { enabledRunners: ['claude-code'], allowlist: { 'claude-code': ['gpt-5'] }, models }));
    expect(screen.queryByText(/not in the allowlist/)).toBeNull();
  });

  it('says nothing for a task inside both, or with no scope known yet', () => {
    const { rerender } = render(card(makeTask()));
    expect(screen.queryByText(/switched off|not in the allowlist/)).toBeNull();
    rerender(<TaskCard task={makeTask({ assignedRunner: 'codex' })} models={emptyModels} isExecuting={false} />);
    expect(screen.queryByText(/switched off|not in the allowlist/)).toBeNull();
  });

  it('words what the flag means by where the task stands, not that every flagged task still runs', () => {
    const tip = () => screen.getByText('codex is switched off').getAttribute('title');
    const { rerender } = render(card(makeTask({ assignedRunner: 'codex', status: 'failed' })));
    expect(tip()).toBe('Failed; a retry would run it there unless moved. Change its runner or model to move it, or ask the planner to.');
    rerender(card(makeTask({ assignedRunner: 'codex', status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt: '2099-01-01T00:00:00.000Z' })));
    expect(tip()).toBe('Paused on a usage limit; resumes there at the reset unless moved. Change its runner or model to move it, or ask the planner to.');
    rerender(card(makeTask({ assignedRunner: 'codex', status: 'in_progress' })));
    expect(tip()).toBe('Already running as assigned. Change its runner or model to move it, or ask the planner to.');
  });

  it('flags a subtask on a switched-off runner too', () => {
    const sub = makeTask({ id: 't1.1', order: 1, title: 'Sub', assignedRunner: 'codex' });
    render(card(makeTask({ subtasks: [sub] })));
    act(() => { fireEvent.click(screen.getByText('Test task')); });
    expect(screen.getByText('codex is switched off')).toBeTruthy();
  });
});
