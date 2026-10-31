import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TaskCard from '../TaskCard';
import SubTaskCard from '../SubTaskCard';
import type { Task, TaskIsolation } from '@ordewell/core';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1', order: 1, title: 'Test task', description: 'A task', type: 'ai', status: 'pending',
    dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build',
    ...overrides,
  };
}

const noop = () => {};
const handlers = {
  onCancel: noop, onSkip: noop, onForceStart: noop, onMarkComplete: noop, onMarkIncomplete: noop, onOpsChange: noop,
};
const isolated = { branch: 'ordewell/t1', worktree: '/wt/t1', repos: ['.'] };
const buttons = (): string[] =>
  Array.from(document.querySelectorAll('.task-actions button')).map((b) => b.textContent ?? '');
const marks = (): string[] =>
  Array.from(document.querySelectorAll('.task-mark-btn')).map((b) => b.textContent ?? '');
const badge = (): Element | null => document.querySelector('.task-status-badge');

describe('a task card, pinned before its rules move to core', () => {
  it.each([
    ['completed', 'Done', 'status-completed'],
    ['failed', 'Failed', 'status-failed'],
    ['in_progress', 'Running', 'status-running'],
    ['blocked', 'Blocked', 'status-blocked'],
    ['pending', 'To do', 'status-pending'],
    ['approved', 'To do', 'status-pending'],
    ['awaiting_user', 'Awaiting User', 'status-blocked'],
  ] as const)('%s reads "%s"', (status, label, cls) => {
    render(<TaskCard task={makeTask({ status })} models={[]} isExecuting />);
    expect(badge()?.textContent).toBe(label);
    expect(badge()?.className).toBe(`task-status-badge ${cls}`);
  });

  it('reads Stalled while running with no recent output', () => {
    render(<TaskCard task={makeTask({ status: 'in_progress' })} models={[]} isExecuting run={{ idleSince: '2026-01-01T00:00:00Z' }} />);
    expect(badge()?.textContent).toBe('Stalled');
    expect(badge()?.className).toBe('task-status-badge status-stalled');
    expect(document.querySelector('.task-check')?.getAttribute('title')).toBe('Stalled: no output recently');
  });

  it('says a running task\'s report was received until the run takes it back, never Done (ADR-0018, L1)', () => {
    const task = makeTask({ status: 'in_progress', attempted: true });
    const { rerender } = render(<TaskCard task={task} models={[]} isExecuting run={{ completionReceived: 'done' }} />);
    expect(badge()?.textContent).toBe('Completion received');
    expect(badge()?.className).toBe('task-status-badge status-running');

    rerender(<TaskCard task={task} models={[]} isExecuting run={{ completionReceived: 'blocked' }} />);
    expect(badge()?.textContent).toBe('Blocked report received');

    rerender(<TaskCard task={task} models={[]} isExecuting run={{}} />);
    expect(badge()?.textContent).toBe('Running');
  });

  it('says a running subtask\'s report was received as its parent card does', () => {
    const parent = makeTask({ id: 'p1', order: 2, title: 'Parent' });
    render(<SubTaskCard task={makeTask({ status: 'in_progress', attempted: true })} parentTask={parent} models={[]} isExecuting run={{ completionReceived: 'failed' }} />);
    expect(badge()?.textContent).toBe('Failure report received');
  });

  it('says a starting task\'s runner is connecting Ordewell\'s tools, then the retry, until the run drops it (ADR-0025)', () => {
    const task = makeTask({ status: 'in_progress', attempted: true });
    const { rerender } = render(<TaskCard task={task} models={[]} isExecuting run={{ attaching: 1 }} />);
    expect(badge()?.textContent).toBe('Connecting Ordewell\'s tools');
    expect(badge()?.className).toBe('task-status-badge status-running');

    rerender(<TaskCard task={task} models={[]} isExecuting run={{ attaching: 2 }} />);
    expect(badge()?.textContent).toBe('Connecting Ordewell\'s tools, retry');

    rerender(<TaskCard task={task} models={[]} isExecuting run={{}} />);
    expect(badge()?.textContent).toBe('Running');
  });

  it('says a starting subtask\'s runner is connecting Ordewell\'s tools as its parent card does', () => {
    const parent = makeTask({ id: 'p1', order: 2, title: 'Parent' });
    render(<SubTaskCard task={makeTask({ status: 'in_progress', attempted: true })} parentTask={parent} models={[]} isExecuting run={{ attaching: 1 }} />);
    expect(badge()?.textContent).toBe('Connecting Ordewell\'s tools');
  });

  it.each([
    ['completed', 'Executed'],
    ['in_progress', 'Running'],
    ['pending', 'To do'],
    ['failed', 'Failed'],
  ] as const)('the check on a %s task is titled "%s"', (status, title) => {
    render(<TaskCard task={makeTask({ status })} models={[]} />);
    expect(document.querySelector('.task-check')?.getAttribute('title')).toBe(title);
  });

  it('labels an ops task that changed tracked files, and says what to do', () => {
    render(<TaskCard task={makeTask({ status: 'awaiting_user', awaitingReason: 'files-changed', ops: true })} models={[]} isExecuting expanded onExpandedChange={noop} />);
    expect(badge()?.textContent).toBe('Changed tracked files');
    expect(document.querySelector('.task-ops-note.warn')?.textContent)
      .toBe('This ops task changed tracked files in your checkout, and nothing was committed. Check the changes, then mark it complete or retry it.');
  });

  it('badges a skipped task apart from a done one, with why, whether or not a run is drawn', () => {
    const { unmount } = render(<TaskCard task={makeTask({ status: 'skipped', skipReason: 'the host has no GPU' })} models={[]} />);
    expect(badge()?.textContent).toBe('Skipped: the host has no GPU');
    expect(badge()?.className).toBe('task-status-badge status-skipped');
    expect(document.querySelector('.task-check')?.getAttribute('title')).toBe('Skipped: nothing of it landed');
    unmount();
    render(<TaskCard task={makeTask({ status: 'skipped' })} models={[]} />);
    expect(badge()?.textContent).toBe('Skipped');
  });

  it('reads a held task with its reason, so it does not look merely unstarted', () => {
    render(<TaskCard task={makeTask()} models={[]} run={{ holdReason: 'could not connect to Ordewell\'s tools; start it again' }} />);
    expect(badge()?.textContent).toBe('On hold: could not connect to Ordewell\'s tools; start it again');
  });

  it('unfolds a skip reason cut to its row on a click, and folds it back', () => {
    const observed = vi.fn();
    vi.stubGlobal('ResizeObserver', class { constructor(private cb: () => void) {} observe() { observed(); this.cb(); } disconnect() {} });
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
    try {
      render(<TaskCard task={makeTask({ status: 'skipped', skipReason: 'a read-only review that did its job' })} models={[]} />);
      expect(observed).toHaveBeenCalled();
      const b = screen.getByRole('button', { name: 'Skipped: a read-only review that did its job' });
      expect(b.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(b);
      expect(b.getAttribute('aria-expanded')).toBe('true');
      expect(b.className).toContain('expanded');
      fireEvent.click(b);
      expect(b.getAttribute('aria-expanded')).toBe('false');
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it('offers Skip on a failed task, and Mark Complete on a skipped one', () => {
    const { unmount } = render(<TaskCard task={makeTask({ status: 'failed' })} models={[]} isExecuting expanded onExpandedChange={noop} {...handlers} />);
    expect(buttons()).toEqual(['Skip']);
    unmount();
    render(<TaskCard task={makeTask({ status: 'skipped' })} models={[]} isExecuting expanded onExpandedChange={noop} {...handlers} />);
    expect(buttons()).toEqual([]);
    expect(marks()).toEqual(['Mark complete']);
  });

  it('counts approvals beyond one', () => {
    render(<TaskCard task={makeTask({ status: 'in_progress', attempted: true })} models={[]} isExecuting run={{ awaitingApproval: 3 }} />);
    expect(document.querySelector('.task-approval-badge')?.textContent).toBe('Waiting for approval (3)');
  });

  it('badges an ops task, never a manual one', () => {
    const { unmount } = render(<TaskCard task={makeTask({ ops: true })} models={[]} />);
    expect(document.querySelector('.task-type-badge.ops')?.textContent).toBe('Ops');
    unmount();
    render(<TaskCard task={makeTask({ ops: true, type: 'user' })} models={[]} />);
    expect(document.querySelector('.task-type-badge.ops')).toBeNull();
  });

  describe('a script task (ADR-0035)', () => {
    const scriptTask = (over: Partial<Task> = {}): Task => makeTask({
      type: 'script', assignedRunner: undefined as never, taskMode: undefined, description: 'Tag it',
      commands: [['git', 'tag', 'v1'], ['git', 'push', 'origin', 'v1']], timeoutMs: 90_000, ...over,
    });

    it('badges it Script, not AI or Ops', () => {
      render(<TaskCard task={scriptTask()} models={[]} />);
      expect(document.querySelector('.task-type-badge.script')?.textContent).toBe('Script');
      expect(document.querySelector('.task-type-badge.ai')).toBeNull();
      expect(document.querySelector('.task-type-badge.ops')).toBeNull();
    });

    it('shows the commands one to a line, and the time limit, in a read-only monospace block where the prompt goes', () => {
      render(<TaskCard task={scriptTask()} models={[]} expanded onExpandedChange={noop} />);
      const body = document.querySelector('.task-script-body');
      expect(body?.tagName).toBe('PRE');
      expect(body?.textContent).toBe('git tag v1\ngit push origin v1\n\nTime limit: 90 seconds.');
      expect(document.querySelector('textarea')).toBeNull();
      expect(document.querySelector('.task-prompt-editable')).toBeNull();
    });

    it('shows a script as written, a control character spelled out', () => {
      render(<TaskCard task={scriptTask({ commands: undefined, script: 'set -e\necho hi\x1b[2J', timeoutMs: undefined })} models={[]} expanded onExpandedChange={noop} />);
      expect(document.querySelector('.task-script-body')?.textContent).toBe('set -e\necho hi<U+001B>[2J\n\nTime limit: 10 minutes.');
    });

    it('offers no prompt editing, runner, model or mode picker, skills, or ops toggle, even before the plan runs', () => {
      render(<TaskCard task={scriptTask()} models={[]} runners={[{ id: 'claude-code', displayName: 'Claude Code' }]} expanded onExpandedChange={noop}
        onRunnerChange={noop} onModelChange={noop} onModeChange={noop} onPromptChange={noop} onSkillsChange={noop} {...handlers} />);
      expect(document.querySelector('.task-ops-toggle')).toBeNull();
      expect(document.querySelector('select')).toBeNull();
      expect(document.querySelector('.task-prompt-textarea')).toBeNull();
      expect(document.querySelector('.task-assignment')).toBeNull();
      expect(screen.queryByText('Runner')).toBeNull();
      expect(screen.queryByText('Mode')).toBeNull();
    });
  });

  it('badges a task a failure blocks with the failed task it waits on, in a subtask too (ADR-0034)', () => {
    const failed = makeTask({ id: 't1', order: 1, title: 'Setup', status: 'failed' });
    const parent = makeTask({ id: 't2', order: 2, title: 'Build', subtasks: [
      makeTask({ id: 's1', order: 1, title: 'First', status: 'failed' }),
      makeTask({ id: 's2', order: 2, title: 'Second', dependencies: ['s1'] }),
    ] });
    const plan = [failed, parent, makeTask({ id: 't3', order: 3, dependencies: ['t1'] })];

    const { unmount } = render(<TaskCard task={plan[2]} models={[]} siblings={plan} />);
    expect(badge()?.textContent).toBe('Blocked by #1');
    expect(badge()?.className).toContain('status-blocked');
    unmount();

    render(<SubTaskCard task={parent.subtasks[1]} parentTask={parent} models={[]} tasks={plan} />);
    expect(badge()?.textContent).toBe('Blocked by #2.1');
  });

  it('badges a task added after the plan was approved as waiting for the user, with an Approve button that force starts it (ADR-0035)', () => {
    const started: string[] = [];
    render(<TaskCard task={makeTask()} models={[]} isExecuting run={{ waitsForApproval: true }} onForceStart={(id) => started.push(id)} />);
    const badge = document.querySelector('.task-isolation-badge.approval');
    expect(badge?.textContent).toBe('Waits for your approval');
    expect(badge?.getAttribute('title')).toBe('Added after you approved the plan, so it does not start on its own. Approve it, or Approve all, and it starts once its dependencies finish.');

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(started).toEqual(['t1']);
  });

  it('drops that badge once the task has started', () => {
    render(<TaskCard task={makeTask({ status: 'in_progress' })} models={[]} isExecuting run={{ waitsForApproval: true }} />);
    expect(document.querySelector('.task-isolation-badge.approval')).toBeNull();
  });

  it('names what a merge gate waits on', () => {
    render(<TaskCard task={makeTask({ id: 'o2', order: 2 })} models={[]} run={{ mergeGate: ['t1', 'ghost'] }} siblings={[makeTask({ id: 't1', order: 1, title: 'Setup' })]} />);
    const gate = document.querySelector('.task-isolation-badge.gate');
    expect(gate?.textContent).toBe('Waits for Merge all');
    expect(gate?.getAttribute('title')).toBe('The work of #1, ghost is not merged into your branch yet. Merge all lets this task go on.');
  });

  it.each([
    ['api', 'Conflict in api', 'Integrating this task conflicted in api: a.ts, b.ts. Its worktree and branch are kept.'],
    ['.', 'Conflict', 'Integrating this task conflicted: a.ts, b.ts. Its worktree and branch are kept.'],
  ])('badges a conflict in %s', (conflictRepo, text, title) => {
    const isolation: TaskIsolation = { ...isolated, state: 'conflict', conflictRepo, conflictFiles: ['a.ts', 'b.ts'] };
    render(<TaskCard task={makeTask({ status: 'awaiting_user' })} models={[]} run={{ isolation }} />);
    const el = document.querySelector('.task-isolation-badge.conflict');
    expect(el?.textContent).toBe(text);
    expect(el?.getAttribute('title')).toBe(title);
  });

  it.each([
    [{ attempt: 1, limit: 3 }, 'Repairing (1 of 3)'],
    [undefined, 'Repairing'],
  ])('badges a repair in flight', (repair, text) => {
    const isolation: TaskIsolation = { ...isolated, state: 'repairing', conflictFiles: ['a.ts'], repair };
    render(<TaskCard task={makeTask({ status: 'in_progress' })} models={[]} run={{ isolation }} />);
    const el = document.querySelector('.task-isolation-badge.repairing');
    expect(el?.textContent).toBe(text);
    expect(el?.getAttribute('title')).toBe('Repairing the conflict in its own worktree: a.ts.');
  });

  it('badges a repair waiting for a slot as that, with no Conflict badge and no Resolve', () => {
    const isolation: TaskIsolation = { ...isolated, state: 'conflict', conflictFiles: ['a.ts'], repairWaits: 'slot' };
    render(<TaskCard task={makeTask({ status: 'pending' })} models={[]} run={{ isolation }} isExecuting onCancel={vi.fn()} onResolveConflict={vi.fn()} expanded />);

    expect(document.querySelector('.task-isolation-badge.repairing')?.textContent).toBe('Repair waits for a free slot');
    expect(document.querySelector('.task-isolation-badge.conflict')).toBeNull();
    expect(screen.queryByText('Resolve')).toBeNull();
    expect(screen.getByText('Cancel')).toBeTruthy();
  });

  it('offers no second resolver for a conflict that has one', () => {
    const isolation: TaskIsolation = { ...isolated, state: 'conflict', conflictFiles: ['a.ts'], resolver: 't9' };
    render(<TaskCard task={makeTask({ status: 'awaiting_user', awaitingReason: 'conflict' })} models={[]} run={{ isolation }} onResolveConflict={vi.fn()} expanded />);

    expect(document.querySelector('.task-isolation-badge.conflict')?.getAttribute('title')).toContain('Task t9 is resolving it.');
    expect(screen.queryByText('Resolve')).toBeNull();
  });

  it('notes the files a repair was for in the details', () => {
    const isolation: TaskIsolation = { ...isolated, state: 'integrated', repairedFiles: ['a.ts'] };
    render(<TaskCard task={makeTask({ status: 'completed' })} models={[]} run={{ isolation }} expanded onExpandedChange={noop} />);
    expect(document.querySelector('.task-isolation-repaired-note')?.textContent).toBe('Landed after repairing a conflict in a.ts.');
  });

  it('notes a force start past the merge gate', () => {
    render(<TaskCard task={makeTask({ status: 'in_progress', forcedPastGate: ['Fix', 'Bump'] })} models={[]} expanded onExpandedChange={noop} />);
    expect(screen.getByText('Force-started before the work of Fix, Bump was merged into your branch.')).toBeTruthy();
  });

  it('names dependencies by order, and an unknown one by its id', () => {
    render(<TaskCard task={makeTask({ id: 't3', order: 3, dependencies: ['t1', 'ghost'] })} models={[]} isExecuting
      siblings={[makeTask({ id: 't1', order: 1, title: 'Setup' })]} expanded onExpandedChange={noop} />);
    expect(document.querySelector('.task-dep-badge.dep-in')?.getAttribute('title')).toBe('Depends on: #1, ghost');
    expect(document.querySelector('.task-deps')?.textContent).toBe('Depends on: #1, ghost');
  });

  it.each([
    ['in_progress', 'ai', ['Cancel']],
    ['blocked', 'ai', ['Skip', 'Start']],
    ['pending', 'ai', ['Start']],
    ['approved', 'ai', ['Start']],
    ['awaiting_user', 'ai', ['Skip']],
    ['completed', 'ai', []],
    ['failed', 'ai', ['Skip']],
    ['pending', 'user', []],
    ['blocked', 'user', ['Skip']],
    ['completed', 'user', []],
  ] as const)('a running plan offers a %s %s task %j', (status, type, offered) => {
    render(<TaskCard task={makeTask({ status, type })} models={[]} isExecuting expanded onExpandedChange={noop} {...handlers} />);
    expect(buttons()).toEqual(offered);
  });

  // The one place a card marks a task: last in the expanded details, never among the action buttons.
  it.each([
    ['in_progress', 'ai', []],
    ['blocked', 'ai', ['Mark complete']],
    ['pending', 'ai', ['Mark complete']],
    ['awaiting_user', 'ai', ['Mark complete']],
    ['failed', 'ai', ['Mark complete']],
    ['skipped', 'ai', ['Mark complete']],
    ['completed', 'ai', ['Mark not done']],
    ['pending', 'user', ['Mark complete']],
    ['completed', 'user', ['Mark not done']],
  ] as const)('a %s %s task marks itself with %j', (status, type, offered) => {
    render(<TaskCard task={makeTask({ status, type })} models={[]} isExecuting expanded onExpandedChange={noop} {...handlers} />);
    expect(marks()).toEqual(offered);
  });

  it.each([
    ['pending', true],
    ['approved', true],
    ['blocked', true],
    ['in_progress', false],
    ['awaiting_user', false],
    ['completed', false],
    ['failed', false],
  ] as const)('offers the ops toggle on a %s task: %s', (status, offered) => {
    render(<TaskCard task={makeTask({ status })} models={[]} expanded onExpandedChange={noop} {...handlers} />);
    expect(document.querySelector('.task-ops-toggle') !== null).toBe(offered);
  });
});

describe('a subtask card, pinned before its rules move to core', () => {
  const parent = makeTask({ id: 'p1', order: 2 });
  const open = (sub: Task) => {
    render(<SubTaskCard task={sub} parentTask={parent} models={[]} isExecuting {...handlers} />);
    fireEvent.click(document.querySelector('.subtask-card-header')!);
  };

  it.each([
    ['in_progress', 'ai', ['Cancel']],
    ['pending', 'ai', ['Force Start', 'Skip']],
    ['approved', 'ai', ['Force Start', 'Skip']],
    ['pending', 'user', ['Skip']],
    ['awaiting_user', 'ai', []],
    ['completed', 'ai', []],
    ['blocked', 'ai', []],
    ['failed', 'ai', ['Skip']],
  ] as const)('a running plan offers a %s %s subtask %j', (status, type, offered) => {
    open(makeTask({ id: 's1', status, type }));
    expect(buttons()).toEqual(offered);
  });

  it.each([
    ['in_progress', 'ai', []],
    ['pending', 'ai', ['Mark complete']],
    ['awaiting_user', 'ai', ['Mark complete']],
    ['failed', 'ai', ['Mark complete']],
    ['completed', 'ai', ['Mark not done']],
    ['pending', 'user', ['Mark complete']],
  ] as const)('a %s %s subtask marks itself with %j, at the bottom of its details only', (status, type, offered) => {
    const { container } = render(<SubTaskCard task={makeTask({ id: 's1', status, type })} parentTask={parent} models={[]} isExecuting {...handlers} />);
    expect(marks()).toEqual([]);
    fireEvent.click(document.querySelector('.subtask-card-header')!);
    expect(marks()).toEqual(offered);
    const body = container.querySelector('.subtask-card-body') as HTMLElement;
    for (const button of document.querySelectorAll('.task-mark-btn')) expect(body.lastElementChild?.contains(button)).toBe(true);
  });

  it('never changes completion from a subtask\'s status circle', () => {
    const onMarkComplete = vi.fn();
    const onMarkIncomplete = vi.fn();
    render(<SubTaskCard task={makeTask({ id: 's1', status: 'pending' })} parentTask={parent} models={[]} onMarkComplete={onMarkComplete} onMarkIncomplete={onMarkIncomplete} />);
    const check = document.querySelector('.task-check') as HTMLElement;

    fireEvent.click(check);
    fireEvent.keyDown(check, { key: 'Enter' });

    expect(onMarkComplete).not.toHaveBeenCalled();
    expect(onMarkIncomplete).not.toHaveBeenCalled();
    expect(check.className).not.toContain('clickable');
  });

  it.each([
    ['completed', 'Done'],
    ['in_progress', 'Running'],
    ['awaiting_user', 'Awaiting User'],
    ['pending', 'To do'],
  ] as const)('a %s subtask reads "%s", and is never stalled', (status, label) => {
    render(<SubTaskCard task={makeTask({ id: 's1', status })} parentTask={parent} models={[]} isExecuting />);
    expect(badge()?.textContent).toBe(label);
  });

  it('labels itself by its dotted order', () => {
    render(<SubTaskCard task={makeTask({ id: 's1', order: 1 })} parentTask={parent} models={[]} />);
    expect(document.querySelector('.subtask-order')?.textContent).toBe('2.1.');
  });

  it('shows its own hold reason, so it does not read as merely unstarted', () => {
    render(<SubTaskCard task={makeTask({ id: 's1' })} parentTask={parent} models={[]} run={{ holdReason: 'could not connect to Ordewell\'s tools; start it again' }} />);
    expect(badge()?.textContent).toBe('On hold: could not connect to Ordewell\'s tools; start it again');
  });
});

describe('a research task card (ADR-0037)', () => {
  const research = (over: Partial<Task> = {}) => makeTask({ research: true, ...over });
  const badges = (): string[] => Array.from(document.querySelectorAll('.task-type-badge')).map((b) => b.textContent ?? '');

  it('is marked Research beside AI, and a task that is not research is not', () => {
    const { unmount } = render(<TaskCard task={research()} models={[]} />);
    expect(badges()).toEqual(['AI', 'Research']);
    expect(document.querySelector('.task-type-badge.research')?.getAttribute('title')).toContain('Its report comes back to the planner and wakes it');
    unmount();
    render(<TaskCard task={makeTask()} models={[]} />);
    expect(badges()).toEqual(['AI']);
  });

  it('reads its own status once it has started', () => {
    render(<TaskCard task={research({ status: 'in_progress' })} models={[]} isExecuting />);
    expect(badge()?.textContent).toBe('Running');
  });
});
