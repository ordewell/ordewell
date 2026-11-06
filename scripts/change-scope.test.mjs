import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  ALWAYS_STEPS,
  CHECKS,
  GUARD_TESTS,
  STEPS_BY_CHECK,
  STEPS_BY_JOB,
  WINDOWS_JOBS,
  changedInPullRequest,
  coverageLegs,
  fullScope,
  gateFailures,
  localRuns,
  missedSteps,
  readWorkspaces,
  scopeForEvent,
  selectScope,
  uncommittedPaths,
  windowsRuns,
} from './change-scope.mjs';

const workspaces = readWorkspaces();
const CORE = 'packages/core';
const CLI = 'packages/cli';
const WEB = 'packages/web';
const UI = 'packages/ui';
const VSCODE = 'packages/vscode';
const DESKTOP = 'packages/desktop';
const selected = (...paths) => selectScope(paths, workspaces);
const onChecks = (scope) => Object.entries(scope.checks).filter(([, on]) => on).map(([check]) => check).sort();
const offChecks = (scope) => Object.entries(scope.checks).filter(([, on]) => !on).map(([check]) => check).sort();

describe('the workspace graph', () => {
  it('comes from the manifests: web, cli and ui on core, cli on web, vscode on core and ui, desktop on core, ui and web', () => {
    const edges = Object.fromEntries(workspaces.map((w) => [w.dir, [...w.deps].sort()]));
    assert.deepEqual(edges, { [CORE]: [], [UI]: [CORE], [VSCODE]: [CORE, UI], [CLI]: [CORE, WEB], [WEB]: [CORE], [DESKTOP]: [CORE, UI, WEB] });
  });

  it('holds every package a source file reaches by a relative path', () => {
    // vitest mocks @ordewell/core with core's source and cli reaches into web
    // the same way, so a manifest could understate what a test imports.
    const reach = /(?:from |import\(|require\()['"](?:\.\.\/)+(core|cli|web|ui|vscode|desktop)\//g;
    const scan = (dir, owner) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'dist') scan(path, owner); continue; }
        if (!/\.(ts|tsx|mjs)$/.test(entry.name)) continue;
        for (const [, reached] of readFileSync(path, 'utf8').matchAll(reach)) {
          const target = `packages/${reached}`;
          if (target === owner.dir) continue;
          assert.ok(owner.deps.includes(target), `${path} reaches ${target}, which ${owner.dir}/package.json does not declare`);
        }
      }
    };
    for (const owner of workspaces) scan(join(owner.dir, owner.dir === WEB ? 'server' : 'src'), owner);
  });
});

describe('a change inside workspaces', () => {
  it('takes core\'s dependents with core, quick: vitest cannot follow them through dist', () => {
    const scope = selected('packages/core/src/services/createSession.ts');
    assert.equal(scope.mode, 'selected');
    assert.deepEqual(scope.suites, { [CORE]: 'full', [UI]: 'quick', [VSCODE]: 'quick', [CLI]: 'quick', [WEB]: 'quick', [DESKTOP]: 'quick' });
    assert.deepEqual(offChecks(scope), ['tour']);
  });

  it('takes the cli and desktop with web, drives the app on the daemon, and leaves core, vscode and what only they prove', () => {
    const scope = selected('packages/web/server/routes/settings.ts');
    assert.deepEqual([...scope.workspaces].sort(), [CLI, DESKTOP, WEB]);
    assert.deepEqual(offChecks(scope), ['engine', 'integration', 'planner', 'sandbox', 'tour']);
  });

  it('keeps a cli change to the cli', () => {
    const scope = selected('packages/cli/src/tui/view.ts');
    assert.deepEqual(scope.workspaces, [CLI]);
    assert.deepEqual(offChecks(scope), ['desktop', 'engine', 'integration', 'planner', 'sandbox', 'tour']);
  });

  it('takes vscode and desktop with ui, and runs the real VS Code and the app for it: both draw from ui\'s dist', () => {
    const scope = selected('packages/ui/src/chat/App.tsx');
    assert.deepEqual(scope.workspaces, [UI, VSCODE, DESKTOP]);
    assert.deepEqual(offChecks(scope), ['binary', 'engine', 'planner', 'sandbox']);
  });

  it('runs the real VS Code for a vscode change, and no container or app', () => {
    const scope = selected('packages/vscode/src/extension.ts');
    assert.deepEqual(scope.workspaces, [VSCODE]);
    assert.deepEqual(offChecks(scope), ['binary', 'desktop', 'engine', 'planner', 'sandbox', 'tour']);
  });

  it('keeps a desktop change to desktop and drives the app for it: nothing is built on it, and no container or VS Code proves it', () => {
    const scope = selected('packages/desktop/src/main/daemon/DaemonManager.ts');
    assert.deepEqual(scope.workspaces, [DESKTOP]);
    assert.deepEqual(offChecks(scope), ['binary', 'engine', 'integration', 'planner', 'sandbox', 'windows']);
    assert.equal(scope.checks.desktop, true);
    assert.equal(scope.checks.tour, true);
  });

  it('owes the visual tour for what draws it, desktop and ui, and the app\'s drive for whatever reaches desktop', () => {
    for (const [path, tour, desktop] of [
      ['packages/desktop/src/main/index.ts', true, true],
      ['packages/ui/src/chat/App.tsx', true, true],
      ['packages/web/server/main.ts', false, true],
      ['packages/core/src/index.ts', false, true],
      ['packages/core/src/services/PlanPrompts.ts', false, true],
      ['packages/cli/src/tui/view.ts', false, false],
      ['packages/vscode/src/extension.ts', false, false],
      ['docs/a.md', false, false],
    ]) {
      const { checks } = selected(path);
      assert.deepEqual({ tour: checks.tour, desktop: checks.desktop }, { tour, desktop }, path);
    }
  });

  it('drives the app and walks the tour for a change to the fakes and mock they run on', () => {
    for (const path of ['bench/live/mock-provider.mjs', 'bench/pipeline/fake-claude/fake-claude.mjs']) {
      const scope = selected(path);
      assert.equal(scope.mode, 'selected', path);
      assert.equal(scope.checks.desktop, true, path);
      assert.equal(scope.checks.tour, true, path);
    }
  });

  it('builds and drives the standalone binary for whatever reaches the cli: it bundles the cli, web and core', () => {
    for (const path of ['packages/cli/src/sea.ts', 'packages/web/server/daemon.ts', 'packages/core/src/index.ts']) {
      const scope = selected(path);
      assert.equal(scope.mode, 'selected', path);
      assert.equal(scope.checks.binary, true, path);
    }
    for (const path of ['packages/ui/src/chat/App.tsx', 'packages/vscode/src/extension.ts', 'packages/desktop/src/main/index.ts']) {
      assert.equal(selected(path).checks.binary, false, path);
    }
    assert.deepEqual(STEPS_BY_CHECK.binary, ['build-binary', 'drive-binary']);
  });

  it('treats a package\'s own build or test config as that package', () => {
    assert.deepEqual([...selected('packages/web/vitest.config.ts').workspaces].sort(), [CLI, DESKTOP, WEB]);
    assert.deepEqual([...selected('packages/core/vitest.config.ts').workspaces].sort(), [CLI, CORE, DESKTOP, UI, VSCODE, WEB]);
    assert.deepEqual(selected('packages/desktop/electron-builder.yml').workspaces, [DESKTOP]);
  });

  it('keeps the packaging scripts to desktop, with the bench step that holds their tests', () => {
    for (const path of ['packages/desktop/scripts/package.mjs', 'packages/desktop/scripts/esigner-sign.mjs']) {
      const scope = selected(path);
      assert.deepEqual(scope.workspaces, [DESKTOP], path);
      assert.equal(scope.checks.bench, true, path);
      assert.equal(scope.checks.package, true, path);
    }
    assert.deepEqual(STEPS_BY_CHECK.bench, ['bench']);
  });

  it('owes a package\'s own README, changelog and authors only its artifacts, which ship them', () => {
    for (const path of ['packages/cli/README.md', 'packages/vscode/CHANGELOG.md', 'packages/web/AUTHORS.md']) {
      const scope = selected(path);
      assert.deepEqual(scope.suites, {}, path);
      assert.deepEqual(onChecks(scope), ['package'], path);
    }
  });

  it('runs a workspace in full and everything built on it quick, at the highest tier any path asks', () => {
    const scope = selected('packages/web/server/main.ts', 'packages/cli/src/tui/view.ts');
    assert.deepEqual(scope.suites, { [CLI]: 'full', [WEB]: 'full', [DESKTOP]: 'quick' });
    assert.deepEqual(scope.windowsSuites, { [CLI]: 'full', [WEB]: 'full' });
  });

  it('unions what several changes need, docs among them', () => {
    const scope = selected('docs/containers.md', 'packages/vscode/src/extension.ts', 'packages/web/server/main.ts');
    assert.equal(scope.mode, 'selected');
    assert.deepEqual([...scope.workspaces].sort(), [CLI, DESKTOP, VSCODE, WEB]);
  });
});

