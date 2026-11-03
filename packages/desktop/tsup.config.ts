import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { 'main/index': 'src/main/index.ts', 'preload/index': 'src/preload/index.ts' },
  outDir: 'dist',
  // A sandboxed preload can require only `electron` and a few Node builtins,
  // so it must be one CommonJS file; main follows suit.
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  // Electron is the host. The daemon is not bundled into main: main forks
  // @ordewell/web's own built entry (ADR-0060 H2), so web stays a package.
  external: ['electron', '@ordewell/web'],
  // Everything else main imports is bundled, so the packaged app needs no
  // node_modules beside the daemon's.
  noExternal: [/^(?!electron$|@ordewell\/web)/],
  clean: false,
  splitting: false,
  sourcemap: true,
  treeshake: true,
});
