import { describe, it, expect } from 'vitest';
import { PlannerConversation } from '../PlannerConversation';
import { createTask, type Task } from '../../models/Task';

/**
 * The plan block's own line says "running, failed and waiting ones first", but
 * `listedIds` ranks every in-progress task above a failed or waiting one. Once
 * a run is wider than the block's 60 tasks, every slot goes to running tasks —
 * which are locked and cannot be edited — and the failed task a planner must
 * act on is not listed, nor is its reference named anywhere.
 */
describe('the plan block on a run wider than it lists', () => {
  function blockOf(counts: { running: number; failed: number; waiting: number }): string {
    const tasks: Task[] = [];
    let order = 1;
    for (let i = 0; i < counts.running; i++) tasks.push(createTask({ id: `r${i + 1}`, order: order++, title: `Run ${i + 1}`, prompt: 'x', status: 'in_progress' }));
    for (let i = 0; i < counts.failed; i++) tasks.push(createTask({ id: `f${i + 1}`, order: order++, title: `Fail ${i + 1}`, prompt: 'x', status: 'failed' }));
    for (let i = 0; i < counts.waiting; i++) tasks.push(Object.assign(createTask({ id: `w${i + 1}`, order: order++, title: `Wait ${i + 1}`, prompt: 'x', status: 'awaiting_user' }), { awaitingReason: 'checkpoint' as const }));
    const host = {
      plan: () => ({ tasks, generatedAt: '2026-01-01T00:00:00Z', status: 'approved', runners: ['claude-code'], lastUpdated: '2026-01-01T00:00:00Z' }),
      tasks: () => tasks,
      catalog: () => ({ modes: { 'claude-code': ['build'] }, models: {}, runners: ['claude-code'] }),
      startWaits: () => [],
      isExecuting: () => true,
      aiService: () => ({ plannerToolsAttached: () => true }),
    };
    const conversation = new PlannerConversation(host as unknown as ConstructorParameters<typeof PlannerConversation>[0]);
    return (conversation as unknown as { planView(): { full: string; overflow: string } }).planView().full;
  }

  it('lists the failed task when 60 tasks are already running', () => {
    const block = blockOf({ running: 60, failed: 1, waiting: 0 });
    expect(block).toContain('Fail 1');
    expect(block).toContain('Not listed: 1 in progress');
  });

  it('lists the task waiting on a person when 60 tasks are already running', () => {
    const block = blockOf({ running: 60, failed: 0, waiting: 1 });
    expect(block).toContain('Wait 1');
  });

  it('names the failed and waiting tasks the rows could not hold, since a read needs a reference', () => {
    const block = blockOf({ running: 2, failed: 60, waiting: 2 });

    expect(block).toContain('Fail 60');
    expect(block).not.toContain('Wait 1');
    expect(block).toContain('Failed or waiting among them: #63, #64.');
    expect(block).toContain('Not listed: 2 in progress, 2 awaiting user.');
  });

  it('keeps a line of them in bounds however many there are', () => {
    const block = blockOf({ running: 0, failed: 1000, waiting: 0 });

    expect(block).toContain('Failed or waiting among them: #61,');
    expect(block).toContain('#120 and 880 more.');
  });

  it('names nothing when every failed and waiting task has a row', () => {
    expect(blockOf({ running: 70, failed: 1, waiting: 1 })).not.toContain('Failed or waiting among them');
  });
});
