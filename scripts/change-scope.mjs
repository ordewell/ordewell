// What a change has to prove. CI and `npm run test:changed` both ask here, so a
// path is judged the same way in a pull request and on a laptop.
//
// Selection only ever narrows from everything: a path no owner here claims, a
// git failure and every event but a pull request all mean the full run. So a
// new root config or a new package costs time, never a missed check.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path, { join } from 'node:path';

/** Prose nothing executes. AUTHORS.md and NOTICE ship in every package, so they are not here. */
const DOCS = /^(docs\/.+|(README|CHANGELOG|CONTEXT|CONTRIBUTING|AGENTS|CLAUDE|SECURITY|CODE_OF_CONDUCT)\.md)$/;

/**
 * Each is a check a scope turns on or off; ci.yml reads them as job outputs.
 * `suites` is the coverage job and `windows` the Windows suites, both on when
 * their scope names any workspace; `merge` is the coverage-merge job, on when
 * a suite it owes in full runs as shards (COVERAGE_SHARDS); `harness` is the
 * windows-harness job.
 */
export const CHECKS = [
  'suites', 'merge', 'typecheck', 'lint', 'package', 'bench', 'windows', 'harness',
  'sandbox', 'planner', 'integration', 'desktop', 'tour', 'engine', 'binary',
];

/**
 * The jobs of ci.yml that confirm their own steps, each with the step ids it
 * owes: `always` on every change, the rest when their check is on. A job owes
 * nothing, and a pull request may skip it, when every check it names is off.
 * `engine` is the real-engine job, which the required status accounts for by
 * its own result, as it does the Windows jobs.
 *
 * Steps that only serve these (each job's own builds, the VS Code download, the
 * coverage upload) are left out: their loss fails the step they serve, or
 * costs nothing a verdict rests on. A step id is owed in one job only.
 */
export const STEPS_BY_JOB = {
  'build-and-test': {
    always: ['build-core', 'verify-scripts', 'repo-guards'],
    bench: ['bench'],
    sandbox: ['sandbox'],
    planner: ['planner-loop'],
    integration: ['vscode-integration'],
    desktop: ['desktop-e2e'],
    binary: ['build-binary', 'drive-binary'],
  },
  // The visual tour is one long walk, so it has a job of its own, a matrix of
  // legs that each walk every state and shoot a share of it; each leg confirms this.
  'desktop-tour': { tour: ['desktop-tour'] },
  typecheck: { typecheck: ['typecheck'] },
  // One leg per workspace the scope names, at the tier it names.
  coverage: { suites: ['coverage'] },
  // A sharded suite's coverage, merged and judged against its floors.
  'coverage-merge': { merge: ['merge-coverage'] },
  lint: { lint: ['lint'] },
  package: { package: ['package-vscode', 'package-desktop', 'verify-artifacts', 'upload-vsix'] },
};

/** Step ids that every change owes, all in build-and-test. */
export const ALWAYS_STEPS = STEPS_BY_JOB['build-and-test'].always;

/** The step ids each check stands for, whichever job runs them. */
export const STEPS_BY_CHECK = Object.fromEntries(CHECKS.flatMap((check) => {
  const ids = Object.values(STEPS_BY_JOB).flatMap((owed) => owed[check] ?? []);
  return ids.length ? [[check, ids]] : [];
}));

/**
 * The jobs that run on Windows (ADR-0010), each with the check that owes it.
 * They confirm no steps, so the required status judges them by their result.
 */
export const WINDOWS_JOBS = { windows: 'windows', 'windows-harness': 'harness' };

/**
 * The workspaces whose suites the windows job runs: the daemon, CLI, core and
 * extension are what Windows support rests on. The shared UI and desktop
 * suites run on Linux only.
 */
export const WINDOWS_SUITES = ['packages/core', 'packages/cli', 'packages/web', 'packages/vscode'];

/**
 * Tests in core that read the whole repository, so what they prove is about
 * every change, docs included, and not about core. They run for every scope.
 */
export const GUARD_TESTS = [
  'src/services/__tests__/fakeSecretsGuard.test.ts',
  'src/services/__tests__/gitExec.test.ts',
];

/**
 * The workspaces in root package.json order, each with the workspaces it
 * depends on, the source files its package.json exports (`./dist/X.d.ts` is
 * built from `src/X.ts`), and whether its vitest config imports the root
 * vitest.shared.ts.
 */
export function readWorkspaces(root = '.') {
  const manifest = (dir) => JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  const dirs = manifest('.').workspaces;
  const dirOf = new Map(dirs.map((dir) => [manifest(dir).name, dir]));
  return dirs.map((dir) => {
    const { name, dependencies, devDependencies, peerDependencies, exports } = manifest(dir);
    const declared = Object.keys({ ...dependencies, ...devDependencies, ...peerDependencies });
    const entries = Object.values(exports ?? {}).flatMap((target) => {
      const built = /^\.\/dist\/(.+)\.d\.ts$/.exec(target?.types ?? '');
      return built ? [`${dir}/src/${built[1]}.ts`] : [];
    });
    const config = join(root, dir, 'vitest.config.ts');
    const sharedTestConfig = existsSync(config) && readFileSync(config, 'utf8').includes('vitest.shared');
    return { name, dir, deps: declared.filter((d) => dirOf.has(d)).map((d) => dirOf.get(d)), entries, sharedTestConfig };
  });
}