describe('core\'s public surface', () => {
  // What tsup builds is what core's package.json can export: read it from the
  // build script, not from the exports selection reads.
  const built = readFileSync('packages/core/package.json', 'utf8').match(/"build": "tsup ([^"]*)/)[1]
    .split(' ').filter((arg) => /^src\/.+\.ts$/.test(arg)).map((arg) => `${CORE}/${arg}`);
  const dependentsFull = (path) => Object.entries(selected(path).suites).every(([, tier]) => tier === 'full');

  it('is every entry core builds, each running every dependent in full', () => {
    assert.ok(built.length >= 5, built.join(' '));
    for (const path of built) {
      assert.ok(dependentsFull(path), path);
      assert.deepEqual(Object.keys(selected(path).suites).sort(), [CLI, CORE, DESKTOP, UI, VSCODE, WEB], path);
    }
  });

  it('is the protocol types the daemon and its clients speak, which index.ts re-exports', () => {
    const index = readFileSync(`${CORE}/src/index.ts`, 'utf8');
    for (const [path, from] of [[`${CORE}/src/daemonContract.ts`, './daemonContract'], [`${CORE}/src/services/SessionMessage.ts`, './services/SessionMessage']]) {
      assert.ok(index.includes(`from '${from}'`), from);
      assert.ok(dependentsFull(path), path);
    }
  });

  it('is not the modules behind the entries: their dependents run quick', () => {
    for (const path of [`${CORE}/src/testEnv.ts`, `${CORE}/src/services/PlanPrompts.ts`, `${CORE}/src/services/__tests__/PlanPrompts.test.ts`]) {
      const { suites } = selected(path);
      assert.equal(suites[CORE], 'full', path);
      assert.deepEqual(Object.values(suites).filter((tier) => tier === 'quick').length, 5, path);
    }
  });

  it('is core\'s alone: another workspace\'s entry runs its dependents quick', () => {
    assert.deepEqual(selected('packages/ui/src/index.ts').suites, { [UI]: 'full', [VSCODE]: 'quick', [DESKTOP]: 'quick' });
  });
});

describe('what a pull request owes, diff by diff', () => {
  // By workspace name, the tier each suite runs at, on Linux and on Windows,
  // and the checks left out. Written from the workspace graph by hand.
  const owed = (scope) => {
    const tiers = (suites) => Object.fromEntries(Object.entries(suites).map(([dir, tier]) => [dir.split('/').at(-1), tier]));
    return { mode: scope.mode, linux: tiers(scope.suites), windows: tiers(scope.windowsSuites), off: offChecks(scope) };
  };
  const ALL_OFF = ['bench', 'binary', 'desktop', 'engine', 'harness', 'integration', 'lint', 'package', 'planner', 'sandbox', 'suites', 'tour', 'typecheck', 'windows'];
  const nothing = { mode: 'docs', linux: {}, windows: {}, off: ALL_OFF };
  const everything = (mode) => ({
    mode,
    linux: { core: 'full', ui: 'full', vscode: 'full', cli: 'full', web: 'full', desktop: 'full' },
    windows: { core: 'full', vscode: 'full', cli: 'full', web: 'full' },
    off: [],
  });
  const pr146 = [
    'CHANGELOG.md', 'CONTEXT.md', 'README.md', 'docs/adr/planner-envelope/0026-one-envelope-for-every-planner.md',
    'docs/adr/platform/0010-windows-support.md', 'docs/troubleshooting.md', 'packages/cli/README.md',
    'packages/cli/src/tui/__tests__/index.test.ts', 'packages/cli/src/tui/__tests__/terminal.test.ts', 'packages/cli/src/tui/index.ts',
    'packages/cli/src/tui/terminal.ts', 'packages/core/src/services/AiService.ts', 'packages/core/src/services/PlanPrompts.ts',
    'packages/core/src/services/__tests__/CliAgentAiService.test.ts', 'packages/core/src/services/__tests__/PlanPrompts.test.ts',
    'packages/core/src/services/__tests__/codexTaskMode.test.ts', 'packages/core/src/services/__tests__/harnessTestKit.ts',
    'packages/core/src/services/harness/CliAgentAiService.ts', 'packages/core/src/services/harness/CodexAdapter.ts',
    'packages/core/src/services/harness/__tests__/nativeShell.test.ts', 'packages/core/src/services/harness/codexOrdewell.ts',
    'packages/core/src/services/harness/codexRpc.ts', 'packages/core/src/services/harness/codexSandbox.ts',
    'packages/core/src/services/harness/nativeShell.ts', 'packages/vscode/CHANGELOG.md', 'packages/vscode/README.md',
  ];

  for (const [title, paths, expected] of [
    ['PR #146: core and cli in full, what is built on them quick, and no tour', pr146, {
      mode: 'selected',
      linux: { core: 'full', ui: 'quick', vscode: 'quick', cli: 'full', web: 'quick', desktop: 'quick' },
      windows: { core: 'full', vscode: 'quick', cli: 'full', web: 'quick' },
      off: ['tour'],
    }],
    ['a README alone: nothing past the checks every change owes', ['README.md'], nothing],
    ['bench/README.md: prose under bench/', ['bench/README.md'], nothing],
    ['.eslintrc.js: lint, and the ui test that lints with it', ['.eslintrc.js'], {
      mode: 'selected', linux: { ui: 'quick' }, windows: {}, off: ALL_OFF.filter((c) => !['lint', 'suites'].includes(c)),
    }],
    ['vitest.setup.ts: every suite in full, everywhere vitest runs', ['vitest.setup.ts'], {
      mode: 'selected', ...everything('selected'), off: ['bench', 'binary', 'desktop', 'harness', 'integration', 'package', 'planner', 'tour', 'typecheck'],
    }],
    ['.gitattributes: the Windows suites and harness, whose checkouts it changes', ['.gitattributes'], {
      mode: 'selected', linux: {}, windows: { core: 'full', vscode: 'full', cli: 'full', web: 'full' },
      off: ALL_OFF.filter((c) => !['windows', 'harness'].includes(c)),
    }],
    ['a desktop change: desktop in full, its drive and tour, no Windows suite', ['packages/desktop/src/main/index.ts'], {
      mode: 'selected', linux: { desktop: 'full' }, windows: {}, off: ['binary', 'engine', 'integration', 'planner', 'sandbox', 'windows'],
    }],
    ['a ui change: ui in full, vscode and desktop quick, the tour', ['packages/ui/src/chat/App.tsx'], {
      mode: 'selected', linux: { ui: 'full', vscode: 'quick', desktop: 'quick' }, windows: { vscode: 'quick' },
      off: ['binary', 'engine', 'planner', 'sandbox'],
    }],
    ['a web change: web in full, cli and desktop quick, no tour', ['packages/web/server/routes/settings.ts'], {
      mode: 'selected', linux: { cli: 'quick', web: 'full', desktop: 'quick' }, windows: { cli: 'quick', web: 'full' },
      off: ['engine', 'integration', 'planner', 'sandbox', 'tour'],
    }],
    ['a core-internal change: core in full, its dependents quick, the app\'s drive but no tour', ['packages/core/src/services/PlanPrompts.ts'], {
      mode: 'selected',
      linux: { core: 'full', ui: 'quick', vscode: 'quick', cli: 'quick', web: 'quick', desktop: 'quick' },
      windows: { core: 'full', vscode: 'quick', cli: 'quick', web: 'quick' },
      off: ['tour'],
    }],
    ['a change to core\'s exports: every dependent in full, still no tour', ['packages/core/src/index.ts'], { ...everything('selected'), off: ['tour'] }],
    ['package-lock.json: everything', ['package-lock.json'], everything('full')],
  ]) {
    it(title, () => assert.deepEqual(owed(selected(...paths)), expected));
  }

  for (const event of ['push', 'schedule', 'workflow_dispatch']) {
    it(`a ${event}: everything, whatever changed`, () => assert.deepEqual(owed(scopeForEvent(event, '.', workspaces)), everything('full')));
  }
});

describe('a change to docs alone', () => {
  it('needs no workspace, and still owes the checks every change owes', () => {
    const scope = selected('docs/adr/README.md', 'docs/desktop/README.md', 'CHANGELOG.md', 'AGENTS.md');
    assert.equal(scope.mode, 'docs');
    assert.deepEqual(scope.workspaces, []);
    assert.deepEqual(offChecks(scope).length, Object.keys(scope.checks).length);
    assert.ok(ALWAYS_STEPS.includes('verify-scripts'));
    assert.ok(ALWAYS_STEPS.includes('repo-guards'));
  });
});

