import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';
import { homeEnv, pathWithFake } from '@ordewell/core/testing';

const PATH_KEY = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
const FAKE_CLAUDE_DIR = path.resolve(__dirname, '../../../bench/pipeline/fake-claude');

async function main(): Promise<void> {
  const workspace = process.env.ORDEWELL_TEST_WORKSPACE;
  if (!workspace) throw new Error('ORDEWELL_TEST_WORKSPACE must point at a scratch directory');

  // Run from a VS Code terminal, the editor's own ELECTRON_RUN_AS_NODE and
  // VSCODE_* variables reach the test instance, which then starts as plain
  // Node (or as an extension host) instead of as VS Code.
  for (const key of Object.keys(process.env)) {
    if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_')) delete process.env[key];
  }

  // VS Code's IPC socket lives in its user data dir, and a Unix socket path
  // may be at most 103 characters on macOS: under a deep checkout, such as a
  // worktree, the default `.vscode-test/user-data` overruns it and VS Code
  // fails to start with EINVAL.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-vsc-'));
  // A home of the instance's own: what the extension writes under ~/.ordewell
  // is not the user's, and on Windows a claude.exe installed in the real home
  // would be started in the fake's place.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-home-'));
  try {
    await run(workspace, userData, home);
  } finally {
    removeScratch(userData);
    removeScratch(home);
  }
}

/**
 * On Windows VS Code's helper processes hold their logs open for a moment after
 * it exits, so the first unlink can meet EBUSY. A scratch directory left behind
 * is no failure of the test.
 */
function removeScratch(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (err) {
    console.warn(`Could not remove ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function run(workspace: string, userData: string, home: string): Promise<void> {
  await runTests({
    extensionDevelopmentPath: path.resolve(__dirname, '..'),
    extensionTestsPath: path.resolve(__dirname, './index.js'),
    launchArgs: [
      workspace,
      `--user-data-dir=${userData}`,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      // The home above has no login keychain, so on macOS the first secret
      // read raises a keychain dialog and the run waits on it until killed.
      ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    ],
    extensionTestsEnv: {
      ...homeEnv(home),
      ORDEWELL_TEST_WORKSPACE: workspace,
      // Set here too, not only by CI: a bare local run must not ping ordewell.ai or write ~/.ordewell.
      ORDEWELL_NO_VERSION_CHECK: '1',
      // Desktop shell resolution would overwrite the synthetic runner's PATH.
      VSCODE_CLI: '1',
      // In the host's environment from launch: the PATH Ordewell spawns runners
      // under is resolved once per process, so setting it later can be too late.
      // Under the key the environment already uses: this merges over
      // process.env, where Windows spells it `Path`, and a second `PATH` beside
      // it lost to the original.
      [PATH_KEY]: pathWithFake(FAKE_CLAUDE_DIR, 'claude'),
      ORDEWELL_TEST_MODEL: process.env.ORDEWELL_TEST_MODEL,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
