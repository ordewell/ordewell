import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const driver = path.join(path.dirname(fileURLToPath(import.meta.url)), 'drive-pipeline.mjs');

function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [driver, ...args], { timeout: 60000 }, (err, out, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: out, stderr });
    });
  });
}

test('plan runs end to end through the fake claude and task_complete', async () => {
  const { code, stdout } = await run(['--runner', 'fake']);
  assert.equal(code, 0, stdout);
});

test('plan runs end to end through the fake ACP agent and task_complete', async () => {
  const { code, stdout } = await run(['--runner', 'acp']);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /ALL TESTS PASSED/);
});

test('an ACP task that ends without task_complete does not pass', async () => {
  const { code, stdout } = await run(['--runner', 'acp', '--case', 'no-completion']);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /EXPECTED FAILURE OBSERVED/);
});
