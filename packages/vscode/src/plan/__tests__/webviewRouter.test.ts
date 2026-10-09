import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createSession, flattenTasks, loadSession, RunnerRegistry, BufferedTaskOutputSource, createTask } from '@ordewell/core';
import type { IAiService, ITerminalRunner, LegacyPlanState, ModelResolver, Session, SessionMessage } from '@ordewell/core';
import { fakeConfig, fakeFileSystem } from '@ordewell/core/testing';
import { ChatViewProvider } from '../../providers/ChatViewProvider';
import type { HostToWebview, WebviewToHost } from '../../shared/protocol';
import { routeWebviewMessage, type WebviewRouterDeps } from '../webviewRouter';

const showWarningMessage = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;

function plan(): LegacyPlanState {
  const at = '2026-01-01T00:00:00Z';
  return {
    tasks: [
      createTask({ id: 't1', order: 1, title: 'Parse JSON', prompt: 'do it', assignedRunner: 'claude-code', taskMode: 'default' }),
      createTask({ id: 't2', order: 2, title: 'Stream it', prompt: 'then this', assignedRunner: 'claude-code', dependencies: ['t1'] }),
    ],
    generatedAt: at,
    status: 'draft',
    runners: ['claude-code'],
    lastUpdated: at,
    conversationHistory: [
      { role: 'user', content: 'build me a parser', timestamp: at },
      { role: 'assistant', content: 'Plan generated with 2 tasks.', timestamp: at, kind: 'plan_generated' },
    ],
  };
}

/** One task as the session holds it now, read through its public plan tree. */
function taskOf(session: Pick<Session, 'planTasks'>, taskId: string) {
  return flattenTasks(session.planTasks).find((t) => t.id === taskId);
}

function harness(aiService: Partial<IAiService> = { hasActiveConversation: () => false }) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-router-'));
  const broadcasts: SessionMessage[] = [];
  const posts: HostToWebview[] = [];
  const chatProvider = new ChatViewProvider({ toString: () => 'file:///ext' } as unknown as vscode.Uri);
  chatProvider.postMessage = (msg) => { posts.push(msg); };
  const runner = { spawn: vi.fn(), stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as unknown as ITerminalRunner;
  const session = createSession({
    config: fakeConfig(),
    notifications: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), confirm: vi.fn().mockResolvedValue(undefined) },
    runner,
    registry: new RunnerRegistry(),
    workspaceRoot: () => workspace,
    fsAdapter: fakeFileSystem(),
    broadcast: (msg) => { broadcasts.push(msg); chatProvider.conversation.receive(msg); },
    modelResolver: { getCachedRunnerModels: () => [], modelsForRunners: vi.fn().mockResolvedValue({}) } as unknown as ModelResolver,
    settings: () => ({}),
    aiService: { reset: () => {}, ...aiService } as unknown as IAiService,
    taskOutput: new BufferedTaskOutputSource({ transcripts: { finalAssistantText: async () => null } }),
  });
  session.loadPlan(plan(), 'build me a parser', workspace, { persist: false });

  let current = session.planState!;
  let goal = 'build me a parser';
  let pending: string[] | undefined;
  const deps: WebviewRouterDeps = {
    session,
    chatProvider,
    modelResolver: {} as unknown as WebviewRouterDeps['modelResolver'],
    pluginRegistry: new RunnerRegistry(),
    config: { aiProvider: 'openrouter', apiKey: 'sk-test', planningModel: 'some/model', enabledRunners: ['claude-code'] } as unknown as WebviewRouterDeps['config'],
    fsAdapter: { getWorkspaceRoot: () => workspace } as unknown as WebviewRouterDeps['fsAdapter'],
    terminalRunner: { stopAll: vi.fn() } as unknown as WebviewRouterDeps['terminalRunner'],
    notifications: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), confirm: vi.fn() },
    getCurrentPlan: () => current,
    setCurrentPlan: (p) => { current = p; },
    getCurrentGoal: () => goal,
    setCurrentGoal: (g) => { goal = g; },
    isGeneratingPlan: () => session.isPlannerBusy,
    persistState: vi.fn(),
    saveCurrentSession: vi.fn(),
    log: () => {},
    extension: {
      ready: vi.fn(),
      refreshModels: vi.fn(),
      runSlashCommand: vi.fn(async () => {}),
      setPlanner: vi.fn(async () => {}),
      setPlannerModel: vi.fn(async () => {}),
      openTaskLog: vi.fn(),
      setPlanDockHeight: vi.fn(),
    },
    getPendingRunners: () => pending,
    setPendingRunners: (r) => { pending = r; },
  };
  const route = (msg: WebviewToHost) => routeWebviewMessage(msg, deps);
  const lastPlan = () => posts.filter((m): m is Extract<HostToWebview, { type: 'planUpdated' }> => m.type === 'planUpdated').at(-1)?.plan;
  return { session, deps, route, broadcasts, posts, lastPlan, workspace };
}

