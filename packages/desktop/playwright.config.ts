import { defineConfig } from '@playwright/test';

/**
 * The offline acceptance test drives one app, one daemon and one repository
 * through a run that builds on each step, so it is one test, in one worker.
 * Joining a held session is a second app with its own repository and two
 * daemons, so it is its own spec in the same project, run after it, as is
 * switching project from a window, which opens several repositories, and the
 * terminal's copy and paste, which drives the system clipboard.
 * The visual tour walks the same run for screenshots and layout checks: its own
 * project, so neither script runs the other's spec.
 */
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  // A retry in CI shows a flake as a flake in the report, rather than as a red build.
  retries: process.env.CI ? 1 : 0,
  timeout: 5 * 60_000,
  expect: { timeout: 30_000 },
  projects: [
    { name: 'acceptance', testMatch: ['acceptance.spec.ts', 'joined.spec.ts', 'switch.spec.ts', 'clipboard.spec.ts'] },
    // Every state in two themes and three sizes is one long walk; a retry would repeat it all.
    { name: 'tour', testMatch: 'tour.spec.ts', retries: 0, timeout: 30 * 60_000 },
  ],
  reporter: process.env.CI ? [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]] : 'list',
});
