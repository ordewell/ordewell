import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'http';
import { ApiClient } from '../../apiClient';

const saved: unknown[][] = [];

vi.mock('../../utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils')>()),
  saveLastSession: (...args: unknown[]) => { saved.push(args); },
  readLastSession: () => ({ sessionId: 'session-1', goal: 'build me a parser', runners: ['claude-code'], workspace: '/tmp/ws' }),
}));

interface Hit { method: string; url: string; body: string }

function daemon(respond: (hit: Hit) => { status?: number; body: unknown }): Promise<{ port: number; hits: Hit[]; close: () => void }> {
  const hits: Hit[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        const hit = { method: req.method ?? '', url: req.url ?? '', body };
        hits.push(hit);
        const answer = respond(hit);
        res.writeHead(answer.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(answer.body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ port: typeof addr === 'object' && addr ? addr.port : 0, hits, close: () => server.close() });
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
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { stdout: logs.join('\n'), stderr: errs.join('\n'), exitCode };
}

const adopted = { ok: true, plan: { tasks: [] }, goal: 'build me a parser' };

beforeEach(() => { saved.length = 0; });

describe('ordewell fork', () => {
  it('adopts the current session, forks it, and makes the fork the current session', async () => {
    const srv = await daemon(({ url }) => url.includes('/load')
      ? { body: adopted }
      : { body: { sessionId: 'session-fork', goal: 'build me a parser', plan: { tasks: [], runners: ['claude-code'] } } });
    const { handleFork } = await import('../conversation');

    const { stdout, exitCode } = await capture(() => handleFork(['--workspace', '/tmp/ws'], new ApiClient(srv.port)));
    srv.close();

    expect(exitCode).toBeNull();
    expect(srv.hits.map((h) => `${h.method} ${h.url}`)).toEqual([
      'POST /api/sessions/session-1/load?workspace=%2Ftmp%2Fws',
      'POST /api/plans/session-1/conversation/fork',
    ]);
    expect(saved).toEqual([['session-fork', 'build me a parser', ['claude-code'], '/tmp/ws']]);
    expect(stdout).toMatch(/Forked session-1 into session-fork/);
  });

  it('reports a refusal and leaves the current session alone', async () => {
    const srv = await daemon(({ url }) => url.includes('/load')
      ? { body: adopted }
      : { status: 409, body: { error: 'Cannot fork the conversation while the planner is answering' } });
    const { handleFork } = await import('../conversation');

    const { stderr, exitCode } = await capture(() => handleFork(['--workspace', '/tmp/ws'], new ApiClient(srv.port)));
    srv.close();

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/planner is answering/);
    expect(saved).toEqual([]);
  });
});

describe('ordewell rewind', () => {
  const targets = [
    { index: 2, preview: 'JSON only', timestamp: '2026-01-01T00:00:02Z' },
    { index: 4, preview: 'Streaming', timestamp: '2026-01-01T00:00:04Z' },
  ];

  it('with no argument prints the messages the TUI picker would offer, and changes nothing', async () => {
    const srv = await daemon(({ url }) => url.includes('/load') ? { body: adopted } : { body: { targets } });
    const { handleRewind } = await import('../conversation');

    const { stdout, exitCode } = await capture(() => handleRewind(['--workspace', '/tmp/ws'], new ApiClient(srv.port)));
    srv.close();

    expect(exitCode).toBeNull();
    expect(srv.hits.map((h) => h.method)).toEqual(['POST', 'GET']);
    expect(stdout).toMatch(/4\s+Streaming/);
    expect(stdout).toMatch(/2\s+JSON only/);
    expect(stdout.indexOf('Streaming')).toBeLessThan(stdout.indexOf('JSON only'));
    expect(stdout).toMatch(/ordewell rewind <n>/);
  });

  it('says so when there is nothing to rewind to', async () => {
    const srv = await daemon(({ url }) => url.includes('/load') ? { body: adopted } : { body: { targets: [] } });
    const { handleRewind } = await import('../conversation');

    const { stdout } = await capture(() => handleRewind(['--workspace', '/tmp/ws'], new ApiClient(srv.port)));
    srv.close();

    expect(stdout).toMatch(/Nothing to rewind to/);
  });

  it('rewinds to just before message n', async () => {
    const srv = await daemon(({ url }) => url.includes('/load') ? { body: adopted } : { body: { plan: { tasks: [], conversationHistory: [] } } });
    const { handleRewind } = await import('../conversation');

    const { stdout, exitCode } = await capture(() => handleRewind(['4', '--workspace', '/tmp/ws'], new ApiClient(srv.port)));
    srv.close();

    expect(exitCode).toBeNull();
    const rewind = srv.hits.find((h) => h.url.endsWith('/conversation/rewind'))!;
    expect(JSON.parse(rewind.body)).toEqual({ index: 4 });
    expect(stdout).toMatch(/Rewound/);
  });

  it.each(['abc', '-1', '2.5'])('refuses %s without calling the daemon', async (arg) => {
    const srv = await daemon(() => ({ body: {} }));
    const { handleRewind } = await import('../conversation');

    const { stderr, exitCode } = await capture(() => handleRewind([arg, '--workspace', '/tmp/ws'], new ApiClient(srv.port)));
    srv.close();

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Usage: ordewell rewind/);
    expect(srv.hits).toEqual([]);
  });

  it('reports a rewind the daemon refused', async () => {
    const srv = await daemon(({ url }) => url.includes('/load')
      ? { body: adopted }
      : { status: 400, body: { error: 'No user message at position 3 to rewind to.' } });
    const { handleRewind } = await import('../conversation');

    const { stderr, exitCode } = await capture(() => handleRewind(['3', '--workspace', '/tmp/ws'], new ApiClient(srv.port)));
    srv.close();

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/No user message at position 3/);
  });
});

describe('ordewell compact', () => {
  const compacted = { plan: { tasks: [] }, summary: 'Goal: a JSON parser. Streaming chosen.', keptMessages: 4 };

  it('adopts the current session, condenses it, and prints the summary that replaced the conversation', async () => {
    const srv = await daemon(({ url }) => url.includes('/load') ? { body: adopted } : { body: compacted });
    const { handleCompact } = await import('../conversation');

    const { stdout, exitCode } = await capture(() => handleCompact(['--workspace', '/tmp/ws'], new ApiClient(srv.port)));
    srv.close();

    expect(exitCode).toBeNull();
    expect(srv.hits.map((h) => `${h.method} ${h.url}`)).toEqual([
      'POST /api/sessions/session-1/load?workspace=%2Ftmp%2Fws',
      'POST /api/plans/session-1/conversation/compact',
    ]);
    expect(stdout).toMatch(/Condensed session-1/);
    expect(stdout).toContain('Goal: a JSON parser. Streaming chosen.');
    expect(stdout).toMatch(/tasks are unchanged/);
  });

  it.each([
    [409, 'Cannot condense the conversation while the planner is answering', /planner is answering/],
    [400, 'The conversation is too short to condense.', /too short/],
  ])('reports a refusal (%i) and exits non-zero', async (status, error, expected) => {
    const srv = await daemon(({ url }) => url.includes('/load') ? { body: adopted } : { status, body: { error } });
    const { handleCompact } = await import('../conversation');

    const { stderr, exitCode } = await capture(() => handleCompact(['--workspace', '/tmp/ws'], new ApiClient(srv.port)));
    srv.close();

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(expected);
  });
});
