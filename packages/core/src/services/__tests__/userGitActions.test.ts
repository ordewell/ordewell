import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LandingBranchHeld } from '../../daemonContract';
import type { IsolationRun } from '../../interfaces/IWorktreeIsolation';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { saveSession } from '../../utils/sessionStore';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import type { LandingRun } from '../landingInterlock';
import { createUserGit, type UserGitDeps } from '../userGitActions';
import { createWorkspaceReader } from '../workspaceReader';

/**
 * A person's git actions on their checkout (ADR-0062), against real
 * repositories and a bare remote on disk. Expected values come from git run
 * here, never from the service's own reads.
 */

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return env;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8' });
}

function write(root: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
}

function configure(root: string): void {
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  // The person's own global hooks are theirs, not this test's.
  git(root, 'config', 'core.hooksPath', '.git/hooks');
}

function repo(root: string, files: Record<string, string>): void {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  configure(root);
  write(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
}

const head = (cwd: string) => git(cwd, 'rev-parse', 'HEAD').trim();
const porcelain = (cwd: string) => git(cwd, 'status', '--porcelain=v1', '--untracked-files=all').split('\n').filter(Boolean).sort();
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe.skipIf(!hasGit)('user git actions (ADR-0062)', () => {
  let tmp: string;
  let workspace: string;
  let runs: LandingRun[];
  let recorded: Array<{ held: LandingBranchHeld; text: string }>;

  const reader = createWorkspaceReader({ config: { workspaceRepos: [] } });
  const deps = (): UserGitDeps => ({
    reader,
    landingRuns: () => runs,
    record: (_workspace, held, text) => recorded.push({ held, text }),
  });
  const userGit = () => createUserGit(deps());
  const at = () => ({ workspace });

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-usergit-')));
    workspace = path.join(tmp, 'ws');
    repo(workspace, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    runs = [];
    recorded = [];
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  describe('save (G10)', () => {
    it('writes a file read at its hash, and answers the repository row', async () => {
      const answer = await userGit().save(at(), { path: 'a.txt', text: 'A\n', baseHash: sha256('a\n') });
      expect(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8')).toBe('A\n');
      expect(answer.repo).toMatchObject({ repo: '.', branch: 'main', head: head(workspace) });
    });

    it('creates a file that must not exist yet', async () => {
      await userGit().save(at(), { path: 'new/c.txt', text: 'c\n', baseHash: null });
      expect(fs.readFileSync(path.join(workspace, 'new/c.txt'), 'utf8')).toBe('c\n');
    });

    it('refuses a file changed since it was read as stale', async () => {
      write(workspace, { 'a.txt': 'changed elsewhere\n' });
      await expect(userGit().save(at(), { path: 'a.txt', text: 'A\n', baseHash: sha256('a\n') })).rejects.toMatchObject({ code: 'stale' });
      await expect(userGit().save(at(), { path: 'a.txt', text: 'A\n', baseHash: null })).rejects.toMatchObject({ code: 'stale' });
      expect(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8')).toBe('changed elsewhere\n');
    });

    it.each([['../outside.txt'], ['.git/config'], ['.ordewell/sessions/x.json']])('refuses %j as a read would', async (file) => {
      await expect(userGit().save(at(), { path: file, text: 'x', baseHash: null })).rejects.toMatchObject({ code: 'path_refused' });
    });

    it('refuses a write through a link that leaves the checkout', async () => {
      fs.mkdirSync(path.join(tmp, 'elsewhere'));
      fs.symlinkSync(path.join(tmp, 'elsewhere'), path.join(workspace, 'link'));
      await expect(userGit().save(at(), { path: 'link/x.txt', text: 'x', baseHash: null })).rejects.toMatchObject({ code: 'path_refused' });
      expect(fs.existsSync(path.join(tmp, 'elsewhere/x.txt'))).toBe(false);
    });
  });

  describe('stage and unstage', () => {
    it('stages and unstages whole files', async () => {
      write(workspace, { 'a.txt': 'A\n', 'c.txt': 'c\n' });
      await userGit().stage(at(), { paths: ['a.txt', 'c.txt'] });
      expect(porcelain(workspace)).toEqual(['A  c.txt', 'M  a.txt']);
      await userGit().unstage(at(), { paths: ['a.txt', 'c.txt'] });
      expect(porcelain(workspace)).toEqual([' M a.txt', '?? c.txt']);
    });

    it('stages and unstages one hunk of a file', async () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
      write(workspace, { 'long.txt': `${lines.join('\n')}\n` });
      git(workspace, 'add', 'long.txt');
      git(workspace, 'commit', '-q', '-m', 'long');
      const edited = [...lines];
      edited[1] = 'FIRST';
      edited[18] = 'LAST';
      write(workspace, { 'long.txt': `${edited.join('\n')}\n` });
      const full = git(workspace, 'diff', '-U1', '--', 'long.txt');
      // The first hunk alone: the header and everything up to the second hunk's.
      const first = full.indexOf('\n@@ ');
      const firstHunk = full.slice(0, full.indexOf('\n@@ ', first + 1) + 1);
      await userGit().stage(at(), { hunks: firstHunk });
      expect(git(workspace, 'diff', '--cached', '-U0', '--', 'long.txt')).toContain('+FIRST');
      expect(git(workspace, 'diff', '--cached', '-U0', '--', 'long.txt')).not.toContain('+LAST');
      const staged = git(workspace, 'diff', '--cached', '-U1', '--', 'long.txt');
      await userGit().unstage(at(), { hunks: staged });
      expect(git(workspace, 'diff', '--cached')).toBe('');
      expect(git(workspace, 'diff', '-U0')).toContain('+LAST');
    });

    it('refuses a hunk naming a path a person may not touch', async () => {
      const patch = 'diff --git a/.git/config b/.git/config\n--- a/.git/config\n+++ b/.git/config\n@@ -1 +1 @@\n-x\n+y\n';
      await expect(userGit().stage(at(), { hunks: patch })).rejects.toMatchObject({ code: 'path_refused' });
    });
  });

  describe('commit and amend (G3, G4)', () => {
    it('commits what is staged with the message', async () => {
      write(workspace, { 'a.txt': 'A\n' });
      git(workspace, 'add', 'a.txt');
      const answer = await userGit().commit(at(), { message: 'Change a' });
      expect(git(workspace, 'log', '-1', '--format=%s').trim()).toBe('Change a');
      expect(answer.repo.head).toBe(head(workspace));
    });

    it('answers git_failed with git\'s own text when nothing is staged', async () => {
      await expect(userGit().commit(at(), { message: 'Nothing' })).rejects.toMatchObject({ code: 'git_failed', message: expect.stringMatching(/nothing (added )?to commit/) });
    });

    it('runs the person\'s own commit hooks', async () => {
      const hook = path.join(workspace, '.git/hooks/commit-msg');
      fs.writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', { mode: 0o755 });
      write(workspace, { 'a.txt': 'A\n' });
      git(workspace, 'add', 'a.txt');
      await expect(userGit().commit(at(), { message: 'Change a' })).rejects.toMatchObject({ code: 'git_failed', message: expect.stringContaining('hook says no') });
    });

    it('amends the unpushed commit it was shown', async () => {
      const shown = head(workspace);
      write(workspace, { 'a.txt': 'A\n' });
      git(workspace, 'add', 'a.txt');
      await userGit().commit(at(), { message: 'Amended', amend: true, confirm: { head: shown } });
      expect(git(workspace, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
      expect(git(workspace, 'log', '-1', '--format=%s').trim()).toBe('Amended');
    });

    it('refuses an amend of a commit other than the one shown as confirm_stale', async () => {
      const shown = head(workspace);
      write(workspace, { 'a.txt': 'A\n' });
      git(workspace, 'commit', '-q', '-am', 'moved on');
      await expect(userGit().commit(at(), { message: 'x', amend: true, confirm: { head: shown } }))
        .rejects.toMatchObject({ code: 'confirm_stale', detail: { difference: { field: 'head', shown, now: head(workspace) } } });
    });

    it('refuses an amend with no confirmation', async () => {
      await expect(userGit().commit(at(), { message: 'x', amend: true })).rejects.toMatchObject({ code: 'confirm_stale' });
    });

    it('refuses an amend of a pushed commit', async () => {
      const remote = path.join(tmp, 'remote.git');
      git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
      git(workspace, 'remote', 'add', 'origin', remote);
      git(workspace, 'push', '-q', '-u', 'origin', 'main');
      await expect(userGit().commit(at(), { message: 'x', amend: true, confirm: { head: head(workspace) } })).rejects.toMatchObject({ code: 'pushed' });
    });
  });

  describe('discard (G3)', () => {
    it('discards exactly the files confirmed: modified, staged, added and untracked', async () => {
      write(workspace, { 'a.txt': 'A\n', 'b.txt': 'B\n', 'added.txt': 'n\n', 'loose.txt': 'u\n' });
      git(workspace, 'add', 'b.txt', 'added.txt');
      const files = ['a.txt', 'added.txt', 'b.txt', 'loose.txt'];
      await userGit().discard(at(), { paths: files, confirm: { files: [...files].reverse() } });
      expect(porcelain(workspace)).toEqual([]);
      expect(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8')).toBe('a\n');
      expect(fs.existsSync(path.join(workspace, 'loose.txt'))).toBe(false);
      expect(fs.existsSync(path.join(workspace, 'added.txt'))).toBe(false);
    });

    it('refuses when the confirmation names other files', async () => {
      write(workspace, { 'a.txt': 'A\n', 'b.txt': 'B\n' });
      await expect(userGit().discard(at(), { paths: ['a.txt', 'b.txt'], confirm: { files: ['a.txt'] } }))
        .rejects.toMatchObject({ code: 'confirm_stale', detail: { difference: { field: 'files', shown: ['a.txt'], now: ['a.txt', 'b.txt'] } } });
      expect(porcelain(workspace)).toEqual([' M a.txt', ' M b.txt']);
    });

    it('refuses a file that no longer has a change to discard', async () => {
      write(workspace, { 'a.txt': 'A\n' });
      await expect(userGit().discard(at(), { paths: ['a.txt', 'b.txt'], confirm: { files: ['a.txt', 'b.txt'] } }))
        .rejects.toMatchObject({ code: 'confirm_stale', detail: { difference: { field: 'files', now: ['a.txt'] } } });
      expect(porcelain(workspace)).toEqual([' M a.txt']);
    });

    it('discards one hunk, refusing it as stale once the file has moved', async () => {
      write(workspace, { 'a.txt': 'A\n' });
      const hunk = git(workspace, 'diff', '--', 'a.txt');
      write(workspace, { 'a.txt': 'something else\n' });
      await expect(userGit().discard(at(), { hunks: hunk, confirm: { files: ['a.txt'] } })).rejects.toMatchObject({ code: 'stale' });
      await expect(userGit().discard(at(), { hunks: hunk, confirm: { files: ['b.txt'] } })).rejects.toMatchObject({ code: 'confirm_stale' });
      write(workspace, { 'a.txt': 'A\n' });
      await userGit().discard(at(), { hunks: hunk, confirm: { files: ['a.txt'] } });
      expect(porcelain(workspace)).toEqual([]);
    });
  });

  describe('branches (G1, G3)', () => {
    it('creates a branch, and switches to it when asked', async () => {
      await userGit().createBranch(at(), { name: 'feature' });
      expect(git(workspace, 'branch', '--show-current').trim()).toBe('main');
      const answer = await userGit().createBranch(at(), { name: 'other', from: 'main', switch: true });
      expect(git(workspace, 'branch', '--show-current').trim()).toBe('other');
      expect(answer.repo.branch).toBe('other');
    });

    it('switches branch', async () => {
      git(workspace, 'branch', 'feature');
      await userGit().switchBranch(at(), { branch: 'feature' });
      expect(git(workspace, 'branch', '--show-current').trim()).toBe('feature');
    });

    it('refuses a name under ordewell/ for a create, a switch and a delete', async () => {
      git(workspace, 'branch', 'ordewell/run1/integration');
      await expect(userGit().createBranch(at(), { name: 'ordewell/mine' })).rejects.toMatchObject({ code: 'ordewell_branch' });
      await expect(userGit().switchBranch(at(), { branch: 'ordewell/run1/integration' })).rejects.toMatchObject({ code: 'ordewell_branch' });
      await expect(userGit().deleteBranch(at(), { branch: 'ordewell/run1/integration', confirm: { branch: 'ordewell/run1/integration', unmerged: false } }))
        .rejects.toMatchObject({ code: 'ordewell_branch' });
      expect(git(workspace, 'branch', '--list', 'ordewell/*').trim()).toBe('ordewell/run1/integration');
    });

    it('refuses a commit on an ordewell/ branch checked out by hand', async () => {
      git(workspace, 'switch', '-q', '-c', 'ordewell/run1/integration');
      write(workspace, { 'a.txt': 'A\n' });
      git(workspace, 'add', 'a.txt');
      await expect(userGit().commit(at(), { message: 'x' })).rejects.toMatchObject({ code: 'ordewell_branch' });
    });

    it('deletes a merged branch confirmed as merged', async () => {
      git(workspace, 'branch', 'feature');
      await userGit().deleteBranch(at(), { branch: 'feature', confirm: { branch: 'feature', unmerged: false } });
      expect(git(workspace, 'branch', '--list', 'feature')).toBe('');
    });

    it('deletes unmerged work only when the confirmation says it is unmerged', async () => {
      git(workspace, 'switch', '-q', '-c', 'feature');
      write(workspace, { 'a.txt': 'feature\n' });
      git(workspace, 'commit', '-q', '-am', 'feature work');
      git(workspace, 'switch', '-q', 'main');
      await expect(userGit().deleteBranch(at(), { branch: 'feature', confirm: { branch: 'feature', unmerged: false } }))
        .rejects.toMatchObject({ code: 'confirm_stale', detail: { difference: { field: 'unmerged', shown: false, now: true } } });
      expect(git(workspace, 'branch', '--list', 'feature').trim()).toBe('feature');
      await userGit().deleteBranch(at(), { branch: 'feature', confirm: { branch: 'feature', unmerged: true } });
      expect(git(workspace, 'branch', '--list', 'feature')).toBe('');
    });

    it('refuses a confirmation naming another branch', async () => {
      git(workspace, 'branch', 'feature');
      await expect(userGit().deleteBranch(at(), { branch: 'feature', confirm: { branch: 'other', unmerged: false } })).rejects.toMatchObject({ code: 'confirm_stale' });
    });

    it('refuses an action on a task worktree under .ordewell/worktrees', async () => {
      const worktree = path.join(workspace, '.ordewell/worktrees/run1/t1');
      git(workspace, 'worktree', 'add', '-q', '-b', 'side', worktree);
      await expect(userGit().commit({ workspace: worktree }, { message: 'x' })).rejects.toMatchObject({ code: 'not_checkout' });
    });
  });

  describe('the interlock (G7)', () => {
    const live = (over: Partial<LandingRun> = {}): LandingRun => ({ workspace, sessionId: 's1', runId: 'r1', repo: '.', branch: 'main', live: true, unmerged: true, ...over });

    beforeEach(() => git(workspace, 'branch', 'feature'));

    it('refuses a switch away from a live run\'s landing branch, naming the run', async () => {
      runs = [live()];
      await expect(userGit().switchBranch(at(), { branch: 'feature' }))
        .rejects.toMatchObject({ code: 'landing_branch_held', detail: { held: { sessionId: 's1', runId: 'r1', repo: '.', branch: 'main' } } });
      expect(git(workspace, 'branch', '--show-current').trim()).toBe('main');
    });

    it('refuses a create that switches away from it, creating nothing', async () => {
      runs = [live()];
      await expect(userGit().createBranch(at(), { name: 'fresh', switch: true })).rejects.toMatchObject({ code: 'landing_branch_held' });
      expect(git(workspace, 'branch', '--list', 'fresh')).toBe('');
    });

    it('refuses deleting the landing branch', async () => {
      runs = [live({ branch: 'feature' })];
      await expect(userGit().deleteBranch(at(), { branch: 'feature', confirm: { branch: 'feature', unmerged: false } })).rejects.toMatchObject({ code: 'landing_branch_held' });
    });

    it('allows everything else under a live run', async () => {
      runs = [live()];
      write(workspace, { 'a.txt': 'A\n' });
      git(workspace, 'add', 'a.txt');
      await userGit().commit(at(), { message: 'mine' });
      await userGit().createBranch(at(), { name: 'fresh' });
      await userGit().deleteBranch(at(), { branch: 'fresh', confirm: { branch: 'fresh', unmerged: false } });
    });

    it('allows a switch away from a settled run with a warning', async () => {
      runs = [live({ live: false })];
      const answer = await userGit().switchBranch(at(), { branch: 'feature' });
      expect(answer.warning).toMatch(/Merge all/);
      expect(git(workspace, 'branch', '--show-current').trim()).toBe('feature');
    });
  });

  describe('timeline recording (G6)', () => {
    const live: LandingRun = { workspace, sessionId: 's1', runId: 'r1', repo: '.', branch: 'main', live: true, unmerged: false };
    const held = { sessionId: 's1', runId: 'r1', repo: '.', branch: 'main' };

    it('records a commit, a stash, a discard and a save on a live run\'s landing branch', async () => {
      runs = [live];
      write(workspace, { 'a.txt': 'A\n' });
      git(workspace, 'add', 'a.txt');
      await userGit().commit(at(), { message: 'mine' });
      write(workspace, { 'b.txt': 'B\n' });
      await userGit().stash(at(), {});
      write(workspace, { 'b.txt': 'B\n' });
      await userGit().discard(at(), { paths: ['b.txt'], confirm: { files: ['b.txt'] } });
      await userGit().save(at(), { path: 'b.txt', text: 'saved\n', baseHash: sha256('b\n') });
      expect(recorded).toEqual([
        { held, text: 'You committed "mine" on main.' },
        { held, text: 'You stashed changes on main.' },
        { held, text: 'You discarded changes to b.txt on main.' },
        { held, text: 'You saved b.txt on main.' },
      ]);
    });

    it('records nothing on another branch, under a settled run, or for a stage', async () => {
      runs = [{ ...live, live: false }];
      write(workspace, { 'a.txt': 'A\n' });
      git(workspace, 'add', 'a.txt');
      await userGit().commit(at(), { message: 'settled' });
      runs = [live];
      write(workspace, { 'b.txt': 'B\n' });
      await userGit().stage(at(), { paths: ['b.txt'] });
      git(workspace, 'switch', '-q', '-c', 'feature');
      await userGit().commit(at(), { message: 'elsewhere' });
      expect(recorded).toEqual([]);
    });
  });

  describe('stash (G8)', () => {
    it('stashes only the paths named, names the stash it made, and pops it by that name', async () => {
      write(workspace, { 'a.txt': 'A\n', 'b.txt': 'B\n', 'c.txt': 'c\n' });
      const answer = await userGit().stash(at(), { paths: ['a.txt', 'c.txt'], message: 'ordewell: before Merge all of r1' });
      expect(porcelain(workspace)).toEqual([' M b.txt']);
      const [sha, subject] = git(workspace, 'stash', 'list', '--format=%H%x00%gs').trim().split('\0');
      expect(answer.stash).toEqual({ sha, message: subject });
      expect(subject).toContain('ordewell: before Merge all of r1');
      // Another stash on top: the pop still takes the one it names.
      write(workspace, { 'b.txt': 'other\n' });
      git(workspace, 'stash', 'push', '-q', '-m', 'on top');
      await userGit().stashPop(at(), { stash: sha });
      expect(porcelain(workspace)).toEqual([' M a.txt', '?? c.txt']);
      expect(git(workspace, 'stash', 'list', '--format=%gs').trim()).toContain('on top');
    });

    it('refuses a stash with nothing to stash', async () => {
      await expect(userGit().stash(at(), {})).rejects.toMatchObject({ code: 'refused' });
    });

    it('drops a stash by name, and answers stale for one that is gone', async () => {
      write(workspace, { 'a.txt': 'A\n' });
      const { stash } = await userGit().stash(at(), {});
      await userGit().stashDrop(at(), { stash: stash!.sha });
      expect(git(workspace, 'stash', 'list')).toBe('');
      await expect(userGit().stashPop(at(), { stash: stash!.sha })).rejects.toMatchObject({ code: 'stale' });
    });
  });

  describe('fetch, pull and push to the tracking remote (G3, G5)', () => {
    let remote: string;
    let other: string;

    beforeEach(() => {
      remote = path.join(tmp, 'remote.git');
      git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
      git(workspace, 'remote', 'add', 'origin', remote);
      git(workspace, 'push', '-q', '-u', 'origin', 'main');
      other = path.join(tmp, 'other');
      git(tmp, 'clone', '-q', remote, other);
      configure(other);
    });

    it('pushes the checked-out branch to its tracking branch', async () => {
      write(workspace, { 'a.txt': 'A\n' });
      git(workspace, 'commit', '-q', '-am', 'to push');
      const answer = await userGit().push(at(), { confirm: { remote: 'origin', branch: 'main' } });
      expect(git(remote, 'rev-parse', 'main').trim()).toBe(head(workspace));
      expect(answer.repo).toMatchObject({ upstream: 'origin/main', ahead: 0, behind: 0 });
    });

    it('fetches, then pulls what another clone pushed', async () => {
      write(other, { 'b.txt': 'from other\n' });
      git(other, 'commit', '-q', '-am', 'other work');
      git(other, 'push', '-q');
      const fetched = await userGit().fetch(at());
      expect(fetched.repo).toMatchObject({ behind: 1 });
      await userGit().pull(at(), { confirm: { remote: 'origin', branch: 'main' } });
      expect(head(workspace)).toBe(head(other));
    });

    it('refuses a push or pull whose confirmation names another remote or branch', async () => {
      await expect(userGit().push(at(), { confirm: { remote: 'upstream', branch: 'main' } }))
        .rejects.toMatchObject({ code: 'confirm_stale', detail: { difference: { field: 'remote', shown: 'upstream', now: 'origin' } } });
      await expect(userGit().pull(at(), { confirm: { remote: 'origin', branch: 'release' } }))
        .rejects.toMatchObject({ code: 'confirm_stale', detail: { difference: { field: 'branch', shown: 'release', now: 'main' } } });
    });

    it('answers git_failed for a push the remote rejects, never forcing it', async () => {
      write(other, { 'b.txt': 'from other\n' });
      git(other, 'commit', '-q', '-am', 'other work');
      git(other, 'push', '-q');
      write(workspace, { 'a.txt': 'A\n' });
      git(workspace, 'commit', '-q', '-am', 'diverged');
      await expect(userGit().push(at(), { confirm: { remote: 'origin', branch: 'main' } })).rejects.toMatchObject({ code: 'git_failed' });
      expect(git(remote, 'rev-parse', 'main').trim()).toBe(head(other));
    });

    it('records a pull on a live run\'s landing branch', async () => {
      runs = [{ workspace, sessionId: 's1', runId: 'r1', repo: '.', branch: 'main', live: true, unmerged: false }];
      await userGit().pull(at(), { confirm: { remote: 'origin', branch: 'main' } });
      expect(recorded.map((r) => r.text)).toEqual(['You pulled from origin/main on main.']);
    });

    it('refuses a pull on a branch with no tracking remote', async () => {
      git(workspace, 'switch', '-q', '-c', 'local-only');
      await expect(userGit().pull(at(), { confirm: { remote: 'origin', branch: 'local-only' } })).rejects.toMatchObject({ code: 'refused' });
    });
  });

  describe('several repositories', () => {
    it('acts on the repository named, and names it in the timeline line', async () => {
      fs.rmSync(workspace, { recursive: true, force: true });
      repo(path.join(workspace, 'api'), { 'a.txt': 'a\n' });
      repo(path.join(workspace, 'web'), { 'w.txt': 'w\n' });
      runs = [{ workspace, sessionId: 's1', runId: 'r1', repo: 'api', branch: 'main', live: true, unmerged: false }];
      write(path.join(workspace, 'api'), { 'a.txt': 'A\n' });
      await userGit().stage({ workspace, repo: 'api' }, { paths: ['a.txt'] });
      await userGit().commit({ workspace, repo: 'api' }, { message: 'api work' });
      expect(git(path.join(workspace, 'api'), 'log', '-1', '--format=%s').trim()).toBe('api work');
      expect(recorded.map((r) => r.text)).toEqual(['You committed "api work" on main in api.']);
      await expect(userGit().commit({ workspace }, { message: 'x' })).rejects.toMatchObject({ code: 'refused' });
    });
  });
});

describe.skipIf(!hasGit)('Merge all preflight (ADR-0062 G8)', () => {
  let tmp: string;
  let workspace: string;
  let run: IsolationRun;
  const session = 'sess-pre';
  const reader = createWorkspaceReader({ config: { workspaceRepos: [] } });
  const isolation = createWorktreeIsolation({
    config: { worktreeIsolation: true, worktreeSetupCommand: undefined, workspaceRepos: [], worktreeLinks: [] },
    resolvePath: async () => process.env.PATH ?? '',
  });
  const task = createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'x' });

  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-preflight-')));
    workspace = path.join(tmp, 'ws');
    repo(workspace, { 'README.md': '# Run\n', 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
    run = await isolation.startRun(workspace);
    const one = await isolation.prepare(task, run);
    write(one.cwd, { 'src/a.ts': 'from the run\n', 'src/new.ts': 'new\n' });
    expect(await isolation.integrate(task, run)).toBe('merged');
    saveSession({ tasks: [task], runners: ['claude-code'], status: 'approved', isolation: { run, resolvers: {} } } as unknown as LegacyPlanState, 'goal', workspace, session);
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const incoming = () => git(workspace, 'diff', '--name-only', run.repos[0].baseRef, run.repos[0].integrationBranch).split('\n').filter(Boolean).sort();

  it('names the uncommitted files the merge would bring in, an untracked one included', async () => {
    write(workspace, { 'src/a.ts': 'mine\n', 'src/new.ts': 'mine too\n', 'README.md': 'mine\n' });
    expect(incoming()).toEqual(['src/a.ts', 'src/new.ts']);
    expect(await reader.mergePreflight(workspace, session)).toEqual({
      runId: run.id,
      repos: [{ repo: '.', branch: 'main', overlap: ['src/a.ts', 'src/new.ts'], otherDirty: true }],
      stashMessage: `ordewell: before Merge all of ${run.id}`,
    });
  });

  it('after a stash of the overlap alone, leaves the rest as the person had it', async () => {
    write(workspace, { 'src/a.ts': 'mine\n', 'src/b.ts': 'mine\n' });
    const before = await reader.mergePreflight(workspace, session);
    expect(before.repos[0]).toMatchObject({ overlap: ['src/a.ts'], otherDirty: true });
    const userGit = createUserGit({ reader, landingRuns: () => [], record: () => undefined });
    await userGit.stash({ workspace }, { paths: before.repos[0].overlap, message: before.stashMessage });
    // Saving the session left Ordewell's own state untracked beside the person's change.
    expect(porcelain(workspace).filter((line) => !line.includes('.ordewell/'))).toEqual([' M src/b.ts']);
    expect(git(workspace, 'stash', 'list', '--format=%gs')).toContain(before.stashMessage);
    expect((await reader.mergePreflight(workspace, session)).repos[0]).toMatchObject({ overlap: [], otherDirty: true });
  });

  it('answers a clean checkout with nothing in the way', async () => {
    expect((await reader.mergePreflight(workspace, session)).repos).toEqual([{ repo: '.', branch: 'main', overlap: [], otherDirty: false }]);
  });

  it('answers gone for a session with no run', async () => {
    saveSession({ tasks: [task], runners: ['claude-code'], status: 'approved' } as unknown as LegacyPlanState, 'goal', workspace, 'sess-none');
    await expect(reader.mergePreflight(workspace, 'sess-none')).rejects.toMatchObject({ code: 'gone' });
  });
});