describe('a path outside the workspaces that only some checks read', () => {
  // What reads each, from a search of the workspaces, scripts/ and ci.yml.
  const ALL = { [CORE]: 'full', [UI]: 'full', [VSCODE]: 'full', [CLI]: 'full', [WEB]: 'full', [DESKTOP]: 'full' };
  const WINDOWS_ALL = { [CORE]: 'full', [VSCODE]: 'full', [CLI]: 'full', [WEB]: 'full' };
  for (const [path, suites, windowsSuites, on] of [
    ['.eslintrc.js', { [UI]: 'quick' }, {}, ['lint', 'suites']],
    ['vitest.shared.ts', ALL, WINDOWS_ALL, ['engine', 'lint', 'sandbox', 'suites', 'windows']],
    ['vitest.setup.ts', ALL, WINDOWS_ALL, ['engine', 'lint', 'sandbox', 'suites', 'windows']],
    ['.gitattributes', {}, WINDOWS_ALL, ['harness', 'windows']],
    ['bench/README.md', {}, {}, []],
    ['bench/scale/README.md', {}, {}, []],
    ['bench/live/.gitignore', {}, {}, []],
    ['bench/pipeline/fake-claude/fake-claude.mjs', { [CORE]: 'full', [CLI]: 'full' }, { [CORE]: 'full', [CLI]: 'full' },
      ['bench', 'desktop', 'engine', 'harness', 'integration', 'suites', 'tour', 'windows']],
    ['bench/pipeline/fake-claude/claude.cmd', { [CORE]: 'full', [CLI]: 'full' }, { [CORE]: 'full', [CLI]: 'full' },
      ['bench', 'desktop', 'engine', 'harness', 'integration', 'suites', 'tour', 'windows']],
    ['bench/pipeline/fake-acp/fake-acp.mjs', { [CORE]: 'full' }, { [CORE]: 'full' }, ['bench', 'harness', 'suites', 'windows']],
    ['bench/pipeline/fake-opencode/fake-opencode.mjs', {}, {}, ['engine']],
    ['bench/pipeline/fake-provider/fake-provider.mjs', {}, {}, ['engine']],
    ['bench/pipeline/drive-pipeline.mjs', {}, {}, ['bench', 'harness']],
    ['bench/live/mock-provider.mjs', {}, {}, ['binary', 'desktop', 'harness', 'planner', 'tour']],
    ['bench/live/scenarios.mjs', {}, {}, ['binary', 'desktop', 'harness', 'planner', 'tour']],
    ['bench/live/drive-conversation.mjs', {}, {}, ['harness', 'planner']],
    ['bench/live/drive-taskops.mjs', {}, {}, ['harness', 'planner']],
    ['bench/live/drive-binary.mjs', {}, {}, ['binary']],
    ['bench/live/webview-harness.mjs', {}, {}, []],
    ['bench/live/host-driver.mjs', {}, {}, []],
    ['bench/containers/verdict.mjs', {}, {}, ['bench', 'engine', 'harness']],
    ['bench/lab/lab.mjs', {}, {}, ['bench', 'harness']],
    ['bench/scale/entry.ts', {}, {}, ['bench', 'harness', 'lint']],
  ]) {
    it(`owes ${on.join(', ') || 'nothing'} for ${path}`, () => {
      const scope = selected(path);
      assert.deepEqual({ suites: scope.suites, windowsSuites: scope.windowsSuites, on: onChecks(scope) }, { suites, windowsSuites, on });
      assert.equal(scope.mode, on.length ? 'selected' : 'docs');
    });
  }

  it('names a suite only for a workspace the repository has', () => {
    const scope = selectScope(['.eslintrc.js'], workspaces.filter((w) => w.dir !== UI));
    assert.deepEqual(scope.suites, {});
    assert.deepEqual(onChecks(scope), ['lint']);
  });
});

describe('the full fallback', () => {
  for (const [path, why] of [
    ['package-lock.json', 'the lockfile'],
    ['package.json', 'the root manifest'],
    ['tsconfig.json', 'shared compiler config'],
    ['.gitignore', 'read by worktreeLinksIgnored'],
    ['.nvmrc', 'the Node in use'],
    ['.github/workflows/ci.yml', 'this workflow'],
    ['.github/workflows/release.yml', 'the release'],
    ['.github/workflows/desktop-build.yml', 'the desktop build: ci.yml cannot judge it, so the full run does'],
    ['.github/workflows/verify-release-tag.mjs', 'the release'],
    ['.github/workflows/cli-build.yml', 'the binary build on every target: ci.yml cannot judge it, so the full run does'],
    ['scripts/sea/build.mjs', 'builds the standalone binary'],
    ['scripts/sea/build.test.mjs', 'the binary build\'s tests'],
    ['packaging/sea/entitlements.plist', 'the entitlements the macOS binary is signed with'],
    ['scripts/install/cli.sh', 'the CLI\'s one-line installer, which fetches the binary'],
    ['scripts/install/cli.test.mjs', 'the CLI installer\'s tests'],
    ['scripts/change-scope.mjs', 'selection itself'],
    ['scripts/verify-skills.mjs', 'a verify script'],
    ['scripts/install/desktop.sh', 'the one-line installer, tested by the bench step'],
    ['scripts/install/desktop.ps1', 'the Windows one-line installer'],
    ['scripts/install/desktop.test.mjs', 'the installers\' tests'],
    ['scripts/desktop-release-assets.mjs', 'writes the fixed-name assets and SHA256SUMS the installers read'],
    ['scripts/release-latest.mjs', 'decides which release release.yml marks latest'],
    ['scripts/render-package-manifests.mjs', 'renders the Homebrew formula and cask and the winget manifests from a release'],
    ['scripts/render-package-manifests.test.mjs', 'the package-manager manifests\' tests'],
    ['packaging/homebrew/ordewell.rb.tmpl', 'the Homebrew formula template'],
    ['packaging/homebrew/ordewell-desktop.rb.tmpl', 'the Homebrew cask template'],
    ['packaging/winget/Ordewell.Ordewell.installer.yaml.tmpl', 'the winget manifest templates'],
    ['assets/logo.png', 'unknown'],
    ['bench/new/harness.mjs', 'a bench path no owner claims yet'],
    ['bench/live/drive-new.mjs', 'a new driver, which something may run'],
    ['bench/pipeline/fake-new/fake.mjs', 'a new fake, which some suite may spawn'],
    ['NOTICE', 'shipped in every artifact'],
    ['AUTHORS.md', 'shipped in every artifact'],
    ['packages/web/package.json', 'a manifest changes what is installed'],
    ['packages/cli-alias/bin.js', 'published, but no workspace'],
    ['packages/brand-new/src/index.ts', 'no workspace yet'],
    ['packages/core', 'a file where a directory belongs'],
    ['Packages/core/src/index.ts', 'case is not folded'],
    ['docs', 'a file named docs'],
    ['somewhere/new.txt', 'unknown'],
  ]) {
    it(`runs everything for ${path} (${why})`, () => {
      const scope = selected('packages/cli/src/main.ts', path);
      assert.equal(scope.mode, 'full');
      assert.ok(scope.reason.includes(path), scope.reason);
      assert.deepEqual(offChecks(scope), []);
      assert.deepEqual([...scope.workspaces].sort(), [CLI, CORE, DESKTOP, UI, VSCODE, WEB]);
    });
  }

  it('runs everything when git reports no change at all: nothing proves that is true', () => {
    assert.equal(selected().mode, 'full');
  });
});

