#!/usr/bin/env node
/** Bundle core's source for the scale benchmark, internals included, and the daemon's session pool. No dist or tsup needed. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

await esbuild.build({
  entryPoints: [path.join(here, 'entry.ts')],
  outfile: path.join(here, '.build', 'core.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  // The pool imports core by its package name: its source, not its dist, so one copy of each class.
  alias: { '@ordewell/core': path.join(here, '../../packages/core/src/index.ts') },
  logLevel: 'warning',
});
console.log('bundled bench/scale/.build/core.mjs');
