#!/usr/bin/env node
// Two artifacts ship third-party code but no node_modules for it: the VS Code
// extension (tsup/vite bundle everything except `vscode`) and the CLI (tsup
// bundles every dependency outside its two externals). The licences of what
// they bundle have to travel with them, so this walks the installed production
// tree and writes THIRD-PARTY-NOTICES.md next to the package. It runs from each
// package's build, which is also what `npm publish` and `vsce package` run
// first, so the file can never describe a previous dependency tree.
//
// The desktop app is the same problem in a different shape: Vite bundles the
// renderer's dependencies into its chunks and the daemon's closure is unpacked
// beside app.asar, so the installer carries the file electron-builder.yml names.
// packages/ui is private and has no artifact of its own, but it is bundled into
// both hosts and keeps its own copy so a change to its dependencies is visible.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * What each bundle pulls in. cli mirrors `noExternal` in
 * packages/cli/tsup.config.ts — everything else there is external and arrives
 * through npm with its own licence. vscode bundles all of `@ordewell/core` plus
 * React for the webviews; `@ordewell/*` itself is first-party and covered by
 * LICENSE, but is walked for the dependencies it brings. desktop's list is what
 * its Vite build and its daemon closure carry: the renderer's UI, editor,
 * terminal and fonts, and the daemon's own production tree. Electron and
 * Chromium are not here: electron-builder copies their licence files beside the
 * app, and they are a build-time dependency, not a bundled package.
 */
const TARGETS = {
  cli: { dir: 'packages/cli', roots: ['string-width'] },
  vscode: { dir: 'packages/vscode', roots: ['@ordewell/core', 'react', 'react-dom'] },
  ui: {
    dir: 'packages/ui',
    roots: ['lucide-react'],
    notes: [
      'This package is private and has no artifact of its own: it is bundled into the',
      'desktop app and the VS Code extension, whose notices carry these packages too.',
      'React comes from whichever host draws it, and is listed by that host.',
    ],
  },
  desktop: {
    dir: 'packages/desktop',
    roots: [
      '@ordewell/web',
      'electron-updater',
      'node-pty',
      'monaco-editor',
      'lucide-react',
      '@xterm/xterm',
      '@xterm/addon-fit',
      '@fontsource-variable/inter',
      '@fontsource-variable/jetbrains-mono',
      'react',
      'react-dom',
    ],
    notes: [
      'Electron and Chromium ship their own licence files beside the app —',
      '`LICENSE.electron.txt` and `LICENSES.chromium.html`, which electron-builder copies —',
      'and are a build-time dependency rather than one of the packages below.',
    ],
  },
};

const target = TARGETS[process.argv[2]];
if (!target) {
  console.error(`usage: generate-third-party-notices.mjs <${Object.keys(TARGETS).join('|')}>`);
  process.exit(1);
}

const packageDir = path.join(root, target.dir);

/** Node's own lookup: walk up from the requiring package until node_modules has it. */
function findPackageDir(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) return undefined;
  }
}

// Monaco ships `ThirdPartyNotices.txt` for the code it inlines, and a notice
// that reproduces only `LICENSE` would leave that code unattributed.
const LICENSE_FILES = /^((licen[cs]e|copying)(\.[a-z]+)?|third[- ]?party[- ]?notices(\.(txt|md))?)$/i;

function licenseFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((entry) => LICENSE_FILES.test(entry) && fs.statSync(path.join(dir, entry)).isFile())
    .sort();
}

const collected = new Map();

function walk(name, fromDir) {
  const dir = findPackageDir(name, fromDir);
  if (!dir) throw new Error(`${name} is not installed under ${path.relative(root, fromDir) || '.'}`);
  if (collected.has(dir)) return;
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  collected.set(dir, { pkg, dir });
  for (const dep of Object.keys(pkg.dependencies ?? {})) walk(dep, dir);
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
    if (findPackageDir(dep, dir)) walk(dep, dir);
  }
}

for (const name of target.roots) walk(name, packageDir);

const entries = [...collected.values()]
  .filter(({ pkg }) => !pkg.name?.startsWith('@ordewell/'))
  .sort((a, b) => a.pkg.name.localeCompare(b.pkg.name) || a.pkg.version.localeCompare(b.pkg.version));

const out = [];
out.push(
  '# Third-party notices',
  '',
  'This artifact bundles the third-party packages listed below. Each entry reproduces the',
  'licence text the installed package ships, as its licence requires; the packages are also',
  'reachable through the dependency tree recorded in `package-lock.json`.',
  '',
  'Generated by `scripts/generate-third-party-notices.mjs` from the installed dependency',
  'tree; do not edit by hand.',
  '',
);
if (target.notes) out.push(...target.notes, '');
for (const { pkg, dir } of entries) {
  out.push('---', '', `## ${pkg.name} ${pkg.version}`, '');
  const license = typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? 'UNKNOWN');
  out.push(`Licence: ${license}`);
  if (pkg.homepage) out.push(`Homepage: ${pkg.homepage}`);
  out.push('');
  const files = licenseFiles(dir);
  if (files.length === 0) {
    out.push(
      `The package declares ${license} but installs no licence file; the identifier above is` +
        ' the licence it grants.',
    );
  } else {
    for (const file of files) {
      out.push('```text', fs.readFileSync(path.join(dir, file), 'utf8').trimEnd(), '```', '');
    }
  }
  out.push('');
}

const dest = path.join(packageDir, 'THIRD-PARTY-NOTICES.md');
fs.writeFileSync(dest, `${out.join('\n').trimEnd()}\n`);
console.log(`Generated ${path.relative(root, dest)} for ${entries.length} bundled packages`);
