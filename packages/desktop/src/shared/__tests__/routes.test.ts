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
