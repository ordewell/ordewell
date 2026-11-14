#!/usr/bin/env node
// Refreshes the model-details snapshot bundled with core: one GET of
// models.dev's api.json, cut down by the same trimModelsDev the runtime cache
// uses, written to packages/core/src/services/modelDetailsSnapshot.json.
//
//   npm run build -w @ordewell/core   # the script reads core's dist/
//   node scripts/refresh-model-snapshot.mjs [--from <api.json>] [--out <file>]
//
// `--from` reads a saved api.json instead of fetching, for an offline refresh.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

const { trimModelsDev, MODELS_DEV_URL } = createRequire(import.meta.url)(join(root, 'packages/core/dist/index.js'));
const out = flag('--out') ?? join(root, 'packages/core/src/services/modelDetailsSnapshot.json');
const from = flag('--from');

let raw;
if (from) {
  raw = JSON.parse(readFileSync(from, 'utf8'));
} else {
  const response = await fetch(MODELS_DEV_URL, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${MODELS_DEV_URL}: ${response.status} ${response.statusText}`);
  raw = await response.json();
}

const table = trimModelsDev(raw);
const providers = Object.keys(table);
if (providers.length === 0) throw new Error('models.dev held none of the providers Ordewell lists; the snapshot is left as it was.');
// Sorted, so a refresh diffs as the models that changed and nothing else.
const sorted = Object.fromEntries(
  providers.sort().map((p) => [p, Object.fromEntries(Object.entries(table[p]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))]),
);
writeFileSync(out, `${JSON.stringify(sorted)}\n`);
console.log(`${out}: ${providers.length} providers, ${Object.values(sorted).reduce((n, m) => n + Object.keys(m).length, 0)} model keys`);
