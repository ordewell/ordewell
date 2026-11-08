import { describe, it, expect, vi } from 'vitest';
import http from 'http';
import { ApiClient } from '../../apiClient';
import { wireRoute } from '../../__tests__/wireRoute';

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

/** A daemon that records what it is asked and answers each control in the seam's words. */
async function daemon(answer: (command: { command: string }) => { status: number; body: unknown }, hits: string[] = []) {
  return startServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const sent = Buffer.concat(chunks).toString('utf8');
      hits.push(`${req.method} ${wireRoute(req.url)} ${sent}`);
      const { status, body } = answer(sent ? JSON.parse(sent) : { command: '' });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
}

/** What was sent to the seam: the plan the CLI reads first to know what to ask is not a command. */
const posts = (hits: string[]): string[] => hits.filter((hit) => hit.startsWith('POST'));

describe('handleMarkComplete', () => {
  it('sends the task as typed, for the seam to resolve, and prints the seam\'s line', async () => {
    const hits: string[] = [];
    const srv = await daemon(() => ({ status: 200, body: { ok: true, message: 'Marked task #2 "Second" complete.' } }), hits);
    const api = new ApiClient(srv.port);
    const { handleMarkComplete } = await import('../mark-complete');

    const { stdout } = await capture(() => handleMarkComplete(['--session-id', 'session-1', '2'], api));

    expect(posts(hits)).toEqual(['POST /api/plans/session-1/execute-command {"command":"mark_complete","task":"2"}']);
    expect(stdout).toBe('Marked task #2 "Second" complete.');
    srv.close();
  });

  it('keeps a title or an order with a hash intact in the command', async () => {
    const hits: string[] = [];
    const srv = await daemon(() => ({ status: 200, body: { ok: true, message: 'ok' } }), hits);
    const { handleMarkComplete } = await import('../mark-complete');

    await capture(() => handleMarkComplete(['--session-id', 'session-1', '#2.1'], new ApiClient(srv.port)));

    expect(posts(hits)).toEqual(['POST /api/plans/session-1/execute-command {"command":"mark_complete","task":"#2.1"}']);
    srv.close();
  });

  it('reports the seam\'s refusal when the task is not in the plan', async () => {
    const srv = await daemon(() => ({ status: 400, body: { error: 'There is no task "99" in this plan.', code: 'refused' } }));
    const { handleMarkComplete } = await import('../mark-complete');

    const { stderr, exitCode } = await capture(() => handleMarkComplete(['--session-id', 'session-1', '99'], new ApiClient(srv.port)));

    expect(stderr).toContain('Failed to mark task complete: There is no task "99" in this plan.');
    expect(exitCode).toBe(1);
    srv.close();
  });
});

describe('handleUncomplete and handleSkip', () => {
  it('print the seam\'s lines for Mark not done and Skip', async () => {
    const hits: string[] = [];
    const srv = await daemon(({ command }) => ({ status: 200, body: { ok: true, message: command === 'skip_task' ? 'Skipped task #2.' : 'Marked task #2 not done.' } }), hits);
    const mod = await import('../mark-complete');
    const api = new ApiClient(srv.port);

    const undone = await capture(() => mod.handleUncomplete(['--session-id', 'session-1', '2'], api));
    const skipped = await capture(() => mod.handleSkip(['--session-id', 'session-1', '2', '--reason', 'not needed'], api));

    expect(posts(hits)).toEqual([
      'POST /api/plans/session-1/execute-command {"command":"mark_not_done","task":"2"}',
      'POST /api/plans/session-1/execute-command {"command":"skip_task","task":"2","reason":"not needed"}',
    ]);
    expect(undone.stdout).toBe('Marked task #2 not done.');
    expect(skipped.stdout).toBe('Skipped task #2.');
    srv.close();
  });
});

/**
 * Mark complete and Mark not done of an AI or script task are overrides
 * (ADR-0029): the CLI asks first, with the core's words, and the daemon gets
 * the yes on the command. `--yes` has asked already; no terminal is a no.
 */
