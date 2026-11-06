// Part of GitWorktreeIsolation: split by describe so CI's shards (vitest splits by file) balance. Helpers: gitWorktreeIsolationKit.ts

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { type GitExecFn } from '../GitWorktreeIsolation';
import { fakeConfig, removeDir } from '../../testing';
import { realpath, hasGit, create, git, initRepo, task, worktreePaths, linksTo, lexists, branches, execFileAsync, refuseWorktreesIn, roots, setupCommand, group, GROUP } from './gitWorktreeIsolationKit';

afterEach(async () => {
  while (roots.length) await removeDir(roots.pop()!);
});

describe.skipIf(!hasGit)('WorktreeIsolation over a repo group', () => {
  describe('detection', () => {
    it('isolates the repositories directly inside a folder, sharing the one with no commits and the loose paths', async () => {
      const dir = group();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(dir)).toEqual({ active: true, repos: GROUP, shared: ['NOTES.md', 'design', 'scratch'] });

      const run = await iso.startRun(dir);
      expect(run.repos.map((r) => r.path)).toEqual(GROUP);
      expect(run.sharedRepos).toEqual(['scratch']);
      expect(run.shared).toEqual(['NOTES.md', 'design', 'scratch']);
      for (const repo of run.repos) {
        expect(repo.root).toBe(join(dir, repo.path));
        expect(repo.baseRef).toBe(git(repo.root, 'rev-parse', 'HEAD'));
        expect(repo.baseBranch).toBe('main');
        expect(repo.integrationBranch).toBe(`ordewell/${run.id}/integration`);
        expect(branches(repo.root)).toEqual([repo.integrationBranch]);
      }
    });

    it('uses workspaceRepos instead when it is set, including a repository two levels down', async () => {
      const dir = group();
      initRepo(join(dir, 'libs', 'core'), { 'lib.ts': 'export {};\n' });
      writeFileSync(join(dir, 'libs', 'README.md'), 'libs\n');
      const iso = create({ config: fakeConfig({ worktreeIsolation: true, workspaceRepos: ['libs/core/', './api'] }) });
      expect(await iso.isActive(dir)).toEqual({ active: true, repos: ['api', 'libs/core'], shared: ['NOTES.md', 'design', 'infra', 'libs/README.md', 'scratch', 'web'] });

      const run = await iso.startRun(dir);
      expect(run.repos.map((r) => r.path)).toEqual(['api', 'libs/core']);
      expect(run.shared).toEqual(['NOTES.md', 'design', 'infra', 'libs/README.md', 'scratch', 'web']);

      const { cwd } = await iso.prepare(task(1, 'Deep'), run);
      expect(readFileSync(join(cwd, 'libs', 'core', 'lib.ts'), 'utf8')).toBe('export {};\n');
      expect(git(join(cwd, 'libs', 'core'), 'branch', '--show-current')).toBe(run.tasks['task-1'].branch);
      expect(lstatSync(join(cwd, 'libs')).isSymbolicLink()).toBe(false);
      expect(linksTo(join(cwd, 'libs', 'README.md'), join(dir, 'libs', 'README.md'))).toBe(true);
    });

    it('shares a repository git refuses a worktree for, and isolates the others', async () => {
      const dir = group();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }), execFileImpl: refuseWorktreesIn(join(dir, 'web')) });
      const run = await iso.startRun(dir);

      expect(run.repos.map((r) => r.path)).toEqual(['api', 'infra']);
      expect(run.sharedRepos).toEqual(['scratch', 'web']);
      expect(run.shared).toContain('web');
      expect(branches(join(dir, 'web'))).toEqual([]);
      const { cwd } = await iso.prepare(task(1, 'Around web'), run);
      expect(lstatSync(join(cwd, 'web')).isSymbolicLink()).toBe(true);
    });

    it('refuses to start a run when git refuses a worktree for every repository', async () => {
      const dir = group();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }), execFileImpl: refuseWorktreesIn(join(dir, 'api'), join(dir, 'infra'), join(dir, 'web')) });
      await expect(iso.startRun(dir)).rejects.toThrow(/No repository could be isolated: api, infra, scratch, web/);
      for (const repo of GROUP) expect(branches(join(dir, repo))).toEqual([]);
    });

    it('reports no-commits, naming them, when no repository in the folder has a commit', async () => {
      const dir = realpath(mkdtempSync(join(tmpdir(), 'ordewell-group-')));
      roots.push(dir);
      for (const name of ['one', 'two']) {
        mkdirSync(join(dir, name));
        git(join(dir, name), 'init', '-q');
      }
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(dir)).toEqual({ active: false, reason: 'no-commits', repos: ['one', 'two'] });
    });

    it('still reports not-git for a folder with no repositories in it', async () => {
      const dir = realpath(mkdtempSync(join(tmpdir(), 'ordewell-group-')));
      roots.push(dir);
      mkdirSync(join(dir, 'docs'));
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(dir)).toEqual({ active: false, reason: 'not-git' });
    });
  });

  describe('dirty trees', () => {
    it('holds the run when any repository has tracked changes, naming only those', async () => {
      const dir = group();
      writeFileSync(join(dir, 'web', 'index.html'), '<p>edited</p>\n');
      writeFileSync(join(dir, 'api', 'README.md'), 'staged\n');
      git(join(dir, 'api'), 'add', 'README.md');
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(dir)).toEqual({ active: false, reason: 'dirty', repos: ['api', 'web'] });
    });

    it('stash cleans every dirty repository, and the group isolates', async () => {
      const dir = group();
      writeFileSync(join(dir, 'web', 'index.html'), '<p>edited</p>\n');
      writeFileSync(join(dir, 'infra', 'main.tf'), '# edited\n');
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });

      await iso.stash(dir);

      expect(await iso.isActive(dir)).toEqual({ active: true, repos: GROUP, shared: ['NOTES.md', 'design', 'scratch'] });
      expect(readFileSync(join(dir, 'web', 'index.html'), 'utf8')).toBe('<p>web</p>\n');
      expect(git(join(dir, 'web'), 'stash', 'list')).toContain('ordewell');
      expect(git(join(dir, 'infra'), 'stash', 'list')).toContain('ordewell');
      expect(git(join(dir, 'api'), 'stash', 'list')).toBe('');
    });
  });

  describe('task workspace', () => {
    it('lays the repositories out as in the real folder, each on the task branch, with the shared paths linked', async () => {
      const dir = group();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      const { cwd, branch, copied } = await iso.prepare(task(1, 'Span repos'), run);

      expect(cwd).toBe(join(dir, '.ordewell', 'worktrees', run.id, '1-span-repos'));
      expect(branch).toBe(`ordewell/${run.id}/1-span-repos`);
      expect(copied).toEqual([]);
      expect(run.tasks['task-1'].workspace).toBe(cwd);
      for (const repo of GROUP) {
        expect(run.tasks['task-1'].repos[repo].worktree).toBe(join(cwd, repo));
        expect(git(join(cwd, repo), 'branch', '--show-current')).toBe(branch);
        expect(worktreePaths(join(dir, repo))).toContain(join(cwd, repo));
      }
      expect(readFileSync(join(cwd, 'web', 'index.html'), 'utf8')).toBe('<p>web</p>\n');
      for (const shared of ['NOTES.md', 'design', 'scratch']) expect(linksTo(join(cwd, shared), join(dir, shared)), shared).toBe(true);
      expect(existsSync(join(cwd, '.ordewell'))).toBe(false);
      expect(linksTo(join(cwd, 'api', '.env'), join(dir, 'api', '.env'))).toBe(true);
      expect(run.tasks['task-1'].repos.api.linked).toEqual(['.env']);
    });

    it('makes an edit to a shared path live in the real folder', async () => {
      const dir = group();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      const { cwd } = await iso.prepare(task(1, 'Edit notes'), run);

      writeFileSync(join(cwd, 'NOTES.md'), 'edited by a task\n');
      writeFileSync(join(cwd, 'design', 'new.txt'), 'new\n');

      expect(readFileSync(join(dir, 'NOTES.md'), 'utf8')).toBe('edited by a task\n');
      expect(readFileSync(join(dir, 'design', 'new.txt'), 'utf8')).toBe('new\n');
    });

    it('prepares a task beside a loose link that leads nowhere, such as an editor lock file, without sharing it', async () => {
      const dir = group();
      symlinkSync('user@host.4242:1700000000', join(dir, '.#NOTES.md'));
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(dir)).toEqual({ active: true, repos: GROUP, shared: ['NOTES.md', 'design', 'scratch'] });
      const run = await iso.startRun(dir);

      const { cwd } = await iso.prepare(task(1, 'Beside a lock file'), run);

      expect(run.shared).toEqual(['NOTES.md', 'design', 'scratch']);
      expect(lexists(join(cwd, '.#NOTES.md'))).toBe(false);
      expect(linksTo(join(cwd, 'NOTES.md'), join(dir, 'NOTES.md'))).toBe(true);
    });

    it('lands each repository the task changed on that repository’s integration branch', async () => {
      const dir = group();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      const t = task(1, 'Api and web');
      const { cwd } = await iso.prepare(t, run);
      writeFileSync(join(cwd, 'api', 'route.ts'), 'route\n');
      writeFileSync(join(cwd, 'web', 'page.html'), 'page\n');

      expect(await iso.integrate(t, run)).toBe('merged');
      const integration = `ordewell/${run.id}/integration`;
      expect(git(join(dir, 'api'), 'show', `${integration}:route.ts`)).toBe('route');
      expect(git(join(dir, 'web'), 'show', `${integration}:page.html`)).toBe('page');
      expect(git(join(dir, 'api'), 'ls-tree', '-r', '--name-only', integration).split('\n')).not.toContain('.env');
      expect(run.tasks['task-1'].repos.infra.changed).toBe(false);
      expect(existsSync(cwd)).toBe(false);
      expect(readFileSync(join(dir, 'NOTES.md'), 'utf8')).toBe('notes\n');
    });

    it('a retry recreates the whole task workspace from the integration tips', async () => {
      const dir = group();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      const retried = task(2, 'Retried');
      const first = await iso.prepare(retried, run);
      writeFileSync(join(first.cwd, 'web', 'stale.txt'), 'old attempt\n');
      await iso.release(run, 'task-2', { keep: true });

      const pred = task(1, 'Predecessor');
      const p = await iso.prepare(pred, run);
      writeFileSync(join(p.cwd, 'infra', 'vpc.tf'), 'vpc\n');
      await iso.integrate(pred, run);

      const retry = await iso.prepare(retried, run);
      expect(retry.cwd).toBe(first.cwd);
      expect(existsSync(join(retry.cwd, 'web', 'stale.txt'))).toBe(false);
      expect(readFileSync(join(retry.cwd, 'infra', 'vpc.tf'), 'utf8')).toBe('vpc\n');
      expect(linksTo(join(retry.cwd, 'NOTES.md'), join(dir, 'NOTES.md'))).toBe(true);
      expect(readFileSync(join(dir, 'NOTES.md'), 'utf8')).toBe('notes\n');
    });
  });

  it('on Windows links shared directories as junctions and shared files as hard links', async () => {
    const dir = group();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }), platform: 'win32' });
    const run = await iso.startRun(dir);
    const { cwd, copied } = await iso.prepare(task(1, 'Windows'), run);

    expect(copied).toEqual([]);
    expect(lstatSync(join(cwd, 'design')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(cwd, 'NOTES.md')).isSymbolicLink()).toBe(false);
    writeFileSync(join(cwd, 'NOTES.md'), 'through a hard link\n');
    expect(readFileSync(join(dir, 'NOTES.md'), 'utf8')).toBe('through a hard link\n');
    await iso.release(run, 'task-1', { keep: false });
    expect(readFileSync(join(dir, 'NOTES.md'), 'utf8')).toBe('through a hard link\n');
    expect(readFileSync(join(dir, 'design', 'mock.txt'), 'utf8')).toBe('mock\n');
  });

  describe('bootstrap', () => {
    it('links worktreeLinks matches from the real repository and keeps them out of the commit', async () => {
      const dir = group();
      writeFileSync(join(dir, 'infra', 'terraform.tfstate'), '{"serial":7}\n');
      mkdirSync(join(dir, 'infra', '.terraform', 'providers'), { recursive: true });
      const iso = create({ config: fakeConfig({ worktreeIsolation: true, worktreeLinks: ['*.tfstate', '.terraform/', 'absent.lock'] }) });
      const run = await iso.startRun(dir);
      const t = task(1, 'Plan infra');
      const { cwd } = await iso.prepare(t, run);

      expect(linksTo(join(cwd, 'infra', 'terraform.tfstate'), join(dir, 'infra', 'terraform.tfstate'))).toBe(true);
      expect(lstatSync(join(cwd, 'infra', '.terraform')).isSymbolicLink()).toBe(true);
      expect(existsSync(join(cwd, 'infra', 'absent.lock'))).toBe(false);
      expect(existsSync(join(cwd, 'web', 'terraform.tfstate'))).toBe(false);

      writeFileSync(join(cwd, 'infra', 'vpc.tf'), 'vpc\n');
      expect(await iso.integrate(t, run)).toBe('merged');
      const tree = git(join(dir, 'infra'), 'ls-tree', '-r', '--name-only', `ordewell/${run.id}/integration`).split('\n');
      expect(tree).toContain('vpc.tf');
      expect(tree.some((f) => f === 'terraform.tfstate' || f.startsWith('.terraform'))).toBe(false);
      expect(readFileSync(join(dir, 'infra', 'terraform.tfstate'), 'utf8')).toBe('{"serial":7}\n');
    });

    it('links each repository’s default artifacts from that repository and keeps them out of its commit', async () => {
      const dir = group();
      mkdirSync(join(dir, 'web', 'node_modules', 'left-pad'), { recursive: true });
      writeFileSync(join(dir, 'infra', '.envrc'), 'export TF_VAR_x=1\n');
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      const t = task(1, 'Use the defaults');
      const { cwd } = await iso.prepare(t, run);

      expect(realpath(join(cwd, 'web', 'node_modules', 'left-pad'))).toBe(join(dir, 'web', 'node_modules', 'left-pad'));
      expect(linksTo(join(cwd, 'infra', '.envrc'), join(dir, 'infra', '.envrc'))).toBe(true);
      expect(existsSync(join(cwd, 'api', 'node_modules'))).toBe(false);
      expect(run.tasks['task-1'].repos.web.linked).toEqual(['node_modules']);
      expect(run.tasks['task-1'].repos.infra.linked).toEqual(['.envrc']);

      writeFileSync(join(cwd, 'web', 'page.html'), 'page\n');
      writeFileSync(join(cwd, 'infra', 'vpc.tf'), 'vpc\n');
      expect(await iso.integrate(t, run)).toBe('merged');
      const tree = (repo: string) => git(join(dir, repo), 'ls-tree', '-r', '--name-only', `ordewell/${run.id}/integration`).split('\n');
      expect(tree('web')).toContain('page.html');
      expect(tree('web').some((f) => f.startsWith('node_modules'))).toBe(false);
      expect(tree('infra')).toContain('vpc.tf');
      expect(tree('infra')).not.toContain('.envrc');
      expect(existsSync(join(dir, 'web', 'node_modules', 'left-pad'))).toBe(true);
    });

    it('runs the setup command once per isolated repository, in its worktree, naming the repository', async () => {
      const dir = group();
      const log = join(dir, 'setup.log');
      const iso = create({
        config: fakeConfig({
          worktreeIsolation: true,
          worktreeSetupCommand: setupCommand(`require('fs').appendFileSync(${JSON.stringify(log)}, [process.env.ORDEWELL_REPO, process.env.ORDEWELL_MAIN_REPO, process.cwd()].join('|') + '\\n');`),
        }),
      });
      const run = await iso.startRun(dir);
      const { cwd } = await iso.prepare(task(1, 'Setup'), run);

      const lines = readFileSync(log, 'utf8').trim().split('\n').sort();
      expect(lines).toEqual(GROUP.map((repo) => `${repo}|${join(dir, repo)}|${join(cwd, repo)}`));
      expect(existsSync(join(cwd, 'api', '.env'))).toBe(false);
    });

    it('a setup command that fails in some repositories gives just those the default links', async () => {
      const dir = group();
      const iso = create({
        config: fakeConfig({ worktreeIsolation: true, worktreeSetupCommand: setupCommand("process.exit(process.env.ORDEWELL_REPO === 'infra' ? 0 : 3);") }),
      });
      const run = await iso.startRun(dir);
      const { cwd, setupFailed } = await iso.prepare(task(1, 'Setup'), run);

      expect(setupFailed?.map((f) => f.repo)).toEqual(['api', 'web']);
      expect(existsSync(join(cwd, 'api', '.env'))).toBe(true);
      expect(run.tasks['task-1'].repos.infra.linked).toEqual([]);
    });
  });

  describe('pruneOrphans', () => {
    it('drops a crashed task workspace and its worktrees and branches in every repository', async () => {
      const dir = group();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      const crashed = await iso.prepare(task(1, 'Was running'), run);
      const kept = await iso.prepare(task(2, 'Failed verdict'), run);
      await iso.release(run, 'task-2', { keep: true });
      const strayDir = join(dir, '.ordewell', 'worktrees', run.id, '9-stray');
      git(join(dir, 'web'), 'worktree', 'add', '-q', '-b', `ordewell/${run.id}/9-stray`, join(strayDir, 'web'), run.repos[2].integrationBranch);

      const result = await iso.pruneOrphans(run);

      expect(existsSync(crashed.cwd)).toBe(false);
      expect(existsSync(strayDir)).toBe(false);
      for (const repo of GROUP) {
        expect(worktreePaths(join(dir, repo)).sort()).toEqual([join(dir, repo), join(kept.cwd, repo)].sort());
        expect(branches(join(dir, repo)).sort()).toEqual([`ordewell/${run.id}/integration`, kept.branch].sort());
      }
      expect(readFileSync(join(dir, 'NOTES.md'), 'utf8')).toBe('notes\n');
      expect(readFileSync(join(dir, 'design', 'mock.txt'), 'utf8')).toBe('mock\n');
      expect(Object.keys(run.tasks)).toEqual(['task-2']);
      expect(result.kept).toEqual([]);
    });

    it('keeps an active task workspace in every repository where it holds unlanded work', async () => {
      const dir = group();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      const working = await iso.prepare(task(1, 'Still running'), run);
      writeFileSync(join(working.cwd, 'web', 'in-flight.txt'), 'not committed yet\n');

      const result = await iso.pruneOrphans(run);

      expect(existsSync(join(working.cwd, 'web', 'in-flight.txt'))).toBe(true);
      expect(branches(join(dir, 'web'))).toContain(working.branch);
      expect(run.tasks['task-1'].status).toBe('kept');
      expect(result.kept).toEqual([{ taskId: 'task-1', order: 1, title: 'Still running' }]);
    });

    it('discard leaves no trace in any repository', async () => {
      const dir = group();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      await iso.prepare(task(1, 'Abandoned'), run);

      await iso.discard(run, { integration: 'delete' });

      for (const repo of GROUP) {
        expect(worktreePaths(join(dir, repo))).toEqual([join(dir, repo)]);
        expect(branches(join(dir, repo))).toEqual([]);
      }
      expect(existsSync(join(dir, '.ordewell', 'worktrees', run.id))).toBe(false);
      expect(readFileSync(join(dir, 'NOTES.md'), 'utf8')).toBe('notes\n');
    });
  });

  describe('merged branches', () => {
    /** A handed-off run whose one task changed every repository of the group. */
    async function landedEverywhere() {
      const dir = group();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      const t = task(1, 'Touch every repo');
      const { cwd } = await iso.prepare(t, run);
      for (const repo of GROUP) writeFileSync(join(cwd, repo, 'landed.txt'), `${repo}\n`);
      expect(await iso.integrate(t, run)).toBe('merged');
      await iso.handoff(run);
      return { dir, iso, run, integration: `ordewell/${run.id}/integration` };
    }

    it('decides per repository: only the one whose checked-out branch took the work loses its integration branch', async () => {
      const { dir, iso, run, integration } = await landedEverywhere();
      git(join(dir, 'api'), 'merge', '-q', '--no-edit', integration);

      await iso.discard(run, { integration: 'delete-merged' });

      expect(branches(join(dir, 'api'))).toEqual([]);
      expect(branches(join(dir, 'infra'))).toEqual([integration]);
      expect(branches(join(dir, 'web'))).toEqual([integration]);
      for (const repo of GROUP) expect(worktreePaths(join(dir, repo))).toEqual([join(dir, repo)]);
    });

    it('sweeps an earlier run out of only the repository that merged it by hand', async () => {
      const { dir, iso, integration } = await landedEverywhere();
      git(join(dir, 'web'), 'merge', '-q', '--no-edit', integration);
      const current = await iso.startRun(dir);

      await iso.sweep(current);

      expect(branches(join(dir, 'web'))).toEqual([current.repos[2].integrationBranch]);
      for (const repo of ['api', 'infra']) {
        expect(branches(join(dir, repo)).sort()).toEqual([integration, `ordewell/${current.id}/integration`].sort());
      }
    });

    it('sweeps every repository it can, then names the one where git failed', async () => {
      const dir = group();
      const failing = join(dir, 'api');
      const exec: GitExecFn = async (file, args, opts) => {
        if (args[0] === 'branch' && args[1] === '-d' && opts.cwd === failing) {
          throw Object.assign(new Error('fatal: cannot lock ref'), { stderr: 'fatal: cannot lock ref', code: 128 });
        }
        const { stdout, stderr } = await execFileAsync(file, args, { cwd: opts.cwd, env: opts.env });
        return { stdout: String(stdout), stderr: String(stderr) };
  };
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }), execFileImpl: exec });
      const earlier = await iso.startRun(dir);
      await iso.discard(earlier, { integration: 'keep' });
      const current = await iso.startRun(dir);

      await expect(iso.sweep(current)).rejects.toThrow(/in api$/);

      expect(branches(failing)).toContain(`ordewell/${earlier.id}/integration`);
      for (const repo of ['infra', 'web']) expect(branches(join(dir, repo))).toEqual([`ordewell/${current.id}/integration`]);
    });
  });
});
