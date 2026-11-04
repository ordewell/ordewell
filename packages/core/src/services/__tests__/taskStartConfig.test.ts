import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, expect, it } from 'vitest';
import { TaskStartConfig } from '../taskStartConfig';
import type { IsolationRun } from '../../interfaces/IWorktreeIsolation';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), 'start-config-'));
  dirs.push(dir);
  return dir;
}

const at = (cwd: string, epoch = 1) => ({ epoch, root: cwd, cwd, worktree: false });

it('takes what a checkout holds at its first launch as the baseline, and holds what differs at the next', async () => {
  const cwd = checkout();
  mkdirSync(join(cwd, '.claude'));
  writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{}');
  const guard = new TaskStartConfig();
  expect(await guard.check(null, 't1', at(cwd))).toEqual([]);
  expect(await guard.check(null, 't2', at(cwd))).toEqual([]);

  writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{"env":{}}');
  writeFileSync(join(cwd, '.mcp.json'), '{}');
  writeFileSync(join(cwd, 'notes.md'), 'not configuration');
  expect(await guard.check(null, 't3', at(cwd))).toEqual(['.claude/settings.local.json', '.mcp.json']);
  // The baseline does not move, so the hold stands until the configuration goes.
  expect(await guard.check(null, 't3', at(cwd))).toEqual(['.claude/settings.local.json', '.mcp.json']);
  rmSync(join(cwd, '.mcp.json'));
  writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{}');
  expect(await guard.check(null, 't3', at(cwd))).toEqual([]);
});

it('takes a new baseline for a new run, and drops them with the plan', async () => {
  const cwd = checkout();
  const guard = new TaskStartConfig();
  await guard.check(null, 't1', at(cwd));
  writeFileSync(join(cwd, '.mcp.json'), '{}');
  expect(await guard.check(null, 't2', at(cwd))).toEqual(['.mcp.json']);
  expect(await guard.check(null, 't2', at(cwd, 2))).toEqual([]);
  guard.clear();
  rmSync(join(cwd, '.mcp.json'));
  await guard.check(null, 't1', at(cwd, 2));
  writeFileSync(join(cwd, '.mcp.json'), '{}');
  expect(await guard.check(null, 't2', at(cwd, 2))).toEqual(['.mcp.json']);
  guard.clear();
  expect(await guard.check(null, 't2', at(cwd, 2))).toEqual([]);
});

it('has nothing to compare for a directory that is not there', async () => {
  const guard = new TaskStartConfig();
  expect(await guard.check(null, 't1', at('/nonexistent/ordewell-start-config'))).toEqual([]);
  expect(await guard.check(null, 't2', at('/nonexistent/ordewell-start-config'))).toEqual([]);
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
  const run = {
    repos: [{ path: '.', root: workspace, baseRef: base }],
    tasks: { t1: { repos: { '.': { worktree } } } },
  } as unknown as IsolationRun;

  const held = await new TaskStartConfig().check(run, 't1', { epoch: 1, root: workspace, cwd: join(worktree, 'sub'), worktree: true });

  expect(held).toContain('.codex/config.toml');
  expect(held.some((name) => name.includes('settings.local.json'))).toBe(false);
});
