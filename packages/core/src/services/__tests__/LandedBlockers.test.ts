import { describe, expect, it } from 'vitest';
import { createTask, type Task } from '../../models/Task';
import type { HandoffFinding } from '../../models/Handoff';
import { landedBlockers, raisesAt } from '../LandedBlockers';

const task = (id: string, extra: Partial<Task> = {}): Task => createTask({ id, title: `Task ${id}`, taskMode: 'build', ...extra });

const blocker = (owner: string, extra: Partial<HandoffFinding> = {}, attempt?: number): HandoffFinding => ({
  id: 'F1',
  severity: 'blocker',
  title: `${owner}'s parser drops the last token`,
  evidence: [{ kind: 'task', node: 'root', task: owner, ...(attempt !== undefined ? { attempt } : {}) }],
  ...extra,
});

const reported = (id: string, findings: HandoffFinding[], extra: Partial<Task> = {}): Task =>
  task(id, { dependencies: ['open'], status: 'completed', handoff: { summary: '', findings, findingCount: findings.length, attempt: 1 }, ...extra });

/** An opening task, four slices after it, and a closing check after them all: a plan that fans out. */
const fanOut = (slices: Task[]): Task[] => [
  task('open', { status: 'completed', handoff: { summary: 'map in report', findings: [], findingCount: 0, attempt: 1 } }),
  ...slices,
  task('close', { dependencies: slices.map((s) => s.id) }),
];

describe('raisesAt', () => {
  it('raises at the first report, its corroboration and each doubling after', () => {
    expect([1, 2, 3, 4, 5, 8, 15, 16, 21].map(raisesAt)).toEqual([true, true, false, true, false, true, false, true, false]);
    expect(raisesAt(0)).toBe(false);
  });
});

describe('landedBlockers', () => {
  it('raises one fact for the landed task a blocker names, with the closing check the fix must land before', () => {
    const plan = fanOut([reported('s1', [blocker('open')]), task('s2', { dependencies: ['open'] }), task('s3', { dependencies: ['open'] }), task('s4', { dependencies: ['open'] })]);

    expect(landedBlockers(plan, 's1')).toEqual([{ owner: 'open', reporters: 1, reports: [{ reporter: 's1', finding: 'F1', title: "open's parser drops the last token" }], closer: 'close' }]);
  });

  it('counts distinct reporters across the plan, raising at two and four but not three', () => {
    const slices = ['s1', 's2', 's3', 's4', 's5'].map((id) => reported(id, [blocker('open')]));
    const plan = fanOut(slices);
    const counts = (upTo: number) => fanOut(slices.map((s, i) => (i < upTo ? s : { ...s, handoff: undefined, status: 'in_progress' as const })));

    expect(landedBlockers(counts(2), 's2').map((f) => f.reporters)).toEqual([2]);
    expect(landedBlockers(counts(3), 's3')).toEqual([]);
    const four = landedBlockers(counts(4), 's4');
    expect(four.map((f) => [f.reporters, f.reports.length])).toEqual([[4, 3]]);
    expect(landedBlockers(plan, 's5')).toEqual([]);
  });

  it('names only work that has landed, a blocker by severity, and the attempt that landed', () => {
    const notLanded = [task('busy', { status: 'in_progress' }), reported('s1', [blocker('busy')])];
    const minor = [task('open', { status: 'completed' }), reported('s1', [blocker('open', { severity: 'major' })])];
    // The opening task landed attempt 2 since: a report against attempt 1 is about work no longer there.
    const stale = [task('open', { status: 'completed', handoff: { summary: '', findings: [], findingCount: 0, attempt: 2 } }), reported('s1', [blocker('open', {}, 1)])];
    const itself = [reported('s1', [blocker('s1')])];

    for (const plan of [notLanded, minor, stale, itself]) expect(landedBlockers(plan, 's1')).toEqual([]);
  });

  it('reads a reference to a finding as citing that report, not the work of the task that wrote it', () => {
    const plan = [task('open', { status: 'completed' }), reported('s1', [{ ...blocker('open'), evidence: [{ kind: 'task', node: 'root', task: 'open', attempt: 1, finding: 'F1' }] }])];

    expect(landedBlockers(plan, 's1')).toEqual([]);
  });

  it('leaves a plan below this one to its own supervisor', () => {
    const plan = [task('open', { status: 'completed' }), reported('s1', [{ ...blocker('open'), evidence: [{ kind: 'task', node: '2', task: 'open' }] }])];

    expect(landedBlockers(plan, 's1')).toEqual([]);
  });

  it('raises one fact per landed task a handoff names, however many of its findings name it', () => {
    const plan = [task('a', { status: 'completed' }), task('b', { status: 'completed' }), reported('s1', [blocker('a'), { ...blocker('a'), id: 'F2' }, { ...blocker('b'), id: 'F3' }], { dependencies: [] })];

    expect(landedBlockers(plan, 's1').map((f) => [f.owner, f.reporters, f.reports.map((r) => r.finding)])).toEqual([['a', 1, ['F1']], ['b', 1, ['F3']]]);
  });

  it('counts against one landed task per finding, the first it cites, however many it names', () => {
    const slices = Array.from({ length: 12 }, (_, i) => reported(`s${i}`, [], { dependencies: [] }));
    const tree: HandoffFinding = { id: 'F1', severity: 'blocker', title: 'the merged tree does not build', evidence: slices.map((s) => ({ kind: 'task' as const, node: 'root', task: s.id })) };
    const plan = [...slices, task('close', { dependencies: slices.map((s) => s.id), status: 'failed', handoff: { summary: '', findings: [tree], findingCount: 1, attempt: 1 } })];

    expect(landedBlockers(plan, 'close').map((f) => f.owner)).toEqual(['s0']);
  });

  it('names no task that lands nothing on the run\'s branch: read-only, ops or a person\'s', () => {
    for (const owner of [task('open', { status: 'completed', readOnly: true }), task('open', { status: 'completed', ops: true }), task('open', { status: 'completed', type: 'user' })]) {
      expect(landedBlockers([owner, reported('s1', [blocker('open')], { status: 'failed' })], 's1')).toEqual([]);
    }
  });

  it('leaves a loop\'s check between rounds to its loop, whose body is the fix', () => {
    const check = (status: Task['status'], loopRound: number) => task('check', { readOnly: true, dependencies: ['open'], status, verdict: { outcome: 'fail', reason: '', checks: [], reported: 'failed', decidedAt: new Date(Date.UTC(2026, 0, 1)).toISOString() }, loop: { body: ['fix'], maxRounds: 2 }, loopRound, handoff: { summary: '', findings: [blocker('open')], findingCount: 1, attempt: 1 } });
    const plan = (c: Task) => [task('open', { status: 'completed' }), c, task('fix', { dependencies: ['check'] })];

    expect(landedBlockers(plan(check('failed', 1)), 'check')).toEqual([]);
    // Its last round failed: the loop has nothing left to fix it with.
    expect(landedBlockers(plan(check('failed', 2)), 'check').map((f) => f.owner)).toEqual(['open']);
  });
});

