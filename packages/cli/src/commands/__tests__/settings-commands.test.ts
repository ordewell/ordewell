import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { ApiClient } from '../../apiClient';

interface Recorded { method: string; url: string; body: any }

/**
 * A stand-in daemon. Routes are matched the way the real one does; every
 * mutating request is recorded so a test can assert on what actually went on
 * the wire rather than on the message the command printed.
 */
async function fakeDaemon(state: {
  settings?: Record<string, unknown>;
  models?: any;
  runners?: any;
} = {}): Promise<{ port: number; close: () => void; sent: Recorded[] }> {
  const sent: Recorded[] = [];
  const settings = {
    orchestratorModel: '',
    aiProvider: 'openrouter',
    plannerThinkingEffort: '',
    modelAllowlist: {},
    ...state.settings,
  };

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

      if (req.url?.startsWith('/api/settings')) {
        if (req.method === 'PATCH') Object.assign(settings, body ?? {});
        return json(settings);
      }
      if (req.url?.startsWith('/api/models')) {
        return json(state.models ?? { models: [], modelsByRunner: {}, providers: [], orchestratorModels: [] });
      }
      if (req.url?.startsWith('/api/runners')) {
        return json(state.runners ?? { runners: [], headless: false, orchestratorModel: '' });
      }
      if (req.url?.includes('/api/sessions/')) {
        return json({
          meta: { id: 'session-1', goal: 'g', runners: [], taskCount: 0, status: 'planned', createdAt: '', updatedAt: '' },
          plan: state.settings?.__plan ?? { tasks: [] },
        });
      }
      return json({ ok: true });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return { port: typeof addr === 'object' && addr ? addr.port : 0, close: () => server.close(), sent };
}

