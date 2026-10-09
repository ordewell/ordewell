import { describe, it, expect } from 'vitest';
import type { Task } from '@ordewell/core';
import { isPlanRevision, planSummaryLabel, nextDock, dragDockHeight, DOCK_MIN_HEIGHT } from '../planDock';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    order: 1,
    title: 'Add rate limiting',
    description: '',
    type: 'ai',
    status: 'pending',
    dependencies: [],
    subtasks: [],
    assignedRunner: 'claude-code',
    taskMode: 'build',
    ...overrides,
  } as Task;
}

/**
 * The webview receives one `planUpdated` message for two very different events:
 * the user revised the plan in chat, and a task's status ticked during
 * execution. Only the first is a revision the user needs pointed out — during a
 * run the status ticks arrive constantly.
 */
describe('isPlanRevision', () => {
  it('does not call a status-only change a revision', () => {
    const before = [task()];
    const after = [task({ status: 'in_progress' })];
    expect(isPlanRevision(before, after)).toBe(false);
  });

  it('is insensitive to the array order the host happens to send', () => {
    const a = task({ id: 't1', order: 1, title: 'First' });
    const b = task({ id: 't2', order: 2, title: 'Second' });
    expect(isPlanRevision([a, b], [b, a])).toBe(false);
  });

  it.each([
    ['a task added', [task()], [task(), task({ id: 't2', order: 2, title: 'And another' })]],
    ['a task removed', [task(), task({ id: 't2', order: 2 })], [task()]],
    ['a retarget', [task()], [task({ assignedRunner: 'opencode' })]],
    ['a mode flip', [task()], [task({ taskMode: 'plan' })]],
    ['a rewired dependency', [task()], [task({ dependencies: ['t0'] })]],
    ['an edited prompt', [task({ prompt: 'old' })], [task({ prompt: 'new' })]],
    ['a model change', [task()], [task({ assignedModel: { modelId: 'sonnet', modelLabel: 'Sonnet' } })]],
  ])('calls %s a revision', (_label, before, after) => {
    expect(isPlanRevision(before as Task[], after as Task[])).toBe(true);
  });
});

/**
 * What the dock says about itself when collapsed. This is the only view of the
 * plan while the user is chatting, so it has to carry progress, not just size.
 */
describe('planSummaryLabel', () => {
  it('counts a single pending task without pluralising', () => {
    expect(planSummaryLabel([task()])).toBe('1 task');
  });

  it('omits the segments that are zero', () => {
    expect(planSummaryLabel([task(), task({ id: 't2', order: 2 })])).toBe('2 tasks');
  });

  it('reports done and running alongside the total', () => {
    const tasks = [
      task({ id: 't1', order: 1, status: 'completed' }),
      task({ id: 't2', order: 2, status: 'completed' }),
      task({ id: 't3', order: 3, status: 'in_progress' }),
      task({ id: 't4', order: 4 }),
    ];
    expect(planSummaryLabel(tasks)).toBe('4 tasks · 2 done · 1 running');
  });

  it('has nothing to say about an empty plan', () => {
    expect(planSummaryLabel([])).toBe('');
  });
});

/**
 * When the dock opens and closes. The rule that matters: a revision opens it
 * (that is the whole point — a chat edit must be visible), while a status tick
 * during execution never moves it, or a long run would fight a user who chose
 * to collapse.
 */
describe('nextDock', () => {
  it('opens on a revision, even from collapsed', () => {
    expect(nextDock(false, 'plan-revised')).toBe(true);
  });

  it('leaves a collapsed dock alone as tasks progress', () => {
    expect(nextDock(false, 'plan-progressed')).toBe(false);
  });

  it('leaves an expanded dock alone as tasks progress', () => {
    expect(nextDock(true, 'plan-progressed')).toBe(true);
  });

  it('honours a collapse while tasks are running', () => {
    expect(nextDock(true, 'user-collapsed')).toBe(false);
  });

  it('opens when the user asks, or clicks a revision chip', () => {
    expect(nextDock(false, 'user-expanded')).toBe(true);
  });

  it('collapses on a new session so the next plan opens fresh', () => {
    expect(nextDock(true, 'session-reset')).toBe(false);
  });
});

/**
 * The dragged height is a cap: it follows the pointer up to wherever the plan
 * ends or the conversation runs out of room, whichever comes first.
 */
describe('dragDockHeight', () => {
  const roomy = { content: 900, available: 900 };

  it('follows the pointer between its bounds', () => {
    expect(dragDockHeight(320.4, roomy)).toBe(320);
  });

  it('stops where the plan ends', () => {
    expect(dragDockHeight(600, { content: 240, available: 900 })).toBe(240);
  });

  it('stops where the conversation reaches its floor', () => {
    expect(dragDockHeight(600, { content: 900, available: 410 })).toBe(410);
  });

  it('never collapses below the minimum, even for a tiny plan', () => {
    expect(dragDockHeight(10, roomy)).toBe(DOCK_MIN_HEIGHT);
    expect(dragDockHeight(300, { content: 40, available: 900 })).toBe(DOCK_MIN_HEIGHT);
  });
});
