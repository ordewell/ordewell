import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'fs';
import http from 'http';
import { ApiClient } from '../../apiClient';

interface RecordedBody {
  env?: Record<string, string>;
  [key: string]: unknown;
}
interface Recorded { method: string; url: string; body: RecordedBody }

/**
 * A stand-in daemon. Routes are matched the way the real one does; every
 * mutating request is recorded so a test can assert on what actually went on
 * the wire rather than on the message the command printed.
 */
async function fakeDaemon(state: {
  settings?: Record<string, unknown>;
  models?: unknown;
  runners?: unknown;
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
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(envDir, { recursive: true, force: true });
});

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

/** The daemon's runner list with every coding agent installed. */
const INSTALLED = {
  runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true }, { id: 'codex', name: 'Codex', enabled: true }, { id: 'opencode', name: 'OpenCode', enabled: true }],
  headless: false,
  orchestratorModel: '',
};

describe('ordewell planner', () => {
  it('sends only the provider — the daemon resolves the model, not the client', async () => {
    const d = await fakeDaemon({
      settings: { orchestratorModel: 'deepseek/deepseek-v4-flash', aiProvider: 'openrouter' },
      models: CATALOG,
      runners: INSTALLED,
    });
    const { handlePlanner } = await import('../planner');
    const { stdout } = await capture(() => handlePlanner(['claude-code'], new ApiClient(d.port)));

    const patch = d.sent.find((r) => r.method === 'PATCH')!;
    expect(patch.body.env).toEqual({ AI_PROVIDER: 'claude-code' });
    expect(stdout).toContain('no API key needed');
    d.close();
  });

  it('writes the daemon-returned model to .env, not an empty string', async () => {
    // The fake daemon's PATCH handler just merges the request body into its
    // settings and echoes them back, so presetting orchestratorModel here
    // stands in for "the daemon already resolved the switch to this model" —
    // the resolution itself is task 2's daemon-side memory, tested there.
    const d = await fakeDaemon({
      settings: {
        orchestratorModel: 'sonnet',
        plannerThinkingEffort: 'high',
        aiProvider: 'openrouter',
        switchRecall: { model: 'sonnet', effort: 'high', source: 'remembered' },
      },
      models: CATALOG,
      runners: INSTALLED,
    });
    const { handlePlanner } = await import('../planner');
    const { stdout } = await capture(() => handlePlanner(['claude-code'], new ApiClient(d.port)));

    const { readFileSync } = await import('fs');
    const { findEnvFile } = await import('../../utils/env');
    const env = readFileSync(findEnvFile(), 'utf8');
    expect(env).toContain('ORCHESTRATOR_MODEL=sonnet');
    expect(env).toContain('ORDEWELL_PLANNER_EFFORT=high');
    expect(stdout).toContain('Restored its planner model: sonnet.');
    d.close();
  });

  it('says so and points at `ordewell model set` when the daemon fell back to a catalog default', async () => {
    const d = await fakeDaemon({
      settings: { orchestratorModel: 'sonnet', aiProvider: 'openrouter', switchRecall: { model: 'sonnet', effort: '', source: 'catalog-default' } },
      models: CATALOG,
      runners: INSTALLED,
    });
    const { handlePlanner } = await import('../planner');
    const { stdout } = await capture(() => handlePlanner(['claude-code'], new ApiClient(d.port)));

    expect(stdout).toContain('Using sonnet, its default model');
    expect(stdout).toContain('ordewell model set');
    d.close();
  });

  it('keeps the "pick a model" guidance when the daemon resolved nothing', async () => {
    const d = await fakeDaemon({
      settings: { orchestratorModel: '', aiProvider: 'openrouter' },
      models: CATALOG,
      runners: INSTALLED,
    });
    const { handlePlanner } = await import('../planner');
    const { stdout } = await capture(() => handlePlanner(['claude-code'], new ApiClient(d.port)));

    expect(stdout).toContain('Pick a model with `ordewell model set <id>`');
    d.close();
  });

  it('refuses a coding agent that is not installed, naming the ones that are, without touching the daemon', async () => {
    const d = await fakeDaemon({ models: CATALOG, runners: { runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true }], headless: false, orchestratorModel: '' } });
    const { handlePlanner } = await import('../planner');
    const { stderr, exitCode } = await capture(() => handlePlanner(['codex'], new ApiClient(d.port)));
    expect(stderr).toContain('Codex is not installed');
    expect(stderr).toContain('claude-code');
    expect(exitCode).toBe(1);
    expect(d.sent).toEqual([]);
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
    expect(d.sent.find((r) => r.method === 'PATCH')!.body).toEqual({ ...{ orchestratorModel: 'sonnet' }, workspace: process.cwd() });
    d.close();
  });

  it('clears the effort in .env when the daemon did not report one, rather than writing "undefined"', async () => {
    const d = await fakeDaemon({ settings: { aiProvider: 'claude-code', plannerThinkingEffort: undefined }, models: CATALOG });
    const { handleModel } = await import('../model');
    await capture(() => handleModel(['set', 'sonnet'], new ApiClient(d.port)));

    const { readFileSync } = await import('fs');
    const { findEnvFile } = await import('../../utils/env');
    const env = readFileSync(findEnvFile(), 'utf8');
    expect(env).toContain('ORCHESTRATOR_MODEL=sonnet');
    expect(env).not.toContain('undefined');
    expect(process.env.ORDEWELL_PLANNER_EFFORT).toBe('');
    d.close();
  });

  it('refuses a vendor model for a coding-agent planner whose catalog is cold, pointing at the planner switch', async () => {
    const d = await fakeDaemon({ settings: { aiProvider: 'claude-code' } });
    const { handleModel } = await import('../model');
    const { stderr, exitCode } = await capture(() => handleModel(['set', 'openai/gpt-4o'], new ApiClient(d.port)));
    expect(stderr).toContain('openai/gpt-4o');
    expect(stderr).toContain('ordewell planner <id>');
    expect(exitCode).toBe(1);
    expect(d.sent).toEqual([]);
    d.close();
  });

  it('takes an OpenCode provider/model id while its catalog is cold, as OpenCode names its own models that way', async () => {
    const d = await fakeDaemon({ settings: { aiProvider: 'opencode' } });
    const { handleModel } = await import('../model');
    await capture(() => handleModel(['set', 'anthropic/claude-sonnet-4-5'], new ApiClient(d.port)));
    expect(d.sent.find((r) => r.method === 'PATCH')!.body).toEqual({ ...{ orchestratorModel: 'anthropic/claude-sonnet-4-5' }, workspace: process.cwd() });
    d.close();
  });

  it('does not scope a vendor planner to a runner catalog', async () => {
    const d = await fakeDaemon({ settings: { aiProvider: 'openrouter' }, models: CATALOG });
    const { handleModel } = await import('../model');
    await capture(() => handleModel(['set', 'anything/at-all'], new ApiClient(d.port)));
    expect(d.sent.find((r) => r.method === 'PATCH')!.body).toEqual({ ...{ orchestratorModel: 'anything/at-all' }, workspace: process.cwd() });
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

describe('ordewell parallel', () => {
  it('shows the limit the daemon runs with', async () => {
    const d = await fakeDaemon({ settings: { maxParallel: 3 } });
    const { handleParallel } = await import('../parallel');
    const { stdout } = await capture(() => handleParallel([], new ApiClient(d.port)));
    expect(stdout).toContain('Up to 3 AI tasks run at once');
    d.close();
  });

  it('sets it on the live daemon, with no ceiling', async () => {
    const d = await fakeDaemon();
    const { handleParallel } = await import('../parallel');
    const { stdout } = await capture(() => handleParallel(['12'], new ApiClient(d.port)));
    expect(d.sent.find((r) => r.method === 'PATCH')!.body.env).toEqual({ ORDEWELL_MAX_PARALLEL: '12' });
    expect(stdout).toContain('Up to 12 AI tasks now run at once.');
    d.close();
  });

  it('refuses anything but a whole number of at least 1, sending nothing', async () => {
    const d = await fakeDaemon();
    const { handleParallel } = await import('../parallel');
    const { stderr, exitCode } = await capture(() => handleParallel(['0'], new ApiClient(d.port)));
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Usage: ordewell parallel');
    expect(d.sent).toEqual([]);
    d.close();
  });
});

describe('ordewell auto (ADR-0030)', () => {
  it('saves the level in the user\'s settings, not in .env', async () => {
    const { join } = await import('path');
    const { existsSync, readFileSync } = await import('fs');
    vi.stubEnv('ORDEWELL_SETTINGS_PATH', join(envDir, 'settings.json'));
    vi.stubEnv('ORDEWELL_AUTONOMOUS_MODE', '');
    const { handleAuto } = await import('../runners');
    const { SettingsService } = await import('@ordewell/core');

    const { stdout } = await capture(() => handleAuto(['guarded']));

    expect(new SettingsService().autonomousMode()).toBe(false);
    expect(stdout).toContain('Autonomy level: Guarded for new plans.');
    const env = join(envDir, '.ordewell', '.env');
    expect(existsSync(env) ? readFileSync(env, 'utf8') : '').not.toContain('ORDEWELL_AUTONOMOUS_MODE');
  });
});

describe('ordewell supervisor, automerge, trailer and autorun (ADR-0030)', () => {
  const RUN = { supervisorLevel: 'watch', mergeAtGatesAutomatically: false, plannedWithTrailer: true, autorun: false, supervisorRetryLimit: 2, wakeUpReadBudget: 12 };

  it('shows the user\'s run settings', async () => {
    const d = await fakeDaemon({ settings: { run: { ...RUN, supervisorLevel: 'act', supervisorRetryLimit: 1 } } });
    const { handleSupervisor, handleAutomerge, handleAutorun, handleTrailer } = await import('../runSettings');
    const supervisor = await capture(() => handleSupervisor([], new ApiClient(d.port)));
    const automerge = await capture(() => handleAutomerge([], new ApiClient(d.port)));
    const autorun = await capture(() => handleAutorun([], new ApiClient(d.port)));
    expect(supervisor.stdout).toContain('Supervisor: Act, 1 retry per task, 12 reads per wake-up');
    expect(automerge.stdout).toContain('Merge automatically (gates, end of run): off');
    expect(autorun.stdout).toContain('Autorun: off');
    expect((await capture(() => handleTrailer([], new ApiClient(d.port)))).stdout).toContain('Planned-with line in commits Ordewell writes: on');
    expect(d.sent).toEqual([]);
    d.close();
  });

  it.each([
    [['act'], 'handleSupervisor', { supervisorLevel: 'act' }],
    [['retries', '3'], 'handleSupervisor', { supervisorRetryLimit: 3 }],
    [['reads', '20'], 'handleSupervisor', { wakeUpReadBudget: 20 }],
    [['on'], 'handleAutomerge', { mergeAtGatesAutomatically: true }],
    [['on'], 'handleAutorun', { autorun: true }],
    [['off'], 'handleTrailer', { plannedWithTrailer: false }],
    [['on'], 'handleTrailer', { plannedWithTrailer: true }],
  ] as const)('saves %j through %s', async (args, handler, run) => {
    const d = await fakeDaemon({ settings: { run: RUN } });
    const commands = await import('../runSettings');
    await capture(() => commands[handler]([...args], new ApiClient(d.port)));
    expect(d.sent.find((r) => r.method === 'PATCH')!.body).toEqual({ run, workspace: process.cwd() });
    d.close();
  });

  it('says a run setting change is the default for new sessions, not every open one', async () => {
    const d = await fakeDaemon({ settings: { run: RUN } });
    const { handleSupervisor, handleAutomerge } = await import('../runSettings');
    const supervisor = await capture(() => handleSupervisor(['act'], new ApiClient(d.port)));
    const automerge = await capture(() => handleAutomerge(['on'], new ApiClient(d.port)));

    expect(supervisor.stdout).toContain('for new sessions');
    expect(automerge.stdout).toContain('for new sessions');
    expect(supervisor.stdout).not.toContain("each session's next run");
    expect(automerge.stdout).not.toContain("each session's next run");
    d.close();
  });

  it('turns delegation on with the tree\'s budget, and off again, saying what it accepts', async () => {
    const d = await fakeDaemon({ settings: { run: { ...RUN, delegationTokens: 0 } } });
    const { handleDelegation } = await import('../runSettings');

    const shown = await capture(() => handleDelegation([], new ApiClient(d.port)));
    expect(shown.stdout).toContain('Delegation: off');
    expect(d.sent).toEqual([]);

    const on = await capture(() => handleDelegation(['5000000'], new ApiClient(d.port)));
    expect(d.sent.at(-1)?.body).toMatchObject({ run: { delegationTokens: 5000000 } });
    expect(on.stdout).toContain('Delegation: on, 5000000 tokens for a tree');
    expect(on.stdout).toMatch(/a plan nobody read/);

    const off = await capture(() => handleDelegation(['off'], new ApiClient(d.port)));
    expect(d.sent.at(-1)?.body).toMatchObject({ run: { delegationTokens: 0 } });
    expect(off.stdout).toContain('Delegation: off');
    expect(off.stdout).not.toMatch(/a plan nobody read/);
    d.close();
  });

  it('says what Act and autorun allow when it turns them on', async () => {
    const d = await fakeDaemon({ settings: { run: RUN } });
    const { handleSupervisor, handleAutorun } = await import('../runSettings');
    expect((await capture(() => handleSupervisor(['act'], new ApiClient(d.port)))).stdout).toMatch(/ops tasks included/);
    expect((await capture(() => handleAutorun(['on'], new ApiClient(d.port)))).stdout).toMatch(/without review, ops tasks included/);
    d.close();
  });

  it.each([
    ['handleSupervisor', ['boss']], ['handleSupervisor', ['reads', '0']], ['handleSupervisor', ['retries', 'many']],
    ['handleAutomerge', ['maybe']], ['handleAutorun', ['yes']], ['handleTrailer', ['sometimes']],
    ['handleDelegation', ['on']], ['handleDelegation', ['0']], ['handleDelegation', ['1.5']],
  ] as const)('%s refuses %j, sending nothing', async (handler, args) => {
    const d = await fakeDaemon({ settings: { run: RUN } });
    const commands = await import('../runSettings');
    const { exitCode } = await capture(() => commands[handler]([...args], new ApiClient(d.port)));
    expect(exitCode).toBe(1);
    expect(d.sent).toEqual([]);
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
