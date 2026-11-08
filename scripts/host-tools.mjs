// What the bench tests need from the machine beyond Node: dash, pwsh, the
// pinned shellcheck. A test without its tool skips, which is right on a laptop
// and wrong in CI, where a skip reads as a pass. ORDEWELL_REQUIRE_TOOLS lists,
// space- or comma-separated, the tools a run means to prove with; one of them
// missing fails the test that needed it (the ORDEWELL_REQUIRE_SANDBOX pattern).
import { spawnSync } from 'node:child_process';

import { FETCH_COMMAND, PIN, resolveShellcheck } from './shellcheck.mjs';

export const REQUIRE_ENV = 'ORDEWELL_REQUIRE_TOOLS';

const required = (env) => new Set((env[REQUIRE_ENV] ?? '').split(/[\s,]+/).filter(Boolean));

export const onPath = (command) => spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;

// Whether `tool` is there to use. Missing and required, it throws instead, so
// the caller's test fails where it would have skipped.
export const hostHas = (tool, { present = onPath(tool), how, env = process.env } = {}) => {
  if (!present && required(env).has(tool)) {
    throw new Error(`${tool} is missing, and ${REQUIRE_ENV} requires it${how ? `: ${how}` : ''}`);
  }
  return present;
};

// The pinned shellcheck for test `t` to lint with, or undefined once `t` is
// skipped. Never the one on PATH: another version judges differently.
export const pinnedShellcheck = (t, env = process.env) => {
  if (process.platform === 'win32') {
    t.skip('no shellcheck is pinned for Windows: build-and-test lints on Linux');
    return undefined;
  }
  const path = resolveShellcheck(env);
  const how = `run ${FETCH_COMMAND}`;
  if (!hostHas('shellcheck', { present: path !== undefined, how, env })) {
    t.skip(`the pinned shellcheck ${PIN.version} is not fetched: ${how}`);
  }
  return path;
};
