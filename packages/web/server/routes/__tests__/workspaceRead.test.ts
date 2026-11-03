import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  type FileFindResponse,
  type FileTreeResponse,
  type GitBranchesResponse,
  type GitCommitResponse,
  type GitDiffResponse,
  type GitLogResponse,
  type GitReposResponse,
  type GitStatusResponse,
  type IsolationRun,
  type LegacyPlanState,
  type TaskDiffResponse,
} from '@ordewell/core';
import { createApp } from '../../app';
import type { OrchestratorPool } from '../../pool/orchestratorPool';

/**
 * The user's reads of files and git over HTTP (ADR-0061), through the whole
 * app: admission, the routes and the reader against real repositories. The
 * pool answers nothing: a read never asks a session for its lease (R4).
 */

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

const PORT = 4555;
const TOKEN = 'reads-token';
const HEADERS = { host: `127.0.0.1:${PORT}`, authorization: bearerHeaderValue(TOKEN) };

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return env;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8' });
}

function write(root: string, files: Record<string, string | Buffer>): void {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
}

function repo(root: string, files: Record<string, string | Buffer>): void {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  write(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
}

const touched: string[] = [];
// Every property a route reads off the pool is recorded: none may be.
const pool = new Proxy({}, { get: (_t, key) => { touched.push(String(key)); return () => { throw new Error(`pool.${String(key)} was called`); }; } }) as OrchestratorPool;
const app = createApp(pool, { port: PORT, token: TOKEN, tokenFile: '/tmp/token' });
touched.length = 0;

async function get<T>(url: string, query: Record<string, string | undefined>): Promise<{ status: number; body: T }> {
  const params = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined));
  const res = await app.request(`${url}?${params.toString()}`, { headers: HEADERS });
  return { status: res.status, body: await res.json() as T };
}

