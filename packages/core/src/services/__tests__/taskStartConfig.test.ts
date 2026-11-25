import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, expect, it } from 'vitest';
import { TaskStartConfig, type StartConfigRuns } from '../taskStartConfig';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), 'start-config-'));
  dirs.push(dir);
  return dir;
}

const noRun: StartConfigRuns = { taskRepos: () => [], workspaceOf: () => undefined };
const at = (cwd: string, epoch = 1) => ({ epoch, root: cwd, cwd, worktree: false });

it('takes what a checkout holds at its first launch as the baseline, and holds what differs at the next', async () => {
  const cwd = checkout();
  mkdirSync(join(cwd, '.claude'));
  writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{}');
  const guard = new TaskStartConfig();
  expect(await guard.check(noRun, 't1', at(cwd))).toEqual([]);
  expect(await guard.check(noRun, 't2', at(cwd))).toEqual([]);

  writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{"env":{}}');
  writeFileSync(join(cwd, '.mcp.json'), '{}');
  writeFileSync(join(cwd, 'notes.md'), 'not configuration');
  expect(await guard.check(noRun, 't3', at(cwd))).toEqual(['.claude/settings.local.json', '.mcp.json']);
  // The baseline does not move, so the hold stands until the configuration goes.
  expect(await guard.check(noRun, 't3', at(cwd))).toEqual(['.claude/settings.local.json', '.mcp.json']);
  rmSync(join(cwd, '.mcp.json'));
  writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{}');
  expect(await guard.check(noRun, 't3', at(cwd))).toEqual([]);
});

it('takes a new baseline for a new run, and drops them with the plan', async () => {
  const cwd = checkout();
  const guard = new TaskStartConfig();
  await guard.check(noRun, 't1', at(cwd));
  writeFileSync(join(cwd, '.mcp.json'), '{}');
  expect(await guard.check(noRun, 't2', at(cwd))).toEqual(['.mcp.json']);
  expect(await guard.check(noRun, 't2', at(cwd, 2))).toEqual([]);
  guard.clear();
  rmSync(join(cwd, '.mcp.json'));
  await guard.check(noRun, 't1', at(cwd, 2));
  writeFileSync(join(cwd, '.mcp.json'), '{}');
  expect(await guard.check(noRun, 't2', at(cwd, 2))).toEqual(['.mcp.json']);
  guard.clear();
  expect(await guard.check(noRun, 't2', at(cwd, 2))).toEqual([]);
});

it('has nothing to compare for a directory that is not there', async () => {
  const guard = new TaskStartConfig();
  expect(await guard.check(noRun, 't1', at('/nonexistent/ordewell-start-config'))).toEqual([]);
  expect(await guard.check(noRun, 't2', at('/nonexistent/ordewell-start-config'))).toEqual([]);
});

// Git for Windows lists the files under a junction, where git elsewhere lists
// one link. A worktree's link to the checkout's own root is the checkout's, and
// is compared there; one a task pointed anywhere else is the worktree's.
it.runIf(process.platform === 'win32')('holds what a task linked into its worktree from elsewhere, and not the checkout\'s own', async () => {
  const top = realpathSync.native(checkout());
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' });
  mkdirSync(join(top, 'sub'));
  writeFileSync(join(top, 'sub', 'README.md'), 'x\n');
  git(top, 'init', '-q', '-b', 'main');
  git(top, 'add', '-A');
  git(top, 'commit', '-qm', 'base');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: top, encoding: 'utf8' }).trim();
  const worktree = join(realpathSync.native(checkout()), 'wt');
  git(top, 'worktree', 'add', '-q', '--detach', worktree);
  const workspace = join(top, 'sub');
  mkdirSync(join(workspace, '.claude'));
  writeFileSync(join(workspace, '.claude', 'settings.local.json'), '{}');
  symlinkSync(join(workspace, '.claude'), join(worktree, 'sub', '.claude'), 'junction');
  const elsewhere = realpathSync.native(checkout());
  writeFileSync(join(elsewhere, 'config.toml'), 'model = "x"\n');
  // At the repository's top, which Codex and OpenCode read on their way up from the workspace.
  symlinkSync(elsewhere, join(worktree, '.codex'), 'junction');
  // The checkout's own, but at the top, where nothing compares it with the checkout's first state.
  mkdirSync(join(top, '.opencode', 'agents'), { recursive: true });
  writeFileSync(join(top, '.opencode', 'agents', 'build.md'), 'rewritten\n');
  symlinkSync(join(top, '.opencode'), join(worktree, '.opencode'), 'junction');
  const runs: StartConfigRuns = {
    taskRepos: () => [{ path: '.', root: workspace, baseRef: base, worktree, branch: 'b/t1', integrationBranch: 'integration', linked: [] }],
    workspaceOf: () => worktree,
  };

  const held = await new TaskStartConfig().check(runs, 't1', { epoch: 1, root: workspace, cwd: join(worktree, 'sub'), worktree: true });

  expect(held).toContain('.codex/config.toml');
  expect(held).toContain('.opencode/agents/build.md');
  expect(held.some((name) => name.includes('settings.local.json'))).toBe(false);
});

