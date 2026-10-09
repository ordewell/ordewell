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
    const match = ((e as Error).message || '').match(/^exit:(\d+)$/);
    if (match) exitCode = parseInt(match[1], 10);
    else throw e;
  }
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
  return { stdout: logs.join('\n'), stderr: errs.join('\n'), exitCode };
}

const PLAN = {
  meta: { id: 'session-1', goal: 'test', runners: ['claude-code'], taskCount: 1, status: 'running', createdAt: '', updatedAt: '' },
  plan: { pendingTasks: [{ id: 'task-abc-123', order: 3, title: 'Third', status: 'failed' }] },
};

async function serverRecordingHits(hits: string[]) {
  return startServer((req, res) => {
    if (req.url?.includes('/sessions/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(PLAN));
      return;
    }
    if (req.url?.endsWith('/merge-gate')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mergeGate: [] }));
      return;
    }
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
}

describe('task control commands', () => {
  it.each([
    ['handleRunTask', 'run', 'Task started.'],
    ['handleForceStart', 'force-start', 'Task force-started.'],
    ['handleRetry', 'retry', 'Task retried.'],
    ['handleCancel', 'cancel', 'Task cancelled.'],
  ])('%s posts the %s route', async (handlerName, segment, message) => {
    const hits: string[] = [];
    const srv = await serverRecordingHits(hits);
    const mod: unknown = await import('../task-control');
    const { stdout } = await capture(() =>
      (mod as Record<string, (...args: unknown[]) => Promise<void>>)[handlerName](['--session-id', 'session-1', '3'], new ApiClient(srv.port)),
    );
    expect(hits).toEqual([`POST /api/plans/session-1/tasks/task-abc-123/${segment}`]);
    expect(stdout).toContain(message);
    srv.close();
  });

  it('resolves a task by ID prefix', async () => {
    const hits: string[] = [];
    const srv = await serverRecordingHits(hits);
    const { handleRetry } = await import('../task-control');
    await capture(() => handleRetry(['--session-id', 'session-1', 'task-abc'], new ApiClient(srv.port)));
    expect(hits[0]).toContain('task-abc-123/retry');
    srv.close();
  });

  it('errors when the task identifier cannot be resolved', async () => {
    const srv = await serverRecordingHits([]);
    const { handleCancel } = await import('../task-control');
    const { stderr, exitCode } = await capture(() =>
      handleCancel(['--session-id', 'session-1', '99'], new ApiClient(srv.port)),
    );
    expect(stderr).toContain('Task not found');
    expect(exitCode).toBe(1);
    srv.close();
  });

  it('continue posts the message to the resolved task\'s continue route (ADR-0018, K1)', async () => {
    let body = '';
    const hits: string[] = [];
    const srv = await startServer((req, res) => {
      req.on('data', (c) => { body += c.toString(); });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url?.includes('/sessions/')) return res.end(JSON.stringify(PLAN));
        hits.push(`${req.method} ${req.url}`);
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const { handleContinue } = await import('../task-control');
    const { stdout } = await capture(() =>
      handleContinue(['--session-id', 'session-1', '3', 'also', 'handle', 'arrays'], new ApiClient(srv.port)),
    );
    expect(hits).toEqual(['POST /api/plans/session-1/tasks/task-abc-123/continue']);
    expect(JSON.parse(body)).toEqual({ text: 'also handle arrays' });
    expect(stdout).toContain('Task continued.');
    srv.close();
  });

  it('continue without a message prints its usage', async () => {
    const { handleContinue } = await import('../task-control');
    const { stderr, exitCode } = await capture(() => handleContinue(['--session-id', 'session-1', '3']));
    expect(stderr).toContain('Usage: ordewell continue');
    expect(exitCode).toBe(1);
  });

  it('continue reports the daemon\'s refusal', async () => {
    const srv = await startServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url?.includes('/sessions/')) return res.end(JSON.stringify(PLAN));
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Task "Third" cannot be continued: its runner left no saved session to resume. Use Retry instead.' }));
      });
    });
    const { handleContinue } = await import('../task-control');
    const { stderr, exitCode } = await capture(() =>
      handleContinue(['--session-id', 'session-1', '3', 'go on'], new ApiClient(srv.port)),
    );
    expect(stderr).toContain('Failed to continue task: Task "Third" cannot be continued');
    expect(exitCode).toBe(1);
    srv.close();
  });

  it('remove-task deletes the resolved task', async () => {
    const hits: string[] = [];
    const srv = await serverRecordingHits(hits);
    const { handleRemoveTask } = await import('../remove-task');
    const { stdout } = await capture(() =>
      handleRemoveTask(['--session-id', 'session-1', '3'], new ApiClient(srv.port)),
    );
    expect(hits).toEqual(['DELETE /api/plans/session-1/tasks/task-abc-123']);
    expect(stdout).toContain('Task removed.');
    srv.close();
  });
});

