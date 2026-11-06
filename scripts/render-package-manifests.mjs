#!/usr/bin/env node
// The package-manager manifests for one release (ADR-0063 H11, ADR-0065): a
// Homebrew formula for the CLI and a Homebrew cask for the desktop app, both for
// ordewell/homebrew-tap, and the three winget manifests for
// microsoft/winget-pkgs, rendered from the version and the one SHA256SUMS that
// scripts/desktop-release-assets.mjs wrote.
//
//   node scripts/render-package-manifests.mjs --version 0.12.3 --sums SHA256SUMS
//       [--only formula|cask|winget]... [--out <dir>]
//
// Without --out the files print to stdout, each after a `==> <path>` line, which
// is the dry run. With --out they are written under it, named by their path in
// the tap and ready to copy there, and to hand to wingetcreate:
//
//   <out>/homebrew/Formula/ordewell.rb          brew install ordewell/tap/ordewell
//   <out>/homebrew/Casks/ordewell-desktop.rb    brew install --cask ordewell/tap/ordewell-desktop
//   <out>/winget/manifests/o/Ordewell/Ordewell/<version>/*.yaml
//
// --only (repeatable) renders just those targets and reads just the files they
// name: the release publishes the formula whenever the tap token exists but the
// cask only from a notarized macOS build, so each must render without the other.
//
// Every file a manifest names has to be in SHA256SUMS, and a fixed-name copy has
// to carry the hash of the versioned file it duplicates: a formula, cask or
// manifest whose checksum is not the release's is worse than none.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The CLI formula's template and where it goes in the tap repository. */
export const FORMULA = { template: 'packaging/homebrew/ordewell.rb.tmpl', path: 'homebrew/Formula/ordewell.rb' };

/** The desktop cask's template and where it goes in the tap repository. */
export const CASK = { template: 'packaging/homebrew/ordewell-desktop.rb.tmpl', path: 'homebrew/Casks/ordewell-desktop.rb' };

/** What `--only` accepts, in the order a full render lists them. */
export const TARGETS = ['formula', 'cask', 'winget'];

/** The winget identifier, and the manifests that describe it. */
export const WINGET_ID = 'Ordewell.Ordewell';
export const WINGET_TEMPLATES = [
  { template: 'packaging/winget/Ordewell.Ordewell.yaml.tmpl', name: 'Ordewell.Ordewell.yaml' },
  { template: 'packaging/winget/Ordewell.Ordewell.installer.yaml.tmpl', name: 'Ordewell.Ordewell.installer.yaml' },
  { template: 'packaging/winget/Ordewell.Ordewell.locale.en-US.yaml.tmpl', name: 'Ordewell.Ordewell.locale.en-US.yaml' },
];

const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const PLACEHOLDER = /\{\{[a-z0-9_]+\}\}/;

/** Where winget-pkgs keeps a package: manifests/<initial>/<publisher>/<package>/<version>. */
export function wingetDirectory(version) {
  return `winget/manifests/o/Ordewell/Ordewell/${version}`;
}

/**
 * SHA256SUMS as `sha256sum -c` reads it: "<hash>  <name>", a name that begins
 * with `*` for binary mode, and the fixed-name copies listed beside the
 * versioned files. A repeated name keeps its last line, as sha256sum does.
 */
