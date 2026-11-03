import { defineConfig } from 'tsup';

export default defineConfig({
  // `protocol` is its own entry so a host can take the message types and the
  // patch helpers without the React half of the package; `host` likewise, for
  // the view assembly a host runs; `design` so a host drawing only the chat
  // never bundles Lucide.
  entry: ['src/index.ts', 'src/protocol.ts', 'src/host.ts', 'src/design.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  // Each host bundles React once; a copy inside this package would be a
  // second React whose hooks fail against the host's renderer.
  external: ['react', 'react-dom', '@ordewell/core', 'lucide-react'],
  tsconfig: 'tsconfig.build.json',
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
