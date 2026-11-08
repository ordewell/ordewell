import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'http';
import { resolve as resolvePath } from 'path';
import { ApiClient } from '../../apiClient';

const saved: unknown[][] = [];
// Resolved as the CLI resolves --workspace: a POSIX-looking path is drive-relative on Windows.
const WS = resolvePath('/tmp/ws');
const WS_QUERY = encodeURIComponent(WS);

vi.mock('../../utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils')>()),
  saveLastSession: (...args: unknown[]) => { saved.push(args); },
  readLastSession: () => ({ sessionId: 'session-1', goal: 'build me a parser', runners: ['claude-code'], workspace: WS }),
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

    const { stdout, exitCode } = await capture(() => handleFork(['--workspace', WS], new ApiClient(srv.port, WS)));
    srv.close();

    expect(exitCode).toBeNull();
    expect(srv.hits.map((h) => `${h.method} ${h.url}`)).toEqual([
      `POST /api/sessions/session-1/load?workspace=${WS_QUERY}`,
      `POST /api/plans/session-1/conversation/fork?workspace=${WS_QUERY}`,
    ]);
    expect(saved).toEqual([['session-fork', 'build me a parser', ['claude-code'], WS]]);
    expect(stdout).toMatch(/Forked session-1 into session-fork/);
  });

  it('reports a refusal and leaves the current session alone', async () => {
    const srv = await daemon(({ url }) => url.includes('/load')
      ? { body: adopted }
      : { status: 409, body: { error: 'Cannot fork the conversation while the planner is answering' } });
    const { handleFork } = await import('../conversation');

    const { stderr, exitCode } = await capture(() => handleFork(['--workspace', WS], new ApiClient(srv.port, WS)));
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

    const { stdout, exitCode } = await capture(() => handleRewind(['--workspace', WS], new ApiClient(srv.port, WS)));
    srv.close();

    expect(exitCode).toBeNull();
    expect(srv.hits.map((h) => h.method)).toEqual(['POST', 'GET']);
    expect(stdout).toMatch(/4\s+Streaming/);
    expect(stdout).toMatch(/2\s+JSON only/);
    expect(stdout.indexOf('Streaming')).toBeLessThan(stdout.indexOf('JSON only'));
    expect(stdout).toMatch(/ordewell rewind <n>/);
    expect(stdout).toMatch(/fork/);
  });

  it('says so when there is nothing to rewind to', async () => {
    const srv = await daemon(({ url }) => url.includes('/load') ? { body: adopted } : { body: { targets: [] } });
    const { handleRewind } = await import('../conversation');

    const { stdout } = await capture(() => handleRewind(['--workspace', WS], new ApiClient(srv.port, WS)));
    srv.close();

    expect(stdout).toMatch(/Nothing to rewind to/);
  });

  it('forks from just before message n, makes the fork current, and prints the rewound message to resend', async () => {
    const rewound = {
      sessionId: 'session-fork', goal: 'build me a parser',
      plan: { tasks: [], runners: ['claude-code'], conversationHistory: [] },
      rewoundMessage: 'Streaming\nand resumable after a crash',
    };
    const srv = await daemon(({ url }) => url.includes('/load') ? { body: adopted } : { body: rewound });
    const { handleRewind } = await import('../conversation');

    const { stdout, exitCode } = await capture(() => handleRewind(['4', '--workspace', WS], new ApiClient(srv.port, WS)));
    srv.close();

    expect(exitCode).toBeNull();
    const rewind = srv.hits.find((h) => h.url.includes('/conversation/rewind'))!;
    expect(rewind.url).toBe(`/api/plans/session-1/conversation/rewind?workspace=${WS_QUERY}`);
    expect(JSON.parse(rewind.body)).toEqual({ index: 4 });
    expect(saved).toEqual([['session-fork', 'build me a parser', ['claude-code'], WS]]);
    expect(stdout).toMatch(/Forked session-1 into session-fork from just before message 4/);
    expect(stdout).toContain('ordewell sessions load session-1');
    expect(stdout).toContain('Streaming\nand resumable after a crash');
  });

  it.each(['abc', '-1', '2.5'])('refuses %s without calling the daemon', async (arg) => {
    const srv = await daemon(() => ({ body: {} }));
    const { handleRewind } = await import('../conversation');

    const { stderr, exitCode } = await capture(() => handleRewind([arg, '--workspace', WS], new ApiClient(srv.port, WS)));
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

    const { stderr, exitCode } = await capture(() => handleRewind(['3', '--workspace', WS], new ApiClient(srv.port, WS)));
    srv.close();

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/No user message at position 3/);
    expect(saved).toEqual([]);
  });

  it('reports a rewind refused mid-turn and leaves the current session alone', async () => {
    const srv = await daemon(({ url }) => url.includes('/load')
      ? { body: adopted }
      : { status: 409, body: { error: 'Cannot rewind the conversation while the planner is answering' } });
    const { handleRewind } = await import('../conversation');

    const { stderr, exitCode } = await capture(() => handleRewind(['2', '--workspace', WS], new ApiClient(srv.port, WS)));
    srv.close();

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/planner is answering/);
    expect(saved).toEqual([]);
  });
});

