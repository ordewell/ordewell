import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import { ApiClient } from '../apiClient';
import { DaemonRefusal } from '@ordewell/core';

type Seen = { method?: string; url?: string };

function startServer(status: number, body: unknown): Promise<{ port: number; seen: Seen; close: () => void }> {
  const seen: Seen = {};
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      seen.method = req.method;
      seen.url = req.url;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, seen, close: () => server.close() });
    });
  });
}

/** The user's reads of files and git (ADR-0064): each method's route and query, and a refusal's code. */
describe('ApiClient workspace reads', () => {
  const servers: Array<{ close: () => void }> = [];
  afterEach(() => { servers.splice(0).forEach((s) => s.close()); });

  async function client(status: number, body: unknown) {
    const srv = await startServer(status, body);
    servers.push(srv);
    return { api: new ApiClient(srv.port, '/ws a'), seen: srv.seen };
  }

  const WS = 'workspace=%2Fws%20a';

  it.each<[string, (api: ApiClient) => Promise<unknown>, string]>([
    ['the tree of a directory', (api) => api.getFileTree({ repo: 'api' }, 'src'), `/api/files/tree?${WS}&repo=api&dir=src`],
    ['the tree of a task scope', (api) => api.getFileTree({ scope: 'task', sessionId: 's1', taskId: 't 1' }), `/api/files/tree?${WS}&scope=task&sessionId=s1&taskId=t%201&dir=`],
    ['a file', (api) => api.getFileContent({ scope: 'integration', sessionId: 's1' }, 'src/a b.ts'), `/api/files/content?${WS}&scope=integration&sessionId=s1&path=src%2Fa%20b.ts`],
    ['a name search', (api) => api.findFiles({}, { query: 'a' }), `/api/files/find?${WS}&query=a`],
    ['a text search, capped', (api) => api.findFiles({ workspace: '/other' }, { query: 'x&y', text: true, limit: 5 }), '/api/files/find?workspace=%2Fother&query=x%26y&text=1&limit=5'],
    ['the repositories', (api) => api.getGitRepos(), `/api/git/repos?${WS}`],
    ['the status', (api) => api.getGitStatus({ repo: 'web' }), `/api/git/status?${WS}&repo=web`],
    ['a diff', (api) => api.getGitDiff({}, { kind: 'staged', path: 'a.ts' }), `/api/git/diff?${WS}&kind=staged&path=a.ts`],
    ['a diff between two refs', (api) => api.getGitDiff({}, { from: 'main', to: 'HEAD' }), `/api/git/diff?${WS}&from=main&to=HEAD`],
    ['a log page', (api) => api.getGitLog({}, { ref: 'origin/main', cursor: 'abc:50', limit: 50 }), `/api/git/log?${WS}&ref=origin%2Fmain&cursor=abc%3A50&limit=50`],
    ['a commit', (api) => api.getGitCommit({}, 'abc', 'a.ts'), `/api/git/commit?${WS}&sha=abc&path=a.ts`],
    ['the branches', (api) => api.getGitBranches({}), `/api/git/branches?${WS}`],
    ['a task\'s changed names', (api) => api.getTaskDiff('s1', 't 1', { names: true }), `/api/plans/s1/tasks/t%201/diff?${WS}&names=1`],
    ['a task\'s file patch', (api) => api.getTaskDiff('s1', 't1', { repo: 'api', path: 'a.ts' }), `/api/plans/s1/tasks/t1/diff?${WS}&repo=api&path=a.ts`],
  ])('reads %s', async (_what, call, url) => {
    const { api, seen } = await client(200, { ok: 'answer' });
    expect(await call(api)).toEqual({ ok: 'answer' });
    expect([seen.method, seen.url]).toEqual(['GET', url]);
  });

  it('carries a refusal\'s code, so a surface tells gone from refused', async () => {
    const { api } = await client(410, { error: 'The task\'s worktree was pruned.', code: 'gone' });
    const err = await api.getFileTree({ scope: 'task', sessionId: 's1', taskId: 't1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonRefusal);
    expect(err).toMatchObject({ status: 410, code: 'gone', message: 'The task\'s worktree was pruned.' });
  });
});
