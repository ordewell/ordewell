import { vi } from 'vitest';
import http from 'http';
import https from 'https';
import type { AddressInfo } from 'net';
import type { Duplex } from 'stream';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CliAgentAiService,
  GeminiService,
  ModelResolver,
  OpenAiService,
  PROVIDER_DETECT_PRIORITY,
  RunnerInstallation,
  RunnerRegistry,
  clearAugmentedPathCache,
  getProviderMeta,
  mintDaemonToken,
  resetInstalledPlanner,
  resetRunnerAuth,
  type ConversationRequest,
  type ConversationTurn,
  type IConfig,
  type IRunner,
} from '@ordewell/core';
import { FakeRunnerSession, homeEnv, removeDir, setEnv } from '@ordewell/core/testing';
import { stageMachine, writeTwoFileProject, type MachineAgents, type StagedMachine } from '../../../../core/src/services/__tests__/firstRunAMachine';
import { attachWsHandler, createApp } from '../../../../web/server/app';
import { createRequestListener } from '../../../../web/server/nodeAdapter';
import { OrchestratorPool } from '../../../../web/server/pool/orchestratorPool';
import { ApiClient } from '../../apiClient';
import { runEffect, type EffectDeps } from '../effects';
import { initialState, reduce, type Action, type Effect } from '../reducer';
import type { TuiState } from '../state';

/**
 * The first-run journey's daemon, for machine A's acceptance tests: the real
 * `OrchestratorPool`, its routes and socket, and a real `RunnerInstallation`
 * asking fake agent CLIs on PATH whether they are installed and signed in, so
 * the sign-in is recorded per workspace the way production records it. Only
 * what sits past the agents is replaced: each planner transport's turn, which
 * the test answers, model discovery and the task runner.
 */

type Handler = NonNullable<ConversationRequest['plannerTools']>['handler'];

/** One planner turn the daemon opened: what it was asked with, and the tools it was handed. */
export interface OpenedTurn {
  transport: 'agent' | 'vendor';
  request: ConversationRequest;
  /** The planner's own tools, answered by the session. */
  tools: Handler;
}

export const toolContext: { signal: AbortSignal } = { signal: new AbortController().signal };

/** Every variable the daemon reads that a first run must not inherit from the host. */
function hostVariables(): string[] {
  const keys = new Set([
    'PATH', 'ORDEWELL_SETTINGS_PATH', 'AI_PROVIDER', 'ORCHESTRATOR_MODEL', 'ORDEWELL_PLANNER_EFFORT', 'ORDEWELL_ENABLED_RUNNERS',
    'ORDEWELL_AUTONOMOUS_MODE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
  ]);
  for (const provider of PROVIDER_DETECT_PRIORITY) {
    const meta = getProviderMeta(provider);
    for (const key of [...meta.detectEnvVars, meta.baseUrlEnvVar, meta.apiKeyEnvVar]) if (key) keys.add(key);
  }
  return [...keys];
}

function inertResolver(): ModelResolver {
  const registry = { getManifest: () => undefined } as unknown as ConstructorParameters<typeof ModelResolver>[0];
  const keyless = { getProviderApiKey: () => '', getProviderBaseUrl: () => '', setProviderModelLists: () => {}, openaiCompatibleBaseUrl: '' } as unknown as IConfig;
  return new ModelResolver(registry, keyless);
}

function holdingRunner(): IRunner {
  return { activeCount: 0, spawn: vi.fn(async () => new FakeRunnerSession()), stop: vi.fn(), stopAll: vi.fn() };
}

/** One TUI on the daemon, its effects run as its own loop runs them. */
export interface FirstRunTui {
  state(): TuiState;
  actions: Action[];
  run(effect: Effect): Promise<void>;
  act(action: Action): Promise<void>;
  /** Type `text` into the composer key by key, as a person does. */
  type(text: string): Promise<void>;
  press(name: string): Promise<void>;
  /** Overwrite part of the state, for a catalog the inert discovery cannot supply. */
  patch(over: Partial<TuiState>): void;
}

export interface FirstRunOptions {
  /** Extra variables, such as an API key the machine holds. */
  env?: Record<string, string | undefined>;
}

/**
 * Start the daemon on `agents`, and run its startup detection as the daemon's
 * own start does. The planner transports are held: each opened turn waits in
 * `turns` until the test answers it with `answer`.
 */
