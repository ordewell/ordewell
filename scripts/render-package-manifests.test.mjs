// The cask and winget manifests the release renders (ADR-0063 H11), on fixed
// inputs: the templates are the ones the workflow uses, so a placeholder that
// moved or a URL that stopped matching the release's names fails here.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { describe, it } from 'node:test';
import {
  CASK,
  WINGET_TEMPLATES,
  parseSums,
  releaseInstallers,
  renderCask,
  renderManifests,
  renderWinget,
  wingetDirectory,
  writeManifests,
} from './render-package-manifests.mjs';

const VERSION = '0.0.0';
const HASH = {
  macArm64: '1'.repeat(64),
  macX64: '2'.repeat(64),
  winX64: '3'.repeat(64),
};

/**
 * SHA256SUMS as desktop-release-assets.mjs writes it: versioned and fixed names,
 * one hash each. `changes` replaces a name's hash, or drops the line with null.
 */
const sumsText = (changes = {}) => {
  const lines = [
    [`Ordewell-${VERSION}-mac-arm64.dmg`, HASH.macArm64],
    [`Ordewell-${VERSION}-mac-x64.dmg`, HASH.macX64],
    [`Ordewell-${VERSION}-win-x64.exe`, HASH.winX64],
    ['Ordewell-mac-arm64.dmg', HASH.macArm64],
    ['Ordewell-mac-x64.dmg', HASH.macX64],
    ['Ordewell-win-x64.exe', HASH.winX64],
  ];
  return `${lines
    .filter(([name]) => changes[name] !== null)
    .map(([name, hash]) => `${changes[name] ?? hash}  ${name}`)
    .join('\n')}\n`;
};

const installers = () => releaseInstallers(VERSION, parseSums(sumsText()));

describe('SHA256SUMS', () => {
  it('reads the versioned and the fixed names, in either hash format', () => {
    const sums = parseSums(`${HASH.macArm64}  Ordewell-mac-arm64.dmg\n${HASH.winX64} *Ordewell-win-x64.exe\n`);
    assert.deepEqual([...sums], [
      ['Ordewell-mac-arm64.dmg', HASH.macArm64],
      ['Ordewell-win-x64.exe', HASH.winX64],
    ]);
  });

  it('ignores blank lines and anything that is not a checksum line', () => {
    assert.equal(parseSums(`\n# a comment\nnot a hash  Ordewell-mac-arm64.dmg\n\n${HASH.macX64}  Ordewell-mac-x64.dmg\n`).size, 1);
  });
});

describe('the installers a release publishes', () => {
  it('names the three files the cask and the winget manifests download', () => {
    assert.deepEqual(installers(), {
      macArm64: { name: `Ordewell-${VERSION}-mac-arm64.dmg`, sha256: HASH.macArm64 },
      macX64: { name: `Ordewell-${VERSION}-mac-x64.dmg`, sha256: HASH.macX64 },
      winX64: { name: `Ordewell-${VERSION}-win-x64.exe`, sha256: HASH.winX64 },
    });
  });

  it('refuses a version that is not x.y.z', () => {
    for (const version of ['v0.0.0', '0.0', '0.0.0-beta.1', '']) {
      assert.throws(() => releaseInstallers(version, parseSums(sumsText())), /is not a version/, version);
    }
  });

  it('refuses a release whose SHA256SUMS lacks one of the three installers', () => {
    const sums = parseSums(sumsText({ [`Ordewell-${VERSION}-win-x64.exe`]: null }));
    assert.throws(() => releaseInstallers(VERSION, sums), /no Ordewell-0\.0\.0-win-x64\.exe/);
  });

  it('refuses a fixed-name copy that is not the versioned file it duplicates', () => {
    const sums = parseSums(sumsText({ 'Ordewell-mac-arm64.dmg': '4'.repeat(64) }));
    assert.throws(() => releaseInstallers(VERSION, sums), /disagree on the hash/);
  });
});

