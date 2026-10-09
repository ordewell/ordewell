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
  type ITerminalRunner,
  type LegacyPlanState,
} from '@ordewell/core';
import { FakeStructuredSession } from '@ordewell/core/testing';
import { createApp } from '../../../web/server/app';
import { createRequestListener } from '../../../web/server/nodeAdapter';
import { OrchestratorPool } from '../../../web/server/pool/orchestratorPool';
import { ApiClient, DaemonError, WorkspaceInitNeededError } from '../apiClient';

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

/** Tasks that start and never finish, so a run stays live until the test ends it. */
function holdingRunner(): ITerminalRunner {
  return {
    activeCount: 0,
    spawn: vi.fn(async () => new FakeStructuredSession()),
    stop: vi.fn(),
    stopAll: vi.fn(),
  };
}

describe('the daemon contract: ApiClient against the real daemon', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let dir: string;
  let workspace: string;
  let pool: OrchestratorPool;
  let server: http.Server;
  let client: ApiClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ordewell-contract-'));
    workspace = join(dir, 'ws');
    mkdirSync(join(workspace, '.git'), { recursive: true });
    for (const key of ['HOME', 'ORDEWELL_SETTINGS_PATH', 'AI_PROVIDER', 'ORCHESTRATOR_MODEL', 'ORDEWELL_PLANNER_EFFORT']) {
      savedEnv[key] = process.env[key];
    }
    process.env.HOME = dir;
    process.env.ORDEWELL_SETTINGS_PATH = join(dir, 'settings.json');
    process.env.AI_PROVIDER = 'openrouter';
    process.env.ORCHESTRATOR_MODEL = 'openrouter/auto';
    vi.spyOn(OpenAiService.prototype, 'startConversation').mockResolvedValue(TEXT);
    vi.spyOn(GeminiService.prototype, 'startConversation').mockResolvedValue(TEXT);

    pool = new OrchestratorPool({ modelResolver: inertResolver(), runner: holdingRunner(), structuredRunner: holdingRunner() });
    server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const { token, file } = mintDaemonToken(port);
    server.on('request', createRequestListener(createApp(pool, { port, token, tokenFile: file })));
    client = new ApiClient(port, workspace);
  });

  afterEach(async () => {
    pool.destroyAll();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function refusal(call: Promise<unknown>): Promise<DaemonError> {
    const err = await call.then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
    return err as DaemonError;
  }

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

      await expect(client.markTaskComplete('session-saved', 't1')).resolves.toEqual({ ok: true });

      expect(pool.hasSession('session-saved')).toBe(true);
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

    it('refuses a reply while the planner is still answering, as conversation_busy', async () => {
      let release: (turn: ConversationTurn) => void = () => {};
      await client.startConversation('session-plan', 'Add a limiter', ['claude-code'], workspace);
      vi.mocked(OpenAiService.prototype.startConversation).mockReturnValue(new Promise((resolve) => { release = resolve; }));

      const inFlight = client.sendConversationMessage('session-plan', 'First');
      await vi.waitFor(() => expect(OpenAiService.prototype.startConversation).toHaveBeenCalledTimes(2));
      const err = await refusal(client.sendConversationMessage('session-plan', 'Second'));
      release(TEXT);
      await inFlight;

      expect(err.status).toBe(409);
      expect(err.code).toBe('conversation_busy');
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

    it('says already_executing for a second start while a task is live', async () => {
      saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');
      await client.adoptSession('session-saved', workspace);

      await expect(client.executePlan('session-saved')).resolves.toEqual({ status: 'running' });
      await vi.waitFor(() => expect(pool.session('session-saved').isExecuting).toBe(true));
      const err = await refusal(client.executePlan('session-saved'));

      expect(err.status).toBe(409);
      expect(err.code).toBe('already_executing');
    });

    it('refuses a message to a task that is not running, as refused', async () => {
      saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');
      await client.adoptSession('session-saved', workspace);

      const err = await refusal(client.interruptTask('session-saved', 't1'));

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

  describe('settings', () => {
    it('reads the settings in the contract shape', async () => {
      const settings = await client.getSettings();

      expect(settings).toMatchObject({
        aiProvider: 'openrouter',
        orchestratorModel: 'openrouter/auto',
        verification: { enabled: expect.any(Boolean) },
        runnerTransport: expect.stringMatching(/structured|terminal/),
      });
    });

    it('names the model a planner switch landed on and why', async () => {
      const switched = await client.updateSettings({ env: { AI_PROVIDER: 'claude-code' } });

      expect(switched.aiProvider).toBe('claude-code');
      expect(switched.switchRecall).toEqual({ model: '', effort: '', source: 'none' });
    });

    it('carries no recall for a write that left the planner alone', async () => {
      const written = await client.updateSettings({ verification: { enabled: false } });

      expect(written.verification).toEqual({ enabled: false });
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

    it('answers a command with the settings it left behind', async () => {
      const result = await client.sendCommand('verify', { action: 'off' });

      expect(result.ok).toBe(true);
      expect(result.settings.verification).toEqual({ enabled: false });
    });

    it('reads the runners the daemon offers', async () => {
      const { runners, orchestratorModel } = await client.getRunners();

      expect(Array.isArray(runners)).toBe(true);
      expect(orchestratorModel).toBe('openrouter/auto');
    });
  });
});
