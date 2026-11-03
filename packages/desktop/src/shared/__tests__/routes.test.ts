import { describe, expect, it } from 'vitest';
import { buildRequest, childStreamPath, isRouteId, ROUTES, segmentError, sessionStreamPath } from '../routes';

function refused(result: ReturnType<typeof buildRequest>): string {
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.request)}`);
  return result.error;
}

describe('the route table', () => {
  it('names only /api paths, so no route reaches a socket, a static file or another host', () => {
    for (const [id, spec] of Object.entries(ROUTES)) {
      expect(spec.path, id).toMatch(/^\/api(\/|$)/);
      expect(spec.path, id).not.toMatch(/\.\.|\/\/|\?|#/);
    }
  });

  it('knows its own ids and nothing inherited', () => {
    expect(isRouteId('sessions.list')).toBe(true);
    expect(isRouteId('toString')).toBe(false);
    expect(isRouteId('__proto__')).toBe(false);
    expect(isRouteId(42)).toBe(false);
  });
});

describe('buildRequest: the IPC allowlist', () => {
  it('builds a GET with its query', () => {
    expect(buildRequest('sessions.list', { workspace: '/Users/me/my repo' })).toEqual({
      ok: true,
      request: { method: 'GET', path: '/api/sessions?workspace=%2FUsers%2Fme%2Fmy+repo' },
    });
  });

  it('fills path parameters as encoded segments', () => {
    expect(buildRequest('sessions.taskLog', { id: 'a b', taskId: 't#1' })).toEqual({
      ok: true,
      request: { method: 'GET', path: '/api/sessions/a%20b/tasks/t%231/log' },
    });
  });

  it('carries a JSON body on a write', () => {
    expect(buildRequest('runners.setEnabled', { id: 'codex' }, { enabled: false })).toEqual({
      ok: true,
      request: { method: 'PUT', path: '/api/runners/codex', body: '{"enabled":false}' },
    });
  });

  it('reaches the checkpoint answers and every isolation outcome the session view sends', () => {
    expect(buildRequest('plans.checkpointReject', { sessionId: 's', taskId: 't' }, { reason: 'no' })).toEqual({
      ok: true,
      request: { method: 'POST', path: '/api/plans/s/tasks/t/checkpoint/reject', body: '{"reason":"no"}' },
    });
    const paths = (['plans.isolationDiscard', 'plans.isolationCleanup', 'plans.isolationStash', 'plans.isolationRunWithout'] as const)
      .map((id) => { const built = buildRequest(id, { sessionId: 's' }); return built.ok ? built.request.path : built.error; });
    expect(paths).toEqual([
      '/api/plans/s/isolation/discard',
      '/api/plans/s/isolation/cleanup',
      '/api/plans/s/isolation/stash-and-continue',
      '/api/plans/s/isolation/run-without',
    ]);
  });

  it('marks a planner turn, which main waits on with no idle bound, and nothing else', () => {
    const built = buildRequest('plans.converseMessage', { sessionId: 's' }, { message: 'hi' });
    expect(built).toEqual({ ok: true, request: { method: 'POST', path: '/api/plans/s/converse/message', body: '{"message":"hi"}', turn: true } });
    const stop = buildRequest('plans.stop', { sessionId: 's' });
    expect(stop.ok && stop.request.turn).toBeFalsy();
  });

  it('builds a route with no params at all', () => {
    expect(buildRequest('server.info', undefined)).toEqual({ ok: true, request: { method: 'GET', path: '/api/server' } });
  });

  it('refuses a route that is not in the table', () => {
    expect(refused(buildRequest('admin.shutdown', {}))).toContain('unknown route');
    expect(refused(buildRequest('/api/sessions', {}))).toContain('unknown route');
    expect(refused(buildRequest(undefined, {}))).toContain('unknown route');
  });

  it('refuses a segment that would climb or split the path', () => {
    for (const id of ['..', '.', '', 'a/b', 'a\\b', '../../admin']) {
      expect(refused(buildRequest('sessions.get', { id })), id).toMatch(/sessions\.get: id/);
    }
  });

  it('refuses a control character in a segment', () => {
    expect(refused(buildRequest('sessions.get', { id: 'a\r\nHost: evil' }))).toContain('control character');
    expect(refused(buildRequest('sessions.get', { id: 'a\u0000' }))).toContain('control character');
  });

  it('refuses a missing path parameter', () => {
    expect(refused(buildRequest('plans.stop', {}))).toBe('plans.stop: sessionId is missing');
  });

  it('refuses a param the route does not read', () => {
    expect(refused(buildRequest('sessions.list', { workspace: '/w', admin: '1' }))).toBe('sessions.list: unknown param admin');
    expect(refused(buildRequest('plans.stop', { sessionId: 's', workspace: '/w' }))).toBe('plans.stop: unknown param workspace');
  });

  it('refuses a param that is not a string', () => {
    expect(refused(buildRequest('sessions.get', { id: 7 }))).toContain('is not a string');
    expect(refused(buildRequest('sessions.list', { workspace: ['/a', '/b'] }))).toContain('is not a string');
  });

  it('refuses params that are not an object', () => {
    expect(refused(buildRequest('sessions.list', 'workspace=/w'))).toContain('params must be an object');
    expect(refused(buildRequest('sessions.list', ['/w']))).toContain('params must be an object');
    expect(refused(buildRequest('sessions.list', null))).toContain('params must be an object');
  });

  it('refuses a body on a GET', () => {
    expect(refused(buildRequest('sessions.list', { workspace: '/w' }, { x: 1 }))).toContain('a GET carries no body');
  });

  it('refuses a body that is not JSON', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(refused(buildRequest('plans.addTask', { sessionId: 's' }, cyclic))).toContain('not JSON');
    expect(refused(buildRequest('plans.addTask', { sessionId: 's' }, 10n))).toContain('not JSON');
  });

  it('never lets a param name a header or method', () => {
    expect(refused(buildRequest('sessions.list', { workspace: '/w', method: 'DELETE' }))).toContain('unknown param method');
    expect(refused(buildRequest('sessions.list', { workspace: '/w', Authorization: 'x' }))).toContain('unknown param Authorization');
  });
});

describe('segmentError', () => {
  it('passes an ordinary id', () => {
    expect(segmentError('2026-11-03_abc')).toBeUndefined();
  });
});

describe('stream paths', () => {
  it('builds a session socket path from a checked id', () => {
    expect(sessionStreamPath('s 1')).toEqual({ ok: true, request: { method: 'GET', path: '/ws/session/s%201' } });
    expect(sessionStreamPath('..')).toEqual({ ok: false, error: 'sessionId is not a path segment' });
    expect(sessionStreamPath(undefined)).toEqual({ ok: false, error: 'sessionId is not a string' });
  });

  it('builds a child socket path, checking both ids', () => {
    expect(childStreamPath('root', 'child')).toEqual({ ok: true, request: { method: 'GET', path: '/ws/session/root/child/child' } });
    expect(childStreamPath('a/b', 'c')).toEqual({ ok: false, error: 'rootId is not a single path segment' });
    expect(childStreamPath('a', '..')).toEqual({ ok: false, error: 'childId is not a path segment' });
  });
});

describe('the file routes', () => {
  const at = { workspace: '/w', repo: '.', scope: 'task', sessionId: 's1', taskId: 't3' };

  it('read a tree, a file and a search in a scope, as query parameters', () => {
    expect(buildRequest('files.tree', { ...at, dir: 'src' })).toEqual({
      ok: true,
      request: { method: 'GET', path: '/api/files/tree?workspace=%2Fw&repo=.&scope=task&sessionId=s1&taskId=t3&dir=src' },
    });
    expect(buildRequest('files.content', { workspace: '/w', repo: '.', scope: 'checkout', path: 'a b.ts' })).toEqual({
      ok: true,
      request: { method: 'GET', path: '/api/files/content?workspace=%2Fw&repo=.&scope=checkout&path=a+b.ts' },
    });
    expect(buildRequest('files.find', { workspace: '/w', repo: '.', scope: 'checkout', query: 'x', text: '1', limit: '100' })).toEqual({
      ok: true,
      request: { method: 'GET', path: '/api/files/find?workspace=%2Fw&repo=.&scope=checkout&query=x&text=1&limit=100' },
    });
  });

  it('save with a PUT whose body names the file, and nothing in the query', () => {
    const body = { workspace: '/w', repo: '.', path: 'a.ts', text: 'x', baseHash: 'h1' };
    expect(buildRequest('files.save', {}, body)).toEqual({
      ok: true,
      request: { method: 'PUT', path: '/api/files/content', body: JSON.stringify(body) },
    });
    expect(refused(buildRequest('files.save', { path: 'a.ts' }, body))).toContain('unknown param path');
  });

  it('refuse a param a read route does not take, and a body on a read', () => {
    expect(refused(buildRequest('files.tree', { ...at, dir: '', root: '/etc' }))).toContain('unknown param root');
    expect(refused(buildRequest('files.content', at, {}))).toContain('no body');
  });

  it('list the repositories of a workspace', () => {
    expect(buildRequest('git.repos', { workspace: '/w' })).toEqual({ ok: true, request: { method: 'GET', path: '/api/git/repos?workspace=%2Fw' } });
  });
});

describe('the Changes view routes', () => {
  it('read a task diff and the merge preflight from the saved run', () => {
    expect(buildRequest('plans.taskDiff', { sessionId: 's1', taskId: 't3', workspace: '/w', repo: '.', path: 'a.ts' })).toEqual({
      ok: true,
      request: { method: 'GET', path: '/api/plans/s1/tasks/t3/diff?workspace=%2Fw&repo=.&path=a.ts' },
    });
    expect(buildRequest('plans.mergePreflight', { sessionId: 's1', workspace: '/w' })).toEqual({
      ok: true,
      request: { method: 'GET', path: '/api/plans/s1/isolation/merge-preflight?workspace=%2Fw' },
    });
  });

  it('read a scope diff and stash with a body, never a query', () => {
    expect(buildRequest('git.diff', { workspace: '/w', repo: '.', scope: 'integration', sessionId: 's1', path: 'a.ts' })).toEqual({
      ok: true,
      request: { method: 'GET', path: '/api/git/diff?workspace=%2Fw&repo=.&scope=integration&sessionId=s1&path=a.ts' },
    });
    const body = { workspace: '/w', repo: '.', paths: ['a.ts'], message: 'm' };
    expect(buildRequest('git.stash', {}, body)).toEqual({ ok: true, request: { method: 'POST', path: '/api/git/stash', body: JSON.stringify(body) } });
    expect(refused(buildRequest('git.stashPop', { stash: 'abc' }, {}))).toContain('unknown param stash');
  });
});

describe('the Git view routes', () => {
  it('page the history by ref and cursor, and read one commit and one of its files', () => {
    expect(buildRequest('git.log', { workspace: '/w', repo: 'web', ref: 'feature/x', cursor: 'abc', limit: '100' })).toEqual({
      ok: true,
      request: { method: 'GET', path: '/api/git/log?workspace=%2Fw&repo=web&ref=feature%2Fx&cursor=abc&limit=100' },
    });
    expect(buildRequest('git.show', { workspace: '/w', repo: '.', sha: 'abc123', path: 'a b.ts' })).toEqual({
      ok: true,
      request: { method: 'GET', path: '/api/git/commit?workspace=%2Fw&repo=.&sha=abc123&path=a+b.ts' },
    });
  });

  it('send every action as a body, which names the repository and the confirmed target', () => {
    for (const route of ['git.branch', 'git.switch', 'git.branchDelete', 'git.stashDrop', 'git.fetch', 'git.pull', 'git.push'] as const) {
      expect(ROUTES[route].method, route).toBe('POST');
    }
    const body = { workspace: '/w', repo: '.', branch: 'old', confirm: { branch: 'old', unmerged: false } };
    expect(buildRequest('git.branchDelete', {}, body)).toEqual({ ok: true, request: { method: 'POST', path: '/api/git/branch-delete', body: JSON.stringify(body) } });
    expect(refused(buildRequest('git.pull', { branch: 'main' }, {}))).toContain('unknown param branch');
  });
});

describe('the checkout group routes', () => {
  it('read the checkout status, with the repo and scope in the query', () => {
    expect(buildRequest('git.status', { workspace: '/w', repo: 'web', scope: 'checkout' })).toEqual({
      ok: true,
      request: { method: 'GET', path: '/api/git/status?workspace=%2Fw&repo=web&scope=checkout' },
    });
    expect(refused(buildRequest('git.status', { workspace: '/w', path: 'a.ts' }))).toContain('unknown param path');
  });

  it('send stage, unstage, commit and discard as bodies so nothing enters the URL', () => {
    const stage = { workspace: '/w', repo: '.', paths: ['a.ts'] };
    expect(buildRequest('git.stage', {}, stage)).toEqual({ ok: true, request: { method: 'POST', path: '/api/git/stage', body: JSON.stringify(stage) } });
    const hunks = { workspace: '/w', repo: '.', hunks: '@@ -1 +1 @@\n-a\n+b\n' };
    expect(buildRequest('git.unstage', {}, hunks)).toEqual({ ok: true, request: { method: 'POST', path: '/api/git/unstage', body: JSON.stringify(hunks) } });
    const commit = { workspace: '/w', repo: '.', message: 'Fix it', amend: true, confirm: { head: 'abc' } };
    expect(buildRequest('git.commit', {}, commit)).toEqual({ ok: true, request: { method: 'POST', path: '/api/git/commit', body: JSON.stringify(commit) } });
    const discard = { workspace: '/w', repo: '.', paths: ['a.ts'], confirm: { files: ['a.ts'] } };
    expect(buildRequest('git.discard', {}, discard)).toEqual({ ok: true, request: { method: 'POST', path: '/api/git/discard', body: JSON.stringify(discard) } });
  });
});
