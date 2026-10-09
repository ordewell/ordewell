import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Hono } from 'hono';
import { saveSession, type ITerminalRunner, type LegacyPlanState, type RunnerSpawnOptions } from '@ordewell/core';
import { FakeStructuredSession } from '@ordewell/core/testing';
import { OrchestratorPool } from '../orchestratorPool';
import { settingsRoute } from '../../routes/settings';

/** What an older build pinned to the terminal — in the settings file or on a saved plan — through the real pool. */
describe('OrchestratorPool after the transport setting was removed', () => {
  let dir: string;
  let workspace: string;
  let saved: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-pool-transport-'));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-pool-transport-ws-'));
    fs.mkdirSync(path.join(workspace, '.git'));
    saved = process.env.ORDEWELL_SETTINGS_PATH;
    process.env.ORDEWELL_SETTINGS_PATH = path.join(dir, 'settings.json');
    fs.writeFileSync(process.env.ORDEWELL_SETTINGS_PATH, JSON.stringify({ tdd: { enabled: true }, verification: { enabled: true }, runnerTransport: 'terminal' }));
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.ORDEWELL_SETTINGS_PATH;
    else process.env.ORDEWELL_SETTINGS_PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  function runners() {
    const structured: FakeStructuredSession[] = [];
    const structuredRunner: ITerminalRunner = {
      spawn: vi.fn(async (opts: RunnerSpawnOptions) => {
        const session = new FakeStructuredSession(`s${structured.length + 1}`, opts.taskId);
        structured.push(session);
        return session;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    };
    const runner: ITerminalRunner = { spawn: vi.fn().mockRejectedValue(new Error('terminal runner unused')), stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
    return { runner, structuredRunner, structured };
  }

  it('reports neither removed setting, and a PATCH of either changes nothing', async () => {
    const app = new Hono();
    app.route('/api/settings', settingsRoute(new OrchestratorPool(runners())));

    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerTransport: 'terminal', verification: { enabled: true } }),
    });

    expect(res.status).toBe(200);
    const body = (await (await app.request('/api/settings')).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('runnerTransport');
    expect(body).not.toHaveProperty('verification');
  });

  it('runs a saved plan pinned to the terminal on the structured transport', async () => {
    const { runner, structuredRunner, structured } = runners();
    const pool = new OrchestratorPool({ runner, structuredRunner });
    const plan = {
      status: 'approved',
      runners: ['claude-code'],
      runnerTransport: 'terminal',
      generatedAt: '2026-10-01T10:00:00.000Z',
      tasks: [
        { id: 't1', order: 1, title: 'Add the limiter', type: 'ai', status: 'pending', description: 'd', dependencies: [], assignedRunner: 'claude-code', subtasks: [], prompt: 'do it' },
      ],
    } as unknown as LegacyPlanState;
    const meta = saveSession(plan, 'Rate limiting', workspace, 'session-pinned-terminal');
    pool.adoptSavedSession(meta.id, workspace);

    await pool.session(meta.id).runTask('t1');

    await vi.waitFor(() => expect(structured).toHaveLength(1));
    expect(runner.spawn).not.toHaveBeenCalled();
    expect(vi.mocked(structuredRunner.spawn).mock.calls[0][0].transport).toBe('structured');
  });
});
