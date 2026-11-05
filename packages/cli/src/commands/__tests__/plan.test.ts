import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { once } from 'events';
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
const WITH_SUBTASKS = {
  tasks: [
    {
      id: 't2', order: 2, title: 'Parent task', type: 'ai',
      subtasks: [
        { id: 't2a', order: 1, title: 'Sub step A', type: 'ai' },
        { id: 't2b', order: 2, title: 'Sub step B', type: 'user' },
      ],
    },
  ],
  runners: ['claude-code'],
};

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

describe('handlePlan — a turn that fails signed out', () => {
  it("rewords the terminal UI's /login sentence in the shell's own command", async () => {
    const srv = await startServer((req, res) => {
      if ((req.url || '').includes('/api/runners')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(RUNNERS));
      }
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Claude Code not logged in. Sign in with /login, or run claude auth login and try again.' }));
    });
    const { handlePlan } = await import('../plan');
    const { stderr, exitCode } = await capture(() => handlePlan(
      ['--goal', 'ship it', '--no-chat', '--workspace', '/tmp'],
      { api: new ApiClient(srv.port) },
    ));
    srv.close();

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Claude Code not logged in. Run claude auth login to sign in, then try again.');
    expect(stderr).not.toContain('/login');
  });
});

describe('handlePlan — a planner call whose reply never comes back', () => {  /** Takes the request, then drops the connection without answering: the outcome is the daemon's alone. */
  async function hangUpOn(fragment: string, hits: string[], answer: unknown = COMMITTED) {
    return startServer((req, res) => {
      const url = req.url || '';
      hits.push(`${req.method} ${url}`);
      if (url.includes(fragment)) return req.socket.destroy();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(url.includes('/api/runners') ? RUNNERS : { plan: answer }));
    });
  }

  const sessionOf = (hits: string[]): string => hits.find((h) => h.includes('/converse/'))!.match(/\/api\/plans\/([^/]+)\//)![1];

  it('names the session it minted, so the user resumes it instead of starting over', async () => {
    const hits: string[] = [];
    const srv = await hangUpOn('/converse/start', hits);
    const { handlePlan } = await import('../plan');
    const { stderr, exitCode } = await capture(() => handlePlan(['--goal', 'ship it', '--workspace', '/tmp'], { api: new ApiClient(srv.port) }));
    srv.close();

    const id = sessionOf(hits);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`ordewell sessions load ${id}`);
    expect(stderr).toMatch(/may still be running|may have finished/);
  });

  it('says the same when a reply to the planner\'s question is the call that was lost', async () => {
    const hits: string[] = [];
    const srv = await hangUpOn('/converse/message', hits, { tasks: [], conversationHistory: [{ role: 'assistant', content: 'Which database?' }] });
    const { handlePlan } = await import('../plan');
    const { stderr } = await capture(() => handlePlan(['--goal', 'ship it', '--workspace', '/tmp'], {
      api: new ApiClient(srv.port),
      reader: { ask: async () => 'postgres', close: () => {} },
    }));
    srv.close();

    expect(stderr).toContain(`ordewell sessions load ${sessionOf(hits)}`);
  });

  it('adds no resume hint when the daemon answered with a refusal', async () => {
    const srv = await startServer((req, res) => {
      res.writeHead(/\/api\/runners/.test(req.url || '') ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(/\/api\/runners/.test(req.url || '') ? RUNNERS : { error: 'planner down' }));
    });
    const { handlePlan } = await import('../plan');
    const { stderr, exitCode } = await capture(() => handlePlan(['--goal', 'ship it', '--workspace', '/tmp'], { api: new ApiClient(srv.port) }));
    srv.close();

    expect(exitCode).toBe(1);
    expect(stderr).not.toContain('sessions load');
  });
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

  it('--no-chat prints the skill check\'s warnings after the plan', async () => {
    const note = 'Skill check:\n- Task "Do the thing": skill "later" not found';
    const srv = await planServer({ '/generate': { plan: COMMITTED, models: [], notes: [note] } }, []);
    const { handlePlan } = await import('../plan');
    const { stdout } = await capture(() =>
      handlePlan(['--goal', 'ship it', '--workspace', '/tmp', '--no-chat'], { api: new ApiClient(srv.port) }),
    );
    expect(stdout.indexOf(note)).toBeGreaterThan(stdout.indexOf('Do the thing'));
    srv.close();
  });

  it('prints the skill check\'s warnings on the plan a conversation committed, and none from earlier commits', async () => {
    const note = (name: string) => ({ role: 'assistant', content: `Skill check:\n- Task "Do the thing": skill "${name}" not found`, timestamp: '2026-01-01T00:00:00Z', kind: 'system' });
    const marker = { role: 'assistant', content: 'Plan generated with 1 task.', timestamp: '2026-01-01T00:00:00Z', kind: 'plan_generated' };
    const plan = { ...COMMITTED, conversationHistory: [marker, note('old'), marker, note('later')] };
    const srv = await planServer({ '/converse/start': { plan } }, []);
    const { handlePlan } = await import('../plan');
    const { stdout } = await capture(() =>
      handlePlan(['--goal', 'ship it', '--workspace', '/tmp'], { api: new ApiClient(srv.port) }),
    );
    expect(stdout).toContain('skill "later" not found');
    expect(stdout).not.toContain('skill "old" not found');
    srv.close();
  });

  it('--no-chat counts the tasks of the stored plan state the one-shot endpoint answers with', async () => {
    const hits: string[] = [];
    const stored = { pendingTasks: COMMITTED.tasks, executionLog: [], runners: ['claude-code'] };
    const srv = await planServer({ '/generate': { plan: stored, models: [] } }, hits);
    const { handlePlan } = await import('../plan');
    const { stdout } = await capture(() =>
      handlePlan(['--goal', 'ship it', '--workspace', '/tmp', '--no-chat'], { api: new ApiClient(srv.port) }),
    );
    expect(stdout).toContain('Plan: 1 task (1 AI, 0 Manual)');
    expect(stdout).toContain('Do the thing');
    srv.close();
  });

  it('renders subtasks as indented dotted-label lines', async () => {
    const hits: string[] = [];
    const srv = await planServer({ '/converse/start': { plan: WITH_SUBTASKS } }, hits);
    const { handlePlan } = await import('../plan');
    const { stdout } = await capture(() =>
      handlePlan(['--goal', 'ship it', '--workspace', '/tmp'], { api: new ApiClient(srv.port) }),
    );
    expect(stdout).toContain(' 2. [ AI] Parent task');
    expect(stdout).toContain('    2.1. [ AI] Sub step A');
    expect(stdout).toContain('    2.2. [MAN] Sub step B');
    srv.close();
  });

  it('prints a script task as [SCR] with its commands under the title, and a legend line for it (ADR-0035)', async () => {
    const withScript = {
      tasks: [
        { id: 't1', order: 1, title: 'Build', type: 'ai' },
        { id: 't2', order: 2, title: 'Tag the release', type: 'script', dependencies: ['t1'], commands: [['git', 'tag', 'v1'], ['git', 'push', 'origin', 'v1']], timeoutMs: 90_000 },
        { id: 't3', order: 3, title: 'Clean up', type: 'script', script: 'rm -rf dist\nls', ops: undefined },
      ],
      runners: ['claude-code'],
    };
    const srv = await planServer({ '/converse/start': { plan: withScript } }, []);
    const { handlePlan } = await import('../plan');
    const { stdout } = await capture(() =>
      handlePlan(['--goal', 'ship it', '--workspace', '/tmp'], { api: new ApiClient(srv.port) }),
    );
    const lines = stdout.split('\n');
    const title = lines.findIndex((l) => l.includes('[SCR] Tag the release'));
    expect(title).toBeGreaterThan(-1);
    expect(lines.slice(title + 1, title + 4)).toEqual([
      '        git tag v1',
      '        git push origin v1',
      '',
    ]);
    expect(stdout).toContain('        Time limit: 90 seconds.');
    expect(stdout).toContain('        rm -rf dist\n        ls');
    expect(stdout).toContain('(1 AI, 2 Script, 0 Manual)');
    expect(stdout).toContain('[SCR] = script task');
    expect(stdout).not.toContain('[OPS]');
    srv.close();
  });

  it('names no runner on a script or a manual task, whatever runner the plan stores for it', async () => {
    const stored = {
      tasks: [
        { id: 't1', order: 1, title: 'Build', type: 'ai', assignedRunner: 'opencode' },
        { id: 't2', order: 2, title: 'Tag the release', type: 'script', commands: [['git', 'tag', 'v1']], assignedRunner: 'opencode' },
        { id: 't3', order: 3, title: 'Sign off', type: 'user', assignedRunner: 'opencode' },
      ],
      runners: ['claude-code'],
    };
    const srv = await planServer({ '/converse/start': { plan: stored } }, []);
    const { handlePlan } = await import('../plan');
    const { stdout } = await capture(() =>
      handlePlan(['--goal', 'ship it', '--workspace', '/tmp'], { api: new ApiClient(srv.port) }),
    );
    const rows = stdout.split('\n').filter((l) => l.includes('[SCR] Tag the release') || l.includes('[MAN] Sign off'));
    expect(rows).toHaveLength(2);
    expect(rows.join('\n')).not.toContain('opencode');
    srv.close();
  });

  it('prints a research task as [RES], with a legend line for it (ADR-0037)', async () => {
    const withResearch = {
      tasks: [
        { id: 't1', order: 1, title: 'Scout the cache', type: 'ai', readOnly: true, research: true },
        { id: 't2', order: 2, title: 'Build', type: 'ai' },
      ],
      runners: ['claude-code'],
    };
    const srv = await planServer({ '/converse/start': { plan: withResearch } }, []);
    const { handlePlan } = await import('../plan');
    const { stdout } = await capture(() =>
      handlePlan(['--goal', 'find it', '--workspace', '/tmp'], { api: new ApiClient(srv.port) }),
    );
    expect(stdout).toContain(' 1. [RES] Scout the cache');
    expect(stdout).toContain(' 2. [ AI] Build');
    expect(stdout).toContain('[RES] = research task: read-only, lands nothing; its report wakes the planner when it ends');
    srv.close();
  });

  it('prints a loop\'s check and body with the rounds and the link between them (ADR-0045)', async () => {
    const withLoop = {
      tasks: [
        { id: 't1', order: 1, title: 'Build', type: 'ai' },
        { id: 't2', order: 2, title: 'Run the tests', type: 'script', dependencies: ['t1'], commands: [['npm', 'test']], loop: { body: ['t3'], maxRounds: 4 } },
        { id: 't3', order: 3, title: 'Fix the failures', type: 'ai', dependencies: ['t2'] },
      ],
      runners: ['claude-code'],
    };
    const srv = await planServer({ '/converse/start': { plan: withLoop } }, []);
    const { handlePlan } = await import('../plan');
    const { stdout } = await capture(() =>
      handlePlan(['--goal', 'get the tests passing', '--workspace', '/tmp'], { api: new ApiClient(srv.port) }),
    );

    expect(stdout).toContain('        ↻ Loop of up to 4 rounds · Runs #3 if it fails');
    expect(stdout).toContain('        ↻ Runs if #2 fails');
    expect(stdout.match(/↻/g)).toHaveLength(2);
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

    expect(hits.slice(0, 2)).toEqual(['PATCH /api/settings', 'PATCH /api/settings']);
    // The provider is a switch; the effort is only what this process inherited, never a pick to remember.
    expect(JSON.parse(bodies[0])).toEqual({ env: { AI_PROVIDER: 'codex' }, workspace: process.cwd() });
    expect(JSON.parse(bodies[1])).toEqual({ env: { ORDEWELL_PLANNER_EFFORT: 'low' }, inherited: true, workspace: process.cwd() });
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

  it('prints the planner\'s question, not a skill-load entry that follows it, when stdin runs out', async () => {
    const skill = { invokedBy: 'planner', name: 'review-plan', source: 'global', path: '~/s', content: 'BODY' };
    const question = {
      tasks: [],
      conversationHistory: [
        { role: 'assistant', content: 'Which database?' },
        { role: 'assistant', content: 'review-plan skill loaded by planner', kind: 'skill_load', skill },
      ],
    };
    const srv = await planServer({ '/converse/start': { plan: question } }, []);
    const reader = { ask: async () => null, close: () => {} };
    const { handlePlan } = await import('../plan');
    const { stdout } = await capture(() =>
      handlePlan(['--goal', 'ship it', '--workspace', '/tmp'], { api: new ApiClient(srv.port), reader }),
    );
    expect(stdout).toContain('Which database?');
    expect(stdout).not.toContain('skill loaded by planner');
    srv.close();
  });

  it('rewords a planner-not-ready refusal with the headless commands, not the daemon\'s slash commands', async () => {
    const reason = { code: 'no_key', provider: 'openrouter', label: 'OpenRouter', keyEnvVar: 'OPENROUTER_API_KEY' };
    const srv = await startServer((req, res) => {
      const refused = (req.url || '').includes('/converse/start');
      res.writeHead(refused ? 409 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(refused
        ? { error: 'No planner is ready. Pick one with /planner', code: 'planner_not_ready', plannerNotReady: reason }
        : RUNNERS));
    });
    const { handlePlan } = await import('../plan');
    const { stderr, exitCode } = await capture(() =>
      handlePlan(['--goal', 'ship it', '--workspace', '/tmp'], { api: new ApiClient(srv.port) }),
    );
    expect(stderr).toContain(
      'No planner is ready. Pick one with ordewell planner <id>: Claude Code, Codex, OpenCode, GitHub Copilot CLI, Qwen Code, Cline, Gemini CLI and Cursor plan with no API key. ' +
      'To plan with OpenRouter instead, add OPENROUTER_API_KEY with ordewell key set openrouter <key>.',
    );
    expect(stderr).not.toContain('/planner');
    expect(exitCode).toBe(1);
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
    // All buffered lines have been handed to the reader once the stream ends.
    await once(stream, 'end');
    return reader;
  }

  it('buffers lines that arrive before they are asked for', async () => {
    // Regression: a piped stdin drains and closes during the planner round-trip,
    // so answers must survive not having a live question waiting for them.
    const reader = await readerOver('one\ntwo\nthree\n');

    expect(await reader.ask('> ')).toBe('one');
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
