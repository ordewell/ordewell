// What a change has to prove. CI and `npm run test:changed` both ask here, so a
// path is judged the same way in a pull request and on a laptop.
//
// Selection only ever narrows from everything: a path this file does not
// recognise, a git failure and every event but a pull request all mean the full
// run. So a new root config or a new package costs time, never a missed check.
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

/** Each is a check a scope turns on or off; ci.yml reads them as job outputs. */
export const CHECKS = ['packages', 'sandbox', 'planner', 'integration', 'engine'];

/** Step ids in ci.yml's build-and-test that every change owes. */
export const ALWAYS_STEPS = ['build-core', 'verify-scripts', 'repo-guards'];

/**
 * The step ids each check stands for. `engine` is the real-engine job, which
 * the required status accounts for by its own result. Steps that only serve
 * these (the VS Code download, the coverage upload) are left out: their loss
 * fails the step they serve, or costs nothing a verdict rests on.
 */
export const STEPS_BY_CHECK = {
  packages: ['bench', 'build-rest', 'typecheck', 'coverage', 'lint', 'package-vscode', 'verify-artifacts', 'upload-vsix'],
  sandbox: ['sandbox'],
  planner: ['planner-loop'],
  integration: ['vscode-integration'],
};

/**
 * The jobs that run the suites on Windows (ADR-0010). A package change owes
 * them as it owes build-and-test's package steps, so they are skipped exactly
 * when those are: on a pull request whose scope reaches no package.
 */
export const WINDOWS_JOBS = ['windows', 'windows-harness'];

/**
 * Tests in core that read the whole repository, so what they prove is about
 * every change, docs included, and not about core. They run for every scope.
 */
export const GUARD_TESTS = [
  'src/services/__tests__/fakeSecretsGuard.test.ts',
  'src/services/__tests__/gitExec.test.ts',
];

/** The workspaces in root package.json order, each with the workspaces it depends on. */
export function readWorkspaces(root = '.') {
  const manifest = (dir) => JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  const dirs = manifest('.').workspaces;
  const dirOf = new Map(dirs.map((dir) => [manifest(dir).name, dir]));
  return dirs.map((dir) => {
    const { name, dependencies, devDependencies, peerDependencies } = manifest(dir);
    const declared = Object.keys({ ...dependencies, ...devDependencies, ...peerDependencies });
    return { name, dir, deps: declared.filter((d) => dirOf.has(d)).map((d) => dirOf.get(d)) };
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

/** The workspace a path belongs to, or nothing when only the full run can judge it. */
function owningWorkspace(path, workspaces) {
  const workspace = workspaces.find((w) => path.startsWith(`${w.dir}/`));
  // A manifest can change what is installed, for every package and the lockfile.
  return workspace && path !== `${workspace.dir}/package.json` ? workspace : undefined;
}

const checksFor = (on) => Object.fromEntries(CHECKS.map((check) => [check, on(check)]));

export function fullScope(reason, workspaces) {
  return { mode: 'full', reason, workspaces: workspaces.map((w) => w.dir), checks: checksFor(() => true) };
}

/**
 * Only core is proved by the sandbox, the planner loop and the engine: they
 * drive core's dist and no other package. Every package gets the same builds,
 * typecheck, lint and artifact checks: those cover the packages together, and
 * what selection saves is the suites and the checks each package owns.
 */
export function selectScope(paths, workspaces) {
  if (paths.length === 0) return fullScope('git reported no changed path', workspaces);
  const affected = new Set();
  for (const path of paths) {
    if (DOCS.test(path)) continue;
    const workspace = owningWorkspace(path, workspaces);
    if (!workspace) return fullScope(`${path} is outside what selection can judge`, workspaces);
    for (const dir of withDependents(workspace.dir, workspaces)) affected.add(dir);
  }
  const core = affected.has('packages/core');
  const on = {
    packages: affected.size > 0,
    sandbox: core,
    planner: core,
    integration: affected.has('packages/vscode'),
    engine: core,
  };
  return {
    mode: affected.size > 0 ? 'selected' : 'docs',
    reason: affected.size > 0 ? `changes reach ${[...affected].join(', ')}` : 'only documentation changed',
    workspaces: workspaces.map((w) => w.dir).filter((dir) => affected.has(dir)),
    checks: checksFor((check) => on[check]),
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
 * What build-and-test owed and did not do, as `id: why`. `outcome` is read, not
 * `conclusion`: a step let through by `continue-on-error` concludes success.
 * A scope that cannot be read owes everything, as the steps' own conditions do.
 */
export function missedSteps(scope, steps) {
  const owed = [
    ...ALWAYS_STEPS,
    ...Object.entries(STEPS_BY_CHECK).filter(([check]) => !scope || scope.checks[check]).flatMap(([, ids]) => ids),
  ];
  return owed.flatMap((id) => {
    const outcome = steps[id]?.outcome;
    if (outcome === 'success') return [];
    return [`${id}: ${outcome ?? 'did not run'}`];
  });
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

  if (result('build-and-test') !== 'success') failures.push(`build-and-test: ${result('build-and-test')}`);
  else if (needs['build-and-test'].outputs?.confirmed !== 'true') failures.push('build-and-test: did not confirm its steps');

  const owed = (job, check) => {
    const outcome = result(job);
    const mayBeSkipped = event === 'pull_request' && scope?.checks[check] === false;
    if (outcome !== 'success' && !(outcome === 'skipped' && mayBeSkipped)) failures.push(`${job}: ${outcome}`);
  };
  owed('real-engine', 'engine');
  for (const job of WINDOWS_JOBS) owed(job, 'packages');
  return failures;
}
