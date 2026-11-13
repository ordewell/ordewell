import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import { ApiClient } from '../apiClient';
import { DaemonRefusal } from '@ordewell/core';

type Seen = { method?: string; url?: string; body?: unknown };

function startServer(status: number, body: unknown): Promise<{ port: number; seen: Seen; close: () => void }> {
  const seen: Seen = {};
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
      req.on('end', () => {
        seen.method = req.method;
        seen.url = req.url;
        seen.body = raw ? JSON.parse(raw) : undefined;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, seen, close: () => server.close() });
    });
  });
}

/** The user's git actions on their checkout (ADR-0062): each method's route and body, and a refusal's structured detail. */
describe('ApiClient user git actions', () => {
  const servers: Array<{ close: () => void }> = [];
  afterEach(() => { servers.splice(0).forEach((s) => s.close()); });

  async function client(status: number, body: unknown) {
    const srv = await startServer(status, body);
    servers.push(srv);
    return { api: new ApiClient(srv.port, '/ws a'), seen: srv.seen };
  }

  const WS = { workspace: '/ws a' };

  it.each<[string, (api: ApiClient) => Promise<unknown>, string, string, object]>([
    ['a save', (api) => api.saveFile({ repo: 'api' }, { path: 'a.ts', text: 'x', baseHash: null }), 'PUT', '/api/files/content', { ...WS, repo: 'api', path: 'a.ts', text: 'x', baseHash: null }],
    ['a stage of files', (api) => api.gitStage({}, { paths: ['a.ts'] }), 'POST', '/api/git/stage', { ...WS, paths: ['a.ts'] }],
    ['an unstage of hunks', (api) => api.gitUnstage({}, { hunks: 'diff' }), 'POST', '/api/git/unstage', { ...WS, hunks: 'diff' }],
    ['an amend', (api) => api.gitCommit({}, { message: 'm', amend: true, confirm: { head: 'abc' } }), 'POST', '/api/git/commit', { ...WS, message: 'm', amend: true, confirm: { head: 'abc' } }],
    ['a discard', (api) => api.gitDiscard({}, { paths: ['a.ts'], confirm: { files: ['a.ts'] } }), 'POST', '/api/git/discard', { ...WS, paths: ['a.ts'], confirm: { files: ['a.ts'] } }],
    ['a new branch', (api) => api.gitCreateBranch({}, { name: 'f', switch: true }), 'POST', '/api/git/branch', { ...WS, name: 'f', switch: true }],
    ['a switch', (api) => api.gitSwitch({ workspace: '/other' }, 'f'), 'POST', '/api/git/switch', { workspace: '/other', branch: 'f' }],
    ['a branch delete', (api) => api.gitDeleteBranch({}, 'f', { branch: 'f', unmerged: false }), 'POST', '/api/git/branch-delete', { ...WS, branch: 'f', confirm: { branch: 'f', unmerged: false } }],
    ['a stash of everything', (api) => api.gitStash({}), 'POST', '/api/git/stash', WS],
    ['a stash of paths', (api) => api.gitStash({}, { paths: ['a.ts'], message: 'm' }), 'POST', '/api/git/stash', { ...WS, paths: ['a.ts'], message: 'm' }],
    ['a stash pop', (api) => api.gitStashPop({}, 'abc'), 'POST', '/api/git/stash-pop', { ...WS, stash: 'abc' }],
    ['a stash drop', (api) => api.gitStashDrop({}, 'abc'), 'POST', '/api/git/stash-drop', { ...WS, stash: 'abc' }],
    ['a fetch', (api) => api.gitFetch({}), 'POST', '/api/git/fetch', WS],
    ['a pull', (api) => api.gitPull({}, { remote: 'origin', branch: 'main' }), 'POST', '/api/git/pull', { ...WS, confirm: { remote: 'origin', branch: 'main' } }],
    ['a push', (api) => api.gitPush({}, { remote: 'origin', branch: 'main' }), 'POST', '/api/git/push', { ...WS, confirm: { remote: 'origin', branch: 'main' } }],
  ])('sends %s', async (_what, call, method, url, body) => {
    const { api, seen } = await client(200, { repo: { path: '.' } });
    expect(await call(api)).toEqual({ repo: { path: '.' } });
    expect([seen.method, seen.url, seen.body]).toEqual([method, url, body]);
  });

  it('reads the Merge all preflight of a session', async () => {
    const { api, seen } = await client(200, { runId: 'r1', repos: [], stashMessage: 'm' });
    expect(await api.mergePreflight('s1')).toEqual({ runId: 'r1', repos: [], stashMessage: 'm' });
    expect([seen.method, seen.url]).toEqual(['GET', '/api/plans/s1/isolation/merge-preflight?workspace=%2Fws%20a']);
  });

  it('carries the run that holds the branch, so a surface can name it', async () => {
    const held = { sessionId: 's1', runId: 'r1', repo: '.', branch: 'main' };
    const { api } = await client(409, { error: 'A run lands on main.', code: 'landing_branch_held', landingBranchHeld: held });
    const err = await api.gitSwitch({}, 'f').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonRefusal);
    expect(err).toMatchObject({ status: 409, code: 'landing_branch_held', message: 'A run lands on main.', landingBranchHeld: held });
  });

  it('carries what changed since the person looked', async () => {
    const confirmStale = { field: 'files', shown: ['a.ts'], now: ['a.ts', 'b.ts'] };
    const { api } = await client(409, { error: 'The files changed.', code: 'confirm_stale', confirmStale });
    const err = await api.gitDiscard({}, { paths: ['a.ts'], confirm: { files: ['a.ts'] } }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: 'confirm_stale', confirmStale });
  });
});