export async function firstRunADaemon(agents: MachineAgents, options: FirstRunOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ordewell-first-run-a-'));
  const workspace = join(dir, 'project');
  writeTwoFileProject(workspace);
  const machine: StagedMachine = stageMachine(dir, agents);

  const restoreEnv = setEnv({
    ...Object.fromEntries(hostVariables().map((key) => [key, undefined])),
    ...homeEnv(dir),
    PATH: machine.PATH,
    ORDEWELL_SETTINGS_PATH: join(dir, 'settings.json'),
    // Guarded, the default settings' autonomy.
    ORDEWELL_AUTONOMOUS_MODE: 'false',
    ...options.env,
  });
  clearAugmentedPathCache();
  resetInstalledPlanner();
  resetRunnerAuth();
  vi.spyOn(https, 'request').mockImplementation(() => { throw new Error('Unexpected external HTTPS request'); });

  const turns: OpenedTurn[] = [];
  const pending: Array<(text: string) => void> = [];
  const hold = (transport: OpenedTurn['transport']) => (req: ConversationRequest) => new Promise<ConversationTurn>((resolve) => {
    turns.push({ transport, request: req, tools: req.plannerTools!.handler });
    pending.push((text) => resolve({ kind: 'message', text, researchLog: [] }));
    req.signal?.addEventListener('abort', () => resolve({ kind: 'message', text: '', researchLog: [], aborted: true }), { once: true });
  });
  vi.spyOn(CliAgentAiService.prototype, 'startConversation').mockImplementation(hold('agent'));
  vi.spyOn(CliAgentAiService.prototype, 'continueConversation').mockImplementation(async () => ({ kind: 'message', text: 'Noted.', researchLog: [] }));
  vi.spyOn(OpenAiService.prototype, 'startConversation').mockImplementation(hold('vendor'));
  vi.spyOn(GeminiService.prototype, 'startConversation').mockImplementation(hold('vendor'));

  // The probe production builds for a workspace (`installationFor`), on the
  // machine's PATH: its verdicts are recorded under this workspace.
  const installation = new RunnerInstallation(new RunnerRegistry(), undefined, undefined, {
    env: async () => ({}),
    workspace: () => workspace,
  });
  const pool = new OrchestratorPool({
    accountLimitCollectors: () => [],
    modelResolver: inertResolver(),
    runner: holdingRunner(),
    runnerInstallation: installation,
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
  // The daemon detects the installed agents as it starts.
  await pool.detectInstalledPlanner();

  let minted = 0;
  const tui = ({ rows = 50, cols = 160 }: { rows?: number; cols?: number } = {}): FirstRunTui => {
    const api = new ApiClient(port, workspace);
    let state = initialState({ rows, cols, workspace });
    const actions: Action[] = [];
    const deps: EffectDeps = {
      api,
      workspace,
      port,
      dispatch: (action) => {
        actions.push(action);
        state = reduce(state, action).state;
      },
      newSessionId: () => `first-run-${++minted}`,
      setEnvVar: () => {},
      saveAutonomy: () => ({ overridden: false }),
      setMouseCapture: () => {},
      hasBin: () => true,
      pipeToClipboard: () => {},
      writeTerminal: () => {},
      reviveDaemon: async () => false,
      login: async () => ({ ok: true }),
      exit: () => {},
    };
    const act = async (action: Action): Promise<void> => {
      actions.push(action);
      const next = reduce(state, action);
      state = next.state;
      for (const effect of next.effects) await runEffect(effect, deps);
    };
    return {
      state: () => state,
      actions,
      run: (effect) => runEffect(effect, deps),
      act,
      type: async (text) => {
        for (const char of text) await act({ type: 'key', key: { name: 'char', char } });
      },
      press: (name) => act({ type: 'key', key: { name } }),
      patch: (over) => { state = { ...state, ...over }; },
    };
  };

  return {
    dir,
    workspace,
    machine,
    pool,
    installation,
    turns,
    /** Answer the oldest turn still open. */
    answer(text: string): void {
      const next = pending.shift();
      if (!next) throw new Error('no planner turn is open');
      next(text);
    },
    client: () => new ApiClient(port, workspace),
    tui,
    async close(): Promise<void> {
      for (const finish of pending.splice(0)) finish('');
      pool.destroyAll();
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      resetInstalledPlanner();
      resetRunnerAuth();
      restoreEnv();
      clearAugmentedPathCache();
      vi.restoreAllMocks();
      // Windows keeps a directory busy (EBUSY) while work the pool started winds down: wait it out without blocking the loop it needs.
      await removeDir(dir);
    },
  };
}

export type FirstRunADaemon = Awaited<ReturnType<typeof firstRunADaemon>>;
