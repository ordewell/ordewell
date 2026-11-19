import { describe, expect, it } from 'vitest';
import { applyChainReview, chainReviewMessage, chainReviewNote, longestChain, revisionNote, CHAIN_REVIEW_MIN, TOOL_CHAIN_REVIEW_MIN } from '../PlanChainReview';
import { BaseAiService, type PlanTextCall, type PlanTextReply } from '../BaseAiService';
import { createTask, type ResearchLogEntry, type ResearchProgress, type RunnerId, type Task } from '../../models/Task';
import { fakeConfig } from '../../testing';

const t = (id: string, deps: string[], prompt = `Do ${id}.`): Task => createTask({ id, title: `T ${id}`, dependencies: deps, prompt, assignedRunner: 'claude-code' });
const RUNNERS: RunnerId[] = ['claude-code'];
const text = (e: ResearchLogEntry): string => ('content' in e ? String(e.content) : '');

/** a > b > c > d > e, and f beside them. */
const chain5 = () => [t('a', []), t('b', ['a']), t('c', ['b'], 'Wait for "T b", then fill in c.'), t('d', ['c']), t('e', ['d']), t('f', ['a'])];

it('finds the longest chain and names its edges', () => {
  const tasks = [t('a', []), t('b', ['a']), t('c', ['b']), t('d', ['a']), t('e', ['c', 'd'])];
  expect(longestChain(tasks).map((x) => x.id)).toEqual(['a', 'b', 'c', 'e']);
  const msg = chainReviewMessage(tasks, longestChain(tasks));
  expect(msg).toContain('"T e" (e) depends on "T c" (c)');
  expect(msg).toContain('is 4 tasks');
});

it('returns no chain for a cycle', () => {
  expect(longestChain([t('a', ['b']), t('b', ['a'])])).toEqual([]);
});

it('asks for the changed dependency lists only, and names what keeps an edge', () => {
  const msg = chainReviewMessage(chain5(), longestChain(chain5()));
  expect(msg).toContain('{"dependencyChanges":[{"id":"<task id>","dependencies":["<task id>", ...]}]}');
  expect(msg).not.toMatch(/whole revised plan/);
  for (const kept of ['finding', 'reproduction before its fix', 'ops task after the changes', 'loop\'s body after its check', 'collide in one checkout', 'expand-contract']) {
    expect(msg).toContain(kept);
  }
});

// Each review was measured with exactly these words: the one-shot call's and submit_plan's answer's.
it('words the one-shot review as measured, and its retry with no claim that the reader wrote the plan', () => {
  const tasks = [t('a', []), t('b', ['a'])];
  const msg = chainReviewMessage(tasks, tasks).split('\n');
  expect(msg[0]).toBe('This is the plan you wrote:');
  expect(msg.slice(2)).toEqual([
    '',
    'Its longest chain of dependencies is 2 tasks, which run one after another:',
    '- "T b" (b) depends on "T a" (a)',
    '',
    'Review the plan edge by edge, every dependency, not only these. For each, ask: does the dependent need a file, name, signature or schema that does not exist in the repository until the other task writes it? Filling in a stub or an interface that already exists creates nothing to consume, and a slice whose tests also run code another slice writes does not need it either: it runs them, reports which fail only for that reason, and leaves those to the closing check.',
    'Keep an edge all the same when the dependent needs the other task\'s finding (research before the build it informs, a reproduction before its fix), or when another rule orders them: an ops task after the changes it acts on, a loop\'s body after its check, two tasks that would collide in one checkout, the steps of an expand-contract change. Keep a leading task that makes the project build, import or collect its tests, and a closing check that depends on every task.',
    'Reply with only the tasks whose dependencies change, each with its complete new list, as one JSON object and nothing else: {"dependencyChanges":[{"id":"<task id>","dependencies":["<task id>", ...]}]}. Use the ids above. An empty list makes the task wait for none; when nothing changes, reply {"dependencyChanges":[]}.',
  ]);
  const alone = chainReviewMessage(tasks, tasks, true).split('\n');
  expect(alone[0]).toBe('This is a plan of tasks that coding agents will run, each task once its dependencies are done:');
  expect(alone.slice(1)).toEqual(chainReviewMessage(tasks, tasks).split('\n').slice(1));
});

