import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'http';
import { resolve } from 'path';
import { ApiClient } from '../../apiClient';
import { handleSessions } from '../sessions';
import { handleStatus } from '../status';
import { handlePlan } from '../plan';
import { handleRun } from '../run';
import { adopted } from '../conversation';
import { handleAddTask } from '../add-task';
import { withResolvedTask } from '../task-control';

// The daemon keeps the cwd of whichever command first started it, so a path
// the CLI sends unresolved lands in a directory the user never named.
const RELATIVE = 'some-relative-workspace';

type Hit = { method: string; url: string; body: unknown };

function startServer(hits: Hit[]): Promise<{ port: number; close: () => void }> {
  return new Promise((done) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const url = req.url || '';
        hits.push({ method: req.method || '', url, body: raw ? JSON.parse(raw) : undefined });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (url.includes('/api/runners')) return res.end(JSON.stringify({ runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true }], headless: false, orchestratorModel: 'x' }));
        if (url.includes('/generate')) return res.end(JSON.stringify({ plan: { tasks: [{ id: 't1', order: 1, title: 'Do', type: 'ai' }], runners: ['claude-code'] } }));
        if (url.includes('/load')) return res.end(JSON.stringify({ ok: true, plan: { tasks: [] }, goal: 'g' }));
        if (/\/api\/sessions\/[^/?]+(\?|$)/.test(url)) return res.end(JSON.stringify({ meta: { id: 's1', goal: 'g', runners: [], taskCount: 0, status: 'planned', createdAt: '', updatedAt: '' }, plan: { tasks: [{ id: 't1', order: 1, title: 'Do', type: 'ai', status: 'pending' }] } }));
        if (url.includes('/api/sessions')) return res.end('[]');
        res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      done({ port: typeof addr === 'object' && addr ? addr.port : 0, close: () => server.close() });
    });
  });
}

const workspaceOfHit = (hit: Hit): unknown => {
  const query = new URL(hit.url, 'http://x').searchParams.get('workspace');
  return query ?? (hit.body as { workspace?: string } | undefined)?.workspace;
};

async function sentWorkspaces(drive: (api: ApiClient) => Promise<unknown>): Promise<unknown[]> {
  const hits: Hit[] = [];
  const srv = await startServer(hits);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
  try {
    // Built as production builds it: for the resolved workspace, so what is
    // under test is the argument a command adds on top of it.
    await drive(new ApiClient(srv.port, resolve(RELATIVE))).catch(() => {});
  } finally {
    srv.close();
  }
  return hits.filter((h) => !h.url.startsWith('/ws/')).map(workspaceOfHit).filter((workspace) => workspace !== undefined);
}

afterEach(() => { vi.restoreAllMocks(); });

describe('a relative --workspace', () => {
  const absolute = resolve(RELATIVE);
  const args = (...rest: string[]) => [...rest, '--workspace', RELATIVE];

  it.each([
    ['sessions list', (api: ApiClient) => handleSessions(args('list'), api)],
    ['status', (api: ApiClient) => handleStatus(args(), api)],
    ['status --session-id', (api: ApiClient) => handleStatus(args('--session-id', 's1'), api)],
    ['plan --no-chat', (api: ApiClient) => handlePlan(args('--goal', 'x', '--no-chat'), { api })],
    ['run', (api: ApiClient) => handleRun(args('--session-id', 's1'), api)],
    ['rewind (adoption)', (api: ApiClient) => adopted(args('--session-id', 's1'), api)],
    ['add-task', (api: ApiClient) => handleAddTask(args('--title', 't', '--session-id', 's1', '--depends-on', '1'), api)],
    ['task edits', (api: ApiClient) => withResolvedTask(args('1', '--session-id', 's1'), 'usage', api, async () => {})],
  ])('reaches the daemon absolute from %s', async (_name, drive) => {
    const sent = await sentWorkspaces(drive);
    expect(sent.length).toBeGreaterThan(0);
    for (const workspace of sent) expect(workspace).toBe(absolute);
  });
});
