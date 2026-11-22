import { describe, expect, it, vi } from 'vitest';
import { closingNote, fanOutShape, shapeFanOut, unnamedTests, UNNAMED_BUDGET_MS, UNNAMED_MAX, withShapeNotes } from '../PlanFanOut';
import { createTask, type Task } from '../../models/Task';
import { fakeFileSystem } from '../../testing';
import { lines, workspace } from './planFanOutKit';

// The closing check is told of the tests no brief names anything of (#474 R4).
const t = (id: string, deps: string[], prompt: string): Task =>
  createTask({ id, title: `T ${id}`, dependencies: deps, prompt, assignedRunner: 'claude-code', autonomy: 'AFK', sliceType: 'AFK' });

/** An opening task, four slices that name their modules, and a closing check. */
const plan = (closing = true) => [
  t('open', [], 'Make pkg import.'),
  t('a', ['open'], 'Fill in pkg/a.py.'),
  t('b', ['open'], 'Fill in pkg/b.py; its tests are pkg/tests/test_b.py.'),
  t('c', ['open'], 'Fill in pkg/flow/c.py.'),
  t('d', ['open'], 'Fill in the pkg.linalg package.'),
  ...(closing ? [t('close', ['a', 'b', 'c', 'd'], 'Run the whole test suite and fix what fails.')] : []),
];

const files = {
  'pkg/a.py': lines(10), 'pkg/tests/test_a.py': lines(10), 'pkg/tests/test_b.py': lines(10),
  'pkg/flow/c.py': lines(10), 'pkg/flow/tests/test_c.py': lines(10),
  'pkg/linalg/tests/test_lin.py': lines(10),
  'pkg/minors/tests/test_contract.py': lines(10), 'pkg/minors/tests/test_minors.py': lines(10),
  'pkg/link/tests/test_rank.py': lines(10),
  'pkg/tests/conftest.py': lines(3),
};

describe('unnamedTests', () => {
  it('lists the test directories whose package no brief names, largest first', async () => {
    const { fs } = workspace(files);
    expect(await unnamedTests(plan(), fs)).toEqual([{ dir: 'pkg/minors/tests', files: 2 }, { dir: 'pkg/link/tests', files: 1 }]);
  });

  it('reads a flat suite by the name it tests, and a sweep\'s directory as its own package only', async () => {
    const { fs } = workspace({ 'tests/test_rdata.py': lines(5), 'tests/test_zone.py': lines(5), 'dns/rdata.py': lines(5),
      'dns/tests/test_x.py': lines(5), 'dns/sub/tests/test_y.py': lines(5), 'lib/deep/tests/test_z.py': lines(5) });
    const tasks = [t('w', [], 'Fill in dns/rdata.py, and any module under dns/ no other task names. Then lib/** as well.')];
    expect(await unnamedTests(tasks, fs)).toEqual([{ dir: 'dns/sub/tests', files: 1 }, { dir: 'tests', files: 1 }]);
  });

  it('reads a brief before its appended notes, whose tables name other tasks\' paths', async () => {
    const { fs } = workspace(files);
    const noted = withShapeNotes(plan());
    expect(await unnamedTests(noted, fs)).toEqual(await unnamedTests(plan(), fs));
  });

  it('names nothing from outside the workspace, and reads no file', async () => {
    const rows = ['../other/tests/test_a.py', '/etc/tests/test_b.py', 'C:/x/tests/test_c.py', 'ok/tests/test_d.py'].join('\n');
    const reads: string[] = [];
    const fs = fakeFileSystem({
      glob: async (pattern) => ({ success: true, output: pattern === '**/test_*' ? rows : 'No files matched.', truncated: false }),
      readFile: async (p) => { reads.push(p); return { success: false, output: 'no', truncated: false }; },
    });
    expect(await unnamedTests([t('a', [], 'Fill in pkg/a.py.')], fs)).toEqual([{ dir: 'ok/tests', files: 1 }]);
    expect(reads).toEqual([]);
  });

  it('does not take a word of prose for a file or a module', async () => {
    const { fs } = workspace({ 'tests/test_flow.py': lines(5), 'tests/test_rdata.py': lines(5) });
    const tasks = [t('w', [], 'Keep the flow of control simple; write dns/rdata.py.')];
    expect(await unnamedTests(tasks, fs)).toEqual([{ dir: 'tests', files: 1 }]);
  });

  it('lists nothing once the listings have taken longer than UNNAMED_BUDGET_MS', async () => {
    const { fs } = workspace(files);
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const slow = { ...fs, glob: async (...a: Parameters<NonNullable<typeof fs.glob>>) => { now += UNNAMED_BUDGET_MS / 3; return fs.glob(...a); } };
      expect(await unnamedTests(plan(), slow)).toBeUndefined();
      expect(await unnamedTests(plan(), fs)).toBeDefined();
    } finally { clock.mockRestore(); }
  });

  it('lists nothing when a listing is cut short or the file system has no glob', async () => {
    const many = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`pkg/m${i}/tests/test_m${i}.py`, lines(1)]));
    expect(await unnamedTests(plan(), workspace(many).fs)).toBeUndefined();
    expect(await unnamedTests(plan(), { readFile: workspace(files).fs.readFile })).toBeUndefined();
  });
});