/** Whose tests a change to `dir` can break: `dir`, and everything built on it. */
function withDependents(dir, workspaces) {
  const found = new Set([dir]);
  for (let grew = true; grew;) {
    grew = false;
    for (const workspace of workspaces) {
      if (found.has(workspace.dir) || !workspace.deps.some((dep) => found.has(dep))) continue;
      found.add(workspace.dir);
      grew = true;
    }
  }
  return found;
}

const checksFor = (on) => Object.fromEntries(CHECKS.map((check) => [check, on(check)]));

const TIER = { quick: 1, full: 2 };

const allFull = (dirs) => Object.fromEntries(dirs.map((dir) => [dir, 'full']));

/**
 * The workspaces whose full coverage leg runs as shards, each with how many.
 * Core's suite is the one leg that set the coverage job's pace, so it is split
 * until a shard runs about as long as the other long jobs. A shard judges no
 * floor, since it runs only part of the suite; coverage-merge merges every
 * shard's coverage and judges the workspace's own floors over the whole.
 */
export const COVERAGE_SHARDS = { 'packages/core': 3 };

const onWindows = (suites) => Object.fromEntries(Object.entries(suites).filter(([dir]) => WINDOWS_SUITES.includes(dir)));

/**
 * The suites a scope runs, by workspace: `full` is the whole suite with
 * coverage on Linux (its floors are judged only there) and with the e2e files
 * on Windows; `quick` is `test:quick`, no coverage and no real-git e2e files.
 */
export function fullScope(reason, workspaces) {
  const dirs = workspaces.map((w) => w.dir);
  return {
    mode: 'full',
    reason,
    workspaces: dirs,
    suites: allFull(dirs),
    windowsSuites: allFull(WINDOWS_SUITES.filter((dir) => dirs.includes(dir))),
    checks: checksFor((check) => check !== 'merge' || dirs.some((dir) => COVERAGE_SHARDS[dir])),
  };
}

/**
 * Core's public surface: what its package.json exports, and the protocol types
 * the daemon and its clients speak (index.ts re-exports both files). A change
 * there can break a dependent's build or its use of core, not only core, so
 * the dependents run in full; any other core change leaves their quick suites
 * to catch what reaches them.
 */
const CORE_PROTOCOL = ['packages/core/src/daemonContract.ts', 'packages/core/src/services/SessionMessage.ts'];
const isCoreSurface = (path, workspace) => workspace.dir === 'packages/core'
  && (workspace.entries.includes(path) || CORE_PROTOCOL.includes(path));

/**
 * What a path inside a workspace owes. The workspace runs in full and what is
 * built on it quick, as above. Every package change owes the same typecheck,
 * lint, artifact and bench checks: they cover the packages together, and the
 * bench step runs scripts' tests, some of which read the packages.
 *
 * Only core is proved by the sandbox, the planner loop and the engine: they
 * drive core's dist and no other package. The standalone binary (ADR-0065)
 * bundles the CLI with web and core, and the CLI depends on both, so whatever
 * reaches the CLI owes its build and its drive. The desktop app's acceptance
 * e2e runs whatever reaches desktop, core included; its visual tour, a
 * twenty-minute walk of layouts, is owed only by a change to what draws them,
 * desktop's own code or ui's.
 */
function workspaceOwner(path, workspace, workspaces) {
  // A manifest can change what is installed, for every package and the lockfile.
  if (path === `${workspace.dir}/package.json`) return undefined;
  // A package's own README, changelog and authors ship in its artifacts and nowhere else.
  if (/^(README|CHANGELOG|AUTHORS)\.md$/.test(path.slice(workspace.dir.length + 1))) return { checks: ['package'] };
  const reached = withDependents(workspace.dir, workspaces);
  const surface = isCoreSurface(path, workspace);
  const suites = Object.fromEntries([...reached].map((dir) => [dir, dir === workspace.dir || surface ? 'full' : 'quick']));
  const core = reached.has('packages/core');
  return {
    suites,
    windows: onWindows(suites),
    checks: [
      'typecheck', 'lint', 'package', 'bench',
      ...(core ? ['sandbox', 'planner', 'engine'] : []),
      ...(reached.has('packages/vscode') ? ['integration'] : []),
      ...(reached.has('packages/desktop') ? ['desktop'] : []),
      ...(['packages/desktop', 'packages/ui'].includes(workspace.dir) ? ['tour'] : []),
      ...(reached.has('packages/cli') ? ['binary'] : []),
    ],
  };
}

const owes = (...checks) => () => ({ checks });

/**
 * Paths outside every workspace that only some checks read, each with what it
 * owes. Under scripts/ and packaging/ only files named here are judged: an
 * installer, a manifest template or a release script owes the bench step that
 * tests it, and none of them reaches the desktop tour. A path matching none of
 * these means the full run: a new file under scripts/ or packaging/, the
 * scripts that decide what CI runs (ci.mjs, change-scope.mjs, ci-scope.mjs,
 * test-changed.mjs, npm.mjs), generate-third-party-notices.mjs, which every
 * package build runs, and the root manifests, the lockfile, the workflows and
 * the setup action, which change what every job installs or runs.
 */