// Two parts were added after the measurement: the collision edge a shared workspace needs (the
// improve-codebase-architecture skill orders overlapping tasks there), and the line keeping it from the user.
it('words submit_plan\'s review as measured, keeps edges a shared workspace needs, and keeps it from the user', () => {
  expect(TOOL_CHAIN_REVIEW_MIN).toBe(4);
  expect(chainReviewNote([t('a', []), t('b', ['a'])])).toBe([
    'Its longest chain of dependencies is 2 tasks, which run one after another: "T a" (a) → "T b" (b).',
    'Before you end your turn, review the plan edge by edge, every dependency, not only these. For each, ask: does the dependent need a file, name, signature or schema that does not exist in the repository until the other task writes it? Filling in a stub or an interface that already exists creates nothing to consume, and a slice whose tests also run code another slice writes does not need it either: its brief runs them, reports which fail only for that reason, and leaves those to the closing check.',
    'Keep every dependency another rule requires: research before the work it informs, a reproduction before its fix, an ops task after the changes it acts on, two tasks that would collide in one checkout, a loop\'s check and its body, the steps of an expand-contract change, a leading task that makes the project build, import or collect its tests, and a closing check that depends on every task.',
    'If any dependency fails the test, call submit_plan once more with the whole plan, each such dependency removed and each brief that named it as a task it waits for reworded to say it runs in parallel; that plan replaces this one. If every dependency passes, keep the plan as it is.',
    'Do not mention this review to the user.',
  ].join(' '));
});

