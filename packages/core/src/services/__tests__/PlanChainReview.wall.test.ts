import { describe, expect, it } from 'vitest';
import { chainReviewMessage, longestChain, waitWall } from '../PlanChainReview';
import { BaseAiService, type PlanTextCall, type PlanTextReply } from '../BaseAiService';
import { createTask, type ResearchLogEntry, type RunnerId, type Task } from '../../models/Task';
import { fakeConfig } from '../../testing';

// ADR-0072 R1: a wide plan whose slices mostly wait on more than five tasks before them is reviewed even with a short chain.
const RUNNERS: RunnerId[] = ['claude-code'];
const ai = (id: string, deps: string[], extra: Partial<Task> = {}): Task => createTask({ id, title: `T ${id}`, dependencies: deps, prompt: `Do ${id}.`, assignedRunner: 'claude-code', ...extra });
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
const text = (e: ResearchLogEntry): string => ('content' in e ? String(e.content) : '');
const closing = (deps: string[]) => ai('final', deps, { prompt: 'Run the whole test suite and fix what fails.' });

/** As networkx-s73 wrote it: an opening task, six modules beside each other after it, 36 slices after all seven, one slice after the opening alone. */
const s73 = () => {
  const gates = ids('g', 6);
  const slices = ids('s', 36);
  return [
    ai('open', []),
    ...gates.map((g) => ai(g, ['open'])),
    ...slices.map((s) => ai(s, ['open', ...gates])),
    ai('random', ['open']),
    closing([...gates, ...slices, 'random']),
  ];
};

/** As networkx-s8 wrote it: thirteen tasks before the slices, four in a row then nine beside each other, and 30 slices after all of them. */
const s8 = () => {
  const row = ['open', 'g1', 'g2', 'g3'];
  const beside = ids('m', 9);
  const before = [...row, ...beside];
  const slices = ids('s', 30);
  return [
    ...row.map((id, i) => ai(id, i ? [row[i - 1]] : [])),
    ...beside.map((m) => ai(m, ['g3'])),
    ...slices.map((s) => ai(s, before)),
    closing(slices),
  ];
};

/** As networkx-seed6 wrote it: five tasks before 20 slices, each slice after all five. */
const s6 = () => {
  const before = ['open', ...ids('g', 4)];
  const slices = ids('s', 20);
  return [ai('open', []), ...before.slice(1).map((g) => ai(g, ['open'])), ...slices.map((s) => ai(s, before)), closing(slices)];
};

/** Answers each plan-text call with the next reply in turn, and keeps what each call asked for. */
class ReviewService extends BaseAiService {
  calls: { prompt: string; hint: string | undefined; call: PlanTextCall | undefined }[] = [];
  constructor(private readonly replies: readonly [string, PlanTextReply][]) { super(fakeConfig()); }
  reset(): void {}
  ensureInit(): void {}
  protected async streamPlanText(prompt: string, hint: string | undefined, _t: (x: string) => void, _r?: (x: string) => void, _s?: AbortSignal, call?: PlanTextCall): Promise<string> {
    const [reply, meta] = this.replies[this.calls.length];
    this.calls.push({ prompt, hint, call });
    call?.onReply?.(meta);
    return reply;
  }
  review(tasks: Task[], log: ResearchLogEntry[] = []): Promise<Task[]> {
    return this.reviewLongChain(tasks, 'goal', '', 'RESEARCH NOTES', {}, RUNNERS, () => {}, undefined, undefined, undefined, log);
  }
}

