import { describe, expect, it } from 'vitest';
import { applyChainReview } from '../PlanChainReview';
import { BaseAiService, type PlanTextCall } from '../BaseAiService';
import { fanOutShape } from '../PlanFanOut';
import { planAncestors } from '../readiness';
import { createTask, type ResearchLogEntry, type RunnerId, type Task } from '../../models/Task';
import { fakeConfig } from '../../testing';

// ADR-0072 R1: a reply makes no task wait on more than the plan as written, and cuts no slice off from the opening.
const RUNNERS: RunnerId[] = ['claude-code'];
const ai = (id: string, deps: string[], extra: Partial<Task> = {}): Task => createTask({ id, title: `T ${id}`, dependencies: deps, prompt: `Do ${id}.`, assignedRunner: 'claude-code', ...extra });
const deps = (tasks: readonly Task[], id: string) => tasks.find((t) => t.id === id)!.dependencies;
const reply = (changes: Record<string, string[]>) => JSON.stringify({ dependencyChanges: Object.entries(changes).map(([id, d]) => ({ id, dependencies: d })) });
const range = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

/** As a recorded plan was written: three opening tasks in a row, the last restoring the package's import, eight slices and a closing check. */
const openingChain = () => [
  ai('o1', []), ai('o2', ['o1']), ai('o3', ['o2'], { title: 'Restore package import' }),
  ...range('s', 8).map((s) => ai(s, ['o3'])),
  ai('final', range('s', 8), { prompt: 'Run the whole test suite and fix what fails.' }),
];

