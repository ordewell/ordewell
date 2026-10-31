#!/usr/bin/env node
/** Bundle core's source for the scale benchmark, internals included. No dist or tsup needed. */
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
  logLevel: 'warning',
});
console.log('bundled bench/scale/.build/core.mjs');
