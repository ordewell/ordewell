#!/usr/bin/env node
// The release assets the one-line installers read (ADR-0063 H10): fixed-name
// copies of the installers, so https://github.com/ordewell/ordewell/releases/
// latest/download/<name> always resolves, and a SHA256SUMS file over every
// installer, versioned name and fixed name alike.
//
//   node scripts/desktop-release-assets.mjs <dir> [--partial]
//
// <dir> holds the installers electron-builder wrote, named
// Ordewell-<version>-<os>-<arch>.<ext>. Without --partial every fixed-name
// asset must be there and agree on one version: a Release gets all of them or
// none, as desktop-build.yml's attach job already does for the installers.
// --partial is for a local directory (`npm run desktop:package` on one OS
// builds some of them), so the installer scripts can be run against it.
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The five fixed names; the zip is a macOS update payload, not an install download. */
export const FIXED_ASSETS = [
  'Ordewell-mac-arm64.dmg',
  'Ordewell-mac-x64.dmg',
  'Ordewell-win-x64.exe',
  'Ordewell-linux-x64.AppImage',
  'Ordewell-linux-x64.deb',
];

export const SUMS_FILE = 'SHA256SUMS';

// A fixed name has no version between "Ordewell-" and the OS, so it never
// matches. The ".blockmap" and "latest*.yml" files do not match either.
const INSTALLER = /^Ordewell-(.+)-(mac|win|linux)-(arm64|x64)\.(dmg|zip|exe|AppImage|deb)$/;

/**
 * Reads the installers out of a list of file names. Returns the files that
 * get a fixed-name copy and the version each carries, or throws when two files
 * would claim one fixed name.
 */
export function readInstallers(names) {
  const installers = [];
  for (const name of names) {
    const match = INSTALLER.exec(name);
    if (match) installers.push({ name, version: match[1], fixed: `Ordewell-${match[2]}-${match[3]}.${match[4]}` });
  }
  const claimed = new Map();
  for (const installer of installers.filter((i) => FIXED_ASSETS.includes(i.fixed))) {
    const other = claimed.get(installer.fixed);
    if (other) throw new Error(`${other.name} and ${installer.name} would both become ${installer.fixed}; remove the stale one`);
    claimed.set(installer.fixed, installer);
  }
  return { installers, claimed };
}

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Writes the fixed-name copies and SHA256SUMS into `dir`, in `sha256sum -c`
 * format (two spaces between the hash and the name). Returns what it wrote.
 */
export async function writeReleaseAssets(dir, { partial = false } = {}) {
  const { installers, claimed } = readInstallers(readdirSync(dir));
  if (installers.length === 0) throw new Error(`no Ordewell-<version>-<os>-<arch> installer in ${dir}`);

  const missing = FIXED_ASSETS.filter((name) => !claimed.has(name));
  if (!partial && missing.length > 0) throw new Error(`the release is missing ${missing.join(', ')}`);
  const versions = new Set([...claimed.values()].map((installer) => installer.version));
  if (!partial && versions.size > 1) throw new Error(`the installers disagree on the version: ${[...versions].join(', ')}`);

  for (const [fixed, installer] of claimed) copyFileSync(join(dir, installer.name), join(dir, fixed));

  const names = [...installers.map((installer) => installer.name), ...claimed.keys()].sort();
  const lines = [];
  for (const name of names) lines.push(`${await sha256(join(dir, name))}  ${name}`);
  writeFileSync(join(dir, SUMS_FILE), `${lines.join('\n')}\n`);
  return { fixed: [...claimed.keys()].sort(), sums: names, missing };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const partial = args.includes('--partial');
  const dirs = args.filter((arg) => !arg.startsWith('--'));
  if (dirs.length !== 1) {
    console.error('usage: node scripts/desktop-release-assets.mjs <dir> [--partial]');
    process.exit(2);
  }
  try {
    const { fixed, sums, missing } = await writeReleaseAssets(dirs[0], { partial });
    console.log(`${SUMS_FILE}: ${sums.length} files; fixed-name copies: ${fixed.join(', ')}`);
    if (missing.length > 0) console.log(`(partial: no ${missing.join(', ')})`);
  } catch (error) {
    console.error(`desktop-release-assets: ${error.message}`);
    process.exit(1);
  }
}
