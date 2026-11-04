import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import type { SpawnFn } from '@ordewell/core';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, delimiter, join } from 'path';

// Core from source, so the process boundary below is the very `spawn` each
// planner's agent is started through; the built bundle's cannot be replaced.
vi.mock('@ordewell/core', () => import('../../../../core/src/index'));

const boundary = vi.hoisted(() => ({ agents: new Map<string, SpawnFn>() }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const spawn = ((command: string, args: string[], options: Parameters<SpawnFn>[2]) => {
    const agent = boundary.agents.get(basename(command, '.exe'));
    return agent ? agent(command, args, options) : actual.spawn(command, args, options);
  }) as typeof actual.spawn;
  return { ...actual, spawn, default: { ...actual, spawn } };
});

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ModelResolver, OPENCODE_MANIFEST, SettingsService, clearAugmentedPathCache, getProviderMeta, mintDaemonToken,
  resetInstalledPlanner, PROVIDER_DETECT_PRIORITY, type IConfig, type IRunner,
} from '@ordewell/core';
import { ORDEWELL_MCP_SERVER_NAME } from '../../../../core/src/services/mcp';
import { fakeSpawn, planJson, respondingSpawn, sseResponse, type FakeAgentProcess } from '../../../../core/src/services/__tests__/harnessTestKit';
import { attachWsHandler, createApp } from '../../../../web/server/app';
import { createRequestListener } from '../../../../web/server/nodeAdapter';
import { OrchestratorPool } from '../../../../web/server/pool/orchestratorPool';
import { ApiClient } from '../../apiClient';
import { loadEnvFile } from '../../utils/env';
import { handlePlan } from '../plan';
import { homeEnv, setEnv, writeStandIn } from '@ordewell/core/testing';

/** What OpenCode's `opencode models` lists for this user: its own providers' ids, which share an OpenRouter slug's shape. */
const OPENCODE_CATALOG = ['opencode/deepseek-v4.1-flash', 'opencode-go/claude-haiku-5-5'];

/** Discovery that spawns nothing: OpenCode lists its catalog, and no other runner is asked. */
function catalogResolver(): ModelResolver {
  const registry = { getManifest: (id: string) => (id === 'opencode' ? OPENCODE_MANIFEST : undefined) } as unknown as ConstructorParameters<typeof ModelResolver>[0];
  const keyless = { getProviderApiKey: () => '', getProviderBaseUrl: () => '', setProviderModelLists: () => {}, openaiCompatibleBaseUrl: '' } as unknown as IConfig;
  return new ModelResolver(registry, keyless, {
    execImpl: async (command) => {
      if (command === 'opencode models') return { stdout: `${OPENCODE_CATALOG.join('\n')}\n` };
      throw new Error(`not run in this test: ${command}`);
    },
    fetchImpl: async () => new Response(JSON.stringify({ data: [] })),
  });
}

