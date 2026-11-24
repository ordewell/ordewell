import { vi } from 'vitest';
import { execFileSync } from 'child_process';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Duplex } from 'stream';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  GeminiService, ModelResolver, OpenAiService, createTask, mintDaemonToken, saveSession,
  type ConversationRequest, type ConversationTurn, type IConfig, type IRunner, type LegacyPlanState,
} from '@ordewell/core';
import { FakeRunnerSession, homeEnv, setEnv } from '@ordewell/core/testing';
import { attachWsHandler, createApp } from '../../../../web/server/app';
import { createRequestListener } from '../../../../web/server/nodeAdapter';
import { OrchestratorPool } from '../../../../web/server/pool/orchestratorPool';
import { ApiClient } from '../../apiClient';
import type { Key } from '../keys';
import { runEffect, type EffectDeps } from '../effects';
import { initialState, reduce, type Action, type Effect } from '../reducer';
import type { TuiState } from '../state';

/**
 * Machine B's run, end to end, for the first-run journey tests: a fresh git
 * project with hello.py and a README whose first line is `# hello`, the real
 * daemon (pool, routes, session socket) in a home of its own, which is the
 * machine, and a TUI driven through `reduce` and `runEffect` with a real
 * `ApiClient`. The pool makes every session itself, worktree isolation and
 * landing included. Only what sits outside the daemon is faked: the planner's
 * vendor transport, which answers every turn at once, and the task runner,
 * which makes the change a test scripts in the task's worktree and reports
 * done in its own words.
 */

export const MACHINE_B_GOAL = 'Add a --shout option to hello.py that prints the greeting in upper case, with a test';
export const README = '# hello\n\nSays hello.\n';

/** What a task's runner does in its worktree, and the summary it hands back in its own words. */
export interface ScriptedChange {
  edit(worktree: string): void;
  summary: string;
}

/** Machine B's settings file: the defaults (autorun off, Watch, manual merge, the trailer on) unless a test says otherwise. */
export interface MachineSettings {
  mergeAtGatesAutomatically?: boolean;
  plannedWithTrailer?: boolean;
}

const cleanGitEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[name];
  return env;
};

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: cleanGitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function freshProject(root: string): void {
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'T');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'hello.py'), 'import sys\n\nprint("hello")\n');
  writeFileSync(join(root, 'README.md'), README);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
}

function inertResolver(): ModelResolver {
  const registry = { getManifest: () => undefined } as unknown as ConstructorParameters<typeof ModelResolver>[0];
  const keyless = { getProviderApiKey: () => '', getProviderBaseUrl: () => '', setProviderModelLists: () => {}, openaiCompatibleBaseUrl: '' } as unknown as IConfig;
  return new ModelResolver(registry, keyless);
}

/** A runner that makes each task's scripted change in its worktree and reports done; a task with no script is held. */
function scriptedRunner(changes: Map<string, ScriptedChange>) {
  const spawned: string[] = [];
  const runner: IRunner = {
    activeCount: 0,
    spawn: vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
      spawned.push(opts.taskId);
      const session = new FakeRunnerSession(`s-${opts.taskId}-${spawned.length}`, opts.taskId);
      const change = changes.get(opts.taskId);
      if (change) {
        setTimeout(() => {
          change.edit(opts.cwd);
          session.reportComplete({ status: 'done', summary: change.summary });
        }, 5);
      }
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
  };
  return { runner, spawned };
}

/** One TUI on the daemon: its state, folded from every action its effects dispatch, as the app's loop folds them. */
export interface RunTui {
  state(): TuiState;
  actions: Action[];
  run(effect: Effect): Promise<void>;
  /** A key as the app's loop takes it: reduced at once, its effects run without being awaited. */
  press(name: Key['name'], char?: string): void;
  /** Typed into the composer and sent with Enter. */
  typed(text: string): void;
  api: ApiClient;
}

