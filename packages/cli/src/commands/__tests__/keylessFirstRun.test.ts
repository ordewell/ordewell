import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import https from 'https';
import type { AddressInfo } from 'net';
import type { SpawnFn } from '@ordewell/core';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { basename, delimiter, join } from 'path';

// Core from source, so the process boundary below is the very `spawn` the
// planner's agent is started through; the built bundle's cannot be replaced.
vi.mock('@ordewell/core', () => import('../../../../core/src/index'));

const boundary = vi.hoisted(() => ({ claude: null as SpawnFn | null }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const spawn = ((command: string, args: string[], options: Parameters<SpawnFn>[2]) =>
    boundary.claude && basename(command, '.exe') === 'claude'
      ? boundary.claude(command, args, options)
      : actual.spawn(command, args, options)) as typeof actual.spawn;
  return { ...actual, spawn, default: { ...actual, spawn } };
});

import {
  ModelResolver, SettingsService, clearAugmentedPathCache, getProviderMeta, mintDaemonToken, recordInstalledPlanner,
  resetInstalledPlanner, detectInstalledPlanner, installedPlannerDetected, saveSession, loadSession, createTask, PROVIDER_DETECT_PRIORITY, type IRunner, type LegacyPlanState, type PlannerUsability,
} from '@ordewell/core';
import { fakeSpawn, type FakeAgentProcess } from '../../../../core/src/services/__tests__/harnessTestKit';
import { attachWsHandler, createApp } from '../../../../web/server/app';
import { createRequestListener } from '../../../../web/server/nodeAdapter';
import { WebConfig } from '../../../../web/server/adapters/WebConfig';
import { OrchestratorPool } from '../../../../web/server/pool/orchestratorPool';
import { ApiClient } from '../../apiClient';
import { handlePlan } from '../plan';
import { handleCompact } from '../conversation';
import { plansRoute } from '../../../../web/server/routes/plans';
import { FakeRunnerSession, flushMicrotasks, homeEnv, setEnv, writeStandIn } from '@ordewell/core/testing';
import type { WebSocket } from 'ws';

/** Discovery that never spawns a CLI or reaches the network. */
function inertResolver(): ModelResolver {
  const registry = { getManifest: () => undefined } as unknown as ConstructorParameters<typeof ModelResolver>[0];
  return new ModelResolver(registry, new WebConfig(), {
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'openai/gpt-4o', name: 'Old vendor model' }] })),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((answer) => { resolve = answer; });
  return { promise, resolve };
}

function answer(proc: FakeAgentProcess, text = 'Which database?'): void {
  proc.emitStdout([
    { type: 'assistant', session_id: 'keyless', message: { id: 'reply', role: 'assistant', content: [{ type: 'text', text }] } },
    { type: 'result', subtype: 'success', session_id: 'keyless', is_error: false, result: text },
  ].map((frame) => JSON.stringify(frame)).join('\n') + '\n');
}

