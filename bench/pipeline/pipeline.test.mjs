import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const driver = path.join(path.dirname(fileURLToPath(import.meta.url)), 'drive-pipeline.mjs');

test('plan runs end to end through the fake claude and task_complete', async () => {
  const { code, stdout } = await new Promise((resolve) => {
    execFile(process.execPath, [driver, '--runner', 'fake'], (err, out) => resolve({ code: err ? err.code : 0, stdout: out }));
  });
  assert.equal(code, 0, stdout);
});
