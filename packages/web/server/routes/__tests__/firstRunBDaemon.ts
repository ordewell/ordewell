import { vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  GeminiService, ModelResolver, OpenAiService, bearerHeaderValue, mintDaemonToken,
  type ConversationRequest, type ConversationTurn, type IConfig, type IRunner,
} from '@ordewell/core';
import { FakeRunnerSession, homeEnv, setEnv } from '@ordewell/core/testing';
import { attachWsHandler, createApp } from '../../app';
import { createRequestListener } from '../../nodeAdapter';
import { OrchestratorPool } from '../../pool/orchestratorPool';

/**
 * Machine B's daemon for the first-run journey tests: the real
 * `OrchestratorPool` behind the real app, admission included, on a port, in a
 * home of its own with a fresh two-file project. Only what sits outside the
 * daemon is faked: the planner's vendor transport, whose turns the test holds
 * open and finishes, fails or watches stop by hand, and the task runner.
 */

export interface HeldTurn {
  /** What the turn was asked: the goal on a first turn. */
  asked: string;
  signal?: AbortSignal;
  finish(text: string): void;
  fail(err: Error): void;
}

export const MACHINE_B_GOAL = 'Add a --shout option to hello.py that prints the greeting in upper case, with a test';

function inertResolver(): ModelResolver {
  const registry = { getManifest: () => undefined } as unknown as ConstructorParameters<typeof ModelResolver>[0];
  const keyless = { getProviderApiKey: () => '', getProviderBaseUrl: () => '', setProviderModelLists: () => {}, openaiCompatibleBaseUrl: '' } as unknown as IConfig;
  return new ModelResolver(registry, keyless);
}

function holdingRunner(): IRunner {
  return { activeCount: 0, spawn: vi.fn(async () => new FakeRunnerSession()), stop: vi.fn(), stopAll: vi.fn() };
}

export async function firstRunBDaemon() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ordewell-firstrun-b-')));
  const workspace = join(dir, 'hello');
  mkdirSync(join(workspace, '.git'), { recursive: true });
  writeFileSync(join(workspace, 'hello.py'), 'print("hello")\n');
  writeFileSync(join(workspace, 'README.md'), '# hello\n\nSays hello.\n');
  const restoreEnv = setEnv({
    ...homeEnv(dir),
    ORDEWELL_SETTINGS_PATH: join(dir, 'settings.json'),
    // A planner the daemon's readiness check passes offline; its turns are the test's.
    AI_PROVIDER: 'openrouter',
    ORCHESTRATOR_MODEL: 'openrouter/auto',
    OPENROUTER_API_KEY: 'sk-or-test',
    ORDEWELL_ENABLED_RUNNERS: 'claude-code',
    ORDEWELL_PLANNER_EFFORT: undefined,
    ORDEWELL_AUTONOMOUS_MODE: 'false',
  });

  const turns: HeldTurn[] = [];
  const open = (req: ConversationRequest) => new Promise<ConversationTurn>((resolve, reject) => {
    turns.push({
      asked: req.initialMessage ?? req.goal,
      signal: req.signal,
      finish: (text) => resolve({ kind: 'message', text, researchLog: [] }),
      fail: reject,
    });
    req.signal?.addEventListener('abort', () => resolve({ kind: 'message', text: '', researchLog: [], aborted: true }), { once: true });
  });
  vi.spyOn(OpenAiService.prototype, 'startConversation').mockImplementation(open);
  vi.spyOn(GeminiService.prototype, 'startConversation').mockImplementation(open);

  const pool = new OrchestratorPool({
    modelResolver: inertResolver(),
    runner: holdingRunner(),
    // Claude Code installed and signed in, Codex installed and signed out.
    runnerInstallation: {
      filterInstalled: async (runners) => runners.filter((id) => id === 'claude-code' || id === 'codex'),
      plannerUsability: async (id) => ({ usable: id === 'claude-code' }),
      runnerUsability: async (id) => ({ usable: id === 'claude-code' }),
    },
    codexSandbox: { ensure: async () => {}, refresh: async () => {} },
  });
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const { token, file } = mintDaemonToken(port);
  const admission = { port, token, tokenFile: file };
  server.on('request', createRequestListener(createApp(pool, admission), admission));
  attachWsHandler(server, pool, admission);

  /** A request as a surface sends it, with the daemon's token. */
  const request = (method: 'GET' | 'POST', path: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: bearerHeaderValue(token), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const ws = encodeURIComponent(workspace);

  return {
    workspace,
    pool,
    turns,
    request,
    /** The user's first message: the goal, sent as the terminal UI sends it. */
    sendGoal: (sessionId: string, goal = MACHINE_B_GOAL) =>
      request('POST', `/api/plans/${sessionId}/converse/start?workspace=${ws}`, { goal, workspace, surface: 'tui' }),
    /** What the sessions route lists for the project. */
    async listed(): Promise<Array<{ id: string; goal: string } & Record<string, unknown>>> {
      const res = await request('GET', `/api/sessions?workspace=${ws}`);
      if (!res.ok) throw new Error(`GET /api/sessions answered ${res.status}`);
      return (await res.json()) as Array<{ id: string; goal: string } & Record<string, unknown>>;
    },
    /** One session as the sessions route reads it, or null when it answers 404. */
    async read(sessionId: string): Promise<Record<string, unknown> | null> {
      const res = await request('GET', `/api/sessions/${sessionId}?workspace=${ws}`);
      if (res.status === 404) return null;
      return (await res.json()) as Record<string, unknown>;
    },
    stopPlanning: (sessionId: string) => request('POST', `/api/plans/${sessionId}/planning/stop?workspace=${ws}`),
    async close(): Promise<void> {
      pool.destroyAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
      vi.restoreAllMocks();
    },
  };
}

export type FirstRunBDaemon = Awaited<ReturnType<typeof firstRunBDaemon>>;
