import { describe, it, expect } from 'vitest';
import { collectDirectDependencyOutputs, landsBeside } from '../promptAugment';
import { readableTaskIds } from '../../models/Handoff';
import { landedOnOf, revertReach } from '../LandingLedger';
import { createTask, type Task } from '../../models/Task';

/** What a task that depends on "*" is given and may read, as if it named each task it covers (ADR-0077). */

const task = (id: string, order: number, patch: Partial<Task> = {}): Task =>
  createTask({ id, order, title: id.toUpperCase(), prompt: id, assignedRunner: 'claude-code', ...patch });

const done = (id: string, order: number, patch: Partial<Task> = {}): Task => task(id, order, {
  status: 'completed',
  outputSummary: { reviewReason: `${id} done`, logTail: '', capturedAt: '2026-11-24T00:00:00Z' },
  ...patch,
});

describe('a task that depends on "*"', () => {
  const plan = (): Task[] => [
    done('a', 1),
    done('b', 2, { dependencies: ['a'] }),
    task('suite', 3, { dependencies: ['*'] }),
    task('pr', 4, { dependencies: ['suite'] }),
  ];

  it('is given the handoff of every task it covers, and not of what follows it', () => {
    const tasks = plan();
    expect(collectDirectDependencyOutputs(tasks[2], tasks).map((o) => o.title)).toEqual(['A', 'B']);
  });

  it('may read every task it covers, and what follows it may read them through it', () => {
    expect([...readableTaskIds(plan(), 'suite')].sort()).toEqual(['a', 'b', 'suite']);
    expect([...readableTaskIds(plan(), 'pr')].sort()).toEqual(['a', 'b', 'pr', 'suite']);
  });

  it('is on the ground of every task it covers: it lands on them and a revert of one reaches it', () => {
    const tasks = plan();
    expect(landedOnOf('suite', tasks).sort()).toEqual(['a', 'b']);
    expect([...revertReach('a', tasks, null)].sort()).toEqual(['a', 'b', 'pr', 'suite']);
  });

  it('is no work landing beside a task it covers, since it starts after that task lands', () => {
    const tasks = [task('a', 1, { status: 'in_progress' }), task('suite', 2, { dependencies: ['*'] })];
    expect(landsBeside(tasks[0], tasks, () => true)).toBe(false);
  });
});
