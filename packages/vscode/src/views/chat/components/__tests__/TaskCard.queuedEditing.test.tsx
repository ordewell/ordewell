import React from 'react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import TaskCard from '../TaskCard';
import SubTaskCard from '../SubTaskCard';
import type { DiscoveredModel, Task } from '@ordewell/core';

const noop = (): void => {};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

const MODELS: DiscoveredModel[] = [
  { modelId: 'openai/gpt', modelLabel: 'GPT', variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
  { modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet', variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
];
const RUNNERS = [{ id: 'claude-code', displayName: 'Claude Code' }, { id: 'codex', displayName: 'Codex' }];
const MODES = [
  { id: 'build', label: 'Build', description: 'Edit files' },
  { id: 'plan', label: 'Read-only', description: 'Lands nothing' },
];
const SKILLS = [{ name: 'tdd', description: 'Test first' }];

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 't1', order: 1, title: 'Queued work', description: '', type: 'ai', status: 'pending',
    dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build',
    assignedModel: { modelId: 'openai/gpt', modelLabel: 'GPT', thinkingEffort: 'high', availableVariants: ['low', 'high'] },
    prompt: 'Do the queued work',
    ...over,
  };
}

const handlers = {
  onRunnerChange: vi.fn(),
  onModelChange: vi.fn(),
  onModeChange: vi.fn(),
  onPromptChange: vi.fn(),
  onSkillsChange: vi.fn(),
  onOpsChange: vi.fn(),
  onDependenciesChange: vi.fn(),
};

function renderCard(over: Partial<React.ComponentProps<typeof TaskCard>> = {}) {
  return render(
    <TaskCard
      task={makeTask()}
      models={MODELS}
      modes={MODES}
      runners={RUNNERS}
      taskSkills={SKILLS}
      isExecuting
      expanded
      onExpandedChange={noop}
      {...handlers}
      {...over}
    />,
  );
}

describe('a queued task keeps its editors while another task runs', () => {
  it('offers the runner, model, mode, prompt, skills and ops controls', () => {
    const { container } = renderCard();

    expect(screen.getByLabelText('Runner')).toBeTruthy();
    expect(screen.getByLabelText('Mode')).toBeTruthy();
    expect(container.querySelector('.task-prompt-editable')).toBeTruthy();
    expect(container.querySelector('.task-skill-add')).toBeTruthy();
    expect(container.querySelector('.task-ops-toggle')).toBeTruthy();
    expect(container.querySelector('.task-assignment-readonly')).toBeNull();
  });

  it('posts a runner change', () => {
    renderCard();

    fireEvent.change(screen.getByLabelText('Runner'), { target: { value: 'codex' } });

    expect(handlers.onRunnerChange).toHaveBeenCalledWith('t1', 'codex');
  });

  it('posts a model and thinking effort picked while queued', () => {
    renderCard();

    fireEvent.click(document.querySelector('.model-picker-trigger')!);
    fireEvent.click(document.querySelectorAll('.model-picker-item')[1]);

    expect(handlers.onModelChange).toHaveBeenCalledWith('t1', {
      modelId: 'claude-sonnet-4-5',
      modelLabel: 'Sonnet',
      thinkingEffort: 'high',
      availableVariants: ['low', 'high'],
    });
  });

  it('posts a mode change, and keeps a task waiting on its approval record or a merge gate editable', () => {
    const { rerender } = renderCard({ run: { waitsForApproval: true } });
    expect(screen.getByLabelText('Runner')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'plan' } });
    expect(handlers.onModeChange).toHaveBeenCalledWith('t1', 'plan');

    rerender(<TaskCard task={makeTask()} models={MODELS} modes={MODES} runners={RUNNERS} taskSkills={SKILLS}
      isExecuting expanded onExpandedChange={noop} run={{ mergeGate: ['t0'] }} siblings={[makeTask({ id: 't0', title: 'Before' })]} {...handlers} />);
    expect(screen.getByLabelText('Runner')).toBeTruthy();
  });

  it('posts a dependency edit and an ops flip', () => {
    const tasks = [makeTask({ id: 't0', order: 1, title: 'Before' }), makeTask({ id: 't1', order: 2 })];
    renderCard({ task: tasks[1], siblings: tasks });

    fireEvent.click(screen.getByTitle('Edit dependencies'));
    fireEvent.click(document.querySelector('.task-dep-option input')!);
    expect(handlers.onDependenciesChange).toHaveBeenCalledWith('t1', ['t0']);

    fireEvent.click(document.querySelector('.task-ops-toggle input')!);
    expect(handlers.onOpsChange).toHaveBeenCalledWith('t1', true);
  });

  it('keeps a blocked task editable, waiting on the failure rather than on its card', () => {
    renderCard({ task: makeTask({ status: 'blocked' }) });

    expect(screen.getByLabelText('Runner')).toBeTruthy();
    expect(document.querySelector('.task-prompt-editable')).toBeTruthy();
  });
});

