import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(resolve(dirname(fileURLToPath(import.meta.url))), 'linux-sandbox-e2e.sh');

// A PATH of nothing but recording stubs, so any install or policy change the
// script attempts shows up as a call, and none reaches this host.
function run(env, { bwrapStatus = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ordewell-sandbox-script-'));
  const stub = (name, status) => {
    writeFileSync(join(dir, name), `#!/bin/sh\nprintf '%s\\n' "$@" > '${join(dir, `${name}.args`)}'\nexit ${status}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  for (const name of ['npm', 'sudo', 'apt-get', 'sysctl']) stub(name, 0);
  stub('bwrap', bwrapStatus);
  try {
    const result = spawnSync('/bin/bash', [SCRIPT, '--maxWorkers=2', '--minWorkers=1'], { encoding: 'utf8', env: { PATH: dir, ...env } });
    const recorded = (name) => (existsSync(join(dir, `${name}.args`)) ? readFileSync(join(dir, `${name}.args`), 'utf8').trim().split('\n') : undefined);
    const calls = Object.fromEntries(['npm', 'sudo', 'apt-get', 'sysctl', 'bwrap'].map((name) => [name, recorded(name)]));
    return { result, calls: (name) => calls[name] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the sandbox script test:changed runs (#71 F4)', { skip: process.platform === 'win32' && 'a bash script for the Linux backend, bubblewrap' }, () => {
  it('with its setup off, installs nothing and hands vitest its arguments', () => {
    const { result, calls } = run({ ORDEWELL_SANDBOX_SETUP: 'none' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls('sudo'), undefined, 'sudo ran');
    assert.equal(calls('apt-get'), undefined, 'apt-get ran');
    assert.deepEqual(calls('bwrap'), ['--ro-bind', '/', '/', 'true']);
    assert.deepEqual(calls('npm'), ['run', 'test:sandbox', '-w', 'packages/core', '--', '--maxWorkers=2', '--minWorkers=1']);
  });

  it('with its setup off, fails before the suite when bubblewrap cannot start', () => {
    const { result, calls } = run({ ORDEWELL_SANDBOX_SETUP: 'none' }, { bwrapStatus: 1 });
    assert.notEqual(result.status, 0);
    assert.equal(calls('npm'), undefined);
    assert.equal(calls('sudo'), undefined);
  });
});