describe('ordewell compact retry', () => {
  const pause = { model: 'vendor/model', at: '2026-10-25T10:00:00Z', reason: "vendor/model refused the planner's call as too long for its window. The planner is paused: Retry compaction tries to condense its context and continue the turn, or stop it to drop the turn.", inputs: ['turn-1'] };

  it('retries the paused turn and says it carried on', async () => {
    const srv = await daemon(({ url }) => url.includes('/load') ? { body: { ...adopted, plan: { tasks: [], plannerContextPause: pause } } } : { body: { plan: { tasks: [] } } });
    const { handleCompact } = await import('../conversation');

    const { stdout, exitCode } = await capture(() => handleCompact(['retry', '--workspace', WS], new ApiClient(srv.port, WS)));
    srv.close();

    expect(exitCode).toBeNull();
    expect(srv.hits.map((h) => `${h.method} ${h.url}`)).toEqual([
      `POST /api/sessions/session-1/load?workspace=${WS_QUERY}`,
      `POST /api/plans/session-1/conversation/compact/retry?workspace=${WS_QUERY}`,
    ]);
    expect(stdout).toMatch(/carried the paused turn on/);
  });

  it('exits non-zero with why when the planner paused again', async () => {
    const srv = await daemon(({ url }) => url.includes('/load') ? { body: adopted } : { body: { plan: { tasks: [], plannerContextPause: pause } } });
    const { handleCompact } = await import('../conversation');

    const { stderr, exitCode } = await capture(() => handleCompact(['retry', '--workspace', WS], new ApiClient(srv.port, WS)));
    srv.close();

    expect(exitCode).toBe(1);
    expect(stderr).toContain(pause.reason);
  });

  it('reports a retry the daemon refused, and exits non-zero', async () => {
    const error = 'The planner is not paused on its context: there is nothing to retry.';
    const srv = await daemon(({ url }) => url.includes('/load') ? { body: adopted } : { status: 400, body: { error, code: 'refused' } });
    const { handleCompact } = await import('../conversation');

    const { stderr, exitCode } = await capture(() => handleCompact(['retry', '--workspace', WS], new ApiClient(srv.port, WS)));
    srv.close();

    expect(exitCode).toBe(1);
    expect(stderr).toContain(`Failed to retry compaction: ${error}`);
  });

  it('refuses any other argument with its usage', async () => {
    const { handleCompact } = await import('../conversation');
    const { stderr, exitCode } = await capture(() => handleCompact(['again']));
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Usage: ordewell compact \[retry\]/);
  });
});

