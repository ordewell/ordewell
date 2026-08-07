import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState } from '../../models/Task';
import * as sessionStore from '../../utils/sessionStore';
import { makeSession, FakeTerminalSession } from './sessionTestKit';
import type { ITerminalRunner } from '../../interfaces/ITerminalRunner';
import { parsePlanJson } from '../PlanValidator';
import type { Session } from '../createSession';

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
      settings: () => ({ tddEnabled: false, grillMeEnabled: false, modelAllowlist: { 'claude-code': ['kimi-2.6'] } }),
      planner,
    });

    await session.generatePlan('test goal', ['claude-code']);

    expect(planner.generate).toHaveBeenCalledWith(
      expect.objectContaining({ perRunnerAllowlist: { 'claude-code': ['kimi-2.6'] } }),
    );
  });

  it('generatePlan carries every mode toggle the one-shot path honours', async () => {
    // The defect: this path destructured verification and researchSubagents and
    // forgot review, so `ordewell plan --no-chat` and the web plan endpoint
    // planned without a review task while every surface showed review as ON.
    const planner = { generate: vi.fn().mockResolvedValue(smallPlan()) };
    const session = makeSession({
      settings: () => ({
        tddEnabled: false,
        grillMeEnabled: true,
        prdEnabled: true,
        reviewEnabled: true,
        verificationEnabled: true,
        researchSubagentsEnabled: true,
      }),
      planner,
    });

    await session.generatePlan('test goal', ['claude-code']);

    expect(planner.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        modes: expect.objectContaining({ review: true, verification: true, researchSubagents: true }),
      }),
    );
  });

  it('startPlanning filters modelsByRunner through allowlist before calling aiService', async () => {
    const startConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'hello', researchLog: [] });
    const session = makeSession({
      settings: () => ({
        tddEnabled: false,
        grillMeEnabled: false,
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
      tddEnabled: false,
      grillMeEnabled: false,
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

  it('modifyPlan passes perRunnerAllowlist to planner.modify', async () => {
    const planner = { modify: vi.fn().mockResolvedValue({ tasks: [] }) };
    const session = makeSession({
      settings: () => ({ tddEnabled: false, grillMeEnabled: false, modelAllowlist: { 'claude-code': ['kimi-2.6'] } }),
      planner,
    });
    session.loadPlan(smallPlan(), 'Test', '/repo');

    await session.modifyPlan('add a task');

    expect(planner.modify).toHaveBeenCalledWith(
      expect.objectContaining({ perRunnerAllowlist: { 'claude-code': ['kimi-2.6'] } }),
    );
  });

  it('processQueuedMessages passes perRunnerAllowlist to planner.modifyDuringExecution', async () => {
    const planner = { modifyDuringExecution: vi.fn().mockResolvedValue({ pendingTasks: [], message: 'ok' }) };
    const session = makeSession({
      settings: () => ({ tddEnabled: false, grillMeEnabled: false, modelAllowlist: { 'claude-code': ['kimi-2.6'] } }),
      planner,
    });
    session.loadPlan(smallPlan(), 'Test', '/repo');

    session.queueMessage('change task 1');
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

    session.queueMessage('user says hi');
    session.queueMessage('user asks something');

    expect(session.queuedCount).toBe(2);

    await session.processQueuedMessages();

    expect(session.queuedCount).toBe(0);
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
    await session.startExecution();
    session.queueMessage('change task 1');

    await session.processQueuedMessages();

    expect(planner.modifyDuringExecution).toHaveBeenCalledTimes(1);
    const req = planner.modifyDuringExecution.mock.calls[0][0];
    expect(req.pendingTasks).toHaveLength(1);
    expect(req.userMessage).toBe('change task 1');
  });

  it('reconciles plan when planner returns modified tasks', async () => {
    const modifiedTask = createTask({ id: 't1', order: 1, title: 'Modified Task', prompt: 'updated' });
    const planner = {
      modifyDuringExecution: vi.fn().mockResolvedValue({ pendingTasks: [modifiedTask], message: 'Plan updated' }),
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
    await session.startExecution();
    session.queueMessage('modify');

    await session.processQueuedMessages();

    const stored = session.getTask('t1');
    expect(stored).toBeDefined();
    expect(stored!.title).toBe('Modified Task');
    expect(session.queuedCount).toBe(0);
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

  it('reschedules dependents after draining the queue — fan-out resumes', async () => {
    const sessions: FakeTerminalSession[] = [];
    const runner = {
      spawn: vi.fn().mockImplementation(() => {
        const s = new FakeTerminalSession(`s${sessions.length + 1}`, `t${sessions.length + 1}`);
        sessions.push(s);
        return Promise.resolve(s);
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } as unknown as ITerminalRunner;

    const events: { type: string }[] = [];
    const broadcast = (msg: { type: string }): void => { events.push({ type: msg.type }); };

    const t1 = createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first', completionMarker: 'mk-1' });
    const t2 = createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second', dependencies: ['t1'], completionMarker: 'mk-2' });
    const planner = {
      modifyDuringExecution: vi.fn().mockResolvedValue({
        // The full plan with t1 already completed so the store rebuild keeps
        // t2's dependency satisfied and getReadyTasks re-schedules t2.
        pendingTasks: [{ ...t1, status: 'completed' }, { ...t2, status: 'approved' }],
        message: 'ok',
      }),
    };

    const session = makeSession({ runner, planner, broadcast });

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

    // Queue a structural edit, then complete t1. With the queue non-empty, the
    // orchestrator must pause fan-out (emit queue_ready) instead of spawning
    // t2 — but only until the queue is drained.
    session.queueMessage('an edit');
    sessions[0].emitOutput('Done.\n<<<ORDEWELL_DONE_mk-1>>>');
    sessions[0].emitExit(0);
    await new Promise((r) => setTimeout(r, 30));

    expect(events.map((e) => e.type)).toContain('queue_ready');
    expect(runner.spawn).toHaveBeenCalledTimes(1); // t2 not spawned yet

    await session.processQueuedMessages();
    await new Promise((r) => setTimeout(r, 30));

    expect(session.queuedCount).toBe(0);
    expect(runner.spawn).toHaveBeenCalledTimes(2);
    expect((runner.spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[1][0].taskId).toBe('t2');
  });
});

describe('Session phase transitions', () => {
  it('Execute Plan spawns an AI task when planner JSON omits prompt', async () => {
    const terminal = new FakeTerminalSession('terminal-1', 't1');
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
    const terminal = new FakeTerminalSession('terminal-2', 't2');
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

    expect(session.getTask('t1')?.status).toBe('completed');
    expect(runner.spawn).toHaveBeenCalledOnce();
    expect(runner.spawn).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't2' }));
  });

  it('Run Task keeps the session busy until the marker and blocks Execute Plan meanwhile', async () => {
    const terminal = new FakeTerminalSession('terminal-1', 't1');
    const runner = {
      spawn: vi.fn().mockResolvedValue(terminal),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies ITerminalRunner;
    const session = makeSession({ runner });
    const plan: LegacyPlanState = {
      tasks: [
        createTask({ id: 't1', order: 1, title: 'Run only me', prompt: 'one', completionMarker: 'mk-1' }),
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
    expect(session.getTask('t1')?.status).toBe('in_progress');
    expect(session.getTask('t2')?.status).toBe('pending');
    await expect(session.executePlan()).rejects.toThrow('Session already executing');

    terminal.emitOutput('<<<ORDEWELL_DONE_mk-1>>>');
    await new Promise(r => setTimeout(r, 10));

    expect(session.isExecuting).toBe(false);
    expect(session.getTask('t1')?.status).toBe('completed');
    expect(session.getTask('t2')?.status).toBe('pending');
    expect(runner.spawn).toHaveBeenCalledOnce();
  });

  describe('every spawn path composes the same augmented prompt', () => {
    function threeTaskPlan(): LegacyPlanState {
      return {
        tasks: [
          createTask({ id: 't1', order: 1, title: 'First', prompt: 'one', completionMarker: 'mk-1' }),
          createTask({ id: 't2', order: 2, title: 'Second', prompt: 'two', completionMarker: 'mk-2' }),
          createTask({ id: 't3', order: 3, title: 'Third', prompt: 'three', completionMarker: 'mk-3' }),
        ],
        generatedAt: new Date().toISOString(),
        status: 'draft',
        runners: ['claude-code'],
        lastUpdated: new Date().toISOString(),
      };
    }

    function spyRunner(): ITerminalRunner & { spawn: ReturnType<typeof vi.fn> } {
      return {
        spawn: vi.fn().mockImplementation((opts: { taskId: string }) => Promise.resolve(new FakeTerminalSession(`term-${opts.taskId}`, opts.taskId))),
        stop: vi.fn(),
        stopAll: vi.fn(),
        activeCount: 0,
      } as unknown as ITerminalRunner & { spawn: ReturnType<typeof vi.fn> };
    }

    it.each([
      ['executePlan', (s: Session) => s.executePlan()],
      ['runTask', (s: Session) => s.runTask('t1')],
      ['forceStartTask', (s: Session) => s.forceStartTask('t1')],
    ])('%s carries the plan map and the completion marker', async (_name, start) => {
      const runner = spyRunner();
      const session = makeSession({ runner, settings: () => ({ tddEnabled: true, grillMeEnabled: false }) });
      session.loadPlan(threeTaskPlan(), 'Test', '/repo');

      await start(session);

      const prompt = runner.spawn.mock.calls.find((c) => c[0].taskId === 't1')![0].prompt as string;
      expect(prompt).toContain('← you are here');
      expect(prompt).toContain('1. [NOW    ] First');
      expect(prompt).toContain('DONE_mk-1>>>');
      expect(prompt).toContain('Implementation workflow (TDD)');
    });

    it('reads the TDD toggle at spawn time, not at the last full-run start', async () => {
      const runner = spyRunner();
      let tddEnabled = false;
      const session = makeSession({ runner, settings: () => ({ tddEnabled, grillMeEnabled: false }) });
      session.loadPlan(threeTaskPlan(), 'Test', '/repo');

      tddEnabled = true;
      await session.runTask('t1');

      expect(runner.spawn.mock.calls[0][0].prompt).toContain('Implementation workflow (TDD)');
    });
  });

  it('isPlanning is true before execution starts', () => {
    const session = makeSession();
    expect(session.isPlanning).toBe(true);
    expect(session.isExecuting).toBe(false);
  });

  it('startExecution clears execution log before starting', async () => {
    const session = makeSession();
    const plan: LegacyPlanState = {
      tasks: [createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };

    session.loadPlan(plan, 'Test', '/repo');
    await session.startExecution();

    expect(session.executionLog).toHaveLength(0);
  });

  it('isPlanning flips to false when orchestration starts', async () => {
    const session = makeSession();

    const plan: LegacyPlanState = {
      tasks: [createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };

    session.loadPlan(plan, 'Test', '/repo');
    expect(session.isPlanning).toBe(true);
    expect(session.isExecuting).toBe(false);

    await session.startExecution();

    expect(session.isPlanning).toBe(true);
    expect(session.isExecuting).toBe(false);

    await session.approveReview();
    expect(session.isPlanning).toBe(false);
    expect(session.isExecuting).toBe(true);
  });
});

describe('currentPlanState — the live plan a surface refreshes from', () => {
  function twoParallel(): { session: Session; sessions: FakeTerminalSession[] } {
    const sessions: FakeTerminalSession[] = [];
    const runner = {
      spawn: vi.fn().mockImplementation((req: { taskId: string }) => {
        const s = new FakeTerminalSession(`s-${req.taskId}`, req.taskId);
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
          createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first', completionMarker: 'mk-1' }),
          createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second', completionMarker: 'mk-2' }),
          createTask({ id: 't3', order: 3, title: 'Third', prompt: 'do third', dependencies: ['t1'], completionMarker: 'mk-3' }),
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
    const spy = vi.mocked(sessionStore.saveSession);
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
    const spy = vi.mocked(sessionStore.saveSession);
    spy.mockClear();

    const id = session.sessionId;
    expect(id).toMatch(/^session-\d+$/);

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
    expect(types).toEqual(['plan_thinking', 'research_step', 'research_step_done', 'plan_token', 'planner_message']);
    expect(broadcast).toHaveBeenCalledWith({ type: 'plan_thinking', text: 'exploring' });
    expect(broadcast).toHaveBeenCalledWith({ type: 'research_step', tool: 'read_file', args: '{"path":"x"}' });
    expect(broadcast).toHaveBeenCalledWith({ type: 'research_step_done', step });
    expect(broadcast).toHaveBeenCalledWith({ type: 'plan_token', token: 'Question: ' });
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
    const spy = vi.mocked(sessionStore.saveSession);
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
    session.queueMessage('meant for session A');
    expect(session.queuedCount).toBe(1);

    session.loadPlan(planWith('b1', 'Plan B task'), 'Goal B', '/repo');

    expect(session.queuedCount).toBe(0);
  });

  it('reset() returns the Session to a blank slate with a fresh identity', () => {
    const reset = vi.fn();
    const session = makeSession({
      aiService: { hasActiveConversation: () => true, reset },
    });
    session.loadPlan(planWith('a1', 'Plan A task'), 'Goal A', '/repo');
    session.queueMessage('pending change');
    const oldId = session.sessionId;

    session.reset();

    expect(session.planState).toBeNull();
    expect(session.currentGoal).toBe('');
    expect(session.planTasks).toHaveLength(0);
    expect(session.queuedCount).toBe(0);
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