describe('an override of an AI or script task', () => {
  const plan = (status: string, type = 'ai') => ({
    meta: {},
    plan: { phase: 'planning', pendingTasks: [{ id: 't1', order: 1, title: 'Parse JSON', description: 'd', type, status, dependencies: [], subtasks: [] }], executionLog: [] },
  });

  async function overrideDaemon(status: string, type = 'ai', hits: string[] = [], activity?: Record<string, boolean>) {
    return startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const sent = Buffer.concat(chunks).toString('utf8');
        hits.push(`${req.method} ${req.url?.split('?')[0]} ${sent}`.trim());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(req.method === 'GET'
          ? { ...plan(status, type), ...(activity ? { run: { tasks: [], runMerge: null, handoff: null, mergeResult: null, activity } } : {}) }
          : { ok: true, message: 'Marked it.' }));
      });
    });
  }

  it('asks in the core\'s words, then sends the yes with the status it was asked about', async () => {
    const hits: string[] = [];
    const srv = await overrideDaemon('failed', 'ai', hits);
    const asked: string[] = [];
    const { handleMarkComplete } = await import('../mark-complete');

    const { stdout } = await capture(() => handleMarkComplete(['--session-id', 'session-1', '1'], new ApiClient(srv.port), async (question) => { asked.push(question); return true; }));

    expect(asked).toEqual([expect.stringMatching(/^Mark task #1 Parse JSON complete\? You vouch for its work although no passing verdict said it was done\..* Go ahead\?$/)]);
    expect(posts(hits)).toEqual(['POST /api/plans/session-1/execute-command {"command":"mark_complete","task":"1","confirmed":true,"seen":"failed"}']);
    expect(stdout).toBe('Marked it.');
    srv.close();
  });

  it('says what Mark not done leaves alone', async () => {
    const hits: string[] = [];
    const srv = await overrideDaemon('completed', 'script', hits);
    const asked: string[] = [];
    const { handleUncomplete } = await import('../mark-complete');

    await capture(() => handleUncomplete(['--session-id', 'session-1', '1'], new ApiClient(srv.port), async (question) => { asked.push(question); return true; }));

    expect(asked[0]).toContain('The work it did stays where it is');
    expect(posts(hits)).toEqual(['POST /api/plans/session-1/execute-command {"command":"mark_not_done","task":"1","confirmed":true,"seen":"completed"}']);
    srv.close();
  });

  it('does not ask while a queued start or a usage-limit hold could still move the task on', async () => {
    const hits: string[] = [];
    const srv = await overrideDaemon('pending', 'ai', hits, {
      starting: false, running: false, scheduled: false, resumable: false, advancesOnItsOwn: true,
    });
    const ask = vi.fn(async () => true);
    const { handleMarkComplete } = await import('../mark-complete');

    const { stderr, exitCode } = await capture(() => handleMarkComplete(['--session-id', 'session-1', '1'], new ApiClient(srv.port), ask));

    expect(ask).not.toHaveBeenCalled();
    expect(posts(hits)).toEqual([]);
    expect(stderr).toContain('Stop the run first');
    expect(exitCode).toBe(1);
    srv.close();
  });

  it('sends nothing, and says so, when the user says no', async () => {
    const hits: string[] = [];
    const srv = await overrideDaemon('pending', 'ai', hits);
    const { handleMarkComplete } = await import('../mark-complete');

    const { stderr, exitCode } = await capture(() => handleMarkComplete(['--session-id', 'session-1', '1'], new ApiClient(srv.port), async () => false));

    expect(posts(hits)).toEqual([]);
    expect(stderr).toContain('Nothing was changed. Pass --yes');
    expect(exitCode).toBe(1);
    srv.close();
  });

  it('treats no terminal as a no: nothing is approved implicitly', async () => {
    const hits: string[] = [];
    const srv = await overrideDaemon('pending', 'ai', hits);
    const { handleMarkComplete } = await import('../mark-complete');
    const tty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      const { exitCode } = await capture(() => handleMarkComplete(['--session-id', 'session-1', '1'], new ApiClient(srv.port)));
      expect(exitCode).toBe(1);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
    }

    expect(posts(hits)).toEqual([]);
    srv.close();
  });

  it('--yes has asked already: it sends the yes without a prompt or a lookup', async () => {
    const hits: string[] = [];
    const srv = await overrideDaemon('pending', 'ai', hits);
    const ask = vi.fn(async () => false);
    const { handleMarkComplete } = await import('../mark-complete');

    await capture(() => handleMarkComplete(['--session-id', 'session-1', '1', '--yes'], new ApiClient(srv.port), ask));

    expect(ask).not.toHaveBeenCalled();
    expect(hits).toEqual(['POST /api/plans/session-1/execute-command {"command":"mark_complete","task":"1","confirmed":true}']);
    srv.close();
  });

  it('signs off a manual task without a prompt', async () => {
    const hits: string[] = [];
    const srv = await overrideDaemon('pending', 'user', hits);
    const ask = vi.fn(async () => false);
    const { handleMarkComplete } = await import('../mark-complete');

    await capture(() => handleMarkComplete(['--session-id', 'session-1', '1'], new ApiClient(srv.port), ask));

    expect(ask).not.toHaveBeenCalled();
    expect(posts(hits)).toEqual(['POST /api/plans/session-1/execute-command {"command":"mark_complete","task":"1"}']);
    srv.close();
  });
});
