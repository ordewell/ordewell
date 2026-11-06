import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  bearerHeaderValue,
  createTask,
  createWorktreeIsolation,
  saveSession,
  type ErrorBody,
  type FileContentResponse,
  type GitActionResponse,
  type IsolationRun,
  type LegacyPlanState,
  type MergePreflightResponse,
} from '@ordewell/core';
import { createApp } from '../../app';
import type { OrchestratorPool } from '../../pool/orchestratorPool';

/**
 * The user's git actions over HTTP (ADR-0062), through the whole app against
 * a real checkout with an isolated run saved on disk and a local bare remote.
 * The pool is asked only whether that run is live and where its timeline is:
 * no route takes a session's lease.
 */

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

const PORT = 4556;
const TOKEN = 'writes-token';
const HEADERS = { host: `127.0.0.1:${PORT}`, authorization: bearerHeaderValue(TOKEN), 'content-type': 'application/json' };

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

function identity(root: string): void {
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
}

let live = false;
const asked: string[] = [];
const recorded: Array<{ sessionId: string; workspace: string; text: string }> = [];
// Only the two questions an action may put to the pool; anything else throws.
const pool = new Proxy({
  userRunIsLive: (sessionId: string) => { asked.push(sessionId); return live; },
  recordUserAction: (sessionId: string, workspace: string, text: string) => { recorded.push({ sessionId, workspace, text }); },
}, { get: (target, key) => (key in target ? target[key as keyof typeof target] : () => { throw new Error(`pool.${String(key)} was called`); }) }) as unknown as OrchestratorPool;
const app = createApp(pool, { port: PORT, token: TOKEN, tokenFile: '/tmp/token' });

