import { describe, expect, it } from 'vitest';
import { mergeSmallSlices } from '../PlanFanOut';
import { createTask, renumberTasks, type Task } from '../../models/Task';
import { lines, workspace } from './planFanOutKit';

const t = (id: string, deps: string[], prompt: string, extra: Partial<Task> = {}): Task =>
  createTask({ id, title: `T ${id}`, dependencies: deps, prompt, assignedRunner: 'claude-code', autonomy: 'AFK', sliceType: 'AFK', ...extra });
const ids = (ts: readonly Task[]) => ts.map((x) => x.id);
const find = (ts: readonly Task[], id: string) => ts.find((x) => x.id === id)!;

/** Ten slices between an opening task and a closing check, each naming its module and its tests. */
const SIZES = [100, 90, 10, 10, 20, 20, 30, 30, 40, 50];
const tenSlices = () => renumberTasks([
  t('r', [], 'Make the package import.'),
  ...SIZES.map((_, i) => t(`s${i + 1}`, ['r'], `Fill in src/m${i + 1}.py. Verify: pytest tests/test_m${i + 1}.py`)),
  t('close', SIZES.map((_, i) => `s${i + 1}`), 'Run the suite and fix what fails.'),
]);
const tenFiles = () => workspace(Object.fromEntries(SIZES.map((n, i) => [`tests/test_m${i + 1}.py`, lines(n)])));

