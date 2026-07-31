import { describe, it, expect, vi } from 'vitest';
import http from 'http';
import { ApiClient } from '../../apiClient';

interface Recorded { method: string; url: string; body: any }

const PLAN = {
  tasks: [
    { id: 'task-1', order: 1, title: 'Research', type: 'ai', status: 'completed', dependencies: [], assignedRunner: 'claude-code', taskMode: 'plan', assignedModel: null },
    { id: 'task-2', order: 2, title: 'Implement', type: 'ai', status: 'pending', dependencies: [], assignedRunner: 'claude-code', taskMode: 'build', assignedModel: { modelId: 'sonnet', modelLabel: 'Sonnet', thinkingEffort: 'high', availableVariants: ['high'] } },
    { id: 'task-3', order: 3, title: 'Sign off', type: 'user', status: 'pending', dependencies: ['task-2'], assignedRunner: '', taskMode: '', assignedModel: null },
  ],
};

const CATALOG = {
  models: [
    { modelId: 'sonnet', modelLabel: 'Sonnet', variants: [{ id: 'high', label: 'High' }] },
    { modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex' },
  ],
  modelsByRunner: { 'claude-code': [{ modelId: 'sonnet' }], codex: [{ modelId: 'gpt-5-codex' }] },
  modesByRunner: { 'claude-code': [{ id: 'build', label: 'Build' }, { id: 'plan', label: 'Plan' }] },
  providers: [],
  orchestratorModels: [],
};

async function fakeDaemon(): Promise<{ port: number; close: () => void; sent: Recorded[] }> {
  const sent: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      if (req.method !== 'GET') sent.push({ method: req.method!, url: req.url!, body });
      const json = (data: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.url?.startsWith('/api/models')) return json(CATALOG);
      if (req.url?.startsWith('/api/runners')) {
        return json({ runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true }, { id: 'codex', name: 'Codex', enabled: true }], headless: false, orchestratorModel: '' });
      }
      if (req.url?.includes('/api/sessions/')) {
        return json({ meta: { id: 'session-1', goal: 'g', runners: [], taskCount: 3, status: 'planned', createdAt: '', updatedAt: '' }, plan: PLAN });
      }
      return json({ ok: true });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return { port: typeof addr === 'object' && addr ? addr.port : 0, close: () => server.close(), sent };
}

async function capture(fn: () => Promise<void>) {
  const logs: string[] = [];
  const errs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => { logs.push(String(m)); });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((m: string) => { errs.push(String(m)); });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
  let exitCode: number | null = null;
  try {
    await fn();
  } catch (e) {
    const match = ((e as Error).message || '').match(/^exit:(\d+)$/);
    if (match) exitCode = Number(match[1]);
    else throw e;
  }
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
  return { stdout: logs.join('\n'), stderr: errs.join('\n'), exitCode };
}

const SESSION = ['--session-id', 'session-1'];
const updates = (sent: Recorded[]) => sent.filter((r) => r.method === 'PUT');

describe('ordewell task-runner', () => {
  it('sends only the runner, leaving the retarget to the daemon', async () => {
    const d = await fakeDaemon();
    const { handleTaskRunner } = await import('../task-assign');
    await capture(() => handleTaskRunner([...SESSION, '2', 'codex'], new ApiClient(d.port)));
    expect(updates(d.sent)).toHaveLength(1);
    expect(updates(d.sent)[0].body).toEqual({ assignedRunner: 'codex' });
    d.close();
  });

  it('refuses a manual task, which runs on no executor', async () => {
    const d = await fakeDaemon();
    const { handleTaskRunner } = await import('../task-assign');
    const { stderr, exitCode } = await capture(() => handleTaskRunner([...SESSION, '3', 'codex'], new ApiClient(d.port)));
    expect(stderr).toContain('Manual tasks');
    expect(exitCode).toBe(1);
    expect(updates(d.sent)).toEqual([]);
    d.close();
  });

  it('lists the runners when none is given', async () => {
    const d = await fakeDaemon();
    const { handleTaskRunner } = await import('../task-assign');
    const { stdout } = await capture(() => handleTaskRunner([...SESSION, '2'], new ApiClient(d.port)));
    expect(stdout).toContain('* claude-code');
    expect(stdout).toContain('codex');
    expect(updates(d.sent)).toEqual([]);
    d.close();
  });
});

