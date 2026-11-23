import { describe, expect, it } from 'vitest';
import { applyChainReview } from '../PlanChainReview';
import { fanOutShape } from '../PlanFanOut';
import { planAncestors } from '../readiness';
import { createTask, type RunnerId, type Task } from '../../models/Task';

// Review of #497: a dropped added wait must not leave its task waiting on less than both the plan as written and the reply.
const RUNNERS: RunnerId[] = ['claude-code'];
const ai = (id: string, deps: string[], extra: Partial<Task> = {}): Task => createTask({ id, title: `T ${id}`, dependencies: deps, prompt: `Do ${id}.`, assignedRunner: 'claude-code', ...extra });
const S = ['s1', 's2', 's3', 's4'];
const plan = () => [ai('open', []), ai('core', ['open']), ...S.map((s) => ai(s, ['core'])), ai('final', S, { prompt: 'Run the whole test suite and fix what fails.' })];
const ancestorsOf = (tasks: readonly Task[], id: string) => planAncestors(tasks)(tasks.find((t) => t.id === id)!);

describe('a reply that moves a task after the closing check', () => {
  it('keeps a docs task beside the check after the slices it ran after', () => {
    const tasks = [...plan().slice(0, -1), ai('docs', S), plan().at(-1)!];
    expect(fanOutShape(tasks).closers.map((c) => c.id)).toEqual(['final', 'docs']);
    const r = applyChainReview(tasks, '{"dependencyChanges":[{"id":"docs","dependencies":["final"]}]}', RUNNERS);
    if (!r.ok) throw new Error(r.error);
    // At HEAD: docs waits for nothing, runs before open and core, and its brief says s1..s4 run in parallel with it.
    expect(ancestorsOf(r.tasks, 'docs')).toEqual(expect.arrayContaining(S));
  });

  it('keeps a read-only audit after core', () => {
    const tasks = [...plan(), ai('audit', ['core'], { readOnly: true })];
    const r = applyChainReview(tasks, '{"dependencyChanges":[{"id":"audit","dependencies":["final"]}]}', RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(ancestorsOf(r.tasks, 'audit')).toContain('core');
  });

  it('applies a reply that sets an ops task after the check, as it was applied before the guard', () => {
    const tasks = [...plan(), ai('release', S, { ops: true, prompt: 'Publish.' })];
    const r = applyChainReview(tasks, '{"dependencyChanges":[{"id":"release","dependencies":["final"]},{"id":"s4","dependencies":["open"]}]}', RUNNERS);
    // At HEAD: refused whole, 'task "release" would no longer run after "T s1" (s1), which it waits for'; at 03d6a771 it applied.
    expect(r.ok ? 'ok' : r.error).toBe('ok');
  });
});