describe('what a pull request changed, read from real git', () => {
  const made = [];
  after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
  const env = () => {
    const clean = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    for (const key of Object.keys(clean)) if (key.startsWith('GIT_') && !/^GIT_(AUTHOR|COMMITTER)_/.test(key)) delete clean[key];
    return clean;
  };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (root, path, text = `${path}\n`) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const repo = () => {
    const root = mkdtempSync(join(tmpdir(), 'ordewell-change-scope-'));
    made.push(root);
    git(root, 'init', '-q', '-b', 'main');
    write(root, 'packages/web/server/gone.ts');
    write(root, 'packages/web/server/moved.ts', 'one long enough body that git would call this a rename\n'.repeat(5));
    write(root, 'docs/a.md');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    return root;
  };
  /** The commit `actions/checkout` hands a pull_request run: a merge of the branch into main. */
  const merged = (root, change) => {
    git(root, 'checkout', '-qb', 'topic');
    change();
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'topic');
    git(root, 'checkout', '-q', 'main');
    write(root, 'docs/main-moved-on.md');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'main moves');
    git(root, 'merge', '-q', '--no-ff', '-m', 'merge', 'topic');
  };

  it('reports both sides of a rename, so the side it left is not forgotten', () => {
    const root = repo();
    merged(root, () => {
      mkdirSync(join(root, 'packages/cli/src'), { recursive: true });
      renameSync(join(root, 'packages/web/server/moved.ts'), join(root, 'packages/cli/src/moved.ts'));
    });
    assert.deepEqual(changedInPullRequest(root).sort(), ['packages/cli/src/moved.ts', 'packages/web/server/moved.ts']);
  });

  it('reports a deletion', () => {
    const root = repo();
    merged(root, () => rmSync(join(root, 'packages/web/server/gone.ts')));
    assert.deepEqual(changedInPullRequest(root), ['packages/web/server/gone.ts']);
  });

  it('reports a path git would quote, whole and unquoted', () => {
    const root = repo();
    merged(root, () => write(root, 'docs/spazio è qui.md'));
    assert.deepEqual(changedInPullRequest(root), ['docs/spazio è qui.md']);
  });

  it('leaves out what main did on its own', () => {
    const root = repo();
    merged(root, () => write(root, 'docs/mine.md'));
    assert.deepEqual(changedInPullRequest(root), ['docs/mine.md']);
  });

  it('refuses a commit that is no merge, and a checkout with no parent', () => {
    const root = repo();
    assert.throws(() => changedInPullRequest(root));
    assert.equal(scopeForEvent('pull_request', root, workspaces).mode, 'full');
  });

  it('refuses a commit with one parent: its diff would be the last commit of the branch alone', () => {
    const root = repo();
    write(root, 'packages/core/src/early.ts');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'the commit that matters');
    write(root, 'docs/last.md');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'a docs commit on top');
    assert.throws(() => changedInPullRequest(root));
    assert.equal(scopeForEvent('pull_request', root, workspaces).mode, 'full');
  });

  it('falls back to everything outside a repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'ordewell-no-repo-'));
    made.push(root);
    const scope = scopeForEvent('pull_request', root, workspaces);
    assert.equal(scope.mode, 'full');
    assert.match(scope.reason, /could not/i);
  });

  it('selects from the merge on a pull request', () => {
    const root = repo();
    merged(root, () => write(root, 'docs/mine.md'));
    assert.equal(scopeForEvent('pull_request', root, workspaces).mode, 'docs');
  });

  it('never selects on a push, a tag or anything else: only a pull request may narrow', () => {
    const root = repo();
    merged(root, () => write(root, 'docs/mine.md'));
    for (const event of ['push', 'workflow_call', 'workflow_dispatch', 'merge_group', '', undefined]) {
      assert.equal(scopeForEvent(event, root, workspaces).mode, 'full', String(event));
    }
  });

  it('reads an uncommitted rename, deletion, and new file below a new directory', () => {
    const root = repo();
    git(root, 'mv', 'packages/web/server/moved.ts', 'packages/web/server/renamed.ts');
    rmSync(join(root, 'packages/web/server/gone.ts'));
    write(root, 'packages/cli/src/deep/new.ts');
    write(root, 'docs/two words.md');
    assert.deepEqual(uncommittedPaths(root).sort(), [
      'docs/two words.md',
      'packages/cli/src/deep/new.ts',
      'packages/web/server/gone.ts',
      'packages/web/server/moved.ts',
      'packages/web/server/renamed.ts',
    ]);
  });
});

describe('the local inner loop', () => {
  const runs = (...paths) => localRuns(paths, workspaces);
  const script = (plan, dir) => plan.runs.find((r) => r.dir === dir)?.script;

  it('rebuilds core and runs its dependents whole for a core change', () => {
    const plan = runs('packages/core/src/index.ts');
    assert.deepEqual(plan.rebuild, [CORE]);
    assert.equal(script(plan, CORE), 'test:changed');
    for (const dependent of [CLI, DESKTOP, UI, VSCODE, WEB]) assert.equal(script(plan, dependent), 'test:quick');
  });

  it('rebuilds web for a web change, and runs the cli and desktop whole', () => {
    const plan = runs('packages/web/server/main.ts');
    assert.deepEqual(plan.rebuild, [WEB]);
    assert.equal(script(plan, WEB), 'test:changed');
    assert.equal(script(plan, CLI), 'test:quick');
    assert.equal(script(plan, DESKTOP), 'test:quick');
    assert.equal(script(plan, CORE), undefined);
    assert.equal(script(plan, VSCODE), undefined);
  });

  it('rebuilds ui for a ui change, and runs vscode and desktop whole', () => {
    const plan = runs('packages/ui/src/chat/hostState.ts');
    assert.deepEqual(plan.rebuild, [UI]);
    assert.equal(script(plan, UI), 'test:changed');
    assert.equal(script(plan, VSCODE), 'test:quick');
    assert.equal(script(plan, DESKTOP), 'test:quick');
    assert.equal(script(plan, CORE), undefined);
  });

  it('rebuilds nothing for a package nothing depends on', () => {
    assert.deepEqual(runs('packages/vscode/src/extension.ts').rebuild, []);
    assert.deepEqual(runs('packages/cli/src/main.ts').rebuild, []);
    assert.deepEqual(runs('packages/desktop/src/main/index.ts').rebuild, []);
  });

  it('runs a package whole when what changed is no source vitest can follow', () => {
    assert.equal(script(runs('packages/web/tsup.config.ts'), WEB), 'test:quick');
  });

  it('runs a package whole for a deleted source: nothing imports it for vitest to follow', () => {
    const plan = localRuns(['packages/web/server/removed.ts'], workspaces, () => false);
    assert.equal(script(plan, WEB), 'test:quick');
  });

  it('runs every quick suite on the full fallback, building what is depended on, in order', () => {
    const plan = runs('scripts/verify-skills.mjs');
    assert.deepEqual(plan.rebuild, [CORE, UI, WEB]);
    for (const dir of [CORE, CLI, UI, VSCODE, WEB, DESKTOP]) assert.equal(script(plan, dir), 'test:quick');
    assert.match(plan.note, /scripts\/verify-skills\.mjs/);
  });

  it('runs nothing with nothing changed, and nothing for docs', () => {
    assert.deepEqual(runs().runs, []);
    assert.deepEqual(runs('docs/a.md').runs, []);
  });
});

describe('the steps a run owes', () => {
  const owedIn = (scope, job) => Object.entries(STEPS_BY_JOB[job])
    .filter(([check]) => check === 'always' || scope.checks[check]).flatMap(([, ids]) => ids);
  const ran = (scope, job = 'build-and-test', outcome = 'success') => Object.fromEntries(
    owedIn(scope, job).map((id) => [id, { outcome, conclusion: outcome }]),
  );

  it('accepts a selected run that ran what it selected, in every job', () => {
    const scope = selected('packages/web/server/main.ts');
    for (const job of Object.keys(STEPS_BY_JOB)) assert.deepEqual(missedSteps(scope, ran(scope, job), job), [], job);
  });

  it('owes the app\'s drive in build-and-test and its visual tour in a job of its own, for a desktop change', () => {
    const scope = selected('packages/desktop/src/renderer/views/task/TaskTab.tsx');
    const steps = ran(scope);
    delete steps['desktop-e2e'];
    assert.deepEqual(missedSteps(scope, steps), ['desktop-e2e: did not run']);
    assert.deepEqual(missedSteps(scope, {}, 'desktop-tour'), ['desktop-tour: did not run']);
    assert.ok(!STEPS_BY_JOB['build-and-test'].tour, 'build-and-test owes no tour');
  });

  it('holds each job to its own steps alone', () => {
    const scope = fullScope('a push', workspaces);
    assert.deepEqual(missedSteps(scope, ran(scope, 'lint'), 'lint'), []);
    assert.deepEqual(missedSteps(scope, ran(scope, 'lint'), 'typecheck'), ['typecheck: did not run']);
  });

  it('owes a step in one job only, and every step a check owes is in some job', () => {
    const ids = Object.values(STEPS_BY_JOB).flatMap((table) => Object.values(table).flat());
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual([...ALWAYS_STEPS, ...Object.values(STEPS_BY_CHECK).flat()].sort(), [...ids].sort());
  });

  it('refuses to confirm for a job it does not know, or none', () => {
    const scope = fullScope('a push', workspaces);
    for (const job of ['nonsense', '']) assert.equal(missedSteps(scope, ran(scope), job).length, 1, job);
  });

  it('names a required step that was skipped', () => {
    const scope = fullScope('a push', workspaces);
    const steps = { ...ran(scope, 'coverage'), coverage: { outcome: 'skipped', conclusion: 'skipped' } };
    assert.deepEqual(missedSteps(scope, steps, 'coverage'), ['coverage: skipped']);
  });

  it('names a required step the run never reported', () => {
    const scope = fullScope('a push', workspaces);
    const steps = ran(scope, 'package');
    delete steps['verify-artifacts'];
    assert.deepEqual(missedSteps(scope, steps, 'package'), ['verify-artifacts: did not run']);
  });

  it('counts a failure let through by continue-on-error as a failure', () => {
    const scope = selected('docs/a.md');
    const steps = { ...ran(scope), 'repo-guards': { outcome: 'failure', conclusion: 'success' } };
    assert.deepEqual(missedSteps(scope, steps), ['repo-guards: failure']);
  });

  it('owes everything when the scope cannot be read', () => {
    const scope = fullScope('a push', workspaces);
    for (const job of Object.keys(STEPS_BY_JOB)) {
      const missed = missedSteps(null, ran(selected('docs/a.md'), job), job);
      assert.deepEqual(missed.length, owedIn(scope, job).length - (STEPS_BY_JOB[job].always ?? []).length, job);
    }
  });
});

