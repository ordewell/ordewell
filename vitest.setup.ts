import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, vi } from 'vitest';
import { homeEnv, setEnv } from './packages/core/src/testEnv';

// No test reaches ordewell.ai (ADR-0048). A test of the version check passes
// its own env, so this only silences the CLI, daemon and extension code that
// starts one as a side effect, and every child process they spawn.
process.env.ORDEWELL_NO_VERSION_CHECK = '1';

// Every test file runs under a home of its own, on every platform. One that
// started a daemon or the CLI without setting a home wrote the user's real
// ~/.ordewell, and on Windows so did every one that set HOME alone, which no
// home there is read from. A test that needs a home of its own sets one over
// this one with homeEnv. The engine's contexts stay where the user keeps them,
// for the container suites.
process.env.DOCKER_CONFIG ??= join(homedir(), '.docker');
const home = mkdtempSync(join(tmpdir(), 'ordewell-test-home-'));
setEnv({ ...homeEnv(home), XDG_CONFIG_HOME: undefined, XDG_DATA_HOME: undefined });
afterAll(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

// Git as it comes, whatever this host configured: Git for Windows turns
// core.autocrlf on system-wide, so a test reading back what a checkout wrote
// read CRLF on Windows alone. The global config is the home's, above.
process.env.GIT_CONFIG_NOSYSTEM = '1';

// vi.waitFor gives up after one second, and vitest has no setting for that.
// Much here waits on real I/O (git, file-system events, child processes), which
// a loaded machine slows past a second: the full suite, under coverage, on a CI
// runner. A wait that succeeds returns as soon as it does, so a longer default
// costs time only in a test that is failing anyway. A timeout a call passes
// itself still wins.
const WAIT_FOR_TIMEOUT_MS = 10_000;

const waitFor = vi.waitFor;
vi.waitFor = ((callback, options) =>
  waitFor(callback, typeof options === 'number' ? options : { timeout: WAIT_FOR_TIMEOUT_MS, ...options })) as typeof vi.waitFor;
