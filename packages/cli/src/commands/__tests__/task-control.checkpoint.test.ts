import { describe, it, expect, vi } from 'vitest';
import http from 'http';
import { ApiClient } from '../../apiClient';
import { wireRoute } from '../../__tests__/wireRoute';

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ port: typeof addr === 'object' && addr ? addr.port : 0, close: () => server.close() });
    });
  });
}

async function capture(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => { logs.push(m); });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((m: string) => { errs.push(m); });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
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

const PLAN = {
  meta: { id: 'session-1', goal: 'test', runners: ['claude-code'], taskCount: 1, status: 'running', createdAt: '', updatedAt: '' },
  plan: { pendingTasks: [{ id: 'task-abc-123', order: 3, title: 'Third', status: 'awaiting_user' }] },
};

/** A daemon that answers the checkpoint routes with `status`, recording what it was sent. */
async function daemon(status = 200, body: unknown = { ok: true }) {
  const hits: string[] = [];
  const srv = await startServer((req, res) => {
    let sent = '';
    req.on('data', (chunk) => { sent += String(chunk); });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (wireRoute(req.url).includes('/sessions/')) return res.end(JSON.stringify(PLAN));
      hits.push(`${req.method} ${wireRoute(req.url)} ${sent}`.trim());
      res.statusCode = status;
      res.end(JSON.stringify(body));
    });
  });
  return { srv, hits, api: new ApiClient(srv.port) };
}

describe('ordewell checkpoint', () => {
  it('approves a task\'s checkpoint, by order number', async () => {
    const { srv, hits, api } = await daemon();
    const { handleCheckpoint } = await import('../task-control');
    const { stdout } = await capture(() => handleCheckpoint(['--session-id', 'session-1', '3', 'approve'], api));
    expect(hits).toEqual(['POST /api/plans/session-1/tasks/3/checkpoint/approve']);
    expect(stdout).toContain('Checkpoint approved.');
    srv.close();
  });

  it('sends a raise with an approval, for a delegated task\'s child', async () => {
    const { srv, hits, api } = await daemon();
    const { handleCheckpoint } = await import('../task-control');
    await capture(() => handleCheckpoint(['--session-id', 'session-1', '3', 'approve', '--raise', '800000'], api));
    expect(hits).toEqual(['POST /api/plans/session-1/tasks/3/checkpoint/approve {"raiseTokens":800000}']);
    srv.close();
  });

  it('sends the words of --answer with an approval, for a delegated task\'s answer', async () => {
    const { srv, hits, api } = await daemon();
    const { handleCheckpoint } = await import('../task-control');
    await capture(() => handleCheckpoint(['--session-id', 'session-1', '3', 'approve', '--answer', 'Half away from zero.'], api));
    expect(hits).toEqual(['POST /api/plans/session-1/tasks/3/checkpoint/approve {"reason":"Half away from zero."}']);
    srv.close();
  });

  it('refuses a raise that is not a whole number, and one that goes with a rejection', async () => {
    const { srv, hits, api } = await daemon();
    const { handleCheckpoint } = await import('../task-control');
    const notANumber = await capture(() => handleCheckpoint(['--session-id', 'session-1', '3', 'approve', '--raise', 'lots'], api));
    const onReject = await capture(() => handleCheckpoint(['--session-id', 'session-1', '3', 'reject', '--raise', '5', 'no'], api));
    const wordsOnReject = await capture(() => handleCheckpoint(['--session-id', 'session-1', '3', 'reject', '--answer', 'Half up.', 'no'], api));
    expect(notANumber.exitCode).toBe(1);
    expect(onReject.exitCode).toBe(1);
    expect(wordsOnReject.exitCode).toBe(1);
    expect(hits).toEqual([]);
    srv.close();
  });

  it('rejects with the rest of the line as the reason', async () => {
    const { srv, hits, api } = await daemon();
    const { handleCheckpoint } = await import('../task-control');
    const { stdout } = await capture(() => handleCheckpoint(['--session-id', 'session-1', '3', 'reject', 'keep', 'the', 'table'], api));
    expect(hits).toEqual(['POST /api/plans/session-1/tasks/3/checkpoint/reject {"reason":"keep the table"}']);
    expect(stdout).toContain('Checkpoint rejected.');
    srv.close();
  });

  it('rejects without a reason when none is given', async () => {
    const { srv, hits, api } = await daemon();
    const { handleCheckpoint } = await import('../task-control');
    await capture(() => handleCheckpoint(['--session-id', 'session-1', '3', 'reject'], api));
    expect(hits).toEqual(['POST /api/plans/session-1/tasks/3/checkpoint/reject {}']);
    srv.close();
  });

  it('refuses an approval that carries a note, sending nothing', async () => {
    const { srv, hits, api } = await daemon();
    const { handleCheckpoint } = await import('../task-control');
    const { stderr, exitCode } = await capture(() => handleCheckpoint(['--session-id', 'session-1', '3', 'approve', 'go', 'ahead'], api));
    expect(stderr).toContain('Approving takes no note');
    expect(exitCode).toBe(1);
    expect(hits).toEqual([]);
    srv.close();
  });

  it.each([[['3']], [['3', 'maybe']], [[]]])('prints its usage for %j', async (args) => {
    const { handleCheckpoint } = await import('../task-control');
    const { stderr, exitCode } = await capture(() => handleCheckpoint(['--session-id', 'session-1', ...args]));
    expect(stderr).toContain('Usage: ordewell checkpoint <task-id-or-order> approve|reject [reason]');
    expect(exitCode).toBe(1);
  });

  it('reports the daemon\'s refusal when nothing waits', async () => {
    const { srv, api } = await daemon(409, { error: 'The task is not waiting at a checkpoint — it was answered already.' });
    const { handleCheckpoint } = await import('../task-control');
    const { stderr, exitCode } = await capture(() => handleCheckpoint(['--session-id', 'session-1', '3', 'approve'], api));
    expect(stderr).toContain('Failed to approve checkpoint: The task is not waiting at a checkpoint');
    expect(exitCode).toBe(1);
    srv.close();
  });
});
