import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { ApiClient } from '../../apiClient';

const savedSessions: unknown[] = [];

vi.mock('../../utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils')>()),
  saveLastSession: (...args: unknown[]) => { savedSessions.push(args); },
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

async function capture(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => { logs.push(m); });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((m: string) => { errs.push(m); });
  const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
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
  writeSpy.mockRestore();
  exitSpy.mockRestore();
  return { stdout: logs.join('\n'), stderr: errs.join('\n'), exitCode };
}

const RUNNERS = { runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true }], headless: false, orchestratorModel: 'x' };
const COMMITTED = { tasks: [{ id: 't1', order: 1, title: 'Do the thing', type: 'ai' }], runners: ['claude-code'] };

/** Serves /api/runners plus whatever plan payloads the test queues up. */
async function planServer(routes: Record<string, unknown>, hits: string[]) {
  return startServer((req, res) => {
    const url = req.url || '';
    hits.push(`${req.method} ${url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.includes('/api/runners')) return res.end(JSON.stringify(RUNNERS));
    for (const [fragment, payload] of Object.entries(routes)) {
      if (url.includes(fragment)) return res.end(JSON.stringify(payload));
    }
    res.end(JSON.stringify({ error: `unexpected ${url}` }));
  });
}

const PLANNER_ENV_KEYS = ['AI_PROVIDER', 'ORCHESTRATOR_MODEL', 'ORDEWELL_PLANNER_EFFORT'];
let savedPlannerEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedSessions.length = 0;
  // handlePlan forwards these unconditionally; a value inherited from the
  // host shell would make forwardPlannerEnv fire an extra, untested request.
  savedPlannerEnv = Object.fromEntries(PLANNER_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of PLANNER_ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of PLANNER_ENV_KEYS) {
    if (savedPlannerEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedPlannerEnv[k];
  }
});

describe('handlePlan', () => {
  it('uses the conversational endpoint by default', async () => {
    const hits: string[] = [];
    const srv = await planServer({ '/converse/start': { plan: COMMITTED } }, hits);
    const { handlePlan } = await import('../plan');
    const { stdout } = await capture(() =>
      handlePlan(['--goal', 'ship it', '--workspace', '/tmp'], { api: new ApiClient(srv.port) }),
    );
    expect(hits.some((h) => h.includes('/converse/start'))).toBe(true);
    expect(hits.some((h) => h.includes('/generate'))).toBe(false);
    expect(stdout).toContain('Do the thing');
    expect(savedSessions).toHaveLength(1);
    srv.close();
  });

  it('--no-chat falls back to the one-shot generate endpoint', async () => {
    const hits: string[] = [];
    const srv = await planServer({ '/generate': { plan: COMMITTED, models: [] } }, hits);
    const { handlePlan } = await import('../plan');
    const { stdout } = await capture(() =>
      handlePlan(['--goal', 'ship it', '--workspace', '/tmp', '--no-chat'], { api: new ApiClient(srv.port) }),
    );
    expect(hits.some((h) => h.includes('/generate'))).toBe(true);
    expect(hits.some((h) => h.includes('/converse'))).toBe(false);
    expect(stdout).toContain('Do the thing');
    srv.close();
  });

  it('forwards the planner environment to a daemon that was already running', async () => {
    // The daemon inherits its environment once, at spawn. Without this the
    // documented `AI_PROVIDER=codex ordewell plan …` planned with whatever the
    // daemon happened to be started with, and said nothing about it.
    const hits: string[] = [];
    const bodies: string[] = [];
    const srv = await startServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        if (body) bodies.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if ((req.url || '').includes('/api/runners')) return res.end(JSON.stringify(RUNNERS));
        res.end(JSON.stringify({ plan: COMMITTED }));
      });
    });

    process.env.AI_PROVIDER = 'codex';
    process.env.ORDEWELL_PLANNER_EFFORT = 'low';
    try {
      const { handlePlan } = await import('../plan');
      await capture(() => handlePlan(['--goal', 'ship it', '--workspace', '/tmp'], { api: new ApiClient(srv.port) }));
    } finally {
      delete process.env.AI_PROVIDER;
      delete process.env.ORDEWELL_PLANNER_EFFORT;
    }

    expect(hits[0]).toBe('PATCH /api/settings');
    expect(JSON.parse(bodies[0])).toEqual({ env: { AI_PROVIDER: 'codex', ORDEWELL_PLANNER_EFFORT: 'low' } });
    srv.close();
  });

  it('leaves the daemon settings alone when nothing is set in the environment', async () => {
    const hits: string[] = [];
    const srv = await planServer({ '/converse/start': { plan: COMMITTED } }, hits);
    const saved = { ...process.env };
    delete process.env.AI_PROVIDER;
    delete process.env.ORCHESTRATOR_MODEL;
    delete process.env.ORDEWELL_PLANNER_EFFORT;
    try {
      const { handlePlan } = await import('../plan');
      await capture(() => handlePlan(['--goal', 'ship it', '--workspace', '/tmp'], { api: new ApiClient(srv.port) }));
    } finally {
      Object.assign(process.env, saved);
    }

    expect(hits.some((h) => h.includes('/api/settings'))).toBe(false);
    srv.close();
  });

  it('answers planner questions and commits once tasks arrive', async () => {
    const question = (n: number) => ({
      tasks: [],
      conversationHistory: [
        { role: 'user', content: 'ship it' },
        { role: 'assistant', content: `Question ${n}?` },
      ],
    });
    let turn = 0;
    const hits: string[] = [];
    const srv = await startServer((req, res) => {
      const url = req.url || '';
      hits.push(url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (url.includes('/api/runners')) return res.end(JSON.stringify(RUNNERS));
      // The plan command also opens a research-progress WS subscription
      // (issue #34); this plain http server surfaces that handshake as a
      // regular request, so it must not count as a converse turn.
      if (url.includes('/ws/session/')) return res.end('{}');
      if (url.includes('/converse/start')) return res.end(JSON.stringify({ plan: question(1) }));
      turn++;
      return res.end(JSON.stringify({ plan: turn === 1 ? question(2) : COMMITTED }));
    });

    const asked: string[] = [];
    const answers = ['first answer', '', 'second answer'];
    const reader = {
      ask: async (q: string) => { asked.push(q); return answers.shift() ?? null; },
      close: () => {},
    };

    const { handlePlan } = await import('../plan');
    const { stdout } = await capture(() =>
      handlePlan(['--goal', 'ship it', '--workspace', '/tmp'], { api: new ApiClient(srv.port), reader }),
    );

    expect(stdout).toContain('Question 1?');
    expect(stdout).toContain('Question 2?');
    // The blank answer is re-prompted rather than sent.
    expect(asked).toHaveLength(3);
    expect(hits.filter((h) => h.includes('/converse/message'))).toHaveLength(2);
    expect(stdout).toContain('Do the thing');
    expect(savedSessions).toHaveLength(1);
    srv.close();
  });

  it('bails with guidance when stdin runs out of answers', async () => {
    const question = {
      tasks: [],
      conversationHistory: [{ role: 'assistant', content: 'What does "ship it" mean here?' }],
    };
    const srv = await planServer({ '/converse/start': { plan: question } }, []);
    const reader = { ask: async () => null, close: () => {} };
    const { handlePlan } = await import('../plan');
    const { stdout, stderr, exitCode } = await capture(() =>
      handlePlan(['--goal', 'ship it', '--workspace', '/tmp'], { api: new ApiClient(srv.port), reader }),
    );
    expect(stdout).toContain('What does "ship it" mean here?');
    expect(stderr).toContain('--no-chat');
    expect(exitCode).toBe(1);
    expect(savedSessions).toHaveLength(0);
    srv.close();
  });

  it('aborts on /quit', async () => {
    const question = {
      tasks: [],
      conversationHistory: [{ role: 'assistant', content: 'Why?' }],
    };
    const srv = await planServer({ '/converse/start': { plan: question } }, []);
    const reader = { ask: async () => '/quit', close: () => {} };
    const { handlePlan } = await import('../plan');
    const { stderr, exitCode } = await capture(() =>
      handlePlan(['--goal', 'ship it', '--workspace', '/tmp'], { api: new ApiClient(srv.port), reader }),
    );
    expect(stderr).toContain('Planning aborted.');
    expect(exitCode).toBe(1);
    srv.close();
  });
});

describe('stdinReader', () => {
  async function readerOver(lines: string) {
    const { PassThrough } = await import('stream');
    const stream = new PassThrough();
    const { stdinReader } = await import('../plan');
    const reader = stdinReader(stream as never);
    stream.end(lines);
    return reader;
  }

  it('buffers lines that arrive before they are asked for', async () => {
    // Regression: a piped stdin drains and closes during the planner round-trip,
    // so answers must survive not having a live question waiting for them.
    const reader = await readerOver('one\ntwo\nthree\n');
    await new Promise((r) => setTimeout(r, 10));

    expect(await reader.ask('> ')).toBe('one');
    await new Promise((r) => setTimeout(r, 10));
    expect(await reader.ask('> ')).toBe('two');
    expect(await reader.ask('> ')).toBe('three');
    expect(await reader.ask('> ')).toBeNull();
  });

  it('resolves a pending question when a line arrives later', async () => {
    const { PassThrough } = await import('stream');
    const stream = new PassThrough();
    const { stdinReader } = await import('../plan');
    const reader = stdinReader(stream as never);

    const pending = reader.ask('> ');
    stream.write('late answer\n');
    expect(await pending).toBe('late answer');
    reader.close();
  });

  it('resolves null when stdin closes with a question pending', async () => {
    const { PassThrough } = await import('stream');
    const stream = new PassThrough();
    const { stdinReader } = await import('../plan');
    const reader = stdinReader(stream as never);

    const pending = reader.ask('> ');
    stream.end();
    expect(await pending).toBeNull();
  });
});
