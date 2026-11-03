#!/usr/bin/env node
// The root NOTICE carries the Apache-2.0 project notice and the MIT notice for
// the adapted planning prompts; AUTHORS.md is the file NOTICE points at. npm
// only packs a file named in `files` and vsce only packs one re-included after
// `**` in `.vscodeignore`, so each publishable package keeps its own copy — and
// a copy that drifts from the root would ship a stale notice without any other
// check noticing. This fails on a missing or diverging copy.
//
// packages/ui is private and ships inside the desktop app and the VS Code
// extension, and packages/desktop ships its copies through electron-builder's
// extraResources rather than npm. Both keep the same copies for the same
// reason, so both are checked for a missing or diverging file; only the
// published five are checked for listing it in `files`.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packages = ['core', 'cli', 'web', 'cli-alias', 'vscode', 'desktop', 'ui'];
const published = ['core', 'cli', 'web', 'cli-alias', 'vscode'];
const files = ['NOTICE', 'AUTHORS.md'];

/** What the desktop installer carries beside Electron's own licence files. */
const desktopShipped = ['LICENSE', 'NOTICE', 'AUTHORS.md', 'THIRD-PARTY-NOTICES.md'];

let failures = 0;
for (const file of files) {
  const expected = fs.readFileSync(path.join(root, file), 'utf8');
  for (const pkg of packages) {
    const copy = path.join(root, 'packages', pkg, file);
    if (!fs.existsSync(copy)) {
      failures += 1;
      console.error(`FAIL  packages/${pkg}/${file} is missing; copy it from the repository root`);
    } else if (fs.readFileSync(copy, 'utf8') !== expected) {
      failures += 1;
      console.error(`FAIL  packages/${pkg}/${file} differs from the root ${file}; copy it again`);
    }
  }
  const listed = published.filter((pkg) => {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'packages', pkg, 'package.json'), 'utf8'));
    if (pkg === 'vscode') {
      return fs.readFileSync(path.join(root, 'packages', pkg, '.vscodeignore'), 'utf8').includes(`!${file}`);
    }
    return (pkgJson.files ?? []).includes(file);
  });
  for (const pkg of published.filter((p) => !listed.includes(p))) {
    failures += 1;
    console.error(`FAIL  packages/${pkg} does not publish ${file}; list it in files (or .vscodeignore)`);
  }
}

// The desktop package's copies reach a user only through the installer, so a
// copy the builder never names would be a file nobody receives.
const builder = fs.readFileSync(path.join(root, 'packages', 'desktop', 'electron-builder.yml'), 'utf8');
for (const file of desktopShipped) {
  if (!new RegExp(`^\\s+-\\s+from:\\s+${file.replace('.', '\\.')}$`, 'm').test(builder)) {
    failures += 1;
    console.error(`FAIL  packages/desktop/electron-builder.yml does not ship ${file} (extraResources)`);
  }
}

if (failures > 0) {
  console.error(`\nverify-notice: ${failures} check(s) failed`);
  process.exit(1);
}
console.log(`verify-notice: all ${packages.length} packages carry the root NOTICE and AUTHORS.md, and the desktop installer ships its four notice files`);
