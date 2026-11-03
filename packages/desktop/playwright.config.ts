import { defineConfig } from '@playwright/test';

/**
 * The offline acceptance test drives one app, one daemon and one repository
 * through a run that builds on each step, so it is one test, in one worker.
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
  reporter: process.env.CI ? [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]] : 'list',
});
