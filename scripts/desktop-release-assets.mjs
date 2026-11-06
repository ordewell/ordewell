#!/usr/bin/env node
// The release assets the one-line installers and the package managers read
// (ADR-0063 H10, ADR-0065): fixed-name copies of the desktop installers and of
// the CLI archives, so https://github.com/ordewell/ordewell/releases/latest/
// download/<name> always resolves, and one SHA256SUMS file over every
// installer, archive, fixed copy and the CLI's install.sh.
//
//   node scripts/desktop-release-assets.mjs <dir> [--partial] [--without-desktop]
//
// <dir> holds the installers electron-builder wrote, named
// Ordewell-<version>-<os>-<arch>.<ext>, the CLI archives named
// ordewell-<version>-<os>-<arch>.tar.gz (os darwin|linux), and install.sh, a
// copy of scripts/install/cli.sh. Without --partial every fixed-name asset
// must be there, install.sh too, and they must agree on one version: a Release
// gets all of them or none, as desktop-build.yml's attach job already does for
// the installers. --partial is for a local directory (`npm run desktop:package`
// on one OS builds some of them), so the installer scripts can be run against
// it.
//
// --without-desktop is a release that leaves the desktop app out (ADR-0065
// C10, release.yml's ORDEWELL_RELEASE_DESKTOP switch off): only the CLI's
// fixed names are made and SHA256SUMS lists only the CLI archives, their copies
// and install.sh, so the CLI's install.sh and the formula need no desktop build.
// A desktop installer in <dir> is then left out, not listed: a SHA256SUMS that
// named one would tell `install.sh --desktop` the release carries the app.
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The five desktop fixed names; the zip is a macOS update payload, not an install download. */
export const FIXED_ASSETS = [
  'Ordewell-mac-arm64.dmg',
  'Ordewell-mac-x64.dmg',
  'Ordewell-win-x64.exe',
  'Ordewell-linux-x64.AppImage',
  'Ordewell-linux-x64.deb',
];

/** The four CLI fixed names, each a copy of the versioned archive it duplicates. */
export const CLI_FIXED_ASSETS = [
  'ordewell-darwin-arm64.tar.gz',
  'ordewell-darwin-x64.tar.gz',
  'ordewell-linux-arm64.tar.gz',
  'ordewell-linux-x64.tar.gz',
];

/** The CLI installer, attached under this name and listed in SHA256SUMS. */
export const INSTALL_SCRIPT = 'install.sh';

export const SUMS_FILE = 'SHA256SUMS';

// A fixed name has no version between "Ordewell-" and the OS, so it never
// matches. The ".blockmap" and "latest*.yml" files do not match either.
const INSTALLER = /^Ordewell-(.+)-(mac|win|linux)-(arm64|x64)\.(dmg|zip|exe|AppImage|deb)$/;
// The CLI's versioned archive. The fixed copy has no version between "ordewell-"
// and the OS, so it never matches either.
const CLI_ARCHIVE = /^ordewell-(.+)-(darwin|linux)-(arm64|x64)\.tar\.gz$/;

/**
 * Reads the installers and CLI archives out of a list of file names. Returns
 * the files that get a fixed-name copy and the version each carries, or throws
 * when two files would claim one fixed name.
 */
export function readInstallers(names) {
  const installers = [];
  for (const name of names) {
    const match = INSTALLER.exec(name);
    if (match) {
      installers.push({ name, version: match[1], fixed: `Ordewell-${match[2]}-${match[3]}.${match[4]}` });
      continue;
    }
    const archive = CLI_ARCHIVE.exec(name);
    if (archive) installers.push({ name, version: archive[1], fixed: `ordewell-${archive[2]}-${archive[3]}.tar.gz` });
  }
  const claimed = new Map();
  for (const installer of installers.filter((i) => FIXED_ASSETS.includes(i.fixed) || CLI_FIXED_ASSETS.includes(i.fixed))) {
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
export async function writeReleaseAssets(dir, { partial = false, withoutDesktop = false } = {}) {
  const read = readInstallers(readdirSync(dir));
  const isCli = (installer) => CLI_FIXED_ASSETS.includes(installer.fixed);
  const installers = withoutDesktop ? read.installers.filter(isCli) : read.installers;
  const claimed = withoutDesktop ? new Map([...read.claimed].filter(([, installer]) => isCli(installer))) : read.claimed;
  if (installers.length === 0) {
    throw new Error(withoutDesktop ? `no ordewell-<version>-<os>-<arch>.tar.gz in ${dir}` : `no Ordewell-<version>-<os>-<arch> installer or ordewell-<version>-<os>-<arch>.tar.gz in ${dir}`);
  }

  const hasScript = readdirSync(dir).includes(INSTALL_SCRIPT);
  const missing = [...(withoutDesktop ? [] : FIXED_ASSETS), ...CLI_FIXED_ASSETS].filter((name) => !claimed.has(name));
  if (!hasScript) missing.push(INSTALL_SCRIPT);
  if (!partial && missing.length > 0) throw new Error(`the release is missing ${missing.join(', ')}`);
  const versions = new Set([...claimed.values()].map((installer) => installer.version));
  if (!partial && versions.size > 1) throw new Error(`the installers and archives disagree on the version: ${[...versions].join(', ')}`);

  for (const [fixed, installer] of claimed) copyFileSync(join(dir, installer.name), join(dir, fixed));

  const names = [...installers.map((installer) => installer.name), ...claimed.keys(), ...(hasScript ? [INSTALL_SCRIPT] : [])].sort();
  const lines = [];
  for (const name of names) lines.push(`${await sha256(join(dir, name))}  ${name}`);
  writeFileSync(join(dir, SUMS_FILE), `${lines.join('\n')}\n`);
  return { fixed: [...claimed.keys()].sort(), sums: names, missing };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const flags = args.filter((arg) => arg.startsWith('--'));
  const dirs = args.filter((arg) => !arg.startsWith('--'));
  if (dirs.length !== 1 || flags.some((flag) => flag !== '--partial' && flag !== '--without-desktop')) {
    console.error('usage: node scripts/desktop-release-assets.mjs <dir> [--partial] [--without-desktop]');
    process.exit(2);
  }
  try {
    const { fixed, sums, missing } = await writeReleaseAssets(dirs[0], { partial: flags.includes('--partial'), withoutDesktop: flags.includes('--without-desktop') });
    console.log(`${SUMS_FILE}: ${sums.length} files; fixed-name copies: ${fixed.join(', ')}`);
    if (missing.length > 0) console.log(`(partial: no ${missing.join(', ')})`);
  } catch (error) {
    console.error(`desktop-release-assets: ${error.message}`);
    process.exit(1);
  }
}
