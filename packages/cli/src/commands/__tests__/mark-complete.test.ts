import { describe, it, expect, vi } from 'vitest';
import http from 'http';
import { ApiClient } from '../../apiClient';

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
    const m = (e as Error).message || '';
    const match = m.match(/^exit:(\d+)$/);
    if (match) exitCode = parseInt(match[1], 10);
    else throw e;
  }
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
  return { stdout: logs.join('\n'), stderr: errs.join('\n'), exitCode };
}

describe('handleMarkComplete', () => {
  it('resolves by order number and marks the task complete', async () => {
    const srv = await startServer((req, res) => {
      if (req.url?.includes('/sessions/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          meta: { id: 'session-1', goal: 'test', runners: ['claude-code'], taskCount: 2, status: 'running', createdAt: '', updatedAt: '' },
          plan: { pendingTasks: [{ id: 'task-abc', order: 2, title: 'Second', status: 'pending' }] },
        }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
    const api = new ApiClient(srv.port);
    const { handleMarkComplete } = await import('../mark-complete');
    const { stdout } = await capture(() => handleMarkComplete(['--session-id', 'session-1', '2'], api));
    expect(stdout).toContain('Task marked complete.');
    srv.close();
  });

  it('resolves by task ID prefix and marks the task complete', async () => {
    const srv = await startServer((req, res) => {
      if (req.url?.includes('/sessions/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          meta: { id: 'session-1', goal: 'test', runners: ['claude-code'], taskCount: 1, status: 'running', createdAt: '', updatedAt: '' },
          plan: { pendingTasks: [{ id: 'task-abc-123', order: 1, title: 'First', status: 'pending' }] },
        }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
    const api = new ApiClient(srv.port);
    const { handleMarkComplete } = await import('../mark-complete');
    const { stdout } = await capture(() => handleMarkComplete(['--session-id', 'session-1', 'task-abc'], api));
    expect(stdout).toContain('Task marked complete.');
    srv.close();
  });

  it('errors when task identifier cannot be resolved', async () => {
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        meta: { id: 'session-1', goal: 'test', runners: ['claude-code'], taskCount: 0, status: 'running', createdAt: '', updatedAt: '' },
        plan: { pendingTasks: [] },
      }));
    });
    const api = new ApiClient(srv.port);
    const { handleMarkComplete } = await import('../mark-complete');
    const { stderr, exitCode } = await capture(() => handleMarkComplete(['--session-id', 'session-1', '99'], api));
    expect(stderr).toContain('Task not found');
    expect(exitCode).toBe(1);
    srv.close();
  });
});
