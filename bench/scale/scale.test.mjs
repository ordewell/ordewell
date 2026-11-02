import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
