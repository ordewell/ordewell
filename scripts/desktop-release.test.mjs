// The desktop app's place in ci.yml, release.yml and the scripts that mirror
// them. change-scope.test.mjs already holds every step id to the workflow's
// rules; this pins what is specific to packaging the desktop app.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { STEPS_BY_CHECK, missedSteps, readWorkspaces, selectScope } from './change-scope.mjs';

const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
const release = readFileSync('.github/workflows/release.yml', 'utf8');
const ciScript = readFileSync('scripts/ci.mjs', 'utf8');
const rootManifest = JSON.parse(readFileSync('package.json', 'utf8'));
const workspaces = readWorkspaces();

/** The text of one top-level job. */
const job = (workflow, name) => {
  const start = workflow.search(new RegExp(`^  ${name}:$`, 'm'));
  assert.ok(start >= 0, `no job ${name}`);
  const rest = workflow.slice(start + 1);
  const end = rest.search(/^  [\w-]+:$/m);
  return end < 0 ? rest : rest.slice(0, end);
};

describe('the desktop build check in ci.yml', () => {
  it('is a packages step, so a change to any workspace owes it and a docs change does not', () => {
    assert.ok(STEPS_BY_CHECK.packages.includes('package-desktop'));
    const desktopOnly = selectScope(['packages/desktop/electron-builder.yml'], workspaces);
    const owed = (scope) => missedSteps(scope, {});
    assert.ok(owed(desktopOnly).some((line) => line.startsWith('package-desktop:')));
    assert.ok(!owed(selectScope(['docs/desktop/design.md'], workspaces)).some((line) => line.startsWith('package-desktop:')));
  });

  it('packages before the artifact check reads the installers', () => {
    assert.ok(ci.indexOf('id: package-desktop') > 0);
    assert.ok(ci.indexOf('id: package-desktop') < ci.indexOf('id: verify-artifacts'));
    assert.match(ci, /name: Package the desktop app\n\s+id: package-desktop\n\s+if: needs\.scope\.outputs\.packages != 'false'\n\s+run: npm run desktop:package\n/);
  });

  it('is run by scripts/ci.mjs as the same root script', () => {
    assert.match(ciScript, /'Package the desktop app': \(\) => npm\('run', 'desktop:package'\)/);
    assert.equal(rootManifest.scripts['desktop:package'], 'npm run package -w packages/desktop --');
  });

  it('is read by package-check.mjs, which fails when the installers are missing', () => {
    assert.match(readFileSync('scripts/package-check.mjs', 'utf8'), /checkDesktopPackage\(root\)/);
  });
});

describe('the desktop job in release.yml', () => {
  const desktop = job(release, 'desktop');

  it('builds on macOS, Windows and Linux, and lets one OS fail without cancelling the others', () => {
    assert.match(desktop, /os: \[macos-latest, windows-latest, ubuntu-latest\]/);
    assert.match(desktop, /fail-fast: false/);
    assert.match(desktop, /runs-on: \$\{\{ matrix\.os \}\}/);
  });

  it('waits for the Release it attaches to, and may write to it', () => {
    assert.match(desktop, /needs: github-release/);
    assert.match(desktop, /permissions:\n\s+contents: write/);
    assert.match(desktop, /gh release upload "\$\{\{ github\.ref_name \}\}"/);
  });

  it('checks the tag, packages, and verifies the packaged app before it uploads', () => {
    const order = ['verify-release-tag.mjs', 'npm ci', 'npm run build', 'npm run desktop:package', 'desktop-package-check.mjs', 'gh release upload'];
    const at = order.map((needle) => desktop.indexOf(needle));
    assert.ok(at.every((i) => i >= 0), `missing: ${order.filter((_, i) => at[i] < 0)}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at);
  });

  it('leaves the existing jobs as they were: nothing waits for the installers', () => {
    for (const name of ['ci', 'npm-publish', 'vscode-publish', 'github-release']) assert.ok(job(release, name));
    assert.match(job(release, 'github-release'), /needs: \[npm-publish, vscode-publish\]/);
    assert.doesNotMatch(release.replace(desktop, ''), /needs:.*desktop/);
  });
});

describe('node-pty in the desktop package (ADR-0062 G11)', () => {
  const builder = readFileSync('packages/desktop/electron-builder.yml', 'utf8');

  it('is rebuilt for Electron per architecture and unpacked from the archive', () => {
    assert.match(builder, /^npmRebuild: true$/m);
    assert.match(builder, /^  - node_modules\/node-pty\/\*\*\/\*$/m);
  });

  it('is built by the package step that ci.yml and every release.yml runner run', () => {
    assert.match(job(release, 'desktop'), /run: npm run desktop:package\n/);
    assert.match(ci, /run: npm run desktop:package\n/);
  });
});