describe('the required status', () => {
  const scoped = (scope) => ({ result: 'success', outputs: { scope: JSON.stringify(scope) } });
  const confirmed = { result: 'success', outputs: { confirmed: 'true' } };
  const passed = { result: 'success', outputs: {} };
  const skipped = { result: 'skipped', outputs: {} };
  const failed = { result: 'failure', outputs: {} };
  const full = fullScope('a push', workspaces);
  const webOnly = selected('packages/web/server/main.ts');
  const cliOnly = selected('packages/cli/src/tui/view.ts');
  const coreChange = selected('packages/core/src/index.ts');
  const docsOnly = selected('docs/a.md');
  const onWindows = (result) => Object.fromEntries(Object.keys(WINDOWS_JOBS).map((job) => [job, result]));
  // Every job that confirms its steps, each confirmed; `over` replaces some.
  const linux = (over = {}) => ({ ...Object.fromEntries(Object.keys(STEPS_BY_JOB).map((job) => [job, confirmed])), ...over });
  const docsJobs = linux({ 'desktop-tour': skipped, typecheck: skipped, coverage: skipped, lint: skipped, package: skipped });
  const without = (needs, job) => Object.fromEntries(Object.entries(needs).filter(([name]) => name !== job));

  it('passes a push whose every job ran', () => {
    assert.deepEqual(gateFailures('push', { scope: scoped(full), ...linux(), 'real-engine': passed, ...onWindows(passed) }), []);
  });

  it('passes a pull request that left out only what its scope let it', () => {
    assert.deepEqual(gateFailures('pull_request', { scope: scoped(webOnly), ...linux(), 'real-engine': skipped, ...onWindows(passed) }), []);
  });

  it('passes a pull request that owed no tour without one', () => {
    assert.deepEqual(gateFailures('pull_request', { scope: scoped(cliOnly), ...linux({ 'desktop-tour': skipped }), 'real-engine': skipped, ...onWindows(passed) }), []);
  });

  it('passes a pull request of docs alone, which owes Windows nothing', () => {
    assert.deepEqual(gateFailures('pull_request', { scope: scoped(docsOnly), ...docsJobs, 'real-engine': skipped, ...onWindows(skipped) }), []);
  });

  it('passes a desktop change without the Windows suites, none of which it reaches', () => {
    const scope = selected('packages/desktop/src/main/index.ts');
    assert.deepEqual(gateFailures('pull_request', { scope: scoped(scope), ...linux(), 'real-engine': skipped, windows: skipped, 'windows-harness': passed }), []);
  });

  it('passes a .gitattributes change that ran only Windows', () => {
    const scope = selected('.gitattributes');
    assert.deepEqual(gateFailures('pull_request', { scope: scoped(scope), ...docsJobs, 'real-engine': skipped, ...onWindows(passed) }), []);
  });

  for (const [title, event, needs] of [
    ['the scope job failed, though the rest ran', 'pull_request', { scope: { result: 'failure', outputs: {} }, ...linux(), 'real-engine': passed, ...onWindows(passed) }],
    ['the scope job gave nothing to read', 'pull_request', { scope: { result: 'success', outputs: {} }, ...linux(), 'real-engine': passed, ...onWindows(passed) }],
    ['the scope is not JSON', 'pull_request', { scope: { result: 'success', outputs: { scope: '{' } }, ...linux(), 'real-engine': passed, ...onWindows(passed) }],
    ['a push ran a narrowed scope, every job green', 'push', { scope: scoped(webOnly), ...linux(), 'real-engine': passed, ...onWindows(passed) }],
    ['the scope job failed after giving a scope', 'pull_request', { scope: { ...scoped(webOnly), result: 'failure' }, ...linux(), 'real-engine': skipped, ...onWindows(passed) }],
    ['a push skipped the engine on a full scope that turned it off', 'push', { scope: scoped({ ...full, checks: { ...full.checks, engine: false } }), ...linux(), 'real-engine': skipped, ...onWindows(passed) }],
    ['build-and-test failed', 'pull_request', { scope: scoped(webOnly), ...linux({ 'build-and-test': failed }), 'real-engine': skipped, ...onWindows(passed) }],
    ['build-and-test was skipped', 'push', { scope: scoped(full), ...linux({ 'build-and-test': skipped }), 'real-engine': passed, ...onWindows(passed) }],
    ['build-and-test was skipped for docs alone', 'pull_request', { scope: scoped(docsOnly), ...docsJobs, 'build-and-test': skipped, 'real-engine': skipped, ...onWindows(skipped) }],
    ['build-and-test was cancelled', 'pull_request', { scope: scoped(webOnly), ...linux({ 'build-and-test': { result: 'cancelled', outputs: {} } }), 'real-engine': skipped, ...onWindows(passed) }],
    ['build-and-test never confirmed its steps', 'push', { scope: scoped(full), ...linux({ 'build-and-test': passed }), 'real-engine': passed, ...onWindows(passed) }],
    ['the tour failed', 'pull_request', { scope: scoped(selected('packages/ui/src/chat/App.tsx')), ...linux({ 'desktop-tour': failed }), 'real-engine': skipped, ...onWindows(passed) }],
    ['the tour was skipped for a desktop change', 'pull_request', { scope: scoped(selected('packages/desktop/src/main/index.ts')), ...linux({ 'desktop-tour': skipped }), 'real-engine': skipped, ...onWindows(passed) }],
    ['the tour was skipped on a push', 'push', { scope: scoped(full), ...linux({ 'desktop-tour': skipped }), 'real-engine': passed, ...onWindows(passed) }],
    ['the tour failed on a change that did not owe it', 'pull_request', { scope: scoped(cliOnly), ...linux({ 'desktop-tour': failed }), 'real-engine': skipped, ...onWindows(passed) }],
    ['the tour never confirmed its steps', 'push', { scope: scoped(full), ...linux({ 'desktop-tour': passed }), 'real-engine': passed, ...onWindows(passed) }],
    ['a coverage leg failed', 'pull_request', { scope: scoped(webOnly), ...linux({ coverage: failed }), 'real-engine': skipped, ...onWindows(passed) }],
    ['coverage was skipped for a package change', 'pull_request', { scope: scoped(webOnly), ...linux({ coverage: skipped }), 'real-engine': skipped, ...onWindows(passed) }],
    ['typecheck failed', 'push', { scope: scoped(full), ...linux({ typecheck: failed }), 'real-engine': passed, ...onWindows(passed) }],
    ['lint was skipped on a push', 'push', { scope: scoped(full), ...linux({ lint: skipped }), 'real-engine': passed, ...onWindows(passed) }],
    ['packaging never confirmed its steps', 'push', { scope: scoped(full), ...linux({ package: passed }), 'real-engine': passed, ...onWindows(passed) }],
    ['lint failed on docs alone, which did not owe it', 'pull_request', { scope: scoped(docsOnly), ...docsJobs, lint: failed, 'real-engine': skipped, ...onWindows(skipped) }],
    ['the engine was skipped on a push', 'push', { scope: scoped(full), ...linux(), 'real-engine': skipped, ...onWindows(passed) }],
    ['the engine was skipped for a core change', 'pull_request', { scope: scoped(coreChange), ...linux(), 'real-engine': skipped, ...onWindows(passed) }],
    ['the engine failed on a change that did not need it', 'pull_request', { scope: scoped(webOnly), ...linux(), 'real-engine': failed, ...onWindows(passed) }],
    ['a Windows job failed', 'pull_request', { scope: scoped(webOnly), ...linux(), 'real-engine': skipped, ...onWindows(passed), windows: failed }],
    ['Windows was skipped on a push', 'push', { scope: scoped(full), ...linux(), 'real-engine': passed, ...onWindows(skipped) }],
    ['Windows was skipped for a package change', 'pull_request', { scope: scoped(webOnly), ...linux(), 'real-engine': skipped, ...onWindows(passed), 'windows-harness': skipped }],
    ['Windows failed on a change that did not need it', 'pull_request', { scope: scoped(docsOnly), ...docsJobs, 'real-engine': skipped, ...onWindows(skipped), windows: failed }],
    ['a job is missing altogether', 'push', { scope: scoped(full), ...linux(), ...onWindows(passed) }],
    ['the tour job is missing altogether', 'push', without({ scope: scoped(full), ...linux(), 'real-engine': passed, ...onWindows(passed) }, 'desktop-tour')],
    ['the coverage job is missing on docs alone', 'pull_request', without({ scope: scoped(docsOnly), ...docsJobs, 'real-engine': skipped, ...onWindows(skipped) }, 'coverage')],
    ['the Windows suites were skipped for a core change', 'pull_request', { scope: scoped(coreChange), ...linux(), 'real-engine': passed, ...onWindows(passed), windows: skipped }],
    ['the Windows harness was skipped for .gitattributes', 'pull_request', { scope: scoped(selected('.gitattributes')), ...docsJobs, 'real-engine': skipped, ...onWindows(passed), 'windows-harness': skipped }],
    ['coverage was skipped for .eslintrc.js, which owes ui\'s quick suite', 'pull_request', { scope: scoped(selected('.eslintrc.js')), ...docsJobs, lint: confirmed, 'real-engine': skipped, ...onWindows(skipped) }],
    ['a Windows job is missing altogether', 'push', { scope: scoped(full), ...linux(), 'real-engine': passed, windows: passed }],
  ]) {
    it(`fails when ${title}`, () => {
      assert.notDeepEqual(gateFailures(event, needs), []);
    });
  }
});

