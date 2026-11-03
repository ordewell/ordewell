import { Hono, type Context } from 'hono';
import {
  assertWorkspaceExists,
  type GitActionResponse,
  type MergePreflightResponse,
  type UserGit,
  type UserGitScope,
  type WorkspaceReader,
} from '@ordewell/core';
import { failure, InvalidBodyError, jsonObject } from './errors';

/*
 * The user's git actions on their own checkout (ADR-0062). Each takes its
 * workspace and repository in the body and acts through the user's git. None
 * touches a session's lease: an action asks the pool only whether a run is
 * live and where its timeline is, so a session another host holds is no bar.
 */

type Body = Record<string, unknown>;

/** The service trusts its types, so every body field is checked here: a wrong one is the request's fault, never a fault of git. */
function bad(message: string): never {
  throw new InvalidBodyError(message);
}

function text(body: Body, name: string): string {
  const value = body[name];
  if (typeof value !== 'string') bad(`"${name}" must be a string.`);
  return value;
}

function optionalText(body: Body, name: string): string | undefined {
  return body[name] === undefined ? undefined : text(body, name);
}

function texts(body: Body, name: string): string[] | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === 'string')) bad(`"${name}" must be a list of strings.`);
  return value;
}

function yes(body: Body, name: string): boolean | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') bad(`"${name}" must be true or false.`);
  return value;
}

/** The `confirm` the surface echoes back: what it showed the person (G3). Absent reads as an empty one, so every field it lacks is stale. */
function confirmOf(body: Body): Body {
  const value = body.confirm;
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad('"confirm" must be an object.');
  return value as Body;
}

function scopeOf(body: Body): UserGitScope {
  const workspace = optionalText(body, 'workspace') || process.cwd();
  assertWorkspaceExists(workspace);
  const repo = optionalText(body, 'repo');
  return repo ? { workspace, repo } : { workspace };
}

function changes(body: Body) {
  const paths = texts(body, 'paths');
  const hunks = optionalText(body, 'hunks');
  if ((paths === undefined) === (hunks === undefined)) bad('Name either "paths" or "hunks".');
  return hunks !== undefined ? { hunks } : { paths };
}

/** A route body that answers the repository's state after the action, or the classified refusal. */
function act(label: string, action: (scope: UserGitScope, body: Body) => Promise<GitActionResponse>) {
  return async (c: Context) => {
    try {
      const body = await jsonObject(c);
      return c.json(await action(scopeOf(body), body) satisfies GitActionResponse);
    } catch (err) {
      return failure(c, err, label, { message: 'Could not act on the repository' });
    }
  };
}

/** `PUT /api/files/content`: a save of a file read at `baseHash` (G10). */
export function fileWriteRoute(git: UserGit) {
  const router = new Hono();
  router.put('/content', act('save file', (scope, body) => {
    const baseHash = body.baseHash === null ? null : text(body, 'baseHash');
    return git.save(scope, { path: text(body, 'path'), text: text(body, 'text'), baseHash });
  }));
  return router;
}

/** `POST /api/git/*`: the v1 action set, each on the user's checkout of one repository. */
export function gitWriteRoute(git: UserGit) {
  const router = new Hono();
  router.post('/stage', act('stage', (scope, body) => git.stage(scope, changes(body))));
  router.post('/unstage', act('unstage', (scope, body) => git.unstage(scope, changes(body))));
  router.post('/commit', act('commit', (scope, body) => {
    const amend = yes(body, 'amend');
    const head = confirmOf(body).head;
    return git.commit(scope, {
      message: text(body, 'message'),
      ...(amend !== undefined ? { amend } : {}),
      ...(typeof head === 'string' ? { confirm: { head } } : {}),
    });
  }));
  router.post('/discard', act('discard', (scope, body) => {
    const files = texts(confirmOf(body), 'files') ?? [];
    return git.discard(scope, { ...changes(body), confirm: { files } });
  }));
  router.post('/branch', act('create branch', (scope, body) => {
    const from = optionalText(body, 'from');
    const switching = yes(body, 'switch');
    return git.createBranch(scope, { name: text(body, 'name'), ...(from !== undefined ? { from } : {}), ...(switching !== undefined ? { switch: switching } : {}) });
  }));
  router.post('/switch', act('switch branch', (scope, body) => git.switchBranch(scope, { branch: text(body, 'branch') })));
  router.post('/branch-delete', act('delete branch', (scope, body) => {
    const confirm = confirmOf(body);
    const shown = typeof confirm.branch === 'string' ? confirm.branch : '';
    if (typeof confirm.unmerged !== 'boolean') bad('"confirm.unmerged" must say whether the branch was shown as unmerged.');
    return git.deleteBranch(scope, { branch: text(body, 'branch'), confirm: { branch: shown, unmerged: confirm.unmerged } });
  }));
  router.post('/stash', act('stash', (scope, body) => {
    const paths = texts(body, 'paths');
    const message = optionalText(body, 'message');
    return git.stash(scope, { ...(paths !== undefined ? { paths } : {}), ...(message !== undefined ? { message } : {}) });
  }));
  router.post('/stash-pop', act('pop stash', (scope, body) => git.stashPop(scope, { stash: text(body, 'stash') })));
  router.post('/stash-drop', act('drop stash', (scope, body) => git.stashDrop(scope, { stash: text(body, 'stash') })));
  router.post('/fetch', act('fetch', (scope) => git.fetch(scope)));
  const remote = (body: Body) => {
    const confirm = confirmOf(body);
    return { remote: typeof confirm.remote === 'string' ? confirm.remote : '', branch: typeof confirm.branch === 'string' ? confirm.branch : '' };
  };
  router.post('/pull', act('pull', (scope, body) => git.pull(scope, { confirm: remote(body) })));
  router.post('/push', act('push', (scope, body) => git.push(scope, { confirm: remote(body) })));
  return router;
}

/**
 * `GET /api/plans/:sessionId/isolation/merge-preflight` (G8): per repository,
 * the user's uncommitted files Merge all would collide with. A read of the
 * saved run, so it needs neither the session open here nor its lease.
 */
export function mergePreflightRoute(reader: WorkspaceReader) {
  const router = new Hono();
  router.get('/:sessionId/isolation/merge-preflight', async (c) => {
    try {
      const workspace = c.req.query('workspace') || process.cwd();
      assertWorkspaceExists(workspace);
      return c.json(await reader.mergePreflight(workspace, c.req.param('sessionId') ?? '') satisfies MergePreflightResponse);
    } catch (err) {
      return failure(c, err, 'merge preflight', { message: 'Could not read the run' });
    }
  });
  return router;
}