const ROOT_OWNERS = [
  // Root lint (`eslint . --ext .ts,.tsx`) reads it, and so does ui's
  // webviewImports.lint.test.ts, which lints with its overrides. No other
  // suite loads it, and Windows runs none of ui's.
  [/^\.eslintrc\.js$/, () => ({ suites: { 'packages/ui': 'quick' }, checks: ['lint'] })],
  // Every vitest config that imports vitest.shared.ts gets its limits and,
  // through it, vitest.setup.ts. The sandbox e2e and the container suites run
  // vitest too. Root lint reads both; no tsconfig includes them.
  [/^vitest\.(shared|setup)\.ts$/, (workspaces) => {
    const suites = allFull(workspaces.filter((w) => w.sharedTestConfig).map((w) => w.dir));
    return { suites, windows: onWindows(suites), checks: ['lint', 'sandbox', 'engine'] };
  }],
  // `* text=auto eol=lf` is what a Linux checkout has already, so only a
  // Windows checkout can change under it, and `eol=crlf` touches only the
  // .cmd and .bat shims that only Windows runs.
  [/^\.gitattributes$/, () => ({ windows: allFull(WINDOWS_SUITES), checks: ['harness'] })],

  // bench/ (offline harnesses): each path owes what reads it.
  [/^bench\/.*\.md$|^bench\/(live|scale)\/\.gitignore$/, owes()],
  // The fake Claude Code: core's and cli's tests spawn it, as do the VS Code
  // integration test, the desktop e2e and tour, the container suites and the
  // pipeline and scale harnesses.
  [/^bench\/pipeline\/fake-claude\//, () => {
    const suites = allFull(['packages/core', 'packages/cli']);
    return { suites, windows: onWindows(suites), checks: ['integration', 'desktop', 'tour', 'engine', 'bench'] };
  }],
  // The fake Copilot over ACP: core's ACP tests and the pipeline harness.
  [/^bench\/pipeline\/fake-acp\//, () => {
    const suites = allFull(['packages/core']);
    return { suites, windows: onWindows(suites), checks: ['bench'] };
  }],
  // Mounted into the containers by dockerLease.e2e.test.ts, which only the engine runs.
  [/^bench\/pipeline\/fake-(opencode|provider)\//, owes('engine')],
  [/^bench\/pipeline\/(drive-pipeline|pipeline\.test)\.mjs$/, owes('bench')],
  // The mock planner and its scripted goals: the planner loop, the desktop
  // e2e and tour, and the binary's drive all talk to it.
  [/^bench\/live\/(mock-provider|scenarios)\.mjs$/, owes('planner', 'desktop', 'tour', 'binary')],
  [/^bench\/live\/drive-(conversation|taskops)\.mjs$/, owes('planner')],
  [/^bench\/live\/drive-binary\.mjs$/, owes('binary')],
  // Run by hand against a dev build; no check runs them.
  [/^bench\/live\/(webview-[^/]+|host-driver|load-playwright|screenshot-header-tmp)\.mjs$/, owes()],
  // verdict.mjs judges the container suites' report; its test runs in bench.
  [/^bench\/containers\//, owes('engine', 'bench')],
  [/^bench\/lab\//, owes('bench')],
  // Its tests run in bench, and root lint reads its entry.ts.
  [/^bench\/scale\//, owes('bench', 'lint')],

  // scripts/ and packaging/: each named file owes what reads it. test:bench
  // runs scripts/**/*.test.mjs, so what only those tests read owes bench
  // (and, through it, windows-harness). release.yml and homebrew-publish.yml
  // read some of these too, but no pull request runs either.
  //
  // The one-line installers: their tests run them against fake releases.
  [/^scripts\/install\/(cli\.sh|desktop\.sh|desktop\.ps1|cli\.test\.mjs|desktop\.test\.mjs)$/, owes('bench')],
  // The pinned shellcheck those tests lint with, and the ORDEWELL_REQUIRE_TOOLS
  // helper that fails them without it: build-and-test fetches it for the bench
  // step alone, and npm run ci, which reads it too, judges nothing in CI.
  [/^scripts\/(shellcheck\.(json|mjs|test\.mjs)|host-tools(\.test)?\.mjs)$/, owes('bench')],
  // The package-manager manifests and the release's own scripts: the
  // templates are read by the renderer alone, and every one of these is run or
  // read by its tests and by no workspace, job step or build.
  [/^packaging\/homebrew\/[^/]+\.rb\.tmpl$|^packaging\/winget\/[^/]+\.yaml\.tmpl$/, owes('bench')],
  [/^scripts\/(render-package-manifests(\.test)?\.mjs|publish-tap\.(sh|test\.mjs)|homebrew-publish\.test\.mjs|verify-brew-install\.sh)$/, owes('bench')],
  [/^scripts\/(desktop-release-assets\.mjs|release-latest(\.test)?\.mjs|(cli|desktop)-release\.test\.mjs)$/, owes('bench')],
  // The standalone binary's build (ADR-0065): build-and-test builds and drives
  // it, and its tests read it. Only a macOS signature reads the entitlements,
  // which cli-build.yml makes; it builds every target on its own for a pull
  // request that touches scripts/sea/ or packaging/sea/.
  [/^scripts\/sea\/build\.mjs$/, owes('binary', 'bench')],
  [/^scripts\/sea\/build\.test\.mjs$|^packaging\/sea\/entitlements\.plist$/, owes('bench')],
  // What the package job's verify-artifacts step runs (package-check.mjs
  // imports the desktop check), and tests read. desktop-build.yml runs the
  // desktop check on its own for a pull request that touches it.
  [/^scripts\/(desktop-)?package-check\.mjs$/, owes('package', 'bench')],
  // Tests of desktop's packaging scripts, and the one that keeps their stdout clean.
  [/^scripts\/(desktop-package-check|desktop-package|test-stdout)\.test\.mjs$/, owes('bench')],
  // The Windows partition proof reads the real suite configs and manifests.
  // Assignment and its measured data owe Windows; their tooling also runs in bench.
  [/^scripts\/windows-(shards|sequencer)\.mjs$|^scripts\/windows-durations\.json$/, () => ({ windows: allFull(WINDOWS_SUITES), checks: ['bench'] })],
  [/^scripts\/(windows-shards\.test|refresh-windows-durations)\.mjs$/, owes('bench')],
  // The local proof's tests and portability guard run in bench. Selection
  // itself, ci-scope.mjs and the rest of
  // what decides what CI runs are not here: they mean the full run.
  [/^scripts\/(change-scope|test-changed)\.test\.mjs$|^scripts\/test-path-portability(\.test)?\.mjs$/, owes('bench')],
  // build-and-test's verify-scripts step runs each on every change, so only
  // windows-harness, which runs them too, is owed.
  [/^scripts\/verify-(adr|fresh-install|migration|notice|skills)\.mjs$/, owes('harness')],
  // The real bubblewrap e2e (the sandbox step) and the container suites
  // (test:containers, the real engine); nothing else runs either, though the
  // bench step tests the container script's pulls and the sandbox script's
  // setup-free run.
  [/^scripts\/linux-sandbox-e2e\.sh$/, owes('sandbox', 'bench')],
  [/^scripts\/linux-sandbox-e2e\.test\.mjs$/, owes('bench')],
  [/^scripts\/container-e2e\.mjs$/, owes('engine', 'bench')],
  [/^scripts\/container-e2e\.test\.mjs$/, owes('bench')],
  // The retry for a command's own downloads: desktop's package.mjs runs
  // electron-builder through it and the container script its docker build;
  // the bench step runs its test and both callers'.
  [/^scripts\/network-retry\.mjs$/, owes('package', 'engine', 'bench')],
  // The bench steps' annotations: only test:bench, through NODE_OPTIONS in
  // ci.yml, loads the reporter, and its test runs there too.
  [/^scripts\/(network-retry\.test|node-test-annotations(\.test)?)\.mjs$/, owes('bench')],
];

/** What a path owes, or nothing when only the full run can judge it. */
function ownerOf(path, workspaces) {
  if (DOCS.test(path)) return {};
  const workspace = workspaces.find((w) => path.startsWith(`${w.dir}/`));
  if (workspace) return workspaceOwner(path, workspace, workspaces);
  return ROOT_OWNERS.find(([pattern]) => pattern.test(path))?.[1](workspaces);
}

function merge(into, suites = {}, dirs) {
  for (const [dir, tier] of Object.entries(suites)) {
    if (dirs.includes(dir) && TIER[tier] > (TIER[into[dir]] ?? 0)) into[dir] = tier;
  }
}

/** Workspaces in root package.json order, each at its tier. */
const ordered = (suites, dirs) => Object.fromEntries(dirs.filter((dir) => suites[dir]).map((dir) => [dir, suites[dir]]));

function summarise(suites, checks) {
  const at = (tier) => Object.keys(suites).filter((dir) => suites[dir] === tier).map((dir) => dir.split('/').at(-1));
  const parts = [];
  if (at('full').length) parts.push(`full suites for ${at('full').join(', ')}`);
  if (at('quick').length) parts.push(`quick suites for ${at('quick').join(', ')}`);
  const also = CHECKS.filter((check) => checks[check] && !['suites', 'merge', 'windows'].includes(check));
  if (also.length) parts.push(`owes ${also.join(', ')}`);
  return parts.join('; ');
}

/**
 * Each path's owner, merged: a suite runs at the highest tier any path asks
 * of it, and a check is on when any path owes it. A pull request that owes
 * nothing still runs the checks every change owes (ALWAYS_STEPS).
 */
export function selectScope(paths, workspaces) {
  if (paths.length === 0) return fullScope('git reported no changed path', workspaces);
  const dirs = workspaces.map((w) => w.dir);
  const suites = {};
  const windows = {};
  const owed = new Set();
  for (const path of paths) {
    const owner = ownerOf(path, workspaces);
    if (!owner) return fullScope(`${path} is outside what selection can judge`, workspaces);
    merge(suites, owner.suites, dirs);
    merge(windows, owner.windows, dirs);
    for (const check of owner.checks ?? []) owed.add(check);
  }
  const linux = ordered(suites, dirs);
  const windowsSuites = ordered(windows, dirs);
  const on = {
    ...Object.fromEntries([...owed].map((check) => [check, true])),
    suites: Object.keys(linux).length > 0,
    merge: Object.entries(linux).some(([dir, tier]) => tier === 'full' && COVERAGE_SHARDS[dir]),
    windows: Object.keys(windowsSuites).length > 0,
    // windows-harness runs the bench step, the planner loop and the VS Code
    // integration test on Windows, so it is owed when any of them is.
    harness: owed.has('harness') || owed.has('bench') || owed.has('planner') || owed.has('integration'),
  };
  const checks = checksFor((check) => on[check] === true);
  const owesAny = CHECKS.some((check) => checks[check]);
  return {
    mode: owesAny ? 'selected' : 'docs',
    reason: owesAny ? summarise(linux, checks) : 'nothing changed that a check reads',
    workspaces: Object.keys(linux),
    suites: linux,
    windowsSuites,
    checks,
  };
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const fields = (output) => output.split('\0').filter(Boolean);

/**
 * What a pull request's merge commit brings to main, the commit a pull_request
 * run checks out. `--no-renames` reports both sides of a rename, so the package
 * a file left is judged too, and `-z` keeps a path with a space or an accent
 * whole and unquoted.
 */
export function changedInPullRequest(root = '.') {
  git(root, 'rev-parse', '--verify', '--quiet', 'HEAD^2');
  return fields(git(root, 'diff', '--name-only', '-z', '--no-renames', 'HEAD^1', 'HEAD'));
}

/** Staged, unstaged and untracked, each file by name. */
export function uncommittedPaths(root = '.') {
  return fields(git(root, 'status', '--porcelain=v1', '-z', '--no-renames', '-uall')).map((entry) => entry.slice(3));
}

/**
 * The run of ci.yml that proved `sha` on main, read from what `findMainRuns`
 * returns: gh's `run list --json` output for successful push runs on main at
 * that commit. gh's filters are not taken on trust; each field is checked
 * here, so a run of another commit, branch, event or outcome proves nothing.
 */
function mainProof(sha, findMainRuns) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return { why: `no full commit SHA to look up (${sha || 'none'})` };
  let runs;
  try {
    runs = JSON.parse(findMainRuns(sha));
  } catch (error) {
    return { why: `could not look up main's runs: ${String(error?.message ?? error).split('\n')[0]}` };
  }
  if (!Array.isArray(runs)) return { why: 'the lookup of main\'s runs gave no list' };
  const proof = runs.find((run) => run?.headSha === sha && run.headBranch === 'main' && run.event === 'push'
    && run.conclusion === 'success' && Number.isSafeInteger(run.databaseId)
    && typeof run.url === 'string' && run.url.startsWith('https://'));
  return proof ? { url: proof.url } : { why: `no successful push run of ci.yml on main is at ${sha}` };
}

/**
 * A release whose commit main's own push run already proved in full: nothing
 * left to prove, so every check is off, and `proof` names that run.
 */
function reusedScope(sha, url) {
  return {
    mode: 'reused',
    reason: `main's push run ${url} already proved ${sha}`,
    workspaces: [],
    suites: {},
    windowsSuites: {},
    checks: checksFor(() => false),
    proof: { url, sha },
  };
}

/**
 * Only a pull request may narrow. A push to main, a release and whatever event
 * comes next run everything: they are the last chance to catch what a stale
 * pull request's selection could not see.
 *
 * The one exception is a release (`reuseMainProof`, ci.yml's workflow_call
 * input) of a commit main's push run proved: that run was the full run, of
 * this commit and this ci.yml. Anything short of finding it, the lookup's own
 * failure included, falls through to the full run.
 */
export function scopeForEvent(event, root, workspaces, { reuseMainProof = false, sha, findMainRuns } = {}) {
  if (reuseMainProof === true) {
    const proof = mainProof(sha, findMainRuns);
    if (proof.url) return reusedScope(sha, proof.url);
    if (event !== 'pull_request') return fullScope(`${event || 'an unnamed event'} runs everything: ${proof.why}`, workspaces);
  }
  if (event !== 'pull_request') return fullScope(`${event || 'an unnamed event'} runs everything`, workspaces);
  try {
    return selectScope(changedInPullRequest(root), workspaces);
  } catch (error) {
    return fullScope(`could not read what changed: ${String(error.message).split('\n')[0]}`, workspaces);
  }
}

/**
 * Local proof uses CI's tiers, including full suites' coverage floors. CI's
 * setup builds every workspace before testing, even on a docs-only change;
 * keeping those builds avoids testing stale dist consumed across workspaces.
 */
export function localRuns(paths, workspaces) {
  if (paths.length === 0) return { note: 'No uncommitted changes.', paths, runs: [], steps: [] };
  const scope = selectScope(paths, workspaces);
  return {
    scope,
    paths,
    note: scope.reason,
    steps: owedSteps(scope),
    runs: Object.entries(scope.suites).map(([dir, tier]) => ({ dir, script: tier === 'full' ? 'test:coverage' : 'test:quick' })),
  };
}

/** The obligations the CI jobs confirm; an unreadable scope owes everything. */
export function owedSteps(scope) {
  return Object.entries(STEPS_BY_JOB).flatMap(([job, table]) => Object.entries(table)
    .filter(([check]) => check === 'always' || !scope || scope.checks[check])
    .flatMap(([, ids]) => ids.map((id) => ({ job, id }))));
}

/**
 * What a job owed and did not do, as `id: why`. `outcome` is read, not
 * `conclusion`: a step let through by `continue-on-error` concludes success.
 * A scope that cannot be read owes everything, as the steps' own conditions do.
 */
export function missedSteps(scope, steps, job = 'build-and-test') {
  if (!STEPS_BY_JOB[job]) return [`${job || 'an unnamed job'}: not a job ci.yml confirms (STEPS_BY_JOB in scripts/change-scope.mjs)`];
  const owed = owedSteps(scope).filter((step) => step.job === job).map((step) => step.id);
  return owed.flatMap((id) => {
    const outcome = steps[id]?.outcome;
    if (outcome === 'success') return [];
    return [`${id}: ${outcome ?? 'did not run'}`];
  });
}

/**
 * The coverage matrix for a scope: a leg per workspace it names. A full leg
 * runs `test:coverage`, under that workspace's floors, or, for a workspace in
 * COVERAGE_SHARDS, one `test:coverage:shard` leg per shard, whose floors
 * coverage-merge judges. A quick leg runs `test:quick`, which judges no floor,
 * since a floor is only meaningful over the whole suite.
 */
export function coverageLegs(scope) {
  return scope.workspaces.flatMap((dir) => {
    const name = dir.split('/').at(-1);
    if (scope.suites[dir] !== 'full') return [{ workspace: dir, name: `${name}-quick`, script: 'test:quick' }];
    const shards = COVERAGE_SHARDS[dir];
    if (!shards) return [{ workspace: dir, name, script: 'test:coverage' }];
    return Array.from({ length: shards }, (_, i) => ({
      workspace: dir, name: `${name}-${i + 1}-of-${shards}`, script: 'test:coverage:shard', shard: `${i + 1}/${shards}`,
    }));
  });
}

/** The coverage-merge matrix: one leg per workspace whose shards coverageLegs gave. */
export function coverageMerges(scope) {
  return scope.workspaces
    .filter((dir) => scope.suites[dir] === 'full' && COVERAGE_SHARDS[dir])
    .map((dir) => ({ workspace: dir, name: dir.split('/').at(-1), shards: COVERAGE_SHARDS[dir] }));
}

/**
 * Why a merge of these blob files would not stand for the whole suite. vitest
 * merges whatever blobs it finds, so a shard that left none would drop its
 * tests and its coverage without a word; and a blob of another count would
 * count files twice.
 */
export function blobProblems(files, shards) {
  if (!Number.isInteger(shards) || shards < 1) return [`${shards} is not a count of shards`];
  const expected = Array.from({ length: shards }, (_, i) => `blob-${i + 1}-${shards}.json`);
  return [
    ...expected.filter((file) => !files.includes(file)).map((file) => `${file}: missing, so shard ${file.split('-')[1]}/${shards} left no tests or coverage to merge`),
    ...files.filter((file) => !expected.includes(file)).map((file) => `${file}: not one of this run's ${shards} shards`),
  ];
}

/**
 * The coverage summary of each workspace in a coverage log, as markdown for a
 * job summary. npm heads each run with `> name@version script`; a shard's run
 * is left out, its coverage being part of a suite.
 */
export function coverageSummaries(log) {
  const chunks = log.split(/^> (\S+)@\S+ test:coverage(?::merge)?\s*$/m);
  const out = [];
  for (let i = 1; i < chunks.length; i += 2) {
    const body = chunks[i + 1] ?? '';
    const marker = body.indexOf('Coverage summary');
    if (marker < 0) continue;
    const rest = body.slice(body.lastIndexOf('\n', marker) + 1);
    const end = rest.search(/\n={20,}/);
    const summary = (end < 0 ? rest : rest.slice(0, end)).trimEnd();
    out.push(`### Coverage — \`${chunks[i]}\``, '', '```', summary, '```', '');
  }
  return out.join('\n');
}

/**
 * What each windows shard runs, in order: a full suite is `test`, the e2e
 * files included; a quick one `test:quick`. A scope that cannot be read owes
 * every suite in full, as the jobs' own conditions do.
 */
export function windowsRuns(scope) {
  const suites = scope ? scope.windowsSuites : allFull(WINDOWS_SUITES);
  return Object.entries(suites).map(([dir, tier]) => ({ dir, script: tier === 'full' ? 'test' : 'test:quick' }));
}

/** The scope a `scope` job's output holds, or null when it holds none. */
export function parseScope(text) {
  try {
    const scope = JSON.parse(text);
    return typeof scope?.mode === 'string' && typeof scope.checks === 'object' && scope.checks ? scope : null;
  } catch {
    return null;
  }
}

/**
 * Why the required status must fail. A skipped job reads as passing to GitHub,
 * so this status judges each job by what the change owed it. It fails rather
 * than excuses: a scope job that failed leaves the rest running everything, and
 * still fails here, because whatever broke it is itself unproven.
 */
export function gateFailures(event, needs, { reuseMainProof = false } = {}) {
  const failures = [];
  const result = (job) => needs[job]?.result ?? 'missing';
  const scope = parseScope(needs.scope?.outputs?.scope);

  if (result('scope') !== 'success') failures.push(`scope: ${result('scope')}`);
  if (!scope) failures.push('scope: gave no readable scope');

  // A release of a commit main's push run proved owes nothing more, but only
  // a caller that asked to reuse that proof may be given a scope that says so.
  if (scope?.mode === 'reused') {
    if (reuseMainProof !== true) failures.push(`${event} reused a proof it did not ask to reuse`);
    if (typeof scope.proof?.url !== 'string') failures.push('scope: reused a proof it does not name');
    if (CHECKS.some((check) => scope.checks[check] !== false)) failures.push('scope: reused a proof yet owes a check');
    for (const job of [...Object.keys(STEPS_BY_JOB), 'real-engine', ...Object.keys(WINDOWS_JOBS)]) {
      const outcome = result(job);
      if (outcome !== 'success' && outcome !== 'skipped') failures.push(`${job}: ${outcome}`);
    }
    return failures;
  }

  if (event !== 'pull_request' && scope?.mode !== 'full') failures.push(`${event} ran a narrowed scope`);

  // Only a pull request may leave a job out, and only when its scope owes it nothing.
  const owes = (job) => event !== 'pull_request' || !scope
    || Object.keys(STEPS_BY_JOB[job]).some((check) => check === 'always' || scope.checks[check]);
  for (const job of Object.keys(STEPS_BY_JOB)) {
    const outcome = result(job);
    if (!owes(job)) {
      if (outcome !== 'success' && outcome !== 'skipped') failures.push(`${job}: ${outcome}`);
    } else if (outcome !== 'success') failures.push(`${job}: ${outcome}`);
    else if (needs[job].outputs?.confirmed !== 'true') failures.push(`${job}: did not confirm its steps`);
  }

  const owed = (job, check) => {
    const outcome = result(job);
    const mayBeSkipped = event === 'pull_request' && scope?.checks[check] === false;
    if (outcome !== 'success' && !(outcome === 'skipped' && mayBeSkipped)) failures.push(`${job}: ${outcome}`);
  };
  owed('real-engine', 'engine');
  for (const [job, check] of Object.entries(WINDOWS_JOBS)) owed(job, check);
  return failures;
}

// The setup action (.github/actions/setup/action.yml): what a job installs and
// builds, and the cache keys that let it skip either. A key hashes everything
// the work reads, so a hit is what the work would have produced. Where in
// doubt a key takes more in: that costs a rebuild, never a stale build.

/**
 * What each workspace's build writes that a later step reads. A hit restores
 * these and nothing else, so an output a build gains and this leaves out goes
 * missing after one. Every path is gitignored, which keeps it out of the key.
 */
export const BUILD_OUTPUTS = {
  'packages/core': ['dist'],
  'packages/ui': ['dist', 'THIRD-PARTY-NOTICES.md'],
  // copy-skills.mjs fills skills/ from core's.
  'packages/vscode': ['dist', 'skills', 'THIRD-PARTY-NOTICES.md'],
  'packages/cli': ['dist', 'THIRD-PARTY-NOTICES.md'],
  'packages/web': ['dist'],
  'packages/desktop': ['dist', 'THIRD-PARTY-NOTICES.md'],
};

/**
 * Files outside the workspaces that a build reads or that decide how it runs:
 * the manifests and lockfile node_modules comes from, the shared tsconfig, the
 * notices generator, and what runs the build. A missing one hashes as missing.
 */
const BUILD_ROOT_FILES = [
  'package.json', 'package-lock.json', 'tsconfig.json', '.nvmrc', '.npmrc',
  'scripts/generate-third-party-notices.mjs', 'scripts/ci-scope.mjs', 'scripts/npm.mjs',
  '.github/actions/setup/action.yml',
];

/** The environment a build reads: desktop's tsup bakes ORDEWELL_DESKTOP_AUTO_UPDATE in. */
const BUILD_ENV = ['NODE_ENV', 'ORDEWELL_DESKTOP_AUTO_UPDATE'];

/** Raised by hand to drop every cached build, should a key ever prove to have missed an input. */
const BUILD_CACHE_EPOCH = 1;

/** npm runs these on `npm ci`, so the files they name shape node_modules too. */
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];

const shortName = (dir) => dir.split('/').at(-1);

/**
 * The workspaces `asked` names (short names, or `all`), each with every
 * workspace it depends on, ordered so a dependency builds before what depends
 * on it, and in root package.json order otherwise.
 */
export function buildOrder(asked, workspaces) {
  const words = asked.split(/\s+/).filter(Boolean);
  const byName = new Map(workspaces.map((ws) => [shortName(ws.dir), ws]));
  const byDir = new Map(workspaces.map((ws) => [ws.dir, ws]));
  const unknown = words.filter((word) => word !== 'all' && !byName.has(word));
  if (unknown.length) throw new Error(`setup: no workspace is named ${unknown.join(', ')}; ask for ${[...byName.keys()].join(', ')} or all`);
  const wanted = new Set();
  const want = (ws) => {
    if (wanted.has(ws.dir)) return;
    wanted.add(ws.dir);
    for (const dep of ws.deps) want(byDir.get(dep));
  };
  for (const ws of words.includes('all') ? workspaces : words.map((word) => byName.get(word))) want(ws);
  const order = [];
  const placed = new Set();
  while (order.length < wanted.size) {
    const next = workspaces.find((ws) => wanted.has(ws.dir) && !placed.has(ws.dir) && ws.deps.every((dep) => placed.has(dep)));
    if (!next) throw new Error('setup: the workspaces depend on each other in a cycle');
    order.push(next);
    placed.add(next.dir);
  }
  return order;
}

/** Every file git would commit under `dirs`: the tracked ones, and new ones .gitignore lets in. */
function filesUnder(root, dirs) {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...dirs], {
    cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  return listed.split('\0').filter(Boolean);
}

/**
 * `files` (repo-relative, `/`-separated) hashed by name and content, in sorted
 * order. A link hashes as its target, and a file listed but gone as missing,
 * so a deletion changes the hash too.
 */
function hashFiles(hash, root, files) {
  for (const file of [...new Set(files)].sort()) {
    const full = join(root, file);
    let body;
    try {
      const stat = lstatSync(full);
      body = stat.isSymbolicLink() ? Buffer.from(`link:${readlinkSync(full)}`) : stat.isFile() ? readFileSync(full) : Buffer.from('not a file');
    } catch {
      body = Buffer.from('missing');
    }
    hash.update(`${file}\0${body.length}\0`);
    hash.update(body);
  }
}

/**
 * Each workspace's build cache key: its own files, the keys of the workspaces
 * it depends on (which stand for their builds), the root files, the outputs it
 * caches, the environment its build reads, and the Node it runs on.
 */
export function buildKeys(order, { root = '.', workspaces, platform, arch, nodeVersion, env }) {
  const byDir = new Map(workspaces.map((ws) => [ws.dir, ws]));
  const keys = new Map();
  const keyOf = (ws) => {
    if (keys.has(ws.dir)) return keys.get(ws.dir);
    const outputs = BUILD_OUTPUTS[ws.dir];
    if (!outputs) throw new Error(`setup: ${ws.dir} has no BUILD_OUTPUTS entry in scripts/change-scope.mjs, so its build cannot be cached`);
    const hash = createHash('sha256');
    hash.update(JSON.stringify({
      epoch: BUILD_CACHE_EPOCH,
      nodeVersion,
      dir: ws.dir,
      outputs,
      env: BUILD_ENV.map((name) => [name, env[name] ?? null]),
      deps: ws.deps.map((dep) => keyOf(byDir.get(dep))),
    }));
    hashFiles(hash, root, [...filesUnder(root, [ws.dir]), ...BUILD_ROOT_FILES]);
    const key = `build-${platform}-${arch}-${shortName(ws.dir)}-${hash.digest('hex')}`;
    keys.set(ws.dir, key);
    return key;
  };
  for (const ws of order) keyOf(ws);
  return keys;
}

/**
 * The node_modules cache key: everything `npm ci` installs from (the lockfile
 * and the manifests it checks the lockfile against) and the files the install
 * scripts it runs name, on this Node and npm.
 */
export function modulesKey({ root = '.', workspaces, platform, arch, nodeVersion }) {
  const manifests = ['.', ...workspaces.map((ws) => ws.dir)];
  const scripts = manifests.flatMap((dir) => {
    const { scripts: run = {} } = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    return INSTALL_SCRIPTS.flatMap((name) => [...(run[name] ?? '').matchAll(/[\w./-]+\.(?:[cm]?js|sh)\b/g)])
      .map(([file]) => path.posix.join(dir, file));
  });
  const hash = createHash('sha256');
  hash.update(`${nodeVersion}\0`);
  hashFiles(hash, root, ['package-lock.json', '.npmrc', ...manifests.map((dir) => path.posix.join(dir, 'package.json')), ...scripts]);
  return `node-modules-${platform}-${arch}-${nodeVersion}-${hash.digest('hex')}`;
}

const pathsFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

/**
 * Where electron's install.js has @electron/get keep its downloads, which is
 * also where electron-builder looks for the same zip and seeded checksums
 * (app-builder-lib's defaultElectronGetCacheRoot).
 */
export function electronCacheDir({ platform, env, home }) {
  const p = pathsFor(platform);
  if (env.electron_config_cache) return env.electron_config_cache;
  if (platform === 'darwin') return p.join(home, 'Library', 'Caches', 'electron');
  if (platform === 'win32') return p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), 'electron', 'Cache');
  return p.join(env.XDG_CACHE_HOME || p.join(home, '.cache'), 'electron');
}

