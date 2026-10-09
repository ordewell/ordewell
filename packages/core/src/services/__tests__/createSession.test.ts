import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTask, type LegacyPlanState } from '../../models/Task';
import type { SkillInfo } from '../SkillsService';
import { makeSession, FakeStructuredSession, fakeConfig, taskOf, queue, saves } from './sessionTestKit';
import { scriptedAdapter, fakeMcpServer } from './harnessTestKit';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import type { ITerminalRunner } from '../../interfaces/ITerminalRunner';
import { parsePlanJson } from '../PlanValidator';
import { PlannerTurnStoppedError } from '../PlannerConversation';
import type { Session } from '../createSession';
import type { SessionMessage } from '../SessionMessage';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { reduceConversation, EMPTY_CONVERSATION } from '../../conversation';
import { flushMicrotasks } from '../../testing';

describe('model allowlist wiring', () => {
  function smallPlan(): LegacyPlanState {
    return {
      tasks: [createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };
  }

  it('generatePlan passes perRunnerAllowlist to planner.generate', async () => {
    const planner = { generate: vi.fn().mockResolvedValue(smallPlan()) };
    const session = makeSession({
      settings: () => ({ modelAllowlist: { 'claude-code': ['kimi-2.6'] } }),
      planner,
    });

    await session.generatePlan('test goal', ['claude-code']);

    expect(planner.generate).toHaveBeenCalledWith(
      expect.objectContaining({ perRunnerAllowlist: { 'claude-code': ['kimi-2.6'] } }),
    );
  });

  it('generatePlan stopped mid-call settles as PlannerTurnStoppedError, not the backend\'s plain abort', async () => {
    const planner = {
      generate: vi.fn((opts: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('Request was aborted.')));
      })),
    };
    const session = makeSession({ planner });

    const generation = session.generatePlan('test goal', ['claude-code']);
    await vi.waitFor(() => expect(planner.generate).toHaveBeenCalled());
    session.abortPlannerTurn();

    await expect(generation).rejects.toThrow(PlannerTurnStoppedError);
  });

  it('startPlanning filters modelsByRunner through allowlist before calling aiService', async () => {
    const startConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'hello', researchLog: [] });
    const session = makeSession({
      settings: () => ({
        modelAllowlist: { 'claude-code': ['kimi-2.6'] },
      }),
      aiService: {
        startConversation,
        hasActiveConversation: () => false,
        reset: vi.fn(),
      },
      modelResolver: {
        modelsForRunners: vi.fn().mockResolvedValue({
          'claude-code': [
            { modelId: 'kimi-2.6', modelLabel: 'Kimi 2.6', variants: [] },
            { modelId: 'gpt-5', modelLabel: 'GPT-5', variants: [] },
          ],
        }),
      },
    });

    await session.startPlanning('test goal', ['claude-code']);

    const callArgs = startConversation.mock.calls[0][0];
    expect(callArgs.modelsByRunner['claude-code']).toHaveLength(1);
    expect(callArgs.modelsByRunner['claude-code'][0].modelId).toBe('kimi-2.6');
  });

  it('live semantic: a plan committed mid-conversation is coerced against the CURRENT allowlist', async () => {
    const mutableSettings = {
      modelAllowlist: { 'claude-code': ['kimi-2.6'] } as Record<string, string[]>,
    };
    const startConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'hello', researchLog: [] });
    const continueConversation = vi.fn().mockResolvedValue({
      kind: 'plan',
      tasks: [createTask({
        id: 'p1', order: 1, title: 'Planned', prompt: 'go',
        assignedRunner: 'claude-code',
        assignedModel: { modelId: 'gpt-5', modelLabel: 'GPT-5', thinkingEffort: 'high' },
      })],
      text: 'done',
      researchLog: [],
    });
    const session = makeSession({
      settings: () => mutableSettings,
      aiService: {
        startConversation,
        continueConversation,
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
      modelResolver: {
        modelsForRunners: vi.fn().mockResolvedValue({
          'claude-code': [
            { modelId: 'kimi-2.6', modelLabel: 'Kimi 2.6', variants: [] },
            { modelId: 'gpt-5', modelLabel: 'GPT-5', variants: [] },
          ],
        }),
      },
    });

    await session.startPlanning('test goal', ['claude-code']);

    // Mid-conversation the user tightens the allowlist; the committed plan
    // must respect the allowlist as it stands at commit time.
    mutableSettings.modelAllowlist = { 'claude-code': ['deepseek-v4'] };

    const plan = await session.continueConversation('make a plan');

    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].assignedModel?.modelId).toBe('deepseek-v4');
    expect(plan.tasks[0].assignedModel?.thinkingEffort).toBeUndefined();
  });

  it('processQueuedMessages passes perRunnerAllowlist to planner.modifyDuringExecution', async () => {
    const planner = { modifyDuringExecution: vi.fn().mockResolvedValue({ pendingTasks: [], message: 'ok' }) };
    const session = makeSession({
      settings: () => ({ modelAllowlist: { 'claude-code': ['kimi-2.6'] } }),
      planner,
    });
    session.loadPlan(smallPlan(), 'Test', '/repo');

    queue(session, 'change task 1');
    await session.processQueuedMessages();

    expect(planner.modifyDuringExecution).toHaveBeenCalledWith(
      expect.objectContaining({ perRunnerAllowlist: { 'claude-code': ['kimi-2.6'] } }),
    );
  });

  it('loadPlan does NOT call filterModelsForPrompt or coerceAssignments (keeps stored modelId as-is)', () => {
    const session = makeSession();
    const plan: LegacyPlanState = {
      tasks: [createTask({
        id: 't1', order: 1, title: 'Task', prompt: 'do it',
        assignedRunner: 'claude-code',
        assignedModel: { modelId: 'out-of-allowlist-model', modelLabel: 'Stray', thinkingEffort: 'high' },
      })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };

    session.loadPlan(plan, 'Test', '/repo');

    expect(session.planState!.tasks[0].assignedModel?.modelId).toBe('out-of-allowlist-model');
    expect(session.planState!.tasks[0].assignedModel?.thinkingEffort).toBe('high');
  });
});

