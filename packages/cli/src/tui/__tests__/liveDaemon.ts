import { vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Duplex } from 'stream';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  GeminiService,
  ModelResolver,
  OpenAiService,
  createTask,
  mintDaemonToken,
  saveSession,
  type AccountLimitCollector,
  type ConversationRequest,
  type ConversationTurn,
  type IConfig,
  type IRunner,
  type LegacyPlanState,
} from '@ordewell/core';
import { FakeRunnerSession, homeEnv, setEnv } from '@ordewell/core/testing';
import { attachWsHandler, createApp } from '../../../../web/server/app';
import { createRequestListener } from '../../../../web/server/nodeAdapter';
import { OrchestratorPool } from '../../../../web/server/pool/orchestratorPool';
import { ApiClient } from '../../apiClient';
import { runEffect, type EffectDeps } from '../effects';
import { initialState, reduce, type Action, type Effect } from '../reducer';
import type { TuiState } from '../state';

/**
 * The real daemon — `OrchestratorPool`, its routes and its session socket —
 * on a port, for a TUI driven through `runEffect` and `reduce` with a real
 * `ApiClient`. Only what sits outside the daemon is faked: the planner's
 * vendor transport, whose turns the test finishes by hand, and the runner.
 */

type Handler = NonNullable<ConversationRequest['plannerTools']>['handler'];

export interface PlannerTurn {
  tools: Handler;
  finish(text: string): void;
}

export const toolContext: { signal: AbortSignal } = { signal: new AbortController().signal };

/** A plan nobody has run yet, as a saved session. */
export function draftPlan(): LegacyPlanState {
  return {
    status: 'draft',
    runners: ['claude-code'],
    generatedAt: '2026-10-16T09:00:00.000Z',
    lastUpdated: '2026-10-16T09:00:00.000Z',
    tasks: [
      createTask({ id: 't1', order: 1, title: 'Add the limiter', prompt: 'add the limiter', assignedRunner: 'claude-code' }),
      createTask({ id: 't2', order: 2, title: 'Wire it up', prompt: 'wire it up', assignedRunner: 'claude-code', dependencies: ['t1'] }),
    ],
    conversationHistory: [
      { role: 'user', content: 'Rate limiting', timestamp: '2026-10-16T08:59:00.000Z' },
      { role: 'assistant', content: 'Plan generated with 2 tasks.', timestamp: '2026-10-16T09:00:00.000Z', kind: 'plan_generated' },
    ],
  };
}

function inertResolver(): ModelResolver {
  const registry = { getManifest: () => undefined } as unknown as ConstructorParameters<typeof ModelResolver>[0];
  const keyless = { getProviderApiKey: () => '', getProviderBaseUrl: () => '', setProviderModelLists: () => {}, openaiCompatibleBaseUrl: '' } as unknown as IConfig;
  return new ModelResolver(registry, keyless);
}

function holdingRunner(): IRunner {
  return { activeCount: 0, spawn: vi.fn(async () => new FakeRunnerSession()), stop: vi.fn(), stopAll: vi.fn() };
}

/** One TUI on the daemon: its state, folded from every action its effects dispatch. */
export interface Tui {
  state(): TuiState;
  actions: Action[];
  run(effect: Effect): Promise<void>;
  /** An action as the TUI's own loop takes it: reduced, and its effects run. */
  act(action: Action): Promise<void>;
  api: ApiClient;
}

export async function liveDaemon(accountLimitCollectors: (workspace: string) => readonly AccountLimitCollector[] = () => []) {
  const dir = mkdtempSync(join(tmpdir(), 'ordewell-live-'));
  const workspace = join(dir, 'ws');
  mkdirSync(join(workspace, '.git'), { recursive: true });
  const restoreEnv = setEnv({
    ...homeEnv(dir),
    ORDEWELL_SETTINGS_PATH: join(dir, 'settings.json'),
    AI_PROVIDER: 'openrouter',
    ORCHESTRATOR_MODEL: 'openrouter/auto',
    OPENROUTER_API_KEY: 'sk-or-test',
    ORDEWELL_ENABLED_RUNNERS: 'claude-code',
    ORDEWELL_PLANNER_EFFORT: undefined,
    // Guarded, where a planner's start of a task the user has not approved asks on its card.
    ORDEWELL_AUTONOMOUS_MODE: 'false',
  });

  // A turn on a session the daemon adopted is a replay, so every turn opens
  // through `startConversation`; each waits for the test to finish it.
  const turns: PlannerTurn[] = [];
  const open = (req: ConversationRequest) => new Promise<ConversationTurn>((resolve) => {
    turns.push({ tools: req.plannerTools!.handler, finish: (text) => resolve({ kind: 'message', text, researchLog: [] }) });
    req.signal?.addEventListener('abort', () => resolve({ kind: 'message', text: '', researchLog: [], aborted: true }), { once: true });
  });
  vi.spyOn(OpenAiService.prototype, 'startConversation').mockImplementation(open);
  vi.spyOn(GeminiService.prototype, 'startConversation').mockImplementation(open);

  const pool = new OrchestratorPool({
    accountLimitCollectors,
    modelResolver: inertResolver(),
    runner: holdingRunner(),
    // Installation must agree with the fake runner even on a host with no agents.
    runnerInstallation: {
      filterInstalled: async (runners) => runners.filter((id) => id === 'claude-code'),
      plannerUsability: async (id) => ({ usable: id === 'claude-code' }),
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
  const sockets = new Set<Duplex>();
  server.on('upgrade', (_request, socket: Duplex) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  /** `wholeLoop`: a dispatched action's effects run too, as `createApp`'s loop runs them. */
  const tui = ({ wholeLoop = false }: { wholeLoop?: boolean } = {}): Tui => {
    const api = new ApiClient(port, workspace);
    let state = initialState({ rows: 30, cols: 100 });
    const actions: Action[] = [];
    const deps: EffectDeps = {
      api,
      workspace,
      port,
      dispatch: (action) => {
        actions.push(action);
        const next = reduce(state, action);
        state = next.state;
        if (wholeLoop) for (const effect of next.effects) void runEffect(effect, deps);
      },
      newSessionId: () => 'session-new',
      setEnvVar: () => {},
      saveAutonomy: () => ({ overridden: false }),
      setMouseCapture: () => {},
      hasBin: () => true,
      pipeToClipboard: () => {},
      writeTerminal: () => {},
      reviveDaemon: async () => true,
      login: async () => ({ ok: true }),
      exit: () => {},
    };
    const act = async (action: Action): Promise<void> => {
      actions.push(action);
      const next = reduce(state, action);
      state = next.state;
      for (const effect of next.effects) await runEffect(effect, deps);
    };
    return { state: () => state, actions, run: (effect) => runEffect(effect, deps), act, api };
  };

  return {
    workspace,
    pool,
    turns,
    client: () => new ApiClient(port, workspace),
    tui,
    save(plan: LegacyPlanState, id: string): string {
      return saveSession(plan, 'Rate limiting', workspace, id).id;
    },
    /** The network between the TUIs and the daemon drops: every open session socket goes at once. */
    dropSockets(): void {
      for (const socket of sockets) socket.destroy();
    },
    async close(): Promise<void> {
      pool.destroyAll();
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
      vi.restoreAllMocks();
    },
  };
}

export type LiveDaemon = Awaited<ReturnType<typeof liveDaemon>>;
