import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const driver = path.join(path.dirname(fileURLToPath(import.meta.url)), 'drive-pipeline.mjs');

// Past the driver's own 60 s wait for the run, so a stall reaches its report
// rather than this kill. On a kill execFile drops the driver's pipes, so a
// fake that inherited them and outlives the driver cannot hold the case open.
const CASE_MS = 90000;

function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [driver, ...args], { timeout: CASE_MS }, (err, out, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : err.signal ?? 1) : 0;
      resolve({ code, stdout: out, stderr });
    });
  });
}

// A backstop, should the case's promise never settle for a reason of its own.
const options = { timeout: CASE_MS + 10000 };

test('plan runs end to end through the fake claude and task_complete', options, async () => {
  const { code, stdout, stderr } = await run(['--runner', 'fake']);
  assert.equal(code, 0, `${stdout}\n${stderr}`);
});

test('plan runs end to end through the fake ACP agent and task_complete', options, async () => {
  const { code, stdout, stderr } = await run(['--runner', 'acp']);
  assert.equal(code, 0, `${stdout}\n${stderr}`);
  assert.match(stdout, /ALL TESTS PASSED/);
});

test('an ACP task that ends without task_complete does not pass', options, async () => {
  const { code, stdout, stderr } = await run(['--runner', 'acp', '--case', 'no-completion']);
  assert.equal(code, 0, `${stdout}\n${stderr}`);
  assert.match(stdout, /EXPECTED FAILURE OBSERVED/);
});