describe.skipIf(!hasGit)('the user\'s file and git reads over HTTP (ADR-0061)', () => {
  let tmp: string;
  let group: string;

  beforeAll(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-reads-')));
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'outside\n');
    // A workspace of two repositories (ADR-0014): the folder itself is none.
    group = path.join(tmp, 'group');
    repo(path.join(group, 'api'), { 'README.md': '# API\n', 'src/server.ts': 'export const port = 1;\n' });
    repo(path.join(group, 'web'), {
      'index.js': 'console.log("web");\n',
      'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]),
      'big.txt': 'x'.repeat(1024 * 1024 + 1),
    });
    const api = path.join(group, 'api');
    write(api, { 'src/server.ts': 'export const port = 2;\n', 'notes.txt': 'todo\n' });
    git(api, 'add', '-A');
    git(api, 'commit', '-q', '-m', 'second');
    write(api, { 'src/server.ts': 'export const port = 3;\n' });
    fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(api, 'leak.txt'));
    write(api, { '.ordewell/sessions/s1.json': '{}' });
  });

  afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  it('lists the workspace\'s repositories', async () => {
    const { status, body } = await get<GitReposResponse>('/api/git/repos', { workspace: group });
    expect(status).toBe(200);
    expect(body.repos.map((r) => [r.repo, r.branch, r.head])).toEqual([
      ['api', 'main', git(path.join(group, 'api'), 'rev-parse', 'HEAD').trim()],
      ['web', 'main', git(path.join(group, 'web'), 'rev-parse', 'HEAD').trim()],
    ]);
  });

  it('lists a directory with git status per entry', async () => {
    const { status, body } = await get<FileTreeResponse>('/api/files/tree', { workspace: group, repo: 'api', dir: 'src' });
    expect(status).toBe(200);
    expect(body.at).toMatchObject({ repo: 'api', scope: 'checkout', source: 'disk' });
    expect(body.entries.map((e) => [e.name, e.status ?? null])).toEqual([['server.ts', 'M']]);
    const root = await get<FileTreeResponse>('/api/files/tree', { workspace: group, repo: 'api' });
    expect(root.body.entries.find((e) => e.name === 'leak.txt')).toMatchObject({ kind: 'symlink' });
    expect(root.body.entries.map((e) => e.name)).not.toContain('.git');
  });

  it('answers a file\'s text, a binary file and a file over the cap', async () => {
    const text = await get<FileContentResponse>('/api/files/content', { workspace: group, repo: 'web', path: 'index.js' });
    expect(text).toMatchObject({ status: 200, body: { kind: 'text', text: 'console.log("web");\n' } });
    const binary = await get<FileContentResponse>('/api/files/content', { workspace: group, repo: 'web', path: 'logo.png' });
    expect(binary.body).toMatchObject({ kind: 'binary', size: 7 });
    expect(binary.body).not.toHaveProperty('text');
    const big = await get<FileContentResponse>('/api/files/content', { workspace: group, repo: 'web', path: 'big.txt' });
    expect(big.body).toMatchObject({ kind: 'too-large', size: 1024 * 1024 + 1, limit: 1024 * 1024 });
  });

  it('finds by name and by text, capped', async () => {
    const byName = await get<FileFindResponse>('/api/files/find', { workspace: group, repo: 'api', query: 'server' });
    expect(byName.body).toMatchObject({ mode: 'name', matches: [{ path: 'src/server.ts' }], truncated: false });
    const byText = await get<FileFindResponse>('/api/files/find', { workspace: group, repo: 'api', query: 'port = 3', text: '1' });
    expect(byText.body).toMatchObject({ mode: 'text', matches: [{ path: 'src/server.ts', line: 1, preview: 'export const port = 3;' }] });
    const capped = await get<FileFindResponse>('/api/files/find', { workspace: group, repo: 'web', query: '.', limit: '1' });
    expect(capped.body).toMatchObject({ truncated: true });
    expect(capped.body.matches).toHaveLength(1);
  });

  it('answers the checkout\'s status and its unstaged diff per file', async () => {
    const api = path.join(group, 'api');
    const status = await get<GitStatusResponse>('/api/git/status', { workspace: group, repo: 'api' });
    expect(status.body.unstaged).toEqual([{ path: 'src/server.ts', status: 'M' }]);
    expect(status.body.untracked).toContain('leak.txt');
    const diff = await get<GitDiffResponse>('/api/git/diff', { workspace: group, repo: 'api', kind: 'unstaged', path: 'src/server.ts' });
    expect(diff.body.files).toEqual([{ path: 'src/server.ts', status: 'M', added: 1, removed: 1 }]);
    expect(diff.body.patch).toBe(git(api, 'diff', '--', 'src/server.ts'));
    const between = await get<GitDiffResponse>('/api/git/diff', { workspace: group, repo: 'api', from: 'HEAD~1', to: 'HEAD' });
    expect(between.body.files.map((f) => f.path)).toEqual(['notes.txt', 'src/server.ts']);
  });

  it('pages the log with parents, and answers one commit', async () => {
    const api = path.join(group, 'api');
    const [head, first] = git(api, 'rev-list', 'HEAD').trim().split('\n');
    const page = await get<GitLogResponse>('/api/git/log', { workspace: group, repo: 'api', limit: '1' });
    expect(page.body.commits.map((c) => [c.sha, c.parents, c.subject])).toEqual([[head, [first], 'second']]);
    expect(page.body.cursor).not.toBeNull();
    const next = await get<GitLogResponse>('/api/git/log', { workspace: group, repo: 'api', limit: '1', cursor: page.body.cursor ?? '' });
    expect(next.body).toMatchObject({ commits: [{ sha: first, parents: [], subject: 'initial' }], cursor: null });
    const byRef = await get<GitLogResponse>('/api/git/log', { workspace: group, repo: 'api', ref: 'HEAD~1' });
    expect(byRef.body.commits.map((c) => c.sha)).toEqual([first]);

    const detail = await get<GitCommitResponse>('/api/git/commit', { workspace: group, repo: 'api', sha: head });
    expect(detail.body.commit).toMatchObject({ sha: head, parents: [first], subject: 'second' });
    expect(detail.body.files.map((f) => f.path)).toEqual(['notes.txt', 'src/server.ts']);
    expect(detail.body).not.toHaveProperty('patch');
    const one = await get<GitCommitResponse>('/api/git/commit', { workspace: group, repo: 'api', sha: head, path: 'src/server.ts' });
    expect(one.body.files.map((f) => f.path)).toEqual(['src/server.ts']);
    expect(one.body.patch).toBe(git(api, 'diff', first, head, '--', 'src/server.ts'));
  });

  it('answers the branches', async () => {
    const { body } = await get<GitBranchesResponse>('/api/git/branches', { workspace: group, repo: 'web' });
    expect(body).toMatchObject({ repo: 'web', current: 'main', detached: false });
    expect(body.local.map((b) => b.name)).toEqual(['main']);
    expect(body.worktrees).toEqual([expect.objectContaining({ path: path.join(group, 'web'), main: true, branch: 'main' })]);
  });

  it.each([
    ['traversal', '../secret.txt'],
    ['traversal out of the repository', '../../secret.txt'],
    ['an absolute path', '/etc/passwd'],
    ['git internals', '.git/config'],
    ['Ordewell\'s state', '.ordewell/sessions/s1.json'],
    ['a link out of the scope', 'leak.txt'],
  ])('refuses %s with 403 path_refused', async (_why, file) => {
    const { status, body } = await get<ErrorBody>('/api/files/content', { workspace: group, repo: 'api', path: file });
    expect(status).toBe(403);
    expect(body.code).toBe('path_refused');
  });

  it('refuses a directory outside the scope and a tree of .git', async () => {
    for (const dir of ['..', '.git', 'src/../..']) {
      const { status } = await get<ErrorBody>('/api/files/tree', { workspace: group, repo: 'api', dir });
      expect(status).toBe(403);
    }
  });

  it('answers 404 path_not_found for a file that is not there', async () => {
    expect(await get<ErrorBody>('/api/files/content', { workspace: group, repo: 'api', path: 'nope.txt' })).toMatchObject({ status: 404, body: { code: 'path_not_found' } });
  });

  it('refuses a repository the workspace does not hold, or none named in a group', async () => {
    expect(await get<ErrorBody>('/api/files/tree', { workspace: group, repo: '../group' })).toMatchObject({ status: 400, body: { code: 'refused' } });
    expect(await get<ErrorBody>('/api/files/tree', { workspace: group })).toMatchObject({ status: 400, body: { code: 'refused' } });
  });

  it('refuses a missing workspace, an unknown scope and a read with no path', async () => {
    expect(await get<ErrorBody>('/api/git/status', { workspace: path.join(tmp, 'nowhere') })).toMatchObject({ status: 400, body: { code: 'workspace_not_found' } });
    expect(await get<ErrorBody>('/api/files/tree', { workspace: group, repo: 'api', scope: 'elsewhere' })).toMatchObject({ status: 400, body: { code: 'refused' } });
    expect(await get<ErrorBody>('/api/files/content', { workspace: group, repo: 'api' })).toMatchObject({ status: 400, body: { code: 'refused' } });
    expect(await get<ErrorBody>('/api/git/commit', { workspace: group, repo: 'api' })).toMatchObject({ status: 400, body: { code: 'refused' } });
    expect(await get<ErrorBody>('/api/files/find', { workspace: group, repo: 'api' })).toMatchObject({ status: 400, body: { code: 'refused' } });
  });

  it('never asks the pool', () => {
    expect(touched).toEqual([]);
  });
});

