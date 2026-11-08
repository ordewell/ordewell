// ORDEWELL_REQUIRE_TOOLS: a run that names a tool turns the test that would
// skip without it into one that fails, so CI cannot pass by proving less.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { hostHas, pinnedShellcheck } from './host-tools.mjs';

const recorder = () => {
  const skips = [];
  return { skips, t: { skip: (why) => skips.push(why) } };
};

describe('hostHas', () => {
  it('says a missing tool is missing when the run does not require it', () => {
    assert.equal(hostHas('dash', { present: false, env: {} }), false);
    assert.equal(hostHas('dash', { present: false, env: { ORDEWELL_REQUIRE_TOOLS: 'shellcheck pwsh' } }), false);
  });

  it('fails on a missing tool the run requires, naming the flag and how to get it', () => {
    for (const list of ['dash', 'shellcheck dash', 'shellcheck,dash', ' pwsh ,dash ']) {
      assert.throws(
        () => hostHas('dash', { present: false, how: 'apt-get install dash', env: { ORDEWELL_REQUIRE_TOOLS: list } }),
        /dash is missing, and ORDEWELL_REQUIRE_TOOLS requires it: apt-get install dash/,
      );
    }
  });

  it('says a present tool is present, required or not', () => {
    assert.equal(hostHas('dash', { present: true, env: {} }), true);
    assert.equal(hostHas('dash', { present: true, env: { ORDEWELL_REQUIRE_TOOLS: 'dash' } }), true);
  });
});

describe('pinnedShellcheck', { skip: process.platform === 'win32' ? 'no shellcheck is pinned for Windows' : false }, () => {
  const nowhere = join('no', 'such', 'shellcheck');

  it('skips, naming the command that fetches it, when the pinned shellcheck is not there', () => {
    const { t, skips } = recorder();
    assert.equal(pinnedShellcheck(t, { ORDEWELL_SHELLCHECK: nowhere }), undefined);
    assert.equal(skips.length, 1);
    assert.match(skips[0], /node scripts\/shellcheck\.mjs/);
  });

  it('fails instead when the run requires shellcheck', () => {
    const { t, skips } = recorder();
    assert.throws(() => pinnedShellcheck(t, { ORDEWELL_SHELLCHECK: nowhere, ORDEWELL_REQUIRE_TOOLS: 'shellcheck' }), /node scripts\/shellcheck\.mjs/);
    assert.deepEqual(skips, []);
  });

  it('turns the installers\' lint test from a skip into a failure under the flag', () => {
    // NODE_OPTIONS cleared: CI's names spec and the annotation reporter, and this reads TAP.
    const run = (env) => spawnSync(process.execPath, ['--test', '--test-name-pattern=shellcheck', join('scripts', 'install', 'desktop.test.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_OPTIONS: '', ORDEWELL_SHELLCHECK: nowhere, ...env },
    });
    const skipped = run({ ORDEWELL_REQUIRE_TOOLS: '' });
    assert.equal(skipped.status, 0, skipped.stdout);
    assert.match(skipped.stdout, /# SKIP .*node scripts\/shellcheck\.mjs/);
    const required = run({ ORDEWELL_REQUIRE_TOOLS: 'shellcheck' });
    assert.notEqual(required.status, 0, required.stdout);
    assert.match(required.stdout, /ORDEWELL_REQUIRE_TOOLS requires it/);
  });
});
