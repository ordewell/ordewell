import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createTask,
  mintDaemonToken,
  saveSession,
  GeminiService,
  ModelResolver,
  OpenAiService,
  type ConversationTurn,
  type IConfig,
  type IRunner,
  type LegacyPlanState,
  type TaskStatus,
} from '@ordewell/core';
import { FakeRunnerSession, homeEnv, setEnv } from '@ordewell/core/testing';
import { createApp } from '../../../web/server/app';
import { createRequestListener } from '../../../web/server/nodeAdapter';
import { OrchestratorPool } from '../../../web/server/pool/orchestratorPool';
import { ApiClient, DaemonError, WorkspaceInitNeededError } from '../apiClient';
import { handleCheckpoint, handleCancel, handleForceStart } from '../commands/task-control';
import { handleSkip, handleMarkComplete, handleUncomplete } from '../commands/mark-complete';
import { handleStop } from '../commands/stop';
import { runEffect, type EffectDeps } from '../tui/effects';
import type { Action, Effect } from '../tui/reducer';

/**
 * The CLI's `ApiClient` against the real `createApp` and `OrchestratorPool`,
 * over a socket. The client tests elsewhere answer from hand-written servers,
 * and the route tests from fake pools, so neither can notice the two halves
 * disagreeing about a body or an error code — which is what this file is for.
 * Only what sits outside the daemon is faked: the planner's vendor transports
 * and the task runner.
 */

const TEXT: ConversationTurn = { kind: 'message', text: 'Which store should the limiter use?', researchLog: [] };

function savedPlan(): LegacyPlanState {
  return {
    status: 'approved',
    runners: ['claude-code'],
    generatedAt: '2026-07-21T10:00:00.000Z',
    lastUpdated: '2026-07-21T10:00:00.000Z',
    tasks: [
      { id: 't1', order: 1, title: 'Add the limiter', type: 'ai', status: 'pending', description: 'd', prompt: 'Add the limiter', dependencies: [], assignedRunner: 'claude-code', subtasks: [] },
    ],
  } as unknown as LegacyPlanState;
}

/** Discovery that never spawns a CLI or reaches the network: every runner serves an empty catalog and no provider has a key. */
function inertResolver(): ModelResolver {
  const registry = { getManifest: () => undefined } as unknown as ConstructorParameters<typeof ModelResolver>[0];
  const keyless = { getProviderApiKey: () => '', getProviderBaseUrl: () => '', setProviderModelLists: () => {}, openaiCompatibleBaseUrl: '' } as unknown as IConfig;
  return new ModelResolver(registry, keyless);
}

/** Tasks that start and never finish, so a run stays live until the test ends it; `spawned` holds each one a test may drive. */
function holdingRunner(spawned: FakeRunnerSession[] = []): IRunner {
  return {
    activeCount: 0,
    spawn: vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
      const task = new FakeRunnerSession(`s${spawned.length + 1}`, opts.taskId);
      spawned.push(task);
      return task;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
  };
}