describe.skipIf(!hasGit)('reads of an isolated run over HTTP (ADR-0061 R2)', () => {
  let tmp: string;
  let workspace: string;
  let run: IsolationRun;
  let integration: string;
  let base: string;
  const session = 'sess-http';
  const isolation = createWorktreeIsolation({
    config: { worktreeIsolation: true, worktreeSetupCommand: undefined, workspaceRepos: [], worktreeLinks: [] },
    resolvePath: async () => process.env.PATH ?? '',
  });
  const task = (n: number) => createTask({ id: `t${n}`, order: n, title: `Task ${n}`, prompt: 'x' });

  beforeAll(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-reads-run-')));
    workspace = path.join(tmp, 'ws');
    repo(workspace, { 'README.md': '# Run\n', 'src/a.ts': 'export const a = 1;\n' });
    run = await isolation.startRun(workspace);
    base = run.repos[0].baseRef;
    integration = run.repos[0].integrationBranch;
    const one = await isolation.prepare(task(1), run);
    write(one.cwd, { 'src/a.ts': 'export const a = 2;\n' });
    expect(await isolation.integrate(task(1), run)).toBe('merged');
    const two = await isolation.prepare(task(2), run);
    write(two.cwd, { 'src/t2.ts': 'export const two = "needle";\n' });
    saveSession({ tasks: [task(1), task(2)], runners: ['claude-code'], status: 'approved', isolation: { run, resolvers: {} } } as unknown as LegacyPlanState, 'goal', workspace, session);
    touched.length = 0;
  });

  afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  it('reads the integration branch\'s files and its diff against the run\'s base', async () => {
    const content = await get<FileContentResponse>('/api/files/content', { workspace, scope: 'integration', sessionId: session, path: 'src/a.ts' });
    expect(content.body).toMatchObject({ at: { scope: 'integration', source: 'commit', branch: integration }, kind: 'text', text: 'export const a = 2;\n' });
    const tree = await get<FileTreeResponse>('/api/files/tree', { workspace, scope: 'integration', sessionId: session, dir: 'src' });
    expect(tree.body.entries.map((e) => [e.name, e.status, e.taskId])).toEqual([['a.ts', 'M', 't1']]);
    const diff = await get<GitDiffResponse>('/api/git/diff', { workspace, scope: 'integration', sessionId: session, path: 'src/a.ts' });
    expect(diff.body).toMatchObject({ from: base, files: [{ path: 'src/a.ts', status: 'M', added: 1, removed: 1 }] });
    expect(diff.body.patch).toBe(git(workspace, 'diff', base, integration, '--', 'src/a.ts'));
  });

  it('reads a live task\'s worktree, crediting its files to it', async () => {
    const tree = await get<FileTreeResponse>('/api/files/tree', { workspace, scope: 'task', sessionId: session, taskId: 't2', dir: 'src' });
    expect(tree.body.entries.find((e) => e.name === 't2.ts')).toMatchObject({ status: '?', taskId: 't2' });
    const find = await get<FileFindResponse>('/api/files/find', { workspace, scope: 'task', sessionId: session, taskId: 't2', query: 'needle', text: 'true' });
    expect(find.body.matches).toEqual([{ path: 'src/t2.ts', line: 1, preview: 'export const two = "needle";' }]);
  });

  it('answers a task\'s diff: names only, then one file\'s patch', async () => {
    const names = await get<TaskDiffResponse>(`/api/plans/${session}/tasks/t2/diff`, { workspace, names: '1' });
    expect(names).toMatchObject({ status: 200, body: { available: true, text: 'src/t2.ts' } });
    const one = await get<TaskDiffResponse>(`/api/plans/${session}/tasks/t2/diff`, { workspace, path: 'src/t2.ts' });
    expect(one.body.available).toBe(true);
    if (one.body.available) expect(one.body.text).toContain('+export const two = "needle";');
  });

  it('refuses a task diff\'s path out of the workspace', async () => {
    expect(await get<ErrorBody>(`/api/plans/${session}/tasks/t2/diff`, { workspace, path: '../x' })).toMatchObject({ status: 403, body: { code: 'path_refused' } });
  });

  it('answers 410 gone for a scope the run does not have, never the checkout instead', async () => {
    expect(await get<ErrorBody>('/api/files/tree', { workspace, scope: 'task', sessionId: session, taskId: 't9' })).toMatchObject({ status: 410, body: { code: 'gone' } });
    expect(await get<ErrorBody>('/api/files/tree', { workspace, scope: 'integration', sessionId: 'no-such' })).toMatchObject({ status: 410, body: { code: 'gone' } });
    expect(await get<ErrorBody>('/api/plans/no-such/tasks/t2/diff', { workspace })).toMatchObject({ status: 410, body: { code: 'gone' } });
    expect(await get<ErrorBody>(`/api/plans/${session}/tasks/t9/diff`, { workspace })).toMatchObject({ status: 410, body: { code: 'gone' } });
  });

  it('names which run and task each of Ordewell\'s branches and worktrees belongs to', async () => {
    const { body } = await get<GitBranchesResponse>('/api/git/branches', { workspace });
    expect(body.ordewell.find((b) => b.name === integration)?.owner).toEqual({ sessionId: session, runId: run.id });
    expect(body.ordewell.find((b) => b.name === run.tasks.t2.branch)?.owner).toEqual({ sessionId: session, runId: run.id, taskId: 't2' });
    expect(body.local.find((b) => b.name === 'main')?.landingFor).toEqual([{ sessionId: session, runId: run.id }]);
    expect(body.worktrees.find((w) => w.branch === run.tasks.t2.branch)?.owner).toMatchObject({ taskId: 't2' });
  });

  it('never asks the pool, so a session held by another host is still read', () => {
    expect(touched).toEqual([]);
  });
});