describe('mergeSmallSlices', () => {
  it('merges the smallest slices of a level, two at a time, toward a multiple of twice the parallel limit, no bin past its largest slice', async () => {
    // Worked by hand at a limit of 2: 3+4, then +5, 6+7, then +8 leaves six tasks. A seventh merge
    // (9 and 6+7, ninety lines) would reach five, which is no multiple of two, and no merge after it fits under a hundred.
    const out = await mergeSmallSlices(tenSlices(), tenFiles().fs, 2);
    expect(ids(out.tasks)).toEqual(['r', 's1', 's2', 's3', 's6', 's9', 's10', 'close']);
    expect(out.tasks.map((x) => x.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(find(out.tasks, 's3').mergedSlices).toEqual(['s4', 's5', 's8']);
    expect(find(out.tasks, 's6').mergedSlices).toEqual(['s7']);
    expect(find(out.tasks, 's1').mergedSlices).toBeUndefined();
    expect(find(out.tasks, 'close').dependencies).toEqual(['s1', 's2', 's3', 's6', 's9', 's10']);
    expect(out.merged).toEqual({ from: 10, to: 6, measure: 'test' });
  });

  it('stops at the fewest the cap allows when the multiple of the limit above it is no fewer than the planner wrote', async () => {
    // Ten slices at a limit of 4: only the two of 10 lines fit together, so nine is the fewest, and twelve is past ten.
    const sizes = [100, 100, 100, 100, 100, 100, 100, 100, 10, 10];
    const plan = renumberTasks([
      t('r', [], 'Make the package import.'),
      ...sizes.map((_, i) => t(`s${i + 1}`, ['r'], `Verify: pytest tests/test_m${i + 1}.py`)),
      t('close', sizes.map((_, i) => `s${i + 1}`), 'Run the suite.'),
    ]);
    const { fs } = workspace(Object.fromEntries(sizes.map((n, i) => [`tests/test_m${i + 1}.py`, lines(n)])));
    const out = await mergeSmallSlices(plan, fs, 4);
    expect(find(out.tasks, 's9').mergedSlices).toEqual(['s10']);
    expect(out.merged).toEqual({ from: 10, to: 9, measure: 'test' });
  });

  it('writes a merged task as one brief over its slices, each whole under its own title, with one done criterion and their notes last', async () => {
    // Five slices at a limit of 2: only the two smallest, of 10 and 20 lines, fit a bin of at most 50.
    const plan = renumberTasks([
      t('r', [], 'Make the package import.'),
      t('a', ['r'], 'Fill in src/a.py.\nVerify: pytest tests/test_a.py', { description: 'The a module.', userStoriesCovered: ['parse'], skills: ['tdd'], taskMode: 'build' }),
      t('b', ['r'], 'Fill in src/b.py. Verify: pytest tests/test_b.py', { skills: ['tdd'] }),
      t('c', ['r'], 'Fill in src/c.py. Verify: pytest tests/test_c.py\n\nPlan revision: this task no longer waits for "T x".', { description: 'The c module.', userStoriesCovered: ['parse', 'emit'], skills: ['tdd'], taskMode: 'build' }),
      t('d', ['r'], 'Fill in src/d.py. Verify: pytest tests/test_d.py', { skills: ['tdd'] }),
      t('e', ['r'], 'Fill in src/e.py. Verify: pytest tests/test_e.py', { skills: ['tdd'] }),
      t('close', ['a', 'b', 'c', 'd', 'e'], 'Run the suite.'),
    ]);
    const { fs } = workspace({ 'tests/test_a.py': lines(10), 'tests/test_b.py': lines(50), 'tests/test_c.py': lines(20), 'tests/test_d.py': lines(40), 'tests/test_e.py': lines(45) });
    const out = await mergeSmallSlices(plan, fs, 2);
    expect(ids(out.tasks)).toEqual(['r', 'a', 'b', 'd', 'e', 'close']);
    expect(find(out.tasks, 'a')).toEqual({
      ...plan[1],
      order: 2,
      title: 'T a; T c',
      description: 'The a module.\n\nThe c module.',
      prompt: [
        'This task covers 2 slices the planner wrote separately, each brief below whole and in order under its own title. Do every one of them in this task.',
        'Slice 1 of 2: T a\nFill in src/a.py.\nVerify: pytest tests/test_a.py',
        'Slice 2 of 2: T c\nFill in src/c.py. Verify: pytest tests/test_c.py',
        "This task is done when every slice above meets its own brief's done criterion.",
        'Plan revision: this task no longer waits for "T x".',
      ].join('\n\n'),
      mergedSlices: ['c'],
      userStoriesCovered: ['parse', 'emit'],
    });
    expect(out.merged).toEqual({ from: 5, to: 4, measure: 'test' });
  });

  describe('merges only slices of one kind', () => {
    /** Two small slices beside three at the level's largest size, at a limit of 2: alike, the two merge. */
    const pair = (b: Partial<Task> = {}, extra: Task[] = []) => renumberTasks([
      t('r', [], 'Make the package import.'),
      t('install', [], 'Install the tools.', { ops: true }),
      t('a', ['r'], 'Fill in src/a.py. Verify: pytest tests/test_a.py'),
      t('b', ['r'], 'Fill in src/b.py. Verify: pytest tests/test_b.py', b),
      ...['c', 'd', 'e'].map((id) => t(id, ['r'], `Fill in src/${id}.py. Verify: pytest tests/test_${id}.py`)),
      t('close', ['a', 'b', 'c', 'd', 'e'], 'Run the suite.'),
      ...extra,
    ]);
    const files = () => workspace({ 'tests/test_a.py': lines(10), 'tests/test_b.py': lines(10), 'tests/test_c.py': lines(100), 'tests/test_d.py': lines(100), 'tests/test_e.py': lines(100) }).fs;

    it('merges two slices alike', async () => {
      expect(find((await mergeSmallSlices(pair(), files(), 2)).tasks, 'a').mergedSlices).toEqual(['b']);
    });

    it.each<[string, Partial<Task>, Task[]]>([
      ['runner', { assignedRunner: 'codex' }, []],
      ['model', { assignedModel: { modelId: 'other', modelLabel: 'Other' } }, []],
      ['mode', { taskMode: 'plan-and-build' }, []],
      ['skills', { skills: ['tdd'] }, []],
      ['autonomy', { autonomy: 'HITL' }, []],
      ['dependencies', { dependencies: ['r', 'install'] }, []],
      ['dependents', {}, [t('look', ['b'], 'Look at b.', { type: 'user' })]],
    ])('never merges slices that differ in their %s', async (_, b, extra) => {
      const plan = pair(b, extra);
      const out = await mergeSmallSlices(plan, files(), 2);
      expect(out.tasks).toBe(plan);
      expect(out.merged).toBeUndefined();
    });
  });

  describe('leaves the plan as it was', () => {
    const same = async (plan: Task[], fs: ReturnType<typeof workspace>['fs'], limit: number | undefined) => {
      const out = await mergeSmallSlices(plan, fs, limit);
      expect(out.tasks).toBe(plan);
      expect(out.merged).toBeUndefined();
    };

    it('with no level of more than twice the parallel limit, and reads nothing', async () => {
      const { fs, reads } = tenFiles();
      await same(tenSlices(), fs, 5);
      await same(tenSlices(), fs, 10);
      await same(tenSlices(), fs, undefined);
      expect(reads).toEqual([]);
    });

    it('with a plan that does not fan out', async () => {
      const narrow = renumberTasks(SIZES.slice(0, 3).map((_, i) => t(`s${i + 1}`, i ? [`s${i}`] : [], `Fill in src/m${i + 1}.py. Verify: pytest tests/test_m${i + 1}.py`)));
      await same(narrow, tenFiles().fs, 1);
    });

    it('with no slice sized', async () => {
      await same(tenSlices(), workspace({}).fs, 2);
    });

    it('with its briefs noted already', async () => {
      const noted = tenSlices().map((x) => (x.id === 's3' ? { ...x, prompt: `${x.prompt}\n\nPlan shape: this task is one of 10 slices.` } : x));
      await same(noted, tenFiles().fs, 2);
    });

    it('keeps a slice with no size alone: none of the files its brief names could be read', async () => {
      const unsized = tenSlices().map((x) => (x.id === 's3' || x.id === 's4' ? { ...x, prompt: 'Fill in src/gone.py. Verify: pytest tests/test_gone.py' } : x));
      const out = await mergeSmallSlices(unsized, tenFiles().fs, 2);
      expect(out.tasks.some((x) => x.mergedSlices?.some((id) => id === 's3' || id === 's4'))).toBe(false);
      expect(ids(out.tasks)).toContain('s3');
      expect(ids(out.tasks)).toContain('s4');
    });
  });

  it('merges each crowded level on its own, the later on the dependencies the earlier merge rewrote', async () => {
    const levelSizes: Record<string, number> = { a1: 100, a2: 100, a3: 100, a4: 10, a5: 10, b1: 50, b2: 50, b3: 50, b4: 5, b5: 5 };
    const brief = (id: string) => `Fill in src/${id}.py. Verify: pytest tests/test_${id}.py`;
    const plan = renumberTasks([
      t('r', [], 'Make the package import.'),
      ...['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => t(id, ['r'], brief(id))),
      ...['b1', 'b2', 'b3'].map((id, i) => t(id, [`a${i + 1}`], brief(id))),
      t('b4', ['a4', 'a5'], brief('b4')),
      t('b5', ['a4', 'a5'], brief('b5')),
      t('close', ['b1', 'b2', 'b3', 'b4', 'b5'], 'Run the suite.'),
    ]);
    const { fs } = workspace(Object.fromEntries(Object.entries(levelSizes).map(([id, n]) => [`tests/test_${id}.py`, lines(n)])));
    const out = await mergeSmallSlices(plan, fs, 2);
    expect(ids(out.tasks)).toEqual(['r', 'a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4', 'close']);
    expect(find(out.tasks, 'a4').mergedSlices).toEqual(['a5']);
    expect(find(out.tasks, 'b4')).toMatchObject({ mergedSlices: ['b5'], dependencies: ['a4'] });
    expect(find(out.tasks, 'close').dependencies).toEqual(['b1', 'b2', 'b3', 'b4']);
    expect(out.merged).toEqual({ from: 10, to: 8, measure: 'test' });
  });
});
