// The Homebrew formula and cask and the winget manifests the release renders
// (ADR-0063 H11, ADR-0065), on fixed inputs: the templates are the ones the workflow uses, so a placeholder that
// moved or a URL that stopped matching the release's names fails here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { describe, it } from 'node:test';
import {
  CASK,
  FORMULA,
  WINGET_TEMPLATES,
  cliArchives,
  parseSums,
  releaseInstallers,
  renderCask,
  renderFormula,
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
  darwinArm64: '4'.repeat(64),
  darwinX64: '5'.repeat(64),
  linuxArm64: '6'.repeat(64),
  linuxX64: '7'.repeat(64),
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
    [`ordewell-${VERSION}-darwin-arm64.tar.gz`, HASH.darwinArm64],
    [`ordewell-${VERSION}-darwin-x64.tar.gz`, HASH.darwinX64],
    [`ordewell-${VERSION}-linux-arm64.tar.gz`, HASH.linuxArm64],
    [`ordewell-${VERSION}-linux-x64.tar.gz`, HASH.linuxX64],
    ['ordewell-darwin-arm64.tar.gz', HASH.darwinArm64],
    ['ordewell-darwin-x64.tar.gz', HASH.darwinX64],
    ['ordewell-linux-arm64.tar.gz', HASH.linuxArm64],
    ['ordewell-linux-x64.tar.gz', HASH.linuxX64],
    ['install.sh', '8'.repeat(64)],
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

describe('the CLI archives a release publishes', () => {
  const archives = () => cliArchives(VERSION, parseSums(sumsText()));

  it('names the four versioned archives the formula downloads', () => {
    assert.deepEqual(archives(), {
      darwinArm64: { name: `ordewell-${VERSION}-darwin-arm64.tar.gz`, sha256: HASH.darwinArm64 },
      darwinX64: { name: `ordewell-${VERSION}-darwin-x64.tar.gz`, sha256: HASH.darwinX64 },
      linuxArm64: { name: `ordewell-${VERSION}-linux-arm64.tar.gz`, sha256: HASH.linuxArm64 },
      linuxX64: { name: `ordewell-${VERSION}-linux-x64.tar.gz`, sha256: HASH.linuxX64 },
    });
  });

  it('refuses a version that is not x.y.z', () => {
    assert.throws(() => cliArchives('0.0.0-beta.1', parseSums(sumsText())), /is not a version/);
  });

  it('refuses a release whose SHA256SUMS lacks any one archive, naming it', () => {
    for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']) {
      const name = `ordewell-${VERSION}-${target}.tar.gz`;
      assert.throws(() => cliArchives(VERSION, parseSums(sumsText({ [name]: null }))), new RegExp(`no ${name.replaceAll('.', '\\.')}`), target);
    }
  });

  it('refuses a fixed copy that is not the versioned archive it duplicates', () => {
    const sums = parseSums(sumsText({ 'ordewell-linux-arm64.tar.gz': '9'.repeat(64) }));
    assert.throws(() => cliArchives(VERSION, sums), /ordewell-linux-arm64\.tar\.gz and ordewell-0\.0\.0-linux-arm64\.tar\.gz disagree on the hash/);
  });

  it('takes a release whose fixed copies are not listed, as the cask does', () => {
    const fixed = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map((t) => `ordewell-${t}.tar.gz`);
    const sums = parseSums(sumsText(Object.fromEntries(fixed.map((name) => [name, null]))));
    assert.deepEqual(archives(), cliArchives(VERSION, sums));
  });

  it('refuses a hash that is not 64 hex digits in the sums', () => {
    const sums = new Map([[`ordewell-${VERSION}-darwin-arm64.tar.gz`, 'zz']]);
    assert.throws(() => cliArchives(VERSION, sums), /no sha256/);
  });
});