export function parseSums(text) {
  const sums = new Map();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

/** Looks each of `names` up in `sums`, and throws rather than render a hole. */
function lookup(sums, names, fixed) {
  const found = {};
  for (const [key, name] of Object.entries(names)) {
    const sha256 = sums.get(name);
    if (!sha256) throw new Error(`SHA256SUMS has no ${name}`);
    if (!SHA256.test(sha256)) throw new Error(`${name} has no sha256 in SHA256SUMS`);
    // The fixed-name copy the one-line installers read must be the same bytes
    // as the versioned file it duplicates.
    const copy = sums.get(fixed[key]);
    if (copy && copy !== sha256) throw new Error(`${fixed[key]} and ${name} disagree on the hash; the release is inconsistent`);
    found[key] = { name, sha256 };
  }
  return found;
}

function checkVersion(version) {
  if (!VERSION.test(version)) throw new Error(`"${version}" is not a version of the form x.y.z`);
}

/**
 * The installers a cask or a winget manifest names (`macArm64`, `macX64`,
 * `winX64`), by the names the release uses; `keys` narrows which are needed.
 * Throws rather than render a manifest with a hole in it.
 */
export function releaseInstallers(version, sums, keys = ['macArm64', 'macX64', 'winX64']) {
  checkVersion(version);
  const wanted = {
    macArm64: `Ordewell-${version}-mac-arm64.dmg`,
    macX64: `Ordewell-${version}-mac-x64.dmg`,
    winX64: `Ordewell-${version}-win-x64.exe`,
  };
  const fixed = {
    macArm64: 'Ordewell-mac-arm64.dmg',
    macX64: 'Ordewell-mac-x64.dmg',
    winX64: 'Ordewell-win-x64.exe',
  };
  const pick = (from) => Object.fromEntries(keys.map((key) => [key, from[key]]));
  return lookup(sums, pick(wanted), pick(fixed));
}

/** The four CLI archives the formula downloads, by the names the release uses. */
export function cliArchives(version, sums) {
  checkVersion(version);
  const targets = { darwinArm64: 'darwin-arm64', darwinX64: 'darwin-x64', linuxArm64: 'linux-arm64', linuxX64: 'linux-x64' };
  const entries = Object.entries(targets);
  return lookup(
    sums,
    Object.fromEntries(entries.map(([key, target]) => [key, `ordewell-${version}-${target}.tar.gz`])),
    Object.fromEntries(entries.map(([key, target]) => [key, `ordewell-${target}.tar.gz`])),
  );
}

function render(template, values) {
  let text = readFileSync(join(root, template), 'utf8');
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{{${name}}}`, value);
  // A template that grew a placeholder this script does not fill would render a
  // broken cask or manifest, which is the failure this check exists for.
  const left = PLACEHOLDER.exec(text);
  if (left) throw new Error(`${template} still holds ${left[0]}`);
  return text;
}

/** The formula's text, from the release's CLI archives. */
export function renderFormula(version, archives) {
  return render(FORMULA.template, {
    version,
    sha256_darwin_arm64: archives.darwinArm64.sha256,
    sha256_darwin_x64: archives.darwinX64.sha256,
    sha256_linux_arm64: archives.linuxArm64.sha256,
    sha256_linux_x64: archives.linuxX64.sha256,
  });
}

/** The cask's text, from the release's installers. */
export function renderCask(version, installers) {
  return render(CASK.template, {
    version,
    sha256_mac_arm64: installers.macArm64.sha256,
    sha256_mac_x64: installers.macX64.sha256,
  });
}

/** The winget manifests' text, from the release's installers. */
export function renderWinget(version, installers) {
  return WINGET_TEMPLATES.map(({ template, name }) => ({
    path: `${wingetDirectory(version)}/${name}`,
    text: render(template, { version, sha256_win_x64: installers.winX64.sha256 }),
  }));
}

/**
 * Every file one release publishes to a package manager, by path under `--out`.
 * `only` names the targets to render (default: all); a target reads only the
 * SHA256SUMS lines it names, so the formula renders without the cask's dmgs.
 */
export function renderManifests(version, sumsText, { only = TARGETS } = {}) {
  const targets = typeof only === 'string' ? [only] : only;
  for (const target of targets) {
    if (!TARGETS.includes(target)) throw new Error(`unknown target "${target}"; expected ${TARGETS.join(', ')}`);
  }
  const sums = parseSums(sumsText);
  const wants = (target) => targets.includes(target);
  const files = [];
  if (wants('formula')) files.push({ path: FORMULA.path, text: renderFormula(version, cliArchives(version, sums)) });
  if (wants('cask')) files.push({ path: CASK.path, text: renderCask(version, releaseInstallers(version, sums, ['macArm64', 'macX64'])) });
  if (wants('winget')) files.push(...renderWinget(version, releaseInstallers(version, sums, ['winX64'])));
  return files;
}

/** Writes each rendered file under `dir`, creating the directories it needs. */
export function writeManifests(dir, files) {
  for (const { path, text } of files) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return files.map(({ path }) => join(dir, path));
}

const USAGE = `usage: node scripts/render-package-manifests.mjs --version <x.y.z> --sums <SHA256SUMS> [--only ${TARGETS.join('|')}]... [--out <dir>]`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const values = (flag) => args.flatMap((arg, at) => (arg === flag ? [args[at + 1]] : []));
  const value = (flag) => values(flag)[0];
  const version = value('--version');
  const sums = value('--sums');
  const out = value('--out');
  const only = values('--only');
  const usable = version && sums && values('--out').every(Boolean) && only.every(Boolean) && !(args.at(-1) === '--only');
  if (!usable || args.includes('-h') || args.includes('--help')) {
    console.error(USAGE);
    process.exit(usable ? 0 : 2);
  }
  try {
    const files = renderManifests(version, readFileSync(sums, 'utf8'), only.length > 0 ? { only } : {});
    if (out) {
      for (const file of writeManifests(out, files)) console.log(file);
    } else {
      for (const { path, text } of files) process.stdout.write(`==> ${path}\n${text}\n`);
    }
  } catch (error) {
    console.error(`render-package-manifests: ${error.message}`);
    process.exit(1);
  }
}
