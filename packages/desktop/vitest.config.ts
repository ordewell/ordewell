import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { sharedTest } from '../../vitest.shared';

export default defineConfig({
  plugins: [react()],
  test: {
    ...sharedTest,
    // Main and the pure renderer modules run in node; anything that renders gets a DOM.
    environment: 'node',
    environmentMatchGlobs: [['src/**/*.test.tsx', 'jsdom']],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: [...sharedTest.setupFiles, 'src/renderer/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**', '**/*.d.ts', 'src/renderer/test/**', 'dist/**'],
    },
  },
});
