import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'http';
import { ApiClient } from '../../apiClient';

const saved: unknown[][] = [];

vi.mock('../../utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils')>()),
  saveLastSession: (...args: unknown[]) => { saved.push(args); },
  readLastSession: () => null,
}));

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

async function capture(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => { logs.push(m); });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((m: string) => { errs.push(m); });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => { throw new Error(`exit:${_code}`); }) as never);
  let exitCode: number | null = null;
  try {
    await fn();
  } catch (e: unknown) {
    const match = ((e as Error).message || '').match(/^exit:(\d+)$/);
    if (match) exitCode = parseInt(match[1], 10);
    else throw e;
  }
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
  return { stdout: logs.join('\n'), stderr: errs.join('\n'), exitCode };
}

const META = { id: 'session-42', goal: 'refactor the parser', runners: ['claude-code'], taskCount: 4, status: 'completed', createdAt: '2026-07-01T10:00:00.000Z', updatedAt: '2026-07-01T11:00:00.000Z' };

async function sessionsServer(hits: string[]) {
  return startServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.method === 'DELETE') return res.end(JSON.stringify({ ok: true }));
    if ((req.url || '').includes('/load')) {
      return res.end(JSON.stringify({ ok: true, plan: { tasks: [] }, goal: META.goal }));
    }
    if (/\/api\/sessions\/[^?]/.test(req.url || '')) {
      return res.end(JSON.stringify({ meta: META, plan: { tasks: [] } }));
    }
    res.end(JSON.stringify([META]));
  });
}

beforeEach(() => { saved.length = 0; });

describe('handleSessions', () => {
  it('lists sessions from the sessionStore-backed endpoint', async () => {
    const hits: string[] = [];
    const srv = await sessionsServer(hits);
    const { handleSessions } = await import('../sessions');
    const { stdout } = await capture(() =>
      handleSessions(['list', '--workspace', '/tmp/ws'], new ApiClient(srv.port)),
    );
    expect(hits[0]).toContain('workspace=%2Ftmp%2Fws');
    expect(stdout).toContain('session-42');
    expect(stdout).toContain('refactor the parser');
    srv.close();
  });

  it('defaults to list with no action', async () => {
    const srv = await sessionsServer([]);
    const { handleSessions } = await import('../sessions');
    const { stdout } = await capture(() => handleSessions([], new ApiClient(srv.port)));
    expect(stdout).toContain('session-42');
    srv.close();
  });

  it('emits JSON with --json', async () => {
    const srv = await sessionsServer([]);
    const { handleSessions } = await import('../sessions');
    const { stdout } = await capture(() => handleSessions(['list', '--json'], new ApiClient(srv.port)));
    expect(JSON.parse(stdout)).toEqual([META]);
    srv.close();
  });

  it('load repoints the last-session marker', async () => {
    const srv = await sessionsServer([]);
    const { handleSessions } = await import('../sessions');
    const { stdout } = await capture(() =>
      handleSessions(['load', 'session-42', '--workspace', '/tmp/ws'], new ApiClient(srv.port)),
    );
    expect(saved).toEqual([['session-42', 'refactor the parser', ['claude-code'], '/tmp/ws']]);
    expect(stdout).toContain('Loaded session session-42');
    srv.close();
  });

  // Repointing the marker is not enough: the daemon only executes sessions it
  // holds in memory, so `sessions load` + `run` used to fail with 404.
  it('load adopts the session on the server so `run` can reach it', async () => {
    const hits: string[] = [];
    const srv = await sessionsServer(hits);
    const { handleSessions } = await import('../sessions');
    await capture(() =>
      handleSessions(['load', 'session-42', '--workspace', '/tmp/ws'], new ApiClient(srv.port)),
    );
    expect(hits.some((h) => h.startsWith('POST /api/sessions/session-42/load'))).toBe(true);
    srv.close();
  });

  it('load reports a session the server cannot adopt', async () => {
    const srv = await startServer((req, res) => {
      if ((req.url || '').includes('/load')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Session not found' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ meta: META, plan: { tasks: [] } }));
    });
    const { handleSessions } = await import('../sessions');
    const { stderr, exitCode } = await capture(() =>
      handleSessions(['load', 'session-42'], new ApiClient(srv.port)),
    );
    expect(stderr).toContain('Session not found');
    expect(exitCode).toBe(1);
    expect(saved).toEqual([]);
    srv.close();
  });

  it('delete removes the session', async () => {
    const hits: string[] = [];
    const srv = await sessionsServer(hits);
    const { handleSessions } = await import('../sessions');
    const { stdout } = await capture(() =>
      handleSessions(['delete', 'session-42'], new ApiClient(srv.port)),
    );
    expect(hits[0]).toContain('DELETE /api/sessions/session-42');
    expect(stdout).toContain('Deleted session session-42');
    srv.close();
  });

  it('rejects an unknown action', async () => {
    const srv = await sessionsServer([]);
    const { handleSessions } = await import('../sessions');
    const { stderr, exitCode } = await capture(() =>
      handleSessions(['frobnicate'], new ApiClient(srv.port)),
    );
    expect(stderr).toContain('Unknown sessions action');
    expect(exitCode).toBe(1);
    srv.close();
  });
});