/** An agent submitting a plan through the Ordewell server it was handed, as the real agent's tool call does. */
async function submitPlan(server: { url: string; headers: Record<string, string> }): Promise<void> {
  const client = new Client({ name: 'fake-agent', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
  await client.callTool({ name: 'submit_plan', arguments: JSON.parse(planJson()) as Record<string, unknown> });
  await client.close();
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

/** `claude` that plans; records the `--model` each launch was given, or blank. */
function claudeAgent(models: string[]): SpawnFn {
  const fake = fakeSpawn([]);
  return (command, args, options) => {
    const at = args.indexOf('--model');
    models.push(at < 0 ? '' : args[at + 1]);
    const proc = fake.spawn(command, args, options) as unknown as FakeAgentProcess;
    proc.on('__written', (chunk: string) => {
      if (!chunk.includes('"type":"user"')) return;
      const config = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> };
      void submitPlan(config.mcpServers[ORDEWELL_MCP_SERVER_NAME]).then(() => {
        proc.emitStdout([
          { type: 'assistant', session_id: 'planned', message: { id: 'reply', role: 'assistant', content: [{ type: 'text', text: 'Plan submitted.' }] } },
          { type: 'result', subtype: 'success', session_id: 'planned', is_error: false, result: 'Plan submitted.' },
        ].map(line).join(''));
      });
    });
    return proc;
  };
}

interface CodexServer { url: string; env_http_headers: Record<string, string> }

/** `codex app-server` that plans; records the `model` each thread was started with, or blank. */
function codexAgent(models: string[]): SpawnFn {
  const envs = new Map<FakeAgentProcess, NodeJS.ProcessEnv>();
  const servers = new Map<FakeAgentProcess, CodexServer>();
  const spawned = respondingSpawn((written, proc) => {
    const msg = JSON.parse(written) as { id?: number; method?: string; params?: { model?: string; config?: { mcp_servers?: Record<string, CodexServer> } } };
    const reply = (result: unknown) => proc.emitStdout(line({ jsonrpc: '2.0', id: msg.id, result }));
    if (msg.method === 'initialize') {
      reply({ userAgent: { name: 'codex', version: '0.160.0' } });
    } else if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
      models.push(msg.params?.model ?? '');
      const server = msg.params?.config?.mcp_servers?.[ORDEWELL_MCP_SERVER_NAME];
      if (server) servers.set(proc, server);
      reply({ thread: { id: 'thr-1', status: { type: 'idle' }, turns: [] }, model: 'gpt-5.5', modelProvider: 'openai', cwd: '/repo' });
      if (server) proc.emitStdout(line({ jsonrpc: '2.0', method: 'mcpServer/startupStatus/updated', params: { name: ORDEWELL_MCP_SERVER_NAME, status: 'ready' } }));
    } else if (msg.method === 'skills/list' || msg.method === 'mcpServerStatus/list' || msg.method === 'model/list') {
      reply({ data: [], nextCursor: null });
    } else if (msg.method === 'turn/start') {
      reply({ turn: { id: 'turn-1', status: 'inProgress', items: [] } });
      proc.emitStdout(line({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thr-1', turn: { id: 'turn-1', status: 'inProgress', items: [] } } }));
      const server = servers.get(proc)!;
      const env = envs.get(proc) ?? {};
      const headers = Object.fromEntries(Object.entries(server.env_http_headers).map(([header, variable]) => [header, env[variable] ?? '']));
      void submitPlan({ url: server.url, headers }).then(() => {
        proc.emitStdout(line({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thr-1', turnId: 'turn-1', item: { id: 'item-1', type: 'agentMessage', text: 'Plan submitted.' } } }));
        proc.emitStdout(line({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: 'turn-1', status: 'completed', items: [] } } }));
      });
    }
  });
  return (command, args, options) => {
    const proc = spawned.spawn(command, args, options);
    envs.set(spawned.processes[spawned.processes.length - 1], options.env ?? {});
    return proc;
  };
}

const OPENCODE_BASE = 'http://127.0.0.1:4096';
const SES = 'ses_fake';

/**
 * `opencode serve` that plans, with the HTTP server it announces; records the
 * model each planner message asked for, as `provider/model`, or blank.
 */
function openCodeAgent(models: string[]): { spawn: SpawnFn; fetch: (input: string, init?: RequestInit) => Promise<Response> | undefined } {
  const fake = fakeSpawn([]);
  let config: { mcp?: Record<string, { url: string; headers: Record<string, string> }> } = {};
  const json = (body: unknown, status = 200) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  return {
    spawn: (command, args, options) => {
      config = JSON.parse(options.env?.OPENCODE_CONFIG_CONTENT ?? '{}') as typeof config;
      const proc = fake.spawn(command, args, options);
      queueMicrotask(() => fake.processes[fake.processes.length - 1].emitStdout(`opencode server listening on ${OPENCODE_BASE}\n`));
      return proc;
    },
    fetch: (input, init) => {
      if (!input.startsWith(OPENCODE_BASE)) return undefined;
      const path = input.slice(OPENCODE_BASE.length);
      const method = init?.method ?? 'GET';
      if (path === '/event') return Promise.resolve(sseResponse(init).response);
      if (path === '/api/info') return Promise.resolve(json({ error: 'not found' }, 404));
      if (method === 'POST' && path === '/session') return Promise.resolve(json({ id: SES }));
      if (path === '/mcp') return Promise.resolve(json({ [ORDEWELL_MCP_SERVER_NAME]: { status: 'connected' } }));
      if (method === 'POST' && path === `/session/${SES}/message`) {
        const body = JSON.parse(String(init?.body)) as { model?: { providerID: string; modelID: string } };
        models.push(body.model ? `${body.model.providerID}/${body.model.modelID}` : '');
        return submitPlan(config.mcp![ORDEWELL_MCP_SERVER_NAME]).then(() => json({
          info: { id: 'msg_reply', role: 'assistant', sessionID: SES },
          parts: [{ id: 'prt_reply', messageID: 'msg_reply', type: 'text', text: 'Plan submitted.' }],
        }));
      }
      if (path === '/session/status') return Promise.resolve(json({}));
      if (method === 'GET' && path.endsWith('/message')) return Promise.resolve(json([]));
      return Promise.resolve(json(true));
    },
  };
}

const AGENTS = ['claude-code', 'codex', 'opencode'] as const;
const BINARY = { 'claude-code': 'claude', codex: 'codex', opencode: 'opencode' } as const;

/**
 * The upgrade from an OpenRouter setup, headless, for each coding agent: the
 * agent is named with AI_PROVIDER, and `~/.ordewell/.env` still holds the old
 * vendor model, read by the CLI's own loader as `ordewell` does at startup.
 * The CLI, HTTP contract, pool, Session and planner transport all run; only
 * the agents, OpenCode's server and discovery are replaced. The one-shot
 * generation process must never be handed the slug, and the plan must land.
 */
describe('ordewell plan --no-chat with a named coding agent and a vendor model left in .env', () => {
  const keys = ['PATH', 'ORDEWELL_SETTINGS_PATH', 'AI_PROVIDER', 'ORCHESTRATOR_MODEL', 'ORDEWELL_PLANNER_EFFORT',
    'ORDEWELL_ENABLED_RUNNERS', 'ORDEWELL_CLAUDE_CODE_ENABLED', 'ORDEWELL_CODEX_ENABLED', 'ORDEWELL_OPENCODE_ENABLED'];
  const saved: Record<string, string | undefined> = {};
  let restoreHome: () => void;
  let dir: string;
  let workspace: string;
  let pool: OrchestratorPool;
  let server: http.Server;
  let client: ApiClient;
  let models: Record<(typeof AGENTS)[number], string[]>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ordewell-named-agent-model-'));
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
    for (const key of keys.slice(2)) delete process.env[key];
    restoreHome = setEnv(homeEnv(dir));
    process.env.ORDEWELL_SETTINGS_PATH = join(dir, 'settings.json');

    // The spawns are faked, but each binary must still resolve on PATH first.
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const agent of AGENTS) writeStandIn(bin, BINARY[agent]);
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
    clearAugmentedPathCache();

    models = { 'claude-code': [], codex: [], opencode: [] };
    const openCode = openCodeAgent(models.opencode);
    boundary.agents.set('claude', claudeAgent(models['claude-code']));
    boundary.agents.set('codex', codexAgent(models.codex));
    boundary.agents.set('opencode', openCode.spawn);
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => openCode.fetch(String(input), init) ?? realFetch(input, init));

    const runner: IRunner = { activeCount: 0, spawn: vi.fn(), stop: vi.fn(), stopAll: vi.fn() } as unknown as IRunner;
    pool = new OrchestratorPool({
      accountLimitCollectors: () => [],
      modelResolver: catalogResolver(),
      runner,
      runnerInstallation: { plannerUsability: async () => ({ usable: true as const }), filterInstalled: async (ids: string[]) => ids.filter((id) => (AGENTS as readonly string[]).includes(id)) },
      codexSandbox: { ensure: async () => undefined, refresh: async () => undefined },
    } as unknown as ConstructorParameters<typeof OrchestratorPool>[0]);
    server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const { token, file } = mintDaemonToken(port);
    const admission = { port, token, tokenFile: file };
    server.on('request', createRequestListener(createApp(pool, admission), admission));
    attachWsHandler(server, pool, admission);
    client = new ApiClient(port, workspace);
  });

  afterEach(async () => {
    boundary.agents.clear();
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
    vi.restoreAllMocks();
  });

  /** `~/.ordewell/.env` as an old OpenRouter setup left it, loaded the way `ordewell` loads it at startup. */
  function leftInEnvFile(model: string): void {
    mkdirSync(join(dir, '.ordewell'), { recursive: true });
    writeFileSync(join(dir, '.ordewell', '.env'), `ORCHESTRATOR_MODEL=${model}\n`);
    loadEnvFile();
  }

  /** Runs the command as `main` would, with `process.exit` turned into a value. */
  async function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const outs: string[] = [];
    const errs: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { outs.push(parts.join(' ')); });
    const error = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errs.push(parts.join(' ')); });
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
    let exitCode: number | null = null;
    try {
      await handlePlan(args, { api: client });
    } catch (err) {
      const match = /^exit:(\d+)$/.exec(err instanceof Error ? err.message : '');
      if (!match) throw err;
      exitCode = Number(match[1]);
    } finally {
      for (const spy of [log, error, write, exit]) spy.mockRestore();
    }
    return { stdout: outs.join('\n'), stderr: errs.join('\n'), exitCode };
  }

  for (const agent of AGENTS) {
    for (const leftover of ['openai/gpt-4o', 'deepseek/deepseek-v4-flash']) {
      it(`AI_PROVIDER=${agent}: generates with the agent's own default, not ${leftover}`, async () => {
        process.env.AI_PROVIDER = agent;
        leftInEnvFile(leftover);
        expect(process.env.ORCHESTRATOR_MODEL).toBe(leftover);

        const { stdout, stderr, exitCode } = await run(['--goal', 'Add a README', '--no-chat', '--workspace', workspace]);

        expect(exitCode, stderr).toBeNull();
        expect(stdout).toContain('Plan: 1 task');
        expect(models[agent].length).toBeGreaterThan(0);
        expect(models[agent].every((model) => model === ''), models[agent].join(', ')).toBe(true);
        expect(new SettingsService().getAll().plannerModels).toBeUndefined();
        expect(await client.getSettings()).toMatchObject({ aiProvider: agent, orchestratorModel: '' });
      });
    }
  }

  it('AI_PROVIDER=opencode: a model in OpenCode\'s own catalog left in .env is still what it plans with', async () => {
    process.env.AI_PROVIDER = 'opencode';
    leftInEnvFile('opencode-go/claude-haiku-5-5');

    const { stderr, exitCode } = await run(['--goal', 'Add a README', '--no-chat', '--workspace', workspace]);

    expect(exitCode, stderr).toBeNull();
    expect(models.opencode).toEqual(['opencode-go/claude-haiku-5-5']);
  });

  it('a model picked for the named agent in the running daemon is what generation sends', async () => {
    process.env.AI_PROVIDER = 'codex';
    leftInEnvFile('openai/gpt-4o');
    await client.updateSettings({ env: { AI_PROVIDER: 'codex' } });
    await client.updateSettings({ orchestratorModel: 'gpt-5.4' });
    process.env.ORCHESTRATOR_MODEL = 'gpt-5.4';

    const { stderr, exitCode } = await run(['--goal', 'Add a README', '--no-chat', '--workspace', workspace]);

    expect(exitCode, stderr).toBeNull();
    expect(models.codex.at(-1)).toBe('gpt-5.4');
  });
});