describe('editable prompt keyboard controls', () => {
  it('focuses and activates a task prompt without toggling the card', () => {
    const onExpandedChange = vi.fn();
    renderCard({ onExpandedChange });

    const prompt = screen.getByRole('button', { name: /Edit task prompt:/ });
    prompt.focus();
    expect(prompt).toHaveFocus();
    fireEvent.keyDown(prompt, { key: 'Enter' });
    // A native button turns keyboard activation into click; fireEvent models that activation.
    fireEvent.click(prompt);

    expect(screen.getByRole('textbox')).toBeTruthy();
    expect(onExpandedChange).not.toHaveBeenCalled();
  });

  it('focuses and activates a subtask prompt without toggling its card', () => {
    const onPromptChange = vi.fn();
    const parent = makeTask({ id: 'p1', status: 'in_progress' });
    render(<SubTaskCard task={makeTask({ id: 's1' })} parentTask={parent} models={[]} isExecuting onPromptChange={onPromptChange} />);
    fireEvent.click(document.querySelector('.subtask-card-header')!);

    const prompt = screen.getByRole('button', { name: /Edit subtask prompt:/ });
    prompt.focus();
    expect(prompt).toHaveFocus();
    fireEvent.keyDown(prompt, { key: ' ' });
    fireEvent.click(prompt);

    expect(screen.getByRole('textbox')).toBeTruthy();
    expect(document.querySelector('.subtask-card')?.classList.contains('expanded')).toBe(true);
    expect(onPromptChange).not.toHaveBeenCalled();
  });

  it('does not expose read-only prompts as controls', () => {
    renderCard({ task: makeTask({ status: 'in_progress' }) });

    expect(screen.queryByRole('button', { name: /Edit task prompt:/ })).toBeNull();
    expect(screen.getByText('Do the queued work').className).toContain('task-prompt-readonly');
  });
});

describe('a subtask reads its own execution state, not its parent\'s', () => {
  const parent = makeTask({ id: 'p1', order: 1, status: 'in_progress' });
  const sub = makeTask({ id: 's1', order: 1, status: 'pending', title: 'Queued subtask' });
  const open = (task: Task) => {
    render(<SubTaskCard task={task} parentTask={parent} models={MODELS} modes={MODES} runners={RUNNERS}
      taskSkills={SKILLS} isExecuting onRunnerChange={handlers.onRunnerChange} onModelChange={handlers.onModelChange}
      onModeChange={handlers.onModeChange} onPromptChange={handlers.onPromptChange} onSkillsChange={handlers.onSkillsChange} />);
    fireEvent.click(document.querySelector('.subtask-card-header')!);
  };

  it('keeps a pending subtask\'s editors while its parent runs', () => {
    open(sub);
    expect(screen.getByLabelText('Runner')).toBeTruthy();
    expect(document.querySelector('.subtask-prompt-editable')).toBeTruthy();
    expect(document.querySelector('.task-skill-add')).toBeTruthy();
  });

  it('goes read-only once that subtask itself starts', () => {
    open({ ...sub, status: 'in_progress' });
    expect(screen.queryByLabelText('Runner')).toBeNull();
    expect(document.querySelector('.subtask-prompt-editable')).toBeNull();
    expect(document.querySelector('.subtask-prompt-readonly')).toBeTruthy();
  });
});