describe('landedBlockers, by the files landed work changed', () => {
  const fileBlocker = (id: string, ...paths: string[]): HandoffFinding => ({ id, severity: 'blocker', title: `${paths[0]} is broken`, evidence: paths.map((path) => ({ kind: 'file' as const, path, line: 3 })) });
  const changed: Record<string, string[]> = { open: ['pkg/decorators.py', 'pkg/backends.py'] };
  const landedPaths = (id: string) => changed[id];

  it('names the landed task that changed the file a blocker cites, reading no words', () => {
    const plan = fanOut([reported('s1', [fileBlocker('F1', 'pkg/decorators.py')]), ...['s2', 's3', 's4'].map((id) => task(id, { dependencies: ['open'] }))]);

    expect(landedBlockers(plan, 's1', landedPaths)).toEqual([{ owner: 'open', reporters: 1, reports: [{ reporter: 's1', finding: 'F1', title: 'pkg/decorators.py is broken' }], closer: 'close' }]);
    expect(landedBlockers(plan, 's1')).toEqual([]);
  });

  it('names one landed task a finding by its files: the first cited that landed work changed, not the callers it shows in', () => {
    const gen = task('gen', { status: 'completed', dependencies: ['open'] });
    const paths: Record<string, string[]> = { ...changed, gen: ['pkg/classic.py'] };
    const plan = [task('open', { status: 'completed' }), gen, reported('s1', [fileBlocker('F1', 'pkg/vendored.py', 'pkg/decorators.py', 'pkg/classic.py')])];

    expect(landedBlockers(plan, 's1', (id) => paths[id]).map((f) => f.owner)).toEqual(['open']);
  });

  it('gives a file several landings changed to the last that landed before the report, as the reporter found the tree', () => {
    const at = (minute: number) => ({ outcome: 'pass' as const, reason: '', checks: [], decidedAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString() });
    const paths: Record<string, string[]> = { multi: ['pkg/multidigraph.py'], graph: ['pkg/multidigraph.py', 'pkg/convert.py'] };
    const plan = [
      task('multi', { status: 'completed', verdict: at(1) }),
      reported('early', [fileBlocker('F1', 'pkg/multidigraph.py')], { dependencies: [], verdict: at(2) }),
      task('graph', { status: 'completed', verdict: at(3) }),
      reported('late', [fileBlocker('F1', 'pkg/multidigraph.py')], { dependencies: [], verdict: at(4) }),
    ];

    expect(landedBlockers(plan, 'early', (id) => paths[id]).map((f) => [f.owner, f.reporters])).toEqual([['multi', 1]]);
    expect(landedBlockers(plan, 'late', (id) => paths[id]).map((f) => [f.owner, f.reporters])).toEqual([['graph', 1]]);
  });

  it('counts no report made before the work it names landed, so the first report after it is raised', () => {
    const at = (minute: number) => ({ outcome: 'pass' as const, reason: '', checks: [], decidedAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString() });
    const plan = [
      reported('s1', [blocker('open')], { dependencies: [], verdict: at(1) }),
      reported('s2', [fileBlocker('F1', 'pkg/decorators.py')], { dependencies: [], verdict: at(2) }),
      task('open', { status: 'completed', verdict: at(3) }),
      reported('s3', [blocker('open')], { dependencies: [], verdict: at(4) }),
    ];

    expect(landedBlockers(plan, 's3', landedPaths).map((f) => [f.owner, f.reporters, f.reports.map((r) => r.reporter)])).toEqual([['open', 1, ['s3']]]);
  });
});