async function send<T>(method: 'POST' | 'PUT', url: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await app.request(url, { method, headers: HEADERS, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, body: await res.json() as T };
}
const post = <T = GitActionResponse>(url: string, body: unknown) => send<T>('POST', url, body);

async function get<T>(url: string, query: Record<string, string>): Promise<{ status: number; body: T }> {
  const res = await app.request(`${url}?${new URLSearchParams(query).toString()}`, { headers: HEADERS });
  return { status: res.status, body: await res.json() as T };
}

describe.skipIf(!hasGit)('the user\'s git actions over HTTP (ADR-0062)', () => {
  let tmp: string;
  let workspace: string;
  let remote: string;
  let run: IsolationRun;
  let taskWorktree: string;
  const session = 'sess-writes';
  const isolation = createWorktreeIsolation({
    config: { worktreeIsolation: true, worktreeSetupCommand: undefined, workspaceRepos: [], worktreeLinks: [] },
    resolvePath: async () => process.env.PATH ?? '',
  });
  const task = (n: number) => createTask({ id: `t${n}`, order: n, title: `Task ${n}`, prompt: 'x' });
  // Ordewell's own state dir is beside the person's files, and none of theirs.
  const status = () => git(workspace, 'status', '--porcelain', '--', '.', ':!.ordewell');

  beforeAll(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-writes-')));
    remote = path.join(tmp, 'remote.git');
    git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
    workspace = path.join(tmp, 'ws');
    fs.mkdirSync(workspace);
    git(workspace, 'init', '-q', '-b', 'main');
    identity(workspace);
    write(workspace, { 'README.md': '# Writes\n', 'src/a.ts': 'export const a = 1;\n' });
    git(workspace, 'add', '-A');
    git(workspace, 'commit', '-q', '-m', 'initial');
    git(workspace, 'remote', 'add', 'origin', remote);
    git(workspace, 'push', '-q', '-u', 'origin', 'main');
    // A run that lands on main and has landed a change to src/a.ts.
    run = await isolation.startRun(workspace);
    const one = await isolation.prepare(task(1), run);
    write(one.cwd, { 'src/a.ts': 'export const a = 2;\n' });
    expect(await isolation.integrate(task(1), run)).toBe('merged');
    taskWorktree = (await isolation.prepare(task(2), run)).cwd;
    saveSession({ tasks: [task(1), task(2)], runners: ['claude-code'], status: 'approved', isolation: { run, resolvers: {} } } as unknown as LegacyPlanState, 'goal', workspace, session);
  });

  afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  beforeEach(() => {
    live = false;
    asked.length = 0;
    recorded.length = 0;
    git(workspace, 'checkout', '-q', 'main');
    git(workspace, 'reset', '-q', '--hard');
    git(workspace, 'clean', '-qfd', '--', 'src', 'notes.md');
  });

  it('saves a file read at its hash, and refuses one that changed since as stale', async () => {
    const read = await get<FileContentResponse>('/api/files/content', { workspace, path: 'README.md' });
    if (read.body.kind !== 'text') throw new Error('expected text');
    const saved = await send<GitActionResponse>('PUT', '/api/files/content', { workspace, path: 'README.md', text: '# Saved\n', baseHash: read.body.hash });
    expect(saved).toMatchObject({ status: 200, body: { repo: { repo: '.', branch: 'main' } } });
    expect(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8')).toBe('# Saved\n');

    const again = await send<ErrorBody>('PUT', '/api/files/content', { workspace, path: 'README.md', text: '# Lost\n', baseHash: read.body.hash });
    expect(again).toMatchObject({ status: 409, body: { code: 'stale' } });
    expect(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8')).toBe('# Saved\n');

    const created = await send<GitActionResponse>('PUT', '/api/files/content', { workspace, path: 'notes.md', text: 'new\n', baseHash: null });
    expect(created.status).toBe(200);
  });

  it('refuses a save outside the checkout', async () => {
    expect(await send<ErrorBody>('PUT', '/api/files/content', { workspace, path: '../escape.txt', text: 'x', baseHash: null })).toMatchObject({ status: 403, body: { code: 'path_refused' } });
    expect(fs.existsSync(path.join(tmp, 'escape.txt'))).toBe(false);
  });

  it('stages, unstages and commits', async () => {
    write(workspace, { 'src/a.ts': 'export const a = 5;\n' });
    expect((await post('/api/git/stage', { workspace, paths: ['src/a.ts'] })).status).toBe(200);
    expect(status()).toBe('M  src/a.ts\n');
    expect((await post('/api/git/unstage', { workspace, paths: ['src/a.ts'] })).status).toBe(200);
    expect(status()).toBe(' M src/a.ts\n');
    await post('/api/git/stage', { workspace, paths: ['src/a.ts'] });
    const committed = await post('/api/git/commit', { workspace, message: 'five' });
    expect(committed.status).toBe(200);
    expect(committed.body.repo.head).toBe(git(workspace, 'rev-parse', 'HEAD').trim());
    expect(git(workspace, 'log', '-1', '--format=%s').trim()).toBe('five');
  });

  it('amends an unpushed commit the person saw, and refuses a pushed one', async () => {
    write(workspace, { 'src/a.ts': 'export const a = 6;\n' });
    await post('/api/git/stage', { workspace, paths: ['src/a.ts'] });
    await post('/api/git/commit', { workspace, message: 'six' });
    const head = git(workspace, 'rev-parse', 'HEAD').trim();
    const amended = await post('/api/git/commit', { workspace, message: 'six, amended', amend: true, confirm: { head } });
    expect(amended.status).toBe(200);
    expect(git(workspace, 'log', '-1', '--format=%s').trim()).toBe('six, amended');

    git(workspace, 'reset', '-q', '--hard', 'origin/main');
    const pushed = await post<ErrorBody>('/api/git/commit', { workspace, message: 'rewrite', amend: true, confirm: { head: git(workspace, 'rev-parse', 'HEAD').trim() } });
    expect(pushed).toMatchObject({ status: 400, body: { code: 'pushed' } });
  });

  it('discards only what the person was shown, answering what changed otherwise', async () => {
    write(workspace, { 'src/a.ts': 'export const a = 7;\n', 'README.md': '# Changed\n' });
    const mismatch = await post<ErrorBody>('/api/git/discard', { workspace, paths: ['src/a.ts', 'README.md'], confirm: { files: ['src/a.ts'] } });
    expect(mismatch).toMatchObject({ status: 409, body: { code: 'confirm_stale', confirmStale: { field: 'files', shown: ['src/a.ts'], now: ['README.md', 'src/a.ts'] } } });
    expect(status()).toContain('src/a.ts');

    const discarded = await post('/api/git/discard', { workspace, paths: ['src/a.ts'], confirm: { files: ['src/a.ts'] } });
    expect(discarded.status).toBe(200);
    expect(status()).toBe(' M README.md\n');
  });

  it('creates, switches and deletes a branch, refusing a stale delete and Ordewell\'s own branches', async () => {
    const created = await post('/api/git/branch', { workspace, name: 'feature', switch: true });
    expect(created).toMatchObject({ status: 200, body: { repo: { branch: 'feature' } } });
    expect((await post('/api/git/switch', { workspace, branch: 'main' })).body.repo.branch).toBe('main');

    expect(await post<ErrorBody>('/api/git/branch-delete', { workspace, branch: 'feature', confirm: { branch: 'other', unmerged: false } }))
      .toMatchObject({ status: 409, body: { code: 'confirm_stale', confirmStale: { field: 'branch' } } });
    expect((await post('/api/git/branch-delete', { workspace, branch: 'feature', confirm: { branch: 'feature', unmerged: false } })).status).toBe(200);
    expect(git(workspace, 'branch', '--list', 'feature')).toBe('');

    const integration = run.repos[0].integrationBranch;
    expect(await post<ErrorBody>('/api/git/branch-delete', { workspace, branch: integration, confirm: { branch: integration, unmerged: true } }))
      .toMatchObject({ status: 400, body: { code: 'ordewell_branch' } });
    expect(await post<ErrorBody>('/api/git/switch', { workspace, branch: integration })).toMatchObject({ status: 400, body: { code: 'ordewell_branch' } });
  });

  it('stashes, then pops and drops a stash by the commit it answered with', async () => {
    write(workspace, { 'src/a.ts': 'export const a = 8;\n' });
    const stashed = await post('/api/git/stash', { workspace, message: 'mine' });
    expect(stashed.status).toBe(200);
    expect(stashed.body.stash?.message).toContain('mine');
    expect(status()).toBe('');
    // Every change is the person's changes: Ordewell's state stays where it is.
    expect(fs.existsSync(path.join(workspace, '.ordewell', '.gitignore'))).toBe(true);
    expect(git(workspace, 'stash', 'show', '--include-untracked', '--name-only', stashed.body.stash?.sha ?? '')).toBe('src/a.ts\n');
    const popped = await post('/api/git/stash-pop', { workspace, stash: stashed.body.stash?.sha });
    expect(popped.status).toBe(200);
    expect(status()).toBe(' M src/a.ts\n');

    const again = await post('/api/git/stash', { workspace, message: 'drop me' });
    expect((await post('/api/git/stash-drop', { workspace, stash: again.body.stash?.sha })).status).toBe(200);
    expect(await post<ErrorBody>('/api/git/stash-drop', { workspace, stash: again.body.stash?.sha })).toMatchObject({ status: 409, body: { code: 'stale' } });
  });

  it('pushes to and pulls from the tracking remote the person was shown', async () => {
    write(workspace, { 'src/a.ts': 'export const a = 9;\n' });
    await post('/api/git/stage', { workspace, paths: ['src/a.ts'] });
    await post('/api/git/commit', { workspace, message: 'nine' });
    expect(await post<ErrorBody>('/api/git/push', { workspace, confirm: { remote: 'upstream', branch: 'main' } }))
      .toMatchObject({ status: 409, body: { code: 'confirm_stale', confirmStale: { field: 'remote', shown: 'upstream', now: 'origin' } } });
    const pushed = await post('/api/git/push', { workspace, confirm: { remote: 'origin', branch: 'main' } });
    expect(pushed).toMatchObject({ status: 200, body: { repo: { ahead: 0 } } });
    expect(git(remote, 'log', '-1', '--format=%s', 'main').trim()).toBe('nine');

    // Someone else pushes; fetch sees it, and pull takes it.
    const other = path.join(tmp, 'other');
    git(tmp, 'clone', '-q', remote, other);
    identity(other);
    write(other, { 'other.txt': 'theirs\n' });
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'theirs');
    git(other, 'push', '-q');
    expect((await post('/api/git/fetch', { workspace })).body.repo.behind).toBe(1);
    const pulled = await post('/api/git/pull', { workspace, confirm: { remote: 'origin', branch: 'main' } });
    expect(pulled).toMatchObject({ status: 200, body: { repo: { behind: 0 } } });
    expect(fs.readFileSync(path.join(workspace, 'other.txt'), 'utf8')).toBe('theirs\n');
  });

  it('answers git\'s own refusal as git_failed with git\'s words', async () => {
    const failed = await post<ErrorBody>('/api/git/commit', { workspace, message: 'nothing staged' });
    expect(failed).toMatchObject({ status: 400, body: { code: 'git_failed' } });
    expect(failed.body.error).not.toBe('');
  });

  it('refuses a body of the wrong shape before git runs', async () => {
    expect(await post<ErrorBody>('/api/git/commit', 'not json')).toMatchObject({ status: 400, body: { code: 'refused' } });
    expect(await post<ErrorBody>('/api/git/commit', { workspace, message: 3 })).toMatchObject({ status: 400, body: { code: 'refused' } });
    expect(await post<ErrorBody>('/api/git/stage', { workspace, paths: 'src/a.ts' })).toMatchObject({ status: 400, body: { code: 'refused' } });
    expect(await post<ErrorBody>('/api/git/stage', { workspace })).toMatchObject({ status: 400, body: { code: 'refused' } });
    expect(await post<ErrorBody>('/api/git/branch-delete', { workspace, branch: 'x', confirm: { branch: 'x' } })).toMatchObject({ status: 400, body: { code: 'refused' } });
    expect(await post<ErrorBody>('/api/git/fetch', { workspace: path.join(tmp, 'missing') })).toMatchObject({ status: 400, body: { code: 'workspace_not_found' } });
  });

  describe('while the run that lands on main is live (G6, G7)', () => {
    beforeEach(() => { live = true; });

    it('refuses switching away from main or deleting it, naming the session and run', async () => {
      git(workspace, 'branch', '-f', 'feature');
      const held = { sessionId: session, runId: run.id, repo: '.', branch: 'main' };
      expect(await post<ErrorBody>('/api/git/switch', { workspace, branch: 'feature' }))
        .toMatchObject({ status: 409, body: { code: 'landing_branch_held', landingBranchHeld: held } });
      expect(await post<ErrorBody>('/api/git/branch', { workspace, name: 'elsewhere', switch: true }))
        .toMatchObject({ status: 409, body: { code: 'landing_branch_held', landingBranchHeld: held } });
      expect(git(workspace, 'branch', '--show-current').trim()).toBe('main');
      expect(asked).toContain(session);

      git(workspace, 'checkout', '-q', 'feature');
      expect(await post<ErrorBody>('/api/git/branch-delete', { workspace, branch: 'main', confirm: { branch: 'main', unmerged: false } }))
        .toMatchObject({ status: 409, body: { code: 'landing_branch_held', landingBranchHeld: held } });
      expect(git(workspace, 'branch', '--list', 'main')).not.toBe('');
      git(workspace, 'checkout', '-q', 'main');
      git(workspace, 'branch', '-D', 'feature');
    });

    it('allows everything else, and records an action on main in the session\'s timeline', async () => {
      expect((await send('PUT', '/api/files/content', { workspace, path: 'notes.md', text: 'mine\n', baseHash: null })).status).toBe(200);
      expect((await post('/api/git/stage', { workspace, paths: ['notes.md'] })).status).toBe(200);
      expect((await post('/api/git/commit', { workspace, message: 'notes' })).status).toBe(200);
      // Staging changes nothing a run lands on, so only the save and the commit are told.
      expect(recorded).toEqual([
        { sessionId: session, workspace, text: 'You saved notes.md on main.' },
        { sessionId: session, workspace, text: 'You committed "notes" on main.' },
      ]);
      git(workspace, 'reset', '-q', '--hard', 'HEAD~1');

      expect((await post('/api/git/branch', { workspace, name: 'side' })).status).toBe(200);
      git(workspace, 'branch', '-D', 'side');
    });
  });

  it('warns, without refusing, a switch away from a settled run\'s branch that holds unmerged work', async () => {
    git(workspace, 'branch', '-f', 'feature');
    const switched = await post('/api/git/switch', { workspace, branch: 'feature' });
    expect(switched).toMatchObject({ status: 200, body: { repo: { branch: 'feature' } } });
    expect(switched.body.warning).toContain('Merge all');
    expect(recorded).toEqual([]);
    git(workspace, 'checkout', '-q', 'main');
    git(workspace, 'branch', '-D', 'feature');
  });

  it('answers Merge all\'s preflight: the uncommitted files the run would collide with', async () => {
    write(workspace, { 'src/a.ts': 'export const a = 10;\n', 'README.md': '# Mine\n' });
    const preflight = await get<MergePreflightResponse>(`/api/plans/${session}/isolation/merge-preflight`, { workspace });
    expect(preflight).toMatchObject({ status: 200, body: { runId: run.id, repos: [{ repo: '.', branch: 'main', overlap: ['src/a.ts'], otherDirty: true }] } });
    expect(preflight.body.stashMessage).toContain(run.id);
    expect(await get<ErrorBody>('/api/plans/no-such/isolation/merge-preflight', { workspace })).toMatchObject({ status: 410, body: { code: 'gone' } });
  });

  it('refuses to act inside a task\'s worktree: actions are on the person\'s checkout only (G1)', async () => {
    write(taskWorktree, { 'src/t2.ts': 'export const two = 2;\n' });
    expect(await post<ErrorBody>('/api/git/stage', { workspace: taskWorktree, paths: ['src/t2.ts'] })).toMatchObject({ status: 400, body: { code: 'not_checkout' } });
    expect(await post<ErrorBody>('/api/git/fetch', { workspace: taskWorktree })).toMatchObject({ status: 400, body: { code: 'not_checkout' } });
    expect(git(taskWorktree, 'status', '--porcelain')).toBe('?? src/t2.ts\n');
  });
});
