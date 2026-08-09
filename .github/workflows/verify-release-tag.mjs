#!/usr/bin/env node
// Release guard: a tag like v0.4.6 must match the version every package.json
// ships. npm versions are immutable — catching a mismatch here beats a
// publish failure (or worse, a wrong-version release) minutes later.
'use strict';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const tag = process.argv[2];
if (!tag) {
  console.error('usage: verify-release-tag.mjs <git-tag>');
  process.exit(1);
}

const version = tag.startsWith('v') ? tag.slice(1) : tag;

const packages = [
  'package.json',
  'packages/core/package.json',
  'packages/web/package.json',
  'packages/cli/package.json',
  'packages/cli-alias/package.json',
  'packages/vscode/package.json',
];

const failures = [];
for (const pkgPath of packages) {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), pkgPath), 'utf8'));
  if (pkg.version !== version) {
    failures.push(`${pkgPath}: version ${pkg.version} != ${version}`);
  }
}

// cli-alias pins @ordewell/cli exactly so the published `ordewell` bin can
// never resolve to a mismatched core.
const cliAlias = JSON.parse(
  readFileSync(join(process.cwd(), 'packages/cli-alias/package.json'), 'utf8'),
);
if (cliAlias.dependencies?.['@ordewell/cli'] !== version) {
  failures.push(
    `packages/cli-alias/package.json: @ordewell/cli pinned to ` +
      `${cliAlias.dependencies?.['@ordewell/cli']} != ${version}`,
  );
}

if (failures.length > 0) {
  console.error(`Tag ${tag} does not match published versions:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`Tag ${tag} matches all ${packages.length} package versions.`);