describe('webview messages reach the session through one entry point each', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    showWarningMessage.mockReset();
    h = harness();
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(h.workspace, { recursive: true, force: true });
  });

  describe('task edits', () => {
    it('a model picked on a card is a session edit, broadcast to every surface', async () => {
      const assignment = { modelId: 'claude-opus-4-1', modelLabel: 'Claude Opus 4.1' };
      await h.route({ type: 'editTask', taskId: 't1', edit: { kind: 'model', assignment } });

      expect(taskOf(h.session, 't1')?.assignedModel).toEqual(assignment);
      expect(h.broadcasts).toContainEqual(expect.objectContaining({ type: 'task_updated', taskId: 't1' }));
      expect(h.deps.persistState).toHaveBeenCalled();
    });

    it('a mode the runner does not offer is refused, and the card is re-shown with what was kept', async () => {
      await h.route({ type: 'editTask', taskId: 't1', edit: { kind: 'mode', mode: 'no-such-mode' } });

      expect(taskOf(h.session, 't1')?.taskMode).toBe('default');
      expect(showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('no-such-mode'));
      expect(h.lastPlan()?.tasks.find((t) => t.id === 't1')?.taskMode).toBe('default');
    });

    it('a mode the runner offers lands in the session', async () => {
      await h.route({ type: 'editTask', taskId: 't1', edit: { kind: 'mode', mode: 'plan' } });

      expect(taskOf(h.session, 't1')?.taskMode).toBe('plan');
    });

    it('a prompt edit lands in the session and is shown', async () => {
      await h.route({ type: 'editTask', taskId: 't2', edit: { kind: 'prompt', prompt: 'stream it in chunks' } });

      expect(taskOf(h.session, 't2')?.prompt).toBe('stream it in chunks');
      expect(h.lastPlan()?.tasks.find((t) => t.id === 't2')?.prompt).toBe('stream it in chunks');
    });

    it('clearing every dependency is an edit, not a removal', async () => {
      await h.route({ type: 'editTask', taskId: 't2', edit: { kind: 'dependencies', dependencies: [] } });

      expect(taskOf(h.session, 't2')?.dependencies).toEqual([]);
      expect(h.session.planTasks).toHaveLength(2);
    });
  });

  describe('task actions', () => {
    it('skip completes the task through the scheduler, so its dependents can start', async () => {
      await h.route({ type: 'sendSystemCommand', command: 'skip', taskId: 't1' });

      expect(taskOf(h.session, 't1')?.status).toBe('completed');
    });

    // Execute re-adopts the plan into the Session; adopting it under an empty
    // workspace sent every later save (one per verdict) to the extension
    // host's cwd instead of the workspace's session store.
    it('execute keeps the session saving into the workspace', async () => {
      await h.route({ type: 'sendSystemCommand', command: 'executePlan', taskId: '' });
      await h.route({ type: 'sendSystemCommand', command: 'skip', taskId: 't1' });

      const saved = loadSession(h.session.sessionId, h.workspace);
      expect(saved?.plan.tasks.find((t) => t.id === 't1')?.status).toBe('completed');
    });

    it('retry reaches the session', async () => {
      const retry = vi.spyOn(h.session, 'retryTask').mockResolvedValue();
      await h.route({ type: 'sendSystemCommand', command: 'retry', taskId: 't2' });

      expect(retry).toHaveBeenCalledWith('t2');
    });

    it('removes a task only once the user confirms, naming what depends on it', async () => {
      showWarningMessage.mockResolvedValueOnce(undefined);
      await h.route({ type: 'removeTask', taskId: 't1' });
      expect(h.session.planTasks).toHaveLength(2);
      expect(showWarningMessage.mock.calls[0][0]).toContain('#2 Stream it');

      showWarningMessage.mockResolvedValueOnce('Remove');
      await h.route({ type: 'removeTask', taskId: 't1' });
      expect(h.session.planTasks.map((t) => t.id)).toEqual(['t2']);
    });

    it('adds a drafted task, and ignores a draft with no title', async () => {
      await h.route({ type: 'addTask', draft: { title: '   ', dependencies: [] } });
      expect(h.session.planTasks).toHaveLength(2);

      await h.route({ type: 'addTask', draft: { title: 'Docs', dependencies: ['t2'] } });
      expect(h.session.planTasks.at(-1)).toMatchObject({ title: 'Docs', prompt: 'Docs', dependencies: ['t2'] });
    });

    it('answers a checkpoint either way, a rejection carrying its reason', async () => {
      const approve = vi.spyOn(h.session, 'approveCheckpoint').mockImplementation(() => {});
      const reject = vi.spyOn(h.session, 'rejectCheckpoint').mockImplementation(() => {});

      await h.route({ type: 'answerCheckpoint', taskId: 't1', approved: true });
      await h.route({ type: 'answerCheckpoint', taskId: 't2', approved: false, reason: 'wrong approach' });

      expect(approve).toHaveBeenCalledWith('t1');
      expect(reject).toHaveBeenCalledWith('t2', 'wrong approach');
    });

    it('sends, takes back and interrupts on a structured task through the Session', async () => {
      const send = vi.spyOn(h.session, 'sendTaskMessage').mockReturnValue('msg-1');
      const remove = vi.spyOn(h.session, 'removeQueuedTaskMessage').mockReturnValue(true);
      const interrupt = vi.spyOn(h.session, 'interruptTask').mockResolvedValue();

      await h.route({ type: 'sendTaskMessage', taskId: 't1', text: 'use Postgres' });
      await h.route({ type: 'removeQueuedTaskMessage', taskId: 't1', id: 'msg-1' });
      await h.route({ type: 'interruptTask', taskId: 't1' });

      expect(send).toHaveBeenCalledWith('t1', 'use Postgres');
      expect(remove).toHaveBeenCalledWith('t1', 'msg-1');
      expect(interrupt).toHaveBeenCalledWith('t1');
    });

    it('force sends a new or a queued message through the Session, and warns when the runner already had it', async () => {
      const now = vi.spyOn(h.session, 'forceSendTaskMessage').mockReturnValue('msg-2');
      const queued = vi.spyOn(h.session, 'forceSendQueuedTaskMessage').mockReturnValue(false);
      showWarningMessage.mockClear();

      await h.route({ type: 'sendTaskMessageNow', taskId: 't1', text: 'stop now' });
      await h.route({ type: 'sendQueuedTaskMessageNow', taskId: 't1', id: 'msg-1' });

      expect(now).toHaveBeenCalledWith('t1', 'stop now');
      expect(queued).toHaveBeenCalledWith('t1', 'msg-1');
      expect(showWarningMessage.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining('runner already has that message')]);
    });

    it('shows the Session\'s refusal of a task that cannot take a message', async () => {
      showWarningMessage.mockClear();

      await h.route({ type: 'sendTaskMessage', taskId: 't1', text: 'hello' });
      await h.route({ type: 'interruptTask', taskId: 't1' });

      expect(showWarningMessage.mock.calls.map((c) => String(c[0]))).toEqual([
        expect.stringContaining('is not running'),
        expect.stringContaining('is not running'),
      ]);
    });
  });

  describe('chat', () => {
    it('sends a known slash command to the extension, and anything else to the planner', async () => {
      const converse = vi.spyOn(h.session, 'continueConversation').mockResolvedValue(h.session.planState!);

      await h.route({ type: 'sendMessage', text: '/refresh', typed: true });
      await h.route({ type: 'sendMessage', text: '/my-skill do it', typed: true });

      expect(h.deps.extension.runSlashCommand).toHaveBeenCalledWith('/refresh');
      expect(converse).toHaveBeenCalledWith('/my-skill do it');
    });

    /** A live planner whose replies the test hands back one at a time, keeping each call's message and signal. */
    function heldPlanner() {
      const calls: { message: string; signal?: AbortSignal; finish: (text: string) => void }[] = [];
      const aiService: Partial<IAiService> = {
        hasActiveConversation: () => true,
        continueConversation: (message, _onProgress, signal) => new Promise((resolve) => {
          calls.push({ message, signal, finish: (text) => resolve({ kind: 'message', text, researchLog: [] }) });
        }),
      };
      return { aiService, calls };
    }

    it('holds a prompt sent right after a stop until the stopped turn has unwound, then sends it', async () => {
      const { aiService, calls } = heldPlanner();
      fs.rmSync(h.workspace, { recursive: true, force: true });
      h = harness(aiService);

      const first = h.route({ type: 'sendMessage', text: 'add streaming', typed: true });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      await h.route({ type: 'stopResearch' });
      expect(calls[0].signal?.aborted).toBe(true);
      await h.route({ type: 'sendMessage', text: 'actually, do this instead', typed: true });

      expect(calls).toHaveLength(1);

      calls[0].finish('Stopped.');
      await first;
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      expect(calls[1].message).toContain('actually, do this instead');
    });

    it('a stopped turn unwinding late leaves the turn after it busy and stoppable', async () => {
      const { aiService, calls } = heldPlanner();
      fs.rmSync(h.workspace, { recursive: true, force: true });
      h = harness(aiService);

      const first = h.route({ type: 'sendMessage', text: 'add streaming', typed: true });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      await h.route({ type: 'stopResearch' });
      await h.route({ type: 'sendMessage', text: 'next', typed: true });
      calls[0].finish('Stopped.');
      await first;
      await vi.waitFor(() => expect(calls).toHaveLength(2));

      expect(h.deps.isGeneratingPlan()).toBe(true);
      await h.route({ type: 'stopResearch' });
      expect(calls[1].signal?.aborted).toBe(true);
    });
  });

  it.each([
    [{ type: 'ready' }, 'ready', []],
    [{ type: 'refreshModels' }, 'refreshModels', []],
    [{ type: 'setPlanner', provider: 'codex' }, 'setPlanner', ['codex']],
    [{ type: 'setPlannerModel', modelId: 'gpt-5', effort: 'high' }, 'setPlannerModel', ['gpt-5', 'high']],
    [{ type: 'openTaskLog', taskId: 't1' }, 'openTaskLog', ['t1']],
    [{ type: 'setPlanDockHeight', height: 320 }, 'setPlanDockHeight', [320]],
  ] as const)('hands %o to the extension', async (msg, handler, args) => {
    await h.route(msg as WebviewToHost);

    expect(h.deps.extension[handler]).toHaveBeenCalledWith(...args);
  });
});
