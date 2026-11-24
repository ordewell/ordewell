import { describe, expect, it } from 'vitest';
import { applyChainReview, longestChain } from '../PlanChainReview';
import { fanOutShape } from '../PlanFanOut';
import { createTask, type RunnerId, type Task } from '../../models/Task';

// ADR-0077 with ADR-0072 R1: a closing check that depends on "*" keeps it whatever the review's reply says.
const RUNNERS: RunnerId[] = ['claude-code'];
const ai = (id: string, deps: string[], extra: Partial<Task> = {}): Task => createTask({ id, title: `T ${id}`, dependencies: deps, prompt: `Do ${id}.`, assignedRunner: 'claude-code', ...extra });
const deps = (tasks: readonly Task[], id: string) => tasks.find((t) => t.id === id)!.dependencies;

/** An opening task, a chain of three, four slices, and a closing check that says "*". */
const plan = () => [
  ai('open', []),
  ai('c1', ['open']), ai('c2', ['c1']), ai('c3', ['c2']),
  ...['s1', 's2', 's3', 's4'].map((s) => ai(s, ['open'])),
  ai('final', ['*'], { prompt: 'Run the whole test suite and fix what fails.' }),
];

describe('a closing check that depends on "*"', () => {
  it('is read as the closing check, at the end of the plan\'s longest chain', () => {
    expect(fanOutShape(plan()).closers[0]?.id).toBe('final');
    expect(longestChain(plan()).map((t) => t.id)).toEqual(['open', 'c1', 'c2', 'c3', 'final']);
  });

  it('keeps "*" when a reply gives it a list of ids instead, and applies the rest of the reply', () => {
    const r = applyChainReview(plan(), '{"dependencyChanges":[{"id":"c3","dependencies":["open"]},{"id":"final","dependencies":["c3"]}]}', RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(deps(r.tasks, 'c3')).toEqual(['open']);
    expect(deps(r.tasks, 'final')).toEqual(['c3', '*']);
    expect(r.changes).toEqual([{ id: 'c3', removed: ['c2'], added: ['open'] }, { id: 'final', removed: [], added: ['c3'] }]);
  });

  it('takes a reply that names "*" itself as a dependency, which is no unknown task', () => {
    const tasks = plan().map((t) => (t.id === 'final' ? { ...t, dependencies: ['c3', 's1', 's2', 's3', 's4'] } : t));
    const r = applyChainReview(tasks, '{"dependencyChanges":[{"id":"final","dependencies":["*"]}]}', RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(deps(r.tasks, 'final')).toEqual(['*']);
  });
});