describe('a task execution has reached is read-only during the run', () => {
  it.each([
    ['a starting task whose worktree exists but whose status has not caught up', makeTask({ status: 'approved' }), { isolation: { state: 'active' } }],
    ['a task its run already names in_progress before the plan refresh', makeTask({ status: 'approved' }), { status: 'in_progress' }],
    ['a running task', makeTask({ status: 'in_progress' }), {}],
    ['a stalled task', makeTask({ status: 'in_progress' }), { idleSince: '2026-10-25T10:00:00Z' }],
    ['a task waiting mid-attempt for input', makeTask({ status: 'awaiting_user', awaitingReason: 'input' }), {}],
    ['a task waiting on its runner\'s approval', makeTask({ status: 'approved' }), { awaitingApproval: 2 }],
    ['a completed task', makeTask({ status: 'completed' }), {}],
    ['a failed task', makeTask({ status: 'failed' }), {}],
    ['a skipped task', makeTask({ status: 'skipped' }), {}],
  ])('leaves %s without editors', (_label, task, run) => {
    const { container } = renderCard({ task, run });
    expect(screen.queryByLabelText('Runner')).toBeNull();
    expect(screen.queryByLabelText('Mode')).toBeNull();
    expect(container.querySelector('.task-prompt-editable')).toBeNull();
    expect(container.querySelector('.task-prompt-textarea')).toBeNull();
    expect(container.querySelector('.task-skill-add')).toBeNull();
    expect(container.querySelector('.task-ops-toggle')).toBeNull();
  });
});

describe('fresh status invalidates a draft safely', () => {
  it('closes an open model picker when the task starts, showing the assignment instead', () => {
    const { container, rerender } = renderCard();
    fireEvent.click(container.querySelector('.model-picker-trigger')!);
    expect(container.querySelector('.model-picker-dropdown')).toBeTruthy();

    rerender(<TaskCard task={makeTask({ status: 'in_progress' })} models={MODELS} modes={MODES} runners={RUNNERS}
      taskSkills={SKILLS} isExecuting expanded onExpandedChange={noop} {...handlers} />);

    expect(container.querySelector('.model-picker-dropdown')).toBeNull();
    expect(container.querySelector('.task-assignment-readonly')).toBeTruthy();
  });

  it('shows the accepted prompt after a save the host has not echoed back', () => {
    const { container } = renderCard();
    fireEvent.click(container.querySelector('.task-prompt-editable')!);
    fireEvent.change(container.querySelector('.task-prompt-textarea')!, { target: { value: 'an unaccepted draft' } });
    fireEvent.keyDown(container.querySelector('.task-prompt-textarea')!, { key: 'Enter', ctrlKey: true });

    expect(handlers.onPromptChange).toHaveBeenCalledWith('t1', 'an unaccepted draft');
    expect(container.querySelector('.task-prompt-textarea')).toBeNull();
    expect(container.querySelector('.task-prompt-editable')?.textContent).toContain('Do the queued work');
  });

  it('closes an open prompt editor when the task starts, and does not bring the draft back', () => {
    const { container, rerender } = renderCard();
    fireEvent.click(container.querySelector('.task-prompt-editable')!);
    fireEvent.change(container.querySelector('.task-prompt-textarea')!, { target: { value: 'an unsaved draft' } });

    rerender(<TaskCard task={makeTask({ status: 'in_progress' })} models={MODELS} modes={MODES} runners={RUNNERS}
      taskSkills={SKILLS} isExecuting expanded onExpandedChange={noop} {...handlers} />);
    expect(container.querySelector('.task-prompt-textarea')).toBeNull();
    expect(container.querySelector('.task-prompt-readonly')?.textContent).toBe('Do the queued work');

    rerender(<TaskCard task={makeTask()} models={MODELS} modes={MODES} runners={RUNNERS}
      taskSkills={SKILLS} isExecuting expanded onExpandedChange={noop} {...handlers} />);
    expect(container.querySelector('.task-prompt-textarea')).toBeNull();
  });
});

describe('task types keep their own restrictions during the run', () => {
  it('offers a script task no editors, only its body', () => {
    const { container } = renderCard({ task: makeTask({ type: 'script', commands: [['git', 'push']], assignedRunner: undefined as never, taskMode: undefined, prompt: undefined }) });
    expect(container.querySelector('.task-script-body')).toBeTruthy();
    expect(screen.queryByLabelText('Runner')).toBeNull();
    expect(screen.queryByLabelText('Mode')).toBeNull();
    expect(container.querySelector('.task-prompt-textarea')).toBeNull();
    expect(container.querySelector('.task-skill-add')).toBeNull();
    expect(container.querySelector('.task-ops-toggle')).toBeNull();
  });

  it('offers a manual task no runner-side editors', () => {
    const { container } = renderCard({ task: makeTask({ type: 'user', prompt: undefined }) });
    expect(screen.queryByLabelText('Runner')).toBeNull();
    expect(screen.queryByLabelText('Mode')).toBeNull();
    expect(container.querySelector('.task-prompt-textarea')).toBeNull();
    expect(container.querySelector('.task-skill-add')).toBeNull();
    expect(container.querySelector('.task-ops-toggle')).toBeNull();
  });
});
