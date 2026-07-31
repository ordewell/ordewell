import { describe, it, expect, vi } from 'vitest';
import http from 'http';
import { readFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ApiClient } from '../../apiClient';

vi.mock('../../utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils')>()),
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

async function capture(fn: () => Promise<void>): Promise<{ stdout: string }> {
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => { logs.push(m); });
  await fn();
  logSpy.mockRestore();
  return { stdout: logs.join('\n') };
}

const SESSION = {
  meta: { id: 'session-1', goal: 'export me', runners: ['claude-code'], taskCount: 1, status: 'completed', createdAt: '', updatedAt: '' },
  plan: { pendingTasks: [{ id: 't1', order: 1, title: 'One', status: 'completed' }] },
};

describe('handleStatus --output', () => {
  it('writes the session JSON to a file and implies --json', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(SESSION));
    });
    const out = join(mkdtempSync(join(tmpdir(), 'ordewell-status-')), 'plan.json');
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() =>
      handleStatus(['--session-id', 'session-1', '--output', out], new ApiClient(srv.port)),
    );

    expect(stdout).toContain(`Wrote ${out}`);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(SESSION);
    srv.close();
  });

  it('still prints JSON to stdout without --output', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(SESSION));
    });
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() =>
      handleStatus(['--session-id', 'session-1', '--json'], new ApiClient(srv.port)),
    );
    expect(JSON.parse(stdout)).toEqual(SESSION);
    srv.close();
  });
});
