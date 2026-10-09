import { defineConfig } from 'tsup';

/**
 * A CJS bundle cannot carry `import.meta` — esbuild blanks it and warns.
 * `builtinSkills.ts` only needs `import.meta.url` on the ESM fallback path
 * (the CJS branch uses `__dirname`, which is always defined there), so the
 * dead CJS reference is pointed at `__filename` for that format alone; the ESM
 * output keeps native `import.meta.url`. `__filename` is an identifier, which
 * is the only shape esbuild's `define` accepts.
 */
export default defineConfig({
  removeNodeProtocol: false,
  esbuildOptions(options, context) {
    if (context.format === 'cjs') {
      options.define = {
        ...(options.define ?? {}),
        'import.meta.url': '__filename',
      };
    }
  },
});
