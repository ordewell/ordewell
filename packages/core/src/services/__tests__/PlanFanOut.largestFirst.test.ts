import { describe, expect, it } from 'vitest';
import { largestSlicesFirst, MAX_SIZED_FILES, MAX_SIZED_LISTINGS } from '../PlanFanOut';
import { createTask, renumberTasks, type Task } from '../../models/Task';
import { fakeFileSystem } from '../../testing';
import { lines, workspace } from './planFanOutKit';

const t = (id: string, deps: string[], prompt: string, extra: Partial<Task> = {}): Task =>
  createTask({ id, title: `T ${id}`, dependencies: deps, prompt, assignedRunner: 'claude-code', autonomy: 'AFK', sliceType: 'AFK', ...extra });
const ids = (ts: readonly Task[]) => ts.map((x) => x.id);
/** An opening task, five slices that each name their module and its tests, a closing check. */
const plan = () => renumberTasks([
  t('r', [], 'Make the package import.'),
  ...[1, 2, 3, 4, 5].map((n) => t(`s${n}`, ['r'], `Fill in src/lib/m${n}.py. Verify: pytest tests/test_m${n}.py`)),
  t('close', ['s1', 's2', 's3', 's4', 's5'], 'Run the suite and fix what fails.'),
]);

describe('largestSlicesFirst', () => {
  it('starts the slices whose named test files are longest first, and changes nothing but their order', async () => {
    const { fs } = workspace({
      'tests/test_m1.py': lines(10), 'tests/test_m2.py': lines(300), 'tests/test_m3.py': lines(40),
      'tests/test_m4.py': lines(900), 'tests/test_m5.py': lines(40),
      'src/lib/m1.py': lines(5000),
    });
    const before = plan();
    const out = await largestSlicesFirst(before, fs);
    expect(ids(out.tasks)).toEqual(['r', 's4', 's2', 's3', 's5', 's1', 'close']);
    expect(out.tasks.map((x) => x.order)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const task of out.tasks) expect({ ...task, order: 0 }).toEqual({ ...before.find((b) => b.id === task.id)!, order: 0 });
    expect(out.measure).toBe('test');
    expect(out.moved).toBe(3);
  });

  it('sizes by the lines of every file a brief names when no slice names a test file that exists', async () => {
    const { fs } = workspace({ 'src/lib/m1.py': lines(20), 'src/lib/m2.py': lines(10), 'src/lib/m3.py': lines(700), 'src/lib/m5.py': lines(30) });
    const out = await largestSlicesFirst(plan(), fs);
    expect(ids(out.tasks)).toEqual(['r', 's3', 's5', 's1', 's2', 's4', 'close']);
    expect(out.measure).toBe('named');
    expect(out.moved).toBe(5);
  });

  // A recorded library plan's briefs named module files first and their tests after the sixth path, so most slices sized nothing.
  it('sizes by every test file a brief names, past the paths the notes\' tables list', async () => {
    const modules = (n: number) => Array.from({ length: 6 }, (_, i) => `src/lib/m${n}_${i}.py`).join(', ');
    const late = renumberTasks([
      t('r', [], 'Make the package import.'),
      ...[1, 2, 3, 4, 5].map((n) => t(`s${n}`, ['r'], `Fill in ${modules(n)}. Verify: pytest tests/test_m${n}.py tests/test_m${n}_more.py`)),
      t('close', ['s1', 's2', 's3', 's4', 's5'], 'Run the suite and fix what fails.'),
    ]);
    const { fs } = workspace({
      'tests/test_m1.py': lines(10), 'tests/test_m2.py': lines(300), 'tests/test_m3.py': lines(40),
      'tests/test_m4.py': lines(100), 'tests/test_m4_more.py': lines(800), 'tests/test_m5.py': lines(40),
    });
    const out = await largestSlicesFirst(late, fs);
    expect(ids(out.tasks)).toEqual(['r', 's4', 's2', 's3', 's5', 's1', 'close']);
    expect(out.measure).toBe('test');
  });

  // The daemon's PoolFileSystem, which the API planner's one-shot plans are sized through, lists a directory's files relative to it.
  it('sizes by the test files under a test directory a brief names, as the planner\'s glob lists them from that directory', async () => {
    const dirs = renumberTasks([
      t('r', [], 'Make the package import.'),
      t('s1', ['r'], 'Fill in pkg/a/core.py. Its tests are in pkg/a/tests/.'),
      t('s2', ['r'], 'Fill in pkg/b/core.py. Verify: pytest pkg/b/tests'),
      t('s3', ['r'], 'Fill in pkg/c/core.py. Verify: pytest pkg/c/tests/test_c.py'),
      t('s4', ['r'], 'Fill in pkg/d/core.py, then run the tests.'),
      t('close', ['s1', 's2', 's3', 's4'], 'Run the suite.'),
    ]);
    const { fs, globs } = workspace({
      'pkg/a/tests/test_one.py': lines(30), 'pkg/a/tests/test_two.py': lines(40), 'pkg/a/tests/data.json': lines(9000),
      // A row of pkg/b/tests is that directory's path: this one is pkg/b/tests/pkg/b/tests/test_b.py, not the one beside it.
      'pkg/b/tests/pkg/b/tests/test_b.py': lines(500), 'pkg/b/tests/test_b.py': lines(1),
      'pkg/c/tests/test_c.py': lines(200), 'pkg/d/core.py': lines(9000),
    });
    const out = await largestSlicesFirst(dirs, fs);
    expect(ids(out.tasks)).toEqual(['r', 's2', 's3', 's1', 's4', 'close']);
    expect(out.measure).toBe('test');
    // A bare `tests` is prose: only a path with a slash is listed.
    expect(globs.sort()).toEqual(['pkg/a/tests', 'pkg/b/tests']);
  });

  it('reads a test file a brief names by its bare name where exactly one file of that name lies under a directory it names', async () => {
    const bare = renumberTasks([
      t('r', [], 'Make the package import.'),
      t('s1', ['r'], 'Fill in lib/flow/maxflow.py. Use its tests: test_maxflow.py.'),
      t('s2', ['r'], 'Fill in lib/cuts/cuts.py. Use its tests: test_core.py.'),
      t('s3', ['r'], 'Fill in lib/a/a.py. Verify: pytest lib/a/tests/test_a.py, then test_a.py again.'),
      t('s4', ['r'], 'Its tests are in lib/d/tests/; start with test_d2.py.'),
      t('close', ['s1', 's2', 's3', 's4'], 'Run the suite.'),
    ]);
    const { fs, globs } = workspace({
      'lib/flow/maxflow.py': lines(10), 'lib/flow/tests/test_maxflow.py': lines(600),
      // Two files of the name: which one the brief meant is a guess, so neither is read.
      'lib/cuts/cuts.py': lines(10), 'lib/cuts/tests/test_core.py': lines(900), 'lib/cuts/old/test_core.py': lines(900),
      'lib/a/a.py': lines(10), 'lib/a/tests/test_a.py': lines(120), 'lib/a/other/test_a.py': lines(5000),
      'lib/d/tests/test_d1.py': lines(50), 'lib/d/tests/test_d2.py': lines(50),
    });
    const out = await largestSlicesFirst(bare, fs);
    expect(ids(out.tasks)).toEqual(['r', 's1', 's3', 's4', 's2', 'close']);
    // A bare name beside the same file's full path is that file: nothing is looked up for it.
    expect(globs.filter((g) => g.includes('test_a.py'))).toEqual([]);
  });

  it(`lists nothing for a plan that would need more than ${MAX_SIZED_LISTINGS} listings, and sizes it by the paths its briefs name whole`, async () => {
    const many = renumberTasks([
      t('r', [], 'Make the package import.'),
      ...Array.from({ length: 4 }, (_, i) => t(`s${i + 1}`, ['r'],
        `Fill in lib/m${i + 1}/core.py. Verify: pytest lib/m${i + 1}/tests/test_whole.py and ${Array.from({ length: 60 }, (_, k) => `test_${i}_${k}.py`).join(' ')}`)),
      t('close', ['s1', 's2', 's3', 's4'], 'Run the suite.'),
    ]);
    const { fs, globs } = workspace({
      ...Object.fromEntries([1, 2, 3, 4].map((n) => [`lib/m${n}/tests/test_whole.py`, lines(10 * n)])),
      'lib/m1/tests/test_0_0.py': lines(9000),
    });
    expect(ids((await largestSlicesFirst(many, fs)).tasks)).toEqual(['r', 's4', 's3', 's2', 's1', 'close']);
    expect(globs).toEqual([]);
  });

  it('sizes nothing by a test directory whose listing was cut short, or through a file system with no glob', async () => {
    const dirs = renumberTasks([
      t('r', [], 'Make the package import.'),
      ...[1, 2, 3, 4].map((n) => t(`s${n}`, ['r'], n === 1 ? 'Verify: pytest big/tests/' : `Verify: pytest tests/test_m${n}.py`)),
      t('close', ['s1', 's2', 's3', 's4'], 'Run the suite.'),
    ]);
    const big = Object.fromEntries(Array.from({ length: MAX_SIZED_FILES + 2 }, (_, i) => [`big/tests/test_${i}.py`, lines(50)]));
    const { fs } = workspace({ ...big, 'tests/test_m2.py': lines(10), 'tests/test_m3.py': lines(30), 'tests/test_m4.py': lines(20) });
    expect(ids((await largestSlicesFirst(dirs, fs)).tasks)).toEqual(['r', 's3', 's4', 's2', 's1', 'close']);
    const { readFile } = workspace({ 'big/tests/test_0.py': lines(900), 'tests/test_m2.py': lines(10) }).fs;
    expect(ids((await largestSlicesFirst(dirs, { readFile })).tasks)).toEqual(['r', 's2', 's1', 's3', 's4', 'close']);
  });

  // A plan saved by a build that merged small slices (ADR-0072 R7) still holds merged tasks.
  it('sizes a merged task by what its slices\' briefs name, not by the lines around them', async () => {
    const merged = renumberTasks([
      t('r', [], 'Make the package import.'),
      ...[1, 2, 3].map((n) => t(`s${n}`, ['r'], `Fill in src/lib/m${n}.py. Verify: pytest tests/test_m${n}.py`)),
      t('s4', ['r'], [
        'This task covers 2 slices the planner wrote separately, each brief below whole and in order under its own title. Do every one of them in this task. Unlike tests/test_m1.py, it is merged.',
        'Slice 1 of 2: T s4\nFill in src/lib/m4.py. Verify: pytest tests/test_m4.py',
        'Slice 2 of 2: T s5\nFill in src/lib/m5.py. Verify: pytest tests/test_m5.py',
        'This task is done when every slice above meets its own brief\'s done criterion.',
        'Plan revision: unlike tests/test_m2.py, this note is Ordewell\'s.',
      ].join('\n\n'), { mergedSlices: ['s5'] }),
      t('close', ['s1', 's2', 's3', 's4'], 'Run the suite.'),
    ]);
    const { fs } = workspace({
      'tests/test_m1.py': lines(100), 'tests/test_m2.py': lines(90), 'tests/test_m3.py': lines(80),
      'tests/test_m4.py': lines(60), 'tests/test_m5.py': lines(50),
    });
    expect(ids((await largestSlicesFirst(merged, fs)).tasks)).toEqual(['r', 's4', 's1', 's2', 's3', 'close']);
  });

  it('counts a test file several briefs name in equal shares', async () => {
    const shared = renumberTasks([
      t('r', [], 'Make the package import.'),
      t('s1', ['r'], 'Fill in src/lib/graph.py. Verify: pytest tests/test_core.py'),
      t('s2', ['r'], 'Fill in src/lib/node.py. Verify: pytest tests/test_core.py'),
      t('s3', ['r'], 'Fill in src/lib/m3.py. Verify: pytest tests/test_m3.py'),
      t('s4', ['r'], 'Fill in src/lib/m4.py. Verify: pytest tests/test_m4.py'),
      t('close', ['s1', 's2', 's3', 's4'], 'Run the suite.'),
    ]);
    const { fs } = workspace({ 'tests/test_core.py': lines(600), 'tests/test_m3.py': lines(400), 'tests/test_m4.py': lines(250) });
    expect(ids((await largestSlicesFirst(shared, fs)).tasks)).toEqual(['r', 's3', 's1', 's2', 's4', 'close']);
  });

  it('reorders nothing when no file a slice names exists, or when the plan does not fan out', async () => {
    const before = plan();
    expect(await largestSlicesFirst(before, workspace({}).fs)).toEqual({ tasks: before, moved: 0 });
    const narrow = renumberTasks([t('a', [], 'Fill in src/a.py. Verify: pytest tests/test_a.py'), t('b', [], 'Fill in src/b.py. Verify: pytest tests/test_b.py')]);
    const { fs, reads } = workspace({ 'tests/test_b.py': lines(100) });
    expect((await largestSlicesFirst(narrow, fs)).tasks).toBe(narrow);
    expect(reads).toEqual([]);
  });

  // A core task most slices wait for, listed after the slices beside it, would wait for a slot while they run.
  it('starts a task the slices wait for ahead of the slices of its level, sized or not', async () => {
    const beside = renumberTasks([
      ...[1, 2, 3, 4, 5].map((n) => t(`x${n}`, [], `Fill in src/x${n}.py. Verify: pytest tests/test_x${n}.py`)),
      t('core', [], 'Fill in src/core.py.'),
      ...[1, 2, 3, 4, 5, 6].map((n) => t(`s${n}`, ['core'], `Fill in src/s${n}.py.`)),
      t('close', ['x1', 'x2', 'x3', 'x4', 'x5', 's1', 's2', 's3', 's4', 's5', 's6'], 'Run the suite.'),
    ]);
    const unsized = await largestSlicesFirst(beside, workspace({}).fs);
    expect(ids(unsized.tasks).slice(0, 6)).toEqual(['core', 'x1', 'x2', 'x3', 'x4', 'x5']);
    expect(unsized).toMatchObject({ moved: 5, gatesFirst: 1 });
    expect(unsized.measure).toBeUndefined();
    expect(unsized.tasks.map((x) => x.order)).toEqual(beside.map((x) => x.order));
    const sized = await largestSlicesFirst(beside, workspace({ 'tests/test_x4.py': lines(50) }).fs);
    expect(ids(sized.tasks).slice(0, 6)).toEqual(['core', 'x4', 'x1', 'x2', 'x3', 'x5']);
    expect(sized.measure).toBe('test');
  });

  it('reorders slices only among those of their own level, and leaves every other task where it was', async () => {
    const levels = renumberTasks([
      t('r', [], 'Make the package import.'),
      ...[1, 2, 3, 4].map((n) => t(`a${n}`, ['r'], `Fill in src/a${n}.py. Verify: pytest tests/test_a${n}.py`)),
      t('install', ['r'], 'Install the build tools.', { ops: true }),
      ...[1, 2, 3, 4].map((n) => t(`b${n}`, [`a${n}`], `Fill in src/b${n}.py. Verify: pytest tests/test_b${n}.py`)),
      t('close', ['b1', 'b2', 'b3', 'b4'], 'Run the suite.'),
    ]);
    const { fs } = workspace({
      'tests/test_a1.py': lines(10), 'tests/test_a2.py': lines(20), 'tests/test_a3.py': lines(30), 'tests/test_a4.py': lines(40),
      'tests/test_b1.py': lines(5), 'tests/test_b2.py': lines(900), 'tests/test_b3.py': lines(5), 'tests/test_b4.py': lines(1),
    });
    const out = await largestSlicesFirst(levels, fs);
    expect(ids(out.tasks)).toEqual(['r', 'a4', 'a3', 'a2', 'a1', 'install', 'b2', 'b1', 'b3', 'b4', 'close']);
    expect(out.tasks.map((x) => x.order)).toEqual(levels.map((x) => x.order));
    expect(out.tasks.map((x) => x.dependencies)).toEqual(ids(out.tasks).map((id) => levels.find((x) => x.id === id)!.dependencies));
  });

  describe('reads within bounds', () => {
    it('skips a file too large to read whole, by its bytes or its lines, as if it did not exist', async () => {
      const { fs } = workspace({
        'tests/test_m1.py': `${'x'.repeat(600 * 1024)}\n`, 'tests/test_m2.py': lines(30_000),
        'tests/test_m3.py': lines(40), 'tests/test_m4.py': lines(50), 'tests/test_m5.py': lines(60),
      });
      expect(ids((await largestSlicesFirst(plan(), fs)).tasks)).toEqual(['r', 's5', 's4', 's3', 's1', 's2', 'close']);
    });

    it('reads no path that climbs out of the workspace, which would ask the user to approve the read', async () => {
      const climbing = plan().map((x) => (x.id === 's1' ? { ...x, prompt: 'Fill in ../other/m1.py. Verify: pytest ../other/tests/test_m1.py' } : x));
      const { fs, reads } = workspace({ 'tests/test_m2.py': lines(10) });
      await largestSlicesFirst(climbing, fs);
      expect(reads.filter((p) => p.includes('..'))).toEqual([]);
    });

    it('reads no path that resolves out of the workspace by a leading run of dots, as `...tests/x.py` does', async () => {
      // `path.relative` gives such a path back starting `..`, which the workspace check reads as outside.
      const dotted = plan().map((x) => (x.id === 's1' ? { ...x, prompt: 'Verify: ...tests/test_m1.py and ./.../tests/test_m1.py' } : x.id === 's4' ? { ...x, prompt: 'Fill in .../tests/test_m4.py' } : x));
      const { fs, reads } = workspace({ 'tests/test_m2.py': lines(10) });
      await largestSlicesFirst(dotted, fs);
      expect(reads.filter((p) => p.includes('..'))).toEqual([]);
    });

    it('sizes nothing by a read that throws, and keeps the plan', async () => {
      const before = plan();
      const fs = fakeFileSystem({ readFile: async () => { throw new Error('EACCES'); } });
      expect(await largestSlicesFirst(before, fs)).toEqual({ tasks: before, moved: 0 });
    });

    it(`reads at most ${MAX_SIZED_FILES} files a plan, and reorders nothing it could not size whole`, async () => {
      const files = (n: number) => Array.from({ length: 26 }, (_, i) => `tests/test_s${n}_${i}.py`);
      const many = renumberTasks([
        t('r', [], 'Make the package import.'),
        ...Array.from({ length: 40 }, (_, i) => t(`s${i + 1}`, ['r'], `Verify: pytest ${files(i + 1).join(' ')}`)),
      ]);
      const { fs, reads } = workspace(Object.fromEntries(many.flatMap((x, i) => files(i).map((p) => [p, lines(i + 1)]))));
      const out = await largestSlicesFirst(many, fs);
      expect(reads.length).toBeLessThanOrEqual(MAX_SIZED_FILES);
      expect(out).toEqual({ tasks: many, moved: 0 });
    });
  });
});
