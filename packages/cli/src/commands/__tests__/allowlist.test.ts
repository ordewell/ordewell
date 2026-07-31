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

/**
 * A daemon that answers the catalog probe `set` makes before it writes, plus
 * the PATCH itself. `models` defaults to the ids the happy-path test sets.
 */
function settingsServer(
  seen: unknown[],
  modelsByRunner: Record<string, { modelId: string }[]> = {
    opencode: [{ modelId: 'kimi-2.6' }, { modelId: 'deepseek-v4-pro' }],
  },
  response: unknown = { modelAllowlist: { opencode: ['kimi-2.6', 'deepseek-v4-pro'] }, saved: true },
) {
  return startServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url?.startsWith('/api/models')) {
        res.end(JSON.stringify({ models: Object.values(modelsByRunner).flat(), modelsByRunner }));
        return;
      }
      seen.push({ method: req.method, url: req.url, body: JSON.parse(body) });
      res.end(JSON.stringify(response));
    });
  });
}

describe('handleAllowlist', () => {
  it('set calls PATCH /settings with modelAllowlist for the runner', async () => {
    const seen: unknown[] = [];
    const srv = await settingsServer(seen);
    const api = new ApiClient(srv.port);
    const { handleAllowlist } = await import('../allowlist');
    await handleAllowlist(['set', 'opencode', 'kimi-2.6,deepseek-v4-pro'], api);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      method: 'PATCH',
      url: '/api/settings',
      body: { modelAllowlist: { opencode: ['kimi-2.6', 'deepseek-v4-pro'] } },
    });
    srv.close();
  });

  it('refuses ids discovered for a different runner instead of persisting them', async () => {
    const seen: unknown[] = [];
    const srv = await settingsServer(seen, {
      'claude-code': [{ modelId: 'claude-sonnet-4-5' }],
      opencode: [{ modelId: 'gpt-5.6-sol' }],
    });
    const api = new ApiClient(srv.port);
    const { handleAllowlist } = await import('../allowlist');
    const { stderr, exitCode } = await capture(() =>
      handleAllowlist(['set', 'claude-code', 'claude-sonnet-4-5,gpt-5.6-sol'], api),
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain('gpt-5.6-sol');
    expect(stderr).not.toContain('claude-sonnet-4-5');
    expect(seen).toHaveLength(0);
    srv.close();
  });

  it('writes anyway when the runner has no discovered models to check against', async () => {
    const seen: unknown[] = [];
    const srv = await settingsServer(seen, { opencode: [{ modelId: 'kimi-2.6' }] });
    const api = new ApiClient(srv.port);
    const { handleAllowlist } = await import('../allowlist');
    await handleAllowlist(['set', 'claude-code', 'some-uncatalogued-model'], api);
    expect(seen).toHaveLength(1);
    srv.close();
  });

  it('clear calls PATCH /settings with empty array for the runner', async () => {
    const seen: unknown[] = [];
    const srv = await startServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body: JSON.parse(body) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ modelAllowlist: { opencode: [] }, saved: true }));
      });
    });
    const api = new ApiClient(srv.port);
    const { handleAllowlist } = await import('../allowlist');
    await handleAllowlist(['clear', 'opencode'], api);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      method: 'PATCH',
      url: '/api/settings',
      body: { modelAllowlist: { opencode: [] } },
    });
    srv.close();
  });

  it('show calls GET /settings and prints per-runner allowlists', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        modelAllowlist: { opencode: ['kimi-2.6'], 'claude-code': null },
      }));
    });
    const api = new ApiClient(srv.port);
    const { handleAllowlist } = await import('../allowlist');
    const { stdout } = await capture(() => handleAllowlist(['show'], api));
    expect(stdout).toContain('opencode');
    expect(stdout).toContain('kimi-2.6');
    expect(stdout).toContain('claude-code');
    expect(stdout).toContain('no restriction');
    srv.close();
  });

  it('show <runner> filters to one runner', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        modelAllowlist: { opencode: ['kimi-2.6'], 'claude-code': ['deepseek-v4'] },
      }));
    });
    const api = new ApiClient(srv.port);
    const { handleAllowlist } = await import('../allowlist');
    const { stdout } = await capture(() => handleAllowlist(['show', 'opencode'], api));
    expect(stdout).toContain('opencode');
    expect(stdout).toContain('kimi-2.6');
    expect(stdout).not.toContain('claude-code');
    expect(stdout).not.toContain('deepseek-v4');
    srv.close();
  });

  it('set with missing runner or ids prints usage and exits non-zero', async () => {
    const { handleAllowlist } = await import('../allowlist');
    const { stderr, exitCode } = await capture(() => handleAllowlist(['set'], {} as ApiClient));
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Usage');
  });

  it('set with empty id list prints usage and exits non-zero', async () => {
    const { handleAllowlist } = await import('../allowlist');
    const { stderr, exitCode } = await capture(() => handleAllowlist(['set', 'opencode'], {} as ApiClient));
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Usage');
  });

  it('defaults to show when no subcommand given', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ modelAllowlist: {} }));
    });
    const api = new ApiClient(srv.port);
    const { handleAllowlist } = await import('../allowlist');
    await expect(handleAllowlist([], api)).resolves.toBeUndefined();
    srv.close();
  });
});