describe('ordewell compact', () => {
  const compacted = { plan: { tasks: [] }, summary: 'Goal: a JSON parser. Streaming chosen.', keptMessages: 4 };

  it('adopts the current session, condenses it, and prints the summary that replaced the conversation', async () => {
    const srv = await daemon(({ url }) => url.includes('/load') ? { body: adopted } : { body: compacted });
    const { handleCompact } = await import('../conversation');

    const { stdout, exitCode } = await capture(() => handleCompact(['--workspace', WS], new ApiClient(srv.port, WS)));
    srv.close();

    expect(exitCode).toBeNull();
    expect(srv.hits.map((h) => `${h.method} ${h.url}`)).toEqual([
      `POST /api/sessions/session-1/load?workspace=${WS_QUERY}`,
      `POST /api/plans/session-1/conversation/compact?workspace=${WS_QUERY}`,
    ]);
    expect(stdout).toMatch(/Condensed session-1/);
    expect(stdout).toContain('Goal: a JSON parser. Streaming chosen.');
    expect(stdout).toMatch(/tasks are unchanged/);
    // The transcript is kept whole; only what the planner is sent is shortened.
    expect(stdout).toMatch(/full conversation stays in the session/);
  });

  it.each([
    [409, 'Cannot condense the conversation while the planner is answering', /planner is answering/],
    [400, 'The conversation is too short to condense.', /too short/],
  ])('reports a refusal (%i) and exits non-zero', async (status, error, expected) => {
    const srv = await daemon(({ url }) => url.includes('/load') ? { body: adopted } : { status, body: { error } });
    const { handleCompact } = await import('../conversation');

    const { stderr, exitCode } = await capture(() => handleCompact(['--workspace', WS], new ApiClient(srv.port, WS)));
    srv.close();

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(expected);
  });

  it('names the session when the connection drops before the condense is answered', async () => {
    const srv = await new Promise<{ port: number; close: () => void }>((resolve) => {
      const server = http.createServer((req, res) => {
        if (req.url?.includes('/compact')) return req.socket.destroy();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(adopted));
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve({ port: typeof addr === 'object' && addr ? addr.port : 0, close: () => server.close() });
      });
    });
    const { handleCompact } = await import('../conversation');

    const { stderr, exitCode } = await capture(() => handleCompact(['--workspace', WS], new ApiClient(srv.port, WS)));
    srv.close();

    expect(exitCode).toBe(1);
    expect(stderr).toContain('ordewell sessions load session-1');
  });

  it('words a planner that cannot plan with the shell\'s commands, not the terminal UI\'s', async () => {
    const plannerNotReady = { code: 'no_key', provider: 'openrouter', label: 'OpenRouter', keyEnvVar: 'OPENROUTER_API_KEY' };
    const srv = await daemon(({ url }) => url.includes('/load')
      ? { body: adopted }
      : { status: 409, body: { error: 'No planner is ready. Pick one with /planner', code: 'planner_not_ready', plannerNotReady } });
    const { handleCompact } = await import('../conversation');

    const { stderr, exitCode } = await capture(() => handleCompact(['--workspace', WS], new ApiClient(srv.port, WS)));
    srv.close();

    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      'Failed to condense: No planner is ready. Pick one with ordewell planner <id>: Claude Code, Codex, OpenCode, GitHub Copilot CLI, Qwen Code, Cline, Gemini CLI and Cursor plan with no API key. ' +
      'To plan with OpenRouter instead, add OPENROUTER_API_KEY with ordewell key set openrouter <key>.',
    );
    expect(stderr).not.toContain('/planner');
  });
});

describe('ordewell resend', () => {
  it.each([
    [true, /Resend cancelled: what waits goes with your next message/],
    [false, /Nothing waits on the planner's usage limit/],
  ])('cancels what waits on the planner\'s usage limit (cancelled: %s), and says what happened', async (cancelled, said) => {
    const srv = await daemon(({ url }) => url.includes('/load') ? { body: adopted } : { body: { cancelled } });
    const { handleResend } = await import('../conversation');

    const { stdout, exitCode } = await capture(() => handleResend(['cancel', '--workspace', WS], new ApiClient(srv.port, WS)));
    srv.close();

    expect(exitCode).toBeNull();
    expect(srv.hits.map((h) => `${h.method} ${h.url}`)).toEqual([
      `POST /api/sessions/session-1/load?workspace=${WS_QUERY}`,
      `POST /api/plans/session-1/converse/resend/cancel?workspace=${WS_QUERY}`,
    ]);
    expect(stdout).toMatch(said);
  });

  it('takes only cancel', async () => {
    const { handleResend } = await import('../conversation');
    const { stderr, exitCode } = await capture(() => handleResend([]));
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Usage: ordewell resend cancel/);
  });
});
