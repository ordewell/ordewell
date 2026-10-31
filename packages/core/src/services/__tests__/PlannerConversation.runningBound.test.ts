import { describe, it, expect } from 'vitest';
import { PlannerConversation } from '../PlannerConversation';
import { createTask } from '../../models/Task';

/**
 * The plan block lists at most 60 task lines, but its "these tasks are locked"
 * line is built from every in-progress task. A plan running more than 60 at
 * once therefore still carries a line that grows with the plan.
 */
describe('the plan block on a plan with many running tasks', () => {
  function runningLine(count: number): string {
    const tasks = Array.from({ length: count }, (_, i) => createTask({
      id: `t${i + 1}`, order: i + 1, title: `T${i + 1}`, prompt: 'x', status: 'in_progress',
    }));
    const host = {
      plan: () => ({ tasks, generatedAt: '2026-01-01T00:00:00Z', status: 'approved', runners: ['claude-code'], lastUpdated: '2026-01-01T00:00:00Z' }),
      tasks: () => tasks,
      catalog: () => ({ modes: { 'claude-code': ['build'] }, models: {}, runners: ['claude-code'] }),
      startWaits: () => [],
      isExecuting: () => true,
      aiService: () => ({ plannerToolsAttached: () => true }),
    };
    const conversation = new PlannerConversation(host as unknown as ConstructorParameters<typeof PlannerConversation>[0]);
    return (conversation as unknown as { planView(): { running: string } }).planView().running;
  }

  it('does not name every running task in its locked line', () => {
    expect(runningLine(1_000)).not.toContain('#1000');
  });

  it('counts the ones it does not name, and costs the same at any width', () => {
    expect(runningLine(1_000)).toContain('#60 and 940 more.');
    expect(runningLine(10_000).length).toBe(runningLine(1_000).length + 1);
  });

  it('names every running task a block can list', () => {
    expect(runningLine(60)).toMatch(/#59, #60\. No new task starts/);
  });
});