describe('the closing check\'s note', () => {
  it('keeps its words with nothing unnamed, and adds one sentence when there is', () => {
    const shape = fanOutShape(plan());
    expect(closingNote(shape, [])).toBe(closingNote(shape));
    expect(closingNote(shape, [{ dir: 'pkg/minors/tests', files: 2 }, { dir: 'pkg/link/tests', files: 1 }])).toBe(`${closingNote(shape)} No task's brief names these tests, nor any path in the package they test, so that code is yours too: write it once the slices' work is in, and run them with the rest: pkg/minors/tests (2 test files), pkg/link/tests (1 test file).`);
  });

  it('cuts its list at UNNAMED_MAX, saying how many more', () => {
    const shape = fanOutShape(plan());
    const many = Array.from({ length: 40 }, (_, i) => ({ dir: `pkg/algorithms/module_${i}/tests`, files: 1 }));
    const added = closingNote(shape, many).slice(closingNote(shape).length + 1);
    expect(added.length).toBeLessThanOrEqual(UNNAMED_MAX);
    expect(added).toMatch(/, and \d+ more directories, which a run of the whole suite shows\.$/);
  });
});

describe('shapeFanOut', () => {
  it('gives the closing check the tests no brief names, and logs them', async () => {
    const { fs } = workspace(files);
    const { tasks, log } = await shapeFanOut(plan(), fs);
    expect(tasks.find((x) => x.id === 'close')!.prompt).toContain('pkg/minors/tests (2 test files), pkg/link/tests (1 test file).');
    for (const x of tasks.filter((y) => y.id !== 'close')) expect(x.prompt).not.toContain('No task\'s brief names these tests');
    expect(log).toContain('coverage: 3 test files in 2 directories no brief names, given to the closing check');
  });

  it('lists nothing for a plan whose closing check is noted already', async () => {
    const { fs, globs } = workspace(files);
    const noted = withShapeNotes(plan());
    const { tasks } = await shapeFanOut(noted, fs);
    expect(tasks.find((x) => x.id === 'close')!.prompt).toBe(noted.find((x) => x.id === 'close')!.prompt);
    expect(globs.filter((g) => g.startsWith('. '))).toEqual([]);
  });

  it('lists nothing for a plan with no closing check, nor for one that does not fan out', async () => {
    const { fs, globs } = workspace(files);
    const { log } = await shapeFanOut(plan(false), fs);
    expect(log.some((l) => l.startsWith('coverage:'))).toBe(false);
    const serial = [t('a', [], 'Fill in pkg/a.py.'), t('b', ['a'], 'Fill in pkg/b.py.')];
    expect((await shapeFanOut(serial, fs)).tasks).toBe(serial);
    expect(globs.filter((g) => g.startsWith('. '))).toEqual([]);
  });
});
