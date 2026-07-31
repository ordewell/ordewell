import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const workspace = process.env.ORDEWELL_TEST_WORKSPACE;
  if (!workspace) throw new Error('ORDEWELL_TEST_WORKSPACE must point at a scratch directory');

  await runTests({
    extensionDevelopmentPath: path.resolve(__dirname, '..'),
    extensionTestsPath: path.resolve(__dirname, './index.js'),
    launchArgs: [workspace, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
    extensionTestsEnv: {
      ORDEWELL_TEST_WORKSPACE: workspace,
      ORDEWELL_TEST_MODEL: process.env.ORDEWELL_TEST_MODEL,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