describe('removing a queued message', () => {
  function loadedSession(): Session {
    const session = makeSession();
    session.loadPlan({
      tasks: [createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    }, 'Test', '/repo');
    return session;
  }

  it('removes one queued message by id and leaves the rest in order', () => {
    const session = loadedSession();
    queue(session, 'first');
    queue(session, 'second');
    queue(session, 'third');

    const [first] = session.getQueuedMessages();
    expect(session.removeQueuedMessage(first.id)).toBe(true);

    expect(session.getQueuedMessages().map((m) => m.text)).toEqual(['second', 'third']);
    expect(session.getQueuedMessages().length).toBe(2);
  });

  it('saves the queue without the removed message, so a reload cannot bring it back', () => {
    const session = loadedSession();
    queue(session, 'keep', 'drop');
    const savedQueues: string[][] = [];
    saves(session).mockImplementation((plan) => { savedQueues.push((plan.queuedMessages ?? []).map((m) => m.text)); });

    const drop = session.getQueuedMessages().find((m) => m.text === 'drop')!;
    session.removeQueuedMessage(drop.id);

    expect(savedQueues.at(-1)).toEqual(['keep']);
  });

  it('reports false for an id that is not queued', () => {
    const session = loadedSession();
    queue(session, 'only');

    expect(session.removeQueuedMessage('q-nope')).toBe(false);
    expect(session.getQueuedMessages().length).toBe(1);
  });

  it('gives every queued message its own id, even within one millisecond', () => {
    const session = loadedSession();
    queue(session, 'a');
    queue(session, 'b');

    const ids = session.getQueuedMessages().map((m) => m.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('processQueuedMessages', () => {
  it('drains queued messages and clears them', async () => {
    const planner = {
      modifyDuringExecution: vi.fn().mockResolvedValue({
        pendingTasks: [createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' })],
        message: 'ok',
      }),
    };
    const session = makeSession({ planner });

    const plan: LegacyPlanState = {
      tasks: [createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };

    session.loadPlan(plan, 'Test', '/repo');

    queue(session, 'user says hi');
    queue(session, 'user asks something');

    expect(session.getQueuedMessages().length).toBe(2);

    await session.processQueuedMessages();

    expect(session.getQueuedMessages().length).toBe(0);
  });

  it('calls planner.modifyDuringExecution with execution context', async () => {
    const planner = {
      modifyDuringExecution: vi.fn().mockResolvedValue({ pendingTasks: [], message: 'ok' }),
    };
    const session = makeSession({ planner });

    const plan: LegacyPlanState = {
      tasks: [createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };

    session.loadPlan(plan, 'Test', '/repo');
    await session.executePlan();
    queue(session, 'change task 1');

    await session.processQueuedMessages();

    expect(planner.modifyDuringExecution).toHaveBeenCalledTimes(1);
    const req = planner.modifyDuringExecution.mock.calls[0][0];
    expect(req.pendingTasks).toHaveLength(1);
    expect(req.userMessage).toBe('change task 1');
  });

  it('reconciles plan when planner returns modified tasks', async () => {
    const t1 = createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' });
    const t2 = createTask({ id: 't2', order: 2, title: 'Task 2', prompt: 'then this', dependencies: ['t1'] });
    const planner = {
      modifyDuringExecution: vi.fn().mockResolvedValue({ pendingTasks: [t1, { ...t2, title: 'Modified Task', prompt: 'updated' }], message: 'Plan updated' }),
    };
    const session = makeSession({ planner });

    const plan: LegacyPlanState = {
      tasks: [t1, t2],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };

    session.loadPlan(plan, 'Test', '/repo');
    await session.executePlan();
    queue(session, 'modify');

    await session.processQueuedMessages();

    // t1 is live, so only the task that has not started takes the edit.
    const stored = taskOf(session, 't2');
    expect(stored).toBeDefined();
    expect(stored!.title).toBe('Modified Task');
    expect(session.getQueuedMessages().length).toBe(0);
  });

  it('does nothing when queue is empty', async () => {
    const planner = { modifyDuringExecution: vi.fn() };
    const session = makeSession({ planner });

    const plan: LegacyPlanState = {
      tasks: [createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };

    session.loadPlan(plan, 'Test', '/repo');

    await session.processQueuedMessages();

    expect(planner.modifyDuringExecution).not.toHaveBeenCalled();
  });

  it('applies a queued edit and resumes fan-out without any surface asking it to', async () => {
    const sessions: FakeStructuredSession[] = [];
    const runner = {
      spawn: vi.fn().mockImplementation(() => {
        const s = new FakeStructuredSession(`s${sessions.length + 1}`, `t${sessions.length + 1}`);
        sessions.push(s);
        return Promise.resolve(s);
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } as unknown as ITerminalRunner;

    const t1 = createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' });
    const t2 = createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second', dependencies: ['t1'] });
    const planner = {
      modifyDuringExecution: vi.fn().mockResolvedValue({
        // The full plan with t1 already completed so the store rebuild keeps
        // t2's dependency satisfied and getReadyTasks re-schedules t2.
        pendingTasks: [{ ...t1, status: 'completed' }, { ...t2, title: 'Second, edited', status: 'approved' }],
        message: 'ok',
      }),
    };

    const session = makeSession({ runner, planner });

    const plan: LegacyPlanState = {
      tasks: [t1, t2],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };

    session.loadPlan(plan, 'Test', '/repo');
    await session.executePlan();

    // t1 starts immediately.
    expect(runner.spawn).toHaveBeenCalledTimes(1);
    expect((runner.spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].taskId).toBe('t1');

    // Queue a structural edit, then complete t1. With the queue non-empty the
    // scheduler parks instead of spawning t2, and the Session drains the queue
    // on its own — no surface is wired to do it.
    queue(session, 'an edit');
    sessions[0].emitOutput('Done.\n');
    sessions[0].reportComplete({ status: 'done', summary: '' });
    sessions[0].emitExit(0);

    await vi.waitFor(() => expect(runner.spawn).toHaveBeenCalledTimes(2));

    expect(planner.modifyDuringExecution).toHaveBeenCalledWith(expect.objectContaining({ userMessage: 'an edit' }));
    expect(session.getQueuedMessages().length).toBe(0);
    expect(taskOf(session, 't2')!.title).toBe('Second, edited');
    expect((runner.spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[1][0].taskId).toBe('t2');
  });
});

describe('processQueuedMessages while it drains', () => {
  function held<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  function recordingRunner() {
    const sessions: FakeStructuredSession[] = [];
    const runner = {
      spawn: vi.fn().mockImplementation((opts: { taskId: string }) => {
        const s = new FakeStructuredSession(`s${sessions.length + 1}`, opts.taskId);
        sessions.push(s);
        return Promise.resolve(s);
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } as unknown as ITerminalRunner;
    const spawnedIds = () => (runner.spawn as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { taskId: string }).taskId);
    return { runner, sessions, spawnedIds };
  }

  const plan = (tasks: LegacyPlanState['tasks']): LegacyPlanState => ({
    tasks,
    generatedAt: new Date().toISOString(),
    status: 'approved',
    runners: ['claude-code'],
    lastUpdated: new Date().toISOString(),
  });

  it('keeps the scheduler paused until the planner has answered', async () => {
    const { runner, sessions, spawnedIds } = recordingRunner();
    const t1 = createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' });
    const u1 = createTask({ id: 'u1', order: 2, title: 'Sign off', type: 'user', userSteps: [{ order: 1, instruction: 'look', completed: false }] });
    const t2 = createTask({ id: 't2', order: 3, title: 'Second', prompt: 'do second', dependencies: ['t1'] });
    const answer = held<{ pendingTasks: LegacyPlanState['tasks']; message: string }>();
    const planner = { modifyDuringExecution: vi.fn().mockReturnValue(answer.promise) };
    const session = makeSession({ runner, planner });
    session.loadPlan(plan([t1, u1, t2]), 'Test', '/repo');
    await session.executePlan();
    queue(session, 'rename the second task');
    sessions[0].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(taskOf(session, 't1')!.status).toBe('completed'));

    const draining = session.processQueuedMessages();
    await vi.waitFor(() => expect(planner.modifyDuringExecution).toHaveBeenCalledTimes(1));
    await session.markTaskComplete('u1');

    expect(spawnedIds()).toEqual(['t1']);

    answer.resolve({ pendingTasks: [{ ...t1, status: 'completed' }, { ...u1, status: 'completed' }, { ...t2, title: 'Renamed' }], message: 'ok' });
    await draining;
    await vi.waitFor(() => expect(spawnedIds()).toEqual(['t1', 't2']));
    expect(taskOf(session, 't2')!.title).toBe('Renamed');
  });

  it('runs one drain at a time: a second call joins it, and what was queued meanwhile is drained after', async () => {
    const answers = [held<{ pendingTasks: LegacyPlanState['tasks']; message: string }>(), held<{ pendingTasks: LegacyPlanState['tasks']; message: string }>()];
    let inFlight = 0;
    let most = 0;
    const planner = {
      modifyDuringExecution: vi.fn().mockImplementation(async () => {
        const answer = answers[planner.modifyDuringExecution.mock.calls.length - 1];
        most = Math.max(most, ++inFlight);
        try { return await answer.promise; } finally { inFlight--; }
      }),
    };
    const t1 = createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' });
    const session = makeSession({ planner });
    session.loadPlan(plan([t1]), 'Test', '/repo');
    queue(session, 'first edit');

    const first = session.processQueuedMessages();
    await vi.waitFor(() => expect(planner.modifyDuringExecution).toHaveBeenCalledTimes(1));
    queue(session, 'second edit');
    const second = session.processQueuedMessages();
    await flushMicrotasks();
    expect(planner.modifyDuringExecution).toHaveBeenCalledTimes(1);

    answers[0].resolve({ pendingTasks: [{ ...t1, title: 'After first' }], message: 'ok' });
    await vi.waitFor(() => expect(planner.modifyDuringExecution).toHaveBeenCalledTimes(2));
    answers[1].resolve({ pendingTasks: [{ ...t1, title: 'After second' }], message: 'ok' });
    await Promise.all([first, second]);

    expect(most).toBe(1);
    expect(planner.modifyDuringExecution.mock.calls.map((c) => (c[0] as { userMessage: string }).userMessage)).toEqual(['first edit', 'second edit']);
    expect(taskOf(session, 't1')!.title).toBe('After second');
    expect(session.getQueuedMessages()).toEqual([]);
  });

  it('will not take back a message the planner already has', async () => {
    const answer = held<{ pendingTasks: LegacyPlanState['tasks']; message: string }>();
    const planner = { modifyDuringExecution: vi.fn().mockReturnValue(answer.promise) };
    const t1 = createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' });
    const session = makeSession({ planner });
    session.loadPlan(plan([t1]), 'Test', '/repo');
    queue(session, 'an edit');
    const [sent] = session.getQueuedMessages();

    const draining = session.processQueuedMessages();
    await vi.waitFor(() => expect(planner.modifyDuringExecution).toHaveBeenCalledTimes(1));

    expect(session.removeQueuedMessage(sent.id)).toBe(false);
    answer.resolve({ pendingTasks: [t1], message: 'ok' });
    await draining;
  });

  it.each([
    ['answers', (answer: ReturnType<typeof held<{ pendingTasks: LegacyPlanState['tasks']; message: string }>>, t1: LegacyPlanState['tasks'][number]) => answer.resolve({ pendingTasks: [{ ...t1, title: 'Edited for the old plan' }], message: 'ok' })],
    ['fails', (answer: ReturnType<typeof held<{ pendingTasks: LegacyPlanState['tasks']; message: string }>>) => answer.resolve(Promise.reject(new Error('planner down')) as never)],
  ] as const)('discards what the planner %s for a plan swapped out while it drained', async (_what, settle) => {
    const { runner, spawnedIds } = recordingRunner();
    const answer = held<{ pendingTasks: LegacyPlanState['tasks']; message: string }>();
    const planner = { modifyDuringExecution: vi.fn().mockReturnValue(answer.promise) };
    const onNotice = vi.fn();
    const t1 = createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' });
    const session = makeSession({ runner, planner, onNotice });
    session.loadPlan(plan([t1]), 'Test', '/repo');
    queue(session, 'an edit');

    const draining = session.processQueuedMessages();
    await vi.waitFor(() => expect(planner.modifyDuringExecution).toHaveBeenCalledTimes(1));
    const adopted = plan([createTask({ id: 't1', order: 1, title: 'Other plan', prompt: 'other' })]);
    session.loadPlan(adopted, 'Other', '/repo');
    saves(session).mockClear();
    settle(answer, t1);
    await draining;

    expect(taskOf(session, 't1')!.title).toBe('Other plan');
    expect(session.planState).toBe(adopted);
    expect(adopted.conversationHistory ?? []).toEqual([]);
    expect(saves(session)).not.toHaveBeenCalled();
    expect(onNotice).not.toHaveBeenCalled();
    expect(spawnedIds()).toEqual([]);
  });
});

describe('Session phase transitions', () => {
  it('Execute Plan spawns an AI task when planner JSON omits prompt', async () => {
    const terminal = new FakeStructuredSession('terminal-1', 't1');
    const runner = {
      spawn: vi.fn().mockResolvedValue(terminal),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies ITerminalRunner;
    const session = makeSession({ runner });
    const tasks = parsePlanJson(JSON.stringify({
      tasks: [{
        id: 't1',
        order: 1,
        title: 'Task 1',
        description: 'do it',
        type: 'ai',
        dependencies: [],
        sliceType: 'AFK',
        autonomy: 'AFK',
      }],
    }), ['claude-code']);
    const plan: LegacyPlanState = {
      tasks,
      generatedAt: new Date().toISOString(),
      status: 'draft',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };

    session.loadPlan(plan, 'Test', '/repo');
    await session.executePlan();

    expect(runner.spawn).toHaveBeenCalledOnce();
    expect(runner.spawn).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't1' }));
  });

  it('Execute Plan resumes at the first incomplete task and preserves completed dependencies', async () => {
    const terminal = new FakeStructuredSession('terminal-2', 't2');
    const runner = {
      spawn: vi.fn().mockResolvedValue(terminal),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies ITerminalRunner;
    const session = makeSession({ runner });
    const plan: LegacyPlanState = {
      tasks: [
        createTask({ id: 't1', order: 1, title: 'Already done', prompt: 'done', status: 'completed' }),
        createTask({ id: 't2', order: 2, title: 'Resume here', prompt: 'resume', dependencies: ['t1'] }),
      ],
      generatedAt: new Date().toISOString(),
      status: 'draft',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };

    session.loadPlan(plan, 'Test', '/repo');
    await session.executePlan();

    expect(taskOf(session, 't1')?.status).toBe('completed');
    expect(runner.spawn).toHaveBeenCalledOnce();
    expect(runner.spawn).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't2' }));
  });

  it('Run Task keeps the session busy until the marker and blocks Execute Plan meanwhile', async () => {
    const terminal = new FakeStructuredSession('terminal-1', 't1');
    const runner = {
      spawn: vi.fn().mockResolvedValue(terminal),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies ITerminalRunner;
    const session = makeSession({ runner });
    const plan: LegacyPlanState = {
      tasks: [
        createTask({ id: 't1', order: 1, title: 'Run only me', prompt: 'one' }),
        createTask({ id: 't2', order: 2, title: 'Leave pending', prompt: 'two' }),
      ],
      generatedAt: new Date().toISOString(),
      status: 'draft',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };

    session.loadPlan(plan, 'Test', '/repo');
    await session.runTask('t1');

    expect(session.isExecuting).toBe(true);
    expect(taskOf(session, 't1')?.status).toBe('in_progress');
    expect(taskOf(session, 't2')?.status).toBe('pending');
    await expect(session.executePlan()).rejects.toThrow('Session already executing');

    terminal.reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(session.isExecuting).toBe(false));

    expect(taskOf(session, 't1')?.status).toBe('completed');
    expect(taskOf(session, 't2')?.status).toBe('pending');
    expect(runner.spawn).toHaveBeenCalledOnce();
  });

  it("captures a finished task's reported answer", async () => {
    const terminal = new FakeStructuredSession('terminal-1', 't1');
    const runner = { spawn: vi.fn().mockResolvedValue(terminal), stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } satisfies ITerminalRunner;
    const taskOutput = new BufferedTaskOutputSource();
    const session = makeSession({ runner, taskOutput });
    session.loadPlan({
      tasks: [createTask({ id: 't1', order: 1, title: 'Only', prompt: 'one' })],
      generatedAt: new Date().toISOString(),
      status: 'draft',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    }, 'Test', '/repo');
    await session.runTask('t1');

    terminal.reportComplete({ status: 'done', summary: 'answer from the runner' });
    await vi.waitFor(() => expect(taskOf(session, 't1')?.outputSummary?.logTail).toBe('answer from the runner'));
  });

  describe('every spawn path composes the same augmented prompt', () => {
    function threeTaskPlan(): LegacyPlanState {
      return {
        tasks: [
          createTask({ id: 't1', order: 1, title: 'First', prompt: 'one' }),
          createTask({ id: 't2', order: 2, title: 'Second', prompt: 'two' }),
          createTask({ id: 't3', order: 3, title: 'Third', prompt: 'three' }),
        ],
        generatedAt: new Date().toISOString(),
        status: 'draft',
        runners: ['claude-code'],
        lastUpdated: new Date().toISOString(),
      };
    }

    function spyRunner(): ITerminalRunner & { spawn: ReturnType<typeof vi.fn> } {
      return {
        spawn: vi.fn().mockImplementation((opts: { taskId: string }) => Promise.resolve(new FakeStructuredSession(`term-${opts.taskId}`, opts.taskId))),
        stop: vi.fn(),
        stopAll: vi.fn(),
        activeCount: 0,
      } as unknown as ITerminalRunner & { spawn: ReturnType<typeof vi.fn> };
    }

    it.each([
      ['executePlan', (s: Session) => s.executePlan()],
      ['runTask', (s: Session) => s.runTask('t1')],
      ['forceStartTask', (s: Session) => s.forceStartTask('t1')],
    ])('%s carries the plan map and the completion tool', async (_name, start) => {
      const runner = spyRunner();
      const session = makeSession({ runner });
      session.loadPlan(threeTaskPlan(), 'Test', '/repo');

      await start(session);

      const prompt = runner.spawn.mock.calls.find((c) => c[0].taskId === 't1')![0].prompt as string;
      expect(prompt).toContain('← you are here');
      expect(prompt).toContain('1. [NOW    ] First');
      expect(prompt).toContain('task_complete');
      expect(prompt).not.toContain('## Task skills');
    });

    it('gives a task the skills attached to it, read from where it runs', async () => {
      const runner = spyRunner();
      const roots: (string | readonly string[])[] = [];
      const tdd: SkillInfo = {
        name: 'tdd', description: 'test-first', metadata: { name: 'tdd', description: 'test-first' },
        content: 'RED then GREEN.', path: '/home/u/.ordewell/skills/tdd/SKILL.md', source: 'global',
        appliesTo: 'task', modelInvocable: false, userInvocable: true,
      };
      const lookup = { findSkill: (name: string) => (name === 'tdd' ? tdd : undefined), listSkills: () => [tdd], searchedDirs: () => [] };
      const skillsService = { ...lookup, forRoot: (root: string | readonly string[]) => { roots.push(root); return lookup; } };
      const session = makeSession({ runner, skillsService });
      const plan = threeTaskPlan();
      plan.tasks[0].skills = ['tdd'];
      session.loadPlan(plan, 'Test', '/repo');

      await session.runTask('t1');

      expect(runner.spawn.mock.calls[0][0].prompt).toContain('### Skill: tdd\n\nRED then GREEN.');
      expect(roots).toEqual([[runner.spawn.mock.calls[0][0].cwd]]);
      expect(taskOf(session, 't1')?.attemptSkills).toEqual([{ name: 'tdd', source: 'global', path: tdd.path, content: 'RED then GREEN.' }]);
    });
  });

  it('nothing is executing before execution starts', () => {
    const session = makeSession();
    expect(session.status).toBe('approved');
    expect(session.isExecuting).toBe(false);
  });

  it('executePlan clears execution log before starting', async () => {
    const session = makeSession();
    const plan: LegacyPlanState = {
      tasks: [createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };

    session.loadPlan(plan, 'Test', '/repo');
    await session.markTaskComplete('t1');
    expect(session.executionLog).toHaveLength(1);

    await session.executePlan();

    expect(session.executionLog).toHaveLength(0);
  });

  it('the run is armed and executing once executePlan starts it', async () => {
    const session = makeSession();

    const plan: LegacyPlanState = {
      tasks: [createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };

    session.loadPlan(plan, 'Test', '/repo');
    expect(session.status).toBe('approved');
    expect(session.isExecuting).toBe(false);

    await session.executePlan();

    expect(session.status).toBe('running');
    expect(session.isExecuting).toBe(true);
  });
});

describe('currentPlanState — the live plan a surface refreshes from', () => {
  function twoParallel(): { session: Session; sessions: FakeStructuredSession[] } {
    const sessions: FakeStructuredSession[] = [];
    const runner = {
      spawn: vi.fn().mockImplementation((req: { taskId: string }) => {
        const s = new FakeStructuredSession(`s-${req.taskId}`, req.taskId);
        sessions.push(s);
        return Promise.resolve(s);
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } as unknown as ITerminalRunner;

    const session = makeSession({ runner });
    session.loadPlan(
      {
        tasks: [
          createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' }),
          createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second' }),
          createTask({ id: 't3', order: 3, title: 'Third', prompt: 'do third', dependencies: ['t1'] }),
        ],
        generatedAt: new Date().toISOString(),
        status: 'approved',
        runners: ['claude-code'],
        lastUpdated: new Date().toISOString(),
      },
      'Test',
      '/repo',
    );
    return { session, sessions };
  }

  const statusOf = (session: Session, id: string): string | undefined =>
    session.currentPlanState?.pendingTasks.find((t) => t.id === id)?.status;

  // The defect this pins: marking one task done re-read the plan through the
  // saved-session boundary, which normalizes `in_progress` to `pending` because
  // a session off disk has no runners behind it. Every sibling still executing
  // came back as never started, and the plan pane dropped its spinner.
  it('keeps a parallel sibling in_progress after another task is marked complete', async () => {
    const { session } = twoParallel();
    await session.executePlan();
    expect(statusOf(session, 't2')).toBe('in_progress');

    await session.markTaskComplete('t1');

    expect(statusOf(session, 't2')).toBe('in_progress');
  });

  it('reports a task the mark-complete just fanned out to as in_progress', async () => {
    const { session } = twoParallel();
    await session.executePlan();

    await session.markTaskComplete('t1');

    expect(statusOf(session, 't3')).toBe('in_progress');
  });

  it('moves a finished task to the execution log without duplicating it', async () => {
    const { session } = twoParallel();
    await session.executePlan();

    await session.markTaskComplete('t1');
    const state = session.currentPlanState;

    expect(state?.phase).toBe('executing');
    expect(state?.pendingTasks.map((t) => t.id)).not.toContain('t1');
    expect(state?.phase === 'executing' && state.executionLog.map((t) => t.id)).toContain('t1');
  });

  it('reports the planning phase with every task while nothing has run', () => {
    const { session } = twoParallel();

    const state = session.currentPlanState;

    expect(state?.phase).toBe('planning');
    expect(state?.pendingTasks).toHaveLength(3);
  });

  it('is null without a plan', () => {
    expect(makeSession().currentPlanState).toBeNull();
  });
});

describe('planState.tasks — written from the store, never shared with it', () => {
  function planOf(tasks: ReturnType<typeof createTask>[]): LegacyPlanState {
    return { tasks, generatedAt: '', status: 'approved', runners: ['claude-code'], lastUpdated: '' };
  }

  it('does not let an edit to the plan object reach the store, or the store reach the caller\'s tasks', () => {
    const input = [createTask({ id: 't1', order: 1, title: 'First', prompt: 'p', status: 'failed' })];
    const session = makeSession();
    session.loadPlan(planOf(input), 'Test', '/repo');

    expect(input[0].status).toBe('failed');
    expect(session.planState!.tasks[0].status).toBe('pending');

    session.planState!.tasks[0].status = 'completed';
    expect(session.planTasks[0].status).toBe('pending');
    expect(taskOf(session, 't1')!.status).toBe('pending');
  });

  // VS Code re-renders from its plan object when a status_update lands, so the
  // plan has to carry the statuses that broadcast announces.
  it('is current by the time a status_update is broadcast', async () => {
    const seen: (string | undefined)[] = [];
    const runner = {
      spawn: vi.fn().mockImplementation((req: { taskId: string }) => Promise.resolve(new FakeStructuredSession(`s-${req.taskId}`, req.taskId))),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } as unknown as ITerminalRunner;
    const session: Session = makeSession({
      runner,
      broadcast: vi.fn((msg: { type: string }) => {
        if (msg.type === 'status_update') seen.push(session.planState?.tasks[0].status);
      }),
    });
    session.loadPlan(planOf([createTask({ id: 't1', order: 1, title: 'First', prompt: 'p' })]), 'Test', '/repo');

    await session.executePlan();

    expect(seen).toContain('in_progress');
    expect(seen.at(-1)).toBe(taskOf(session, 't1')!.status);
  });
});

describe('session id stability (persist seam)', () => {
  function smallPlan(): LegacyPlanState {
    return {
      tasks: [createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };
  }

  it('persists under the host-assigned session id on every save', async () => {
    const session = makeSession({ sessionId: 'session-host-42' });
    const spy = saves(session);
    spy.mockClear();

    session.loadPlan(smallPlan(), 'Test', '/repo');
    await session.addTask({ title: 'Extra A', prompt: 'a' });
    await session.addTask({ title: 'Extra B', prompt: 'b' });

    expect(session.sessionId).toBe('session-host-42');
    expect(spy).toHaveBeenCalled();
    for (const call of spy.mock.calls) {
      expect(call[3]).toBe('session-host-42');
    }
  });

  it('mints one stable id when the host provides none', async () => {
    const session = makeSession();
    const spy = saves(session);
    spy.mockClear();

    const id = session.sessionId;
    expect(id).toMatch(/^session-[0-9a-f]+$/);

    session.loadPlan(smallPlan(), 'Test', '/repo');
    await session.addTask({ title: 'One', prompt: 'a' });
    await session.addTask({ title: 'Two', prompt: 'b' });

    expect(session.sessionId).toBe(id);
    for (const call of spy.mock.calls) {
      expect(call[3]).toBe(id);
    }
  });

  // Progress delivery is broadcast-only: ResearchProgress becomes a
  // SessionMessage inside the Session, and every surface consumes that one
  // union. There is no onProgress override for a surface to re-map through.
  it('translates every planner progress variant to a SessionMessage through broadcast', async () => {
    const broadcast = vi.fn();
    const step = { id: 's1', tool: 'read_file', args: '{"path":"x"}', result: 'ok', timestamp: '' };
    const session = makeSession({
      broadcast,
      aiService: {
        startConversation: vi.fn(async (req: import("../../services/AiService").ConversationRequest) => {
          req.onProgress({ type: 'thinking', text: 'exploring' });
          req.onProgress({ type: 'tool_call', tool: 'read_file', toolArgs: '{"path":"x"}' });
          req.onProgress({ type: 'tool_result', step: step as import("../../models/Task").ResearchStep });
          req.onProgress({ type: 'plan_token', planToken: 'Question: ' });
          req.onProgress({ type: 'interrupted' });
          return { kind: 'message' as const, text: 'Question: which storage?', researchLog: [] };
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });

    await session.startPlanning('add persistence', ['claude-code']);

    const types = broadcast.mock.calls.map((c: unknown[]) => (c[0] as { type: string }).type);
    expect(types).toEqual(['planner_turn_started', 'planner_thinking_delta', 'research_step', 'research_step_done', 'plan_token', 'planner_message', 'planner_turn_ended']);
    const { turnId } = broadcast.mock.calls[0][0] as { turnId: string };
    expect(broadcast).toHaveBeenCalledWith({ type: 'planner_thinking_delta', text: 'exploring', turnId });
    expect(broadcast).toHaveBeenCalledWith({ type: 'research_step', tool: 'read_file', args: '{"path":"x"}', turnId });
    expect(broadcast).toHaveBeenCalledWith({ type: 'research_step_done', step, turnId });
    expect(broadcast).toHaveBeenCalledWith({ type: 'plan_token', token: 'Question: ', turnId });
  });

  describe('turn-scoped planner progress (#47)', () => {
    // Through the one-shot planner, which hands progress to the session as it
    // comes: the turn ids below stand in for the ones a turn's owner stamps.
    async function broadcastsFor(progress: import('../../models/Task').ResearchProgress[]): Promise<unknown[]> {
      const broadcast = vi.fn();
      const session = makeSession({
        broadcast,
        planner: {
          generate: vi.fn(async (req: { onProgress?: (p: import('../../models/Task').ResearchProgress) => void }) => {
            for (const p of progress) req.onProgress?.(p);
            return { tasks: [], generatedAt: '', status: 'draft' as const, runners: ['claude-code' as const], lastUpdated: '' };
          }),
        },
      });
      await session.generatePlan('add persistence', ['claude-code']);
      return broadcast.mock.calls.map((c: unknown[]) => c[0]).filter((m) => !['plan_generated', 'status_update'].includes((m as { type: string }).type));
    }

    it('streams reply prose of a turn as text deltas, and retracts it', async () => {
      const sent = await broadcastsFor([
        { type: 'text_delta', turnId: 't1', segmentId: 's1', text: 'Which ' },
        { type: 'text_delta', turnId: 't1', segmentId: 's1', text: 'store?' },
        { type: 'text_retracted', turnId: 't1', segmentId: 's1' },
        { type: 'text_retracted', turnId: 't1' },
      ]);

      expect(sent).toEqual([
        { type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'Which ' },
        { type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'store?' },
        { type: 'planner_text_retracted', turnId: 't1', segmentId: 's1' },
        { type: 'planner_text_retracted', turnId: 't1' },
      ]);
    });

    // `plan_token` is the building-plan display only; prose with no turn to
    // attach to has no surface that draws it.
    it('drops prose streamed outside a turn', async () => {
      const sent = await broadcastsFor([{ type: 'text_delta', segmentId: 's1', text: 'Which store?' }]);

      expect(sent).toEqual([]);
    });

    it('keeps the turn and the subagent on thinking, steps and plan tokens', async () => {
      const step = { id: 's1', tool: 'grep' as const, args: '{}', result: '', success: true, outcome: 'success' as const, subagentId: 'sa1', timestamp: '' };
      const sent = await broadcastsFor([
        { type: 'thinking', turnId: 't1', subagentId: 'sa1', text: 'look in src' },
        { type: 'thinking', turnId: 't1', segmentId: 'th1', text: 'streamed' },
        { type: 'tool_call', turnId: 't1', subagentId: 'sa1', tool: 'grep', toolArgs: '{}', toolCallId: 'c1' },
        { type: 'tool_result', turnId: 't1', subagentId: 'sa1', step, toolCallId: 'c1' },
        { type: 'plan_token', turnId: 't1', planToken: '{"tasks"' },
      ]);

      expect(sent).toEqual([
        { type: 'planner_thinking_delta', turnId: 't1', subagentId: 'sa1', text: 'look in src' },
        { type: 'planner_thinking_delta', turnId: 't1', segmentId: 'th1', text: 'streamed' },
        { type: 'research_step', turnId: 't1', subagentId: 'sa1', tool: 'grep', args: '{}', toolCallId: 'c1' },
        { type: 'research_step_done', turnId: 't1', subagentId: 'sa1', step },
        { type: 'plan_token', turnId: 't1', token: '{"tasks"' },
      ]);
    });

    it('announces a subagent starting and finishing', async () => {
      const sent = await broadcastsFor([
        { type: 'subagent_started', turnId: 't1', subagentId: 'sa1', brief: 'find the cache', model: 'flash' },
        { type: 'subagent_finished', turnId: 't1', subagentId: 'sa1', outcome: 'done', digest: 'src/cache.ts', usage: { inputTokens: 900 } },
      ]);

      expect(sent).toEqual([
        { type: 'subagent_started', turnId: 't1', subagentId: 'sa1', brief: 'find the cache', model: 'flash' },
        { type: 'subagent_finished', turnId: 't1', subagentId: 'sa1', outcome: 'done', digest: 'src/cache.ts', usage: { inputTokens: 900 } },
      ]);
    });

    it('broadcasts running usage, subagents counted in the total and shown apart', async () => {
      const sent = await broadcastsFor([
        { type: 'usage', turnId: 't1', record: { source: 'claude-code', inputTokens: 1000, outputTokens: 100, contextWindow: 200000, reportedCost: { amount: 0.01, currency: 'USD' } } },
        { type: 'usage', turnId: 't1', record: { source: 'claude-code', inputTokens: 400, outputTokens: 40, subagentId: 'sa1' } },
      ]);

      expect(sent).toEqual([
        {
          type: 'planner_usage', turnId: 't1',
          totals: { inputTokens: 1000, outputTokens: 100, reportedCost: { USD: 0.01 } },
          contextFill: { usedTokens: 1000, windowTokens: 200000 },
        },
        {
          type: 'planner_usage', turnId: 't1',
          totals: { inputTokens: 1400, outputTokens: 140, reportedCost: { USD: 0.01 } },
          bySubagent: { sa1: { inputTokens: 400, outputTokens: 40 } },
          contextFill: { usedTokens: 1000, windowTokens: 200000 },
        },
      ]);
    });

    it('leaves context fill out while the window is unknown', async () => {
      const sent = await broadcastsFor([{ type: 'usage', record: { source: 'openai', inputTokens: 1000 } }]);

      expect(sent).toEqual([{ type: 'planner_usage', totals: { inputTokens: 1000 } }]);
    });

    it('treats a reported window of zero as unknown, not as no room', async () => {
      const sent = await broadcastsFor([
        { type: 'usage', record: { source: 'codex', inputTokens: 1000, contextWindow: 0 } },
      ]);

      expect(sent).toEqual([{ type: 'planner_usage', totals: { inputTokens: 1000 } }]);
    });

    it('keeps costs reported in different currencies apart', async () => {
      const sent = await broadcastsFor([
        { type: 'usage', record: { source: 'openai', reportedCost: { amount: 0.25, currency: 'USD' } } },
        { type: 'usage', record: { source: 'openai', reportedCost: { amount: 0.10, currency: 'EUR' } } },
      ]);

      expect((sent.at(-1) as { totals: unknown }).totals).toEqual({
        reportedCost: { USD: 0.25, EUR: 0.10 },
      });
    });

    it('leaves a measure absent until a record reports it', async () => {
      const sent = await broadcastsFor([
        { type: 'usage', record: { source: 'openai', inputTokens: 10 } },
        { type: 'usage', record: { source: 'openai', outputTokens: 4 } },
      ]);

      expect((sent.at(-1) as { totals: unknown }).totals).toEqual({ inputTokens: 10, outputTokens: 4 });
    });

    it('persists the running totals onto the plan state', async () => {
      const broadcast = vi.fn();
      const session = makeSession({
        broadcast,
        aiService: {
          startConversation: vi.fn(async (req: import('../../services/AiService').ConversationRequest) => {
            req.onProgress({ type: 'usage', record: { source: 'openai', inputTokens: 10, outputTokens: 2, reportedCost: { amount: 0.5, currency: 'USD' } } });
            return { kind: 'message' as const, text: 'done', researchLog: [] };
          }),
          hasActiveConversation: () => true,
          reset: vi.fn(),
        },
      });

      await session.startPlanning('goal', ['claude-code']);

      const persisted = saves(session).mock.calls.at(-1)?.[0];
      expect(persisted?.plannerUsage).toEqual({
        totals: { inputTokens: 10, outputTokens: 2, reportedCost: { USD: 0.5 } },
        lastPromptTokens: 10,
      });
    });

    it('restores saved totals and re-broadcasts them when a session loads', async () => {
      const broadcast = vi.fn();
      const session = makeSession({ broadcast });
      const saved = smallPlan();
      saved.plannerUsage = {
        totals: { inputTokens: 1500, outputTokens: 200 },
        bySubagent: { 'sa-1': { inputTokens: 900 } },
        lastPromptTokens: 600,
        contextWindow: 200000,
      };

      session.loadPlan(saved, 'build it', '/repo', { persist: false });

      expect(broadcast).toHaveBeenCalledWith({
        type: 'planner_usage',
        totals: { inputTokens: 1500, outputTokens: 200 },
        bySubagent: { 'sa-1': { inputTokens: 900 } },
        contextFill: { usedTokens: 600, windowTokens: 200000 },
      });
    });

    it('does not re-broadcast usage for a plan that never recorded any', () => {
      const broadcast = vi.fn();
      const session = makeSession({ broadcast });

      session.loadPlan(smallPlan(), 'build it', '/repo', { persist: false });

      expect(broadcast.mock.calls.map((c) => (c[0] as { type: string }).type)).not.toContain('planner_usage');
    });

    it('threads the planner model window from the resolver into the opening', async () => {
      const startConversation = vi.fn().mockResolvedValue({ kind: 'message' as const, text: 'hi', researchLog: [] });
      const session = makeSession({
        modelResolver: { modelsForRunners: vi.fn().mockResolvedValue({}), contextWindowFor: () => 200000 },
        aiService: { startConversation, hasActiveConversation: () => true, reset: vi.fn() },
      });

      await session.startPlanning('goal', ['claude-code']);

      expect(startConversation.mock.calls[0][0]).toMatchObject({ contextWindow: 200000 });
    });
  });

  describe('subagent persistence (#50)', () => {
    it('persists a harness planner\'s subagent events the same way', async () => {
      const cli = new CliAgentAiService(
        fakeConfig({ aiProvider: 'claude-code' }),
        {
          mcpServer: fakeMcpServer(),
          createAdapter: scriptedAdapter([[
            { type: 'subagent_started', subagentId: 'sa1', brief: 'find the cache', model: 'haiku' },
            { type: 'tool_call', id: 'c1', name: 'Grep', args: { pattern: 'cache' }, subagentId: 'sa1' },
            { type: 'tool_result', id: 'c1', name: 'Grep', output: 'src/cache.ts', success: true, subagentId: 'sa1' },
            { type: 'subagent_finished', subagentId: 'sa1', outcome: 'done', digest: 'src/cache.ts' },
            { type: 'assistant_text', text: 'Found it.' },
            { type: 'turn_end' },
          ]]),
          workspaceRoot: () => '/repo',
        },
      );
      const session = makeSession({
        aiService: {
          startConversation: (req: import('../../services/AiService').ConversationRequest) => cli.startConversation(req),
          hasActiveConversation: () => cli.hasActiveConversation(),
          reset: () => cli.reset(),
        },
      });

      await session.startPlanning('find the cache', ['claude-code']);

      const saved = saves(session).mock.calls.at(-1)![0] as LegacyPlanState;
      const log = saved.researchLog ?? [];
      const entry = log.find((e): e is import('../../models/Task').SubagentLogEntry => 'type' in e && e.type === 'subagent');
      expect(entry).toMatchObject({ subagentId: 'sa1', brief: 'find the cache', model: 'haiku', outcome: 'done', digest: 'src/cache.ts' });
      const step = log.find((e): e is import('../../models/Task').ResearchStep => !('type' in e) && e.toolCallId === 'c1');
      expect(step).toMatchObject({ subagentId: 'sa1', tool: 'grep' });
      // The child step is re-grouped directly under its entry, not left where
      // the harness's own turn log happened to record it.
      expect(log[log.indexOf(entry!) + 1]).toBe(step);
    });

    it('a harness planner\'s prose streams as chat text end to end, never the "building" plan display (#48)', async () => {
      // Full chain: CliAgentAiService -> Session -> the same reduceConversation
      // every surface draws through. Guards the regression where harness reply
      // text bypassed TurnStream's classifier and rendered as "Building plan…"
      // for every reply, plan or prose alike, until the turn settled.
      const cli = new CliAgentAiService(
        fakeConfig({ aiProvider: 'claude-code' }),
        {
          mcpServer: fakeMcpServer(),
          createAdapter: scriptedAdapter([[
            { type: 'assistant_text_delta', text: 'Looking. ' },
            { type: 'tool_call', id: 'c1', name: 'Grep', args: { pattern: 'cache' } },
            { type: 'tool_result', id: 'c1', name: 'Grep', output: 'src/cache.ts', success: true },
            { type: 'assistant_text_delta', text: 'It is in src/cache.ts.' },
            { type: 'assistant_text', text: 'It is in src/cache.ts.' },
            { type: 'usage', record: { source: 'claude-code', inputTokens: 100, outputTokens: 10 } },
            { type: 'turn_end' },
          ]]),
          workspaceRoot: () => '/repo',
        },
      );
      const broadcasts: import('../SessionMessage').SessionMessage[] = [];
      const session = makeSession({
        broadcast: (msg) => broadcasts.push(msg),
        aiService: {
          startConversation: (req: import('../../services/AiService').ConversationRequest) => cli.startConversation(req),
          hasActiveConversation: () => cli.hasActiveConversation(),
          reset: () => cli.reset(),
        },
      });

      await session.startPlanning('find the cache', ['claude-code']);

      const view = broadcasts.reduce(reduceConversation, EMPTY_CONVERSATION);
      const message = view.blocks.find((b) => b.type === 'message' && b.role === 'planner');
      expect(message).toMatchObject({ text: 'Looking. It is in src/cache.ts.', streaming: false });
      expect(view.blocks.some((b) => b.type === 'plan' && b.status === 'building')).toBe(false);
      expect(view.blocks.some((b) => b.type === 'tool')).toBe(true);
      expect(view.blocks.some((b) => b.type === 'usage')).toBe(true);
    });

    it('a harness planner\'s thinking arrives as the one thinking message, though it has no segment', async () => {
      const cli = new CliAgentAiService(
        fakeConfig({ aiProvider: 'claude-code' }),
        {
          mcpServer: fakeMcpServer(),
          createAdapter: scriptedAdapter([[
            { type: 'thinking_delta', text: 'Grep for ' },
            { type: 'thinking_delta', text: 'the cache.' },
            { type: 'thinking', text: 'Grep for the cache.' },
            { type: 'thinking', text: 'Scan src.', subagentId: 'sa1' },
            { type: 'assistant_text', text: 'Found it.' },
            { type: 'turn_end' },
          ]]),
          workspaceRoot: () => '/repo',
        },
      );
      const broadcasts: import('../SessionMessage').SessionMessage[] = [];
      const session = makeSession({
        broadcast: (msg) => broadcasts.push(msg),
        aiService: {
          startConversation: (req: import('../../services/AiService').ConversationRequest) => cli.startConversation(req),
          hasActiveConversation: () => cli.hasActiveConversation(),
          reset: () => cli.reset(),
        },
      });

      await session.startPlanning('find the cache', ['claude-code']);

      const turnId = (broadcasts[0] as { turnId: string }).turnId;
      const thinking = broadcasts.filter((m) => m.type.includes('thinking'));
      expect(thinking).toEqual([
        { type: 'planner_thinking_delta', turnId, text: 'Grep for ' },
        { type: 'planner_thinking_delta', turnId, text: 'the cache.' },
        { type: 'planner_thinking_delta', turnId, subagentId: 'sa1', text: 'Scan src.' },
      ]);
    });

    it('saves each subagent with its tagged child steps, grouped despite interleaving', async () => {
      const step = (id: string, subagentId: string): import('../../models/Task').ResearchStep => ({
        id, tool: 'grep', args: '{}', result: '', success: true, outcome: 'success', subagentId, timestamp: '',
      });
      const session = makeSession({
        aiService: {
          startConversation: vi.fn(async (req: import('../../services/AiService').ConversationRequest) => {
            req.onProgress({ type: 'subagent_started', turnId: 't1', subagentId: 'sa-a', brief: 'explore a', model: 'flash' });
            req.onProgress({ type: 'subagent_started', turnId: 't1', subagentId: 'sa-b', brief: 'explore b', model: 'flash' });
            req.onProgress({ type: 'tool_result', turnId: 't1', subagentId: 'sa-a', step: step('a1', 'sa-a'), toolCallId: 'a1' });
            req.onProgress({ type: 'tool_result', turnId: 't1', subagentId: 'sa-b', step: step('b1', 'sa-b'), toolCallId: 'b1' });
            req.onProgress({ type: 'tool_result', turnId: 't1', subagentId: 'sa-a', step: step('a2', 'sa-a'), toolCallId: 'a2' });
            req.onProgress({ type: 'subagent_finished', turnId: 't1', subagentId: 'sa-a', outcome: 'done', digest: 'found a', usage: { inputTokens: 10 } });
            req.onProgress({ type: 'subagent_finished', turnId: 't1', subagentId: 'sa-b', outcome: 'failed', digest: 'no b' });
            return { kind: 'message' as const, text: 'done', researchLog: [] };
          }),
          hasActiveConversation: () => true,
          reset: vi.fn(),
        },
      });

      await session.startPlanning('add persistence', ['claude-code']);

      const saved = saves(session).mock.calls.at(-1)![0] as LegacyPlanState;
      const log = saved.researchLog ?? [];
      const subagents = log.filter((e): e is import('../../models/Task').SubagentLogEntry => 'type' in e && e.type === 'subagent');
      const steps = log.filter((e): e is import('../../models/Task').ResearchStep => !('type' in e));

      expect(subagents.map((e) => [e.subagentId, e.brief, e.model, e.outcome, e.digest, e.usage])).toEqual([
        ['sa-a', 'explore a', 'flash', 'done', 'found a', { inputTokens: 10 }],
        ['sa-b', 'explore b', 'flash', 'failed', 'no b', undefined],
      ]);
      expect(steps.map((e) => [e.id, e.subagentId])).toEqual([
        ['a1', 'sa-a'], ['a2', 'sa-a'], ['b1', 'sa-b'],
      ]);
      // Each subagent's steps sit immediately under its own entry, even though
      // the live stream interleaved the two subagents' events.
      const aIdx = log.findIndex((e) => 'type' in e && e.type === 'subagent' && e.subagentId === 'sa-a');
      expect(log.slice(aIdx + 1, aIdx + 3).map((e) => e.id)).toEqual(['a1', 'a2']);
    });
  });

  // The orchestrator has ONE notification channel (the observer); the Session
  // turns store mutations into status_update broadcasts. There is no separate
  // onRefresh callback for a surface to wire.
  it('routes store mutations through the observer to a status_update broadcast', async () => {
    const broadcast = vi.fn();
    const session = makeSession({ broadcast });
    session.loadPlan(smallPlan(), 'Test', '/repo');

    await session.addTask({ title: 'Extra', prompt: 'a' });

    const types = broadcast.mock.calls.map((c: unknown[]) => (c[0] as { type: string }).type);
    expect(types).toContain('status_update');
  });

  // The mutation seam aborts before sync/persist/broadcast when the store op
  // reports failure — a failed update must leave no trace.
  it('aborts the mutation seam when the store op fails: nothing persisted or broadcast', async () => {
    const broadcast = vi.fn();
    const session = makeSession({ broadcast });
    session.loadPlan(smallPlan(), 'Test', '/repo');
    const spy = saves(session);
    spy.mockClear();
    broadcast.mockClear();

    const result = await session.updateTask('no-such-task', { title: 'x' });

    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(broadcast.mock.calls.map((c: unknown[]) => (c[0] as { type: string }).type)).not.toContain('task_updated');
  });

  // The store mirrors the artifact at plan commit (not only at execution):
  // otherwise pre-execution edits hit an empty store — updateTask misses every
  // committed task and addTask's sync-back wipes the plan to a single task.
  it('keeps the store in lockstep at plan commit so task edits before execution work', async () => {
    const committed = [
      createTask({ id: 'c1', order: 1, title: 'Committed 1', prompt: 'x' }),
      createTask({ id: 'c2', order: 2, title: 'Committed 2', prompt: 'y' }),
    ];
    const session = makeSession({
      aiService: {
        startConversation: vi.fn(async () => ({ kind: 'plan' as const, tasks: committed, text: '', researchLog: [] })),
        hasActiveConversation: () => false,
        reset: vi.fn(),
      },
    });
    await session.startPlanning('clear goal', ['claude-code']);

    const updated = await session.updateTask('c1', { title: 'Renamed' });
    expect(updated?.tasks.find((t) => t.id === 'c1')?.title).toBe('Renamed');

    const after = await session.addTask({ title: 'Extra', prompt: 'z' });
    expect(after?.tasks.map((t) => t.id)).toContain('c1');
    expect(after?.tasks).toHaveLength(3);
  });
});

// Nothing from one session may bleed into another: not the PlanStore tasks
// (planContextBlock would present them to the model as the CURRENT plan),
// not the live LLM conversation (the next message would continue the old
// session's thread and re-emit its plan), not the execution log or queue.
describe('cross-session isolation', () => {
  function planWith(id: string, title: string): LegacyPlanState {
    return {
      tasks: [createTask({ id, order: 1, title, prompt: 'do it' })],
      generatedAt: new Date().toISOString(),
      status: 'draft',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };
  }

  it('startPlanning never leaks a previous plan\'s tasks into the conversation context', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: {
        startConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'What storage?', researchLog: [] }),
        continueConversation,
        hasActiveConversation: () => true,
      },
    });

    // Session A's plan is adopted, then the user starts a brand-new session goal.
    session.loadPlan(planWith('old-1', 'Old secret task'), 'Old goal', '/repo');
    await session.startPlanning('new unrelated goal', ['claude-code']);
    expect(session.planTasks).toHaveLength(0);

    // The follow-up turn's outgoing message must not carry session A's tasks.
    await session.continueConversation('sounds good, proceed');
    const outgoing = continueConversation.mock.calls[0][0] as string;
    expect(outgoing).not.toContain('Old secret task');
    expect(outgoing).not.toContain('<current_plan>');
  });

  it('startPlanning drops a live conversation left over from the previous session', async () => {
    let active = true;
    const reset = vi.fn(() => { active = false; });
    const session = makeSession({
      aiService: {
        startConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'hi', researchLog: [] }),
        hasActiveConversation: () => active,
        reset,
      },
    });

    await session.startPlanning('fresh goal', ['claude-code']);

    expect(reset).toHaveBeenCalled();
  });

  it('loadPlan of a different plan drops the live conversation; re-adopting the same plan keeps it', () => {
    const reset = vi.fn();
    const session = makeSession({
      aiService: { hasActiveConversation: () => true, reset },
    });
    const planA = planWith('a1', 'Plan A task');
    const planB = planWith('b1', 'Plan B task');

    session.loadPlan(planA, 'Goal A', '/repo');
    expect(reset).toHaveBeenCalledTimes(1);

    // Approval-style re-adoption of the SAME plan object must keep the thread.
    session.loadPlan(planA, 'Goal A', '/repo');
    expect(reset).toHaveBeenCalledTimes(1);

    // Switching to another session's plan must drop it.
    session.loadPlan(planB, 'Goal B', '/repo');
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it('loadPlan of a different plan clears the previous session\'s queued messages', () => {
    const session = makeSession();
    session.loadPlan(planWith('a1', 'Plan A task'), 'Goal A', '/repo');
    queue(session, 'meant for session A');
    expect(session.getQueuedMessages().length).toBe(1);

    session.loadPlan(planWith('b1', 'Plan B task'), 'Goal B', '/repo');

    expect(session.getQueuedMessages().length).toBe(0);
  });

  it('reset() returns the Session to a blank slate with a fresh identity', () => {
    const reset = vi.fn();
    const session = makeSession({
      aiService: { hasActiveConversation: () => true, reset },
    });
    session.loadPlan(planWith('a1', 'Plan A task'), 'Goal A', '/repo');
    queue(session, 'pending change');
    const oldId = session.sessionId;

    session.reset();

    expect(session.planState).toBeNull();
    expect(session.currentGoal).toBe('');
    expect(session.planTasks).toHaveLength(0);
    expect(session.getQueuedMessages().length).toBe(0);
    expect(session.executionLog).toHaveLength(0);
    expect(reset).toHaveBeenCalled();
    expect(session.sessionId).not.toBe(oldId);
  });

  it('destroy() aborts a live planning conversation, not just running tasks', () => {
    const reset = vi.fn();
    const session = makeSession({
      aiService: { hasActiveConversation: () => true, reset },
    });

    session.destroy();

    expect(reset).toHaveBeenCalled();
  });

  it('destroy() releases the AI service even with no conversation held', () => {
    // "No conversation" is not "nothing to release": a harness planner holds an
    // agent process that outlives the conversation a committed plan closed, so
    // gating this on hasActiveConversation() leaked that process per session.
    const reset = vi.fn();
    const session = makeSession({
      aiService: { hasActiveConversation: () => false, reset },
    });

    session.destroy();

    expect(reset).toHaveBeenCalled();
  });
});

describe('continueConversation — planner config drift mid-conversation', () => {
  // A harness planner's model is a spawn-time argument to the agent process,
  // not a per-turn field (ADR-0009): a picker change while the conversation is
  // live cannot reach the process already running. `conversationMatchesConfig`
  // is how the AI service tells Session that, so it reroutes through
  // `resumeConversation` (tear down, restart, fold the transcript so far into
  // the opening message) instead of sending the next turn to the stale one.
  it('reroutes to a fresh startConversation, not continueConversation, once the live conversation goes stale', async () => {
    const startConversation = vi.fn()
      .mockResolvedValueOnce({ kind: 'message', text: 'hello', researchLog: [] })
      .mockResolvedValueOnce({ kind: 'message', text: 'restarted under the new model', researchLog: [] });
    const continueConversation = vi.fn();
    let matchesConfig = true;
    const session = makeSession({
      aiService: {
        startConversation,
        continueConversation,
        hasActiveConversation: () => true,
        conversationMatchesConfig: () => matchesConfig,
        reset: vi.fn(),
      },
    });

    await session.startPlanning('test goal', ['claude-code']);

    // Simulate the user picking a different model for the harness planner
    // while this conversation is still open.
    matchesConfig = false;

    const plan = await session.continueConversation('keep going');

    expect(continueConversation).not.toHaveBeenCalled();
    expect(startConversation).toHaveBeenCalledTimes(2);
    const restart = startConversation.mock.calls[1][0];
    expect(restart.initialMessage).toContain('keep going');
    // The transcript accumulated so far (goal + first reply) rides along so
    // the restarted conversation isn't starting from nothing.
    expect(restart.priorHistory.length).toBeGreaterThan(0);
    expect(plan.conversationHistory?.at(-1)?.content).toContain('restarted under the new model');
  });

  it('keeps continuing in place when the AI service reports no drift', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: {
        startConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'hi', researchLog: [] }),
        continueConversation,
        hasActiveConversation: () => true,
        conversationMatchesConfig: () => true,
        reset: vi.fn(),
      },
    });

    await session.startPlanning('test goal', ['claude-code']);
    await session.continueConversation('next');

    expect(continueConversation).toHaveBeenCalled();
  });

  it('treats a missing conversationMatchesConfig as always current — vendor backends never implement it', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: {
        startConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'hi', researchLog: [] }),
        continueConversation,
        hasActiveConversation: () => true,
        // No conversationMatchesConfig — matches OpenAiService/GeminiService,
        // which don't implement the optional method.
        reset: vi.fn(),
      },
    });

    await session.startPlanning('test goal', ['claude-code']);
    await session.continueConversation('next');

    expect(continueConversation).toHaveBeenCalled();
  });
});

describe('idleSince on the status_update broadcast', () => {
  function onePlan(): LegacyPlanState {
    return {
      tasks: [createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('round-trips idleSince from the verifier through SerializedTaskStatus on status_update, and clears it on resume', async () => {
    const fakeSession = new FakeStructuredSession('s1', 't1');
    const runner = {
      spawn: vi.fn().mockResolvedValue(fakeSession),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } as unknown as ITerminalRunner;

    const broadcast = vi.fn();
    const session = makeSession({ broadcast, runner });
    session.loadPlan(onePlan(), 'Test', '/repo');

    vi.useFakeTimers();
    await session.executePlan();
    fakeSession.emitOutput('working...');
    broadcast.mockClear();

    vi.advanceTimersByTime(60_000);

    const idleUpdates = broadcast.mock.calls
      .map((c: unknown[]) => c[0] as { type: string; tasks?: Array<{ id: string; idleSince?: string | null }> })
      .filter((m) => m.type === 'status_update');
    expect(idleUpdates.length).toBeGreaterThan(0);
    const lastIdle = idleUpdates[idleUpdates.length - 1].tasks!.find((t) => t.id === 't1');
    expect(lastIdle?.idleSince).toEqual(expect.any(String));

    broadcast.mockClear();
    fakeSession.emitOutput('more output');

    const resumeUpdates = broadcast.mock.calls
      .map((c: unknown[]) => c[0] as { type: string; tasks?: Array<{ id: string; idleSince?: string | null }> })
      .filter((m) => m.type === 'status_update');
    expect(resumeUpdates.length).toBeGreaterThan(0);
    const lastResumed = resumeUpdates[resumeUpdates.length - 1].tasks!.find((t) => t.id === 't1');
    expect(lastResumed?.idleSince).toBeNull();
  });
});

describe('saving a run as its tasks settle', () => {
  function twoTaskRun() {
    const terminals: FakeStructuredSession[] = [];
    const runner = {
      spawn: vi.fn().mockImplementation((req: { taskId: string }) => {
        const t = new FakeStructuredSession(`s-${req.taskId}`, req.taskId);
        terminals.push(t);
        return Promise.resolve(t);
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } as unknown as ITerminalRunner;
    // Each save and each announcement, tagged with t1's status as it was then.
    const order: string[] = [];
    const saveSession = vi.fn((plan: LegacyPlanState) => {
      order.push(`save:${plan.tasks.find((t) => t.id === 't1')!.status}`);
    });
    const broadcast = (msg: SessionMessage) => {
      if (msg.type === 'status_update') order.push(`status:${msg.tasks.find((t) => t.id === 't1')!.status}`);
      if (msg.type === 'execution_complete') order.push('complete');
    };
    const session = makeSession({ runner, broadcast, saveSession });
    session.loadPlan({
      tasks: [
        createTask({ id: 't1', order: 1, title: 'First', prompt: 'a' }),
        createTask({ id: 't2', order: 2, title: 'Second', prompt: 'b' }),
      ],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    }, 'Test', '/repo', { persist: false });
    const terminal = (taskId: string) => terminals.find((t) => t.taskId === taskId)!;
    return { session, saveSession, order, terminal };
  }

  it('saves a task\'s verdict the moment it lands, before announcing it, while the run goes on', async () => {
    const { session, saveSession, order, terminal } = twoTaskRun();
    await session.executePlan();
    saveSession.mockClear();
    order.length = 0;

    terminal('t1').reportComplete({ status: 'done', summary: '' });
    terminal('t1').emitExit(0);

    await vi.waitFor(() => expect(order).toContain('save:completed'));
    expect(order.indexOf('save:completed')).toBeLessThan(order.indexOf('status:completed'));
    expect(order).not.toContain('complete');
    expect(session.isExecuting).toBe(true);
  });

  it('saves a failed verdict as well', async () => {
    const { session, saveSession, terminal } = twoTaskRun();
    await session.executePlan();
    saveSession.mockClear();

    terminal('t1').emitExit(1);

    await vi.waitFor(() => expect(saveSession.mock.calls.some(([p]) => p.tasks.find((t) => t.id === 't1')!.status === 'failed')).toBe(true));
  });

  it('does not save on a status change that settles nothing', async () => {
    const { session, saveSession, terminal } = twoTaskRun();
    await session.executePlan();
    saveSession.mockClear();

    terminal('t1').emitOutput('still working');

    expect(saveSession).not.toHaveBeenCalled();
  });
});
