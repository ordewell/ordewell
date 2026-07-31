import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['server/main.ts'],
  outDir: 'dist/server',
  format: ['cjs'],
  external: ['hono', '@hono/node-server', 'ws', '@ordewell/core'],
  clean: false,
  splitting: false,
  sourcemap: true,
  treeshake: true,
});