/** electron-builder's own cache, its toolsets (AppImage, fpm) among them, as app-builder-lib's getCacheDirectory finds it. */
export function electronBuilderCacheDir({ platform, env, home, tmp }) {
  const p = pathsFor(platform);
  const override = env.ELECTRON_BUILDER_CACHE?.trim();
  if (override && p.parse(override).root) return override;
  if (platform === 'darwin') return p.join(home, 'Library', 'Caches', 'electron-builder');
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA?.trim();
    const system = local?.toLowerCase().includes('\\windows\\system32\\') || env.USERNAME?.trim().toLowerCase() === 'system';
    return !local || system ? p.join(tmp, 'electron-builder-cache') : p.join(local, 'electron-builder', 'Cache');
  }
  const xdg = env.XDG_CACHE_HOME;
  return xdg && p.parse(xdg).root ? p.join(xdg, 'electron-builder') : p.join(home, '.cache', 'electron-builder');
}

/** Where @electron/rebuild keeps the Electron headers a native module compiles against. */
export const electronGypDir = ({ platform, home }) => pathsFor(platform).join(home, '.electron-gyp');

/** The version package-lock.json installs `name` at, or null. */
export const lockedVersion = (lock, name) => lock.packages?.[`node_modules/${name}`]?.version ?? null;

