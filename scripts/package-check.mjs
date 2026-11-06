#!/usr/bin/env node
// What a user actually installs: the four npm tarballs, the VSIX and the
// desktop app's installers. Nothing else in CI looks inside them, so a missing main/exports/bin target, a LICENSE
// or NOTICE npm left out of the allowlist, or a bundle that dies before --help
// is otherwise first found by `npm publish` or by a user. The CLI's CJS bundle
// once required ESM-only string-width at load and failed exactly that way on
// the Node versions its engines allow.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDesktopPackage } from './desktop-package-check.mjs';

const root = process.cwd();
let failures = 0;
const ok = (message) => console.log(`  ok  ${message}`);
const fail = (message) => {
  failures += 1;
  console.error(`FAIL  ${message}`);
};

const PACKAGES = [
  { dir: 'packages/core', notices: ['LICENSE', 'NOTICE', 'AUTHORS.md'] },
  { dir: 'packages/web', notices: ['LICENSE', 'NOTICE', 'AUTHORS.md'] },
  { dir: 'packages/cli', notices: ['LICENSE', 'NOTICE', 'AUTHORS.md', 'THIRD-PARTY-NOTICES.md'] },
  { dir: 'packages/cli-alias', notices: ['LICENSE', 'NOTICE', 'AUTHORS.md'] },
];

/**
 * Every path a consumer can reach: main/module/types, each exports leaf and
 * each bin. All must be inside the tarball, or `npm install` produces a package
 * whose entry point does not exist.
 */
function entryTargets(pkg) {
  const targets = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.startsWith('./')) targets.add(value.slice(2));
  };
  for (const field of ['main', 'module', 'types', 'browser']) add(pkg[field]);
  if (typeof pkg.bin === 'string') add(pkg.bin);
  for (const value of Object.values(pkg.bin ?? {})) add(value);
  const walk = (value) => {
    if (typeof value === 'string') add(value);
    else if (value && typeof value === 'object') for (const nested of Object.values(value)) walk(nested);
  };
  walk(pkg.exports);
  return [...targets].sort();
}