// A take-in (ADR-0013) brings a sibling's landed configuration into the
// worktree. The task did not write it, but the user never consented to it
// either: a worktree is compared with the run's base, never the task's fork
// point, so what a landing added holds the start as it would have unmerged.
it('holds runner configuration a task took in from a sibling\'s landing, compared with the run\'s base', async () => {
  const top = realpathSync.native(checkout());
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
  writeFileSync(join(top, 'README.md'), 'x\n');
  git(top, 'init', '-q', '-b', 'main');
  git(top, 'add', '-A');
  git(top, 'commit', '-qm', 'base');
  const base = git(top, 'rev-parse', 'HEAD');
  git(top, 'branch', 'integration');
  const sibling = join(realpathSync.native(checkout()), 'sibling');
  git(top, 'worktree', 'add', '-q', '-b', 'b/t2', sibling, base);
  writeFileSync(join(sibling, '.mcp.json'), '{"mcpServers":{}}\n');
  git(sibling, 'add', '-A');
  git(sibling, 'commit', '-qm', 'sibling');
  const landing = join(realpathSync.native(checkout()), 'integration');
  git(top, 'worktree', 'add', '-q', landing, 'integration');
  git(landing, 'merge', '-q', '--no-ff', '-m', 'Merge: sibling', 'b/t2');
  const worktree = join(realpathSync.native(checkout()), 'wt');
  git(top, 'worktree', 'add', '-q', '-b', 'b/t1', worktree, base);
  writeFileSync(join(worktree, 'parser.py'), 'parse\n');
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-qm', 'own');
  git(worktree, 'merge', '-q', '--no-edit', '-m', 'Merge: own (take in landed work)', 'integration');
  const runs: StartConfigRuns = {
    taskRepos: () => [{ path: '.', root: top, baseRef: base, worktree, branch: 'b/t1', integrationBranch: 'integration', linked: [] }],
    workspaceOf: () => worktree,
  };

  expect(await new TaskStartConfig().check(runs, 't1', { epoch: 1, root: top, cwd: worktree, worktree: true })).toEqual(['.mcp.json']);
});

it('compares the checkout at a task\'s end only with a look a launch took, and takes none itself (ADR-0028)', async () => {
  const cwd = checkout();
  const guard = new TaskStartConfig();
  // An end before any launch of the run: no baseline, so nothing to say, and none taken from what it finds.
  writeFileSync(join(cwd, '.mcp.json'), '{"before":true}');
  expect(guard.checkoutChanges(1, cwd)).toEqual([]);
  rmSync(join(cwd, '.mcp.json'));
  expect(await guard.check(noRun, 't1', at(cwd))).toEqual([]);
  writeFileSync(join(cwd, '.mcp.json'), '{}');
  expect(guard.checkoutChanges(1, cwd)).toEqual(['.mcp.json']);
  // What an end reads leaves the next launch's check as it was.
  expect(await guard.check(noRun, 't2', at(cwd))).toEqual(['.mcp.json']);
  expect(guard.checkoutChanges(2, cwd)).toEqual([]);
});

it('says each path once per run at a launch, and at an end only what no notice has said', () => {
  const guard = new TaskStartConfig();
  expect(guard.untold(1, 'launch', ['.mcp.json', '.claude/settings.json'])).toEqual(['.mcp.json', '.claude/settings.json']);
  expect(guard.untold(1, 'launch', ['.mcp.json', '.codex/config.toml'])).toEqual(['.codex/config.toml']);
  // A launch said them, so an end says none of them, and something new once.
  expect(guard.untold(1, 'end', ['.mcp.json', '.pi/settings.json'])).toEqual(['.pi/settings.json']);
  expect(guard.untold(1, 'end', ['.pi/settings.json'])).toEqual([]);
  // An end's notice does not stand for a launch's, which says what the run in Full lets through.
  expect(guard.untold(1, 'launch', ['.pi/settings.json'])).toEqual(['.pi/settings.json']);
  // A new run says them again; the plan going takes what was said with it.
  expect(guard.untold(2, 'launch', ['.mcp.json'])).toEqual(['.mcp.json']);
  guard.clear();
  expect(guard.untold(1, 'launch', ['.mcp.json'])).toEqual(['.mcp.json']);
});
