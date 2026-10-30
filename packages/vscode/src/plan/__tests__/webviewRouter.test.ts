import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createSession, flattenTasks, loadSession, RunnerRegistry, BufferedTaskOutputSource, createTask } from '@ordewell/core';
import type { IAiService, IRunner, LegacyPlanState, ModelResolver, Session, SessionMessage } from '@ordewell/core';
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
  const runner = { spawn: vi.fn(), stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as unknown as IRunner;
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
    taskOutput: new BufferedTaskOutputSource(),
  });
  session.loadPlan(plan(), 'build me a parser', workspace, { persist: false });

  let current = session.planState!;
  let goal = 'build me a parser';
  let pending: string[] | undefined;
  const deps: WebviewRouterDeps = {
    session,
    chatProvider,
    modelResolver: {} as unknown as WebviewRouterDeps['modelResolver'],
    runnerRegistry: new RunnerRegistry(),
    config: { aiProvider: 'openrouter', apiKey: 'sk-test', getProviderApiKey: () => 'sk-test', planningModel: 'some/model', enabledRunners: ['claude-code'] } as unknown as WebviewRouterDeps['config'],
    fsAdapter: { getWorkspaceRoot: () => workspace } as unknown as WebviewRouterDeps['fsAdapter'],
    runner: { stopAll: vi.fn() } as unknown as WebviewRouterDeps['runner'],
    notifications: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), confirm: vi.fn() },
    getCurrentPlan: () => current,
    setCurrentPlan: (p) => { current = p; },
    getCurrentGoal: () => goal,
    setCurrentGoal: (g) => { goal = g; },
    isGeneratingPlan: () => session.isPlannerBusy,
    persistState: vi.fn(),
    saveCurrentSession: vi.fn(),
    sendRunSettings: vi.fn(),
    log: () => {},
    extension: {
      ready: vi.fn(),
      refreshModels: vi.fn(),
      runSlashCommand: vi.fn(async () => {}),
      setPlanner: vi.fn(async () => {}),
      setPlannerModel: vi.fn(async () => {}),
      openTaskLog: vi.fn(),
      openFile: vi.fn(),
      setPlanDockHeight: vi.fn(),
      changeSettings: vi.fn(async () => {}),
      setRunnerEnabled: vi.fn(async () => {}),
      loginPlanner: vi.fn(async () => {}),
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

  it('answers a task command catalog request from the Session without planner commands', async () => {
    await h.route({ type: 'getTaskCommands', taskId: 't1' });
    expect(h.posts).toContainEqual({ type: 'taskCommands', taskId: 't1', commands: [] });
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

    it('hand-set skills land in the session, trimmed and deduplicated', async () => {
      await h.route({ type: 'editTask', taskId: 't1', edit: { kind: 'skills', skills: [' tdd', 'tdd'] } });

      expect(taskOf(h.session, 't1')?.skills).toEqual(['tdd']);
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
    it('skip ends the task as skipped through the scheduler, landing nothing, so its dependents can start', async () => {
      await h.route({ type: 'sendSystemCommand', command: 'skip', taskId: 't1' });

      expect(taskOf(h.session, 't1')?.status).toBe('skipped');
    });

    // Execute re-adopts the plan into the Session; adopting it under an empty
    // workspace sent every later save (one per verdict) to the extension
    // host's cwd instead of the workspace's session store.
    it('execute keeps the session saving into the workspace', async () => {
      await h.route({ type: 'sendSystemCommand', command: 'executePlan', taskId: '' });
      await h.route({ type: 'sendSystemCommand', command: 'skip', taskId: 't1' });

      const saved = loadSession(h.session.sessionId, h.workspace);
      expect(saved?.plan.tasks.find((t) => t.id === 't1')?.status).toBe('skipped');
    });

    it.each([
      ['resumeNow', { command: 'retry_task', task: 't1', from: 'session' }],
      ['cancelResume', { command: 'cancel_resume', task: 't1' }],
      ['forceStart', { command: 'force_start', task: 't1' }],
    ] as const)('%s reaches the command seam as the user', async (command, expected) => {
      const execute = vi.spyOn(h.session, 'execute').mockResolvedValue({ ok: true, message: 'done' });
      await h.route({ type: 'sendSystemCommand', command, taskId: 't1' });

      expect(execute).toHaveBeenCalledWith(expected, { kind: 'user' });
    });

    it.each([
      ['markComplete', 'Mark complete', { command: 'mark_complete', task: 't1', confirmed: true, seen: 'pending' }],
      ['markIncomplete', 'Mark not done', { command: 'mark_not_done', task: 't1', confirmed: true, seen: 'pending' }],
    ] as const)('%s reaches the command seam as the user only once the modal is answered %s', async (command, yes, expected) => {
      const execute = vi.spyOn(h.session, 'execute').mockResolvedValue({ ok: true, message: 'done' });
      showWarningMessage.mockClear();
      showWarningMessage.mockResolvedValueOnce(undefined);
      await h.route({ type: 'sendSystemCommand', command, taskId: 't1' });
      expect(execute).not.toHaveBeenCalled();

      showWarningMessage.mockResolvedValueOnce(yes);
      await h.route({ type: 'sendSystemCommand', command, taskId: 't1' });

      expect(showWarningMessage).toHaveBeenLastCalledWith(expect.stringContaining('?'), { modal: true }, yes);
      expect(execute).toHaveBeenCalledWith(expected, { kind: 'user' });
    });

    it('shows the seam\'s refusal of a control, in the seam\'s own words', async () => {
      vi.spyOn(h.session, 'execute').mockResolvedValue({ ok: false, outcome: 'refused', message: 'Task #1 "Parse JSON" is not running, so there is nothing to stop.' });
      showWarningMessage.mockClear();

      await h.route({ type: 'sendSystemCommand', command: 'cancel', taskId: 't1' });
      await h.route({ type: 'sendSystemCommand', command: 'resumeNow', taskId: 't1' });

      expect(showWarningMessage.mock.calls.map((c) => c[0])).toEqual([
        'Task #1 "Parse JSON" is not running, so there is nothing to stop.',
        'Task #1 "Parse JSON" is not running, so there is nothing to stop.',
      ]);
    });

    it('retry reaches the command seam as the user', async () => {
      const execute = vi.spyOn(h.session, 'execute').mockResolvedValue({ ok: true, message: 'Retrying task #2 "Stream it".' });
      await h.route({ type: 'sendSystemCommand', command: 'retry', taskId: 't2' });

      expect(execute).toHaveBeenCalledWith({ command: 'retry_task', task: 't2', from: 'fresh' }, { kind: 'user' });
    });

    it('execute, stop, cancel and run reach the command seam as the user', async () => {
      const execute = vi.spyOn(h.session, 'execute').mockResolvedValue({ ok: true, message: 'done' });

      await h.route({ type: 'sendSystemCommand', command: 'executePlan', taskId: '' });
      await h.route({ type: 'sendSystemCommand', command: 'stopExecution', taskId: '' });
      await h.route({ type: 'sendSystemCommand', command: 'cancel', taskId: 't1' });
      await h.route({ type: 'sendSystemCommand', command: 'runTask', taskId: 't2' });

      expect(execute).toHaveBeenCalledWith({ command: 'run_plan' }, { kind: 'user' });
      expect(execute).toHaveBeenCalledWith({ command: 'stop_run' }, { kind: 'user' });
      expect(execute).toHaveBeenCalledWith({ command: 'stop_task', task: 't1' }, { kind: 'user' });
      expect(execute).toHaveBeenCalledWith({ command: 'run_task', task: 't2' }, { kind: 'user' });
    });

    it('Stop with nothing running is the seam\'s ok no-op: nothing is shown, and the runner is stopped all the same', async () => {
      showWarningMessage.mockClear();

      await h.route({ type: 'sendSystemCommand', command: 'stopExecution', taskId: '' });

      expect(showWarningMessage).not.toHaveBeenCalled();
      expect(h.deps.runner.stopAll).toHaveBeenCalled();
    });

    it('a Stop the seam refuses is shown, and stops nothing', async () => {
      vi.spyOn(h.session, 'execute').mockResolvedValue({ ok: false, outcome: 'refused', message: 'Could not stop the run.' });
      showWarningMessage.mockClear();

      await h.route({ type: 'sendSystemCommand', command: 'stopExecution', taskId: '' });

      expect(showWarningMessage).toHaveBeenCalledWith('Could not stop the run.');
      expect(h.deps.runner.stopAll).not.toHaveBeenCalled();
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

    it('answers a checkpoint either way through the seam, a rejection carrying its reason', async () => {
      const execute = vi.spyOn(h.session, 'execute').mockResolvedValue({ ok: true, message: 'done' });

      await h.route({ type: 'answerCheckpoint', taskId: 't1', approved: true });
      await h.route({ type: 'answerCheckpoint', taskId: 't2', approved: false, reason: 'wrong approach' });

      expect(execute.mock.calls).toEqual([
        [{ command: 'answer_checkpoint', task: 't1', answer: 'approve' }, { kind: 'user' }],
        [{ command: 'answer_checkpoint', task: 't2', answer: 'reject', reason: 'wrong approach' }, { kind: 'user' }],
      ]);
    });

    it('answers an escalation through the session and tells the webview what it said, a refusal in its own words', async () => {
      const answer = vi.spyOn(h.session, 'answerEscalation')
        .mockResolvedValueOnce({ ok: true, message: 'Retried.' })
        .mockResolvedValueOnce({ ok: false, outcome: 'refused', message: 'That is no longer waiting on you.' });

      await h.route({ type: 'answerEscalation', requestId: 'r1', id: 'failed:t1:2', option: 'retry' });
      await h.route({ type: 'answerEscalation', requestId: 'r2', id: 'failed:t1:1', option: 'complete', note: 'by hand', confirmed: true });

      expect(answer.mock.calls).toEqual([
        ['failed:t1:2', 'retry', undefined, undefined],
        ['failed:t1:1', 'complete', 'by hand', true],
      ]);
      expect(h.posts.filter((m) => m.type === 'escalationAnswered')).toEqual([
        { type: 'escalationAnswered', requestId: 'r1', id: 'failed:t1:2', ok: true },
        { type: 'escalationAnswered', requestId: 'r2', id: 'failed:t1:1', ok: false, message: 'That is no longer waiting on you.' },
      ]);
    });

    it('tells the webview an escalation answer threw, so its entry does not stay sending', async () => {
      vi.spyOn(h.session, 'answerEscalation').mockRejectedValue(new Error('git said no'));

      await h.route({ type: 'answerEscalation', requestId: 'r1', id: 'failed:t1:2', option: 'retry' });

      expect(h.posts.filter((m) => m.type === 'escalationAnswered')).toEqual([
        { type: 'escalationAnswered', requestId: 'r1', id: 'failed:t1:2', ok: false, message: 'git said no' },
      ]);
    });

    it('sends a message, a removal, an interrupt and a force send through the command seam as the user', async () => {
      const execute = vi.spyOn(h.session, 'execute').mockResolvedValue({ ok: true, message: 'done' });

      await h.route({ type: 'sendTaskMessage', taskId: 't1', text: 'use Postgres' });
      await h.route({ type: 'removeQueuedTaskMessage', taskId: 't1', id: 'msg-1' });
      await h.route({ type: 'interruptTask', taskId: 't1' });
      await h.route({ type: 'sendTaskMessageNow', taskId: 't1', text: 'stop now' });
      await h.route({ type: 'sendQueuedTaskMessageNow', taskId: 't1', id: 'msg-1' });

      expect(execute.mock.calls).toEqual([
        [{ command: 'message_task', task: 't1', text: 'use Postgres' }, { kind: 'user' }],
        [{ command: 'remove_queued', task: 't1', id: 'msg-1' }, { kind: 'user' }],
        [{ command: 'interrupt_task', task: 't1' }, { kind: 'user' }],
        [{ command: 'message_task', task: 't1', text: 'stop now', force: true }, { kind: 'user' }],
        [{ command: 'force_send_queued', task: 't1', id: 'msg-1' }, { kind: 'user' }],
      ]);
    });

    it('tells the user when a queued message could not be taken back or sent now', async () => {
      vi.spyOn(h.session, 'execute').mockResolvedValue({ ok: false, outcome: 'refused', message: 'The runner has already read that message.' });
      showWarningMessage.mockClear();

      await h.route({ type: 'removeQueuedTaskMessage', taskId: 't1', id: 'msg-1' });
      await h.route({ type: 'sendQueuedTaskMessageNow', taskId: 't1', id: 'msg-1' });

      expect(showWarningMessage.mock.calls.map((c) => String(c[0]))).toEqual([
        'The runner has already read that message.',
        'The runner has already read that message.',
      ]);
    });

    describe('a runner request\'s card', () => {
      const runnerRequest = { id: 'ap-1', createdAt: '', request: { kind: 'runner_tool' as const, subject: 'Bash(npm test)', scope: 'Bash', taskId: 't1' } };

      it.each([
        [true, { command: 'answer_approval', task: 't1', approval: 'ap-1', answer: 'allow' }],
        [false, { command: 'answer_approval', task: 't1', approval: 'ap-1', answer: 'deny' }],
      ] as const)('is answered (granted: %s) through the seam as the user', async (granted, expected) => {
        vi.spyOn(h.session, 'outstandingApprovals').mockReturnValue([runnerRequest]);
        const execute = vi.spyOn(h.session, 'execute').mockResolvedValue({ ok: true, message: 'done' });
        const resolve = vi.spyOn(h.session, 'resolveApproval');

        await h.route({ type: 'resolveApproval', id: 'ap-1', granted });

        expect(execute).toHaveBeenCalledWith(expected, { kind: 'user' });
        expect(resolve).not.toHaveBeenCalled();
      });

      it('shows a refused answer instead of dropping it', async () => {
        vi.spyOn(h.session, 'outstandingApprovals').mockReturnValue([runnerRequest]);
        vi.spyOn(h.session, 'execute').mockResolvedValue({ ok: false, outcome: 'refused', message: 'Task #1 "Parse JSON" has no request waiting for an answer.' });
        showWarningMessage.mockClear();

        await h.route({ type: 'resolveApproval', id: 'ap-1', granted: false });

        expect(showWarningMessage).toHaveBeenCalledWith('Task #1 "Parse JSON" has no request waiting for an answer.');
      });

      it('leaves a request that is not a runner\'s to the approval path', async () => {
        vi.spyOn(h.session, 'outstandingApprovals').mockReturnValue([{ id: 'ap-2', createdAt: '', request: { kind: 'task_start', subject: 'Start #1', scope: 'task_start' } }]);
        const execute = vi.spyOn(h.session, 'execute');
        const resolve = vi.spyOn(h.session, 'resolveApproval').mockReturnValue(true);

        await h.route({ type: 'resolveApproval', id: 'ap-2', granted: true });

        expect(resolve).toHaveBeenCalledWith('ap-2', true);
        expect(execute).not.toHaveBeenCalled();
      });
    });

    it('shows the seam\'s refusal of a task that cannot take a message', async () => {
      showWarningMessage.mockClear();

      await h.route({ type: 'sendTaskMessage', taskId: 't1', text: 'hello' });
      await h.route({ type: 'interruptTask', taskId: 't1' });

      expect(showWarningMessage.mock.calls.map((c) => String(c[0]))).toEqual([
        expect.stringContaining('is not running'),
        expect.stringContaining('is not running'),
      ]);
    });
  });

  describe('a handler that rejects', () => {
    it.each([
      ['setPlanner', { type: 'setPlanner', provider: 'openrouter' }],
      ['setPlannerModel', { type: 'setPlannerModel', modelId: 'some/model' }],
      ['changeSettings', { type: 'changeSettings', change: { key: 'maxParallelSessions', value: 2 } }],
    ] as unknown as Array<[keyof WebviewRouterDeps['extension'], WebviewToHost]>)(
      'tells the user instead of leaving %s an unhandled rejection',
      async (handler, msg) => {
        vi.mocked(h.deps.extension[handler] as (...args: unknown[]) => unknown).mockRejectedValueOnce(new Error('config write refused'));

        await expect(h.route(msg)).resolves.toBeUndefined();

        expect(h.deps.notifications.error).toHaveBeenCalledWith(expect.stringContaining('config write refused'));
      },
    );

    it.each<['addTask' | 'removeTask', WebviewToHost]>([
      ['addTask', { type: 'addTask', draft: { title: 'Docs', dependencies: [] } }],
      ['removeTask', { type: 'removeTask', taskId: 't2' }],
    ])('tells the user when the session refuses a %s', async (method, msg) => {
      showWarningMessage.mockResolvedValue('Remove');
      vi.spyOn(h.session, method).mockRejectedValue(new Error('plan is locked'));

      await expect(h.route(msg)).resolves.toBeUndefined();

      expect(h.deps.notifications.error).toHaveBeenCalledWith(expect.stringContaining('plan is locked'));
    });
  });

  describe('a held prompt that fails when it is sent on', () => {
    it('is reported too, not left an unhandled rejection', async () => {
      h.deps.chatProvider.conversation.holdPrompt('queued while busy');
      h.deps.getPendingRunners = () => { throw new Error('runner set unreadable'); };

      await h.route({ type: 'sendMessage', text: '/refresh', typed: true });
      await vi.waitFor(() => expect(h.deps.notifications.error).toHaveBeenCalledWith(expect.stringContaining('runner set unreadable')));
    });
  });

  // The context-pause bar's Retry is a planner turn the chat did not send, so
  // nothing in sendChat drains the prompt typed while it ran.
  describe('a prompt held during a Retry compaction', () => {
    it.each([
      ['it lands', () => Promise.resolve(h.session.planState!)],
      ['it fails', () => Promise.reject(new Error('rate limited'))],
    ])('is sent once when %s', async (_case, retry) => {
      vi.spyOn(h.session, 'retryPlannerCompaction').mockImplementation(retry);
      const converse = vi.spyOn(h.session, 'continueConversation').mockResolvedValue(h.session.planState!);
      h.deps.chatProvider.conversation.holdPrompt('typed during the retry');

      await h.route({ type: 'sendSystemCommand', command: 'retryPlannerCompaction' });

      expect(converse).toHaveBeenCalledTimes(1);
      expect(converse).toHaveBeenCalledWith('typed during the retry');
    });

    it('stays held while the planner is still busy', async () => {
      vi.spyOn(h.session, 'retryPlannerCompaction').mockResolvedValue(h.session.planState!);
      const converse = vi.spyOn(h.session, 'continueConversation').mockResolvedValue(h.session.planState!);
      h.deps.isGeneratingPlan = () => true;
      h.deps.chatProvider.conversation.holdPrompt('typed during the retry');

      await h.route({ type: 'sendSystemCommand', command: 'retryPlannerCompaction' });

      expect(converse).not.toHaveBeenCalled();
      const holds = h.posts.filter((m): m is Extract<HostToWebview, { type: 'heldPrompts' }> => m.type === 'heldPrompts');
      expect(holds.at(-1)?.prompts).toEqual(['typed during the retry']);
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

    it('sends now: a mid-turn message stops the planner turn through forceSendPrompt', async () => {
      const force = vi.spyOn(h.session, 'forceSendPrompt').mockResolvedValue(h.session.planState!);
      h.deps.isGeneratingPlan = () => true;

      await h.route({ type: 'sendMessageNow', text: 'use Postgres instead' });

      expect(force).toHaveBeenCalledWith('use Postgres instead');
    });

    it('sends now with no turn running as a plain send', async () => {
      const converse = vi.spyOn(h.session, 'continueConversation').mockResolvedValue(h.session.planState!);
      const force = vi.spyOn(h.session, 'forceSendPrompt').mockResolvedValue(h.session.planState!);
      h.deps.isGeneratingPlan = () => false;

      await h.route({ type: 'sendMessageNow', text: 'a normal reply' });

      expect(force).not.toHaveBeenCalled();
      expect(converse).toHaveBeenCalledWith('a normal reply');
    });

    it('sends one held prompt now by position, leaving the rest held in order', async () => {
      const force = vi.spyOn(h.session, 'forceSendPrompt').mockResolvedValue(h.session.planState!);
      h.deps.isGeneratingPlan = () => true;
      h.deps.chatProvider.conversation.holdPrompt('one');
      h.deps.chatProvider.conversation.holdPrompt('two');
      h.deps.chatProvider.conversation.holdPrompt('three');

      await h.route({ type: 'sendHeldPromptNow', index: 1 });

      expect(force).toHaveBeenCalledWith('two');
      const holds = h.posts.filter((m): m is Extract<HostToWebview, { type: 'heldPrompts' }> => m.type === 'heldPrompts');
      expect(holds.at(-1)?.prompts).toEqual(['one', 'three']);
      expect(h.posts.some((m) => m.type === 'promptUnsent')).toBe(false);
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
    [{ type: 'openFile', path: '.ordewell/sessions/s1/tasks/t1/1.patch' }, 'openFile', ['.ordewell/sessions/s1/tasks/t1/1.patch']],
    [{ type: 'setPlanDockHeight', height: 320 }, 'setPlanDockHeight', [320]],
    [{ type: 'changeSettings', change: { run: { autorun: true } } }, 'changeSettings', [{ run: { autorun: true } }]],
    [{ type: 'setRunnerEnabled', runnerId: 'codex', enabled: false, requestId: 'req-1' }, 'setRunnerEnabled', ['codex', false, 'req-1']],
    [{ type: 'loginPlanner', runner: 'codex' }, 'loginPlanner', ['codex']],
    // No runner is the active planner's login, which the host resolves.
    [{ type: 'loginPlanner' }, 'loginPlanner', [undefined]],
  ] as const)('hands %o to the extension', async (msg, handler, args) => {
    await h.route(msg as WebviewToHost);

    expect(h.deps.extension[handler]).toHaveBeenCalledWith(...args);
  });
});
