import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  ALWAYS_STEPS,
  BUILD_OUTPUTS,
  CHECKS,
  COVERAGE_SHARDS,
  GUARD_TESTS,
  STEPS_BY_CHECK,
  STEPS_BY_JOB,
  WINDOWS_JOBS,
  buildKeys,
  buildOrder,
  blobProblems,
  changedInPullRequest,
  coverageLegs,
  coverageMerges,
  coverageSummaries,
  electronBuilderCacheDir,
  electronCacheDir,
  electronGypDir,
  fullScope,
  gateFailures,
  localRuns,
  lockedVersion,
  missedSteps,
  modulesKey,
  readWorkspaces,
  scopeForEvent,
  selectScope,
  setupPlan,
  shasumsText,
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
    assert.deepEqual(offChecks(scope), ['engine', 'integration', 'merge', 'planner', 'sandbox', 'tour']);
  });

  it('keeps a cli change to the cli', () => {
    const scope = selected('packages/cli/src/tui/view.ts');
    assert.deepEqual(scope.workspaces, [CLI]);
    assert.deepEqual(offChecks(scope), ['desktop', 'engine', 'integration', 'merge', 'planner', 'sandbox', 'tour']);
  });

  it('takes vscode and desktop with ui, and runs the real VS Code and the app for it: both draw from ui\'s dist', () => {
    const scope = selected('packages/ui/src/chat/App.tsx');
    assert.deepEqual(scope.workspaces, [UI, VSCODE, DESKTOP]);
    assert.deepEqual(offChecks(scope), ['binary', 'engine', 'merge', 'planner', 'sandbox']);
  });

  it('runs the real VS Code for a vscode change, and no container or app', () => {
    const scope = selected('packages/vscode/src/extension.ts');
    assert.deepEqual(scope.workspaces, [VSCODE]);
    assert.deepEqual(offChecks(scope), ['binary', 'desktop', 'engine', 'merge', 'planner', 'sandbox', 'tour']);
  });

  it('keeps a desktop change to desktop and drives the app for it: nothing is built on it, and no container or VS Code proves it', () => {
    const scope = selected('packages/desktop/src/main/daemon/DaemonManager.ts');
    assert.deepEqual(scope.workspaces, [DESKTOP]);
    assert.deepEqual(offChecks(scope), ['binary', 'engine', 'integration', 'merge', 'planner', 'sandbox', 'windows']);
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
  const ALL_OFF = ['bench', 'binary', 'desktop', 'engine', 'harness', 'integration', 'lint', 'merge', 'package', 'planner', 'sandbox', 'suites', 'tour', 'typecheck', 'windows'];
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
      mode: 'selected', linux: { desktop: 'full' }, windows: {}, off: ['binary', 'engine', 'integration', 'merge', 'planner', 'sandbox', 'windows'],
    }],
    ['a ui change: ui in full, vscode and desktop quick, the tour', ['packages/ui/src/chat/App.tsx'], {
      mode: 'selected', linux: { ui: 'full', vscode: 'quick', desktop: 'quick' }, windows: { vscode: 'quick' },
      off: ['binary', 'engine', 'merge', 'planner', 'sandbox'],
    }],
    ['a web change: web in full, cli and desktop quick, no tour', ['packages/web/server/routes/settings.ts'], {
      mode: 'selected', linux: { cli: 'quick', web: 'full', desktop: 'quick' }, windows: { cli: 'quick', web: 'full' },
      off: ['engine', 'integration', 'merge', 'planner', 'sandbox', 'tour'],
    }],
    ['a core-internal change: core in full, its dependents quick, the app\'s drive but no tour', ['packages/core/src/services/PlanPrompts.ts'], {
      mode: 'selected',
      linux: { core: 'full', ui: 'quick', vscode: 'quick', cli: 'quick', web: 'quick', desktop: 'quick' },
      windows: { core: 'full', vscode: 'quick', cli: 'quick', web: 'quick' },
      off: ['tour'],
    }],
    ['a change to core\'s exports: every dependent in full, still no tour', ['packages/core/src/index.ts'], { ...everything('selected'), off: ['tour'] }],
    ['package-lock.json: everything', ['package-lock.json'], everything('full')],
    ['the CLI installer and its docs: the bench step, here and on Windows, and no suite or tour', [
      'scripts/install/cli.sh', 'scripts/install/cli.test.mjs', 'docs/troubleshooting.md', 'CHANGELOG.md',
    ], { mode: 'selected', linux: {}, windows: {}, off: ALL_OFF.filter((c) => !['bench', 'harness'].includes(c)) }],
    ['the CLI installer with a cli change: cli in full, the binary\'s build and drive, and still no tour', [
      'scripts/install/cli.sh', 'scripts/install/cli.test.mjs', 'docs/troubleshooting.md', 'CHANGELOG.md',
      'packages/cli/src/main.ts', 'packages/cli/src/utils/longDash.ts', 'packages/cli/src/utils/__tests__/longDash.test.ts',
    ], {
      mode: 'selected', linux: { cli: 'full' }, windows: { cli: 'full' },
      off: ['desktop', 'engine', 'integration', 'merge', 'planner', 'sandbox', 'tour'],
    }],
  ]) {
    it(title, () => assert.deepEqual(owed(selected(...paths)), expected));
  }

  for (const event of ['push', 'schedule', 'workflow_dispatch']) {
    it(`a ${event}: everything, whatever changed`, () => assert.deepEqual(owed(scopeForEvent(event, '.', workspaces)), everything('full')));
  }
});

