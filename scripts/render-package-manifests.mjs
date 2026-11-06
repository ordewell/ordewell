#!/usr/bin/env node
// The package-manager manifests for one release (ADR-0063 H11): a Homebrew cask
// for ordewell/homebrew-tap and the three winget manifests for
// microsoft/winget-pkgs, rendered from the version and the SHA256SUMS the attach
// job of desktop-build.yml wrote.
//
//   node scripts/render-package-manifests.mjs --version 0.12.3 --sums SHA256SUMS [--out <dir>]
//
// Without --out the files print to stdout, each after a `==> <path>` line, which
// is the dry run. With --out they are written under it, ready to copy into the
// tap and to hand to wingetcreate:
//
//   <out>/homebrew/Casks/ordewell.rb
//   <out>/winget/manifests/o/Ordewell/Ordewell/<version>/*.yaml
//
// Every installer a manifest names has to be in SHA256SUMS, and a fixed-name
// copy has to carry the hash of the versioned file it duplicates: a cask or a
// manifest whose checksum is not the release's is worse than none.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The cask template and where it goes in the tap repository. */
export const CASK = { template: 'packaging/homebrew/ordewell.rb.tmpl', path: 'homebrew/Casks/ordewell.rb' };

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

/**
 * The three installers a cask or a winget manifest names, by the names the
 * release uses. Throws rather than render a manifest with a hole in it.
 */
export function releaseInstallers(version, sums) {
  if (!VERSION.test(version)) throw new Error(`"${version}" is not a version of the form x.y.z`);
  const wanted = {
    macArm64: `Ordewell-${version}-mac-arm64.dmg`,
    macX64: `Ordewell-${version}-mac-x64.dmg`,
    winX64: `Ordewell-${version}-win-x64.exe`,
  };
  // The fixed-name copies the one-line installers read, which must be the same
  // bytes as the versioned file they duplicate.
  const fixed = {
    macArm64: 'Ordewell-mac-arm64.dmg',
    macX64: 'Ordewell-mac-x64.dmg',
    winX64: 'Ordewell-win-x64.exe',
  };
  const installers = {};
  for (const [key, name] of Object.entries(wanted)) {
    const sha256 = sums.get(name);
    if (!sha256) throw new Error(`SHA256SUMS has no ${name}`);
    if (!SHA256.test(sha256)) throw new Error(`${name} has no sha256 in SHA256SUMS`);
    const copy = sums.get(fixed[key]);
    if (copy && copy !== sha256) throw new Error(`${fixed[key]} and ${name} disagree on the hash; the release is inconsistent`);
    installers[key] = { name, sha256 };
  }
  return installers;
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

/** Every file one release publishes to a package manager, by path under `--out`. */
export function renderManifests(version, sumsText) {
  const installers = releaseInstallers(version, parseSums(sumsText));
  return [
    { path: CASK.path, text: renderCask(version, installers) },
    ...renderWinget(version, installers),
  ];
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

const USAGE = 'usage: node scripts/render-package-manifests.mjs --version <x.y.z> --sums <SHA256SUMS> [--out <dir>]';

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const at = args.indexOf(flag);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const version = value('--version');
  const sums = value('--sums');
  const out = value('--out');
  if (!version || !sums || args.includes('-h') || args.includes('--help')) {
    console.error(USAGE);
    process.exit(version && sums ? 0 : 2);
  }
  try {
    const files = renderManifests(version, readFileSync(sums, 'utf8'));
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