describe('the repository-wide guards', () => {
  it('names only tests that exist', () => {
    for (const test of GUARD_TESTS) assert.ok(readFileSync(join(CORE, test), 'utf8').length > 0, test);
    const script = JSON.parse(readFileSync('package.json', 'utf8')).scripts['test:guards'];
    for (const test of GUARD_TESTS) assert.ok(script.includes(test), `test:guards leaves out ${test}`);
  });

  it('accounts for every test that climbs out of its own package, so a new one is not left out of selection', () => {
    // Selection runs a package's tests for changes to that package. A test that
    // reads the repository proves something about changes selection could leave
    // it out for, unless what it reads is itself a full fallback.
    const accounted = new Map([
      ['packages/core/src/services/__tests__/fakeSecretsGuard.test.ts', 'guard'],
      ['packages/core/src/services/__tests__/gitExec.test.ts', 'guard'],
      ['packages/core/src/services/__tests__/worktreeLinksIgnored.test.ts', '.gitignore is a full fallback'],
      ['packages/ui/src/__tests__/webviewImports.lint.test.ts', '.eslintrc.js owes ui\'s suite'],
      // Its Docker legs run only in real-engine, which every fake it reads owes.
      ['packages/core/src/services/container/__tests__/dockerLease.e2e.test.ts', 'its fakes owe the engine'],
    ]);
    for (const fake of ['fake-claude/fake-claude.mjs', 'fake-opencode/fake-opencode.mjs', 'fake-provider/fake-provider.mjs']) {
      assert.equal(selected(`bench/pipeline/${fake}`).checks.engine, true, fake);
    }
    // A directory is judged by its files, each of which the test may read.
    const readsBench = (target, owner) => {
      const files = statSync(target).isDirectory() ? readdirSync(target).map((name) => `${target}/${name}`) : [target];
      return files.every((file) => {
        const scope = selected(file);
        return scope.mode === 'full' || scope.suites[owner.dir] === 'full';
      });
    };
    const climbing = /\b(?:resolve|join)\(__dirname,\s*((?:'[^']*'(?:,\s*)?)+)\)/g;
    const found = new Set();
    const walk = (dir, owner) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(path, owner); continue; }
        if (!/\.test\.tsx?$/.test(entry.name)) continue;
        for (const [, literals] of readFileSync(path, 'utf8').matchAll(climbing)) {
          // In git's spelling, with forward slashes, which the workspaces' dirs use on Windows too.
          const target = relative(resolve('.'), resolve(dirname(path), ...literals.split(/,\s*/).map((l) => l.slice(1, -1)))).split(sep).join('/');
          const staysHome = target === owner.dir || target.startsWith(`${owner.dir}/`);
          // A dependency's change already selects its dependents, and a bench/
          // path must name this suite among what it owes.
          const covered = (target.startsWith('bench/') && readsBench(target, owner)) || owner.deps.some((dep) => target.startsWith(`${dep}/`));
          if (!staysHome && !covered) found.add(path.split(sep).join('/'));
        }
      }
    };
    for (const owner of workspaces) walk(owner.dir === WEB ? join(owner.dir, 'server') : join(owner.dir, 'src'), owner);
    assert.deepEqual([...found].sort(), [...accounted.keys()].sort());
    for (const test of GUARD_TESTS) assert.equal(accounted.get(`${CORE}/${test}`), 'guard');
  });
});

