import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// These harnesses reach into core's internals, so a change there breaks them
// with no type error to say so: nothing else runs them.
const here = dirname(fileURLToPath(import.meta.url));

function run(script, ...args) {
  const done = spawnSync(process.execPath, [join(here, script), ...args], { encoding: 'utf8', env: { ...process.env, ORDEWELL_DIRENV: 'false' } });
  assert.equal(done.status, 0, done.stderr);
  return done.stdout;
}

test.before(() => run('build.mjs'));

test('ops.mjs runs every section at a small plan', () => {
  const out = run('ops.mjs', '--sizes', '20', '--slots', '10');
  for (const row of ['tick', 'a row for every task', 'saveSession', 'statusMessage', '100 failures in one window', 'open, spend and close every child', 'composeAugmentedPrompt']) {
    assert.match(out, new RegExp(`\\| *${row}`), `no row for ${row}`);
  }
  assert.doesNotMatch(out, /\b(NaN|undefined)\b/);
});

test('live.mjs finishes every task of a small lifetime through the whole pipeline', () => {
  const result = JSON.parse(run('live.mjs', '--sessions', '3', '--tasks', '6', '--rate', '200', '--events', '2', '--budget', '400').trim().split('\n').at(-1));
  assert.equal(result.finished, 6);
  assert.equal(result.mcp.failures, 0);
  assert.ok(result.saves.count >= 6, 'each settlement is saved');
});

test('target.mjs records a small run and compares it with itself, every ratio one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ordewell-target-'));
  try {
    const file = join(dir, 'run.json');
    run('target.mjs', '--sessions', '3', '--tasks', '6', '--events', '2', '--sizes', '20', '--repeats', '1', '--out', file);
    const result = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(result.problems, []);
    assert.equal(result.live.finished, 6);
    assert.ok(result.ops['saved file, half done (bytes)']['20'] > 0);
    assert.ok(result.commit, 'a run says what it measured');
    const compared = run('target.mjs', '--compare', file, file);
    assert.match(compared, /live: finished \| 6 \| 6 \| 1\.00/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('target.mjs keeps a long run when ops.mjs breaks, and names the break as a problem', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ordewell-target-'));
  try {
    const scale = join(dir, 'bench/scale');
    mkdirSync(scale, { recursive: true });
    writeFileSync(join(scale, 'build.mjs'), '');
    writeFileSync(join(scale, 'live.mjs'), 'console.log(JSON.stringify({ finished: 6, wallS: 9, mcp: { failures: 0 } }));');
    writeFileSync(join(scale, 'ops.mjs'), "console.error('TypeError: this.host.startWaits is not a function'); process.exit(1);");
    const file = join(dir, 'run.json');
    const done = spawnSync(process.execPath, [join(here, 'target.mjs'), '--checkout', dir, '--tasks', '6', '--repeats', '1', '--out', file], { encoding: 'utf8' });
    assert.equal(done.status, 1);
    const result = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(result.live.wallS, 9);
    assert.deepEqual(result.ops, {});
    assert.match(result.problems.join('\n'), /ops\.mjs[\s\S]*startWaits is not a function/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('target.mjs refuses a checkout with nothing to measure, rather than reporting an empty run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ordewell-target-'));
  try {
    const done = spawnSync(process.execPath, [join(here, 'target.mjs'), '--checkout', join(dir, 'no-such-checkout'), '--repeats', '1'], { encoding: 'utf8' });
    assert.notEqual(done.status, 0);
    assert.match(done.stderr, /no-such-checkout/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const TINY = ['--tasks', '12', '--settled', '6', '--turns', '9', '--live', '2', '--events', '4', '--rate', '50', '--mutations', '4', '--planner-turns', '1', '--log-kb', '2'];

test('long.mjs runs its grid small through the pool, every figure a number and every row a slope', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ordewell-long-'));
  try {
    const file = join(dir, 'long.json');
    const out = run('long.mjs', ...TINY, '--out', file);
    for (const row of ['heap.heldMb', 'status.msP50', 'saves.perMin', 'mutations.broadcastKbP50', 'lag.p99', 'load.openMs', 'wire.types.plan_generated.kb']) {
      assert.match(out, new RegExp(`^\\| ${row.replace(/\./g, '\\.')} \\|`, 'm'), `no row for ${row}`);
    }
    assert.doesNotMatch(out, /\b(NaN|undefined)\b/);
    const result = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(result.problems, []);
    assert.deepEqual(Object.keys(result.long), ['settled=0 turns=9', 'settled=2 turns=9', 'settled=6 turns=9', 'settled=6 turns=0', 'slope']);
    assert.equal(result.long['settled=6 turns=9'].mutations.count, 4);
    assert.ok(result.long['settled=6 turns=9'].wire.types.plan_generated.frames > 0, 'a mutation sends the plan to the client');
    assert.equal(typeof result.long.slope.perHundredSettled['heap.heldMb'], 'number');
    assert.match(run('long.mjs', '--compare', file, file), /long settled=6 turns=9: heap\.heldMb \| [\d.]+ \| [\d.]+ \| 1\.00/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('long.mjs takes its sizes from a saved session without writing there or saying a word of it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ordewell-long-from-'));
  try {
    const secret = 'NEVER-PRINT-THIS-PROMPT';
    const task = (i, status) => ({ id: `task-${i}`, order: i, title: secret, description: secret, type: 'ai', status, dependencies: [], subtasks: [], prompt: `${secret} `.repeat(40), assignedRunner: 'claude-code', ...(status === 'completed' ? { handoff: { summary: secret.repeat(10), findings: [], findingCount: 0 }, attemptUsage: [{ attempt: 1 }] } : {}) });
    const plan = { tasks: [task(1, 'completed'), task(2, 'completed'), task(3, 'pending'), task(4, 'pending')], conversationHistory: [{ role: 'user', content: secret, timestamp: '2026-01-01T00:00:00Z' }, { role: 'assistant', content: secret.repeat(5), timestamp: '2026-01-01T00:00:00Z' }], status: 'running', runners: ['claude-code'], generatedAt: '2026-01-01T00:00:00Z', lastUpdated: '2026-01-01T00:00:00Z' };
    writeFileSync(join(dir, 'goal_abcdef12.json'), JSON.stringify({ meta: { id: 'session-abcdef12', goal: secret, runners: ['claude-code'], taskCount: 4, status: 'running', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }, plan }));
    const before = readdirSync(dir).map((name) => [name, statSync(join(dir, name)).mtimeMs]);
    const out = run('long.mjs', '--point', '--from', dir, '--live', '1', '--events', '4', '--rate', '50', '--mutations', '2', '--planner-turns', '1', '--log-kb', '2');
    const result = JSON.parse(out.trim().split('\n').at(-1));
    assert.deepEqual({ tasks: result.sizes.tasks, settled: result.sizes.settled, turns: result.sizes.turns }, { tasks: 4, settled: 2, turns: 1 });
    assert.deepEqual(result.problems, []);
    assert.doesNotMatch(out, new RegExp(secret));
    assert.deepEqual(readdirSync(dir).map((name) => [name, statSync(join(dir, name)).mtimeMs]), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
