import { defineConfig } from 'tsup';

export default defineConfig({
  // `protocol` is its own entry so a host can take the message types and the
  // patch helpers without the React half of the package.
  entry: ['src/index.ts', 'src/protocol.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  // Each host bundles React once; a copy inside this package would be a
  // second React whose hooks fail against the host's renderer.
  external: ['react', 'react-dom', '@ordewell/core'],
  tsconfig: 'tsconfig.build.json',
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