describe('ci-scope.mjs, as ci.yml runs it', () => {
  const made = [];
  after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
  const cli = resolve('scripts/ci-scope.mjs');
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-ci-scope-'));
    made.push(dir);
    return dir;
  };
  const run = (command, env, cwd = '.') => {
    const dir = scratch();
    const GITHUB_OUTPUT = join(dir, 'output');
    const GITHUB_STEP_SUMMARY = join(dir, 'summary');
    writeFileSync(GITHUB_OUTPUT, '');
    const { status, stderr } = spawnSync('node', [cli, command], { cwd, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY, ...env } });
    const pairs = readFileSync(GITHUB_OUTPUT, 'utf8').split('\n').filter(Boolean).map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    });
    return { status, stderr, outputs: Object.fromEntries(pairs) };
  };
  const passed = (ids) => JSON.stringify(Object.fromEntries(ids.map((id) => [id, { outcome: 'success', conclusion: 'success' }])));
  const jobSteps = (job) => Object.values(STEPS_BY_JOB[job]).flat();

  it('gives a push every check, and a coverage leg for every workspace', () => {
    for (const EVENT of ['push', 'schedule', 'workflow_dispatch']) {
      const { status, outputs } = run('select', { EVENT });
      assert.equal(status, 0);
      assert.deepEqual(JSON.parse(outputs.coverage), workspaces.map((w) => ({ workspace: w.dir, name: w.dir.split('/').at(-1), script: 'test:coverage' })), EVENT);
      for (const check of CHECKS) assert.equal(outputs[check], 'true', `${EVENT} ${check}`);
      assert.equal(JSON.parse(outputs.scope).mode, 'full');
    }
  });

  it('names each coverage leg by its directory, which an artifact name can hold', () => {
    for (const { name } of coverageLegs(fullScope('a push', workspaces))) assert.match(name, /^[\w-]+$/);
    assert.deepEqual(coverageLegs(selected('docs/a.md')), []);
  });

  it('gives a quick suite a leg of its own that runs test:quick, under a name no full leg holds', () => {
    assert.deepEqual(coverageLegs(selected('packages/ui/src/chat/App.tsx')), [
      { workspace: UI, name: 'ui', script: 'test:coverage' },
      { workspace: VSCODE, name: 'vscode-quick', script: 'test:quick' },
      { workspace: 'packages/desktop', name: 'desktop-quick', script: 'test:quick' },
    ]);
  });

  it('runs on Windows what the scope owes Windows, and every suite in full when the scope is lost', () => {
    const all = [CORE, CLI, WEB, VSCODE].map((dir) => ({ dir, script: 'test' }));
    assert.deepEqual([...windowsRuns(null)].sort((a, b) => a.dir.localeCompare(b.dir)), [...all].sort((a, b) => a.dir.localeCompare(b.dir)));
    const runs = windowsRuns(selected('packages/cli/src/commands/run.ts'));
    assert.deepEqual([...runs].sort((a, b) => a.dir.localeCompare(b.dir)), [{ dir: CLI, script: 'test' }]);
    const web = windowsRuns(selected('packages/web/server/index.ts'));
    assert.deepEqual([...web].sort((a, b) => a.dir.localeCompare(b.dir)), [{ dir: CLI, script: 'test:quick' }, { dir: WEB, script: 'test' }]);
    assert.deepEqual(windowsRuns(selected('packages/desktop/src/main/index.ts')), []);
  });

  it('runs each Windows suite on its shard, every one even after a failure, and fails if any did', () => {
    const root = scratch();
    const log = join(root, 'ran.log');
    const write = (path, text) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    const record = (code) => `node -e "require('fs').appendFileSync(process.argv[1], process.argv.slice(2).join(' ') + '\\n'); process.exit(${code})"`;
    write('package.json', JSON.stringify({ private: true, workspaces: [CORE, WEB] }));
    write(`${CORE}/package.json`, JSON.stringify({ name: 'c', scripts: { test: `${record(1)} ${JSON.stringify(log)} core-test`, 'test:quick': `${record(0)} ${JSON.stringify(log)} core-quick` } }));
    write(`${WEB}/package.json`, JSON.stringify({ name: 'w', scripts: { test: `${record(0)} ${JSON.stringify(log)} web-test`, 'test:quick': `${record(0)} ${JSON.stringify(log)} web-quick` } }));
    const scope = JSON.stringify({ mode: 'selected', checks: {}, windowsSuites: { [CORE]: 'full', [WEB]: 'quick' } });
    const { status, stderr } = run('windows-tests', { SCOPE: scope, SHARD: '2/6' }, root);
    assert.equal(status, 1, stderr);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['core-test --shard=2/6', 'web-quick --shard=2/6']);
  });

  it('names the workspaces of a narrowed pull request, in outputs ci.yml can compare', () => {
    const root = scratch();
    const write = (path, text) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    write('package.json', JSON.stringify({ workspaces: ['packages/a', 'packages/b'] }));
    write('packages/a/package.json', JSON.stringify({ name: 'a' }));
    write('packages/b/package.json', JSON.stringify({ name: 'b', dependencies: { a: '*' } }));
    write('packages/a/one.ts', '1');
    const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'topic');
    write('packages/a/two.ts', '2');
    git('add', '-A');
    git('commit', '-qm', 'topic');
    git('checkout', '-q', 'main');
    write('docs/moved-on.md', 'x');
    git('add', '-A');
    git('commit', '-qm', 'main');
    git('merge', '-q', '--no-ff', '-m', 'merge', 'topic');

    const { status, outputs } = run('select', { EVENT: 'pull_request' }, root);
    assert.equal(status, 0);
    // a changed: its full suite. b only depends on it: a quick one.
    assert.equal(outputs.coverage, '[{"workspace":"packages/a","name":"a","script":"test:coverage"},{"workspace":"packages/b","name":"b-quick","script":"test:quick"}]');
    assert.equal(outputs.suites, 'true');
    assert.equal(outputs.windows, 'false');
    assert.equal(outputs.engine, 'false');
    assert.equal(outputs.integration, 'false');
    assert.equal(outputs.desktop, 'false');
    assert.equal(outputs.tour, 'false');
  });

  it('confirms a run that did what it owed', () => {
    const scope = JSON.stringify(selected('docs/a.md'));
    const { status, outputs } = run('confirm', { JOB: 'build-and-test', SCOPE: scope, STEPS: passed(ALWAYS_STEPS) });
    assert.equal(status, 0);
    assert.equal(outputs.confirmed, 'true');
  });

  it('confirms each job on its own steps', () => {
    const scope = JSON.stringify(fullScope('a push', workspaces));
    for (const job of Object.keys(STEPS_BY_JOB)) {
      assert.equal(run('confirm', { JOB: job, SCOPE: scope, STEPS: passed(jobSteps(job)) }).status, 0, job);
    }
  });

  it('refuses to confirm, and writes no proof, when an owed step is missing', () => {
    const scope = JSON.stringify(selected('packages/core/src/index.ts'));
    const { status, stderr, outputs } = run('confirm', { JOB: 'coverage', SCOPE: scope, STEPS: passed([]) });
    assert.equal(status, 1);
    assert.match(stderr, /coverage: did not run/);
    assert.equal(outputs.confirmed, undefined);
  });

  it('refuses to confirm a job it is not told, rather than proving build-and-test\'s steps', () => {
    const scope = JSON.stringify(selected('docs/a.md'));
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'JOB'));
    const dir = scratch();
    const GITHUB_OUTPUT = join(dir, 'output');
    writeFileSync(GITHUB_OUTPUT, '');
    const { status } = spawnSync('node', [cli, 'confirm'], { encoding: 'utf8', env: { ...env, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY: join(dir, 'summary'), SCOPE: scope, STEPS: passed(ALWAYS_STEPS) } });
    assert.equal(status, 1);
    assert.equal(readFileSync(GITHUB_OUTPUT, 'utf8'), '');
    assert.equal(run('confirm', { JOB: 'nonsense', SCOPE: scope, STEPS: passed(ALWAYS_STEPS) }).status, 1);
  });

  it('owes everything when the scope output is empty, as after a failed scope job', () => {
    assert.equal(run('confirm', { JOB: 'build-and-test', SCOPE: '', STEPS: passed(ALWAYS_STEPS) }).status, 1);
    assert.equal(run('confirm', { JOB: 'build-and-test', SCOPE: '', STEPS: passed(jobSteps('build-and-test')) }).status, 0);
    assert.equal(run('confirm', { JOB: 'desktop-tour', SCOPE: '', STEPS: passed([]) }).status, 1);
  });

  it('fails the gate on unreadable input rather than passing it', () => {
    assert.notEqual(run('gate', { EVENT: 'push', NEEDS: '' }).status, 0);
    assert.notEqual(run('confirm', { SCOPE: '', STEPS: '' }).status, 0);
  });

  it('passes and fails the gate by exit status, which is all GitHub reads', () => {
    const scope = { result: 'success', outputs: { scope: JSON.stringify(fullScope('a push', workspaces)) } };
    const job = { result: 'success', outputs: { confirmed: 'true' } };
    const good = { scope, ...Object.fromEntries(Object.keys(STEPS_BY_JOB).map((name) => [name, job])), 'real-engine': { result: 'success', outputs: {} }, ...Object.fromEntries(Object.keys(WINDOWS_JOBS).map((name) => [name, { result: 'success', outputs: {} }])) };
    assert.equal(run('gate', { EVENT: 'push', NEEDS: JSON.stringify(good) }).status, 0);
    const skipped = { ...good, 'real-engine': { result: 'skipped', outputs: {} } };
    const refused = run('gate', { EVENT: 'push', NEEDS: JSON.stringify(skipped) });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /real-engine: skipped/);
  });

  it('refuses a command it does not know', () => {
    assert.equal(run('nonsense', {}).status, 2);
  });
});