export async function firstRunBRun(settings: MachineSettings = {}) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ordewell-firstrun-b-')));
  const workspace = join(dir, 'hello');
  mkdirSync(workspace);
  freshProject(workspace);
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({
    autorun: false,
    supervisorLevel: 'watch',
    mergeAtGatesAutomatically: settings.mergeAtGatesAutomatically ?? false,
    plannedWithTrailer: settings.plannedWithTrailer ?? true,
  }));
  const restoreEnv = setEnv({
    ...homeEnv(dir),
    ORDEWELL_SETTINGS_PATH: settingsPath,
    // A planner the daemon's readiness check passes offline; its turns are answered here.
    AI_PROVIDER: 'openrouter',
    ORCHESTRATOR_MODEL: 'openrouter/auto',
    OPENROUTER_API_KEY: 'sk-or-test',
    ORDEWELL_ENABLED_RUNNERS: 'claude-code',
    ORDEWELL_PLANNER_EFFORT: undefined,
    ORDEWELL_AUTONOMOUS_MODE: 'false',
  });

  // The supervisor at Watch is woken at the run's end; it answers with a wrap-up.
  const asked: string[] = [];
  const answer = async (req: ConversationRequest): Promise<ConversationTurn> => {
    asked.push(req.initialMessage ?? req.goal);
    return { kind: 'message', text: 'The run is done and ready for you to merge.', researchLog: [] };
  };
  vi.spyOn(OpenAiService.prototype, 'startConversation').mockImplementation(answer);
  vi.spyOn(GeminiService.prototype, 'startConversation').mockImplementation(answer);

  const changes = new Map<string, ScriptedChange>();
  const { runner, spawned } = scriptedRunner(changes);
  const pool = new OrchestratorPool({
    modelResolver: inertResolver(),
    runner,
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
  const sockets = new Set<Duplex>();
  server.on('upgrade', (_request, socket: Duplex) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  const tui = (): RunTui => {
    const api = new ApiClient(port, workspace);
    let state = initialState({ rows: 60, cols: 140 });
    const actions: Action[] = [];
    const deps: EffectDeps = {
      api,
      workspace,
      port,
      dispatch: (action) => {
        actions.push(action);
        const next = reduce(state, action);
        state = next.state;
        for (const effect of next.effects) void runEffect(effect, deps).catch(() => undefined);
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
    const press = (name: Key['name'], char?: string) => deps.dispatch({ type: 'key', key: { name, ...(char ? { char } : {}) } });
    return {
      state: () => state,
      actions,
      run: (effect) => runEffect(effect, deps),
      press,
      typed(text: string) {
        if (state.focus !== 'chat') press('tab');
        for (const char of text) press('char', char);
        press('enter');
      },
      api,
    };
  };

  return {
    workspace,
    pool,
    asked,
    spawned,
    tui,
    /**
     * A plan for the goal, drafted and saved as the planner leaves one, with
     * each task's runner scripted to make `change`.
     */
    draft(sessionId: string, tasks: Array<{ id: string; title: string; change: ScriptedChange }>): void {
      for (const t of tasks) changes.set(t.id, t.change);
      const plan: LegacyPlanState = {
        status: 'draft',
        runners: ['claude-code'],
        generatedAt: '2026-11-24T09:00:00.000Z',
        lastUpdated: '2026-11-24T09:00:00.000Z',
        tasks: tasks.map((t, i) => createTask({ id: t.id, order: i + 1, title: t.title, prompt: t.title, assignedRunner: 'claude-code' })),
        conversationHistory: [
          { role: 'user', content: MACHINE_B_GOAL, timestamp: '2026-11-24T08:59:00.000Z' },
          { role: 'assistant', content: `Plan generated with ${tasks.length} tasks.`, timestamp: '2026-11-24T09:00:00.000Z', kind: 'plan_generated' },
        ],
      };
      saveSession(plan, MACHINE_B_GOAL, workspace, sessionId);
    },
    async close(): Promise<void> {
      pool.destroyAll();
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      restoreEnv();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      vi.restoreAllMocks();
    },
  };
}

export type FirstRunBRun = Awaited<ReturnType<typeof firstRunBRun>>;
