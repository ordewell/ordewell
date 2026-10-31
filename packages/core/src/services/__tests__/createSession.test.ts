import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTask, rejoinPlanTree, type LegacyPlanState, type Task } from '../../models/Task';
import type { SkillInfo } from '../SkillsService';
import { makeSession, FakeRunnerSession, fakeConfig, fakeFs, taskOf, saves, memoryTaskLogs } from './sessionTestKit';
import { contextMeterText, plannerContextFill, taskUsageSummary, usageText } from '../../models/Usage';
import { scriptedAdapter, fakeMcpServer, fakeSpawn, fixture } from './harnessTestKit';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { IDLE_TIMEOUT_MS } from '../VerdictEngine';
import type { IRunner } from '../../interfaces/IRunner';
import { parsePlanJson } from '../PlanValidator';
import { PlannerTurnDiscardedError, PlannerTurnStoppedError } from '../PlannerConversation';
import type { Session } from '../createSession';
import type { SessionMessage } from '../SessionMessage';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { reduceConversation, EMPTY_CONVERSATION, replayTaskLog } from '../../conversation';

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

  it('loadPlan does NOT filter or resolve assignments (keeps stored modelId as-is)', () => {
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

describe('Session phase transitions', () => {
  it('Execute Plan spawns an AI task when planner JSON omits prompt', async () => {
    const runnerSession = new FakeRunnerSession('runnerSession-1', 't1');
    const runner = {
      spawn: vi.fn().mockResolvedValue(runnerSession),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies IRunner;
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
    await session.execute({ command: 'run_plan' }, { kind: 'user' });

    expect(runner.spawn).toHaveBeenCalledOnce();
    expect(runner.spawn).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't1' }));
  });

  it('Execute Plan resumes at the first incomplete task and preserves completed dependencies', async () => {
    const runnerSession = new FakeRunnerSession('runnerSession-2', 't2');
    const runner = {
      spawn: vi.fn().mockResolvedValue(runnerSession),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies IRunner;
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
    await session.execute({ command: 'run_plan' }, { kind: 'user' });

    expect(taskOf(session, 't1')?.status).toBe('completed');
    expect(runner.spawn).toHaveBeenCalledOnce();
    expect(runner.spawn).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't2' }));
  });

  it('Run Task keeps the session busy until the marker', async () => {
    const runnerSession = new FakeRunnerSession('runnerSession-1', 't1');
    const runner = {
      spawn: vi.fn().mockResolvedValue(runnerSession),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies IRunner;
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
    await session.execute({ command: 'run_task', task: 't1' }, { kind: 'user' });

    expect(session.isExecuting).toBe(true);
    expect(taskOf(session, 't1')?.status).toBe('in_progress');
    expect(taskOf(session, 't2')?.status).toBe('pending');

    runnerSession.reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(session.isExecuting).toBe(false));

    expect(taskOf(session, 't1')?.status).toBe('completed');
    expect(taskOf(session, 't2')?.status).toBe('pending');
    expect(runner.spawn).toHaveBeenCalledOnce();
  });

  it('Execute Plan during a Run Task makes it the plan\'s run: the rest start as their dependencies finish', async () => {
    const sessions = [new FakeRunnerSession('runnerSession-1', 't1'), new FakeRunnerSession('runnerSession-2', 't2')];
    const runner = {
      spawn: vi.fn().mockImplementation(() => Promise.resolve(sessions[runner.spawn.mock.calls.length - 1])),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies IRunner;
    const session = makeSession({ runner });
    session.loadPlan({
      tasks: [
        createTask({ id: 't1', order: 1, title: 'Run only me', prompt: 'one' }),
        createTask({ id: 't2', order: 2, title: 'After me', prompt: 'two', dependencies: ['t1'] }),
      ],
      generatedAt: new Date().toISOString(),
      status: 'draft',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    }, 'Test', '/repo');
    await session.execute({ command: 'run_task', task: 't1' }, { kind: 'user' });

    await session.execute({ command: 'run_plan' }, { kind: 'user' });

    expect(runner.spawn).toHaveBeenCalledOnce();
    sessions[0].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(runner.spawn).toHaveBeenCalledTimes(2));
    expect(taskOf(session, 't2')?.status).toBe('in_progress');
  });

  it("captures a finished task's reported answer", async () => {
    const runnerSession = new FakeRunnerSession('runnerSession-1', 't1');
    const runner = { spawn: vi.fn().mockResolvedValue(runnerSession), stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } satisfies IRunner;
    const taskOutput = new BufferedTaskOutputSource();
    const session = makeSession({ runner, taskOutput });
    session.loadPlan({
      tasks: [createTask({ id: 't1', order: 1, title: 'Only', prompt: 'one' })],
      generatedAt: new Date().toISOString(),
      status: 'draft',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    }, 'Test', '/repo');
    await session.execute({ command: 'run_task', task: 't1' }, { kind: 'user' });

    runnerSession.reportComplete({ status: 'done', summary: 'answer from the runner' });
    await vi.waitFor(() => expect(taskOf(session, 't1')?.handoff?.summary).toBe('answer from the runner'));
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

    function spyRunner(): IRunner & { spawn: ReturnType<typeof vi.fn> } {
      return {
        spawn: vi.fn().mockImplementation((opts: { taskId: string }) => Promise.resolve(new FakeRunnerSession(`term-${opts.taskId}`, opts.taskId))),
        stop: vi.fn(),
        stopAll: vi.fn(),
        activeCount: 0,
      } as unknown as IRunner & { spawn: ReturnType<typeof vi.fn> };
    }

    it.each([
      ['run_plan', (s: Session) => s.execute({ command: 'run_plan' }, { kind: 'user' })],
      ['run_task', (s: Session) => s.execute({ command: 'run_task', task: 't1' }, { kind: 'user' })],
      ['force_start', (s: Session) => s.execute({ command: 'force_start', task: 't1' }, { kind: 'user' })],
    ])('%s carries the plan map, and leaves the completion contract to the runner\'s instructions', async (_name, start) => {
      const runner = spyRunner();
      const session = makeSession({ runner });
      session.loadPlan(threeTaskPlan(), 'Test', '/repo');

      await start(session);

      const prompt = runner.spawn.mock.calls.find((c) => c[0].taskId === 't1')![0].prompt as string;
      expect(prompt).toContain('← you are here');
      expect(prompt).toContain('1. [NOW    ] First');
      expect(prompt).not.toContain('task_complete');
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

      await session.execute({ command: 'run_task', task: 't1' }, { kind: 'user' });

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

  it('execute clears execution log before starting', async () => {
    const session = makeSession();
    const plan: LegacyPlanState = {
      tasks: [
        createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' }),
        createTask({ id: 't2', order: 2, title: 'Task 2', prompt: 'do it too' }),
      ],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };

    session.loadPlan(plan, 'Test', '/repo');
    await session.execute({ command: 'mark_complete', task: 't1', confirmed: true }, { kind: 'user' });
    expect(session.executionLog).toHaveLength(1);

    await session.execute({ command: 'run_plan' }, { kind: 'user' });

    expect(session.executionLog).toHaveLength(0);
  });

  it('the run is armed and executing once the user\'s Execute starts it', async () => {
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

    await session.execute({ command: 'run_plan' }, { kind: 'user' });

    expect(session.status).toBe('running');
    expect(session.isExecuting).toBe(true);
  });
});

describe('currentPlanState — the live plan a surface refreshes from', () => {
  function twoParallel(): { session: Session; sessions: FakeRunnerSession[] } {
    const sessions: FakeRunnerSession[] = [];
    const runner = {
      spawn: vi.fn().mockImplementation((req: { taskId: string }) => {
        const s = new FakeRunnerSession(`s-${req.taskId}`, req.taskId);
        sessions.push(s);
        return Promise.resolve(s);
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } as unknown as IRunner;

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

  // Marking a running AI task complete by hand is refused while the run goes on, so the runner reports it done.
  async function finish(session: Session, sessions: FakeRunnerSession[], id: string): Promise<void> {
    sessions.find((s) => s.taskId === id)!.reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(taskOf(session, id)!.status).toBe('completed'));
  }

  // The defect this pins: marking one task done re-read the plan through the
  // saved-session boundary, which normalizes `in_progress` to `pending` because
  // a session off disk has no runners behind it. Every sibling still executing
  // came back as never started, and the plan pane dropped its spinner.
  it('keeps a parallel sibling in_progress after another task is marked complete', async () => {
    const { session, sessions } = twoParallel();
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    expect(statusOf(session, 't2')).toBe('in_progress');

    await finish(session, sessions, 't1');

    expect(statusOf(session, 't2')).toBe('in_progress');
  });

  it('reports a task the completion just fanned out to as in_progress', async () => {
    const { session, sessions } = twoParallel();
    await session.execute({ command: 'run_plan' }, { kind: 'user' });

    await finish(session, sessions, 't1');
    await vi.waitFor(() => expect(statusOf(session, 't3')).toBe('in_progress'));

    expect(statusOf(session, 't3')).toBe('in_progress');
  });

  it('moves a finished task to the execution log without duplicating it', async () => {
    const { session, sessions } = twoParallel();
    await session.execute({ command: 'run_plan' }, { kind: 'user' });

    await finish(session, sessions, 't1');
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

  it('serves a retried task live, with every attempt it spent, not the snapshot its failure archived', async () => {
    const { session, sessions } = twoParallel();
    const served = (): Readonly<Task> | undefined => {
      const state = session.currentPlanState;
      return state ? rejoinPlanTree(state.pendingTasks, state.phase === 'executing' ? state.executionLog : []).find((t) => t.id === 't1') : undefined;
    };
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    sessions[0].emitEvent({ type: 'usage', record: { source: 'claude-code', inputTokens: 100, reportedCost: { amount: 1, currency: 'USD' } } });
    sessions[0].emitExit(1);
    await vi.waitFor(() => expect(served()?.status).toBe('failed'));

    await session.execute({ command: 'retry_task', task: 't1', from: 'fresh' }, { kind: 'user' });
    sessions[2].emitEvent({ type: 'usage', record: { source: 'claude-code', inputTokens: 200, reportedCost: { amount: 2, currency: 'USD' } } });
    expect(served()?.status).toBe('in_progress');
    expect(taskUsageSummary(served()!)).toMatchObject({ attempts: 2, totals: { inputTokens: 300, reportedCost: { USD: 3 } } });

    await session.execute({ command: 'stop_task', task: 't1' }, { kind: 'user' });
    expect(served()?.status).toBe('pending');
    expect(taskUsageSummary(served()!)).toMatchObject({ attempts: 2, totals: { inputTokens: 300, reportedCost: { USD: 3 } } });
  });
});

describe('a continue counts its runner session\'s cost on from what was counted before', () => {
  /** Each spawn's session; `nativeIds` picks the native session id a spawn reports, defaulting to one session. */
  function spawning(nativeIds: string[] = []) {
    const sessions: FakeRunnerSession[] = [];
    const runner = {
      spawn: vi.fn(async ({ taskId }: Parameters<IRunner['spawn']>[0]) => {
        const s = new FakeRunnerSession(`s${sessions.length + 1}`, taskId, nativeIds[sessions.length] ?? 'native-1');
        sessions.push(s);
        return s;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies IRunner;
    return { runner, sessions };
  }
  const plan = (): LegacyPlanState => ({
    tasks: [createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', assignedRunner: 'claude-code' })],
    generatedAt: '', status: 'approved', runners: ['claude-code'], lastUpdated: '',
  });
  const counted = { sessionId: 'native-1', usd: 0.5, modelUsd: { 'claude-sonnet-5': 0.5 } };

  it('hands the resumed spawn the count its attempt ended with, after a reload too', async () => {
    const first = spawning();
    const session = makeSession({ runner: first.runner });
    session.loadPlan(plan(), 'Goal', '/repo');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    first.sessions[0].cost = counted;
    first.sessions[0].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(taskOf(session, 't1')?.status).toBe('completed'));
    const saved = saves(session).mock.calls.at(-1)?.[0];
    expect(saved?.tasks[0].attemptUsage?.at(-1)?.runnerSessionCost).toEqual(counted);

    const later = spawning();
    const reloaded = makeSession({ runner: later.runner });
    reloaded.loadPlan(saved!, 'Goal', '/repo');
    await reloaded.execute({ command: 'retry_task', task: 't1', from: 'session', message: 'one more thing' }, { kind: 'user' });

    expect(later.runner.spawn).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: 'native-1', resumeCost: counted }));
  });

  it('measures a continue against the window its session reported before, when the resumed turn reports none', async () => {
    const { runner, sessions } = spawning();
    const session = makeSession({ runner });
    session.loadPlan(plan(), 'Goal', '/repo');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    sessions[0].emitEvent({ type: 'usage', record: { source: 'claude-code', model: 'claude-mystery', inputTokens: 1_000, contextWindow: 500_000 } });
    sessions[0].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(taskOf(session, 't1')?.status).toBe('completed'));

    await session.execute({ command: 'retry_task', task: 't1', from: 'session', message: 'one more thing' }, { kind: 'user' });
    sessions[1].emitEvent({ type: 'usage', record: { source: 'claude-code', model: 'claude-mystery', inputTokens: 50_000 } });

    await vi.waitFor(() => expect(taskUsageSummary(taskOf(session, 't1')!).contextFill).toEqual({ usedTokens: 50_000, windowTokens: 500_000 }));
  });

  // A continue that ends without measuring anything is still the same session:
  // the window the first attempt reported is its session's, not the empty
  // ledger the continue left behind.
  it('keeps the window its session reported across a continue that measured nothing', async () => {
    const { runner, sessions } = spawning();
    const session = makeSession({ runner });
    session.loadPlan(plan(), 'Goal', '/repo');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    sessions[0].emitEvent({ type: 'usage', record: { source: 'claude-code', model: 'claude-mystery', inputTokens: 1_000, contextWindow: 500_000 } });
    sessions[0].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(taskOf(session, 't1')?.status).toBe('completed'));

    await session.execute({ command: 'retry_task', task: 't1', from: 'session', message: 'one more thing' }, { kind: 'user' });
    sessions[1].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(taskOf(session, 't1')?.status).toBe('completed'));

    await session.execute({ command: 'retry_task', task: 't1', from: 'session', message: 'and one more' }, { kind: 'user' });
    sessions[2].emitEvent({ type: 'usage', record: { source: 'claude-code', model: 'claude-mystery', inputTokens: 50_000 } });

    await vi.waitFor(() => expect(taskUsageSummary(taskOf(session, 't1')!).contextFill).toEqual({ usedTokens: 50_000, windowTokens: 500_000 }));
  });

  // A continue of a fresh attempt's session is not handed the window an
  // earlier, different runner session ended on; the model's window is still
  // known, because it was reported in this Ordewell session.
  it('hands a continue no other runner session\'s window, and still knows its model\'s', async () => {
    const { runner, sessions } = spawning(['native-1', 'native-2']);
    const session = makeSession({ runner });
    session.loadPlan(plan(), 'Goal', '/repo');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    sessions[0].emitEvent({ type: 'usage', record: { source: 'claude-code', model: 'claude-mystery', inputTokens: 1_000, contextWindow: 500_000 } });
    sessions[0].reportComplete({ status: 'failed', summary: '', reason: 'no' });
    await vi.waitFor(() => expect(taskOf(session, 't1')?.status).toBe('failed'));

    await session.execute({ command: 'retry_task', task: 't1', from: 'fresh' }, { kind: 'user' });
    sessions[1].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(taskOf(session, 't1')?.status).toBe('completed'));
    expect(taskOf(session, 't1')?.runnerSessionId).toBe('native-2');

    await session.execute({ command: 'retry_task', task: 't1', from: 'session', message: 'and one more' }, { kind: 'user' });
    expect(runner.spawn.mock.calls[2][0].resumeSessionId).toBe('native-2');
    expect(runner.spawn.mock.calls[2][0].resumeWindow).toBeUndefined();
    sessions[2].emitEvent({ type: 'usage', record: { source: 'claude-code', model: 'claude-mystery', inputTokens: 50_000 } });

    await vi.waitFor(() => expect(taskUsageSummary(taskOf(session, 't1')!).totals.inputTokens).toBe(51_000));
    expect(taskUsageSummary(taskOf(session, 't1')!).contextFill).toEqual({ usedTokens: 50_000, windowTokens: 500_000 });
  });

  it('hands a fresh attempt no count', async () => {
    const { runner } = spawning();
    const session = makeSession({ runner });
    session.loadPlan(plan(), 'Goal', '/repo');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    expect(runner.spawn.mock.calls[0][0].resumeCost).toBeUndefined();
  });
});

describe('planState.tasks — written from the store, never shared with it', () => {
  function planOf(tasks: ReturnType<typeof createTask>[]): LegacyPlanState {
    return { tasks, generatedAt: '', status: 'approved', runners: ['claude-code'], lastUpdated: '' };
  }

  it('does not let an edit to the plan object reach the store, or the store reach the caller\'s tasks', () => {
    // A status only a file from before ADR-0034 holds: the load rewrites it, on its own copy.
    const input = [createTask({ id: 't1', order: 1, title: 'First', prompt: 'p', status: 'blocked' as Task['status'] })];
    const session = makeSession();
    session.loadPlan(planOf(input), 'Test', '/repo');

    expect(input[0].status).toBe('blocked');
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
      spawn: vi.fn().mockImplementation((req: { taskId: string }) => Promise.resolve(new FakeRunnerSession(`s-${req.taskId}`, req.taskId))),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } as unknown as IRunner;
    const session: Session = makeSession({
      runner,
      broadcast: vi.fn((msg: { type: string }) => {
        if (msg.type === 'status_update') seen.push(session.planState?.tasks[0].status);
      }),
    });
    session.loadPlan(planOf([createTask({ id: 't1', order: 1, title: 'First', prompt: 'p' })]), 'Test', '/repo');

    await session.execute({ command: 'run_plan' }, { kind: 'user' });

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
        // A backend that says nothing of automatic compaction, as a harness planner's: the meter is these records' alone.
        aiService: {},
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
          byModel: [{ source: 'claude-code', totals: { inputTokens: 1000, outputTokens: 100, reportedCost: { USD: 0.01 } } }],
          contextFill: { usedTokens: 1000, windowTokens: 200000 },
        },
        {
          type: 'planner_usage', turnId: 't1',
          totals: { inputTokens: 1400, outputTokens: 140, reportedCost: { USD: 0.01 } },
          byModel: [{ source: 'claude-code', totals: { inputTokens: 1400, outputTokens: 140, reportedCost: { USD: 0.01 } } }],
          bySubagent: { sa1: { inputTokens: 400, outputTokens: 40 } },
          contextFill: { usedTokens: 1000, windowTokens: 200000 },
        },
      ]);
    });

    it('carries the used tokens without a window while the window is unknown', async () => {
      const sent = await broadcastsFor([{ type: 'usage', record: { source: 'openai', inputTokens: 1000 } }]);

      expect(sent).toEqual([{ type: 'planner_usage', totals: { inputTokens: 1000 }, contextFill: { usedTokens: 1000 }, byModel: [{ source: 'openai', totals: { inputTokens: 1000 } }] }]);
    });

    it('treats a reported window of zero as unknown, not as no room, and still carries the used tokens', async () => {
      const sent = await broadcastsFor([
        { type: 'usage', record: { source: 'codex', inputTokens: 1000, contextWindow: 0 } },
      ]);

      expect(sent).toEqual([{ type: 'planner_usage', totals: { inputTokens: 1000 }, contextFill: { usedTokens: 1000 }, byModel: [{ source: 'codex', totals: { inputTokens: 1000 } }] }]);
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
        byModel: [{ source: 'openai', totals: { inputTokens: 10, outputTokens: 2, reportedCost: { USD: 0.5 } } }],
        source: 'openai',
        model: undefined,
        lastPromptTokens: 10,
      });
    });

    it('restores saved totals and re-broadcasts them when a session loads', async () => {
      const broadcast = vi.fn();
      const session = makeSession({ broadcast, aiService: {} });
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

    // A plan saved before the meter existed carries a prompt count and no
    // window: that is what it can show. Nothing is invented for it, and a
    // task's own line reads the same way.
    it('loads a plan saved before context windows and the context measure without inventing one', async () => {
      const broadcast = vi.fn();
      const saved = smallPlan();
      saved.tasks[0].assignedRunner = 'claude-code';
      saved.plannerUsage = {
        totals: { inputTokens: 1500, outputTokens: 200 },
        source: 'claude-code',
        model: 'claude-opus-5-5',
        lastPromptTokens: 22_000,
      };
      saved.tasks[0].attemptUsage = [{
        attempt: 1,
        runner: 'claude-code',
        startedAt: '2026-10-18T10:00:00.000Z',
        endedAt: '2026-10-18T10:01:00.000Z',
        wallTimeMs: 60_000,
        totals: { inputTokens: 22_000 },
        source: 'claude-code',
        model: 'claude-opus-5-5',
        lastPromptTokens: 22_000,
      }];
      const session = makeSession({ broadcast, aiService: {} });
      session.loadPlan(saved, 'old', '/repo', { persist: false });

      const line = broadcast.mock.calls.map(([m]) => m as SessionMessage).filter((m) => m.type === 'planner_usage').at(-1);
      expect(line?.contextFill).toEqual({ usedTokens: 22_000 });
      expect(taskUsageSummary(taskOf(session, 't1')!).contextFill).toEqual({ usedTokens: 22_000 });
      expect(contextMeterText(taskUsageSummary(taskOf(session, 't1')!).contextFill)).toBe('ctx 22k');
      session.destroy();
    });

    // A plan saved before any context measure has none: the line shows the
    // totals alone, never a ctx 0.
    it('shows no meter for a plan saved with no context measure at all', () => {
      const session = makeSession();
      const saved = smallPlan();
      saved.plannerUsage = { totals: { inputTokens: 1500 } };
      saved.tasks[0].attemptUsage = [{
        attempt: 1, runner: 'claude-code', startedAt: '2026-10-18T10:00:00.000Z', wallTimeMs: 0,
        totals: { inputTokens: 1500 },
      }];
      session.loadPlan(saved, 'old', '/repo', { persist: false });
      expect(taskUsageSummary(taskOf(session, 't1')!).contextFill).toBeUndefined();
      expect(usageText(taskUsageSummary(taskOf(session, 't1')!))).toBeNull();
      session.destroy();
    });

    // A reloaded plan's planner does not resume its old Claude Code session: it
    // starts a fresh one seeded from the transcript (ADR-0009, T4), so its
    // first turn is counted from zero on top of the ledger the plan restored.
    // Whoever makes a reload resume the old session must carry its count too —
    // its total would otherwise be counted again, or this test would fail.
    it('counts a reloaded planner\'s first turn in full on top of the restored ledger', async () => {
      const spawned = fakeSpawn([fixture('claude-code', 'stream-reasoning')]);
      const cli = new CliAgentAiService(fakeConfig({ aiProvider: 'claude-code' }), {
        spawn: spawned.spawn,
        fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
        resolvePath: async () => '/usr/bin',
        workspaceRoot: () => '/repo',
        platform: 'linux',
        isDirectory: () => true,
        exists: () => true,
        mcpServer: fakeMcpServer(),
      });
      const session = makeSession({
        aiService: {
          startConversation: (req: import('../../services/AiService').ConversationRequest) => cli.startConversation(req),
          continueConversation: (message: string, onProgress: (p: import('../../models/Task').ResearchProgress) => void) => cli.continueConversation(message, onProgress),
          hasActiveConversation: () => cli.hasActiveConversation(),
          reset: () => cli.reset(),
        },
      });
      const saved = smallPlan();
      saved.status = 'draft';
      saved.conversationHistory = [
        { role: 'user', content: 'build it', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'Which store?', timestamp: new Date().toISOString() },
      ];
      saved.plannerUsage = { totals: { inputTokens: 1500, reportedCost: { USD: 1 } } };
      session.loadPlan(saved, 'build it', '/repo', { persist: false });

      await session.continueConversation('postgres');

      expect(spawned.lastArgs()).not.toContain('--resume');
      // 0.075482 is the recorded fixture's first-turn total.
      expect(saves(session).mock.calls.at(-1)![0].plannerUsage?.totals.reportedCost?.USD).toBeCloseTo(1.075482, 10);
    });

    // VS Code's Execute re-adopts the Session's own plan object, and is offered
    // while a planner turn runs: what that turn spent is recorded, not yet saved.
    it('keeps a turn\'s unsaved usage when the plan it is answering is re-adopted', async () => {
      const broadcast = vi.fn();
      let progress: ((p: import('../../models/Task').ResearchProgress) => void) | undefined;
      const session = makeSession({
        broadcast,
        aiService: {
          startConversation: vi.fn(async (req: import('../../services/AiService').ConversationRequest) => {
            req.onProgress({ type: 'usage', record: { source: 'openai', inputTokens: 100 } });
            return { kind: 'message' as const, text: 'Which store?', researchLog: [] };
          }),
          continueConversation: vi.fn((_message: string, onProgress: (p: import('../../models/Task').ResearchProgress) => void) => {
            progress = onProgress;
            return new Promise<never>(() => {});
          }),
          hasActiveConversation: () => true,
          reset: vi.fn(),
        },
      });
      await session.startPlanning('goal', ['claude-code']);
      void session.continueConversation('postgres').catch(() => {});
      await vi.waitFor(() => expect(progress).toBeDefined());
      progress!({ type: 'usage', record: { source: 'openai', inputTokens: 50 } });
      broadcast.mockClear();

      session.loadPlan(session.planState!, 'goal', '/repo');

      expect(saves(session).mock.calls.at(-1)![0].plannerUsage?.totals).toEqual({ inputTokens: 150 });
      const sent = broadcast.mock.calls.map(([m]) => m).filter((m) => m.type === 'planner_usage');
      expect(sent.map((m) => m.totals)).toEqual([{ inputTokens: 150 }]);
    });

    it('does not re-broadcast usage for a plan that never recorded any', () => {
      const broadcast = vi.fn();
      const session = makeSession({ broadcast });

      session.loadPlan(smallPlan(), 'build it', '/repo', { persist: false });

      expect(broadcast.mock.calls.map((c) => (c[0] as { type: string }).type)).not.toContain('planner_usage');
    });

    it('measures the planner\'s context against the resolver\'s window for the model each call names', async () => {
      const broadcast = vi.fn();
      const windows: Record<string, number> = { 'gpt-4o': 128000, 'gpt-4o-mini': 64000 };
      const session = makeSession({
        broadcast,
        modelResolver: { modelsForRunners: vi.fn().mockResolvedValue({}), contextWindowFor: (source: string, model: string) => source === 'openai' ? windows[model] : undefined },
        aiService: {
          startConversation: vi.fn(async (req: import('../../services/AiService').ConversationRequest) => {
            req.onProgress({ type: 'usage', record: { source: 'openai', model: 'gpt-4o', inputTokens: 90000 } });
            req.onProgress({ type: 'usage', record: { source: 'openai', model: 'gpt-4o-mini', inputTokens: 30000 } });
            return { kind: 'message' as const, text: 'done', researchLog: [] };
          }),
          hasActiveConversation: () => true,
          reset: vi.fn(),
        },
      });

      await session.startPlanning('goal', ['claude-code']);

      const fills = broadcast.mock.calls.map((c) => c[0] as { type: string; contextFill?: unknown }).filter((m) => m.type === 'planner_usage').map((m) => m.contextFill);
      expect(fills).toEqual([{ usedTokens: 90000, windowTokens: 128000 }, { usedTokens: 30000, windowTokens: 64000 }]);
    });
  });

  describe('subagent persistence (#50)', () => {
    it('saves the subagents one-shot plan generation started with the plan', async () => {
      const step: import('../../models/Task').ResearchStep = { id: 'a1', tool: 'grep', args: '{}', result: '', success: true, outcome: 'success', subagentId: 'sa-a', timestamp: '' };
      const session = makeSession({
        planner: {
          generate: vi.fn(async (req: { onProgress?: (p: import('../../models/Task').ResearchProgress) => void }) => {
            req.onProgress?.({ type: 'subagent_started', subagentId: 'sa-a', brief: 'explore a' });
            req.onProgress?.({ type: 'tool_result', subagentId: 'sa-a', step });
            req.onProgress?.({ type: 'subagent_finished', subagentId: 'sa-a', outcome: 'done', digest: 'found a' });
            return { tasks: [], generatedAt: '', status: 'draft' as const, runners: ['claude-code' as const], lastUpdated: '', researchLog: [step] };
          }),
        },
      });

      await session.generatePlan('add persistence', ['claude-code']);

      const saved = saves(session).mock.calls.at(-1)![0] as LegacyPlanState;
      expect((saved.researchLog ?? []).map((e) => e.id)).toEqual(['sa-sa-a', 'a1']);
      expect(saved.researchLog![0]).toMatchObject({ brief: 'explore a', outcome: 'done', digest: 'found a' });
    });

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
            { type: 'assistant_text', runId: 'r1', text: 'Found it.' },
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
            { type: 'assistant_text_delta', runId: 'r1', text: 'Looking. ' },
            { type: 'tool_call', id: 'c1', name: 'Grep', args: { pattern: 'cache' } },
            { type: 'tool_result', id: 'c1', name: 'Grep', output: 'src/cache.ts', success: true },
            { type: 'assistant_text_delta', runId: 'r2', text: 'It is in src/cache.ts.' },
            { type: 'assistant_text', runId: 'r2', text: 'It is in src/cache.ts.' },
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
      // Each run settles where it streamed, around the call between them (ADR-0017 A1).
      expect(view.blocks.map((b) => (b.type === 'message' ? [b.role, b.text, b.streaming] : b.type))).toEqual([
        ['user', 'find the cache', false], ['planner', 'Looking. ', false], 'tool', ['planner', 'It is in src/cache.ts.', false], 'usage',
      ]);
      expect(view.blocks.some((b) => b.type === 'plan' && b.status === 'building')).toBe(false);
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
            { type: 'assistant_text', runId: 'r1', text: 'Found it.' },
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
// (the plan block would present them to the model as the CURRENT plan),
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

  it('startPlanning does not announce the new plan as emptied to a planner that never saw the old one', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: {
        startConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'What storage?', researchLog: [] }),
        continueConversation,
        hasActiveConversation: () => true,
      },
    });

    // A turn over the old plan leaves its rows in that planner's context.
    session.loadPlan(planWith('old-1', 'Old task'), 'Old goal', '/repo');
    await session.continueConversation('and now?');
    expect(continueConversation.mock.calls[0][0]).toContain('<current_plan>');

    await session.startPlanning('new unrelated goal', ['claude-code']);
    await session.continueConversation('sounds good, proceed');

    expect(continueConversation.mock.calls[1][0]).not.toContain('The plan now has no tasks.');
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

  it('loadPlan of a different plan drops the previous session\'s pending turns, and their callers hear it', async () => {
    const session = makeSession({
      aiService: { hasActiveConversation: () => true, continueConversation: vi.fn(() => new Promise<never>(() => {})), reset: vi.fn() },
    });
    session.loadPlan(planWith('a1', 'Plan A task'), 'Goal A', '/repo');
    const inFlight = session.continueConversation('meant for session A');
    const waiting = session.continueConversation('also for session A');

    const planB = planWith('b1', 'Plan B task');
    session.loadPlan(planB, 'Goal B', '/repo');

    await expect(inFlight).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    await expect(waiting).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    expect(planB.pendingTurns).toBeUndefined();
  });

  it('reset() returns the Session to a blank slate with a fresh identity', () => {
    const reset = vi.fn();
    const session = makeSession({
      aiService: { hasActiveConversation: () => true, reset },
    });
    session.loadPlan(planWith('a1', 'Plan A task'), 'Goal A', '/repo');
    const oldId = session.sessionId;

    session.reset();

    expect(session.planState).toBeNull();
    expect(session.currentGoal).toBe('');
    expect(session.planTasks).toHaveLength(0);
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
    const fakeSession = new FakeRunnerSession('s1', 't1');
    const runner = {
      spawn: vi.fn().mockResolvedValue(fakeSession),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } as unknown as IRunner;

    const broadcast = vi.fn();
    const session = makeSession({ broadcast, runner });
    session.loadPlan(onePlan(), 'Test', '/repo');

    vi.useFakeTimers();
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    fakeSession.emitOutput('working...');
    broadcast.mockClear();

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS);

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
    const runnerSessions: FakeRunnerSession[] = [];
    const runner = {
      spawn: vi.fn().mockImplementation((req: { taskId: string }) => {
        const t = new FakeRunnerSession(`s-${req.taskId}`, req.taskId);
        runnerSessions.push(t);
        return Promise.resolve(t);
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } as unknown as IRunner;
    // Each save and each announcement, tagged with t1's status as it was then.
    const order: string[] = [];
    const messages: SessionMessage[] = [];
    const saveSession = vi.fn((plan: LegacyPlanState) => {
      order.push(`save:${plan.tasks.find((t) => t.id === 't1')!.status}`);
    });
    const broadcast = (msg: SessionMessage) => {
      messages.push(msg);
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
    const runnerSession = (taskId: string) => runnerSessions.find((t) => t.taskId === taskId)!;
    return { session, saveSession, order, runnerSession, messages };
  }

  it('persists live attempt usage before broadcasting the task ledgers and task total', async () => {
    const env = twoTaskRun();
    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });
    env.order.length = 0;
    env.runnerSession('t1').emitEvent({ type: 'usage', record: { source: 'claude-code', model: 'actual', inputTokens: 10, reportedCost: { amount: 0.5, currency: 'USD' } } });
    expect(env.order).toEqual(['save:in_progress', 'status:in_progress']);
    const persisted = env.saveSession.mock.calls.at(-1)![0];
    expect(persisted.tasks[0].attemptUsage?.[0].byModel?.[0].model).toBe('actual');
    expect(persisted.tasks[0].attemptUsage?.[0].totals).toEqual({ inputTokens: 10, reportedCost: { USD: 0.5 } });
    const status = env.messages.filter((msg) => msg.type === 'status_update').at(-1);
    expect(status?.type).toBe('status_update');
    if (status?.type !== 'status_update') throw new Error('Missing status update');
    expect(status.usage?.totals).toEqual({ inputTokens: 10, reportedCost: { USD: 0.5 } });
    expect(status.tasks[0].attemptUsage?.[0].totals).toEqual(status.usage?.totals);
    expect(status.usage?.attempts).toBe(2);
    env.session.destroy();
    const restored = makeSession();
    restored.loadPlan(persisted, 'Usage', '/repo', { persist: false });
    expect(taskOf(restored, 't1')?.attemptUsage?.[0].totals).toEqual(status.usage?.totals);
    restored.destroy();
  });

  it('measures a task\'s context against its runner\'s catalog window when the runner reports none', async () => {
    const runnerSession = new FakeRunnerSession('s-t1', 't1');
    const runner = { spawn: vi.fn(async () => runnerSession), stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as unknown as IRunner;
    const logs = memoryTaskLogs();
    const session = makeSession({
      runner,
      openTaskLog: logs,
      modelResolver: { modelsForRunners: vi.fn().mockResolvedValue({}), contextWindowFor: (source: string, model: string) => source === 'opencode' && model === 'opencode/big-pickle' ? 400000 : undefined },
    });
    session.loadPlan({
      tasks: [createTask({ id: 't1', order: 1, title: 'First', prompt: 'a', assignedRunner: 'opencode' })],
      generatedAt: new Date().toISOString(), status: 'approved', runners: ['opencode'], lastUpdated: new Date().toISOString(),
    }, 'Test', '/repo', { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });

    runnerSession.emitEvent({ type: 'usage', record: { source: 'opencode', model: 'opencode/big-pickle', inputTokens: 1000 } });
    runnerSession.emitExit(0);

    const usage = taskOf(session, 't1')?.attemptUsage?.at(-1);
    expect(usage && plannerContextFill(usage)).toEqual({ usedTokens: 1000, windowTokens: 400000 });
    // The task log is what a surface folds into the task's own meter.
    const logged = logs.files.get('t1')?.at(-1)?.find((e) => e.type === 'usage');
    expect(logged).toEqual({ type: 'usage', record: { source: 'opencode', model: 'opencode/big-pickle', inputTokens: 1000, contextWindow: 400000 } });
    session.destroy();
  });

  // Claude Code states a window only on a turn's last line, and a task is
  // often one long turn: the planner's report on the same model is what the
  // task's meter has from its first call, and a reload still knows it.
  it('measures a Claude Code task on the planner\'s model against the window the planner was told, from its first call and after a reload', async () => {
    const spawned: FakeRunnerSession[] = [];
    const runner = () => ({
      spawn: vi.fn(async (req: { taskId: string }) => {
        const runnerSession = new FakeRunnerSession(`s-${req.taskId}`, req.taskId);
        spawned.push(runnerSession);
        return runnerSession;
      }),
      stop: vi.fn(), stopAll: vi.fn(), activeCount: 0,
    }) as unknown as IRunner;
    const session = makeSession({
      runner: runner(),
      aiService: {
        startConversation: vi.fn(async (req: import('../../services/AiService').ConversationRequest) => {
          req.onProgress({ type: 'usage', record: { source: 'claude-code', model: 'claude-opus-5-5', inputTokens: 20000, outputTokens: 500, contextTokens: 20500 } });
          req.onProgress({ type: 'usage', record: { source: 'claude-code', model: 'claude-opus-5-5', contextWindow: 1_000_000 } });
          return { kind: 'message' as const, text: 'Planned.', researchLog: [] };
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    await session.startPlanning('goal', ['claude-code']);
    const plan = session.planState!;
    Object.assign(plan, { status: 'approved', runners: ['claude-code'], tasks: [createTask({ id: 't1', order: 1, title: 'First', prompt: 'a', assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-opus-5-5', modelLabel: 'Opus 5.5' } })] });
    session.loadPlan(plan, 'goal', '/repo');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });

    spawned[0].emitEvent({ type: 'usage', record: { source: 'claude-code', model: 'claude-opus-5-5', inputTokens: 60000, outputTokens: 1000, contextTokens: 61000 } });
    expect(contextMeterText(taskUsageSummary(taskOf(session, 't1')!).contextFill)).toBe('ctx 61k (6%)');

    const persisted = saves(session).mock.calls.at(-1)![0] as LegacyPlanState;
    expect(persisted.contextWindows).toEqual([{ source: 'claude-code', model: 'claude-opus-5-5', contextWindow: 1_000_000 }]);
    session.destroy();

    const restored = makeSession({ runner: runner() });
    restored.loadPlan({
      ...persisted, approved: undefined, approvedTasks: undefined,
      tasks: [createTask({ id: 't2', order: 1, title: 'Second', prompt: 'b', assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-opus-5-5', modelLabel: 'Opus 5.5' } })],
    }, 'goal', '/repo', { persist: false });
    await restored.execute({ command: 'run_plan' }, { kind: 'user' });
    spawned[1].emitEvent({ type: 'usage', record: { source: 'claude-code', model: 'claude-opus-5-5', inputTokens: 40000, outputTokens: 1000, contextTokens: 41000 } });
    expect(contextMeterText(taskUsageSummary(taskOf(restored, 't2')!).contextFill)).toBe('ctx 41k (4%)');
    restored.destroy();
  });

  it('shows the task log\'s meter, the attempt ledger\'s and the reloaded plan\'s as one, through a compaction', async () => {
    const runnerSession = new FakeRunnerSession('s-t1', 't1');
    const runner = { spawn: vi.fn(async () => runnerSession), stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as unknown as IRunner;
    const logs = memoryTaskLogs();
    const session = makeSession({ runner, openTaskLog: logs });
    session.loadPlan({
      tasks: [createTask({ id: 't1', order: 1, title: 'First', prompt: 'a', assignedRunner: 'claude-code' })],
      generatedAt: new Date().toISOString(), status: 'approved', runners: ['claude-code'], lastUpdated: new Date().toISOString(),
    }, 'Test', '/repo', { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });

    runnerSession.emitEvent({ type: 'usage', record: { source: 'claude-code', model: 'claude-opus-5-5', inputTokens: 60_000, outputTokens: 1_000, contextTokens: 61_000, contextWindow: 1_000_000 } });
    runnerSession.emitEvent({ type: 'usage', record: { source: 'claude-code', model: 'claude-opus-5-5', compacted: true, contextTokens: 3_615 } });
    runnerSession.emitEvent({ type: 'usage', record: { source: 'claude-code', model: 'claude-opus-5-5', inputTokens: 40_000, outputTokens: 1_000, contextTokens: 41_000 } });
    runnerSession.reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(taskOf(session, 't1')?.status).toBe('completed'));

    const attempt = taskOf(session, 't1')!.attemptUsage!.at(-1)!;
    const expected = { usedTokens: 41_000, windowTokens: 1_000_000 };
    expect(plannerContextFill(attempt)).toEqual(expected);
    // The task log a surface folds into its own line, from the events it saved.
    expect(plannerContextFill(replayTaskLog(logs.files.get('t1')!.at(-1)!).usage!)).toEqual(expected);

    const persisted = saves(session).mock.calls.at(-1)![0] as LegacyPlanState;
    session.destroy();
    const restored = makeSession();
    restored.loadPlan(persisted, 'Test', '/repo', { persist: false });
    expect(plannerContextFill(taskOf(restored, 't1')!.attemptUsage!.at(-1)!)).toEqual(expected);
    restored.destroy();
  });

  it('saves a task\'s verdict the moment it lands, before announcing it, while the run goes on', async () => {
    const { session, saveSession, order, runnerSession } = twoTaskRun();
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    saveSession.mockClear();
    order.length = 0;

    runnerSession('t1').reportComplete({ status: 'done', summary: '' });
    runnerSession('t1').emitExit(0);

    await vi.waitFor(() => expect(order).toContain('save:completed'));
    expect(order.indexOf('save:completed')).toBeLessThan(order.indexOf('status:completed'));
    expect(order).not.toContain('complete');
    expect(session.isExecuting).toBe(true);
  });

  it('saves a failed verdict as well', async () => {
    const { session, saveSession, runnerSession } = twoTaskRun();
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    saveSession.mockClear();

    runnerSession('t1').emitExit(1);

    await vi.waitFor(() => expect(saveSession.mock.calls.some(([p]) => p.tasks.find((t) => t.id === 't1')!.status === 'failed')).toBe(true));
  });

  it('does not save on a status change that settles nothing', async () => {
    const { session, saveSession, runnerSession } = twoTaskRun();
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    saveSession.mockClear();

    runnerSession('t1').emitOutput('still working');

    expect(saveSession).not.toHaveBeenCalled();
  });
});

describe('a task control naming a task the plan does not hold', () => {
  it.each([
    ['forceStartTask', (s: Session) => s.execute({ command: 'force_start', task: 'gone' }, { kind: 'user' })],
    ['run_task', (s: Session) => s.execute({ command: 'run_task', task: 'gone' }, { kind: 'user' })],
  ])('%s is refused, and the run in progress keeps its agent and its verdict', async (_name, start) => {
    const spawned: FakeRunnerSession[] = [];
    const runner = {
      spawn: vi.fn(async ({ taskId }: Parameters<IRunner['spawn']>[0]) => {
        const s = new FakeRunnerSession(`s-${taskId}`, taskId);
        spawned.push(s);
        return s;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies IRunner;
    const session = makeSession({ runner });
    session.loadPlan({
      tasks: [
        createTask({ id: 't1', order: 1, title: 'First', prompt: 'one' }),
        createTask({ id: 't2', order: 2, title: 'Second', prompt: 'two', dependencies: ['t1'] }),
      ],
      generatedAt: new Date().toISOString(),
      status: 'draft',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    }, 'Test', '/repo');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));

    await expect(start(session)).resolves.toMatchObject({ ok: false, outcome: 'refused', message: expect.stringMatching(/no task "gone"/i) });

    spawned[0].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(taskOf(session, 't1')?.status).toBe('completed'));
    await vi.waitFor(() => expect(spawned.map((s) => s.taskId)).toEqual(['t1', 't2']));
  });
});

describe('executing a plan whose tasks are all completed', () => {
  it('announces the end of execution once', async () => {
    const broadcast = vi.fn<(msg: SessionMessage) => void>();
    const session = makeSession({ broadcast });
    session.loadPlan({
      tasks: [createTask({ id: 't1', order: 1, title: 'Done already', prompt: 'one', status: 'completed' })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    }, 'Test', '/repo');

    await session.execute({ command: 'approve_review' }, { kind: 'user' });

    expect(broadcast.mock.calls.filter(([msg]) => msg.type === 'execution_complete')).toHaveLength(1);
  });
});

describe("the planner shell's notice and scratch directory (ADR-0011)", () => {
  it('says the notice the filesystem raises through the session, and ends its session on reset and destroy', () => {
    let notify: ((message: string) => void) | undefined;
    const endSession = vi.fn();
    const notices: unknown[] = [];
    const session = makeSession({
      fsAdapter: { ...fakeFs(), setNotice: (notice) => { notify = notice; }, endSession },
      onNotice: (notice) => notices.push(notice),
    });

    notify?.('The planner\'s shell runs without an OS sandbox on this machine.');
    expect(notices).toEqual([{ type: 'notice', level: 'warn', message: 'The planner\'s shell runs without an OS sandbox on this machine.' }]);

    session.reset();
    expect(endSession).toHaveBeenCalledTimes(1);
    session.destroy();
    expect(endSession).toHaveBeenCalledTimes(2);
  });
});

describe('the native-shell setting\'s notice channel (ADR-0036 N4)', () => {
  it('hands a harness planner the session notice, so it can say why the setting is not offered', async () => {
    const notices: unknown[] = [];
    const startConversation = vi.fn(async (req: { notice?: (level: 'warn', message: string) => void }) => {
      req.notice?.('warn', 'The planner\'s own shell is off: Claude Code 2.1.300 has not been checked.');
      return { kind: 'message' as const, text: 'hello', researchLog: [] };
    });
    const session = makeSession({
      aiService: { startConversation, hasActiveConversation: () => false, reset: vi.fn() },
      onNotice: (notice) => notices.push(notice),
    });

    await session.startPlanning('test goal', ['claude-code']);

    expect(notices).toEqual([{
      type: 'notice',
      level: 'warn',
      message: 'The planner\'s own shell is off: Claude Code 2.1.300 has not been checked.',
    }]);
  });
});
