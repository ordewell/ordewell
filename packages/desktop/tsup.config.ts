import { defineConfig } from 'tsup';

/**
 * The update gate as main's bundle holds it. scripts/package.mjs sets
 * ORDEWELL_DESKTOP_AUTO_UPDATE from its signing plan (ADR-0060 H9); any other
 * build (`npm run build`, `npm run dev`) has it off.
 */
export function autoUpdateDefine(env: NodeJS.ProcessEnv): Record<string, string> {
  return { __ORDEWELL_AUTO_UPDATE__: env.ORDEWELL_DESKTOP_AUTO_UPDATE === 'on' ? 'true' : 'false' };
}

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
  define: autoUpdateDefine(process.env),
  clean: false,
  splitting: false,
  sourcemap: true,
  treeshake: true,
});
