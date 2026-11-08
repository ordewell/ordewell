import { describe, it, expect, vi } from 'vitest';
import http from 'http';
import { ApiClient } from '../../apiClient';
import { wireRoute } from '../../__tests__/wireRoute';

/**
 * Adversarial, round two: the merge gate is confirmed before a start that
 * passes it (ADR-0020) — the TUI's gated force start and VS Code's gated Run
 * task both send `force_start` once the user goes ahead, because the seam's
 * `run_task` refuses a gated task. The CLI's `ordewell run` asks the same
 * question and, once the user goes ahead, sends the force start that passes it.
 */

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

async function capture(fn: () => Promise<void>): Promise<{ stderr: string; exitCode: number | null }> {
  const errs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
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
  return { stderr: errs.join('\n'), exitCode };
}

const PLAN = {
  meta: { id: 'session-1', goal: 'test', runners: ['claude-code'], taskCount: 2, status: 'running', createdAt: '', updatedAt: '' },
  plan: { pendingTasks: [{ id: 'ops-2', order: 2, title: 'Deploy', type: 'ai', ops: true, status: 'pending' }] },
};

async function gatedServer(hits: string[]) {
  return startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (wireRoute(req.url).includes('/sessions/')) return res.end(JSON.stringify(PLAN));
    if (wireRoute(req.url).endsWith('/merge-gate')) return res.end(JSON.stringify({ mergeGate: [{ id: 'fix-1', order: 1, title: 'Fix' }] }));
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const sent = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { command: string; task: string };
      hits.push(`${sent.command} ${sent.task}`);
      res.end(JSON.stringify({ ok: true, message: 'Thing started.' }));
    });
  });
}

describe('adversarial: a gated task confirmed by the user starts, whichever control asked', () => {
  it('sends the confirmed start as a force start, as VS Code\'s gated Run task does', async () => {
    const hits: string[] = [];
    const srv = await gatedServer(hits);
    const { handleRunTask } = await import('../task-control');

    const { stderr, exitCode } = await capture(() =>
      handleRunTask(['--session-id', 'session-1', '2'], new ApiClient(srv.port), async () => true),
    );

    expect(stderr).toBe('');
    expect(exitCode).toBeNull();
    expect(hits).toEqual(['force_start 2']);
    srv.close();
  });
});
