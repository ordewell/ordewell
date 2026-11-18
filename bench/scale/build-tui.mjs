#!/usr/bin/env node
/** Bundle the terminal UI's source for tui.mjs, core's source included. No dist or tsup needed. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.join(here, '..', '..', 'packages', 'core', 'src');
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

await esbuild.build({
  entryPoints: [path.join(here, 'entry-tui.ts')],
  outfile: path.join(here, '.build', 'tui.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  // `packages: external` would leave these to resolve to core's dist.
  alias: {
    '@ordewell/core/plan-utils': path.join(core, 'plan-utils.ts'),
    '@ordewell/core': path.join(core, 'index.ts'),
  },
  logLevel: 'warning',
});
console.log('bundled bench/scale/.build/tui.mjs');
