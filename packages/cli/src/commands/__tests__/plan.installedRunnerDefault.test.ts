import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import https from 'https';
import type { AddressInfo } from 'net';
import type { SpawnFn } from '@ordewell/core';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, delimiter, join } from 'path';

// Core from source, so the process boundary below is the very `spawn` the
// planner's agent is started through; the built bundle's cannot be replaced.
vi.mock('@ordewell/core', () => import('../../../../core/src/index'));

const boundary = vi.hoisted(() => ({ spawned: [] as string[] }));
const AGENTS = ['claude', 'codex', 'opencode'];

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const spawn = ((command: string, args: string[], options: Parameters<SpawnFn>[2]) => {
    if (!AGENTS.includes(basename(command))) return actual.spawn(command, args, options);
    boundary.spawned.push(basename(command));
    throw new Error('stopped at the process boundary');
  }) as typeof actual.spawn;
  return { ...actual, spawn, default: { ...actual, spawn } };
});

import {
  ModelResolver, SettingsService, clearAugmentedPathCache, getProviderMeta, mintDaemonToken, resetInstalledPlanner,
  PROVIDER_DETECT_PRIORITY, type IRunner, type PlannerUsability, type RunnerId,
} from '@ordewell/core';
import { attachWsHandler, createApp } from '../../../../web/server/app';
import { createRequestListener } from '../../../../web/server/nodeAdapter';
import { WebConfig } from '../../../../web/server/adapters/WebConfig';
import { OrchestratorPool } from '../../../../web/server/pool/orchestratorPool';
import { ApiClient } from '../../apiClient';
import { handlePlan } from '../plan';
import { FakeRunnerSession } from '@ordewell/core/testing';

/** Discovery that never spawns a CLI or reaches the network. */
function inertResolver(): ModelResolver {
  const registry = { getManifest: () => undefined } as unknown as ConstructorParameters<typeof ModelResolver>[0];
  return new ModelResolver(registry, new WebConfig(), { fetchImpl: async () => new Response(JSON.stringify({ data: [] })) });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((answer) => { resolve = answer; });
  return { promise, resolve };
}

const BINARY: Record<RunnerId, string> = { 'claude-code': 'claude', codex: 'codex', opencode: 'opencode' };