const packDir = mkdtempSync(join(tmpdir(), 'ordewell-pack-'));
const tarballs = [];
try {
  for (const { dir, notices } of PACKAGES) {
    const cwd = join(root, dir);
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    console.log(`\n${pkg.name}@${pkg.version}`);
    const before = failures;
    const dryRun = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd, encoding: 'utf8' }));
    const files = new Set(dryRun[0].files.map((file) => file.path));
    for (const target of entryTargets(pkg)) {
      if (!files.has(target)) fail(`${dir}: entry target ${target} is not in the tarball`);
    }
    for (const notice of notices) {
      if (!files.has(notice)) fail(`${dir}: ${notice} is not in the tarball (list it in "files")`);
    }
    if (failures === before) ok(`${files.size} files, every entry target and notice present`);
    const packed = execFileSync('npm', ['pack', '--pack-destination', packDir, '--ignore-scripts'], { cwd, encoding: 'utf8' })
      .trim()
      .split('\n')
      .pop();
    tarballs.push({ name: pkg.name, path: join(packDir, packed) });
  }

  // Install the tarballs together, as `npm i ordewell` would resolve them, and
  // start the CLI with require(esm) off: the oldest Node the engines field
  // promises behaves that way even when the local Node does not.
  console.log('\ninstall the tarballs and start the CLI');
  const consumer = join(packDir, 'consumer');
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'ordewell-pack-smoke', private: true, dependencies: Object.fromEntries(tarballs.map((t) => [t.name, `file:${t.path}`])) }, null, 2),
  );
  // An empty user config keeps a developer's ~/.npmrc (an allow-scripts list
  // makes npm refuse a project-scoped install) out of the smoke install. `npm
  // run` re-exports that list as npm_config_allow_scripts, so drop it from the
  // environment too.
  const userconfig = join(packDir, 'empty.npmrc');
  writeFileSync(userconfig, '');
  const installEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase().replace(/-/g, '_') !== 'npm_config_allow_scripts'));
  const installed = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `--userconfig=${userconfig}`], { cwd: consumer, stdio: 'inherit', env: installEnv });
  if (installed.status !== 0) {
    fail('npm install of the packed tarballs failed');
  } else {
    const cliVersion = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')).version;
    const runs = [
      ['@ordewell/cli dist/main.js --help', join(consumer, 'node_modules/@ordewell/cli/dist/main.js'), ['--help']],
      ['packed ordewell bin --help', join(consumer, 'node_modules/ordewell/bin/ordewell.js'), ['--help']],
      ['@ordewell/cli dist/main.js --version', join(consumer, 'node_modules/@ordewell/cli/dist/main.js'), ['--version']],
    ];
    for (const [label, entry, args] of runs) {
      const run = spawnSync(process.execPath, ['--no-experimental-require-module', entry, ...args], { encoding: 'utf8' });
      if (run.status !== 0) {
        fail(`${label} exited ${run.status}: ${(run.stderr || run.stdout).trim().split('\n').slice(-3).join(' | ')}`);
      } else if (args.includes('--version') && !run.stdout.includes(cliVersion)) {
        fail(`${label} printed ${JSON.stringify(run.stdout.trim())}, expected ${cliVersion}`);
      } else {
        ok(label);
      }
    }

    // Subplanners and containers are held out of every published build
    // (ADR-0055 D21, ADR-0059 L5): the variables only count in a git checkout,
    // so a user who exports them still gets neither command. Prove that
    // against the artifact users install, and prove the same variables still
    // open both in the checkout's build, which is the gate development uses.
    console.log('\nfeature gates');
    const gatedEnv = { ...process.env, ORDEWELL_DELEGATION: '1', ORDEWELL_CONTAINERS: '1' };
    const helpWith = (entry) =>
      spawnSync(process.execPath, ['--no-experimental-require-module', entry, '--help'], { encoding: 'utf8', env: gatedEnv });
    const checkGate = (label, run, offered) => {
      if (run.status !== 0) {
        fail(`${label} --help exited ${run.status} with the feature variables set: ${(run.stderr || run.stdout).trim().split('\n').slice(-3).join(' | ')}`);
        return;
      }
      const delegation = /ordewell delegation/.test(run.stdout);
      const containers = /ordewell containers/.test(run.stdout);
      if (offered ? delegation && containers : !delegation && !containers) {
        ok(`${label} --help ${offered ? 'offers' : 'hides'} subplanners and containers with the feature variables set`);
      } else {
        fail(`${label} --help ${delegation ? 'offers' : 'hides'} subplanners and ${containers ? 'offers' : 'hides'} containers with the feature variables set, expected both ${offered ? 'offered' : 'hidden'}`);
      }
    };
    checkGate('packed CLI', helpWith(join(consumer, 'node_modules/@ordewell/cli/dist/main.js')), false);
    checkGate('checkout CLI', helpWith(join(root, 'packages/cli/dist/main.js')), true);
  }

  // The VSIX, after "Package VS Code Extension". vsce renames LICENSE to
  // LICENSE.txt, so match the extension's basename with any suffix.
  console.log('\nVS Code extension');
  const vscodeDir = join(root, 'packages/vscode');
  const before = failures;
  // Name the current version: earlier releases' .vsix files linger in the
  // directory, and sorting the names puts 0.10.8 after 0.10.12.
  const extension = JSON.parse(readFileSync(join(vscodeDir, 'package.json'), 'utf8'));
  const vsix = readdirSync(vscodeDir).find((file) => file === `${extension.name}-${extension.version}.vsix`);
  if (!vsix) {
    fail(`no ${extension.name}-${extension.version}.vsix in packages/vscode; run "npm run package -w packages/vscode" first`);
  } else {
    const listed = execFileSync('unzip', ['-Z1', join(vscodeDir, vsix)], { encoding: 'utf8' }).split('\n');
    const has = (pattern) => listed.some((entry) => pattern.test(entry));
    for (const [label, pattern] of [
      ['dist/extension.js', /^extension\/dist\/extension\.js$/],
      ['package.json', /^extension\/package\.json$/],
      ['LICENSE', /^extension\/LICENSE(\.[a-z]+)?$/],
      ['NOTICE', /^extension\/NOTICE$/],
      ['AUTHORS.md', /^extension\/AUTHORS\.md$/],
      ['THIRD-PARTY-NOTICES.md', /^extension\/THIRD-PARTY-NOTICES\.md$/],
    ]) {
      if (!has(pattern)) fail(`${vsix}: ${label} is not in the VSIX (check .vscodeignore)`);
    }
    if (failures === before) ok(`${vsix} carries the bundle, LICENSE, NOTICE and third-party notices`);

    // The extension ships the containers command but must never show it without
    // the context key its activation sets only when containersOffered() is true
    // (ADR-0059 L5). The packaged manifest is the last place that gate can be
    // lost while every unit test still passes.
    const manifest = JSON.parse(
      execFileSync('unzip', ['-p', join(vscodeDir, vsix), 'extension/package.json'], { encoding: 'utf8' }),
    );
    const containerCommand = manifest.contributes?.commands?.find((command) => command.command === 'ordewell.containers');
    const containerMenu = manifest.contributes?.menus?.commandPalette?.find((item) => item.command === 'ordewell.containers');
    if (!containerCommand) {
      fail(`${vsix}: the containers command is missing, so the experiment cannot be reached in a checkout`);
    } else if (containerMenu?.when !== 'ordewell.containersOffered') {
      fail(`${vsix}: the containers command is not held behind ordewell.containersOffered, so a published extension would offer it`);
    } else {
      ok(`${vsix} keeps containers behind ordewell.containersOffered`);
    }
  }

  // The desktop installers, after "Package the desktop app". Its own module
  // holds the checks so a test can drive them without packaging anything.
  console.log('\nDesktop app');
  const desktop = await checkDesktopPackage(root);
  for (const message of desktop) fail(message);
  if (!desktop.length) ok('installers, unpacked daemon closure, fuses and notices');
} finally {
  rmSync(packDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\npackage-check: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\npackage-check: all packaged artifacts are complete and the CLI starts');
