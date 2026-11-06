// What a change has to prove. CI and `npm run test:changed` both ask here, so a
// path is judged the same way in a pull request and on a laptop.
//
// Selection only ever narrows from everything: a path no owner here claims, a
// git failure and every event but a pull request all mean the full run. So a
// new root config or a new package costs time, never a missed check.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Prose nothing executes. AUTHORS.md and NOTICE ship in every package, so they are not here. */
const DOCS = /^(docs\/.+|(README|CHANGELOG|CONTEXT|CONTRIBUTING|AGENTS|CLAUDE|SECURITY|CODE_OF_CONDUCT)\.md)$/;

/**
 * vitest's `--changed` follows the imports of source files, so anything else
 * in a package (a tsup config, a fixture) leaves the suite to run whole.
 */
const SOURCE = /^(src|server)\/.+\.tsx?$/;

/**
 * Each is a check a scope turns on or off; ci.yml reads them as job outputs.
 * `suites` is the coverage job and `windows` the Windows suites, both on when
 * their scope names any workspace; `harness` is the windows-harness job.
 */
export const CHECKS = [
  'suites', 'typecheck', 'lint', 'package', 'bench', 'windows', 'harness',
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
  // The visual tour is one long walk (21.9 min in CI), so it has a job of its own.
  'desktop-tour': { tour: ['desktop-tour'] },
  typecheck: { typecheck: ['typecheck'] },
  // One leg per workspace the scope names, at the tier it names.
  coverage: { suites: ['coverage'] },
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
    checks: checksFor(() => true),
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
 * owes. A path matching none of these, everything under scripts/ and packaging/
 * included, means the full run: the installers, the release scripts and the
 * binary's build (scripts/sea/, packaging/sea/) are tested in the bench step
 * and read by more than one job, and the root manifests, the lockfile and the
 * workflows change what every job installs or runs.
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
  const also = CHECKS.filter((check) => checks[check] && !['suites', 'windows'].includes(check));
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
 * Only a pull request may narrow. A push to main, a release and whatever event
 * comes next run everything: they are the last chance to catch what a stale
 * pull request's selection could not see.
 */
export function scopeForEvent(event, root, workspaces) {
  if (event !== 'pull_request') return fullScope(`${event || 'an unnamed event'} runs everything`, workspaces);
  try {
    return selectScope(changedInPullRequest(root), workspaces);
  } catch (error) {
    return fullScope(`could not read what changed: ${String(error.message).split('\n')[0]}`, workspaces);
  }
}

/**
 * What `npm run test:changed` runs. Workspaces reach each other through dist,
 * which vitest cannot see through: a changed workspace others depend on is
 * rebuilt, and those others run whole. Web keeps core external (its tsup
 * config), so a core change alone does not need web rebuilt.
 */
export function localRuns(paths, workspaces, exists = existsSync) {
  const scope = selectScope(paths, workspaces);
  if (paths.length === 0 || scope.mode === 'docs') return { note: '', rebuild: [], runs: [] };
  const full = scope.mode === 'full';
  const own = new Map(workspaces.map(({ dir }) => [dir, paths.filter((p) => p.startsWith(`${dir}/`))]));
  const dependedOn = (dir) => workspaces.some((w) => w.deps.includes(dir));
  return {
    note: full ? `${scope.reason}: running every workspace's quick suite.` : '',
    rebuild: workspaces.map((w) => w.dir).filter((dir) => dependedOn(dir) && (full || own.get(dir).length > 0)),
    runs: scope.workspaces.map((dir) => {
      const mine = own.get(dir);
      // A deleted source is in nobody's import graph, so `--changed` would
      // leave out exactly the tests still importing it.
      const followable = !full && mine.length > 0 && mine.every((p) => {
        return SOURCE.test(p.slice(dir.length + 1)) && exists(p);
      });
      return { dir, script: followable ? 'test:changed' : 'test:quick' };
    }),
  };
}

/**
 * What a job owed and did not do, as `id: why`. `outcome` is read, not
 * `conclusion`: a step let through by `continue-on-error` concludes success.
 * A scope that cannot be read owes everything, as the steps' own conditions do.
 */
export function missedSteps(scope, steps, job = 'build-and-test') {
  const table = STEPS_BY_JOB[job];
  if (!table) return [`${job || 'an unnamed job'}: not a job ci.yml confirms (STEPS_BY_JOB in scripts/change-scope.mjs)`];
  const owed = Object.entries(table).filter(([check]) => check === 'always' || !scope || scope.checks[check]).flatMap(([, ids]) => ids);
  return owed.flatMap((id) => {
    const outcome = steps[id]?.outcome;
    if (outcome === 'success') return [];
    return [`${id}: ${outcome ?? 'did not run'}`];
  });
}

/**
 * The coverage matrix for a scope: a leg per workspace it names. A full leg
 * runs `test:coverage`, under that workspace's floors; a quick one runs
 * `test:quick`, which judges no floor, since a floor is only meaningful over
 * the whole suite.
 */
export function coverageLegs(scope) {
  return scope.workspaces.map((dir) => {
    const name = dir.split('/').at(-1);
    return scope.suites[dir] === 'full'
      ? { workspace: dir, name, script: 'test:coverage' }
      : { workspace: dir, name: `${name}-quick`, script: 'test:quick' };
  });
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
export function gateFailures(event, needs) {
  const failures = [];
  const result = (job) => needs[job]?.result ?? 'missing';
  const scope = parseScope(needs.scope?.outputs?.scope);

  if (result('scope') !== 'success') failures.push(`scope: ${result('scope')}`);
  if (!scope) failures.push('scope: gave no readable scope');
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