describe('the daemon contract: ApiClient against the real daemon', () => {
  let restoreEnv: () => void;
  let dir: string;
  let workspace: string;
  let pool: OrchestratorPool;
  let server: http.Server;
  let client: ApiClient;
  let spawned: FakeRunnerSession[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ordewell-contract-'));
    workspace = join(dir, 'ws');
    mkdirSync(join(workspace, '.git'), { recursive: true });
    restoreEnv = setEnv({
      ...homeEnv(dir),
      ORDEWELL_SETTINGS_PATH: join(dir, 'settings.json'),
      AI_PROVIDER: 'openrouter',
      ORCHESTRATOR_MODEL: 'openrouter/auto',
      // Kept as it is, only so it is put back: the daemon writes it on a planner pick.
      ORDEWELL_PLANNER_EFFORT: process.env.ORDEWELL_PLANNER_EFFORT,
      OPENROUTER_API_KEY: 'sk-or-test',
    });
    vi.spyOn(OpenAiService.prototype, 'startConversation').mockResolvedValue(TEXT);
    vi.spyOn(GeminiService.prototype, 'startConversation').mockResolvedValue(TEXT);

    spawned = [];
    pool = new OrchestratorPool({ modelResolver: inertResolver(), runner: holdingRunner(spawned) });
    server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const { token, file } = mintDaemonToken(port);
    const admission = { port, token, tokenFile: file };
    server.on('request', createRequestListener(createApp(pool, admission), admission));
    client = new ApiClient(port, workspace);
  });

  afterEach(async () => {
    pool.destroyAll();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    restoreEnv();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function refusal(call: Promise<unknown>): Promise<DaemonError> {
    const err = await call.then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
    return err as DaemonError;
  }

  describe('workspaces', () => {
    it('reads the repositories and branches a first screen shows, without starting or changing anything', async () => {
      const { preview } = await client.getIsolationPreview(workspace);

      expect(preview.status).toBe('no-repo');
      expect(preview.repos).toEqual([]);
      expect(pool.hasSession('session-preview')).toBe(false);
    });
  });

  describe('sessions', () => {
    it('adopts a saved session and answers with its plan and goal', async () => {
      saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');

      const adopted = await client.adoptSession('session-saved', workspace);

      expect(adopted.goal).toBe('Rate limiting');
      expect(adopted.plan.tasks.map((t) => t.id)).toEqual(['t1']);
      expect(pool.hasSession('session-saved')).toBe(true);
    });

    it('lists and reads saved sessions through the contract shapes', async () => {
      saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');

      const list = await client.getSessions(workspace);
      const one = await client.getSession('session-saved', workspace);

      expect(list.map((m) => m.id)).toEqual(['session-saved']);
      expect(one.meta.goal).toBe('Rate limiting');
      expect(one.plan.phase).toBe('planning');
    });

    it('adopts a session the daemon no longer holds, then retries the call once', async () => {
      saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');
      expect(pool.hasSession('session-saved')).toBe(false);

      await expect(client.execute('session-saved', { command: 'mark_complete', task: 't1', confirmed: true })).resolves.toEqual({ ok: true, message: 'Marked task #1 "Add the limiter" complete.' });

      expect(pool.hasSession('session-saved')).toBe(true);
    });

    it('skips a failed task through the command seam as the user, and refuses one that completed', async () => {
      const plan = savedPlan();
      plan.tasks = [
        { ...plan.tasks[0], status: 'failed' },
        { ...plan.tasks[0], id: 't2', order: 2, title: 'Use the limiter', status: 'completed', dependencies: ['t1'] },
      ];
      saveSession(plan, 'Rate limiting', workspace, 'session-saved');

      await expect(client.execute('session-saved', { command: 'skip_task', task: 't1', reason: 'the limiter is not needed' })).resolves.toMatchObject({ ok: true, message: expect.stringContaining('Skipped task #1') });
      const err = await refusal(client.execute('session-saved', { command: 'skip_task', task: 't2' }));

      const skipped = pool.session('session-saved').planState!.tasks.find((t) => t.id === 't1')!;
      expect(skipped).toMatchObject({ status: 'skipped', skipReason: 'the limiter is not needed' });
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/has completed: its work landed/);
    });

    it('says session_not_found for one that exists nowhere', async () => {
      const err = await refusal(client.executePlan('session-ghost'));

      expect(err.status).toBe(404);
      expect(err.code).toBe('session_not_found');
    });

    it('deletes a saved session', async () => {
      saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');

      await expect(client.deleteSession('session-saved', workspace)).resolves.toEqual({ ok: true });

      expect(await client.getSessions(workspace)).toEqual([]);
    });
  });

  describe('planning', () => {
    it('opens the planner dialogue and carries the transcript back', async () => {
      const plan = await client.startConversation('session-plan', 'Add a limiter', ['claude-code'], workspace);

      expect(plan.tasks).toEqual([]);
      expect(plan.conversationHistory?.at(-1)?.content).toBe(TEXT.kind === 'message' ? TEXT.text : '');
      expect(pool.hasSession('session-plan')).toBe(true);
    });

    it('refuses a keyless vendor planner with a code and the reason as data, ahead of any transport call', async () => {
      delete process.env.OPENROUTER_API_KEY;

      const err = await refusal(client.startConversation('session-plan', 'Add a limiter', ['claude-code'], workspace));

      expect(err.status).toBe(409);
      expect(err.code).toBe('planner_not_ready');
      expect(err.message).toContain('Pick one with /planner');
      expect(err.plannerNotReady).toMatchObject({ code: 'no_key', provider: 'openrouter', keyEnvVar: 'OPENROUTER_API_KEY' });
      expect(OpenAiService.prototype.startConversation).not.toHaveBeenCalled();
    });

    it('commits a plan from the planner\'s reply and reads it back from the session', async () => {
      await client.startConversation('session-plan', 'Add a limiter', ['claude-code'], workspace);
      vi.mocked(OpenAiService.prototype.startConversation).mockResolvedValue({
        kind: 'plan',
        text: 'Plan generated.',
        researchLog: [],
        tasks: [createTask({ id: 'a', order: 1, title: 'Add limiter', prompt: 'p', status: 'pending' })],
      });

      const plan = await client.sendConversationMessage('session-plan', 'A token bucket');

      expect(plan.tasks.map((t) => t.id)).toEqual(['a']);
      const read = await client.getSession('session-plan', workspace);
      expect(read.meta.taskCount).toBe(1);
    });

    it('takes a reply sent while the planner is still answering in the next turn', async () => {
      let release: (turn: ConversationTurn) => void = () => {};
      await client.startConversation('session-plan', 'Add a limiter', ['claude-code'], workspace);
      vi.mocked(OpenAiService.prototype.startConversation)
        .mockReturnValueOnce(new Promise((resolve) => { release = resolve; }))
        .mockResolvedValueOnce(TEXT);

      const first = client.sendConversationMessage('session-plan', 'First');
      await vi.waitFor(() => expect(OpenAiService.prototype.startConversation).toHaveBeenCalledTimes(2));
      const second = client.sendConversationMessage('session-plan', 'Second');
      await vi.waitFor(() => expect(pool.session('session-plan').planState?.pendingTurns?.map((t) => t.text)).toEqual(['First', 'Second']));
      release(TEXT);
      await first;
      const plan = await second;

      expect(plan.conversationHistory?.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['Add a limiter', 'First', 'Second']);
    });

    it('answers a stopped turn with planner_turn_stopped, not a fault', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      await client.startConversation('session-plan', 'Add a limiter', ['claude-code'], workspace);
      vi.mocked(OpenAiService.prototype.startConversation).mockImplementation((req) => new Promise((_, reject) => {
        req.signal?.addEventListener('abort', () => reject(new Error('Request was aborted.')));
      }));

      const inFlight = refusal(client.sendConversationMessage('session-plan', 'A token bucket'));
      await vi.waitFor(() => expect(OpenAiService.prototype.startConversation).toHaveBeenCalledTimes(2));
      await expect(client.cancelPlanning('session-plan')).resolves.toEqual({ cancelled: true });
      const err = await inFlight;

      expect(err.status).toBe(409);
      expect(err.code).toBe('planner_turn_stopped');
      expect(log).not.toHaveBeenCalled();
    });

    it('asks to initialize a directory with no project marker, carrying the directory', async () => {
      const bare = join(dir, 'bare');
      mkdirSync(bare);

      const err = await refusal(client.startConversation('session-bare', 'Add a limiter', ['claude-code'], bare));

      expect(err).toBeInstanceOf(WorkspaceInitNeededError);
      expect(err.code).toBe('workspace_not_a_project');
      expect((err as WorkspaceInitNeededError).workspace).toBe(bare);
    });

    it('says workspace_not_found for a directory that does not exist', async () => {
      const err = await refusal(client.startConversation('session-gone', 'Add a limiter', ['claude-code'], join(dir, 'nowhere')));

      expect(err.status).toBe(400);
      expect(err.code).toBe('workspace_not_found');
    });

    it('serves the model catalog in the contract shape', async () => {
      const catalog = await client.getModels();

      expect(catalog).toMatchObject({ models: [], modelsByRunner: expect.any(Object), providers: expect.any(Array), orchestratorModels: expect.any(Array) });
    });
  });

  describe('execution', () => {
    it('says no_plan when the session holds no tasks', async () => {
      await client.startConversation('session-plan', 'Add a limiter', ['claude-code'], workspace);

      const err = await refusal(client.executePlan('session-plan'));

      expect(err.status).toBe(400);
      expect(err.code).toBe('no_plan');
    });

    it('answers a second start while a task is live as running, approving what waits rather than restarting the run', async () => {
      saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');
      await client.adoptSession('session-saved', workspace);

      await expect(client.executePlan('session-saved')).resolves.toMatchObject({ status: 'running' });
      await vi.waitFor(() => expect(pool.session('session-saved').isExecuting).toBe(true));
      const live = pool.session('session-saved').runSnapshot().tasks.filter((t) => t.status === 'in_progress').map((t) => t.id);

      await expect(client.executePlan('session-saved')).resolves.toMatchObject({ status: 'running' });

      expect(pool.session('session-saved').runSnapshot().tasks.filter((t) => t.status === 'in_progress').map((t) => t.id)).toEqual(live);
    });

    it('refuses a message to a task that is not running, as refused', async () => {
      saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');
      await client.adoptSession('session-saved', workspace);

      const err = await refusal(client.execute('session-saved', { command: 'interrupt_task', task: 't1' }));

      expect(err.status).toBe(400);
      expect(err.code).toBe('refused');
    });

    it('says checkpoint_not_waiting when no task waits at one', async () => {
      saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');
      await client.adoptSession('session-saved', workspace);

      const err = await refusal(client.approveTaskCheckpoint('session-saved', 't1'));

      expect(err.status).toBe(409);
      expect(err.code).toBe('checkpoint_not_waiting');
    });
  });

  describe('a control lands exactly one execution_action line, whichever surface sent it (ADR-0029)', () => {
    const silent = () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    };

    /** What the session's timeline holds of the user's controls, as the transcript every surface reads keeps it. */
    const timeline = (sessionId: string) => (pool.session(sessionId).planState?.conversationHistory ?? [])
      .filter((entry) => entry.kind === 'execution')
      .map((entry) => entry.content);

    function tui(): { deps: EffectDeps; actions: Action[] } {
      const actions: Action[] = [];
      const deps: EffectDeps = {
        api: client, workspace, port: 0, dispatch: (action) => { actions.push(action); }, newSessionId: () => 'unused',
        setEnvVar: () => {}, saveAutonomy: () => ({ overridden: false }), hasBin: () => true,
        login: async () => ({ ok: true }),
        exit: () => {},
        reviveDaemon: async () => false, setMouseCapture: () => {}, writeTerminal: () => {},
      };
      return { deps, actions };
    }

    interface Control {
      name: string;
      /** The state the control acts on, reached through the daemon. */
      before?: (sessionId: string) => Promise<void>;
      cli?: (sessionId: string) => Promise<void>;
      effect: (sessionId: string) => Effect;
      /** The line it keeps, the same whichever surface sent it; none when the control had nothing to do. */
      line: string | null;
    }

    const running = async (sessionId: string) => { await client.executePlan(sessionId); await vi.waitFor(() => expect(spawned).toHaveLength(1)); };
    const confirmed = (effect: Effect, seen: TaskStatus): Effect => (effect.type === 'taskAction' ? { ...effect, confirmed: { seen } } : effect);
    const task = (sessionId: string, action: 'complete' | 'uncomplete' | 'skip' | 'retry' | 'cancel' | 'force-start'): Effect => ({ type: 'taskAction', sessionId, taskId: 't1', action });

    const controls: Control[] = [
      { name: 'Mark complete', cli: (id) => handleMarkComplete(['--session-id', id, '--workspace', workspace, '1'], client, async () => true), effect: (id) => confirmed(task(id, 'complete'), 'pending'), line: 'You marked task #1 "Add the limiter" complete.' },
      {
        name: 'Mark not done',
        before: async (id) => { await client.execute(id, { command: 'mark_complete', task: 't1', confirmed: true }); },
        cli: (id) => handleUncomplete(['--session-id', id, '--workspace', workspace, '1'], client, async () => true),
        effect: (id) => confirmed(task(id, 'uncomplete'), 'completed'),
        line: 'You marked task #1 "Add the limiter" not done.',
      },
      { name: 'Skip', cli: (id) => handleSkip(['--session-id', id, '1'], client), effect: (id) => task(id, 'skip'), line: 'You skipped task #1 "Add the limiter".' },
      { name: 'Force start', cli: (id) => handleForceStart(['--session-id', id, '1', '--yes'], client), effect: (id) => task(id, 'force-start'), line: 'You force started task #1 "Add the limiter".' },
      { name: 'Cancel', before: running, cli: (id) => handleCancel(['--session-id', id, '1'], client), effect: (id) => task(id, 'cancel'), line: 'You stopped task #1 "Add the limiter".' },
      { name: 'Stop', before: running, cli: (id) => handleStop(['--session-id', id], client), effect: (id) => ({ type: 'stopExecution', sessionId: id }), line: 'You stopped the run.' },
      { name: 'a Stop with nothing running', cli: (id) => handleStop(['--session-id', id], client), effect: (id) => ({ type: 'stopExecution', sessionId: id }), line: null },
      { name: 'Interrupt', before: running, effect: (id) => ({ type: 'interruptTask', sessionId: id, taskId: 't1' }), line: 'You interrupted task #1 "Add the limiter".' },
      {
        name: 'a checkpoint answer',
        before: async (id) => {
          await running(id);
          void spawned[0].callCheckpoint('Drop the table?');
          await vi.waitFor(() => expect(pool.session(id).awaitsCheckpoint('t1')).toBe(true));
        },
        cli: (id) => handleCheckpoint(['--session-id', id, '1', 'approve'], client),
        effect: (id) => ({ type: 'answerTaskCheckpoint', sessionId: id, taskId: 't1', answer: 'approve' }),
        line: 'You approved the checkpoint of task #1 "Add the limiter".',
      },
    ];

    it.each(controls.flatMap((control) => [
      ...(control.cli ? [[control.name, 'the CLI', control] as const] : []),
      [control.name, 'the TUI', control] as const,
    ]))('%s from %s', async (_name, surface, control) => {
      silent();
      saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');
      await client.adoptSession('session-saved', workspace);
      await control.before?.('session-saved');
      const kept = timeline('session-saved').length;

      if (surface === 'the CLI') await control.cli!('session-saved');
      else {
        const { deps, actions } = tui();
        await runEffect(control.effect('session-saved'), deps);
        expect(actions.filter((a) => a.type === 'failed')).toEqual([]);
      }

      expect(timeline('session-saved').slice(kept)).toEqual(control.line ? [control.line] : []);
    });
  });

  describe('settings', () => {
    it('reads the settings in the contract shape', async () => {
      const settings = await client.getSettings();

      expect(settings).toMatchObject({
        aiProvider: 'openrouter',
        orchestratorModel: 'openrouter/auto',
      });
      expect(settings).not.toHaveProperty('runnerTransport');
      expect(settings).not.toHaveProperty('verification');
      expect(settings).not.toHaveProperty('tdd');
    });

    it('names the model a planner switch landed on and why', async () => {
      const switched = await client.updateSettings({ env: { AI_PROVIDER: 'claude-code' } });

      expect(switched.aiProvider).toBe('claude-code');
      expect(switched.switchRecall).toEqual({ model: '', effort: '', source: 'none' });
    });

    it('carries no recall for a write that left the planner alone', async () => {
      const written = await client.updateSettings({ modelAllowlist: { opencode: ['a/b'] } });

      expect(written.modelAllowlist).toEqual({ opencode: ['a/b'] });
      expect(written.switchRecall).toBeUndefined();
    });

    it('names the env keys it refused', async () => {
      const written = await client.updateSettings({ env: { PATH: '/tmp/evil' } });

      expect(written.rejectedEnvKeys).toEqual(['PATH']);
    });

    it('refuses an empty write', async () => {
      const err = await refusal(client.updateSettings({}));

      expect(err.status).toBe(400);
    });

    it('reads the runners the daemon offers', async () => {
      const { runners, orchestratorModel } = await client.getRunners();

      expect(Array.isArray(runners)).toBe(true);
      expect(orchestratorModel).toBe('openrouter/auto');
    });
  });
});
