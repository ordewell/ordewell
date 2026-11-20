import { describe, expect, it } from 'vitest';
import { largestSlicesFirst, MAX_SIZED_FILES } from '../PlanFanOut';
import { createTask, renumberTasks, type Task } from '../../models/Task';
import type { ReadFileOpts, ToolOutcome } from '../../interfaces/IFileSystem';
import { fakeFileSystem } from '../../testing';

const t = (id: string, deps: string[], prompt: string, extra: Partial<Task> = {}): Task =>
  createTask({ id, title: `T ${id}`, dependencies: deps, prompt, assignedRunner: 'claude-code', autonomy: 'AFK', sliceType: 'AFK', ...extra });
const ids = (ts: readonly Task[]) => ts.map((x) => x.id);
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

/** A workspace whose reads answer as the planner's file systems do: numbered lines, a size cap in KB, a line limit. */
function workspace(files: Record<string, string>) {
  const reads: string[] = [];
  const fs = fakeFileSystem({
    readFile: async (p: string, opts?: ReadFileOpts): Promise<ToolOutcome> => {
      reads.push(p);
      const content = files[p];
      if (content === undefined) return { success: false, output: `Error reading ${p}: ENOENT`, truncated: false };
      if (Buffer.byteLength(content) > (opts?.maxBytes ?? 1024) * 1024) return { success: true, output: 'File too large (2.0 MB). Maximum is 1024 KB.', truncated: false };
      const all = content.split('\n');
      if (all[all.length - 1] === '') all.pop();
      const limit = opts?.limit ?? 2000;
      const shown = all.slice(0, limit).map((l, i) => `${String(i + 1).padStart(String(all.length).length)}|${l}`).join('\n');
      return limit < all.length
        ? { success: true, output: `${shown}\n\n(File has more lines — use offset=${limit} to read beyond line ${limit})\n`, truncated: true }
        : { success: true, output: shown, truncated: false };
    },
  });
  return { fs, reads };
}

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

    it('sizes nothing by a read that throws, and keeps the plan', async () => {
      const before = plan();
      const fs = fakeFileSystem({ readFile: async () => { throw new Error('EACCES'); } });
      expect(await largestSlicesFirst(before, fs)).toEqual({ tasks: before, moved: 0 });
    });

    it(`reads at most ${MAX_SIZED_FILES} files a plan, and reorders nothing it could not size whole`, async () => {
      const files = (n: number) => Array.from({ length: 6 }, (_, i) => `tests/test_s${n}_${i}.py`);
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