describe('a release that reuses main\'s proof', () => {
  // What `gh run list --json databaseId,url,headSha,event,headBranch,conclusion` prints.
  const SHA = '1374ff43a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const URL = 'https://github.com/ordewell/ordewell/actions/runs/42286454001';
  const mainRun = { databaseId: 42286454001, url: URL, headSha: SHA, event: 'push', headBranch: 'main', conclusion: 'success' };
  const lookingUp = (output) => {
    const asked = [];
    const findMainRuns = (sha) => {
      asked.push(sha);
      if (output instanceof Error) throw output;
      return output;
    };
    return { asked, findMainRuns };
  };
  const release = (output, over = {}) => {
    const lookup = lookingUp(output);
    return { ...lookup, scope: scopeForEvent('push', '.', workspaces, { reuseMainProof: true, sha: SHA, findMainRuns: lookup.findMainRuns, ...over }) };
  };

  it('selects nothing when main\'s push run proved this exact commit, and names that run', () => {
    const { scope, asked } = release(JSON.stringify([mainRun]));
    assert.deepEqual(asked, [SHA]);
    assert.equal(scope.mode, 'reused');
    assert.deepEqual(onChecks(scope), []);
    assert.deepEqual(scope.workspaces, []);
    assert.deepEqual(coverageLegs(scope), []);
    assert.deepEqual(windowsRuns(scope), []);
    assert.deepEqual(scope.proof, { url: URL, sha: SHA });
    assert.ok(scope.reason.includes(URL), scope.reason);
  });

  for (const [title, output] of [
    ['no run at that commit', '[]'],
    ['the lookup throwing', new Error('gh: HTTP 403: Resource not accessible by integration')],
    ['a run for a different SHA', JSON.stringify([{ ...mainRun, headSha: '0'.repeat(40) }])],
    ['a run on another branch', JSON.stringify([{ ...mainRun, headBranch: 'release-0.13' }])],
    ['a pull_request run', JSON.stringify([{ ...mainRun, event: 'pull_request' }])],
    ['a workflow_dispatch run', JSON.stringify([{ ...mainRun, event: 'workflow_dispatch' }])],
    ['a failed run', JSON.stringify([{ ...mainRun, conclusion: 'failure' }])],
    ['a cancelled run', JSON.stringify([{ ...mainRun, conclusion: 'cancelled' }])],
    ['a run with no URL', JSON.stringify([{ ...mainRun, url: undefined }])],
    ['output that is not JSON', 'gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.'],
    ['JSON that is no list', '{"databaseId":1}'],
    ['a list of nulls', '[null]'],
  ]) {
    it(`runs everything for ${title}`, () => {
      const { scope } = release(output);
      assert.equal(scope.mode, 'full');
      assert.deepEqual(offChecks(scope), []);
      assert.deepEqual(scope.proof, undefined);
    });
  }

  it('runs everything without asking when it has no full SHA to ask about', () => {
    for (const sha of [undefined, '', 'main', SHA.slice(0, 7)]) {
      const { scope, asked } = release(JSON.stringify([mainRun]), { sha });
      assert.equal(scope.mode, 'full', String(sha));
      assert.deepEqual(asked, []);
    }
  });

  it('keeps today\'s scope when the input is off, and never looks a run up', () => {
    for (const reuseMainProof of [false, undefined, 'true']) {
      const { scope, asked } = release(JSON.stringify([mainRun]), { reuseMainProof });
      assert.deepEqual(scope, scopeForEvent('push', '.', workspaces), String(reuseMainProof));
      assert.deepEqual(asked, []);
    }
  });
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
    ['vitest.shared.ts', ALL, WINDOWS_ALL, ['engine', 'lint', 'merge', 'sandbox', 'suites', 'windows']],
    ['vitest.setup.ts', ALL, WINDOWS_ALL, ['engine', 'lint', 'merge', 'sandbox', 'suites', 'windows']],
    ['.gitattributes', {}, WINDOWS_ALL, ['harness', 'windows']],
    ['bench/README.md', {}, {}, []],
    ['bench/scale/README.md', {}, {}, []],
    ['bench/live/.gitignore', {}, {}, []],
    ['bench/pipeline/fake-claude/fake-claude.mjs', { [CORE]: 'full', [CLI]: 'full' }, { [CORE]: 'full', [CLI]: 'full' },
      ['bench', 'desktop', 'engine', 'harness', 'integration', 'merge', 'suites', 'tour', 'windows']],
    ['bench/pipeline/fake-claude/claude.cmd', { [CORE]: 'full', [CLI]: 'full' }, { [CORE]: 'full', [CLI]: 'full' },
      ['bench', 'desktop', 'engine', 'harness', 'integration', 'merge', 'suites', 'tour', 'windows']],
    ['bench/pipeline/fake-acp/fake-acp.mjs', { [CORE]: 'full' }, { [CORE]: 'full' }, ['bench', 'harness', 'merge', 'suites', 'windows']],
    ['bench/pipeline/fake-opencode/fake-opencode.mjs', {}, {}, ['engine']],
    ['bench/pipeline/fake-provider/fake-provider.mjs', {}, {}, ['engine']],
    ['bench/pipeline/drive-pipeline.mjs', {}, {}, ['bench', 'harness']],
    ['bench/live/mock-provider.mjs', {}, {}, ['binary', 'desktop', 'harness', 'planner', 'tour']],
    ['bench/live/scenarios.mjs', {}, {}, ['binary', 'desktop', 'harness', 'planner', 'tour']],
    ['bench/live/drive-conversation.mjs', {}, {}, ['harness', 'planner']],
    ['bench/live/drive-taskops.mjs', {}, {}, ['harness', 'planner']],
    ['bench/live/drive-conversation.test.mjs', {}, {}, ['bench', 'harness']],
    ['bench/lib/data-dir.mjs', {}, {}, ['bench', 'harness', 'planner']],
    ['bench/lib/data-dir.test.mjs', {}, {}, ['bench', 'harness', 'planner']],
    ['bench/live/drive-binary.mjs', {}, {}, ['binary']],
    ['bench/live/webview-harness.mjs', {}, {}, []],
    ['bench/live/host-driver.mjs', {}, {}, []],
    ['bench/live/opencode-research-agent-probe.mjs', {}, {}, []],
    ['bench/live/acp-subagent-probe.mjs', {}, {}, []],
    ['bench/live/acp-subagent-probe-lib.mjs', {}, {}, ['bench', 'harness']],
    ['bench/live/acp-subagent-probe.test.mjs', {}, {}, ['bench', 'harness']],
    ['bench/containers/verdict.mjs', {}, {}, ['bench', 'engine', 'harness']],
    ['bench/lab/lab.mjs', {}, {}, ['bench', 'harness']],
    ['bench/planner-eval/run.mjs', {}, {}, ['bench', 'harness']],
    ['bench/planner-eval/goals/g4.json', {}, {}, ['bench', 'harness']],
    ['bench/planner-eval/README.md', {}, {}, []],
    ['bench/planner-eval/.gitignore', {}, {}, []],
    ['bench/scale/entry.ts', {}, {}, ['bench', 'harness', 'lint']],

    // scripts/ and packaging/: test:bench runs scripts/**/*.test.mjs, here and
    // in windows-harness, so whatever only those tests read owes bench alone.
    ['scripts/install/cli.sh', {}, {}, ['bench', 'harness']],
    ['scripts/install/cli.test.mjs', {}, {}, ['bench', 'harness']],
    ['scripts/install/desktop.sh', {}, {}, ['bench', 'harness']],
    ['scripts/install/desktop.ps1', {}, {}, ['bench', 'harness']],
    ['scripts/install/desktop.test.mjs', {}, {}, ['bench', 'harness']],
    ['scripts/shellcheck.json', {}, {}, ['bench', 'harness']],
    ['scripts/shellcheck.mjs', {}, {}, ['bench', 'harness']],
    ['scripts/shellcheck.test.mjs', {}, {}, ['bench', 'harness']],
    ['scripts/host-tools.mjs', {}, {}, ['bench', 'harness']],
    ['scripts/host-tools.test.mjs', {}, {}, ['bench', 'harness']],
    ['packaging/homebrew/ordewell.rb.tmpl', {}, {}, ['bench', 'harness']],
    ['packaging/homebrew/ordewell-desktop.rb.tmpl', {}, {}, ['bench', 'harness']],
    ['packaging/winget/Ordewell.Ordewell.yaml.tmpl', {}, {}, ['bench', 'harness']],
    ['packaging/winget/Ordewell.Ordewell.installer.yaml.tmpl', {}, {}, ['bench', 'harness']],
    ['packaging/winget/Ordewell.Ordewell.locale.en-US.yaml.tmpl', {}, {}, ['bench', 'harness']],
    ['scripts/render-package-manifests.mjs', {}, {}, ['bench', 'harness']],
    ['scripts/render-package-manifests.test.mjs', {}, {}, ['bench', 'harness']],
    ['scripts/publish-tap.sh', {}, {}, ['bench', 'harness']],
    ['scripts/publish-tap.test.mjs', {}, {}, ['bench', 'harness']],
    ['scripts/homebrew-publish.test.mjs', {}, {}, ['bench', 'harness']],
    ['scripts/verify-brew-install.sh', {}, {}, ['bench', 'harness']],
    ['scripts/desktop-release-assets.mjs', {}, {}, ['bench', 'harness']],
    ['scripts/release-latest.mjs', {}, {}, ['bench', 'harness']],
    ['scripts/release-latest.test.mjs', {}, {}, ['bench', 'harness']],
    ['scripts/cli-release.test.mjs', {}, {}, ['bench', 'harness']],
    ['scripts/desktop-release.test.mjs', {}, {}, ['bench', 'harness']],
    ['scripts/sea/build.mjs', {}, {}, ['bench', 'binary', 'harness']],
    ['scripts/sea/build.test.mjs', {}, {}, ['bench', 'harness']],
    ['packaging/sea/entitlements.plist', {}, {}, ['bench', 'harness']],
    ['scripts/package-check.mjs', {}, {}, ['bench', 'harness', 'package']],
    ['scripts/desktop-package-check.mjs', {}, {}, ['bench', 'harness', 'package']],
    ['scripts/desktop-package-check.test.mjs', {}, {}, ['bench', 'harness']],
    ['scripts/desktop-package.test.mjs', {}, {}, ['bench', 'harness']],
    ['scripts/test-stdout.test.mjs', {}, {}, ['bench', 'harness']],
    // build-and-test runs every verify script on every change; windows-harness only when owed.
    ['scripts/verify-adr.mjs', {}, {}, ['harness']],
    ['scripts/verify-fresh-install.mjs', {}, {}, ['harness']],
    ['scripts/verify-migration.mjs', {}, {}, ['harness']],
    ['scripts/verify-notice.mjs', {}, {}, ['harness']],
    ['scripts/verify-skills.mjs', {}, {}, ['harness']],
    ['scripts/linux-sandbox-e2e.sh', {}, {}, ['bench', 'harness', 'sandbox']],
    ['scripts/linux-sandbox-e2e.test.mjs', {}, {}, ['bench', 'harness']],
    // The bench step runs its tests, which import its pull helpers.
    ['scripts/container-e2e.mjs', {}, {}, ['bench', 'engine', 'harness']],
    ['scripts/container-e2e.test.mjs', {}, {}, ['bench', 'harness']],
    ['scripts/change-scope.test.mjs', {}, {}, ['bench', 'harness']],
    ['scripts/network-retry.mjs', {}, {}, ['bench', 'engine', 'harness', 'package']],
    ['scripts/network-retry.test.mjs', {}, {}, ['bench', 'harness']],
    ['scripts/node-test-annotations.mjs', {}, {}, ['bench', 'harness']],
    ['scripts/node-test-annotations.test.mjs', {}, {}, ['bench', 'harness']],
  ]) {
    it(`owes ${on.join(', ') || 'nothing'} for ${path}`, () => {
      const scope = selected(path);
      assert.deepEqual({ suites: scope.suites, windowsSuites: scope.windowsSuites, on: onChecks(scope) }, { suites, windowsSuites, on });
      assert.equal(scope.mode, on.length ? 'selected' : 'docs');
    });
  }

  it('walks no tour for the installer, the Homebrew templates or their renderer: none of them draws a layout', () => {
    for (const path of ['scripts/install/cli.sh', 'packaging/homebrew/ordewell.rb.tmpl', 'packaging/homebrew/ordewell-desktop.rb.tmpl',
      'scripts/render-package-manifests.mjs']) {
      const scope = selected(path);
      assert.equal(scope.mode, 'selected', path);
      assert.equal(scope.checks.tour, false, path);
      assert.equal(scope.checks.desktop, false, path);
      assert.deepEqual(scope.suites, {}, path);
    }
  });

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
    ['.github/workflows/homebrew-publish.yml', 'the manual re-publish to the Homebrew tap: ci.yml cannot judge it, so the full run does'],
    ['.github/actions/setup/action.yml', 'how every job installs and builds'],
    ['scripts/change-scope.mjs', 'selection itself'],
    ['scripts/ci-scope.mjs', 'what ci.yml runs selection with'],
    ['scripts/ci.mjs', 'npm run ci, which mirrors every ci.yml step'],
    ['scripts/test-changed.mjs', 'the local inner loop'],
    ['scripts/npm.mjs', 'how every script starts npm'],
    ['scripts/generate-third-party-notices.mjs', 'every package build runs it, the tour\'s included'],
    ['scripts/new-tool.mjs', 'a script no owner claims yet'],
    ['scripts/install/new.sh', 'a new installer, which a release may ship'],
    ['scripts/sea/sign.mjs', 'a new build step'],
    ['scripts/verify-new.mjs', 'a new verify script, which may read past what it verifies'],
    ['packaging/apt/control.tmpl', 'a new package manager'],
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

  it('owns the local proof tests and path guard through the bench check that runs them', () => {
    for (const path of ['scripts/test-changed.test.mjs', 'scripts/test-path-portability.mjs', 'scripts/test-path-portability.test.mjs']) {
      const scope = selected(path);
      assert.equal(scope.mode, 'selected', path);
      assert.deepEqual(onChecks(scope), ['bench', 'harness'], path);
    }
  });

  it('owes the bench step for the scale harness refactor that broke session.persist (#66 F3)', () => {
    const plan = runs('packages/core/src/services/Session.ts');
    assert.ok(plan.steps.some(({ job, id }) => job === 'build-and-test' && id === 'bench'));
  });

  it('runs core and its dependents with coverage for an exported core change', () => {
    const plan = runs('packages/core/src/index.ts');
    for (const dir of [CORE, CLI, DESKTOP, UI, VSCODE, WEB]) assert.equal(script(plan, dir), 'test:coverage');
  });

  it('runs web with coverage, and the cli and desktop quick', () => {
    const plan = runs('packages/web/server/main.ts');
    assert.equal(script(plan, WEB), 'test:coverage');
    assert.equal(script(plan, CLI), 'test:quick');
    assert.equal(script(plan, DESKTOP), 'test:quick');
    assert.equal(script(plan, CORE), undefined);
    assert.equal(script(plan, VSCODE), undefined);
  });

  it('runs ui with coverage, and vscode and desktop quick', () => {
    const plan = runs('packages/ui/src/chat/hostState.ts');
    assert.equal(script(plan, UI), 'test:coverage');
    assert.equal(script(plan, VSCODE), 'test:quick');
    assert.equal(script(plan, DESKTOP), 'test:quick');
    assert.equal(script(plan, CORE), undefined);
  });

  it('runs a package whole when what changed is no source vitest can follow', () => {
    assert.equal(script(runs('packages/web/tsup.config.ts'), WEB), 'test:coverage');
  });

  it('runs a package whole for a deleted source: nothing imports it for vitest to follow', () => {
    const plan = localRuns(['packages/web/server/removed.ts'], workspaces);
    assert.equal(script(plan, WEB), 'test:coverage');
  });

  it('runs every full suite with coverage on the full fallback', () => {
    const plan = runs('scripts/ci.mjs');
    for (const dir of [CORE, CLI, UI, VSCODE, WEB, DESKTOP]) assert.equal(script(plan, dir), 'test:coverage');
    assert.match(plan.note, /scripts\/ci\.mjs/);
  });

  it('runs no workspace suite with nothing changed or for docs', () => {
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
  const docsJobs = linux({ 'desktop-tour': skipped, typecheck: skipped, coverage: skipped, 'coverage-merge': skipped, lint: skipped, package: skipped });
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

  it('passes a change that owes core no full suite without a coverage merge', () => {
    assert.deepEqual(gateFailures('pull_request', { scope: scoped(webOnly), ...linux({ 'coverage-merge': skipped }), 'real-engine': skipped, ...onWindows(passed) }), []);
  });

  it('passes a desktop change without the Windows suites, none of which it reaches', () => {
    const scope = selected('packages/desktop/src/main/index.ts');
    assert.deepEqual(gateFailures('pull_request', { scope: scoped(scope), ...linux(), 'real-engine': skipped, windows: skipped, 'windows-harness': passed }), []);
  });

  it('passes a .gitattributes change that ran only Windows', () => {
    const scope = selected('.gitattributes');
    assert.deepEqual(gateFailures('pull_request', { scope: scoped(scope), ...docsJobs, 'real-engine': skipped, ...onWindows(passed) }), []);
  });

  describe('for a release that reused main\'s proof', () => {
    const URL = 'https://github.com/ordewell/ordewell/actions/runs/42286454001';
    const SHA = '1374ff43a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const reused = scopeForEvent('push', '.', workspaces, {
      reuseMainProof: true,
      sha: SHA,
      findMainRuns: () => JSON.stringify([{ databaseId: 42286454001, url: URL, headSha: SHA, event: 'push', headBranch: 'main', conclusion: 'success' }]),
    });
    const allSkipped = { ...Object.fromEntries(Object.keys(STEPS_BY_JOB).map((job) => [job, skipped])), 'real-engine': skipped, ...onWindows(skipped) };
    const on = { reuseMainProof: true };

    it('passes when every other job was skipped', () => {
      assert.deepEqual(gateFailures('push', { scope: scoped(reused), ...allSkipped }, on), []);
    });

    for (const [title, needs, options] of [
      ['the input was off: a plain push cannot claim a proof', { scope: scoped(reused), ...allSkipped }, {}],
      ['the scope names no run', { scope: scoped({ ...reused, proof: undefined }), ...allSkipped }, on],
      ['the scope turned a check on', { scope: scoped({ ...reused, checks: { ...reused.checks, lint: true } }), ...allSkipped }, on],
      ['the scope job failed', { scope: { ...scoped(reused), result: 'failure' }, ...allSkipped }, on],
      ['a job that ran anyway failed', { scope: scoped(reused), ...allSkipped, lint: failed }, on],
      ['a job is missing altogether', without({ scope: scoped(reused), ...allSkipped }, 'windows')],
    ]) {
      it(`fails when ${title}`, () => assert.notDeepEqual(gateFailures('push', needs, options ?? on), []));
    }

    it('still fails a full push that skipped a job when the input is on', () => {
      assert.notDeepEqual(gateFailures('push', { scope: scoped(full), ...allSkipped }, on), []);
    });
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
    ['the coverage merge was skipped for a core change', 'pull_request', { scope: scoped(coreChange), ...linux({ 'coverage-merge': skipped }), 'real-engine': passed, ...onWindows(passed) }],
    ['the coverage merge was skipped on a push', 'push', { scope: scoped(full), ...linux({ 'coverage-merge': skipped }), 'real-engine': passed, ...onWindows(passed) }],
    ['the coverage merge failed: a shard\'s test, a floor or a blob', 'push', { scope: scoped(full), ...linux({ 'coverage-merge': failed }), 'real-engine': passed, ...onWindows(passed) }],
    ['the coverage merge never confirmed its step', 'pull_request', { scope: scoped(coreChange), ...linux({ 'coverage-merge': passed }), 'real-engine': passed, ...onWindows(passed) }],
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
      assert.deepEqual(JSON.parse(outputs.coverage), workspaces.flatMap((w) => {
        const name = w.dir.split('/').at(-1);
        const shards = COVERAGE_SHARDS[w.dir];
        if (!shards) return [{ workspace: w.dir, name, script: 'test:coverage' }];
        return Array.from({ length: shards }, (_, i) => ({ workspace: w.dir, name: `${name}-${i + 1}-of-${shards}`, script: 'test:coverage:shard', shard: `${i + 1}/${shards}` }));
      }), EVENT);
      assert.deepEqual(JSON.parse(outputs.merges), [{ workspace: CORE, name: 'core', shards: COVERAGE_SHARDS[CORE] }], EVENT);
      for (const check of CHECKS) assert.equal(outputs[check], 'true', `${EVENT} ${check}`);
      assert.equal(JSON.parse(outputs.scope).mode, 'full');
    }
  });

  it('runs everything for a release whose lookup cannot run, and names no proof', () => {
    // No gh on PATH: the lookup fails, as it would without a token or a network.
    const dir = scratch();
    const GITHUB_OUTPUT = join(dir, 'output');
    const GITHUB_STEP_SUMMARY = join(dir, 'summary');
    writeFileSync(GITHUB_OUTPUT, '');
    const env = { ...process.env, PATH: dir, Path: dir, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY, EVENT: 'push', REUSE_MAIN_PROOF: 'true', GITHUB_SHA: '1374ff43a1b2c3d4e5f60718293a4b5c6d7e8f90', GITHUB_REPOSITORY: 'ordewell/ordewell' };
    const { status, stdout, stderr } = spawnSync(process.execPath, [cli, 'select'], { encoding: 'utf8', env });
    assert.equal(status, 0, stderr);
    const outputs = Object.fromEntries(readFileSync(GITHUB_OUTPUT, 'utf8').split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    assert.equal(JSON.parse(outputs.scope).mode, 'full');
    for (const check of CHECKS) assert.equal(outputs[check], 'true', check);
    assert.equal(outputs.proof, '');
    assert.match(stdout, /could not look up main's runs/);
  });

  it('gates a reused release by the input the caller gave, which a plain push lacks', () => {
    const SHA = '1374ff43a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const URL = 'https://github.com/ordewell/ordewell/actions/runs/42286454001';
    const reused = scopeForEvent('push', '.', workspaces, { reuseMainProof: true, sha: SHA, findMainRuns: () => JSON.stringify([{ databaseId: 1, url: URL, headSha: SHA, event: 'push', headBranch: 'main', conclusion: 'success' }]) });
    const skipped = { result: 'skipped', outputs: {} };
    const needs = JSON.stringify({ scope: { result: 'success', outputs: { scope: JSON.stringify(reused) } }, ...Object.fromEntries([...Object.keys(STEPS_BY_JOB), 'real-engine', ...Object.keys(WINDOWS_JOBS)].map((job) => [job, skipped])) });
    assert.equal(run('gate', { EVENT: 'push', NEEDS: needs, REUSE_MAIN_PROOF: 'true' }).status, 0);
    assert.equal(run('gate', { EVENT: 'push', NEEDS: needs, REUSE_MAIN_PROOF: '' }).status, 1);
    assert.equal(run('gate', { EVENT: 'push', NEEDS: needs, REUSE_MAIN_PROOF: 'false' }).status, 1);
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

  it('splits a suite owed in full into the shards COVERAGE_SHARDS gives it, which one merge leg joins', () => {
    const scope = selected('packages/core/src/index.ts');
    const shards = COVERAGE_SHARDS[CORE];
    assert.ok(Number.isInteger(shards) && shards > 1, 'core is not sharded');
    const legs = coverageLegs(scope).filter((leg) => leg.workspace === CORE);
    assert.deepEqual(legs, Array.from({ length: shards }, (_, i) => ({ workspace: CORE, name: `core-${i + 1}-of-${shards}`, script: 'test:coverage:shard', shard: `${i + 1}/${shards}` })));
    assert.deepEqual(coverageMerges(scope), [{ workspace: CORE, name: 'core', shards }]);
    assert.equal(scope.checks.merge, true);
    // Only core is sharded: every other suite owed in full keeps its one leg, floors and all.
    for (const leg of coverageLegs(scope).filter((leg) => leg.workspace !== CORE)) assert.ok(!leg.shard, leg.name);
  });

  it('runs core whole and quick, with nothing to merge, when the change owes it only quick', () => {
    const scope = { ...selected('packages/core/src/index.ts'), workspaces: [CORE], suites: { [CORE]: 'quick' } };
    assert.deepEqual(coverageLegs(scope), [{ workspace: CORE, name: 'core-quick', script: 'test:quick' }]);
    assert.deepEqual(coverageMerges(scope), []);
    const web = selected('packages/web/server/main.ts');
    assert.equal(web.checks.merge, false);
    assert.deepEqual(coverageMerges(web), []);
  });

  it('refuses to merge unless every shard of this count left its blob, and nothing else lies beside them', () => {
    assert.deepEqual(blobProblems(['blob-1-3.json', 'blob-2-3.json', 'blob-3-3.json'], 3), []);
    assert.deepEqual(blobProblems(['blob-1-3.json', 'blob-3-3.json'], 3), ['blob-2-3.json: missing, so shard 2/3 left no tests or coverage to merge']);
    assert.deepEqual(blobProblems(['blob-1-2.json', 'blob-2-2.json', 'blob-1-3.json'], 2), ['blob-1-3.json: not one of this run\'s 2 shards']);
    assert.equal(blobProblems([], 2).length, 2);
    for (const count of [Number.NaN, 0, 1.5]) assert.deepEqual(blobProblems([], count), [`${count} is not a count of shards`]);
  });

  it('summarises a whole suite\'s coverage and a merged one\'s, never a shard\'s', () => {
    const table = (pct) => `% Coverage report from v8\n=============================== Coverage summary ===============================\nStatements   : ${pct}% ( 1/1 )\n================================================================================\nmore`;
    const log = [
      '> @ordewell/web@1.0.0 test:coverage', table(90),
      '> @ordewell/core@1.0.0 test:coverage:shard', table(40),
      '> @ordewell/core@1.0.0 test:coverage:merge', table(95),
      '> @ordewell/cli@1.0.0 test:quick', 'no coverage',
    ].join('\n');
    const summary = coverageSummaries(log);
    assert.ok(summary.includes('### Coverage — `@ordewell/web`'), summary);
    assert.ok(summary.includes('### Coverage — `@ordewell/core`'), summary);
    assert.ok(summary.includes('Statements   : 95%'), summary);
    assert.ok(summary.includes('Statements   : 90%'), summary);
    assert.ok(!summary.includes('40%'), 'a shard\'s partial coverage reached the summary');
    assert.ok(!summary.includes('more'), 'the summary ran past its table');
    assert.equal(coverageSummaries('no runs here'), '');
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

  it('merges nothing on the leg a lost scope gives, whose suites the coverage job judged whole', () => {
    const { status } = run('coverage-merge', { WORKSPACE: '', SHARDS: '' });
    assert.equal(status, 0);
  });

  it('fails a merge that a shard left no blob for, before vitest would merge the rest without it', () => {
    const dir = scratch();
    const reports = join(dir, 'packages', 'core', '.vitest-reports');
    mkdirSync(reports, { recursive: true });
    writeFileSync(join(reports, 'blob-1-3.json'), '[]');
    writeFileSync(join(reports, 'blob-3-3.json'), '[]');
    const { status, stderr } = run('coverage-merge', { WORKSPACE: 'packages/core', SHARDS: '3' }, dir);
    assert.equal(status, 1);
    assert.match(stderr, /blob-2-3\.json: missing/);
    // No blobs at all, as when the download found no artifact.
    const empty = run('coverage-merge', { WORKSPACE: 'packages/web', SHARDS: '2' }, dir);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /blob-1-2\.json: missing/);
  });

  it('writes the coverage log\'s summaries to the job summary, and nothing without a log', () => {
    const dir = scratch();
    const GITHUB_STEP_SUMMARY = join(dir, 'summary');
    writeFileSync(GITHUB_STEP_SUMMARY, '');
    assert.equal(run('coverage-summary', { GITHUB_STEP_SUMMARY }, dir).status, 0);
    assert.equal(readFileSync(GITHUB_STEP_SUMMARY, 'utf8'), '');
    writeFileSync(join(dir, 'coverage.log'), '> @ordewell/core@1.0.0 test:coverage:merge\n=============================== Coverage summary ===============================\nLines        : 97.92% ( 1/1 )\n====================\n');
    assert.equal(run('coverage-summary', { GITHUB_STEP_SUMMARY }, dir).status, 0);
    assert.match(readFileSync(GITHUB_STEP_SUMMARY, 'utf8'), /### Coverage — `@ordewell\/core`[\s\S]*Lines {8}: 97\.92%/);
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
  const jobGate = (check, needs = 'scope') => new RegExp(`needs: ${needs.replace(/[[\]]/g, '\\$&')}\\n\\s+if: \\$\\{\\{ !cancelled\\(\\) && needs\\.scope\\.outputs\\.${check} != 'false' \\}\\}`);
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
        // coverage-merge reads what the coverage job's shards left.
        const needs = job === 'coverage-merge' ? '[scope, coverage]' : 'scope';
        assert.match(jobBlock(job), jobGate(check, needs), `job ${job} is not gated on ${check} as a default-run`);
        assert.doesNotMatch(stepIn(job, id), /^\s*if:/m, `${job} ${id}`);
      }
    }
  });

  it('hands every check on from the scope job: a missing output reads as empty, and the step would run on every change', () => {
    for (const check of [...CHECKS, 'coverage', 'merges']) {
      assert.ok(jobBlock('scope').includes(`${check}: \${{ steps.select.outputs.${check} }}`), `the scope job does not output ${check}`);
    }
  });

  it('lets no required step fail quietly', () => {
    assert.doesNotMatch(workflow, /continue-on-error/);
  });

  it('keeps build-and-test and the engine alive when the scope job fails, and skips build-and-test only for a named proof', () => {
    assert.ok(jobBlock('build-and-test').includes("needs: scope\n    if: ${{ !cancelled() && needs.scope.outputs.proof == '' }}"), 'build-and-test is not a default-run');
    assert.ok(jobBlock('scope').includes('proof: ${{ steps.select.outputs.proof }}'), 'the scope job does not output proof');
    assert.match(jobBlock('real-engine'), jobGate('engine'));
  });

  it('runs each Windows job on its own check, and keeps it alive when the scope job fails', () => {
    for (const [job, check] of Object.entries(WINDOWS_JOBS)) {
      assert.match(jobBlock(job), jobGate(check), job);
      assert.match(jobBlock(job), /runs-on: windows-2025-vs2026/, job);
    }
  });

  it('splits the Windows suites into shards numbered from one, and names each by the matrix\'s own total', () => {
    const windows = jobBlock('windows');
    const shards = JSON.parse(windows.match(/^\s+shard: (\[[\d, ]+\])$/m)[1]);
    assert.deepEqual(shards, shards.map((_, i) => i + 1));
    assert.equal(shards.length, 12);
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
      'Install dependencies and build every package',
      'Install xvfb if the image lacks it',
      'Desktop app — visual tour and layout checks',
      'Upload the desktop tour report',
      'Confirm every step this change owed ran',
    ]);
    const report = stepNamed('desktop-tour', 'Upload the desktop tour report');
    assert.match(report, /failure\(\)/);
    assert.match(report, /path: packages\/desktop\/test-results\/tour/);
  });

  it('walks the tour in legs numbered from one, each knowing its share, every leg to the end, each report apart', () => {
    const tour = jobBlock('desktop-tour');
    const legs = JSON.parse(tour.match(/^\s+leg: (\[[\d, ]+\])$/m)[1]);
    assert.deepEqual(legs, legs.map((_, i) => i + 1));
    // The tour shoots two themes at three sizes (packages/desktop/e2e/tour.spec.ts), and refuses a leg with none of them.
    assert.ok(legs.length >= 1 && legs.length <= 6, `${legs.length} legs`);
    assert.ok(tour.includes('name: desktop-tour (${{ matrix.leg }}/${{ strategy.job-total }})'));
    assert.match(tour, /fail-fast: false/);
    assert.ok(stepIn('desktop-tour', 'desktop-tour').includes('TOUR_LEG: ${{ matrix.leg }}/${{ strategy.job-total }}'), 'a leg does not know which it is');
    assert.ok(stepNamed('desktop-tour', 'Upload the desktop tour report').includes('name: desktop-tour-report-${{ matrix.leg }}-of-${{ strategy.job-total }}'), 'legs would upload over one another');
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
    assert.ok(step.includes('SHARD: ${{ matrix.shard }}'));
    assert.ok(step.includes('npm run "${SCRIPT:-test:coverage}" ${WORKSPACE:+-w "$WORKSPACE"} --if-present ${SHARD:+-- "--shard=$SHARD"}'), 'a leg does not run its own workspace\'s script, or its own shard of it');
    assert.match(step, /set -o pipefail/);
    const upload = stepNamed('coverage', 'Upload coverage reports');
    assert.ok(upload.includes('name: coverage-reports-${{ matrix.name }}'), 'legs would upload over one another');
    // A shard's coverage is part of the suite's: coverage-merge uploads the whole.
    assert.ok(upload.includes("if: ${{ always() && matrix.script != 'test:quick' && !matrix.shard }}"), 'a quick leg, which writes no report, or a shard would upload one');
    const blob = stepNamed('coverage', "Upload the shard's coverage blob");
    assert.ok(blob, 'a shard does not hand its blob on');
    // A shard whose tests failed still leaves its blob, and the merge fails on them.
    assert.ok(blob.includes('if: ${{ always() && matrix.shard }}'));
    assert.ok(blob.includes('name: coverage-blob-${{ matrix.name }}'));
    assert.ok(blob.includes('path: ${{ matrix.workspace }}/.vitest-reports/'));
    // upload-artifact leaves a hidden directory out unless told.
    assert.ok(blob.includes('include-hidden-files: true'));
    assert.ok(blob.includes('if-no-files-found: error'));
  });

  it('merges each sharded suite\'s blobs in a job of its own, and judges its floors on the whole', () => {
    const merge = jobBlock('coverage-merge');
    assert.match(merge, /fail-fast: false/);
    assert.ok(merge.includes('name: coverage merge (${{ matrix.name }})'));
    const fallback = merge.match(/include: \$\{\{ fromJSON\(needs\.scope\.outputs\.merges \|\| '(.+)'\) \}\}/);
    assert.ok(fallback, 'the matrix does not fall back when the scope output is lost');
    // The coverage job's fallback runs every suite whole, so this one names no workspace.
    assert.deepEqual(JSON.parse(fallback[1]), [{ workspace: '', name: 'every workspace' }]);
    // The merge reads only the blobs and the config, never a dist/.
    const install = stepNamed('coverage-merge', 'Install dependencies');
    assert.match(install, /uses: \.\/\.github\/actions\/setup\n/);
    assert.doesNotMatch(install, /build:/);
    const download = stepNamed('coverage-merge', "Download the shards' coverage blobs");
    // The pattern finds a blob by its leg's name, so each merge must find its own shards' legs and no other.
    const full = fullScope('a push', workspaces);
    for (const { workspace, name } of coverageMerges(full)) {
      const found = coverageLegs(full).filter((leg) => leg.name.startsWith(`${name}-`));
      assert.deepEqual(found.map((leg) => leg.workspace), found.map(() => workspace), name);
      assert.ok(found.length > 1 && found.every((leg) => leg.shard), name);
    }
    assert.ok(download.includes('pattern: coverage-blob-${{ matrix.name }}-*'));
    assert.ok(download.includes('path: ${{ matrix.workspace }}/.vitest-reports'));
    assert.ok(download.includes('merge-multiple: true'));
    const step = stepIn('coverage-merge', 'merge-coverage');
    assert.ok(step.includes('WORKSPACE: ${{ matrix.workspace }}'));
    assert.ok(step.includes('SHARDS: ${{ matrix.shards }}'));
    assert.ok(step.includes('node scripts/ci-scope.mjs coverage-merge'));
    assert.match(step, /set -o pipefail/);
    const upload = stepNamed('coverage-merge', 'Upload coverage reports');
    assert.ok(upload.includes('name: coverage-reports-${{ matrix.name }}'));
    assert.ok(upload.includes('path: ${{ matrix.workspace }}/coverage/'));
    assert.ok(stepNamed('coverage-merge', 'Append coverage summaries to the job summary').includes('node scripts/ci-scope.mjs coverage-summary'));
    assert.ok(jobBlock('required-checks').includes('coverage, coverage-merge,'), 'the gate does not read the merge');
  });

  it('lints without building, and builds every package before typecheck, coverage, packaging and the tour', () => {
    const install = stepNamed('lint', 'Install dependencies');
    assert.match(install, /uses: \.\/\.github\/actions\/setup\n/);
    assert.doesNotMatch(install, /build:/);
    assert.doesNotMatch(jobBlock('lint'), /id: build-/);
    for (const job of ['typecheck', 'package', 'coverage', 'desktop-tour']) {
      const block = jobBlock(job);
      const owed = Object.values(STEPS_BY_JOB[job]).flat()[0];
      assert.match(stepIn(job, 'setup'), /uses: \.\/\.github\/actions\/setup\n\s+with:\n\s+build: all\n/, job);
      assert.ok(block.indexOf('id: setup') < block.indexOf(`id: ${owed}`), job);
    }
  });

  it('builds core before build-and-test\'s first check, and the rest where only their readers run', () => {
    const block = jobBlock('build-and-test');
    assert.match(stepIn('build-and-test', 'build-core'), /uses: \.\/\.github\/actions\/setup\n\s+with:\n\s+build: core\n/);
    const rest = stepIn('build-and-test', 'build-rest');
    assert.match(rest, /uses: \.\/\.github\/actions\/setup\n/);
    assert.match(rest, /build: ui vscode cli web desktop\n/);
    // Only the desktop e2e launches Electron, so only it fetches the binary.
    assert.ok(rest.includes("electron: ${{ needs.scope.outputs.desktop != 'false' }}"));
    assert.ok(block.indexOf('id: build-core') < block.indexOf('id: build-rest'));
    for (const id of Object.values(STEPS_BY_JOB['build-and-test']).flat().filter((id) => !id.startsWith('build-'))) {
      assert.ok(block.indexOf('id: build-core') < block.indexOf(`id: ${id}`), id);
    }
    for (const id of ['vscode-integration', 'desktop-e2e']) assert.ok(block.indexOf('id: build-rest') < block.indexOf(`id: ${id}`), id);
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

  it('reuses main\'s proof only when its caller asks, as release.yml does', () => {
    const call = workflow.match(/^ {2}workflow_call:\n((?: {4}.*\n)+)/m);
    assert.ok(call, 'workflow_call takes no input');
    assert.match(call[1], /^ {4}inputs:\n {6}reuse-main-proof:\n(?: {8}.*\n)*? {8}type: boolean\n(?: {8}.*\n)*? {8}default: false\n/m);
    const select = stepIn('scope', 'select');
    assert.ok(select.includes('REUSE_MAIN_PROOF: ${{ inputs.reuse-main-proof }}'), 'select does not hear the input');
    assert.ok(select.includes('GH_TOKEN: ${{ github.token }}'), 'the lookup has no token');
    const gate = stepNamed('required-checks', 'Require every check this change owed');
    assert.ok(gate.includes('REUSE_MAIN_PROOF: ${{ inputs.reuse-main-proof }}'), 'the gate does not hear the input');
    // The pull_request, push, schedule and dispatch runs keep the token they had.
    assert.doesNotMatch(workflow, /^\s*permissions:/m);

    const release = readFileSync('.github/workflows/release.yml', 'utf8');
    const ci = release.match(/^ {2}ci:\n((?: {4}.*\n|\s*\n)+?)(?=^ {2}[\w-]+:$)/m)[1];
    assert.match(ci, /^ {4}with:\n {6}reuse-main-proof: true$/m);
    // The lookup reads Actions; checkout reads contents. Nothing in ci.yml writes.
    assert.match(ci, /^ {4}permissions:\n {6}contents: read\n {6}actions: read$/m);
  });

  it('builds in npm-publish but proves nothing again: the ci job of the same run did', () => {
    const release = readFileSync('.github/workflows/release.yml', 'utf8');
    const publish = release.match(/^ {2}npm-publish:\n((?: {4}.*\n|\s*\n)+?)(?=^ {2}[\w-]+:$)/m)[1];
    const names = [...publish.matchAll(/^ {6}- (?:name|uses): (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(names, [
      'actions/checkout@v7',
      'Use Node.js 22.x',
      'Verify tag matches package versions',
      'Install dependencies',
      'Build',
      'Publish npm packages (dependency order)',
    ]);
    assert.match(publish, /- name: Build\n {8}run: npm run build\n/);
    assert.doesNotMatch(publish, /npm (run )?(test|typecheck)/);
  });

  it('leaves the checkout-only gates off where the gate tests run', () => {
    // delegationSwitch.test.ts asserts they are off, and a variable set here
    // would prove delegation and containers on for the wrong reason.
    assert.doesNotMatch(workflow, /ORDEWELL_(DELEGATION|CONTAINERS)/);
    assert.doesNotMatch(readFileSync('.github/workflows/release.yml', 'utf8'), /ORDEWELL_(DELEGATION|CONTAINERS)/);
  });
});

describe('the order the setup action builds in', () => {
  const dirs = (asked) => buildOrder(asked, workspaces).map((ws) => ws.dir);

  it('brings what a workspace depends on, before it', () => {
    assert.deepEqual(dirs('core'), [CORE]);
    assert.deepEqual(dirs('cli'), [CORE, WEB, CLI]);
    assert.deepEqual(dirs('desktop'), [CORE, UI, WEB, DESKTOP]);
    assert.deepEqual(dirs('ui ui core'), [CORE, UI]);
    assert.deepEqual(dirs(''), []);
  });

  it('builds every workspace for all, each after everything it depends on', () => {
    const order = dirs('all');
    assert.deepEqual([...order].sort(), workspaces.map((ws) => ws.dir).sort());
    for (const ws of workspaces) for (const dep of ws.deps) assert.ok(order.indexOf(dep) < order.indexOf(ws.dir), `${dep} after ${ws.dir}`);
  });

  it('refuses a name no workspace has, and a cycle, rather than build part of it', () => {
    assert.throws(() => dirs('core nonsense'), /no workspace is named nonsense/);
    const cycle = [{ dir: 'packages/a', deps: ['packages/b'] }, { dir: 'packages/b', deps: ['packages/a'] }];
    assert.throws(() => buildOrder('a', cycle), /cycle/);
  });
});

describe('the setup action\'s caches', () => {
  const made = [];
  after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
  const host = { platform: 'linux', arch: 'x64', nodeVersion: 'v22.0.0', env: {}, home: '/home/u', tmp: '/tmp' };
  const buildScript = (code = 0) => `node -e "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/built','');process.exit(${code})"`;

  /** A repository of core, and ui and web on it, as git lists it, whose builds write dist/built. */
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'ordewell-setup-'));
    made.push(root);
    const write = (file, text) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    };
    write('.gitignore', 'dist/\nnode_modules/\n');
    write('package.json', JSON.stringify({ private: true, workspaces: [CORE, UI, WEB], scripts: { postinstall: 'node scripts/postinstall.mjs' } }));
    write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/electron': { version: '45.2.1' }, 'node_modules/electron-builder': { version: '26.18.0' } } }));
    write('tsconfig.json', '{}');
    write('scripts/postinstall.mjs', '');
    write(`${CORE}/package.json`, JSON.stringify({ name: '@f/core', scripts: { build: buildScript() } }));
    write(`${UI}/package.json`, JSON.stringify({ name: '@f/ui', dependencies: { '@f/core': '*' }, scripts: { build: buildScript() } }));
    write(`${WEB}/package.json`, JSON.stringify({ name: '@f/web', dependencies: { '@f/core': '*' }, scripts: { build: buildScript() } }));
    for (const dir of [CORE, UI, WEB]) write(`${dir}/src/index.ts`, `export const name = '${dir}';\n`);
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    return { root, write, workspaces: readWorkspaces(root) };
  };
  const keysOf = ({ root, workspaces: ws }, over = {}) => Object.fromEntries(buildKeys(buildOrder('all', ws), { ...host, ...over, root, workspaces: ws }));

  it('keys a build by the workspace, the host and a hash', () => {
    const keys = keysOf(fixture());
    assert.deepEqual(Object.keys(keys), [CORE, UI, WEB]);
    assert.match(keys[CORE], /^build-linux-x64-core-[0-9a-f]{64}$/);
    assert.notEqual(keys[UI], keysOf(fixture(), { arch: 'arm64' })[UI]);
  });

  it('builds again what a change reaches, through what depends on it, and nothing else', () => {
    const repo = fixture();
    const before = keysOf(repo);
    repo.write(`${WEB}/src/index.ts`, 'export const name = 2;\n');
    const web = keysOf(repo);
    assert.deepEqual([CORE, UI, WEB].filter((dir) => web[dir] !== before[dir]), [WEB]);
    repo.write(`${CORE}/src/index.ts`, 'export const name = 2;\n');
    const core = keysOf(repo);
    assert.deepEqual([CORE, UI, WEB].filter((dir) => core[dir] !== web[dir]), [CORE, UI, WEB]);
  });

  it('reads a new file, a deleted one and a root file every build reads, but not its own gitignored output', () => {
    const repo = fixture();
    const before = keysOf(repo);
    repo.write(`${CORE}/dist/index.js`, 'built');
    assert.deepEqual(keysOf(repo), before);
    repo.write(`${UI}/src/new.ts`, '');
    const added = keysOf(repo);
    assert.notEqual(added[UI], before[UI]);
    unlinkSync(join(repo.root, UI, 'src', 'index.ts'));
    assert.notEqual(keysOf(repo)[UI], added[UI]);
    const kept = keysOf(repo);
    repo.write('tsconfig.json', '{"compilerOptions":{}}');
    const after = keysOf(repo);
    for (const dir of [CORE, UI, WEB]) assert.notEqual(after[dir], kept[dir], dir);
  });

  it('builds again on another Node, or with an environment the build bakes in', () => {
    const repo = fixture();
    const before = keysOf(repo);
    for (const over of [{ nodeVersion: 'v22.1.0' }, { env: { NODE_ENV: 'production' } }, { env: { ORDEWELL_DESKTOP_AUTO_UPDATE: '0' } }]) {
      const after = keysOf(repo, over);
      for (const dir of [CORE, UI, WEB]) assert.notEqual(after[dir], before[dir], `${JSON.stringify(over)} ${dir}`);
    }
    assert.deepEqual(keysOf(repo, { env: { UNRELATED: '1' } }), before);
  });

  it('refuses to key a workspace whose outputs it does not know', () => {
    const ws = [{ dir: 'packages/new', deps: [] }];
    assert.throws(() => buildKeys(ws, { ...host, root: fixture().root, workspaces: ws }), /packages\/new has no BUILD_OUTPUTS entry/);
  });

  it('keys node_modules by what npm ci installs from and runs, not by the source', () => {
    const repo = fixture();
    const key = () => modulesKey({ ...host, root: repo.root, workspaces: repo.workspaces });
    const before = key();
    assert.match(before, /^node-modules-linux-x64-v22\.0\.0-[0-9a-f]{64}$/);
    repo.write(`${CORE}/src/index.ts`, 'changed');
    assert.equal(key(), before);
    const changes = [
      ['package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {} } })],
      [`${UI}/package.json`, JSON.stringify({ name: '@f/ui', dependencies: { '@f/core': '*', left: '1' } })],
      ['scripts/postinstall.mjs', 'console.log(1);'],
      ['.npmrc', 'fund=false'],
    ];
    let last = before;
    for (const [file, text] of changes) {
      repo.write(file, text);
      assert.notEqual(key(), last, file);
      last = key();
    }
    assert.notEqual(modulesKey({ ...host, nodeVersion: 'v22.1.0', root: repo.root, workspaces: repo.workspaces }), last);
  });

  it('plans the install, each build with the paths it caches, and nothing for Electron unless asked', () => {
    const repo = fixture();
    const plan = setupPlan({ build: 'ui' }, { ...host, root: repo.root });
    assert.equal(plan.install, true);
    assert.equal(plan.modulesKey, modulesKey({ ...host, root: repo.root, workspaces: repo.workspaces }));
    assert.deepEqual(plan.builds.map(({ name, dir, paths }) => ({ name, dir, paths })), [
      { name: 'core', dir: CORE, paths: [`${CORE}/dist`] },
      { name: 'ui', dir: UI, paths: [`${UI}/dist`, `${UI}/THIRD-PARTY-NOTICES.md`] },
    ]);
    assert.equal(plan.builds[1].key, keysOf(repo)[UI]);
    assert.equal(plan.electron, null);
    assert.equal(plan.electronBuilder, null);
  });

  it('installs nothing again on a second call in the job, and builds only what the first did not', () => {
    const repo = fixture();
    const plan = setupPlan({ build: 'all', installed: true, built: ['core', 'ui'] }, { ...host, root: repo.root });
    assert.equal(plan.install, false);
    assert.equal(plan.modulesKey, '');
    assert.deepEqual(plan.builds.map(({ name, key }) => [name, key]), [['web', keysOf(repo)[WEB]]]);
  });

  it('caches no node_modules on Windows, where npm ci fills it faster than a restore unpacks it', () => {
    assert.equal(setupPlan({ build: 'core' }, { ...host, platform: 'win32', root: fixture().root }).modulesKey, '');
  });

  it('keys the Electron downloads by the versions the lockfile installs', () => {
    const repo = fixture();
    const plan = setupPlan({ electron: true, electronBuilder: true }, { ...host, root: repo.root });
    assert.deepEqual(plan.builds, []);
    assert.deepEqual(plan.electron, { key: 'electron-linux-x64-electron@45.2.1', path: '/home/u/.cache/electron' });
    assert.deepEqual(plan.electronBuilder, {
      key: 'electron-builder-linux-x64-electron@45.2.1-electron-builder@26.18.0',
      paths: ['/home/u/.cache/electron-builder', '/home/u/.electron-gyp'],
    });
    const windows = setupPlan({ electron: true }, { ...host, platform: 'win32', home: 'C:\\Users\\u', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, root: repo.root });
    assert.equal(windows.electron.path, 'C:\\Users\\u\\AppData\\Local\\electron\\Cache');
  });

  it('finds the Electron caches where electron, electron-builder and @electron/rebuild look', () => {
    const linux = { platform: 'linux', home: '/home/u', tmp: '/tmp' };
    assert.equal(electronCacheDir({ ...linux, env: {} }), '/home/u/.cache/electron');
    assert.equal(electronCacheDir({ ...linux, env: { XDG_CACHE_HOME: '/xdg' } }), '/xdg/electron');
    assert.equal(electronCacheDir({ ...linux, env: { XDG_CACHE_HOME: '/xdg', electron_config_cache: '/mine' } }), '/mine');
    assert.equal(electronCacheDir({ platform: 'darwin', home: '/Users/u', env: {} }), '/Users/u/Library/Caches/electron');
    assert.equal(electronCacheDir({ platform: 'win32', home: 'C:\\Users\\u', env: {} }), 'C:\\Users\\u\\AppData\\Local\\electron\\Cache');
    assert.equal(electronCacheDir({ platform: 'win32', home: 'C:\\Users\\u', env: { LOCALAPPDATA: 'D:\\local' } }), 'D:\\local\\electron\\Cache');

    assert.equal(electronBuilderCacheDir({ ...linux, env: {} }), '/home/u/.cache/electron-builder');
    assert.equal(electronBuilderCacheDir({ ...linux, env: { XDG_CACHE_HOME: '/xdg' } }), '/xdg/electron-builder');
    assert.equal(electronBuilderCacheDir({ ...linux, env: { XDG_CACHE_HOME: 'relative' } }), '/home/u/.cache/electron-builder');
    assert.equal(electronBuilderCacheDir({ ...linux, env: { ELECTRON_BUILDER_CACHE: '/mine' } }), '/mine');
    assert.equal(electronBuilderCacheDir({ ...linux, env: { ELECTRON_BUILDER_CACHE: 'relative' } }), '/home/u/.cache/electron-builder');
    assert.equal(electronBuilderCacheDir({ platform: 'darwin', home: '/Users/u', env: {} }), '/Users/u/Library/Caches/electron-builder');
    const windows = { platform: 'win32', home: 'C:\\Users\\u', tmp: 'C:\\Temp' };
    assert.equal(electronBuilderCacheDir({ ...windows, env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } }), 'C:\\Users\\u\\AppData\\Local\\electron-builder\\Cache');
    assert.equal(electronBuilderCacheDir({ ...windows, env: {} }), 'C:\\Temp\\electron-builder-cache');
    assert.equal(electronBuilderCacheDir({ ...windows, env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', USERNAME: 'SYSTEM' } }), 'C:\\Temp\\electron-builder-cache');
    assert.equal(electronBuilderCacheDir({ ...windows, env: { LOCALAPPDATA: 'C:\\Windows\\System32\\config\\systemprofile\\AppData\\Local' } }), 'C:\\Temp\\electron-builder-cache');

    assert.equal(electronGypDir(linux), '/home/u/.electron-gyp');
    assert.equal(electronGypDir(windows), 'C:\\Users\\u\\.electron-gyp');
  });

  it('writes electron\'s checksums as the SHASUMS256.txt electron-builder reads, and finds the locked versions', () => {
    assert.equal(shasumsText({ 'b.zip': '22', 'a.zip': '11' }), '11 *a.zip\n22 *b.zip\n');
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    for (const name of ['electron', 'electron-builder']) assert.match(lockedVersion(lock, name), /^\d+\.\d+\.\d+/, name);
    assert.equal(lockedVersion(lock, 'no-such-package-here'), null);
  });

  it('caches only gitignored outputs, so a build\'s own output never moves its key', () => {
    assert.deepEqual(Object.keys(BUILD_OUTPUTS).sort(), workspaces.map((ws) => ws.dir).sort());
    const ignored = (file) => spawnSync('git', ['check-ignore', '-q', file]).status === 0;
    for (const [dir, outputs] of Object.entries(BUILD_OUTPUTS)) {
      for (const output of outputs) {
        const file = `${dir}/${output}`;
        assert.ok(ignored(file) || ignored(`${file}/x`), `${file} is not gitignored`);
        assert.equal(execFileSync('git', ['ls-files', '--', file], { encoding: 'utf8' }), '', `${file} is tracked`);
      }
    }
  });
});

describe('ci-scope.mjs, as the setup action runs it', () => {
  const made = [];
  after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
  const cli = resolve('scripts/ci-scope.mjs');
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-setup-run-'));
    made.push(dir);
    return dir;
  };
  /** GITHUB_OUTPUT as the runner reads it, `name<<END` values over several lines among them. */
  const parseOutputs = (text) => {
    const outputs = {};
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const heredoc = /^([\w-]+)<<(.+)$/.exec(lines[i]);
      if (heredoc) {
        const end = lines.indexOf(heredoc[2], i + 1);
        assert.ok(end > i, `${heredoc[1]} is never closed`);
        outputs[heredoc[1]] = lines.slice(i + 1, end).join('\n');
        i = end;
      } else if (lines[i]) {
        const at = lines[i].indexOf('=');
        outputs[lines[i].slice(0, at)] = lines[i].slice(at + 1);
      }
    }
    return outputs;
  };
  // In CI this runs after the action has written its own markers into the job's
  // environment, so each run sets every variable it reads.
  const run = (command, env, cwd) => {
    const dir = scratch();
    const files = { GITHUB_OUTPUT: join(dir, 'output'), GITHUB_ENV: join(dir, 'env'), GITHUB_STEP_SUMMARY: join(dir, 'summary') };
    for (const file of Object.values(files)) writeFileSync(file, '');
    const clean = { BUILD: '', ELECTRON: '', ELECTRON_BUILDER: '', STEPS: '{}', ORDEWELL_SETUP_INSTALLED: '', ORDEWELL_SETUP_BUILT: '', electron_config_cache: join(dir, 'electron') };
    const { status, stdout, stderr } = spawnSync(process.execPath, [cli, command], { cwd, encoding: 'utf8', env: { ...process.env, ...files, ...clean, ...env } });
    return { status, stdout, stderr, cache: clean.electron_config_cache, outputs: parseOutputs(readFileSync(files.GITHUB_OUTPUT, 'utf8')), jobEnv: readFileSync(files.GITHUB_ENV, 'utf8') };
  };
  /** core, and ui and web on it; a web build that exits `webStatus`. */
  const fixture = (webStatus = 0) => {
    const root = scratch();
    const write = (file, text) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    };
    const build = (code) => `node -e "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/built','');process.exit(${code})"`;
    write('.gitignore', 'dist/\n');
    write('package.json', JSON.stringify({ private: true, workspaces: [CORE, UI, WEB] }));
    write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/electron': { version: '45.2.1' }, 'node_modules/electron-builder': { version: '26.18.0' } } }));
    write(`${CORE}/package.json`, JSON.stringify({ name: '@f/core', scripts: { build: build(0) } }));
    write(`${UI}/package.json`, JSON.stringify({ name: '@f/ui', dependencies: { '@f/core': '*' }, scripts: { build: build(0) } }));
    write(`${WEB}/package.json`, JSON.stringify({ name: '@f/web', dependencies: { '@f/core': '*' }, scripts: { build: build(webStatus) } }));
    write('node_modules/electron/package.json', JSON.stringify({ name: 'electron', version: '45.2.1' }));
    write('node_modules/electron/checksums.json', JSON.stringify({ 'electron-v45.2.1-linux-x64.zip': 'ab', 'SHASUMS256.txt': 'cd' }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    return root;
  };
  const built = (root, dir) => existsSync(join(root, dir, 'dist', 'built'));

  it('plans each build with its key and paths, and gives every workspace both outputs, empty when unasked', () => {
    const { status, stderr, outputs } = run('setup-plan', { BUILD: 'ui' }, fixture());
    assert.equal(status, 0, stderr);
    assert.equal(outputs.install, 'true');
    if (process.platform === 'win32') assert.equal(outputs['modules-key'], '');
    else assert.match(outputs['modules-key'], new RegExp(`^node-modules-${process.platform}-${process.arch}-`));
    assert.equal(outputs.build, 'core ui');
    assert.match(outputs['core-key'], new RegExp(`^build-${process.platform}-${process.arch}-core-`));
    assert.equal(outputs['ui-paths'], `${UI}/dist\n${UI}/THIRD-PARTY-NOTICES.md`);
    assert.equal(outputs['web-key'], '');
    assert.equal(outputs['web-paths'], '');
    for (const name of ['electron-key', 'electron-path', 'builder-key', 'builder-paths']) assert.equal(outputs[name], '', name);
  });

  it('plans from what an earlier call in the job left in its environment', () => {
    const { status, outputs } = run('setup-plan', { BUILD: 'all', ORDEWELL_SETUP_INSTALLED: 'true', ORDEWELL_SETUP_BUILT: 'core' }, fixture());
    assert.equal(status, 0);
    assert.equal(outputs.install, 'false');
    assert.equal(outputs['modules-key'], '');
    assert.equal(outputs.build, 'ui web');
    assert.equal(outputs['core-key'], '');
  });

  it('plans the Electron caches where this host keeps them, and refuses a workspace it does not know', () => {
    const { status, outputs, cache } = run('setup-plan', { ELECTRON: 'true', ELECTRON_BUILDER: 'true' }, fixture());
    assert.equal(status, 0);
    assert.equal(outputs['electron-key'], `electron-${process.platform}-${process.arch}-electron@45.2.1`);
    assert.equal(outputs['electron-path'], cache);
    assert.equal(outputs['builder-key'], `electron-builder-${process.platform}-${process.arch}-electron@45.2.1-electron-builder@26.18.0`);
    assert.equal(outputs['builder-paths'].split('\n').length, 2);
    const refused = run('setup-plan', { BUILD: 'nonsense' }, fixture());
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /no workspace is named nonsense/);
  });

  it('builds what no cache restored, in order, and tells a later call in the job', () => {
    const root = fixture();
    const STEPS = JSON.stringify({ 'restore-core': { outputs: { 'cache-hit': 'true' } }, 'restore-ui': { outputs: { 'cache-hit': '' } } });
    const first = run('setup-build', { BUILD: 'core ui', STEPS }, root);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(built(root, CORE), false);
    assert.equal(built(root, UI), true);
    assert.deepEqual([first.outputs.restored, first.outputs.built], ['core', 'ui']);
    assert.equal(first.jobEnv, 'ORDEWELL_SETUP_INSTALLED=true\nORDEWELL_SETUP_BUILT=core ui\n');
    const second = run('setup-build', { BUILD: 'web', ORDEWELL_SETUP_BUILT: 'core ui' }, root);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual([second.outputs.restored, second.outputs.built], ['', 'web']);
    assert.equal(second.jobEnv, 'ORDEWELL_SETUP_INSTALLED=true\nORDEWELL_SETUP_BUILT=core ui web\n');
  });

  it('fails on a build that fails, names it, and tells no later call it was built', () => {
    const root = fixture(3);
    const { status, stderr, outputs, jobEnv } = run('setup-build', { BUILD: 'core web' }, root);
    assert.equal(status, 1);
    assert.match(stderr, /::error::the web build failed/);
    assert.equal(built(root, CORE), true);
    assert.deepEqual(outputs, {});
    assert.equal(jobEnv, '');
  });

  it('seeds electron\'s checksums beside the zip, where electron-builder looks', () => {
    const { status, stderr, cache } = run('electron-checksums', {}, fixture());
    assert.equal(status, 0, stderr);
    assert.equal(readFileSync(join(cache, 'SHASUMS256.txt-45.2.1'), 'utf8'), 'cd *SHASUMS256.txt\nab *electron-v45.2.1-linux-x64.zip\n');
  });
});

describe('the setup action', () => {
  const action = readFileSync('.github/actions/setup/action.yml', 'utf8');
  const steps = action.slice(action.indexOf('\n  steps:\n')).split(/^ {4}- /m).slice(1);
  const named = (name) => steps.find((s) => s.startsWith(`name: ${name}\n`));
  const at = (name) => steps.indexOf(named(name));
  const field = (step, name) => step.match(new RegExp(`^\\s+${name}: (.+)$`, 'm'))?.[1];
  const names = readWorkspaces().map((ws) => ws.dir.split('/').at(-1));

  it('restores and saves each workspace\'s build under its own key and paths, around the one step that builds', () => {
    const build = steps.findIndex((s) => /^\s+id: build$/m.test(s));
    assert.match(steps[build], /STEPS: \$\{\{ toJSON\(steps\) \}\}/);
    assert.match(steps[build], /node scripts\/ci-scope\.mjs setup-build/);
    for (const name of names) {
      const restore = named(`Restore ${name}'s build`);
      const save = named(`Save ${name}'s build`);
      assert.ok(restore && save, name);
      assert.equal(field(restore, 'id'), `restore-${name}`);
      assert.equal(field(restore, 'uses'), 'actions/cache/restore@v6');
      assert.equal(field(save, 'uses'), 'actions/cache/save@v6');
      assert.equal(field(restore, 'if'), `steps.plan.outputs.${name}-key != ''`);
      assert.equal(field(save, 'if'), `steps.plan.outputs.${name}-key != '' && steps.restore-${name}.outputs.cache-hit != 'true'`);
      for (const step of [restore, save]) {
        assert.equal(field(step, 'path'), `\${{ steps.plan.outputs.${name}-paths }}`, name);
        assert.equal(field(step, 'key'), `\${{ steps.plan.outputs.${name}-key }}`, name);
      }
      assert.ok(at(`Restore ${name}'s build`) < build && build < at(`Save ${name}'s build`), name);
    }
  });

  it('saves node_modules under the paths it restored, once npm ci has filled it and before anything builds', () => {
    const paths = (step) => step.slice(step.indexOf('path: |'), step.indexOf('key:'));
    assert.equal(paths(named('Restore node_modules')), paths(named('Save node_modules')));
    assert.match(paths(named('Restore node_modules')), /node_modules\n\s+packages\/\*\/node_modules\n/);
    assert.ok(at('Restore node_modules') < at('Install dependencies'));
    assert.ok(at('Install dependencies') < at('Save node_modules'));
    assert.ok(at('Save node_modules') < at('Build what no cache restored'));
    assert.equal(field(named('Install dependencies'), 'if'), "steps.plan.outputs.install == 'true' && steps.modules.outputs.cache-hit != 'true'");
  });

  it('retries the Electron download, and nothing whose failure is a verdict', () => {
    const install = named('Install Electron\'s binary');
    assert.match(install, /for attempt in 1 2 3 4 5; do\n\s+node node_modules\/electron\/install\.js && break/);
    assert.match(install, /sleep \$\(\(attempt \* 15\)\)/);
    for (const step of steps.filter((s) => s !== install)) assert.doesNotMatch(step, /for attempt|sleep /);
  });

  it('runs each script step in bash, which a composite step must name', () => {
    for (const step of steps.filter((s) => /^\s+run: /m.test(s))) assert.equal(field(step, 'shell'), 'bash', step.split('\n')[0]);
  });

  it('reads only outputs the plan writes, so no cache is keyed by an empty string by mistake', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-setup-outputs-'));
    try {
      const GITHUB_OUTPUT = join(dir, 'output');
      writeFileSync(GITHUB_OUTPUT, '');
      const env = { ...process.env, GITHUB_OUTPUT, BUILD: 'all', ELECTRON: 'true', ELECTRON_BUILDER: 'true', ORDEWELL_SETUP_INSTALLED: '', ORDEWELL_SETUP_BUILT: '' };
      const { status, stderr } = spawnSync(process.execPath, ['scripts/ci-scope.mjs', 'setup-plan'], { encoding: 'utf8', env });
      assert.equal(status, 0, stderr);
      const written = new Set([...readFileSync(GITHUB_OUTPUT, 'utf8').matchAll(/^([\w-]+)(?:=|<<)/gm)].map((m) => m[1]));
      const read = new Set([...action.matchAll(/steps\.plan\.outputs\.([\w-]+)/g)].map((m) => m[1]));
      assert.deepEqual([...read].filter((name) => !written.has(name)), []);
      for (const name of names) assert.ok(written.has(`${name}-key`) && written.has(`${name}-paths`), name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('every CI job', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n')).split(/^ {2}(?=[\w-]+:$)/m).slice(1);
  const nodeJobs = [...Object.keys(STEPS_BY_JOB), 'real-engine', ...Object.keys(WINDOWS_JOBS)];

  it('has a timeout, so a hang ends in minutes rather than at GitHub\'s six hours', () => {
    assert.ok(jobs.length > nodeJobs.length);
    for (const job of jobs) assert.match(job, /^ {4}timeout-minutes: \d+$/m, job.split('\n')[0]);
  });

  it('names its image, so a move of a -latest label is a change here, in ci.yml and in the release', () => {
    const images = [...workflow.matchAll(/^\s+runs-on: (.+)$/gm)].map((m) => m[1]);
    assert.equal(images.length, jobs.length);
    for (const image of images) assert.match(image, /^(ubuntu-\d+\.\d+|windows-\d{4}(-vs\d{4})?)$/);
    // homebrew-verify's matrix tries the installer on the -latest labels on purpose.
    const release = readFileSync('.github/workflows/release.yml', 'utf8');
    for (const [, image] of release.matchAll(/^\s+runs-on: (.+)$/gm)) {
      if (image !== '${{ matrix.runner }}') assert.doesNotMatch(image, /latest/, image);
    }
  });

  it('sets Node up through the setup action, straight after checkout', () => {
    assert.doesNotMatch(workflow, /actions\/setup-node|run: npm ci/);
    for (const job of nodeJobs) {
      const block = jobs.find((j) => j.startsWith(`${job}:\n`));
      assert.ok(block, job);
      const jobSteps = block.split(/^ {6}- /m).slice(1);
      assert.match(jobSteps[0], /^uses: actions\/checkout@/, job);
      assert.match(jobSteps[1], /^\s+uses: \.\/\.github\/actions\/setup$/m, job);
    }
  });
});