// A first run with no key, no saved runner choice and one agent installed:
// the CLI, HTTP contract, pool, Session and planner transport all run, and
// only the agent processes, discovery and the host probe are replaced.
describe('with no saved runner choice, the installed agents are the enabled runners', () => {
  const keys = ['HOME', 'PATH', 'ORDEWELL_SETTINGS_PATH', 'AI_PROVIDER', 'ORCHESTRATOR_MODEL', 'ORDEWELL_PLANNER_EFFORT',
    'ORDEWELL_ENABLED_RUNNERS', 'ORDEWELL_CLAUDE_CODE_ENABLED', 'ORDEWELL_CODEX_ENABLED', 'ORDEWELL_OPENCODE_ENABLED'];
  const saved: Record<string, string | undefined> = {};
  let dir: string;
  let workspace: string;
  let pool: OrchestratorPool;
  let server: http.Server;
  let client: ApiClient;
  let installed: RunnerId[];
  /** Holds a probe back, or answers it; undefined defers to `installed`. */
  let usability: () => Promise<PlannerUsability | undefined>;
  let requested: (RunnerId[] | undefined)[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ordewell-installed-runners-'));
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
    for (const key of keys.slice(3)) delete process.env[key];
    process.env.HOME = dir;
    process.env.ORDEWELL_SETTINGS_PATH = join(dir, 'settings.json');

    // The spawn is faked, but each binary must still resolve on PATH first.
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const agent of AGENTS) {
      writeFileSync(join(bin, agent), '#!/bin/sh\nexit 1\n');
      chmodSync(join(bin, agent), 0o755);
    }
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
    clearAugmentedPathCache();
    vi.spyOn(https, 'request').mockImplementation(() => { throw new Error('Unexpected external HTTPS request'); });
    boundary.spawned = [];
    installed = [];
    usability = async () => undefined;
    requested = [];

    const runner: IRunner = { activeCount: 0, spawn: vi.fn(async (opts) => new FakeRunnerSession('task-run', opts.taskId)), stop: vi.fn(), stopAll: vi.fn() };
    pool = new OrchestratorPool({
      accountLimitCollectors: () => [],
      modelResolver: inertResolver(),
      runner,
      runnerInstallation: {
        plannerUsability: async (id: RunnerId) => (await usability()) ?? { usable: installed.includes(id) },
        runnerUsability: async (id: RunnerId) => (await usability()) ?? { usable: installed.includes(id) },
        filterInstalled: async (ids: string[]) => ids.filter((id) => installed.includes(id)),
      },
      codexSandbox: { ensure: async () => undefined, refresh: async () => undefined },
    } as unknown as ConstructorParameters<typeof OrchestratorPool>[0]);
    // What each start asked the Session for, as the route handed it over.
    const startPlanning = pool.startPlanning.bind(pool);
    pool.startPlanning = (sessionId, goal, runners, ...rest) => {
      requested.push(runners);
      return startPlanning(sessionId, goal, runners, ...rest);
    };
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
    pool.destroyAll();
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    resetInstalledPlanner();
    clearAugmentedPathCache();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function host(...agents: RunnerId[]): Promise<void> {
    installed = agents;
    await pool.detectInstalledPlanner();
  }

  /** Runs the command as `main` would, with `process.exit` turned into a value. */
  async function plan(...extra: string[]): Promise<{ stderr: string; exitCode: number | null }> {
    const errs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errs.push(parts.join(' ')); });
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
    let exitCode: number | null = null;
    try {
      await handlePlan(['--goal', 'Build a cache', '--workspace', workspace, ...extra], { api: client });
    } catch (err) {
      const match = /^exit:(\d+)$/.exec(err instanceof Error ? err.message : '');
      if (!match) throw err;
      exitCode = Number(match[1]);
    } finally {
      vi.restoreAllMocks();
    }
    return { stderr: errs.join('\n'), exitCode };
  }

  function savedRunners(): unknown {
    const file = process.env.ORDEWELL_SETTINGS_PATH!;
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { enabledRunners?: unknown }).enabledRunners : undefined;
  }

  for (const only of ['codex', 'opencode'] as const) {
    it(`a ${only}-only first run plans with ${only}, down to its agent spawn`, async () => {
      await host(only);
      expect((await client.getSettings()).aiProvider).toBe(only);
      expect((await client.getRunners()).runners).toEqual([expect.objectContaining({ id: only, enabled: true })]);

      const { stderr } = await plan();

      expect(stderr).not.toContain('None of the requested runners are enabled');
      expect(requested).toEqual([[only]]);
      expect(boundary.spawned).toEqual([BINARY[only]]);
      expect(savedRunners()).toBeUndefined();
    });
  }

  it('a claude-only first run is unchanged', async () => {
    await host('claude-code');
    expect((await client.getRunners()).runners).toEqual([expect.objectContaining({ id: 'claude-code', enabled: true })]);
    await plan();
    expect(requested).toEqual([['claude-code']]);
    expect(boundary.spawned).toEqual(['claude']);
  });

  it('enables every installed agent, in registry order, and saves none of them', async () => {
    await host('opencode', 'codex');
    expect((await client.getRunners()).runners.map((r) => [r.id, r.enabled])).toEqual([['codex', true], ['opencode', true]]);
    await plan();
    expect(requested).toEqual([['codex', 'opencode']]);
    expect(savedRunners()).toBeUndefined();
  });

  it('keeps a saved selection over the installed agents', async () => {
    new SettingsService().setEnabledRunners(['opencode']);
    await host('codex', 'opencode');
    expect((await client.getRunners()).runners.map((r) => [r.id, r.enabled])).toEqual([['codex', false], ['opencode', true]]);
    await plan();
    expect(requested).toEqual([['opencode']]);
    expect(savedRunners()).toEqual(['opencode']);
  });

  it('keeps a saved empty selection, and says how to enable an installed agent', async () => {
    new SettingsService().setEnabledRunners([]);
    await host('codex');
    expect((await client.getRunners()).runners).toEqual([expect.objectContaining({ id: 'codex', enabled: false })]);

    const { stderr, exitCode } = await plan();

    expect(exitCode).toBe(1);
    expect(stderr).toContain('ordewell runners codex on');
    expect(requested).toEqual([]);
    expect(boundary.spawned).toEqual([]);
    expect(savedRunners()).toEqual([]);
  });

  it('--runner of an installed agent the derived default enables plans with it', async () => {
    await host('claude-code', 'codex');
    await plan('--runner', 'codex');
    expect(requested).toEqual([['codex']]);
    expect(boundary.spawned).toEqual(['claude']);
  });

  it('--runner of an installed but disabled agent names the command that enables it', async () => {
    new SettingsService().setEnabledRunners(['claude-code']);
    await host('claude-code', 'codex');

    const { stderr, exitCode } = await plan('--runner', 'codex');

    expect(exitCode).toBe(1);
    expect(stderr).toContain('codex is installed but not enabled');
    expect(stderr).toContain('ordewell runners codex on');
    expect(stderr).not.toContain('Unknown runner');
    expect(requested).toEqual([]);
    expect(savedRunners()).toEqual(['claude-code']);
  });

  it('--runner of an agent that is not installed is still unknown', async () => {
    await host('codex');
    const { stderr, exitCode } = await plan('--runner', 'opencode');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Unknown runner: "opencode"');
    expect(requested).toEqual([]);
  });

  it('the runner list waits for the probe instead of answering with the stale default', async () => {
    installed = ['codex'];
    const gate = deferred<void>();
    usability = async () => { await gate.promise; return undefined; };
    const detection = pool.detectInstalledPlanner();
    let answered = false;
    const listed = client.getRunners().then((state) => { answered = true; return state; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(answered).toBe(false);

    gate.resolve();
    await detection;
    expect((await listed).runners).toEqual([expect.objectContaining({ id: 'codex', enabled: true })]);
  });

  it('a goal sent with no runners before the probe answers opens with the installed agent', async () => {
    installed = ['codex'];
    const gate = deferred<void>();
    usability = async () => { await gate.promise; return undefined; };
    const detection = pool.detectInstalledPlanner();
    const started = client.startConversation('tui', 'Build a cache', undefined, workspace).catch((err: unknown) => err);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(boundary.spawned).toEqual([]);

    gate.resolve();
    await detection;
    const outcome = await started;

    expect(String(outcome)).not.toContain('None of the requested runners are enabled');
    expect(boundary.spawned).toEqual(['codex']);
    expect(pool.getPlan('tui')?.runners).toEqual(['codex']);
  });
});