describe('ordewell task-model', () => {
  it("refuses a model the task's runner was not discovered with", async () => {
    const d = await fakeDaemon();
    const { handleTaskModel } = await import('../task-assign');
    const { stderr, exitCode } = await capture(() => handleTaskModel([...SESSION, '2', 'gpt-5-codex'], new ApiClient(d.port)));
    expect(stderr).toContain('was not discovered for claude-code');
    expect(exitCode).toBe(1);
    d.close();
  });

  it('carries a still-supported effort across a model change', async () => {
    const d = await fakeDaemon();
    const { handleTaskModel } = await import('../task-assign');
    await capture(() => handleTaskModel([...SESSION, '2', 'sonnet'], new ApiClient(d.port)));
    expect(updates(d.sent)[0].body.assignedModel).toMatchObject({ modelId: 'sonnet', thinkingEffort: 'high' });
    d.close();
  });
});

describe('ordewell task-effort', () => {
  it('clears the effort on "default"', async () => {
    const d = await fakeDaemon();
    const { handleTaskEffort } = await import('../task-assign');
    await capture(() => handleTaskEffort([...SESSION, '2', 'default'], new ApiClient(d.port)));
    // `null`, not absent: JSON drops undefined, and the stale persisted
    // top-level effort has to be cleared explicitly.
    expect(updates(d.sent)[0].body.thinkingEffort).toBeNull();
    expect(updates(d.sent)[0].body.assignedModel.thinkingEffort).toBeUndefined();
    d.close();
  });

  it('rejects a level the assigned model does not expose', async () => {
    const d = await fakeDaemon();
    const { handleTaskEffort } = await import('../task-assign');
    const { stderr, exitCode } = await capture(() => handleTaskEffort([...SESSION, '2', 'ultra'], new ApiClient(d.port)));
    expect(stderr).toContain('Unknown effort: ultra');
    expect(exitCode).toBe(1);
    d.close();
  });
});

describe('ordewell task-mode', () => {
  it("accepts a mode the task's runner declares", async () => {
    const d = await fakeDaemon();
    const { handleTaskMode } = await import('../task-assign');
    await capture(() => handleTaskMode([...SESSION, '2', 'plan'], new ApiClient(d.port)));
    expect(updates(d.sent)[0].body).toEqual({ taskMode: 'plan' });
    d.close();
  });

  it('rejects a mode that runner does not declare', async () => {
    const d = await fakeDaemon();
    const { handleTaskMode } = await import('../task-assign');
    const { stderr, exitCode } = await capture(() => handleTaskMode([...SESSION, '2', 'yolo'], new ApiClient(d.port)));
    expect(stderr).toContain('Unknown mode "yolo" for claude-code');
    expect(exitCode).toBe(1);
    d.close();
  });
});

describe('ordewell task-deps', () => {
  it('accepts order numbers and resolves them to ids', async () => {
    const d = await fakeDaemon();
    const { handleTaskDeps } = await import('../task-assign');
    await capture(() => handleTaskDeps([...SESSION, '3', '1,2'], new ApiClient(d.port)));
    expect(updates(d.sent)[0].body).toEqual({ dependencies: ['task-1', 'task-2'] });
    d.close();
  });

  it('clears dependencies on "none"', async () => {
    const d = await fakeDaemon();
    const { handleTaskDeps } = await import('../task-assign');
    await capture(() => handleTaskDeps([...SESSION, '3', 'none'], new ApiClient(d.port)));
    expect(updates(d.sent)[0].body).toEqual({ dependencies: [] });
    d.close();
  });

  it('refuses a dependency that comes later in the plan, naming both tasks', async () => {
    const d = await fakeDaemon();
    const { handleTaskDeps } = await import('../task-assign');
    const { stderr, exitCode } = await capture(() => handleTaskDeps([...SESSION, '1', '3'], new ApiClient(d.port)));
    expect(stderr).toContain('cannot depend on');
    expect(stderr).toContain('Sign off');
    expect(exitCode).toBe(1);
    expect(updates(d.sent)).toEqual([]);
    d.close();
  });

  it('lists only the earlier tasks when no value is given', async () => {
    const d = await fakeDaemon();
    const { handleTaskDeps } = await import('../task-assign');
    const { stdout } = await capture(() => handleTaskDeps([...SESSION, '3'], new ApiClient(d.port)));
    expect(stdout).toContain('#1 Research');
    expect(stdout).toContain('* task-2');
    // The task itself names the header, but must never be offered as its own
    // candidate — the header line is the only place its id may appear.
    expect(stdout.split('\n').filter((l) => l.includes('task-3'))).toEqual([]);
    d.close();
  });
});