async function capture(fn: () => Promise<void> | void) {
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

// Every settings command persists to `.env`; point that at a scratch file so a
// test run cannot rewrite the developer's real one.
let envDir: string;
beforeEach(async () => {
  const { mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  envDir = mkdtempSync(join(tmpdir(), 'ordewell-cli-test-'));
  vi.stubEnv('HOME', envDir);
});
afterEach(() => { vi.unstubAllEnvs(); });

const CATALOG = {
  models: [
    { modelId: 'sonnet', modelLabel: 'Sonnet', variants: [{ id: 'high', label: 'High' }] },
    { modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex' },
  ],
  modelsByRunner: {
    'claude-code': [{ modelId: 'sonnet' }],
    codex: [{ modelId: 'gpt-5-codex' }],
  },
  providers: ['openrouter'],
  orchestratorModels: [{ id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' }],
  modesByRunner: { 'claude-code': [{ id: 'build', label: 'Build' }, { id: 'plan', label: 'Plan' }] },
};

describe('ordewell planner', () => {
  it('clears the planner model and its effort when the new backend cannot serve it', async () => {
    const d = await fakeDaemon({
      settings: { orchestratorModel: 'deepseek/deepseek-v4-flash', aiProvider: 'openrouter' },
      models: CATALOG,
    });
    const { handlePlanner } = await import('../planner');
    const { stdout } = await capture(() => handlePlanner(['claude-code'], new ApiClient(d.port)));

    const patch = d.sent.find((r) => r.method === 'PATCH')!;
    expect(patch.body.env).toEqual({
      AI_PROVIDER: 'claude-code',
      ORCHESTRATOR_MODEL: '',
      ORDEWELL_PLANNER_EFFORT: '',
    });
    expect(stdout).toContain('no API key needed');
    d.close();
  });

  it('keeps a planner model the new backend does serve', async () => {
    const d = await fakeDaemon({
      settings: { orchestratorModel: 'sonnet', aiProvider: 'codex' },
      models: CATALOG,
    });
    const { handlePlanner } = await import('../planner');
    await capture(() => handlePlanner(['claude-code'], new ApiClient(d.port)));

    const patch = d.sent.find((r) => r.method === 'PATCH')!;
    expect(patch.body.env).toEqual({ AI_PROVIDER: 'claude-code' });
    d.close();
  });

  it('refuses an unknown planner without touching the daemon', async () => {
    const d = await fakeDaemon();
    const { handlePlanner } = await import('../planner');
    const { stderr, exitCode } = await capture(() => handlePlanner(['gpt-9'], new ApiClient(d.port)));
    expect(stderr).toContain('Unknown planner: gpt-9');
    expect(exitCode).toBe(1);
    expect(d.sent).toEqual([]);
    d.close();
  });
});

describe('ordewell model', () => {
  it('refuses a model the harness planner runner was not discovered with', async () => {
    const d = await fakeDaemon({ settings: { aiProvider: 'claude-code' }, models: CATALOG });
    const { handleModel } = await import('../model');
    const { stderr, exitCode } = await capture(() => handleModel(['set', 'gpt-5-codex'], new ApiClient(d.port)));
    expect(stderr).toContain('was not discovered for claude-code');
    expect(exitCode).toBe(1);
    expect(d.sent).toEqual([]);
    d.close();
  });

  it('pushes an accepted model to the daemon', async () => {
    const d = await fakeDaemon({ settings: { aiProvider: 'claude-code' }, models: CATALOG });
    const { handleModel } = await import('../model');
    await capture(() => handleModel(['set', 'sonnet'], new ApiClient(d.port)));
    expect(d.sent.find((r) => r.method === 'PATCH')!.body).toEqual({ orchestratorModel: 'sonnet' });
    d.close();
  });

  it('does not scope a vendor planner to a runner catalog', async () => {
    const d = await fakeDaemon({ settings: { aiProvider: 'openrouter' }, models: CATALOG });
    const { handleModel } = await import('../model');
    await capture(() => handleModel(['set', 'anything/at-all'], new ApiClient(d.port)));
    expect(d.sent.find((r) => r.method === 'PATCH')!.body).toEqual({ orchestratorModel: 'anything/at-all' });
    d.close();
  });
});

describe('ordewell planner-effort', () => {
  it('refuses when the planner is a vendor, which has no effort knob', async () => {
    const d = await fakeDaemon({ settings: { aiProvider: 'openrouter' }, models: CATALOG });
    const { handlePlannerEffort } = await import('../planner');
    const { stderr, exitCode } = await capture(() => handlePlannerEffort(['high'], new ApiClient(d.port)));
    expect(stderr).toContain('coding-agent planner');
    expect(exitCode).toBe(1);
    d.close();
  });

  it('accepts a level the selected model actually exposes', async () => {
    const d = await fakeDaemon({ settings: { aiProvider: 'claude-code', orchestratorModel: 'sonnet' }, models: CATALOG });
    const { handlePlannerEffort } = await import('../planner');
    await capture(() => handlePlannerEffort(['high'], new ApiClient(d.port)));
    expect(d.sent.find((r) => r.method === 'PATCH')!.body.env).toEqual({ ORDEWELL_PLANNER_EFFORT: 'high' });
    d.close();
  });

  it('rejects a level that model does not expose', async () => {
    const d = await fakeDaemon({ settings: { aiProvider: 'claude-code', orchestratorModel: 'sonnet' }, models: CATALOG });
    const { handlePlannerEffort } = await import('../planner');
    const { stderr, exitCode } = await capture(() => handlePlannerEffort(['ultra'], new ApiClient(d.port)));
    expect(stderr).toContain('Unknown effort: ultra');
    expect(exitCode).toBe(1);
    d.close();
  });
});

describe('ordewell key', () => {
  it('stores the key under the provider env var and never prints it', async () => {
    const d = await fakeDaemon({ models: CATALOG });
    const { handleKey } = await import('../key');
    const { stdout } = await capture(() => handleKey(['set', 'openrouter', 'sk-or-secret'], new ApiClient(d.port)));
    expect(d.sent.find((r) => r.method === 'PATCH')!.body.env).toEqual({ OPENROUTER_API_KEY: 'sk-or-secret' });
    expect(stdout).not.toContain('sk-or-secret');
    expect(stdout).toContain('OPENROUTER_API_KEY');
    d.close();
  });
});

describe('ordewell runners', () => {
  const runners = { runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true }], headless: false, orchestratorModel: '' };

  it('toggles a known runner', async () => {
    const d = await fakeDaemon({ runners });
    const { handleRunners } = await import('../runners');
    await capture(() => handleRunners(['claude-code', 'off'], new ApiClient(d.port)));
    expect(d.sent.find((r) => r.method === 'PUT')!.body).toEqual({ enabled: false });
    d.close();
  });

  it('flips the current state when no on/off is given', async () => {
    const d = await fakeDaemon({ runners });
    const { handleRunners } = await import('../runners');
    await capture(() => handleRunners(['claude-code'], new ApiClient(d.port)));
    expect(d.sent.find((r) => r.method === 'PUT')!.body).toEqual({ enabled: false });
    d.close();
  });

  it('refuses a runner this daemon does not know', async () => {
    const d = await fakeDaemon({ runners });
    const { handleRunners } = await import('../runners');
    const { stderr, exitCode } = await capture(() => handleRunners(['aider', 'on'], new ApiClient(d.port)));
    expect(stderr).toContain('Unknown runner: aider');
    expect(exitCode).toBe(1);
    d.close();
  });
});
