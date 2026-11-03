import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  ALWAYS_STEPS,
  GUARD_TESTS,
  STEPS_BY_CHECK,
  changedInPullRequest,
  fullScope,
  gateFailures,
  localRuns,
  missedSteps,
  readWorkspaces,
  scopeForEvent,
  selectScope,
  uncommittedPaths,
} from './change-scope.mjs';

const workspaces = readWorkspaces();
const CORE = 'packages/core';
const CLI = 'packages/cli';
const WEB = 'packages/web';
const UI = 'packages/ui';
const VSCODE = 'packages/vscode';
const selected = (...paths) => selectScope(paths, workspaces);
const offChecks = (scope) => Object.entries(scope.checks).filter(([, on]) => !on).map(([check]) => check).sort();

describe('the workspace graph', () => {
  it('comes from the manifests: web, cli and ui on core, cli on web, vscode on core and ui', () => {
    const edges = Object.fromEntries(workspaces.map((w) => [w.dir, [...w.deps].sort()]));
    assert.deepEqual(edges, { [CORE]: [], [UI]: [CORE], [VSCODE]: [CORE, UI], [CLI]: [CORE, WEB], [WEB]: [CORE] });
  });

  it('holds every package a source file reaches by a relative path', () => {
    // vitest mocks @ordewell/core with core's source and cli reaches into web
    // the same way, so a manifest could understate what a test imports.
    const reach = /(?:from |import\(|require\()['"](?:\.\.\/)+(core|cli|web|ui|vscode)\//g;
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
  it('takes core\'s dependents with core: vitest cannot follow them through dist', () => {
    const scope = selected('packages/core/src/services/createSession.ts');
    assert.equal(scope.mode, 'selected');
    assert.deepEqual([...scope.workspaces].sort(), [CLI, CORE, UI, VSCODE, WEB]);
    assert.deepEqual(offChecks(scope), []);
  });

  it('takes the cli with web, and leaves core, vscode and what only they prove', () => {
    const scope = selected('packages/web/server/routes/settings.ts');
    assert.deepEqual([...scope.workspaces].sort(), [CLI, WEB]);
    assert.deepEqual(offChecks(scope), ['engine', 'integration', 'planner', 'sandbox']);
  });

  it('keeps a cli change to the cli', () => {
    const scope = selected('packages/cli/src/tui/view.ts');
    assert.deepEqual(scope.workspaces, [CLI]);
    assert.deepEqual(offChecks(scope), ['engine', 'integration', 'planner', 'sandbox']);
  });

  it('takes vscode with ui, and runs the real VS Code for it: the webview is drawn from ui\'s dist', () => {
    const scope = selected('packages/ui/src/chat/App.tsx');
    assert.deepEqual(scope.workspaces, [UI, VSCODE]);
    assert.deepEqual(offChecks(scope), ['engine', 'planner', 'sandbox']);
  });

  it('runs the real VS Code for a vscode change, and no container', () => {
    const scope = selected('packages/vscode/src/extension.ts');
    assert.deepEqual(scope.workspaces, [VSCODE]);
    assert.deepEqual(offChecks(scope), ['engine', 'planner', 'sandbox']);
  });

  it('treats a package\'s own build or test config as that package', () => {
    assert.deepEqual([...selected('packages/web/vitest.config.ts').workspaces].sort(), [CLI, WEB]);
    assert.deepEqual([...selected('packages/core/vitest.config.ts').workspaces].sort(), [CLI, CORE, UI, VSCODE, WEB]);
  });

  it('unions what several changes need, docs among them', () => {
    const scope = selected('docs/containers.md', 'packages/vscode/src/extension.ts', 'packages/web/server/main.ts');
    assert.equal(scope.mode, 'selected');
    assert.deepEqual([...scope.workspaces].sort(), [CLI, VSCODE, WEB]);
  });
});

describe('a change to docs alone', () => {
  it('needs no workspace, and still owes the checks every change owes', () => {
    const scope = selected('docs/adr/README.md', 'CHANGELOG.md', 'AGENTS.md');
    assert.equal(scope.mode, 'docs');
    assert.deepEqual(scope.workspaces, []);
    assert.deepEqual(offChecks(scope).length, Object.keys(scope.checks).length);
    assert.ok(ALWAYS_STEPS.includes('verify-scripts'));
    assert.ok(ALWAYS_STEPS.includes('repo-guards'));
  });
});

describe('the full fallback', () => {
  for (const [path, why] of [
    ['package-lock.json', 'the lockfile'],
    ['package.json', 'the root manifest'],
    ['tsconfig.json', 'shared compiler config'],
    ['vitest.shared.ts', 'shared test config'],
    ['vitest.setup.ts', 'shared test setup'],
    ['.eslintrc.js', 'shared lint config'],
    ['.gitignore', 'read by worktreeLinksIgnored'],
    ['.nvmrc', 'the Node in use'],
    ['.github/workflows/ci.yml', 'this workflow'],
    ['.github/workflows/verify-release-tag.mjs', 'the release'],
    ['scripts/change-scope.mjs', 'selection itself'],
    ['scripts/verify-skills.mjs', 'a verify script'],
    ['bench/pipeline/fake-claude/fake-claude.mjs', 'read by core e2e tests'],
    ['bench/containers/verdict.mjs', 'the real engine verdict'],
    ['assets/logo.png', 'unknown'],
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
      assert.deepEqual([...scope.workspaces].sort(), [CLI, CORE, UI, VSCODE, WEB]);
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
    for (const dependent of [CLI, UI, VSCODE, WEB]) assert.equal(script(plan, dependent), 'test:quick');
  });

  it('rebuilds web for a web change, and runs the cli whole', () => {
    const plan = runs('packages/web/server/main.ts');
    assert.deepEqual(plan.rebuild, [WEB]);
    assert.equal(script(plan, WEB), 'test:changed');
    assert.equal(script(plan, CLI), 'test:quick');
    assert.equal(script(plan, CORE), undefined);
    assert.equal(script(plan, VSCODE), undefined);
  });

  it('rebuilds ui for a ui change, and runs vscode whole', () => {
    const plan = runs('packages/ui/src/chat/hostState.ts');
    assert.deepEqual(plan.rebuild, [UI]);
    assert.equal(script(plan, UI), 'test:changed');
    assert.equal(script(plan, VSCODE), 'test:quick');
    assert.equal(script(plan, CORE), undefined);
  });

  it('rebuilds nothing for a package nothing depends on', () => {
    assert.deepEqual(runs('packages/vscode/src/extension.ts').rebuild, []);
    assert.deepEqual(runs('packages/cli/src/main.ts').rebuild, []);
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
    for (const dir of [CORE, CLI, UI, VSCODE, WEB]) assert.equal(script(plan, dir), 'test:quick');
    assert.match(plan.note, /scripts\/verify-skills\.mjs/);
  });

  it('runs nothing with nothing changed, and nothing for docs', () => {
    assert.deepEqual(runs().runs, []);
    assert.deepEqual(runs('docs/a.md').runs, []);
  });
});

describe('the steps a run owes', () => {
  const ran = (scope, outcome = 'success') => Object.fromEntries(
    [...ALWAYS_STEPS, ...Object.entries(STEPS_BY_CHECK).filter(([check]) => scope.checks[check]).flatMap(([, ids]) => ids)]
      .map((id) => [id, { outcome, conclusion: outcome }]),
  );

  it('accepts a selected run that ran what it selected', () => {
    const scope = selected('packages/web/server/main.ts');
    assert.deepEqual(missedSteps(scope, ran(scope)), []);
  });

  it('names a required step that was skipped', () => {
    const scope = fullScope('a push', workspaces);
    const steps = { ...ran(scope), coverage: { outcome: 'skipped', conclusion: 'skipped' } };
    assert.deepEqual(missedSteps(scope, steps), ['coverage: skipped']);
  });

  it('names a required step the run never reported', () => {
    const scope = fullScope('a push', workspaces);
    const steps = ran(scope);
    delete steps['verify-artifacts'];
    assert.deepEqual(missedSteps(scope, steps), ['verify-artifacts: did not run']);
  });

  it('counts a failure let through by continue-on-error as a failure', () => {
    const scope = selected('docs/a.md');
    const steps = { ...ran(scope), 'repo-guards': { outcome: 'failure', conclusion: 'success' } };
    assert.deepEqual(missedSteps(scope, steps), ['repo-guards: failure']);
  });

  it('owes everything when the scope cannot be read', () => {
    const scope = fullScope('a push', workspaces);
    const missed = missedSteps(null, ran(selected('docs/a.md')));
    assert.deepEqual(missed.length, missedSteps(scope, {}).length - ALWAYS_STEPS.length);
  });
});

describe('the required status', () => {
  const scoped = (scope) => ({ result: 'success', outputs: { scope: JSON.stringify(scope) } });
  const confirmed = { result: 'success', outputs: { confirmed: 'true' } };
  const passed = { result: 'success', outputs: {} };
  const skipped = { result: 'skipped', outputs: {} };
  const full = fullScope('a push', workspaces);
  const webOnly = selected('packages/web/server/main.ts');
  const coreChange = selected('packages/core/src/index.ts');

  it('passes a push whose every job ran', () => {
    assert.deepEqual(gateFailures('push', { scope: scoped(full), 'build-and-test': confirmed, 'real-engine': passed }), []);
  });

  it('passes a pull request that left out only what its scope let it', () => {
    assert.deepEqual(gateFailures('pull_request', { scope: scoped(webOnly), 'build-and-test': confirmed, 'real-engine': skipped }), []);
  });

  for (const [title, event, needs] of [
    ['the scope job failed, though the rest ran', 'pull_request', { scope: { result: 'failure', outputs: {} }, 'build-and-test': confirmed, 'real-engine': passed }],
    ['the scope job gave nothing to read', 'pull_request', { scope: { result: 'success', outputs: {} }, 'build-and-test': confirmed, 'real-engine': passed }],
    ['the scope is not JSON', 'pull_request', { scope: { result: 'success', outputs: { scope: '{' } }, 'build-and-test': confirmed, 'real-engine': passed }],
    ['a push ran a narrowed scope, every job green', 'push', { scope: scoped(webOnly), 'build-and-test': confirmed, 'real-engine': passed }],
    ['the scope job failed after giving a scope', 'pull_request', { scope: { ...scoped(webOnly), result: 'failure' }, 'build-and-test': confirmed, 'real-engine': skipped }],
    ['a push skipped the engine on a full scope that turned it off', 'push', { scope: scoped({ ...full, checks: { ...full.checks, engine: false } }), 'build-and-test': confirmed, 'real-engine': skipped }],
    ['build-and-test failed', 'pull_request', { scope: scoped(webOnly), 'build-and-test': { result: 'failure', outputs: {} }, 'real-engine': skipped }],
    ['build-and-test was skipped', 'push', { scope: scoped(full), 'build-and-test': skipped, 'real-engine': passed }],
    ['build-and-test was cancelled', 'pull_request', { scope: scoped(webOnly), 'build-and-test': { result: 'cancelled', outputs: {} }, 'real-engine': skipped }],
    ['build-and-test never confirmed its steps', 'push', { scope: scoped(full), 'build-and-test': passed, 'real-engine': passed }],
    ['the engine was skipped on a push', 'push', { scope: scoped(full), 'build-and-test': confirmed, 'real-engine': skipped }],
    ['the engine was skipped for a core change', 'pull_request', { scope: scoped(coreChange), 'build-and-test': confirmed, 'real-engine': skipped }],
    ['the engine failed on a change that did not need it', 'pull_request', { scope: scoped(webOnly), 'build-and-test': confirmed, 'real-engine': { result: 'failure', outputs: {} } }],
    ['a job is missing altogether', 'push', { scope: scoped(full), 'build-and-test': confirmed }],
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
      ['packages/ui/src/__tests__/webviewImports.lint.test.ts', '.eslintrc.js is a full fallback'],
    ]);
    const climbing = /\b(?:resolve|join)\(__dirname,\s*((?:'[^']*'(?:,\s*)?)+)\)/g;
    const found = new Set();
    const walk = (dir, owner) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(path, owner); continue; }
        if (!/\.test\.tsx?$/.test(entry.name)) continue;
        for (const [, literals] of readFileSync(path, 'utf8').matchAll(climbing)) {
          const target = relative(resolve('.'), resolve(dirname(path), ...literals.split(/,\s*/).map((l) => l.slice(1, -1))));
          const staysHome = target === owner.dir || target.startsWith(`${owner.dir}/`);
          // bench/ is a full fallback by path, and a dependency's change already selects its dependents.
          const covered = target.startsWith('bench/') || owner.deps.some((dep) => target.startsWith(`${dep}/`));
          if (!staysHome && !covered) found.add(path);
        }
      }
    };
    for (const owner of workspaces) walk(owner.dir === WEB ? join(owner.dir, 'server') : join(owner.dir, 'src'), owner);
    assert.deepEqual([...found].sort(), [...accounted.keys()].sort());
    for (const test of GUARD_TESTS) assert.equal(accounted.get(join(CORE, test)), 'guard');
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
  const allSteps = [...ALWAYS_STEPS, ...Object.values(STEPS_BY_CHECK).flat()];

  it('gives a push every check, and no workspace list, so coverage is the root script', () => {
    const { status, outputs } = run('select', { EVENT: 'push' });
    assert.equal(status, 0);
    assert.equal(outputs.coverage_args, '');
    for (const check of ['packages', 'sandbox', 'planner', 'integration', 'engine']) assert.equal(outputs[check], 'true', check);
    assert.equal(JSON.parse(outputs.scope).mode, 'full');
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
    assert.equal(outputs.coverage_args, '-w packages/a -w packages/b');
    assert.equal(outputs.packages, 'true');
    assert.equal(outputs.engine, 'false');
    assert.equal(outputs.integration, 'false');
  });

  it('confirms a run that did what it owed', () => {
    const scope = JSON.stringify(selected('docs/a.md'));
    const { status, outputs } = run('confirm', { SCOPE: scope, STEPS: passed(ALWAYS_STEPS) });
    assert.equal(status, 0);
    assert.equal(outputs.confirmed, 'true');
  });

  it('refuses to confirm, and writes no proof, when an owed step is missing', () => {
    const scope = JSON.stringify(selected('packages/core/src/index.ts'));
    const { status, stderr, outputs } = run('confirm', { SCOPE: scope, STEPS: passed(ALWAYS_STEPS) });
    assert.equal(status, 1);
    assert.match(stderr, /coverage: did not run/);
    assert.equal(outputs.confirmed, undefined);
  });

  it('owes everything when the scope output is empty, as after a failed scope job', () => {
    assert.equal(run('confirm', { SCOPE: '', STEPS: passed(ALWAYS_STEPS) }).status, 1);
    assert.equal(run('confirm', { SCOPE: '', STEPS: passed(allSteps) }).status, 0);
  });

  it('fails the gate on unreadable input rather than passing it', () => {
    assert.notEqual(run('gate', { EVENT: 'push', NEEDS: '' }).status, 0);
    assert.notEqual(run('confirm', { SCOPE: '', STEPS: '' }).status, 0);
  });

  it('passes and fails the gate by exit status, which is all GitHub reads', () => {
    const scope = { result: 'success', outputs: { scope: JSON.stringify(fullScope('a push', workspaces)) } };
    const job = { result: 'success', outputs: { confirmed: 'true' } };
    const good = { scope, 'build-and-test': job, 'real-engine': { result: 'success', outputs: {} } };
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
  const stepOf = (id) => steps('build-and-test').find((s) => new RegExp(`^\\s*id: ${id}$`, 'm').test(s));

  it('has every step the tables name, in build-and-test', () => {
    for (const id of [...ALWAYS_STEPS, ...Object.values(STEPS_BY_CHECK).flat()]) assert.ok(stepOf(id), `no step ${id}`);
  });

  it('skips an always step for no reason of its own', () => {
    for (const id of ALWAYS_STEPS) assert.doesNotMatch(stepOf(id), /^\s*if:/m, id);
  });

  it('runs a selected step unless its check says no, so a lost output runs it', () => {
    for (const [check, ids] of Object.entries(STEPS_BY_CHECK)) {
      for (const id of ids) {
        assert.ok(stepOf(id).includes(`if: needs.scope.outputs.${check} != 'false'`), `step ${id} is not gated on ${check} as a default-run`);
      }
    }
  });

  it('lets no required step fail quietly', () => {
    assert.doesNotMatch(workflow, /continue-on-error/);
  });

  it('keeps build-and-test and the engine alive when the scope job fails', () => {
    assert.match(jobBlock('build-and-test'), /needs: scope\n\s+if: \$\{\{ !cancelled\(\) \}\}/);
    assert.match(jobBlock('real-engine'), /needs: scope\n\s+if: \$\{\{ !cancelled\(\) && needs\.scope\.outputs\.engine != 'false' \}\}/);
  });

  it('confirms its steps last, and hands the proof to the required status', () => {
    const last = steps('build-and-test').at(-1);
    assert.match(last, /id: confirm/);
    assert.match(last, /node scripts\/ci-scope\.mjs confirm/);
    assert.match(last, /toJSON\(steps\)/);
    assert.match(jobBlock('build-and-test'), /confirmed: \$\{\{ steps\.confirm\.outputs\.confirmed \}\}/);
  });

  it('has a required status that always reports, over every job', () => {
    const gate = jobBlock('required-checks');
    assert.match(gate, /if: always\(\)/);
    assert.match(gate, /needs: \[scope, build-and-test, real-engine\]/);
    assert.match(gate, /toJSON\(needs\)/);
    assert.match(gate, /node scripts\/ci-scope\.mjs gate/);
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
