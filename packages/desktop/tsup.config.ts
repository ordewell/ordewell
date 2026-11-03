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
  external: ['electron', 'electron-updater', 'node-pty', '@ordewell/web'],
  // Everything else main imports is bundled, so the packaged app's
  // node_modules hold only the daemon's closure, electron-updater (which reads
  // its own package metadata at run time) and node-pty (a native addon).
  noExternal: [/^(?!electron$|electron-updater$|node-pty$|@ordewell\/web)/],
  clean: false,
  splitting: false,
  sourcemap: true,
  treeshake: true,
});