/**
 * electron's checksums.json written as a SHASUMS256.txt, `<sha256> *<file>` a
 * line. Seeded beside the zip, it lets electron-builder verify that zip offline
 * rather than download the sums again (app-builder-lib's resolveSeededChecksums).
 */
export function shasumsText(checksums) {
  return Object.keys(checksums).sort().map((file) => `${checksums[file]} *${file}\n`).join('');
}

/**
 * What one call of the setup action does: install unless this job already
 * did, build each workspace asked for that this job has not, and the caches
 * each of those reads, keyed. `built` is the short names already built here.
 */
export function setupPlan(request, host = {}) {
  const { build = '', installed = false, built = [], electron = false, electronBuilder = false } = request;
  const { root = '.', platform = process.platform, arch = process.arch, nodeVersion = process.version, env = process.env, home = homedir(), tmp = tmpdir() } = host;
  const workspaces = host.workspaces ?? readWorkspaces(root);
  const order = buildOrder(build, workspaces).filter((ws) => !built.includes(shortName(ws.dir)));
  const keys = buildKeys(order, { root, workspaces, platform, arch, nodeVersion, env });
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const electronAt = `electron@${lockedVersion(lock, 'electron')}`;
  const builderAt = `electron-builder@${lockedVersion(lock, 'electron-builder')}`;
  const where = { platform, env, home, tmp };
  return {
    install: !installed,
    // node_modules is some 40k files on Windows, which unpack there slower than
    // `npm ci` fills them from the npm cache setup-node restores.
    modulesKey: !installed && platform !== 'win32' ? modulesKey({ root, workspaces, platform, arch, nodeVersion }) : '',
    builds: order.map((ws) => ({
      name: shortName(ws.dir),
      dir: ws.dir,
      key: keys.get(ws.dir),
      paths: BUILD_OUTPUTS[ws.dir].map((output) => `${ws.dir}/${output}`),
    })),
    electron: electron ? { key: `electron-${platform}-${arch}-${electronAt}`, path: electronCacheDir(where) } : null,
    electronBuilder: electronBuilder
      ? { key: `electron-builder-${platform}-${arch}-${electronAt}-${builderAt}`, paths: [electronBuilderCacheDir(where), electronGypDir(where)] }
      : null,
  };
}
