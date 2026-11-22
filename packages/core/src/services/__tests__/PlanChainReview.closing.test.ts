import { describe, expect, it } from 'vitest';
import { applyChainReview, longestChain } from '../PlanChainReview';
import { BaseAiService, type PlanTextCall } from '../BaseAiService';
import { fanOutShape, notedRole } from '../PlanFanOut';
import { createTask, type ResearchLogEntry, type RunnerId, type Task } from '../../models/Task';
import { fakeConfig } from '../../testing';

// ADR-0072 R1: the review's reply cannot cut the first plan's closing check off from what it waited for.
const RUNNERS: RunnerId[] = ['claude-code'];
const ai = (id: string, deps: string[], extra: Partial<Task> = {}): Task => createTask({ id, title: `T ${id}`, dependencies: deps, prompt: `Do ${id}.`, assignedRunner: 'claude-code', ...extra });
const deps = (tasks: readonly Task[], id: string) => tasks.find((t) => t.id === id)!.dependencies;

/**
 * As a recorded library plan was written: an opening task, a shared module,
 * six slices, a sweep after four of them, and a final check that covers every
 * slice only through the sweep.
 */
const sweptPlan = () => [
  ai('open', []), ai('core', ['open']),
  ...['s1', 's2', 's3', 's4', 's5', 's6'].map((s) => ai(s, ['core'])),
  ai('sweep', ['s1', 's2', 's3', 's4'], { prompt: 'Implement every module under pkg/ no other task names.' }),
  ai('final', ['sweep', 's5', 's6'], { prompt: 'Run the whole test suite and fix what fails.' }),
];

