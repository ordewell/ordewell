import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT } from '../lib/data-dir.mjs';

const script = path.join(import.meta.dirname, 'drive-conversation.mjs');

// A real run needs a key, but the data directory is judged before any model is
// called, so a refused run never reaches the network and needs no built core.
const realRun = (extra, env) =>
  spawnSync(process.execPath, [script, '--real', '--model', 'x', ...extra], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '', OPENROUTER_API_KEY: 'dummy', ...env },
  });

describe('where a real conversation run keeps its report', () => {
  it('refuses a bench directory, --out or --dump inside the repository, creating nothing', (t) => {
    const inRepo = path.join(REPO_ROOT, 'bench', 'live', '.refused-by-test');
    t.after(() => fs.rmSync(inRepo, { recursive: true, force: true }));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-conversation-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

    for (const [extra, env] of [
      [[], { ORDEWELL_BENCH_DIR: inRepo }],
      [['--out', inRepo], { ORDEWELL_BENCH_DIR: outside }],
      [['--dump', inRepo], { ORDEWELL_BENCH_DIR: outside }],
    ]) {
      const run = realRun(extra, env);
      assert.notEqual(run.status, 0, extra.join(' '));
      assert.match(run.stderr, /ORDEWELL_BENCH_DIR/);
      assert.equal(fs.existsSync(inRepo), false);
    }
  });
});