describe('the Homebrew formula', () => {
  const formula = renderFormula(VERSION, cliArchives(VERSION, parseSums(sumsText())));

  it('is Formula/ordewell.rb in the tap, a class named for the token', () => {
    assert.equal(FORMULA.path, 'homebrew/Formula/ordewell.rb');
    assert.match(formula, /^class Ordewell < Formula$/m);
    assert.doesNotMatch(formula, /\{\{/);
    assert.match(readFileSync('packaging/homebrew/ordewell.rb.tmpl', 'utf8'), /\{\{sha256_linux_x64\}\}/, 'the template is a template');
  });

  it('states what the tool is, where it lives and its licence', () => {
    assert.ok(formula.includes('desc "Turn one goal into an ordered plan of coding-agent tasks"'));
    assert.ok(formula.includes('homepage "https://ordewell.ai/"'));
    assert.match(formula, /^ {2}version "0\.0\.0"$/m);
    const licence = /^\s*(Apache License)/m.exec(readFileSync('LICENSE', 'utf8'));
    assert.ok(licence, 'LICENSE is the Apache licence');
    assert.match(formula, /^ {2}license "Apache-2\.0"$/m);
  });

  it('downloads the versioned archive of each platform with that archive\'s own checksum', () => {
    const block = (os, cpu) => new RegExp(`on_${os} do\\n(?:.*\\n)*? {4}on_${cpu} do\\n {6}url "([^"]+)"\\n {6}sha256 "([0-9a-f]{64})"\\n {4}end`);
    const expected = [
      ['macos', 'arm', 'darwin-arm64', HASH.darwinArm64],
      ['macos', 'intel', 'darwin-x64', HASH.darwinX64],
      ['linux', 'arm', 'linux-arm64', HASH.linuxArm64],
      ['linux', 'intel', 'linux-x64', HASH.linuxX64],
    ];
    for (const [os, cpu, target, hash] of expected) {
      const section = formula.slice(formula.indexOf(`on_${os} do`));
      const match = block(os, cpu).exec(section);
      assert.ok(match, `${os} ${cpu}`);
      assert.equal(match[1], `https://github.com/ordewell/ordewell/releases/download/v#{version}/ordewell-#{version}-${target}.tar.gz`);
      assert.equal(match[2], hash);
    }
  });

  it('installs the one executable, checks its version, and follows the latest release', () => {
    assert.match(formula, /^ {2}def install\n {4}bin\.install "ordewell"\n {2}end$/m);
    assert.match(formula, /^ {2}test do\n {4}assert_match version\.to_s, shell_output\("#\{bin\}\/ordewell --version"\)\n {2}end$/m);
    assert.match(formula, /^ {2}livecheck do\n {4}url :stable\n {4}strategy :github_latest\n {2}end$/m);
  });
});

describe('the Homebrew cask', () => {
  const cask = renderCask(VERSION, installers());

  it('pins the version, both architectures and their checksums', () => {
    assert.match(cask, /^cask "ordewell-desktop" do$/m);
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
    assert.equal(CASK.path, 'homebrew/Casks/ordewell-desktop.rb');
    assert.doesNotMatch(cask, /\{\{/);
    assert.match(readFileSync('packaging/homebrew/ordewell-desktop.rb.tmpl', 'utf8'), /\{\{version\}\}/, 'the template is a template');
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
  const tapAndWinget = [FORMULA.path, CASK.path, ...WINGET_TEMPLATES.map(({ name }) => `${wingetDirectory(VERSION)}/${name}`)];

  it('is the formula, the cask and the three winget manifests, from the version and the sums', () => {
    const files = renderManifests(VERSION, sumsText());
    assert.deepEqual(files.map(({ path }) => path), tapAndWinget);
    assert.equal(FORMULA.path, 'homebrew/Formula/ordewell.rb');
    assert.equal(CASK.path, 'homebrew/Casks/ordewell-desktop.rb');
  });

  it('renders one target alone, which needs only the files that target names', () => {
    const noDmgs = sumsText({ [`Ordewell-${VERSION}-mac-arm64.dmg`]: null, [`Ordewell-${VERSION}-mac-x64.dmg`]: null });
    assert.deepEqual(renderManifests(VERSION, noDmgs, { only: ['formula'] }).map(({ path }) => path), [FORMULA.path]);
    assert.throws(() => renderManifests(VERSION, noDmgs, { only: ['cask'] }), /no Ordewell-0\.0\.0-mac-arm64\.dmg/);
    assert.throws(() => renderManifests(VERSION, noDmgs), /no Ordewell-0\.0\.0-mac-arm64\.dmg/);

    const noArchives = sumsText({ [`ordewell-${VERSION}-linux-x64.tar.gz`]: null });
    assert.deepEqual(renderManifests(VERSION, noArchives, { only: ['cask'] }).map(({ path }) => path), [CASK.path]);
    assert.deepEqual(renderManifests(VERSION, noArchives, { only: ['winget'] }).map(({ path }) => path), tapAndWinget.slice(2));
    assert.throws(() => renderManifests(VERSION, noArchives, { only: ['formula'] }), /no ordewell-0\.0\.0-linux-x64\.tar\.gz/);
  });

  it('fails the whole render, not just one file, when a hash disagrees', () => {
    assert.throws(() => renderManifests(VERSION, sumsText({ 'ordewell-darwin-x64.tar.gz': '9'.repeat(64) })), /disagree on the hash/);
    assert.throws(() => renderManifests(VERSION, sumsText({ 'Ordewell-mac-x64.dmg': '9'.repeat(64) })), /disagree on the hash/);
  });

  it('refuses a target it does not know', () => {
    assert.throws(() => renderManifests(VERSION, sumsText(), { only: ['scoop'] }), /unknown target "scoop"/);
  });

  const made = [];
  after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

  it('writes the files under the output directory, creating the directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-manifests-'));
    made.push(dir);
    const written = writeManifests(dir, renderManifests(VERSION, sumsText()));
    assert.equal(written.length, 5);
    assert.match(readFileSync(join(dir, 'homebrew', 'Casks', 'ordewell-desktop.rb'), 'utf8'), /^cask "ordewell-desktop" do$/m);
    assert.match(readFileSync(join(dir, 'homebrew', 'Formula', 'ordewell.rb'), 'utf8'), /^class Ordewell < Formula$/m);
    const version = readFileSync(join(dir, 'winget', 'manifests', 'o', 'Ordewell', 'Ordewell', VERSION, 'Ordewell.Ordewell.yaml'), 'utf8');
    assert.match(version, /^PackageVersion: 0\.0\.0$/m);
  });

  const render = (dir, ...args) => {
    const sums = join(dir, 'SHA256SUMS');
    writeFileSync(sums, sumsText());
    return spawnSync(process.execPath, ['scripts/render-package-manifests.mjs', '--version', VERSION, '--sums', sums, ...args], { encoding: 'utf8' });
  };

  it('is a command: --only picks the files, --out names the folder, a bad flag exits 2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-manifests-cli-'));
    made.push(dir);
    const out = join(dir, 'out');
    const formula = render(dir, '--only', 'formula', '--out', out);
    assert.equal(formula.status, 0, formula.stderr);
    assert.deepEqual(readdirSync(out, { recursive: true }).map((p) => p.replaceAll('\\', '/')).filter((p) => p.endsWith('.rb')), ['homebrew/Formula/ordewell.rb']);
    const both = render(dir, '--only', 'formula', '--only', 'cask');
    assert.equal(both.status, 0, both.stderr);
    assert.match(both.stdout, /^==> homebrew\/Formula\/ordewell\.rb$/m);
    assert.match(both.stdout, /^==> homebrew\/Casks\/ordewell-desktop\.rb$/m);
    assert.doesNotMatch(both.stdout, /==> winget/);
    const bad = render(dir, '--only', 'scoop');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /unknown target "scoop"/);
    assert.equal(render(dir, '--only').status, 2);
  });

  // The syntax check is the only thing here that needs Ruby, which Windows runners and
  // most dev machines lack; it is skipped, not faked, when `ruby` is not on PATH.
  const ruby = spawnSync('ruby', ['-v'], { encoding: 'utf8' });
  const hasRuby = ruby.status === 0;
  it('renders Ruby that `ruby -c` accepts', { skip: hasRuby ? false : 'ruby is not on PATH' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-ruby-'));
    made.push(dir);
    for (const { path, text } of renderManifests(VERSION, sumsText(), { only: ['formula', 'cask'] })) {
      const file = join(dir, path.slice(path.lastIndexOf('/') + 1));
      writeFileSync(file, text);
      const check = spawnSync('ruby', ['-c', file], { encoding: 'utf8' });
      assert.equal(check.status, 0, `${path}: ${check.stdout}${check.stderr}`);
    }
  });
});
