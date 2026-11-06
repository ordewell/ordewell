// The standalone CLI binary's place in ci.yml, cli-build.yml, release.yml and
// scripts/ci.mjs (ADR-0065). change-scope.test.mjs already holds every step id
// to the workflow's rules; this pins what is specific to building, signing and
// releasing the binary.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { CLI_FIXED_ASSETS, FIXED_ASSETS, INSTALL_SCRIPT } from './desktop-release-assets.mjs';
import { STEPS_BY_CHECK } from './change-scope.mjs';

const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
const release = readFileSync('.github/workflows/release.yml', 'utf8');
const cliBuild = readFileSync('.github/workflows/cli-build.yml', 'utf8');
const ciScript = readFileSync('scripts/ci.mjs', 'utf8');

/** The text of one top-level job. */
const job = (workflow, name) => {
  const start = workflow.search(new RegExp(`^  ${name}:$`, 'm'));
  assert.ok(start >= 0, `no job ${name}`);
  const rest = workflow.slice(start + 1);
  const end = rest.search(/^  [\w-]+:$/m);
  return end < 0 ? rest : rest.slice(0, end);
};

/** The text of one step, from its name to the next step. */
const step = (text, name) => {
  const start = text.indexOf(`- name: ${name}\n`);
  assert.ok(start >= 0, `no step ${name}`);
  const rest = text.slice(start + 1);
  const end = rest.search(/^\s+- (?:name|uses):/m);
  return end < 0 ? rest : rest.slice(0, end);
};

const SIGNING_SECRETS = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];

