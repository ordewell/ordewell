import { Hono, type Context } from 'hono';
import {
  assertWorkspaceExists,
  WorkspaceReadError,
  type FileContentResponse,
  type FileFindResponse,
  type FileTreeResponse,
  type GitBranchesResponse,
  type GitCommitResponse,
  type GitDiffResponse,
  type GitLogResponse,
  type GitReposResponse,
  type GitStatusResponse,
  type ReadTarget,
  type TaskDiffResponse,
  type ViewScopeKind,
  type WorkspaceReader,
} from '@ordewell/core';
import { failure } from './errors';

/*
 * The user principal's reads of a workspace's files and git (ADR-0064): every
 * route is a GET, takes its workspace per request, and answers from the
 * reader alone. None touches the pool, so none takes or waits on a session's
 * lease (R4), and a session another host holds is read all the same.
 */

const SCOPES: readonly ViewScopeKind[] = ['checkout', 'integration', 'task'];

function workspaceOf(c: Context): string {
  const workspace = c.req.query('workspace') || process.cwd();
  assertWorkspaceExists(workspace);
  return workspace;
}

function targetOf(c: Context): ReadTarget {
  const scope = c.req.query('scope');
  if (scope !== undefined && !(SCOPES as readonly string[]).includes(scope)) {
    throw new WorkspaceReadError('refused', `Unknown scope "${scope}": name ${SCOPES.join(', ')}.`);
  }
  const target: ReadTarget = { workspace: workspaceOf(c) };
  const repo = c.req.query('repo');
  const sessionId = c.req.query('sessionId');
  const taskId = c.req.query('taskId');
  if (repo) target.repo = repo;
  if (scope) target.scope = scope as ViewScopeKind;
  if (sessionId) target.sessionId = sessionId;
  if (taskId) target.taskId = taskId;
  return target;
}

function required(c: Context, name: string): string {
  const value = c.req.query(name);
  if (!value) throw new WorkspaceReadError('refused', `Name the ${name} to read.`);
  return value;
}

function flag(c: Context, name: string): boolean {
  const value = c.req.query(name);
  return value === '1' || value === 'true';
}

function count(c: Context, name: string): number | undefined {
  const value = c.req.query(name);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new WorkspaceReadError('refused', `"${name}" must be a positive whole number.`);
  return n;
}

function optional(c: Context, name: string): string | undefined {
  return c.req.query(name) || undefined;
}

/** A route body that answers what the reader read, or the classified refusal. */
function read<T>(label: string, answer: (c: Context) => Promise<T>) {
  return async (c: Context) => {
    try {
      return c.json(await answer(c));
    } catch (err) {
      return failure(c, err, label, { message: 'Could not read the workspace' });
    }
  };
}

/** `/api/files`: a scope's tree, one file's content, and search by name or text. */
export function filesRoute(reader: WorkspaceReader) {
  const router = new Hono();
  router.get('/tree', read('read tree', (c) => reader.tree(targetOf(c), c.req.query('dir') ?? '') satisfies Promise<FileTreeResponse>));
  router.get('/content', read('read file', async (c) => {
    const target = targetOf(c);
    return reader.content(target, required(c, 'path')) satisfies Promise<FileContentResponse>;
  }));
  router.get('/find', read('find files', async (c) => {
    const target = targetOf(c);
    return reader.find(target, { query: required(c, 'query'), text: flag(c, 'text'), limit: count(c, 'limit') }) satisfies Promise<FileFindResponse>;
  }));
  return router;
}

/** `/api/git`: the workspace's repositories, and per repository its status, diffs, history and branches. */
export function gitRoute(reader: WorkspaceReader) {
  const router = new Hono();
  router.get('/repos', read('read repositories', (c) => reader.repos(workspaceOf(c)) satisfies Promise<GitReposResponse>));
  router.get('/status', read('read status', (c) => reader.status(targetOf(c)) satisfies Promise<GitStatusResponse>));
  router.get('/diff', read('read diff', async (c) => {
    const target = targetOf(c);
    const kind = c.req.query('kind');
    if (kind !== undefined && kind !== 'staged' && kind !== 'unstaged') throw new WorkspaceReadError('refused', `Unknown diff kind "${kind}": name staged or unstaged.`);
    return reader.diff(target, { kind, from: optional(c, 'from'), to: optional(c, 'to'), path: optional(c, 'path') }) satisfies Promise<GitDiffResponse>;
  }));
  router.get('/log', read('read log', async (c) => {
    const target = targetOf(c);
    return reader.log(target, { ref: optional(c, 'ref'), cursor: optional(c, 'cursor'), limit: count(c, 'limit') }) satisfies Promise<GitLogResponse>;
  }));
  router.get('/commit', read('read commit', async (c) => {
    const target = targetOf(c);
    return reader.commit(target, required(c, 'sha'), optional(c, 'path')) satisfies Promise<GitCommitResponse>;
  }));
  router.get('/branches', read('read branches', (c) => reader.branches(targetOf(c)) satisfies Promise<GitBranchesResponse>));
  return router;
}

/**
 * `GET /api/plans/:sessionId/tasks/:taskId/diff`: one task's diff from the
 * saved run, as `readTaskDiff` reads it for a verdict. Mounted beside
 * `plansRoute` rather than in it, since it reads the saved session and never
 * the pool's live one.
 */
export function taskDiffRoute(reader: WorkspaceReader) {
  const router = new Hono();
  router.get('/:sessionId/tasks/:taskId/diff', read('read task diff', (c) => reader.taskDiff(workspaceOf(c), c.req.param('sessionId') ?? '', c.req.param('taskId') ?? '', {
    repo: optional(c, 'repo'), path: optional(c, 'path'), names: flag(c, 'names'),
  }) satisfies Promise<TaskDiffResponse>));
  return router;
}