describe('the first plan\'s closing check keeps waiting for every task it waited for', () => {
  it('gives back, directly, the slices a reply cut it from through another task, and applies the rest of the reply', () => {
    const tasks = sweptPlan();
    expect(fanOutShape(tasks).closers[0]?.id).toBe('final');
    const r = applyChainReview(tasks, '{"dependencyChanges":[{"id":"sweep","dependencies":["open"]}]}', RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(deps(r.tasks, 'sweep')).toEqual(['open']);
    expect(deps(r.tasks, 'final')).toEqual(['sweep', 's5', 's6', 's1', 's2', 's3', 's4']);
    expect(fanOutShape(r.tasks).closers[0]?.id).toBe('final');
    // It ran after them before: its brief is told nothing.
    expect(r.tasks.find((t) => t.id === 'final')!.prompt).toBe('Run the whole test suite and fix what fails.');
    expect(r.changes).toEqual([{ id: 'sweep', removed: ['s1', 's2', 's3', 's4'], added: ['open'] }, { id: 'final', removed: [], added: [], restored: ['s1', 's2', 's3', 's4'] }]);
  });

  it('gives back the fewest: a task another given-back one still reaches stays reached through it', () => {
    // s1 > s1b, and the sweep waited for s1b alone: only s1b comes back.
    const tasks = [ai('open', []), ...['s1', 's2', 's3', 's4'].map((s) => ai(s, ['open'])), ai('s1b', ['s1']),
      ai('sweep', ['s1b', 's2', 's3', 's4']), ai('final', ['sweep'])];
    expect(fanOutShape(tasks).closers[0]?.id).toBe('final');
    const r = applyChainReview(tasks, '{"dependencyChanges":[{"id":"sweep","dependencies":["open"]}]}', RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(deps(r.tasks, 'final')).toEqual(['sweep', 's1b', 's2', 's3', 's4']);
  });

  it('puts back a direct dependency the reply dropped from the check itself, and logs it as given back', () => {
    const tasks = sweptPlan();
    const r = applyChainReview(tasks, '{"dependencyChanges":[{"id":"final","dependencies":["sweep"]}]}', RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect([...deps(r.tasks, 'final')].sort()).toEqual(['s5', 's6', 'sweep']);
    expect(r.changes).toEqual([{ id: 'final', removed: [], added: [], restored: ['s5', 's6'] }]);
    expect(r.tasks.find((t) => t.id === 'final')!.prompt).toBe('Run the whole test suite and fix what fails.');
  });

  it('lets a redundant direct edge of the check go, as for a task that acts on the checkout', () => {
    const tasks = sweptPlan().map((t) => (t.id === 'final' ? { ...t, dependencies: ['sweep', 's1', 's5', 's6'] } : t));
    const r = applyChainReview(tasks, '{"dependencyChanges":[{"id":"final","dependencies":["sweep","s5","s6"]}]}', RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(deps(r.tasks, 'final')).toEqual(['sweep', 's5', 's6']);
    expect(r.changes).toEqual([{ id: 'final', removed: ['s1'], added: [] }]);
  });

  it('refuses the whole reply when giving a dependency back would close a cycle', () => {
    // The reply cuts the sweep and sets s1 after the check, which the check waited for through the sweep.
    const tasks = sweptPlan();
    const r = applyChainReview(tasks, '{"dependencyChanges":[{"id":"sweep","dependencies":["open"]},{"id":"s1","dependencies":["final"]}]}', RUNNERS);
    // Named as the closing check's lost wait, not as a cycle the reply did not write.
    expect(r.ok ? 'applied' : r.error).toBe('the closing check "final" would no longer run after "T s1" (s1), which it waits for');
  });

  it('touches a plan that does not fan out as before: a serial plan\'s last task may lose what the reply cuts', () => {
    const tasks = [ai('a', []), ai('b', ['a']), ai('c', ['b']), ai('d', ['c']), ai('e', ['d'])];
    expect(fanOutShape(tasks).wide).toBe(false);
    const r = applyChainReview(tasks, '{"dependencyChanges":[{"id":"e","dependencies":["a"]}]}', RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(deps(r.tasks, 'e')).toEqual(['a']);
  });

  it('leaves a loop\'s check to the refusal that already holds it', () => {
    const tasks = [ai('open', []), ...['s1', 's2', 's3', 's4'].map((s) => ai(s, ['open'])), ai('sweep', ['s1', 's2', 's3', 's4']),
      ai('check', ['sweep'], { readOnly: true, loop: { body: ['fix'], maxRounds: 2 } }), ai('fix', ['check'])];
    const r = applyChainReview(tasks, '{"dependencyChanges":[{"id":"sweep","dependencies":["open"]}]}', RUNNERS);
    expect(r.ok ? 'applied' : r.error).toBe('task "check" would no longer run after "T s1" (s1), which it waits for');
  });

  it('gives back what a reply that empties the check\'s own list cut, as the list it had', () => {
    const r = applyChainReview(sweptPlan(), '{"dependencyChanges":[{"id":"final","dependencies":[]}]}', RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(deps(r.tasks, 'final')).toEqual(['sweep', 's5', 's6']);
    expect(r.changes).toEqual([{ id: 'final', removed: [], added: [], restored: ['sweep', 's5', 's6'] }]);
  });

  it('keeps the check after the slices when a reply moves it into the first wave, and notes only the edge the reply added', () => {
    const r = applyChainReview(sweptPlan(), '{"dependencyChanges":[{"id":"final","dependencies":["open"]}]}', RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(deps(r.tasks, 'final')).toEqual(['open', 'sweep', 's5', 's6']);
    expect(r.changes).toEqual([{ id: 'final', removed: [], added: ['open'], restored: ['sweep', 's5', 's6'] }]);
    expect(r.tasks.find((t) => t.id === 'final')!.prompt).toBe('Run the whole test suite and fix what fails.\n\nPlan revision: This task now also runs after "T open" (open).');
  });

  it('lets a reply set another task after the check, which loses nothing', () => {
    const tasks = [...sweptPlan(), ai('audit', ['core'], { readOnly: true })];
    const r = applyChainReview(tasks, '{"dependencyChanges":[{"id":"audit","dependencies":["final"]}]}', RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(deps(r.tasks, 'final')).toEqual(['sweep', 's5', 's6']);
    expect(r.changes).toEqual([{ id: 'audit', removed: ['core'], added: ['final'] }]);
  });

  it('holds only the closing check R5 reads when two tasks after every slice could be it', () => {
    // Side by side, the later in the plan is the closing check; the docs task is the reply's to move.
    const tasks = [ai('open', []), ai('core', ['open']), ...['s1', 's2', 's3', 's4'].map((s) => ai(s, ['core'])),
      ai('docs', ['s1', 's2', 's3', 's4']), ai('final', ['s1', 's2', 's3', 's4'])];
    expect(fanOutShape(tasks).closers.map((c) => c.id)).toEqual(['final', 'docs']);
    const r = applyChainReview(tasks, '{"dependencyChanges":[{"id":"docs","dependencies":["core"]},{"id":"final","dependencies":["core"]}]}', RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(deps(r.tasks, 'docs')).toEqual(['core']);
    expect(deps(r.tasks, 'final')).toEqual(['core', 's1', 's2', 's3', 's4']);
  });

  it('holds the last of two in a row: a sweep after every slice is a slice of the last level', () => {
    const tasks = [ai('open', []), ai('core', ['open']), ...['s1', 's2', 's3', 's4'].map((s) => ai(s, ['core'])),
      ai('sweep', ['s1', 's2', 's3', 's4']), ai('final', ['sweep'])];
    expect(fanOutShape(tasks).closers.map((c) => c.id)).toEqual(['final']);
    const r = applyChainReview(tasks, '{"dependencyChanges":[{"id":"sweep","dependencies":["core"]}]}', RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(deps(r.tasks, 'final')).toEqual(['sweep', 's1', 's2', 's3', 's4']);
  });

  it('gives back top-level tasks only, and leaves subtasks and a reply\'s entry for one as they were', () => {
    const sub = (id: string, d: string[]) => ai(id, d);
    const tasks = sweptPlan().map((t) => {
      if (t.id === 's1') return { ...t, subtasks: [sub('s1a', []), sub('s1b', ['s1a'])] };
      if (t.id === 'final') return { ...t, subtasks: [sub('fa', []), sub('fb', ['fa'])] };
      return t;
    });
    const r = applyChainReview(tasks, '{"dependencyChanges":[{"id":"sweep","dependencies":["open"]},{"id":"s1b","dependencies":[]}]}', RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(r.ignored).toEqual(['s1b']);
    expect(deps(r.tasks, 'final')).toEqual(['sweep', 's5', 's6', 's1', 's2', 's3', 's4']);
    expect(r.changes.find((c) => c.id === 'final')!.restored).toEqual(['s1', 's2', 's3', 's4']);
    expect(r.tasks.find((t) => t.id === 's1')!.subtasks.map((s) => s.dependencies)).toEqual([[], ['s1a']]);
    expect(r.tasks.find((t) => t.id === 'final')!.subtasks.map((s) => s.dependencies)).toEqual([[], ['fa']]);
  });
});

/**
 * As the recorded run was written: two sweeps cover the slices between them,
 * and the final check waits for the sweeps alone. Its reply cut one sweep to
 * the opening task.
 */
const twoSweeps = () => [
  ai('open', []), ai('core', ['open']),
  ...['c1', 'c2', 'c3', 'c4'].map((s) => ai(s, ['core'])), ai('coreSweep', ['c1', 'c2', 'c3', 'c4']),
  ...['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((s) => ai(s, ['core'])), ai('algSweep', ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']),
  ai('final', ['coreSweep', 'algSweep'], { prompt: 'Run the whole test suite and fix what fails.' }),
];
const cutSweep = `{"dependencyChanges":[${['c1', 'c2', 'c3', 'c4', 'algSweep'].map((c) => `{"id":"${c}","dependencies":["open"]}`).join(',')}]}`;

class OneReply extends BaseAiService {
  constructor(private readonly reply: string) { super(fakeConfig()); }
  reset(): void {}
  ensureInit(): void {}
  protected async streamPlanText(_p: string, _h: string | undefined, _t: (x: string) => void, _r?: (x: string) => void, _s?: AbortSignal, call?: PlanTextCall): Promise<string> {
    call?.onReply?.({ cutOff: false });
    return this.reply;
  }
  review(tasks: Task[], log: ResearchLogEntry[] = []): Promise<Task[]> {
    return this.reviewLongChain(tasks, 'goal', '', '', {}, RUNNERS, () => {}, undefined, undefined, undefined, log);
  }
}

it('reviewLongChain keeps the shorter plan with its closing check noted, and logs what was given back', async () => {
  const tasks = sweptPlan();
  expect(longestChain(tasks).length).toBe(5);
  const log: ResearchLogEntry[] = [];
  const out = await new OneReply('{"dependencyChanges":[{"id":"sweep","dependencies":["open"]}]}').review(tasks, log);
  expect(deps(out, 'final')).toEqual(['sweep', 's5', 's6', 's1', 's2', 's3', 's4']);
  expect(out.find((t) => t.id === 'final')!.prompt).toContain('Plan shape: this check runs after the 7 slices.');
  const lines = log.map((e) => ('content' in e ? String(e.content) : ''));
  expect(lines[0]).toBe('chain review: 5 -> 4, kept; 2 tasks changed: "T sweep" drops "T s1", "T s2", "T s3", "T s4" adds "T open"; "T final", kept as the closing check after 4 tasks the reply cut it from');
});

it('reviewLongChain keeps the closing check after the slices a cut sweep covered, so shaping notes it as the closing check', async () => {
  const tasks = twoSweeps();
  expect(longestChain(tasks).length).toBe(5);
  // The reply as written, applied alone: nothing waits for every slice, so shaping finds no closing check.
  const cut = new Set(['c1', 'c2', 'c3', 'c4', 'algSweep']);
  const asWritten = tasks.map((t) => (cut.has(t.id) ? { ...t, dependencies: ['open'] } : t));
  expect(fanOutShape(asWritten).closers).toEqual([]);
  const log: ResearchLogEntry[] = [];
  const out = await new OneReply(cutSweep).review(tasks, log);
  expect(deps(out, 'final')).toEqual(['coreSweep', 'algSweep', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  expect(notedRole(out.find((t) => t.id === 'final')!)).toBe('closing');
  expect(notedRole(out.find((t) => t.id === 'open')!)).toBe('opening');
  // The cut sweep's own wait stays the reply's: it starts beside the slices.
  expect(deps(out, 'algSweep')).toEqual(['open']);
  expect(notedRole(out.find((t) => t.id === 'algSweep')!)).toBe('slice');
  const lines = log.map((e) => ('content' in e ? String(e.content) : ''));
  expect(lines[0]).toMatch(/^chain review: 5 -> 4, kept; 6 tasks changed: .*; "T final", kept as the closing check after 6 tasks the reply cut it from$/);
});