describe('applyChainReview', () => {
  it('applies each new list and notes the change in that brief alone', () => {
    const reply = 'Here:\n{"dependencyChanges":[{"id":"c","dependencies":["a"]},{"id":"d","dependencies":["a"]},{"id":"e","dependencies":["c","d"]}]}';
    const r = applyChainReview(chain5(), reply, RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(r.tasks.map((x) => [x.id, x.dependencies])).toEqual([['a', []], ['b', ['a']], ['c', ['a']], ['d', ['a']], ['e', ['c', 'd']], ['f', ['a']]]);
    expect(longestChain(r.tasks)).toHaveLength(3);
    expect(r.changes).toEqual([{ id: 'c', removed: ['b'], added: ['a'] }, { id: 'd', removed: ['c'], added: ['a'] }, { id: 'e', removed: [], added: ['c'] }]);
    const c = r.tasks.find((x) => x.id === 'c')!;
    expect(c.prompt).toBe('Wait for "T b", then fill in c.\n\n' + revisionNote(['"T b" (b)'], ['"T a" (a)']));
    expect(c.prompt).toContain('no longer waits for "T b" (b), which runs in parallel with it');
    expect(r.tasks.find((x) => x.id === 'b')!.prompt).toBe('Do b.');
  });

  it('leaves the plan alone when nothing changes', () => {
    const r = applyChainReview(chain5(), '{"dependencyChanges":[]}', RUNNERS);
    expect(r.ok && r.changes).toEqual([]);
  });

  it.each([
    ['no object', 'I would drop the edge c > b.'],
    ['a cut-off reply', '{"dependencyChanges":[{"id":"c","dependencies":["a"'],
    ['an unknown task', '{"dependencyChanges":[{"id":"zz","dependencies":[]}]}'],
    ['an unknown dependency', '{"dependencyChanges":[{"id":"c","dependencies":["zz"]}]}'],
    ['a malformed entry', '{"dependencyChanges":[{"id":"c","dependencies":"a"}]}'],
    ['a cycle', '{"dependencyChanges":[{"id":"a","dependencies":["e"]}]}'],
  ])('rejects the whole reply on %s', (_name, reply) => {
    expect(applyChainReview(chain5(), reply, RUNNERS).ok).toBe(false);
  });

  it('names several removed tasks together', () => {
    expect(revisionNote(['"A"', '"B"'], [])).toBe('Plan revision: this task no longer waits for "A" and "B", which run in parallel with it. Where this brief says to wait for them, do not: take in their work once it has landed, and until then run this slice\'s tests, name each that fails only because that work has not landed in a finding, and leave those to the closing check.');
    expect(revisionNote([], ['"C"'])).toBe('Plan revision: This task now also runs after "C".');
  });
});

/** Answers each plan-text call with the next reply in turn, and keeps what each call asked for. */
class ReviewService extends BaseAiService {
  calls: { prompt: string; hint: string | undefined; call: PlanTextCall | undefined }[] = [];
  constructor(private readonly replies: readonly [string, PlanTextReply][]) { super(fakeConfig()); }
  get efforts(): (string | undefined)[] { return this.calls.map((c) => c.call?.effort); }
  reset(): void {}
  ensureInit(): void {}
  protected async streamPlanText(prompt: string, hint: string | undefined, _t: (x: string) => void, _r?: (x: string) => void, _s?: AbortSignal, call?: PlanTextCall): Promise<string> {
    const [text, reply] = this.replies[this.calls.length];
    this.calls.push({ prompt, hint, call });
    call?.onReply?.(reply);
    return text;
  }
  review(tasks: Task[], onProgress: (p: ResearchProgress) => void, log: ResearchLogEntry[]): Promise<Task[]> {
    return this.reviewLongChain(tasks, 'goal', '', 'RESEARCH NOTES', {}, RUNNERS, onProgress, undefined, undefined, undefined, log);
  }
}

describe('reviewLongChain', () => {
  const usage = { source: 'openrouter', model: 'm', inputTokens: 10, outputTokens: 2, reportedCost: { amount: 0.01, currency: 'USD' } };
  const SHORTER = '{"dependencyChanges":[{"id":"c","dependencies":["a"]},{"id":"d","dependencies":["a"]}]}';
  const CUT = '{"dependencyChanges":[{"id":"c","dep';
  const usages = (progress: ResearchProgress[]) => progress.filter((p) => p.type === 'usage').map((p) => p.record);

  it('makes one call, records its usage with the planner\'s, keeps a shorter plan and notes the change in the brief and the log', async () => {
    const svc = new ReviewService([[SHORTER, { usage, cutOff: false }]]);
    const progress: ResearchProgress[] = [];
    const log: ResearchLogEntry[] = [];
    const out = await svc.review(chain5(), (p) => progress.push(p), log);
    expect(svc.calls).toHaveLength(1);
    expect(svc.efforts).toEqual(['low']);
    expect(svc.calls[0].call?.largestReply).toBe(false);
    expect(svc.calls[0].hint).toBe(chainReviewMessage(chain5(), longestChain(chain5())));
    expect(longestChain(out)).toHaveLength(3);
    expect(out.find((x) => x.id === 'c')!.prompt).toBe('Wait for "T b", then fill in c.\n\n' + revisionNote(['"T b" (b)'], ['"T a" (a)']));
    expect(out.find((x) => x.id === 'e')!.prompt).toBe('Do e.');
    expect(usages(progress)).toEqual([{ ...usage, aggregate: true }]);
    expect(log.map(text)).toEqual(['chain review: 5 -> 3, kept; 2 tasks changed: "T c" drops "T b" adds "T a"; "T d" drops "T c" adds "T a" [reply 2 tokens out]']);
  });

  it('keeps the first plan when the revision is not shorter, and says so', async () => {
    const tasks = chain5();
    const svc = new ReviewService([['{"dependencyChanges":[{"id":"f","dependencies":[]}]}', { usage, cutOff: false }]]);
    const log: ResearchLogEntry[] = [];
    expect(await svc.review(tasks, () => {}, log)).toBe(tasks);
    expect(text(log[0])).toMatch(/^chain review: 5 -> 5, first plan kept, not shorter; 1 task changed/);
  });

  it('keeps the first plan on an invalid revision, with no second call when the reply was not cut off', async () => {
    const tasks = chain5();
    const svc = new ReviewService([['{"dependencyChanges":[{"id":"a","dependencies":["e"]}]}', { usage, cutOff: false }]]);
    const log: ResearchLogEntry[] = [];
    expect(await svc.review(tasks, () => {}, log)).toBe(tasks);
    expect(svc.calls).toHaveLength(1);
    expect(text(log[0])).toMatch(/^chain review: 5, first plan kept: /);
  });

  it('asks once more after a cut-off reply, with the plan and the question alone, the least effort and the longest reply', async () => {
    const svc = new ReviewService([[CUT, { usage, cutOff: true }], [SHORTER, { usage: { ...usage, outputTokens: 3 }, cutOff: false }]]);
    const progress: ResearchProgress[] = [];
    const log: ResearchLogEntry[] = [];
    const out = await svc.review(chain5(), (p) => progress.push(p), log);
    expect(svc.calls).toHaveLength(2);
    const retry = svc.calls[1];
    expect(retry.prompt).toBe(chainReviewMessage(chain5(), longestChain(chain5()), true));
    expect(retry.prompt).toMatch(/^This is a plan of tasks that coding agents will run/);
    expect(retry.prompt).not.toContain('RESEARCH NOTES');
    expect(svc.calls[0].prompt).toContain('RESEARCH NOTES');
    expect(retry.hint).toBeUndefined();
    expect(retry.call).toMatchObject({ effort: 'low', largestReply: true });
    expect(longestChain(out)).toHaveLength(3);
    // Both calls are billed with the planner's.
    expect(usages(progress)).toEqual([{ ...usage, aggregate: true }, { ...usage, outputTokens: 3, aggregate: true }]);
    expect(log.map(text)).toEqual([
      'chain review: 5, reply cut off at the output limit [reply 2 tokens out]; asked once more with the plan alone',
      'chain review: 5 -> 3, kept; 2 tasks changed: "T c" drops "T b" adds "T a"; "T d" drops "T c" adds "T a" [reply 3 tokens out]',
    ]);
  });

  it('keeps the first plan when the second reply is cut off too, asking no third time and still recording both', async () => {
    const tasks = chain5();
    const svc = new ReviewService([[CUT, { usage, cutOff: true }], [CUT, { usage, cutOff: true }], [SHORTER, { usage, cutOff: false }]]);
    const progress: ResearchProgress[] = [];
    const log: ResearchLogEntry[] = [];
    expect(await svc.review(tasks, (p) => progress.push(p), log)).toBe(tasks);
    expect(svc.calls).toHaveLength(2);
    expect(usages(progress)).toHaveLength(2);
    expect(text(log[1])).toMatch(/^chain review: 5, first plan kept: reply cut off at the output limit; /);
  });

  it('keeps the first plan when the second reply is invalid', async () => {
    const tasks = chain5();
    const svc = new ReviewService([[CUT, { usage, cutOff: true }], ['{"dependencyChanges":[{"id":"zz","dependencies":[]}]}', { usage, cutOff: false }]]);
    const log: ResearchLogEntry[] = [];
    expect(await svc.review(tasks, () => {}, log)).toBe(tasks);
    expect(svc.calls).toHaveLength(2);
    expect(text(log[1])).toMatch(/^chain review: 5, first plan kept: unknown task "zz"/);
  });

  it('takes a reply that was cut off after its list was whole, with no second call', async () => {
    const svc = new ReviewService([[`${SHORTER}\nI also considered`, { usage, cutOff: true }]]);
    const out = await svc.review(chain5(), () => {}, []);
    expect(svc.calls).toHaveLength(1);
    expect(longestChain(out)).toHaveLength(3);
  });

  it('makes no call under the threshold, and one from it', async () => {
    expect(CHAIN_REVIEW_MIN).toBe(5);
    const svc = new ReviewService([]);
    const tasks = [t('a', []), t('b', ['a']), t('c', ['b']), t('d', ['c'])];
    const log: ResearchLogEntry[] = [];
    expect(await svc.review(tasks, () => {}, log)).toBe(tasks);
    expect(svc.calls).toHaveLength(0);
    expect(log).toEqual([]);
    const at = new ReviewService([['{"dependencyChanges":[]}', { cutOff: false }]]);
    await at.review([...tasks, t('e', ['d'])], () => {}, []);
    expect(at.calls).toHaveLength(1);
  });
});
