import { describe, it, expect, vi } from 'vitest';
import http from 'http';
import { ApiClient } from '../../apiClient';
import { handleRevert } from '../revert';

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
    if (!match) throw e;
    exitCode = parseInt(match[1], 10);
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { stdout: logs.join('\n'), stderr: errs.join('\n'), exitCode };
}

const preview = {
  revertible: true,
  tasks: [
    { taskId: 't2', order: 2, title: 'Wire it up', repos: ['.'], dependent: true },
    { taskId: 't1', order: 1, title: 'Parse JSON', repos: ['.'], dependent: false },
  ],
};

async function daemon(previewBody: unknown, hits: string[]) {
  return startServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      hits.push(`${req.method} ${req.url} ${Buffer.concat(chunks).toString('utf8')}`.trim());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.method === 'GET' ? previewBody : { ok: true, message: 'Reverted task #1 and #2.' }));
    });
  });
}

describe('ordewell revert (ADR-0054)', () => {
  it('lists what goes with the task, asks, and sends the yes with the ids it showed', async () => {
    const hits: string[] = [];
    const srv = await daemon(preview, hits);
    const confirm = vi.fn().mockResolvedValue(true);

    const { stdout } = await capture(() => handleRevert(['--session-id', 'session-1', '1'], new ApiClient(srv.port), confirm));

    expect(stdout.indexOf('#2 Wire it up (goes with it)')).toBeGreaterThanOrEqual(0);
    expect(stdout.indexOf('#2 Wire it up')).toBeLessThan(stdout.indexOf('#1 Parse JSON'));
    expect(stdout).toContain('Reverted task #1 and #2.');
    expect(hits).toEqual([
      'GET /api/plans/session-1/tasks/1/revert-preview',
      'POST /api/plans/session-1/execute-command {"command":"revert_task","task":"1","confirmed":true,"seen":["t2","t1"]}',
    ]);
    srv.close();
  });

  it('sends nothing when declined', async () => {
    const hits: string[] = [];
    const srv = await daemon(preview, hits);

    const { stderr, exitCode } = await capture(() => handleRevert(['--session-id', 'session-1', '1'], new ApiClient(srv.port), vi.fn().mockResolvedValue(false)));

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Nothing was changed');
    expect(hits.filter((h) => h.startsWith('POST'))).toEqual([]);
    srv.close();
  });

  it('skips the question with --yes, and still reads the preview', async () => {
    const hits: string[] = [];
    const srv = await daemon(preview, hits);
    const confirm = vi.fn();

    await capture(() => handleRevert(['--session-id', 'session-1', '1', '--yes'], new ApiClient(srv.port), confirm));

    expect(confirm).not.toHaveBeenCalled();
    expect(hits).toHaveLength(2);
    srv.close();
  });

  it('shows a refusal in core\'s words, with the exact command for work already merged, and asks nothing', async () => {
    const hits: string[] = [];
    const message = 'This work is already merged into your branch, which Ordewell never writes to. To undo it there, run this: git revert -m 1 abc1234';
    const srv = await daemon({ revertible: false, reason: 'in-branch', message, commands: [] }, hits);
    const confirm = vi.fn();

    const { stderr, exitCode } = await capture(() => handleRevert(['--session-id', 'session-1', '1', '--yes'], new ApiClient(srv.port), confirm));

    expect(stderr).toContain(message);
    expect(exitCode).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(hits.filter((h) => h.startsWith('POST'))).toEqual([]);
    srv.close();
  });
});