describe('the binary check in ci.yml', () => {
  it('builds and drives the linux-x64 binary after the planner loop has let the mock port go', () => {
    assert.deepEqual(STEPS_BY_CHECK.binary, ['build-binary', 'drive-binary']);
    assert.match(ci, /- name: Build the standalone CLI binary\n\s+id: build-binary\n\s+if: needs\.scope\.outputs\.binary != 'false'\n\s+run: node scripts\/sea\/build\.mjs\n/);
    const drive = step(ci, 'CLI binary — offline e2e, no Node on PATH');
    assert.match(drive, /id: drive-binary/);
    assert.match(drive, /dist-sea\/linux-x64\/ordewell --version/);
    assert.match(drive, /node bench\/live\/drive-binary\.mjs --bin dist-sea\/linux-x64\/ordewell/);
    const at = ['id: build-core', 'id: planner-loop', 'id: build-binary', 'id: drive-binary'].map((id) => ci.indexOf(id));
    assert.deepEqual([...at].sort((a, b) => a - b), at);
  });

  it('is run by scripts/ci.mjs on this host, and skipped on Windows with the reason', () => {
    assert.match(ciScript, /'Build the standalone CLI binary': seaStep\(/);
    assert.match(ciScript, /'CLI binary — offline e2e, no Node on PATH': seaStep\(/);
    assert.match(ciScript, /process\.platform === 'win32'[\s\S]{0,200}Windows installs the CLI with npm/);
  });
});

describe('cli-build.yml', () => {
  const builds = job(cliBuild, 'build');
  const attach = job(cliBuild, 'attach');

  it('runs on a release call, by hand and for a pull request to main that touches what the binary holds', () => {
    assert.match(cliBuild, /^ {2}workflow_call:$/m);
    assert.match(cliBuild, /^ {2}workflow_dispatch:$/m);
    assert.match(cliBuild, /^ {2}pull_request:\n {4}branches: \[ "main" \]\n(?: {4}#.*\n)* {4}paths:\n/m);
    const paths = [...cliBuild.matchAll(/^ {6}- '([^']+)'$/gm)].map((m) => m[1]);
    for (const path of ['packages/cli/**', 'packages/core/**', 'packages/web/**', 'package.json', 'package-lock.json', 'scripts/sea/**', 'packaging/sea/**', 'bench/live/drive-binary.mjs', 'bench/live/mock-provider.mjs', '.github/workflows/cli-build.yml']) {
      assert.ok(paths.includes(path), `${path} can change the binary but does not trigger a build`);
    }
  });

  it('builds each of the four targets on its own native runner, and lets one fail without cancelling the others', () => {
    const targets = [...builds.matchAll(/- target: (\S+)\n\s+os: (\S+)/g)].map(([, target, os]) => [target, os]);
    assert.deepEqual(targets, [['darwin-arm64', 'macos-15'], ['darwin-x64', 'macos-15-intel'], ['linux-x64', 'ubuntu-24.04'], ['linux-arm64', 'ubuntu-24.04-arm']]);
    assert.deepEqual(targets.map(([target]) => `ordewell-${target}.tar.gz`).sort(), [...CLI_FIXED_ASSETS].sort());
    assert.match(builds, /fail-fast: false/);
    assert.match(builds, /runs-on: \$\{\{ matrix\.os \}\}/);
  });

  it('pins every action to a commit SHA: on the release path its jobs hold the certificate and a token that writes', () => {
    const uses = [...cliBuild.matchAll(/^ {6,8}(?:- )?uses: (\S+)(?: # (\S+))?$/gm)].map(([, ref, version]) => ({ ref, version }));
    assert.ok(uses.length >= 4);
    for (const { ref, version } of uses) {
      assert.match(ref, /^actions\/[\w-]+@[0-9a-f]{40}$/, ref);
      assert.match(version ?? '', /^v\d+$/, `${ref} names no version`);
    }
  });

  it('is read-only everywhere except the job that attaches to the Release', () => {
    assert.match(cliBuild, /^permissions:\n {2}contents: read$/m);
    assert.doesNotMatch(builds, /permissions:/);
    assert.match(attach, /permissions:\n\s+contents: write/);
    assert.equal(cliBuild.match(/contents: write/g).length, 1);
    assert.match(attach, /if: inputs\.attach/);
    assert.match(attach, /needs: build/);
  });

  it('checks the tag only on the release path, before anything is installed', () => {
    assert.match(step(builds, 'Verify tag matches package versions'), /if: inputs\.attach\n/);
    assert.ok(builds.indexOf('verify-release-tag.mjs') < builds.indexOf('npm ci'));
  });

  it('builds core, then the binary, then proves it with no Node on PATH, then uploads it', () => {
    const order = ['npm ci', 'npm run build:core', 'node scripts/sea/build.mjs', '--version', 'node bench/live/drive-binary.mjs --bin "dist-sea/${{ matrix.target }}/ordewell"', 'actions/upload-artifact'];
    const at = order.map((needle) => builds.indexOf(needle));
    assert.ok(at.every((i) => i >= 0), `missing: ${order.filter((_, i) => at[i] < 0)}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at);
    const upload = step(builds, 'Upload the archive');
    assert.match(upload, /name: cli-\$\{\{ matrix\.target \}\}/);
    assert.match(upload, /path: dist-sea\/ordewell-\*-\$\{\{ matrix\.target \}\}\.tar\.gz/);
    assert.match(upload, /if-no-files-found: error/);
  });

  it('keeps the drive off ordewell.ai (ADR-0048)', () => {
    assert.match(builds, /ORDEWELL_NO_VERSION_CHECK: '1'/);
  });

  it('signs with the Developer ID only on a macOS release with the certificate, and ad hoc otherwise (ADR-0065 C4)', () => {
    assert.match(builds, /MAC_SIGNING_SET: \$\{\{ inputs\.attach && startsWith\(matrix\.target, 'darwin-'\) && secrets\.CSC_LINK != '' && secrets\.CSC_KEY_PASSWORD != '' \}\}/);
    const imported = step(builds, 'Import the Developer ID certificate');
    assert.match(imported, /if: env\.MAC_SIGNING_SET == 'true'\n/);
    assert.match(imported, /security create-keychain/);
    assert.match(imported, /ORDEWELL_SEA_SIGN_IDENTITY=/);
    assert.ok(builds.indexOf('Import the Developer ID certificate') < builds.indexOf('node scripts/sea/build.mjs'), 'the identity is set before the build signs');
    assert.match(step(builds, 'Verify the macOS signature'), /codesign --verify --strict/);
    assert.match(step(builds, 'Remove the signing keychain'), /if: always\(\) && env\.SEA_KEYCHAIN != ''/);
  });

  it('notarizes only a Developer ID-signed binary, waits for Apple, and passes only "Accepted"', () => {
    assert.match(builds, /MAC_NOTARIZE_SET: \$\{\{ inputs\.attach && startsWith\(matrix\.target, 'darwin-'\) && secrets\.APPLE_API_KEY != '' && secrets\.APPLE_API_KEY_ID != '' && secrets\.APPLE_API_ISSUER != '' \}\}/);
    const notarize = step(builds, 'Notarize the binary');
    assert.match(notarize, /if: env\.MAC_SIGNING_SET == 'true' && env\.MAC_NOTARIZE_SET == 'true'\n/);
    assert.match(notarize, /xcrun notarytool submit "\$zip" "\$\{auth\[@\]\}" --wait/);
    assert.match(notarize, /if \[ "\$status" != "Accepted" \]; then/);
    assert.match(notarize, /trap 'rm -f "\$key" "\$zip"' EXIT/);
    assert.ok(builds.indexOf('Drive the binary offline') < builds.indexOf('- name: Notarize the binary'), 'only a driven binary goes to Apple');
    assert.ok(builds.indexOf('- name: Notarize the binary') < builds.indexOf('- name: Upload the archive'));
    assert.match(builds, /- name: Say why the macOS binary was not notarized\n\s+if: runner\.os == 'macOS' && !\(env\.MAC_SIGNING_SET == 'true' && env\.MAC_NOTARIZE_SET == 'true'\)/);
  });

  it('hands each secret only to the step that uses it, and declares each as optional', () => {
    const jobEnv = builds.slice(builds.indexOf('    env:\n'), builds.indexOf('    steps:'));
    assert.doesNotMatch(jobEnv, /secrets\.\w+ \}\}/, 'a secret is in the job env');
    for (const name of SIGNING_SECRETS) {
      assert.equal((cliBuild.match(new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`, 'g')) ?? []).length, 1, name);
      assert.match(cliBuild, new RegExp(`^ {6}${name}:\\n {8}required: false$`, 'm'), `${name} is not declared`);
    }
    assert.doesNotMatch(cliBuild, /secrets: inherit/);
  });

  it('attaches all four archives or none', () => {
    const upload = step(attach, 'Attach the archives to the GitHub Release');
    assert.match(upload, /if \[ \$\{#files\[@\]\} -ne 4 \]; then/);
    assert.match(upload, /gh release upload "\$TAG" "\$\{files\[@\]\}" --clobber --repo "\$REPO"/);
  });
});

describe('the cli and release-assets jobs in release.yml', () => {
  const cli = job(release, 'cli');
  const assets = job(release, 'release-assets');

  it('calls cli-build.yml to attach to this tag, after the Release exists', () => {
    assert.match(cli, /needs: github-release/);
    assert.match(cli, /uses: \.\/\.github\/workflows\/cli-build\.yml/);
    assert.match(cli, /attach: true/);
    assert.match(cli, /tag: \$\{\{ github\.ref_name \}\}/);
    assert.match(cli, /permissions:\n\s+contents: write/);
  });

  it('passes the macOS signing secrets by name and nothing else', () => {
    assert.doesNotMatch(cli, /secrets: inherit/);
    const passed = [...cli.slice(cli.indexOf('    secrets:\n')).matchAll(/^ {6}(\w+): \$\{\{ secrets\.(\w+) \}\}$/gm)];
    assert.deepEqual(passed.map(([, name, from]) => [name, from]), SIGNING_SECRETS.map((name) => [name, name]));
  });

  it('writes the fixed names, install.sh and SHA256SUMS once both builds have attached, sums last, then marks the Release latest (ADR-0065 C11)', () => {
    assert.match(assets, /needs: \[desktop, cli\]/);
    assert.match(assets, /permissions:\n\s+contents: write/);
    const at = [
      'gh release download "$TAG" --dir release',
      'cp scripts/install/cli.sh release/install.sh',
      'node scripts/desktop-release-assets.mjs release',
      'Ordewell-mac-arm64.dmg',
      'gh release upload "$TAG" release/SHA256SUMS',
      'node scripts/release-latest.mjs "$TAG"',
      'gh release edit "$TAG" --latest',
    ].map((needle) => assets.indexOf(needle));
    assert.ok(at.every((i) => i >= 0), 'download, install.sh, the script, the fixed names, SHA256SUMS, the latest mark');
    assert.deepEqual([...at].sort((a, b) => a - b), at);
    const fixed = step(assets, 'Attach the fixed-name copies and install.sh');
    for (const name of [...FIXED_ASSETS, ...CLI_FIXED_ASSETS, INSTALL_SCRIPT]) assert.ok(fixed.includes(name), `${name} is not uploaded`);
    assert.doesNotMatch(fixed, /SHA256SUMS/);
  });

  it('reads only the versioned files back, so a stale fixed-name copy is rewritten, not listed twice', () => {
    const download = step(assets, 'Download the installers and the CLI archives from the Release');
    const patterns = [...download.matchAll(/--pattern '([^']+)'/g)].map(([, p]) => p);
    assert.deepEqual(patterns, ['Ordewell-*-*-*.dmg', 'Ordewell-*-*-*.zip', 'Ordewell-*-*-*.exe', 'Ordewell-*-*-*.AppImage', 'Ordewell-*-*-*.deb', 'ordewell-*-*-*.tar.gz']);
  });

  it('pins its actions to a commit SHA: it holds a token that writes the Release', () => {
    const uses = [...assets.matchAll(/uses: (\S+)/g)].map(([, ref]) => ref);
    assert.ok(uses.length > 0);
    for (const ref of uses) assert.match(ref, /^actions\/[\w-]+@[0-9a-f]{40}$/, ref);
  });
});
