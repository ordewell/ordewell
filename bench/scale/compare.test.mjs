import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRuns, describeComparison, medianOf, parseOpsTable, unfinished } from './compare.mjs';

const OPS = `# ops: shape=dag
[Saves n=100: 0.1s, load 1 1 1]

## all operations (shape=dag)
| operation | n=100 | n=1000 | order |
| --- | --- | --- | --- |
| saveSession, half done (ms) | 1.50 | 12.00 | n^0.90 |
| saved file, half done (bytes) | 127.1 KB | 2.00 MB | n^1.00 |
|   getMergeGate, every task (ms) | 0.5600 | - | - |
| digest (bytes) | 189 B | 189 B | n^0.00 |
`;

const run = (over = {}) => ({
  target: { sessions: 30, tasks: 2000, rate: 200, events: 8, budget: 400, sizes: [100, 1000] },
  commit: 'aaaa',
  host: { platform: 'darwin', arch: 'arm64', cpus: 10, node: 'v26.10.0' },
  live: { wallS: 100, peakRssMb: 400, saves: { mb: 900 }, status: { jsonMb: 60 } },
  ops: { 'saved file, half done (bytes)': { 100: 1000, 1000: 10000 } },
  ...over,
});

test('reads every size of the ops table, its units undone and a size it skipped left out', () => {
  assert.deepEqual(parseOpsTable(OPS), {
    'saveSession, half done (ms)': { 100: 1.5, 1000: 12 },
    'saved file, half done (bytes)': { 100: 130150.4, 1000: 2097152 },
    'getMergeGate, every task (ms)': { 100: 0.56 },
    'digest (bytes)': { 100: 189, 1000: 189 },
  });
});

test('takes the median of each number across repeats, keeping one bad run from setting the result', () => {
  const median = medianOf([
    { wallS: 10, saves: { mb: 5 }, label: 'x' },
    { wallS: 90, saves: { mb: 6 }, label: 'y' },
    { wallS: 12, saves: { mb: 7 }, label: 'z' },
  ]);
  assert.deepEqual(median, { wallS: 12, saves: { mb: 6 }, label: 'x' });
});

test('names a repeat that left tasks unfinished or a call failed: its numbers describe a shorter run', () => {
  assert.deepEqual(unfinished({ tasks: 2000 }, [{ finished: 2000, mcp: { failures: 0 } }]), []);
  assert.deepEqual(unfinished({ tasks: 2000 }, [{ finished: 1500, mcp: { failures: 0 } }, { finished: 2000, mcp: { failures: 3 } }]), [
    'repeat 1 finished 1500 of 2000 tasks',
    'repeat 2 had 3 failed MCP calls',
  ]);
});

test('compares a figure both runs hold, as a ratio of after to before', () => {
  const before = run();
  const after = run({ commit: 'bbbb', live: { wallS: 50, peakRssMb: 400, saves: { mb: 90 }, status: { jsonMb: 60 } }, ops: { 'saved file, half done (bytes)': { 100: 1000, 1000: 5000 } } });
  const { rows, warnings } = compareRuns(before, after);
  assert.deepEqual(warnings, []);
  assert.deepEqual(rows.find((row) => row.name === 'live: wallS'), { name: 'live: wallS', before: 100, after: 50, ratio: 0.5 });
  assert.deepEqual(rows.find((row) => row.name === 'live: saves.mb'), { name: 'live: saves.mb', before: 900, after: 90, ratio: 0.1 });
  assert.deepEqual(rows.find((row) => row.name === 'ops n=1000: saved file, half done (bytes)'), { name: 'ops n=1000: saved file, half done (bytes)', before: 10000, after: 5000, ratio: 0.5 });
});

test('says so when a figure is held by one run only, rather than reading it as unchanged', () => {
  const after = run({ live: { wallS: 100, peakRssMb: 400, saves: { mb: 900 }, status: { jsonMb: 60 }, added: 7 } });
  const { rows } = compareRuns(run(), after);
  assert.deepEqual(rows.find((row) => row.name === 'live: added'), { name: 'live: added', before: null, after: 7, ratio: null });
});

test('warns of a run on another machine, or of another target, rather than comparing silently', () => {
  const other = run({ host: { platform: 'linux', arch: 'x64', cpus: 4, node: 'v22.0.0' }, target: { sessions: 10, tasks: 2000, rate: 200, events: 8, budget: 400, sizes: [100, 1000] } });
  const { warnings } = compareRuns(run(), other);
  assert.equal(warnings.length, 2);
  assert.match(warnings.join('\n'), /target/);
  assert.match(warnings.join('\n'), /machine/);
});

test('warns when either side did not finish, and carries that into the text', () => {
  const short = run({ problems: ['repeat 1 finished 1500 of 2000 tasks'] });
  const compared = compareRuns(run(), short);
  assert.match(compared.warnings.join('\n'), /finished 1500/);
  assert.match(describeComparison(compared).join('\n'), /finished 1500/);
});

test('reads as a table of figures with no verdict of its own', () => {
  const text = describeComparison(compareRuns(run(), run({ commit: 'bbbb' }))).join('\n');
  assert.match(text, /live: wallS \| 100 \| 100 \| 1\.00/);
  assert.doesNotMatch(text, /pass|fail/i);
});