describe('the slices keep the opening the plan as written gave them all', () => {
  it('gives each slice the reply cut from the opening chain a direct wait on its last task, and its brief is told nothing', () => {
    const tasks = openingChain();
    expect(fanOutShape(tasks).gates.map((t) => t.id)).toEqual(['o1', 'o2', 'o3']);
    const r = applyChainReview(tasks, reply(Object.fromEntries(range('s', 8).map((s) => [s, []]))), RUNNERS);
    if (!r.ok) throw new Error(r.error);
    for (const s of range('s', 8)) {
      expect(deps(r.tasks, s)).toEqual(['o3']);
      expect(r.tasks.find((t) => t.id === s)!.prompt).toBe(`Do ${s}.`);
    }
    expect(r.changes).toEqual(range('s', 8).map((id) => ({ id, removed: [], added: [], openingKept: ['o3'] })));
  });

  it('leaves a slice the reply kept after the opening task to the reply, and gives back one whose only wait was dropped', () => {
    const tasks = openingChain();
    const r = applyChainReview(tasks, reply({ s1: ['o2'], s2: ['s3'] }), RUNNERS);
    if (!r.ok) throw new Error(r.error);
    // s1 still runs after o1: it may skip o3, as a slice that needs only the shared modules before it.
    expect(deps(r.tasks, 's1')).toEqual(['o2']);
    // s2 never ran after s3: that wait is dropped, and what s3 and s2 both ran after, o3, comes back with it.
    expect(deps(r.tasks, 's2')).toEqual(['o3']);
    expect(r.changes).toEqual([
      { id: 's1', removed: ['o3'], added: ['o2'] },
      { id: 's2', removed: [], added: [], dropped: ['s3'] },
    ]);
  });

  it('lets a reply put the tasks before the slices in another order, and keeps the slices after all of them', () => {
    // As a recorded reply did: the task that restores the import first, the one written first after it.
    const tasks = openingChain();
    const r = applyChainReview(tasks, reply({ o3: [], o1: ['o3'] }), RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(deps(r.tasks, 'o3')).toEqual([]);
    expect(deps(r.tasks, 'o1')).toEqual(['o3']);
    // Each slice still runs after o3, but no longer after o1 or o2 through it: the last of those, o2, comes back.
    for (const s of range('s', 8)) expect(deps(r.tasks, s)).toEqual(['o3', 'o2']);
    expect(fanOutShape(r.tasks).opening?.id).toBe('o3');
    expect(r.changes.filter((c) => c.dropped)).toEqual([]);
  });
});

/**
 * As a recorded run was written: twelve tasks in a row before thirty slices,
 * and a thirteenth beside them after the first that only one slice waits for.
 */
const longOpening = () => [
  ai('g1', []), ...range('g', 12).slice(1).map((g, i) => ai(g, [`g${i + 1}`])), ai('g13', ['g1']),
  ai('s1', ['g12', 'g13']), ...range('s', 30).slice(1).map((s) => ai(s, ['g12'])),
  ai('final', range('s', 30)),
];
/** Its reply: the twelve flattened onto the first, and every slice waiting for all thirteen. */
const everySliceOnAll = reply({
  ...Object.fromEntries(range('g', 12).slice(1).map((g) => [g, ['g1']])),
  ...Object.fromEntries(range('s', 30).map((s) => [s, range('g', 13)])),
});

describe('a reply makes no task wait on more than the plan as written', () => {
  it('drops each slice\'s added wait on a task it never ran after, and keeps the waits that flatten its chain', () => {
    const tasks = longOpening();
    const r = applyChainReview(tasks, everySliceOnAll, RUNNERS);
    if (!r.ok) throw new Error(r.error);
    const after = planAncestors(r.tasks);
    const waitOn13 = r.tasks.filter((t) => t.id.startsWith('s') && after(t).includes('g13')).map((t) => t.id);
    expect(waitOn13).toEqual(['s1']);
    expect(deps(r.tasks, 's1')).toEqual(range('g', 13));
    expect(deps(r.tasks, 's2')).toEqual(range('g', 12));
    expect(deps(r.tasks, 'g5')).toEqual(['g1']);
    expect(r.changes.filter((c) => c.dropped).map((c) => [c.id, c.dropped])).toEqual(range('s', 30).slice(1).map((s) => [s, ['g13']]));
    expect(r.changes.some((c) => c.openingKept || c.restored)).toBe(false);
    // The brief names only the waits kept.
    expect(r.tasks.find((t) => t.id === 's2')!.prompt).not.toContain('g13');
  });

  it('drops a wait that would set the opening after a slice, so the reply closes no cycle', () => {
    const r = applyChainReview(openingChain(), reply({ o3: ['o2', 's1'] }), RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(deps(r.tasks, 'o3')).toEqual(['o2']);
    expect(r.changes).toEqual([{ id: 'o3', removed: [], added: [], dropped: ['s1'] }]);
  });

  it('applies a reply that only cuts slices from each other as before', () => {
    const tasks = [ai('open', []), ai('core', ['open']), ...range('s', 5).map((s) => ai(s, ['core'])), ai('s6', ['s5']), ai('final', range('s', 6))];
    const r = applyChainReview(tasks, reply({ s6: ['core'] }), RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(deps(r.tasks, 's6')).toEqual(['core']);
    expect(r.changes).toEqual([{ id: 's6', removed: ['s5'], added: ['core'] }]);
  });

  it('leaves a plan that does not fan out to the reply: it may wait on what it never ran after', () => {
    const tasks = [ai('a', []), ai('b', ['a']), ai('c', ['a']), ai('d', ['b', 'c']), ai('e', ['d'])];
    expect(fanOutShape(tasks).wide).toBe(false);
    const r = applyChainReview(tasks, reply({ c: ['b'], d: [] }), RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(deps(r.tasks, 'c')).toEqual(['b']);
    expect(deps(r.tasks, 'd')).toEqual([]);
    expect(r.changes).toEqual([{ id: 'c', removed: ['a'], added: ['b'] }, { id: 'd', removed: ['b', 'c'], added: [] }]);
  });
});

class OneReply extends BaseAiService {
  constructor(private readonly reply: string) { super(fakeConfig()); }
  reset(): void {}
  ensureInit(): void {}
  protected async streamPlanText(_p: string, _h: string | undefined, _t: (x: string) => void, _r?: (x: string) => void, _s?: AbortSignal, call?: PlanTextCall): Promise<string> {
    call?.onReply?.({ cutOff: false });
    return this.reply;
  }
  async logLine(tasks: Task[]): Promise<string> {
    const log: ResearchLogEntry[] = [];
    await this.reviewLongChain(tasks, 'goal', '', '', {}, RUNNERS, () => {}, undefined, undefined, undefined, log);
    return log.map((e) => ('content' in e ? String(e.content) : ''))[0];
  }
}

describe('the review\'s log line counts what the rules dropped and kept', () => {
  it('counts the added waits dropped', async () => {
    const line = await new OneReply(everySliceOnAll).logLine(longOpening());
    expect(line).toMatch(/^chain review: 14 -> 4, kept; 40 tasks changed: .*, 29 added waits dropped, 0 opening waits kept$/);
  });

  it('counts the opening waits kept, and keeps the first plan when they leave it no shorter', async () => {
    const line = await new OneReply(reply(Object.fromEntries(range('s', 8).map((s) => [s, []])))).logLine(openingChain());
    expect(line).toMatch(/^chain review: 5 -> 5, first plan kept, not shorter; 0 tasks changed, 0 added waits dropped, 8 opening waits kept$/);
  });

  it('says nothing of either when neither rule changed the reply', async () => {
    const line = await new OneReply(reply({ s2: ['g12', 'g11'] })).logLine(longOpening());
    expect(line).toBe('chain review: 14 -> 14, first plan kept, not shorter; 1 task changed: "T s2" adds "T g11"');
  });
});
