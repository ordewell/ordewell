import { fileURLToPath } from 'node:url';

/** Test settings every package shares; each vitest.config.ts spreads these into its `test`. */
export const sharedTest = {
  setupFiles: [fileURLToPath(new URL('./vitest.setup.ts', import.meta.url))],
  // vitest's five-second default would end a test before the setup's longer
  // vi.waitFor default could, which would put the flake back.
  testTimeout: 30_000,
  // An afterEach waits out real git before it removes a repository
  // (closeSessions), so a hook needs the same room on a loaded machine.
  hookTimeout: 30_000,
};
