import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The terminal UI's reducer and renderer are bundled from packages/cli, so a
// change to either breaks tui.mjs with no type error to say so: nothing else runs it.
const here = dirname(fileURLToPath(import.meta.url));

function run(script, ...args) {
  // CI's bench steps preload a reporter through NODE_OPTIONS; the child needs none.
  const done = spawnSync(process.execPath, [join(here, script), ...args], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(done.status, 0, done.stderr);
  return done.stdout;
}

test.before(() => run('build-tui.mjs'));

test('tui.mjs prints every figure at a tiny size, sweeping settled tasks and entries, and writes its JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ordewell-tui-'));
  try {
    const file = join(dir, 'tui.json');
    const out = run('tui.mjs', '--tasks', '12', '--settled', '9', '--entries', '12', '--minutes', '0.1', '--sweep-minutes', '0.1', '--keys', '4', '--profile', '--out', file);
    for (const row of [
      'load: chatRestored', 'load: planRefreshed', 'load: runSnapshot action', 'load: run_snapshot frame', 'load: whole-plan frame', 'heap after load',
      'frame wide, ms \\(median\\)', 'frame narrow \\(stacked\\)', 'key scrolling the plan', 'key scrolling the chat',
      'stream: frames a second', 'stream: event-loop ms a second', 'stream: heap slope',
      'status_update', 'planner_thinking_delta', 'task_log', 'per \\+100 settled tasks', 'per \\+100 tasks', 'Self time in a frame',
    ]) assert.match(out, new RegExp(row), `no row for ${row}`);
    assert.doesNotMatch(out, /\b(NaN|undefined|Infinity)\b/);

    const result = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(result.runs.map((r) => [r.tasks, r.settled, r.entries]), [[12, 0, 12], [12, 3, 12], [12, 9, 12], [12, 9, 0], [4, 3, 12]]);
    for (const r of result.runs) {
      assert.ok(r.stream.frames > 0, 'the stream paints');
      assert.ok(r.render.wideRows === 50 && r.render.narrowRows === 40, 'a frame is one row per terminal row');
      assert.ok(r.load.heapMb > 0);
    }
    assert.ok(result.profile.frame.length > 0 && result.profile.statusFold.length > 0 && result.profile.planScrollReduce.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tui.mjs builds its feed from a saved session file without printing it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ordewell-tui-'));
  try {
    const file = join(dir, 'session.json');
    const secret = 'SECRET-GOAL-TEXT';
    const tasks = Array.from({ length: 6 }, (_, i) => ({
      id: `t${i + 1}`, order: i + 1, title: `${secret} task ${i + 1}`, description: 'd', type: 'ai', status: i < 4 ? 'completed' : i === 4 ? 'in_progress' : 'pending',
      dependencies: [], assignedRunner: 'claude-code', assignedModel: null, taskMode: 'build', prompt: 'p', subtasks: [],
    }));
    const plan = {
      tasks, runners: ['claude-code'], generatedAt: new Date().toISOString(), status: 'approved',
      conversationHistory: [
        { role: 'user', content: `${secret} please`, timestamp: '2026-01-01T00:00:00.000Z' },
        { role: 'assistant', content: 'Done.', timestamp: '2026-01-01T00:00:05.000Z' },
      ],
    };
    writeFileSync(file, JSON.stringify({ meta: { id: 'session-x', goal: secret }, plan }));
    const out = run('tui.mjs', '--session', file, '--minutes', '0.1', '--keys', '3');
    assert.match(out, /## Terminal UI: 6 tasks/);
    assert.doesNotMatch(out, new RegExp(secret));
    assert.doesNotMatch(out, /\b(NaN|undefined|Infinity)\b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