describe('handleAddTask', () => {
  it('posts a task with title, type and dependencies', async () => {
    let body = '';
    const srv = await startServer((req, res) => {
      req.on('data', (c) => { body += c.toString(); });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const { handleAddTask } = await import('../add-task');
    const { stdout } = await capture(() =>
      handleAddTask(
        ['--session-id', 'session-1', '--title', 'Add retries', '--depends-on', 'task-1', '--depends-on', 'task-2'],
        new ApiClient(srv.port),
      ),
    );
    expect(JSON.parse(body)).toMatchObject({
      title: 'Add retries',
      description: 'Add retries',
      type: 'ai',
      dependencies: ['task-1', 'task-2'],
    });
    expect(stdout).toContain('Added task: Add retries');
    srv.close();
  });

  it('builds userSteps for manual tasks', async () => {
    let body = '';
    const srv = await startServer((req, res) => {
      req.on('data', (c) => { body += c.toString(); });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const { handleAddTask } = await import('../add-task');
    await capture(() =>
      handleAddTask(
        ['--session-id', 'session-1', '--title', 'Deploy', '--type', 'user'],
        new ApiClient(srv.port),
      ),
    );
    const parsed = JSON.parse(body);
    expect(parsed.type).toBe('user');
    expect(parsed.prompt).toBeUndefined();
    expect(parsed.userSteps).toEqual([{ order: 1, instruction: 'Deploy', completed: false }]);
    srv.close();
  });

  it('errors without a title', async () => {
    const { handleAddTask } = await import('../add-task');
    const { stderr, exitCode } = await capture(() => handleAddTask(['--session-id', 'session-1']));
    expect(stderr).toContain('--title');
    expect(exitCode).toBe(1);
  });
});

describe('starting a task past its merge gate (ADR-0020)', () => {
  const GATE_PLAN = {
    meta: PLAN.meta,
    plan: { pendingTasks: [{ id: 'ops-2', order: 2, title: 'Deploy', type: 'ai', ops: true, status: 'pending' }] },
  };

  async function gatedServer(hits: string[], gate: unknown = { mergeGate: [{ id: 'fix-1', order: 1, title: 'Fix' }] }, gateStatus = 200) {
    return startServer((req, res) => {
      res.writeHead(req.url?.endsWith('/merge-gate') ? gateStatus : 200, { 'Content-Type': 'application/json' });
      if (req.url?.includes('/sessions/')) return res.end(JSON.stringify(GATE_PLAN));
      if (req.url?.endsWith('/merge-gate')) return res.end(JSON.stringify(gate));
      hits.push(`${req.method} ${req.url}`);
      res.end(JSON.stringify({ ok: true }));
    });
  }

  it.each(['handleForceStart', 'handleRunTask'])('%s asks first, naming the unmerged work, and starts nothing on a no', async (handlerName) => {
    const hits: string[] = [];
    const srv = await gatedServer(hits);
    const questions: string[] = [];
    const mod = (await import('../task-control')) as unknown as Record<string, (...args: unknown[]) => Promise<void>>;

    const { stderr, exitCode } = await capture(() =>
      mod[handlerName](['--session-id', 'session-1', '2'], new ApiClient(srv.port), async (q: string) => { questions.push(q); return false; }),
    );

    expect(questions).toEqual([expect.stringContaining('the work of #1 Fix is not merged into your branch yet')]);
    expect(stderr).toContain('Not started');
    expect(exitCode).toBe(1);
    expect(hits).toEqual([]);
    srv.close();
  });

  it('starts it on a yes, and with --yes asks nothing', async () => {
    const hits: string[] = [];
    const srv = await gatedServer(hits);
    const { handleForceStart } = await import('../task-control');
    const asked: string[] = [];

    await capture(() => handleForceStart(['--session-id', 'session-1', '2'], new ApiClient(srv.port), async (q) => { asked.push(q); return true; }));
    await capture(() => handleForceStart(['--session-id', 'session-1', '--yes', '2'], new ApiClient(srv.port), async (q) => { asked.push(q); return false; }));

    expect(asked).toHaveLength(1);
    expect(hits).toEqual(['POST /api/plans/session-1/tasks/ops-2/force-start', 'POST /api/plans/session-1/tasks/ops-2/force-start']);
    srv.close();
  });

  it('leaves a daemon that cannot say what gates the task to answer the start itself', async () => {
    const hits: string[] = [];
    const srv = await gatedServer(hits, { error: 'Session not found' }, 404);
    const { handleForceStart } = await import('../task-control');

    await capture(() => handleForceStart(['--session-id', 'session-1', '2'], new ApiClient(srv.port), async () => { throw new Error('asked'); }));

    expect(hits).toEqual(['POST /api/plans/session-1/tasks/ops-2/force-start']);
    srv.close();
  });

  it('never asks before a retry', async () => {
    const hits: string[] = [];
    const srv = await gatedServer(hits);
    const { handleRetry } = await import('../task-control');

    await capture(() => handleRetry(['--session-id', 'session-1', '2'], new ApiClient(srv.port), async () => { throw new Error('asked'); }));

    expect(hits).toEqual(['POST /api/plans/session-1/tasks/ops-2/retry']);
    srv.close();
  });
});
