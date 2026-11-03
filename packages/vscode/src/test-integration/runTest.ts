import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

const PATH_KEY = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';

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
  try {
    await run(workspace, userData);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

async function run(workspace: string, userData: string): Promise<void> {
  await runTests({
    extensionDevelopmentPath: path.resolve(__dirname, '..'),
    extensionTestsPath: path.resolve(__dirname, './index.js'),
    launchArgs: [workspace, `--user-data-dir=${userData}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
    extensionTestsEnv: {
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
      [PATH_KEY]: [path.resolve(__dirname, '../../../bench/pipeline/fake-claude'), process.env.PATH].filter(Boolean).join(path.delimiter),
      ORDEWELL_TEST_MODEL: process.env.ORDEWELL_TEST_MODEL,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