// Only the process, model discovery and runner boundaries are replaced: the
// CLI, HTTP contract, Session, planner transport and Claude adapter all run.
describe('keyless first-run entry points at the process boundary', () => {
  const keys = ['PATH', 'ORDEWELL_SETTINGS_PATH', 'AI_PROVIDER', 'ORCHESTRATOR_MODEL', 'ORDEWELL_PLANNER_EFFORT'];
  const saved: Record<string, string | undefined> = {};
  let restoreHome: () => void;
  let dir: string;
  let workspace: string;
  let pool: OrchestratorPool;
  let server: http.Server;
  let client: ApiClient;
  let argvs: string[][];
  let prompts: string[];
  let vendorBase: string;
  let vendorRequests: { authorization: string | undefined; body: string }[];
  let respond: (chunk: string, proc: FakeAgentProcess) => void;
  let runner: IRunner;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ordewell-inherited-model-'));
    workspace = join(dir, 'ws');
    mkdirSync(join(workspace, '.git'), { recursive: true });
    for (const key of keys) saved[key] = process.env[key];
    for (const provider of PROVIDER_DETECT_PRIORITY) {
      const meta = getProviderMeta(provider);
      for (const key of [...meta.detectEnvVars, meta.baseUrlEnvVar]) {
        if (!key) continue;
        saved[key] = process.env[key];
        delete process.env[key];
      }
    }
    restoreHome = setEnv(homeEnv(dir));
    process.env.ORDEWELL_SETTINGS_PATH = join(dir, 'settings.json');
    delete process.env.AI_PROVIDER;
    delete process.env.ORDEWELL_PLANNER_EFFORT;
    process.env.ORCHESTRATOR_MODEL = 'openai/gpt-4o';

    // The spawn is faked, but the binary must still resolve on PATH first.
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeStandIn(bin, 'claude');
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
    clearAugmentedPathCache();

    argvs = [];
    prompts = [];
    vendorRequests = [];
    vi.spyOn(https, 'request').mockImplementation(() => { throw new Error('Unexpected external HTTPS request'); });
    respond = (_chunk, proc) => answer(proc);
    const fake = fakeSpawn([]);
    boundary.claude = (command, args, options) => {
      argvs.push(args);
      const proc = fake.spawn(command, args, options) as unknown as FakeAgentProcess;
      // The kit answers the control traffic; a user turn is answered here.
      proc.on('__written', (chunk: string) => {
        if (chunk.includes('"type":"user"')) {
          prompts.push(chunk);
          respond(chunk, proc);
        }
      });
      return proc;
    };

    recordInstalledPlanner('claude-code');
    runner = { activeCount: 0, spawn: vi.fn(async (opts) => new FakeRunnerSession('task-run', opts.taskId)), stop: vi.fn(), stopAll: vi.fn() };
    pool = new OrchestratorPool({
      accountLimitCollectors: () => [],
      modelResolver: inertResolver(),
      runner,
      runnerInstallation: { plannerUsability: async () => ({ usable: true as const }), filterInstalled: async (ids: string[]) => ids.filter((id) => id === 'claude-code') },
      codexSandbox: { ensure: async () => undefined, refresh: async () => undefined },
    } as unknown as ConstructorParameters<typeof OrchestratorPool>[0]);
    server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const { token, file } = mintDaemonToken(port);
    const admission = { port, token, tokenFile: file };
    vendorBase = `http://127.0.0.1:${port}/vendor`;
    const daemonListener = createRequestListener(createApp(pool, admission), admission);
    server.on('request', async (req, res) => {
      if (!req.url?.startsWith('/vendor/')) { daemonListener(req, res); return; }
      let body = '';
      for await (const chunk of req) body += String(chunk);
      vendorRequests.push({ authorization: req.headers.authorization, body });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Which database?' }, finish_reason: null }] }) + '\n\ndata: [DONE]\n\n');
    });
    attachWsHandler(server, pool, admission);
    client = new ApiClient(port, workspace);
  });

  afterEach(async () => {
    boundary.claude = null;
    pool.destroyAll();
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    resetInstalledPlanner();
    clearAugmentedPathCache();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    restoreHome();
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Runs the command as `main` would, with `process.exit` turned into a value. */
  async function run(args: string[], command: 'plan' | 'compact' = 'plan'): Promise<{ stderr: string; exitCode: number | null }> {
    const errs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errs.push(parts.join(' ')); });
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
    let exitCode: number | null = null;
    try {
      if (command === 'compact') await handleCompact(args, client);
      else await handlePlan(args, { api: client });
    } catch (err) {
      const match = /^exit:(\d+)$/.exec(err instanceof Error ? err.message : '');
      if (!match) throw err;
      exitCode = Number(match[1]);
    } finally {
      vi.restoreAllMocks();
    }
    return { stderr: errs.join('\n'), exitCode };
  }

  function savePlan(id: string, over: Partial<LegacyPlanState> = {}): LegacyPlanState {
    const timestamp = '2026-10-10T10:00:00.000Z';
    const plan: LegacyPlanState = {
      tasks: [1, 2].map((n) => createTask({ id: `t${n}`, order: n, title: `Task ${n}`, prompt: `Implement ${n}`, assignedRunner: 'claude-code' })),
      generatedAt: timestamp, lastUpdated: timestamp, status: 'draft', runners: ['claude-code'],
      conversationHistory: Array.from({ length: 8 }, (_, n) => ({ role: n % 2 ? 'assistant' as const : 'user' as const, content: `exchange ${n}`, timestamp })),
      ...over,
    };
    saveSession(plan, 'Build a cache', workspace, id);
    return plan;
  }

  function pending(source: 'user' | 'supervisor' = 'user') {
    return [{ id: 'pending-1', source, text: source === 'user' ? 'Use Postgres' : 'Task t1 failed; inspect it', timestamp: '2026-10-10T10:01:00.000Z' }];
  }

  function probe() {
    const gate = deferred<PlannerUsability>();
    const detection = detectInstalledPlanner({ plannerUsability: () => gate.promise });
    return { detection, answer: (usable = true) => gate.resolve(usable ? { usable: true } : { usable: false, reason: 'not installed' }) };
  }

  function ended(id: string) {
    const gate = deferred<void>();
    pool.subscribe(id, { OPEN: 1, readyState: 1, send: (payload: string) => {
      const message = JSON.parse(payload) as { type: string };
      if (message.type === 'planner_turn_ended') gate.resolve();
    } } as unknown as WebSocket);
    return gate.promise;
  }

  async function route(id: string, path: string, body?: unknown): Promise<Response> {
    return plansRoute(pool).request(`/${id}/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it('keeps restored user input idle after detection, then sends it with a new message and persists its removal', async () => {
    savePlan('restored', { pendingTurns: pending() });
    const detection = probe();
    const landed = ended('restored');
    await client.adoptSession('restored', workspace);
    expect(argvs).toEqual([]);
    expect(loadSession('restored', workspace)?.plan.pendingTurns?.map((t) => t.text)).toEqual(['Use Postgres']);

    detection.answer();
    await detection.detection;
    await flushMicrotasks(100);
    expect(argvs).toEqual([]);
    await client.sendConversationMessage('restored', 'go on');
    await landed;

    expect(argvs).toHaveLength(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Use Postgres');
    expect(prompts[0]).toContain('go on');
    expect(pool.getPlan('restored')?.pendingTurns ?? []).toEqual([]);
    expect(loadSession('restored', workspace)?.plan.pendingTurns ?? []).toEqual([]);
    await client.adoptSession('restored', workspace);
    expect(prompts).toHaveLength(1);
  });

  it('retains restored input on disk when the latest probe finds no usable planner', async () => {
    savePlan('not-ready', { pendingTurns: pending() });
    const detection = probe();
    await client.adoptSession('not-ready', workspace);
    detection.answer(false);
    await detection.detection;
    await flushMicrotasks(100);

    expect(argvs).toEqual([]);
    expect(loadSession('not-ready', workspace)?.plan.pendingTurns?.map((t) => t.text)).toEqual(['Use Postgres']);
    expect(pool.getPlan('not-ready')?.pendingTurns?.map((t) => t.text)).toEqual(['Use Postgres']);
  });

  for (const source of ['user', 'supervisor'] as const) {
    it(`loading restored ${source} input leaves no live turn to Stop, and autorun never spawns`, async () => {
      pool.updateRunSettings({ autorun: true, supervisorLevel: 'watch' });
      savePlan('stopped', { pendingTurns: pending(source), runSettings: { mergeAtGatesAutomatically: false, supervisorLevel: 'watch' } });
      const detection = probe();
      await client.adoptSession('stopped', workspace);

      expect(await client.cancelPlanning('stopped')).toEqual({ cancelled: false });
      detection.answer();
      await detection.detection;
      await installedPlannerDetected();
      await flushMicrotasks(100);

      expect(argvs).toEqual([]);
      expect(runner.spawn).not.toHaveBeenCalled();
      expect(loadSession('stopped', workspace)?.plan.pendingTurns).toEqual(pending(source));
      expect(await client.cancelPlanning('stopped')).toEqual({ cancelled: false });
    });
  }

  it('a first goal stopped at the gate spawns nothing, and the next goal reaches stdin', async () => {
    const detection = probe();
    const first = pool.startPlanning('opening', 'Do not run this goal', ['claude-code'], workspace);
    const refused = expect(first).rejects.toThrow();
    expect(await client.cancelPlanning('opening')).toEqual({ cancelled: true });
    await refused;
    const second = pool.startPlanning('opening', 'Build a ledger', ['claude-code'], workspace);
    detection.answer();
    await second;

    expect(argvs).toHaveLength(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Build a ledger');
    expect(prompts[0]).not.toContain('Do not run this goal');
    expect(runner.spawn).not.toHaveBeenCalled();
  });

  it('a newer probe frees a waiting goal while the older probe remains unresolved, and a late old answer cannot undo it', async () => {
    const old = probe();
    const planning = pool.startPlanning('racing', 'Build a ledger', ['claude-code'], workspace);
    const newest = probe();
    newest.answer();
    await newest.detection;
    await planning;
    expect(argvs).toHaveLength(1);

    old.answer(false);
    await old.detection;
    expect(await client.getSettings()).toMatchObject({ aiProvider: 'claude-code' });
    await client.sendConversationMessage('racing', 'Use Postgres');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Use Postgres');
  });

  it('a late old probe cannot free a waiter parked behind a newer unfinished probe', async () => {
    const old = probe();
    const planning = pool.startPlanning('newest', 'Build a ledger', ['claude-code'], workspace);
    const newest = probe();
    old.answer(false);
    await old.detection;
    await flushMicrotasks(100);
    expect(argvs).toEqual([]);
    newest.answer();
    await planning;
    expect(argvs).toHaveLength(1);
  });

  it('holds a saved supervisor wake-up until user input reaches the same gate and adapter', async () => {
    savePlan('supervisor', { pendingTurns: pending('supervisor'), runSettings: { mergeAtGatesAutomatically: false, supervisorLevel: 'watch' } });
    const detection = probe();
    const landed = ended('supervisor');
    await client.adoptSession('supervisor', workspace);
    expect(argvs).toEqual([]);
    detection.answer();
    await detection.detection;
    await flushMicrotasks(100);
    expect(argvs).toEqual([]);
    await client.sendConversationMessage('supervisor', 'what happened?');
    await landed;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Task t1 failed; inspect it');
    expect(runner.spawn).not.toHaveBeenCalled();
  });

  for (const action of ['force-send', 'compact'] as const) {
    it(`${action} is refused by the real route before spawning when the selected vendor has no key`, async () => {
      savePlan('refusal');
      await client.adoptSession('refusal', workspace);
      process.env.AI_PROVIDER = 'openai';
      process.env.ORCHESTRATOR_MODEL = 'gpt-4o';
      process.env.OPENROUTER_API_KEY = 'other-provider-key';
      const response = action === 'force-send' ? await route('refusal', 'converse/message/now', { message: 'Use Postgres' })
        : await route('refusal', 'conversation/compact');

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'planner_not_ready', plannerNotReady: { provider: 'openai', keyEnvVar: 'OPENAI_API_KEY' } });
      expect(argvs).toEqual([]);
      expect(runner.spawn).not.toHaveBeenCalled();
    });
  }

  for (const action of ['force-send', 'compact'] as const) {
    it(`${action} waits for detection and then reaches the real Claude adapter`, async () => {
      if (action === 'compact') respond = (_chunk, proc) => answer(proc, '<conversation_summary>Build a ledger; database undecided.</conversation_summary>');
      savePlan('waiting');
      await client.adoptSession('waiting', workspace);
      const detection = probe();
      const response = action === 'force-send' ? route('waiting', 'converse/message/now', { message: 'Use Postgres' })
        : route('waiting', 'conversation/compact');
      await flushMicrotasks(100);
      expect(argvs).toEqual([]);
      detection.answer();
      const result = await response;
      const body: unknown = await result.json();
      expect(result.status, JSON.stringify(body)).toBe(200);
      expect(argvs).toHaveLength(1);
      expect(argvs[0]).not.toContain('--model');
      expect(prompts).toHaveLength(1);
      expect(prompts[0].toLowerCase()).toContain(action === 'force-send' ? 'postgres' : action === 'compact' ? 'conversation_summary' : action);
    });
  }

  it('headless compact prints shell commands for the core readiness refusal', async () => {
    savePlan('compact');
    process.env.AI_PROVIDER = 'openai';
    process.env.ORCHESTRATOR_MODEL = 'gpt-4o';
    process.env.OPENROUTER_API_KEY = 'other-provider-key';
    const result = await run(['--session-id', 'compact', '--workspace', workspace], 'compact');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ordewell planner <id>');
    expect(result.stderr).toContain('ordewell key set openai <key>');
    expect(result.stderr).not.toContain('/planner');
    expect(argvs).toEqual([]);
  });

  it('a per-request model reaches argv through the generate route without replacing the remembered choice', async () => {
    process.env.ORCHESTRATOR_MODEL = '';
    new SettingsService().setPlannerModel('claude-code', { model: 'sonnet', effort: 'high' });
    respond = (_chunk, proc) => { proc.emitStderr('stopped at argv'); proc.exit(1); };
    await route('override', 'generate', { goal: 'Build a cache', runners: ['claude-code'], workspace, model: 'haiku' });
    const argv = argvs.at(-1) ?? [];
    expect(argv[argv.indexOf('--model') + 1]).toBe('haiku');
    expect(argv).not.toContain('--effort');
    expect(new SettingsService().getPlannerModel('claude-code')).toEqual({ model: 'sonnet', effort: 'high' });
  });

  it('a blank inherited model restores both model and effort through the real CLI', async () => {
    process.env.ORCHESTRATOR_MODEL = '';
    process.env.ORDEWELL_PLANNER_EFFORT = 'low';
    new SettingsService().setPlannerModel('claude-code', { model: 'sonnet', effort: 'high' });
    respond = (_chunk, proc) => { proc.emitStderr('stopped at argv'); proc.exit(1); };
    await run(['--goal', 'Build a cache', '--runner', 'claude-code', '--no-chat', '--workspace', workspace]);
    const argv = argvs.at(-1) ?? [];
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
    expect(argv[argv.indexOf('--effort') + 1]).toBe('high');
  });

  it('an explicit pick of the detected planner survives a credential added to the same daemon', async () => {
    expect(await client.getSettings()).toMatchObject({ aiProvider: 'claude-code' });
    await client.updateSettings({ env: { AI_PROVIDER: 'claude-code' } });
    process.env.OPENROUTER_API_KEY = 'later-key';
    await client.startConversation('explicit', 'Build a cache', ['claude-code'], workspace);
    expect(process.env.AI_PROVIDER).toBe('claude-code');
    expect(argvs).toHaveLength(1);
    expect(prompts[0]).toContain('Build a cache');
  });
  it('a live daemon session follows key removal and replacement despite a previously discovered vendor list', async () => {
    process.env.OPENROUTER_API_KEY = 'old-router-key';
    process.env.OPENROUTER_BASE_URL = vendorBase;
    await pool.getProviderModels();
    await client.startConversation('credentials', 'Build a ledger', ['claude-code'], workspace);
    expect(vendorRequests).toHaveLength(1);
    expect(vendorRequests[0].authorization).toBe('Bearer old-router-key');
    expect(argvs).toEqual([]);

    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_BASE_URL;
    await client.sendConversationMessage('credentials', 'Use Postgres');
    expect(argvs).toHaveLength(1);
    expect(argvs[0]).not.toContain('--model');
    expect(prompts[0]).toContain('Use Postgres');
    expect(vendorRequests).toHaveLength(1);

    process.env.OPENROUTER_API_KEY = 'replacement-router-key';
    process.env.OPENROUTER_BASE_URL = vendorBase;
    await client.sendConversationMessage('credentials', 'Keep the ledger append-only');
    expect(vendorRequests).toHaveLength(2);
    expect(vendorRequests[1].authorization).toBe('Bearer replacement-router-key');
    expect(vendorRequests[1].body).toContain('Keep the ledger append-only');
  });

  it('a vendor model picked while its key was set never reaches the detected agent, and returns with the key', async () => {
    process.env.ORCHESTRATOR_MODEL = '';
    await client.updateSettings({ env: { OPENROUTER_API_KEY: 'test-key' } });
    await client.updateSettings({ orchestratorModel: 'openai/gpt-4o' });
    await client.updateSettings({ env: { OPENROUTER_API_KEY: '' } });
    expect(await client.getSettings()).toMatchObject({ aiProvider: 'claude-code', orchestratorModel: '' });

    await client.startConversation('picked', 'Build a cache', ['claude-code'], workspace);
    expect(argvs).toHaveLength(1);
    expect(argvs[0]).not.toContain('--model');
    expect(vendorRequests).toEqual([]);

    await client.updateSettings({ plannerThinkingEffort: 'high' });
    expect(new SettingsService().getPlannerModel('claude-code')).toBeUndefined();

    await client.updateSettings({ env: { OPENROUTER_API_KEY: 'test-key', OPENROUTER_BASE_URL: vendorBase } });
    expect(await client.getSettings()).toMatchObject({ aiProvider: 'openrouter', orchestratorModel: 'openai/gpt-4o' });
    await client.sendConversationMessage('picked', 'Use Postgres');
    expect(vendorRequests).toHaveLength(1);
    expect(JSON.parse(vendorRequests[0].body)).toMatchObject({ model: 'openai/gpt-4o' });
    expect(vendorRequests[0].body).toContain('Use Postgres');
  });

  it('a model picked for the detected agent is not sent to a vendor whose key is added later', async () => {
    await client.updateSettings({ orchestratorModel: 'sonnet' });
    await client.updateSettings({ env: { OPENROUTER_API_KEY: 'test-key', OPENROUTER_BASE_URL: vendorBase } });
    expect(await client.getSettings()).toMatchObject({ aiProvider: 'openrouter', orchestratorModel: '' });

    await expect(client.startConversation('agent-pick', 'Build a cache', ['claude-code'], workspace))
      .rejects.toMatchObject({ plannerNotReady: { code: 'no_model', provider: 'openrouter' } });
    expect(vendorRequests).toEqual([]);
    expect(argvs).toEqual([]);
  });

  it('a model picked for OpenRouter is not sent to Google when the key is swapped for a Gemini one', async () => {
    const outbound = vi.fn(async () => new Response('unexpected', { status: 500 }));
    const local = globalThis.fetch;
    vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      String(input instanceof Request ? input.url : input).startsWith('http://127.0.0.1:') ? local(input, init) : outbound());
    process.env.ORCHESTRATOR_MODEL = '';
    await client.updateSettings({ env: { OPENROUTER_API_KEY: 'test-key' } });
    await client.updateSettings({ orchestratorModel: 'openai/gpt-4o' });
    await client.updateSettings({ env: { OPENROUTER_API_KEY: '', GEMINI_API_KEY: 'gemini-key' } });
    expect(await client.getSettings()).toMatchObject({ aiProvider: 'google', orchestratorModel: '' });

    await expect(client.startConversation('swapped', 'Build a cache', ['claude-code'], workspace))
      .rejects.toMatchObject({ plannerNotReady: { code: 'no_model', provider: 'google' } });
    expect(outbound).not.toHaveBeenCalled();
  });

  for (const leftover of ['OPENROUTER_BASE_URL', 'GEMINI_BASE_URL']) {
    it(`a leftover ${leftover} without its key does not take planning from the detected agent`, async () => {
      process.env[leftover] = vendorBase;
      expect(await client.getSettings()).toMatchObject({ aiProvider: 'claude-code' });
      await client.startConversation('endpoint', 'Build a cache', ['claude-code'], workspace);
      expect(argvs).toHaveLength(1);
      expect(prompts[0]).toContain('Build a cache');
      expect(vendorRequests).toEqual([]);
    });
  }

  it('GET /api/runners reports the planner model that settings report and the spawn uses', async () => {
    process.env.ORCHESTRATOR_MODEL = '';
    await client.updateSettings({ orchestratorModel: 'claude-opus-5-5' });
    // Another surface sharing the settings file remembers a different pick.
    new SettingsService().setPlannerModel('claude-code', { model: 'sonnet', effort: '' });
    expect(await client.getSettings()).toMatchObject({ aiProvider: 'claude-code', orchestratorModel: 'claude-opus-5-5' });
    expect((await client.getRunners()).orchestratorModel).toBe('claude-opus-5-5');
    await client.startConversation('runners', 'Build a cache', ['claude-code'], workspace);
    expect(argvs[0][argvs[0].indexOf('--model') + 1]).toBe('claude-opus-5-5');
  });

  it('an openai_compatible endpoint with no key still plans through that endpoint', async () => {
    process.env.ORCHESTRATOR_MODEL = 'local-model';
    process.env.OPENAI_COMPATIBLE_BASE_URL = vendorBase;
    expect(await client.getSettings()).toMatchObject({ aiProvider: 'openai_compatible', orchestratorModel: 'local-model' });
    await client.startConversation('local', 'Build a cache', ['claude-code'], workspace);
    expect(argvs).toEqual([]);
    expect(vendorRequests).toHaveLength(1);
    expect(JSON.parse(vendorRequests[0].body)).toMatchObject({ model: 'local-model' });
  });

});
