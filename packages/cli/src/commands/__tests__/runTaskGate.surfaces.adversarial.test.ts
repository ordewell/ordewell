import { describe, expect, it, vi } from 'vitest';
import http from 'http';
import { ApiClient } from '../../apiClient';
import { wireRoute } from '../../__tests__/wireRoute';

/**
 * Adversarial: a start the user confirmed past a merge gate has to reach the
 * command that passes it. The seam's `run_task` refuses a gated task ("Merge
 * all to start it, or force start it") — only a force start goes past the
 * gate (ADR-0020) — and VS Code's Run task converts to a force start once the
 * user confirms (PlanManager `handleSystemCommand('runTask')`), as the TUI's
 * `f` does. The CLI asks the same question and sends the force start the
 * confirmation stands for.
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

/** A daemon holding one ops task whose ancestor's work is landed but not merged. */
function gatedServer(hits: string[]) {
  return startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (wireRoute(req.url).endsWith('/merge-gate')) {
      res.end(JSON.stringify({ mergeGate: [{ id: 'fix-1', order: 1, title: 'Fix' }] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const sent = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { command: string; task: string };
      hits.push(`${sent.command} ${sent.task}`);
      res.end(JSON.stringify({ ok: true, message: 'Started task #2 "Deploy".' }));
    });
  });
}

describe('adversarial: a run-task confirmed past its merge gate', () => {
  it('starts through force-start once the user confirmed the work it would act without', async () => {
    const hits: string[] = [];
    const srv = await gatedServer(hits);
    const { handleRunTask } = await import('../task-control');
    const asked: string[] = [];

    await capture(() => handleRunTask(['--session-id', 'session-1', '2'], new ApiClient(srv.port), async (q) => { asked.push(q); return true; }));

    expect(asked).toEqual([expect.stringContaining('not merged into your branch yet')]);
    expect(hits).toEqual(['force_start 2']);
    srv.close();
  });
});