describe('the review of a wall of tasks before the slices', () => {
  it('asks a plan shaped as networkx-s73 once, its chain short, naming the wall in one sentence', async () => {
    const tasks = s73();
    const chain = longestChain(tasks);
    expect(chain).toHaveLength(4);
    const svc = new ReviewService([['{"dependencyChanges":[]}', { cutOff: false }]]);
    await svc.review(tasks);
    expect(svc.calls).toHaveLength(1);
    const asked = svc.calls[0].hint!.split('\n');
    const plain = chainReviewMessage(tasks, chain).split('\n');
    // The sentence follows the chain's edges, before the blank line: every other line is as measured.
    const at = plain.indexOf('', 3);
    expect(asked).toEqual([...plain.slice(0, at), 'Most of its 37 parallel tasks wait on all 7 tasks before them; keep only the waits each needs.', ...plain.slice(at)]);
  });

  it('asks a plan shaped as networkx-s8, which also has a long chain, once, naming both', async () => {
    const tasks = s8();
    const chain = longestChain(tasks);
    expect(chain).toHaveLength(7);
    const svc = new ReviewService([['{"dependencyChanges":[]}', { cutOff: false }]]);
    await svc.review(tasks);
    expect(svc.calls).toHaveLength(1);
    const asked = svc.calls[0].hint!;
    expect(asked).toContain('Its longest chain of dependencies is 7 tasks, which run one after another:\n- "T g1" (g1) depends on "T open" (open)');
    expect(asked).toContain('\nMost of its 30 parallel tasks wait on all 13 tasks before them; keep only the waits each needs.\n\nReview the plan edge by edge');
  });

  it('asks the retry after a cut-off reply with the sentence too', async () => {
    const tasks = s73();
    const svc = new ReviewService([['{"dependencyChanges":[{"id":"s1","dep', { cutOff: true }], ['{"dependencyChanges":[]}', { cutOff: false }]]);
    await svc.review(tasks);
    expect(svc.calls).toHaveLength(2);
    expect(svc.calls[1].prompt).toMatch(/^This is a plan of tasks that coding agents will run/);
    expect(svc.calls[1].prompt).toContain('\nMost of its 37 parallel tasks wait on all 7 tasks before them; keep only the waits each needs.\n');
  });

  it('names how many of the tasks before them most slices wait on when not all', () => {
    // fanOutShape makes every task before the slices one the fan-out's level all wait on, so a plan rarely shows this.
    const tasks = s73();
    expect(chainReviewMessage(tasks, longestChain(tasks), false, { slices: 40, before: 9, median: 6 }))
      .toContain('\nMost of its 40 parallel tasks wait on 6 of the 9 tasks before them; keep only the waits each needs.\n');
  });

  it('reads the wall as the lower median of the slices\' waits', () => {
    expect(waitWall(s73())).toEqual({ slices: 37, before: 7, median: 7 });
    expect(waitWall(s8())).toEqual({ slices: 30, before: 13, median: 13 });
    expect(waitWall(s6())).toBeUndefined();
  });

  it('asks nothing of a plan shaped as networkx-seed6, whose slices wait on five', async () => {
    const tasks = s6();
    expect(longestChain(tasks)).toHaveLength(4);
    const svc = new ReviewService([]);
    const log: ResearchLogEntry[] = [];
    expect(await svc.review(tasks, log)).toEqual(tasks.map((t) => expect.objectContaining({ id: t.id, dependencies: t.dependencies })));
    expect(svc.calls).toHaveLength(0);
    expect(log.map(text).filter((l) => l.startsWith('chain review'))).toEqual([]);
  });

  it('asks nothing of a plan that does not fan out, however many tasks its slices wait on', async () => {
    const gates = ids('g', 6);
    const slices = ids('s', 3);
    const tasks = [ai('open', []), ...gates.map((g) => ai(g, ['open'])), ...slices.map((s) => ai(s, ['open', ...gates])), closing(slices)];
    const svc = new ReviewService([]);
    await svc.review(tasks);
    expect(svc.calls).toHaveLength(0);
  });

  it('keeps a revision that thins the wall though its chain is no shorter, and logs both', async () => {
    const tasks = s73();
    // Twenty of the 36 slices after the opening alone: with the slice after it as written, 21 of 37 wait on one.
    const reply = JSON.stringify({ dependencyChanges: ids('s', 20).map((id) => ({ id, dependencies: ['open'] })) });
    const svc = new ReviewService([[reply, { cutOff: false }]]);
    const log: ResearchLogEntry[] = [];
    const out = await svc.review(tasks, log);
    expect(longestChain(out)).toHaveLength(4);
    expect(out.find((t) => t.id === 's1')!.dependencies).toEqual(['open']);
    expect(out.find((t) => t.id === 's21')!.dependencies).toEqual(['open', ...ids('g', 6)]);
    expect(text(log[0])).toMatch(/^chain review: 4 -> 4, waits 7 of 7 -> 1, kept; 20 tasks changed: "T s1" drops "T g1", "T g2"/);
  });

  it('keeps the first plan when a revision neither shortens the chain nor thins the wall', async () => {
    const tasks = s73();
    const reply = JSON.stringify({ dependencyChanges: ids('s', 10).map((id) => ({ id, dependencies: ['open'] })) });
    const svc = new ReviewService([[reply, { cutOff: false }]]);
    const log: ResearchLogEntry[] = [];
    const out = await svc.review(tasks, log);
    expect(out.find((t) => t.id === 's1')!.dependencies).toEqual(['open', ...ids('g', 6)]);
    expect(text(log[0])).toMatch(/^chain review: 4 -> 4, waits 7 of 7 -> 7, first plan kept, neither shorter nor fewer waits; 10 tasks changed/);
  });
});
