import { defineConfig } from '@playwright/test';

/**
 * Marketing captures of the real app: stills and videos for the website and
 * store listings, written to marketing-out/ (gitignored). Run them with
 * `npm run marketing:capture`, which starts a private Xvfb display first
 * (e2e/marketing/xrun.sh). Never part of CI: no workflow step or ci.mjs entry
 * names this config, and its files end in .capture.ts, so the acceptance and
 * tour projects' *.spec.ts never match one.
 */
export default defineConfig({
  testDir: 'e2e/marketing',
  testMatch: '**/*.capture.ts',
  outputDir: 'test-results/marketing',
  globalSetup: './e2e/marketing/setup.ts',
  fullyParallel: false,
  // One screen: two captures at once would grab each other's windows.
  workers: 1,
  retries: 0,
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  reporter: 'list',
});
