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
  // The installers are named for this version (electron-builder's artifactName).
  'packages/desktop/package.json',
];

const failures = [];
for (const pkgPath of packages) {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), pkgPath), 'utf8'));
  if (pkg.version !== version) {
    failures.push(`${pkgPath}: version ${pkg.version} != ${version}`);
  }
}

// Internal packages are released in lockstep. Checking versions alone is not
// enough: for 0.x, `^0.10.12` excludes 0.11.0, so a minor bump tagged here
// would still publish a CLI or extension that resolves the previous core (or
// web). cli-alias pins @ordewell/cli exactly — its bin is the published entry
// point — while every other internal dependency must be `^<version>`.
const cliAliasPath = 'packages/cli-alias/package.json';
for (const pkgPath of packages.slice(1)) {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), pkgPath), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
      if (!dep.startsWith('@ordewell/')) continue;
      const expected = pkgPath === cliAliasPath ? version : `^${version}`;
      if (range !== expected) {
        failures.push(`${pkgPath}: ${dep} is ${range}, expected ${expected}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`Tag ${tag} does not match published versions:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`Tag ${tag} matches all ${packages.length} package versions.`);