describe('ci.yml', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const jobBlock = (job) => {
    const start = workflow.search(new RegExp(`^  ${job}:$`, 'm'));
    assert.ok(start >= 0, `no job ${job}`);
    const rest = workflow.slice(start + 1);
    const end = rest.search(/^  [\w-]+:$/m);
    return end < 0 ? rest : rest.slice(0, end);
  };
  const steps = (job) => jobBlock(job).split(/^ {6}- /m).slice(1);
  const stepIn = (job, id) => steps(job).find((s) => new RegExp(`^\\s*id: ${id}$`, 'm').test(s));
  const stepNamed = (job, name) => steps(job).find((s) => s.startsWith(`name: ${name}\n`));
  const jobGate = (check) => new RegExp(`needs: scope\\n\\s+if: \\$\\{\\{ !cancelled\\(\\) && needs\\.scope\\.outputs\\.${check} != 'false' \\}\\}`);
  const owedSteps = Object.entries(STEPS_BY_JOB).flatMap(([job, table]) => Object.entries(table).flatMap(([check, ids]) => ids.map((id) => ({ job, check, id }))));

  it('has every step the tables name, in the job that owes it', () => {
    for (const { job, id } of owedSteps) assert.ok(stepIn(job, id), `no step ${id} in ${job}`);
  });

  it('skips an always step for no reason of its own', () => {
    for (const id of ALWAYS_STEPS) assert.doesNotMatch(stepIn('build-and-test', id), /^\s*if:/m, id);
  });

  it('runs a selected step unless its check says no, so a lost output runs it', () => {
    for (const { job, check, id } of owedSteps.filter(({ check }) => check !== 'always')) {
      if (job === 'build-and-test') {
        assert.ok(stepIn(job, id).includes(`if: needs.scope.outputs.${check} != 'false'`), `step ${id} is not gated on ${check} as a default-run`);
      } else {
        // A job of one check is gated as a whole, so its steps need no gate.
        assert.deepEqual(Object.keys(STEPS_BY_JOB[job]), [check], job);
        assert.match(jobBlock(job), jobGate(check), `job ${job} is not gated on ${check} as a default-run`);
        assert.doesNotMatch(stepIn(job, id), /^\s*if:/m, `${job} ${id}`);
      }
    }
  });

  it('hands every check on from the scope job: a missing output reads as empty, and the step would run on every change', () => {
    for (const check of [...CHECKS, 'coverage']) {
      assert.ok(jobBlock('scope').includes(`${check}: \${{ steps.select.outputs.${check} }}`), `the scope job does not output ${check}`);
    }
  });

  it('lets no required step fail quietly', () => {
    assert.doesNotMatch(workflow, /continue-on-error/);
  });

  it('keeps build-and-test and the engine alive when the scope job fails', () => {
    assert.match(jobBlock('build-and-test'), /needs: scope\n\s+if: \$\{\{ !cancelled\(\) \}\}/);
    assert.match(jobBlock('real-engine'), jobGate('engine'));
  });

  it('runs each Windows job on its own check, and keeps it alive when the scope job fails', () => {
    for (const [job, check] of Object.entries(WINDOWS_JOBS)) {
      assert.match(jobBlock(job), jobGate(check), job);
      assert.match(jobBlock(job), /runs-on: windows-latest/, job);
    }
  });

  it('splits the Windows suites into shards numbered from one, and names each by the matrix\'s own total', () => {
    const windows = jobBlock('windows');
    const shards = JSON.parse(windows.match(/^\s+shard: (\[[\d, ]+\])$/m)[1]);
    assert.deepEqual(shards, shards.map((_, i) => i + 1));
    assert.equal(shards.length, 6);
    assert.ok(windows.includes('name: windows (${{ matrix.shard }}/${{ strategy.job-total }})'));
    const test = stepNamed('windows', 'Test on Windows');
    assert.ok(test.includes('SHARD: ${{ matrix.shard }}/${{ strategy.job-total }}'), 'a shard does not know which it is');
    assert.ok(test.includes('SCOPE: ${{ needs.scope.outputs.scope }}'), 'a shard does not know what the scope owes');
    assert.match(test, /node scripts\/ci-scope\.mjs windows-tests/);
    assert.match(windows, /fail-fast: false/);
  });

  it('runs a Windows harness step unless its check says no', () => {
    for (const [name, check] of [['Planner conversation loop on Windows', 'planner'], ['VS Code integration test on Windows', 'integration']]) {
      const step = stepNamed('windows-harness', name);
      assert.ok(step, `no step ${name}`);
      assert.ok(step.includes(`if: needs.scope.outputs.${check} != 'false'`), `step ${name} is not gated on ${check} as a default-run`);
    }
  });

  it('confirms each job\'s steps last, as that job, and hands the proof to the required status', () => {
    for (const job of Object.keys(STEPS_BY_JOB)) {
      const last = steps(job).at(-1);
      assert.match(last, /id: confirm/, job);
      assert.match(last, /node scripts\/ci-scope\.mjs confirm/, job);
      assert.match(last, /toJSON\(steps\)/, job);
      assert.ok(last.includes('JOB: ${{ github.job }}'), `${job} does not name itself to confirm`);
      assert.match(jobBlock(job), /confirmed: \$\{\{ steps\.confirm\.outputs\.confirmed \}\}/, job);
    }
  });

  it('has a required status that always reports, over every job', () => {
    const gate = jobBlock('required-checks');
    assert.match(gate, /name: Required checks\n/);
    assert.match(gate, /if: always\(\)/);
    const jobs = ['scope', ...Object.keys(STEPS_BY_JOB), 'real-engine', ...Object.keys(WINDOWS_JOBS)];
    assert.ok(gate.includes(`needs: [${jobs.join(', ')}]`), 'the gate does not need every job');
    const declared = [...workflow.slice(workflow.indexOf('\njobs:\n')).matchAll(/^  ([\w-]+):$/gm)].map((m) => m[1]).filter((job) => job !== 'required-checks');
    assert.deepEqual([...declared].sort(), [...jobs].sort(), 'a job the gate does not judge');
    assert.match(gate, /toJSON\(needs\)/);
    assert.match(gate, /node scripts\/ci-scope\.mjs gate/);
  });

  it('runs the visual tour strict, in a job of its own that builds what it walks and nothing more', () => {
    const tour = stepIn('desktop-tour', 'desktop-tour');
    assert.match(tour, /TOUR_STRICT: '1'/);
    assert.match(tour, /xvfb-run -a npm run desktop:tour/);
    assert.match(jobBlock('desktop-tour'), jobGate('tour'));
    assert.match(jobBlock('desktop-tour'), /timeout-minutes: \d+/);
    const names = steps('desktop-tour').map((s) => s.match(/^(?:name|uses): (.+)$/m)[1]);
    assert.deepEqual(names, [
      'actions/checkout@v7',
      'Use Node.js 22.x',
      'Install dependencies',
      'Build (core first — cli, web and vscode compile against its dist/)',
      'Build (ui, vscode, cli, web & desktop)',
      'Install xvfb if the image lacks it',
      'Desktop app — visual tour and layout checks',
      'Upload the desktop tour report',
      'Confirm every step this change owed ran',
    ]);
    const report = stepNamed('desktop-tour', 'Upload the desktop tour report');
    assert.match(report, /failure\(\)/);
    assert.match(report, /path: packages\/desktop\/test-results\/tour/);
  });

  it('runs coverage one leg per workspace, every leg to the end, and the root script when the scope gave none', () => {
    const coverage = jobBlock('coverage');
    assert.match(coverage, /fail-fast: false/);
    assert.ok(coverage.includes('name: coverage (${{ matrix.name }})'));
    const fallback = coverage.match(/include: \$\{\{ fromJSON\(needs\.scope\.outputs\.coverage \|\| '(.+)'\) \}\}/);
    assert.ok(fallback, 'the matrix does not fall back when the scope output is lost');
    assert.deepEqual(JSON.parse(fallback[1]), [{ workspace: '', name: 'every workspace' }]);
    const step = stepIn('coverage', 'coverage');
    assert.ok(step.includes('WORKSPACE: ${{ matrix.workspace }}'));
    assert.ok(step.includes('SCRIPT: ${{ matrix.script }}'));
    // The fallback leg names no script, so it runs coverage, floors and all.
    assert.ok(step.includes('npm run "${SCRIPT:-test:coverage}" ${WORKSPACE:+-w "$WORKSPACE"} --if-present'), 'a leg does not run its own workspace\'s script');
    assert.match(step, /set -o pipefail/);
    const upload = stepNamed('coverage', 'Upload coverage reports');
    assert.ok(upload.includes('name: coverage-reports-${{ matrix.name }}'), 'legs would upload over one another');
    assert.ok(upload.includes("if: ${{ always() && matrix.script != 'test:quick' }}"), 'a quick leg, which writes no report, would upload one');
  });

  it('lints without building, and builds before typecheck and packaging', () => {
    assert.doesNotMatch(jobBlock('lint'), /id: build-/);
    for (const job of ['typecheck', 'package', 'coverage', 'desktop-tour']) {
      const block = jobBlock(job);
      const owed = Object.values(STEPS_BY_JOB[job]).flat()[0];
      assert.ok(block.indexOf('id: build-core') < block.indexOf('id: build-rest'), job);
      assert.ok(block.indexOf('id: build-rest') < block.indexOf(`id: ${owed}`), job);
    }
  });

  it('runs in full every night and on demand, and cancels only a pull request\'s superseded run', () => {
    assert.match(workflow, /^ {2}schedule:\n {4}- cron: '\d+ \d+ \* \* \*'$/m);
    assert.match(workflow, /^ {2}workflow_dispatch:$/m);
    const concurrency = workflow.match(/^concurrency:\n((?: {2}.*\n)+)/m)[1];
    assert.ok(concurrency.includes("group: ci-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}"), 'a run on main shares a group and can be cancelled');
    assert.ok(concurrency.includes("cancel-in-progress: ${{ github.event_name == 'pull_request' }}"));
  });

  it('reads two commits, so a pull request\'s merge has its parents', () => {
    assert.match(jobBlock('scope'), /fetch-depth: 2/);
  });

  it('can be called by the release, which then waits for it', () => {
    assert.match(workflow, /^ {2}workflow_call:$/m);
    const release = readFileSync('.github/workflows/release.yml', 'utf8');
    assert.match(release, /^ {2}ci:\n\s+uses: \.\/\.github\/workflows\/ci\.yml$/m);
    for (const job of ['npm-publish', 'vscode-publish']) {
      assert.match(release, new RegExp(`^  ${job}:\\n\\s+needs: ci$`, 'm'), `${job} does not wait for CI`);
    }
  });

  it('leaves the checkout-only gates off where the gate tests run', () => {
    // delegationSwitch.test.ts asserts they are off, and a variable set here
    // would prove delegation and containers on for the wrong reason.
    assert.doesNotMatch(workflow, /ORDEWELL_(DELEGATION|CONTAINERS)/);
    assert.doesNotMatch(readFileSync('.github/workflows/release.yml', 'utf8'), /ORDEWELL_(DELEGATION|CONTAINERS)/);
  });
});