describe('the Homebrew cask', () => {
  const cask = renderCask(VERSION, installers());

  it('pins the version, both architectures and their checksums', () => {
    assert.match(cask, /^cask "ordewell" do$/m);
    assert.match(cask, /^ {2}arch arm: "arm64", intel: "x64"$/m);
    assert.match(cask, /^ {2}version "0\.0\.0"$/m);
    assert.match(cask, new RegExp(`^ {2}sha256 arm: {3}"${HASH.macArm64}",\\n {9}intel: "${HASH.macX64}"$`, 'm'));
  });

  it('downloads the versioned installer for the architecture it runs on', () => {
    assert.ok(cask.includes('releases/download/v#{version}/Ordewell-#{version}-mac-#{arch}.dmg'));
    assert.doesNotMatch(cask, /on_arm|on_intel/, 'the arch stanza names the file, so no per-arch blocks are needed');
  });

  it('installs the app, needs the macOS the Electron build needs, and lets it update itself', () => {
    assert.match(cask, /^ {2}app "Ordewell\.app"$/m);
    assert.match(cask, /^ {2}depends_on macos: :ventura$/m);
    assert.match(cask, /^ {2}auto_updates true$/m);
    assert.ok(cask.includes('desc "Turn one goal into an ordered plan of coding-agent tasks"'));
    assert.ok(cask.includes('homepage "https://ordewell.ai/"'));
    assert.match(cask, /^ {2}livecheck do\n {4}url :url\n {4}strategy :github_latest\n {2}end$/m);
  });

  it('zaps the app data Electron writes, named as Electron names it', () => {
    assert.ok(cask.includes('"~/Library/Application Support/@ordewell/desktop"'));
    assert.ok(cask.includes('"~/Library/Preferences/ai.ordewell.desktop.plist"'));
    assert.ok(cask.includes('"~/Library/Saved Application State/ai.ordewell.desktop.savedState"'));
  });

  it('is a cask file for the tap, and leaves no placeholder behind', () => {
    assert.equal(CASK.path, 'homebrew/Casks/ordewell.rb');
    assert.doesNotMatch(cask, /\{\{/);
    assert.match(readFileSync('packaging/homebrew/ordewell.rb.tmpl', 'utf8'), /\{\{version\}\}/, 'the template is a template');
  });
});

describe('the winget manifests', () => {
  const manifests = renderWinget(VERSION, installers());
  const byName = new Map(manifests.map(({ path, text }) => [path.slice(path.lastIndexOf('/') + 1), text]));

  it('are the three files winget-pkgs expects, under the package path', () => {
    assert.deepEqual([...byName.keys()].sort(), [
      'Ordewell.Ordewell.installer.yaml',
      'Ordewell.Ordewell.locale.en-US.yaml',
      'Ordewell.Ordewell.yaml',
    ]);
    assert.equal(wingetDirectory(VERSION), 'winget/manifests/o/Ordewell/Ordewell/0.0.0');
    for (const { path } of manifests) assert.ok(path.startsWith(`winget/manifests/o/Ordewell/Ordewell/${VERSION}/`), path);
    assert.equal(manifests.length, WINGET_TEMPLATES.length);
  });

  it('state the identifier, the version and the schema each file uses', () => {
    for (const text of byName.values()) {
      assert.match(text, /^PackageIdentifier: Ordewell\.Ordewell$/m);
      assert.match(text, /^PackageVersion: 0\.0\.0$/m);
      assert.match(text, /^ManifestVersion: 1\.12\.0$/m);
      assert.doesNotMatch(text, /\{\{/);
    }
    assert.match(byName.get('Ordewell.Ordewell.yaml'), /^ManifestType: version$/m);
    assert.match(byName.get('Ordewell.Ordewell.installer.yaml'), /^ManifestType: installer$/m);
    assert.match(byName.get('Ordewell.Ordewell.locale.en-US.yaml'), /^ManifestType: defaultLocale$/m);
  });

  it('open with the schema header winget-pkgs validates, one per manifest type', () => {
    const header = (type) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.1.12.0.schema.json`;
    assert.ok(byName.get('Ordewell.Ordewell.yaml').startsWith(header('version')));
    assert.ok(byName.get('Ordewell.Ordewell.installer.yaml').startsWith(header('installer')));
    assert.ok(byName.get('Ordewell.Ordewell.locale.en-US.yaml').startsWith(header('defaultLocale')));
  });

  it('install the per-user NSIS build silently from the versioned installer, with its checksum', () => {
    const installer = byName.get('Ordewell.Ordewell.installer.yaml');
    assert.match(installer, /^InstallerType: nullsoft$/m);
    assert.match(installer, /^ {2}- Architecture: x64$/m);
    assert.match(installer, /^ {4}Scope: user$/m);
    assert.match(installer, /^ {6}Silent: \/S$/m);
    assert.match(installer, /^ {4}UpgradeBehavior: install$/m);
    assert.ok(installer.includes('https://github.com/ordewell/ordewell/releases/download/v0.0.0/Ordewell-0.0.0-win-x64.exe'));
    assert.match(installer, new RegExp(`^ {4}InstallerSha256: ${HASH.winX64}$`, 'm'));
  });

  it('carry the publisher, name, licence and homepage winget shows', () => {
    const locale = byName.get('Ordewell.Ordewell.locale.en-US.yaml');
    assert.match(locale, /^Publisher: Alessandro Costanzo Ciano$/m);
    assert.match(locale, /^PackageName: Ordewell$/m);
    assert.match(locale, /^License: Apache-2\.0$/m);
    assert.match(locale, /^LicenseUrl: https:\/\/github\.com\/ordewell\/ordewell\/blob\/main\/LICENSE$/m);
    assert.match(locale, /^PackageUrl: https:\/\/ordewell\.ai$/m);
    assert.match(locale, /^PackageLocale: en-US$/m);
  });
});

describe('rendering a release', () => {
  it('is the cask and the three winget manifests, from the version and the sums', () => {
    const files = renderManifests(VERSION, sumsText());
    assert.equal(files.length, 4);
    assert.equal(files[0].path, 'homebrew/Casks/ordewell.rb');
    assert.deepEqual(files.slice(1).map(({ path }) => path), WINGET_TEMPLATES.map(({ name }) => `${wingetDirectory(VERSION)}/${name}`));
  });

  const made = [];
  after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

  it('writes the files under the output directory, creating the directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-manifests-'));
    made.push(dir);
    const written = writeManifests(dir, renderManifests(VERSION, sumsText()));
    assert.equal(written.length, 4);
    assert.match(readFileSync(join(dir, 'homebrew', 'Casks', 'ordewell.rb'), 'utf8'), /^cask "ordewell" do$/m);
    const version = readFileSync(join(dir, 'winget', 'manifests', 'o', 'Ordewell', 'Ordewell', VERSION, 'Ordewell.Ordewell.yaml'), 'utf8');
    assert.match(version, /^PackageVersion: 0\.0\.0$/m);
  });
});
