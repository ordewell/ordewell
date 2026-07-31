import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/extension.ts'],
  outDir: 'dist',
  format: ['cjs'],
  // Only `vscode` is provided by the host. Everything else — including
  // @ordewell/core and its deps — is bundled so the .vsix is self-contained.
  //
  // tsup externalises everything in `dependencies` by default and `external`
  // only adds to that list, so naming @ordewell/core alone left a bare
  // require('uuid') in a .vsix that ships no node_modules — the extension threw
  // on activation. noExternal is matched before external, hence the negative
  // lookahead rather than a blanket /.*/, which would swallow `vscode` too.
  external: ['vscode'],
  noExternal: [/^(?!vscode$)/],
  clean: true,
  splitting: false,
  sourcemap: true,
  treeshake: true,
});
