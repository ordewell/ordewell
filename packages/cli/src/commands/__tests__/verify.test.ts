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

describe('handleVerify', () => {
  it('on sends the verify command and prints ON from the verification setting', async () => {
    let requestedPath = '';
    const srv = await startServer((req, res) => {
      requestedPath = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, settings: { verification: { enabled: true } } }));
    });
    const api = new ApiClient(srv.port);
    const { handleVerify } = await import('../verify');
    const { stdout } = await capture(() => handleVerify(['on'], api));
    expect(requestedPath).toContain('verify');
    expect(stdout).toContain('ON');
    srv.close();
  });

  it('off prints OFF', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, settings: { verification: { enabled: false } } }));
    });
    const api = new ApiClient(srv.port);
    const { handleVerify } = await import('../verify');
    const { stdout } = await capture(() => handleVerify(['off'], api));
    expect(stdout).toContain('OFF');
    srv.close();
  });

  it('no args shows status from getSettings and usage', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ verification: { enabled: true } }));
    });
    const api = new ApiClient(srv.port);
    const { handleVerify } = await import('../verify');
    const { stdout } = await capture(() => handleVerify([], api));
    expect(stdout).toContain('ON');
    expect(stdout).toContain('Usage');
    srv.close();
  });
});
