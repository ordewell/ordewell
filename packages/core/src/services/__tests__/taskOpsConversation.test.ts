import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { FakeRunnerSession, makeSession, testWorkspace, taskOf, saves } from './sessionTestKit';
import type { IRunner } from '../../interfaces/IRunner';
import type { ModelResolver } from '../ModelResolver';
import type { SessionMessage } from '../SessionMessage';
import { SURFACE_AND_SETTINGS } from '../surfaceControls';

/** A runner double that records the order tasks were spawned in. */
/** The turn without its standing facts, whose control labels name queued messages whatever the run is doing (ADR-0030). */
function withoutFacts(turn: string): string {
  return turn.split('\n\n').filter((part) => !part.startsWith(SURFACE_AND_SETTINGS)).join('\n\n');
}

function recordingRunner(spawned: string[]): IRunner {
  return {
    spawn: vi.fn(async ({ taskId }: { taskId: string }) => {
      spawned.push(taskId);
      return new FakeRunnerSession(`s-${taskId}`, taskId);
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } as unknown as IRunner;
}

function planWithTasks(): LegacyPlanState {
  return {
    tasks: [
      createTask({ id: 'a', order: 1, title: 'Setup', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 2, title: 'Build', prompt: 'p', dependencies: ['a'], assignedRunner: 'claude-code' }),
    ],
    generatedAt: new Date().toISOString(),
    status: 'draft',
    runners: ['claude-code'],
    lastUpdated: new Date().toISOString(),
    conversationHistory: [
      { role: 'user', content: 'build it', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Plan generated with 2 tasks.', timestamp: '2026-01-01T00:00:01Z', kind: 'plan_generated' },
    ],
  };
}

/**
 * A plan the scheduler has already run into a pause: one completed AI task, one
 * AI task the user cancelled (on hold) and one pending `user` task. Nothing is
 * live, but `tick()` keeps the scheduler armed so the user task can still fan
 * its dependents out.
 */
function pausedRunPlan(): LegacyPlanState {
  return {
    tasks: [
      createTask({ id: 'a', order: 1, title: 'Setup', prompt: 'p', status: 'completed', assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 2, title: 'Build', prompt: 'p', dependencies: ['a'], assignedRunner: 'claude-code' }),
      createTask({ id: 'c', order: 3, title: 'Sign off', type: 'user', dependencies: ['a'], assignedRunner: 'claude-code' }),
    ],
    generatedAt: new Date().toISOString(),
    status: 'approved',
    runners: ['claude-code'],
    lastUpdated: new Date().toISOString(),
    conversationHistory: [
      { role: 'user', content: 'build it', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Plan generated with 3 tasks.', timestamp: '2026-01-01T00:00:01Z', kind: 'plan_generated' },
    ],
  };
}

describe('task_ops conversation turns', () => {
  it('applies valid ops, records a transcript entry, and broadcasts the plan', async () => {
    const broadcast = vi.fn();
    const session = makeSession({
      broadcast,
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn().mockResolvedValue({
          kind: 'task_ops',
          ops: [{ op: 'update', taskId: '#2', changes: { title: 'Build v2' } }],
          text: '{"taskOps":[...]}',
          researchLog: [],
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(planWithTasks(), 'build it', testWorkspace, { persist: false });

    const plan = await session.continueConversation('rename task 2 to Build v2');

    expect(session.planTasks.find((t) => t.id === 'b')!.title).toBe('Build v2');
    const last = plan.conversationHistory![plan.conversationHistory!.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.content).toContain('Updated "Build"');
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'planner_message' }));
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'plan_generated' }));
  });

  it('runs the mutatePlan ritual for an applied task_ops turn: persist strictly before broadcast', async () => {
    const order: string[] = [];
    // The turn's start and end mark the stream, not the plan: only what
    // carries plan state is bound to follow the persist.
    const broadcast = vi.fn((msg: SessionMessage) => { if (!msg.type.startsWith('planner_turn_')) order.push('broadcast'); });
    const session = makeSession({
      broadcast,
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn().mockResolvedValue({
          kind: 'task_ops',
          ops: [{ op: 'update', taskId: '#2', changes: { title: 'Build v2' } }],
          text: '', researchLog: [],
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(planWithTasks(), 'build it', testWorkspace, { persist: false });
    saves(session).mockClear();
    saves(session).mockImplementation(() => {
      order.push('persist');
      return { id: 'x', goal: '', runners: [], taskCount: 0, status: 'approved', createdAt: '', updatedAt: '' };
    });

    await session.continueConversation('rename task 2');

    expect(order[0]).toBe('persist');
    expect(order).toContain('broadcast');
  });

  it('feeds validation errors back and applies the corrected retry', async () => {
    const continueConversation = vi.fn()
      .mockResolvedValueOnce({
        kind: 'task_ops',
        ops: [{ op: 'update', taskId: 'a', changes: { dependencies: ['b'] } }], // cycle a->b->a
        text: '', researchLog: [],
      })
      .mockResolvedValueOnce({
        kind: 'task_ops',
        ops: [{ op: 'update', taskId: 'a', changes: { title: 'Setup v2' } }],
        text: '', researchLog: [],
      });
    const session = makeSession({
      aiService: {
        startConversation: vi.fn(),
        continueConversation,
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(planWithTasks(), 'g', testWorkspace, { persist: false });

    await session.continueConversation('tweak the plan');

    expect(continueConversation).toHaveBeenCalledTimes(2);
    expect(String(continueConversation.mock.calls[1][0])).toMatch(/rejected/);
    expect(session.planTasks[0].title).toBe('Setup v2');
    expect(session.planTasks[0].dependencies).toEqual([]);
  });

  // The type-coherence rule (TaskOps.test.ts, "type coherence on AI <-> MAN
  // flips") is a validation failure like any other: the planner never sees a
  // hard error, only the corrective prompt, and self-corrects within budget.
  it('feeds a type-coherence refusal back and applies the corrected retry', async () => {
    const continueConversation = vi.fn()
      .mockResolvedValueOnce({
        kind: 'task_ops',
        ops: [{ op: 'update', taskId: 'b', changes: { type: 'user' } }], // missing userSteps
        text: '', researchLog: [],
      })
      .mockResolvedValueOnce({
        kind: 'task_ops',
        ops: [{
          op: 'update', taskId: 'b',
          changes: { type: 'user', userSteps: [{ order: 1, instruction: 'ship it', completed: false }] },
        }],
        text: '', researchLog: [],
      });
    const session = makeSession({
      aiService: {
        startConversation: vi.fn(),
        continueConversation,
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(planWithTasks(), 'g', testWorkspace, { persist: false });

    await session.continueConversation('make the build step manual');

    expect(continueConversation).toHaveBeenCalledTimes(2);
    expect(String(continueConversation.mock.calls[1][0])).toMatch(/rejected/);
    const build = session.planTasks.find((t) => t.id === 'b')!;
    expect(build.type).toBe('user');
    expect(build.userSteps).toHaveLength(1);
  });

  it('gives up after retries and surfaces the errors with the plan untouched', async () => {
    const badTurn = {
      kind: 'task_ops',
      ops: [{ op: 'remove', taskId: 'nope' }],
      text: '', researchLog: [],
    };
    const continueConversation = vi.fn().mockResolvedValue(badTurn);
    const session = makeSession({
      aiService: {
        startConversation: vi.fn(),
        continueConversation,
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(planWithTasks(), 'g', testWorkspace, { persist: false });

    const plan = await session.continueConversation('remove something');

    // 1 initial + 2 retries
    expect(continueConversation).toHaveBeenCalledTimes(3);
    expect(session.planTasks).toHaveLength(2);
    const last = plan.conversationHistory![plan.conversationHistory!.length - 1];
    expect(last.content).toMatch(/invalid/i);
    expect(last.content).toContain('not found');
  });

  // First turn and later turns settle through the same path — a task_ops
  // emitted straight out of startPlanning gets the same corrective retries.
  it('retries an invalid first-turn task_ops from startPlanning', async () => {
    const startConversation = vi.fn(async () => ({
      kind: 'task_ops' as const,
      ops: [{ op: 'remove' as const, taskId: 'nope' }],
      text: '', researchLog: [],
    }));
    const continueConversation = vi.fn().mockResolvedValue({
      kind: 'message', text: 'sorry, which task?', researchLog: [],
    });
    const session = makeSession({
      aiService: {
        startConversation,
        continueConversation,
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });

    const plan = await session.startPlanning('goal', ['claude-code']);

    expect(continueConversation).toHaveBeenCalledTimes(1);
    expect(String(continueConversation.mock.calls[0][0])).toMatch(/rejected/);
    const last = plan.conversationHistory![plan.conversationHistory!.length - 1];
    expect(last.content).toBe('sorry, which task?');
  });

  it('applies edits immediately when the scheduler is armed but no runner is live', async () => {
    const session = makeSession({
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn().mockResolvedValue({
          kind: 'task_ops',
          ops: [{ op: 'update', taskId: '#3', changes: { title: 'Sign off with the team' } }],
          text: '', researchLog: [],
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(pausedRunPlan(), 'build it', testWorkspace, { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await session.execute({ command: 'stop_task', task: 'b' }, { kind: 'user' });

    // The scheduler is still armed, but nothing is executing — and it is the
    // live runner, not the armed flag, that decides whether a run is active.
    expect(session.isExecuting).toBe(false);

    const plan = await session.continueConversation('rename the sign-off step');

    expect(session.planTasks.find((t) => t.id === 'c')!.title).toBe('Sign off with the team');
    expect(plan.pendingTurns).toEqual([]);
  });

  // A paused run whose last live task was cancelled must be startable again:
  // otherwise the armed scheduler refuses every restart as "already
  // executing" and the plan is stuck with work left in it.
  it('lets a paused run start again after its last live task is cancelled', async () => {
    const spawned: string[] = [];
    const session = makeSession({
      runner: recordingRunner(spawned),
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn().mockResolvedValue({ kind: 'message', text: '', researchLog: [] }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(pausedRunPlan(), 'build it', testWorkspace, { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });

    expect(spawned).toEqual(['b']);
    await session.execute({ command: 'stop_task', task: 'b' }, { kind: 'user' });
    expect(session.isExecuting).toBe(false);

    await expect(session.execute({ command: 'run_plan' }, { kind: 'user' })).resolves.toMatchObject({ ok: true });
    // The stop held it: starting the plan again is not a retry.
    expect(spawned).toEqual(['b']);

    await expect(session.execute({ command: 'force_start', task: 'b' }, { kind: 'user' })).resolves.toMatchObject({ ok: true });
    expect(spawned).toEqual(['b', 'b']);
  });

  it('applies an edit to a task that is not running while another task is live', async () => {
    const spawned: string[] = [];
    const session = makeSession({
      runner: recordingRunner(spawned),
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn().mockResolvedValue({
          kind: 'task_ops',
          ops: [{ op: 'update', taskId: '#3', changes: { title: 'Sign off with the team' } }],
          text: '', researchLog: [],
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(pausedRunPlan(), 'build it', testWorkspace, { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' }); // spawns #2 and leaves it running

    const plan = await session.continueConversation('rename the sign-off step');

    // The edit never reaches the running #2, so it lands now; #2 keeps running.
    expect(session.planTasks.find((t) => t.id === 'c')!.title).toBe('Sign off with the team');
    expect(taskOf(session, 'b')!.status).toBe('in_progress');
    expect(spawned).toEqual(['b']);
    expect(plan.pendingTurns).toEqual([]);
  });

  // A running task is not the turn's to change: the edit is refused with a
  // note, nothing of it lands, and the run it was aimed at goes on as it was.
  it('refuses an edit that reaches the running task, and the run keeps going', async () => {
    const spawned: string[] = [];
    const continueConversation = vi.fn().mockResolvedValue({
      kind: 'task_ops',
      ops: [{ op: 'update', taskId: '#2', changes: { title: 'Build the backend' } }],
      text: '', researchLog: [],
    });
    const session = makeSession({
      runner: recordingRunner(spawned),
      aiService: { startConversation: vi.fn(), continueConversation, hasActiveConversation: () => true, reset: vi.fn() },
    });
    session.loadPlan(pausedRunPlan(), 'build it', testWorkspace, { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' }); // spawns #2 and leaves it running

    const plan = await session.continueConversation('rename the running step');

    expect(String(continueConversation.mock.calls[1][0])).toMatch(/"Build" is running and cannot be modified now: the user can stop it first/);
    expect(taskOf(session, 'b')!.title).toBe('Build');
    expect(taskOf(session, 'b')!.status).toBe('in_progress');
    expect(session.isExecuting).toBe(true);
    expect(session.status).toBe('running');
    expect(spawned).toEqual(['b']);
    const last = plan.conversationHistory![plan.conversationHistory!.length - 1];
    expect(last.content).toMatch(/The plan is unchanged/);
    expect(plan.pendingTurns).toEqual([]);
  });

  it('gives a planner-added task without an explicit model a valid, spawnable assignment', async () => {
    const modelResolver = {
      modelsForRunners: vi.fn().mockResolvedValue({
        'claude-code': [{ modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5', variants: [] }],
      }),
    } as unknown as Pick<ModelResolver, 'modelsForRunners'>;
    const session = makeSession({
      modelResolver,
      aiService: {
        startConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'ok, planning', researchLog: [] }),
        continueConversation: vi.fn().mockResolvedValue({
          kind: 'task_ops',
          ops: [{ op: 'add', task: { title: 'Docs', description: 'write docs', prompt: 'write the docs', dependencies: ['a'] } }],
          text: '', researchLog: [],
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    // Seeds modelsCache the way a live planning conversation would — loadPlan
    // alone (a bare resume) never calls the model resolver.
    await session.startPlanning('goal', ['claude-code']);
    session.loadPlan(planWithTasks(), 'build it', testWorkspace, { persist: false });

    await session.continueConversation('add a docs task after setup');

    const added = session.planTasks.find((t) => t.title === 'Docs')!;
    expect(added.assignedRunner).toBe('claude-code');
    expect(added.assignedModel!.modelId).toBe('claude-sonnet-4-5');
    expect(added.taskMode).toBeTruthy();
  });

  // The user asked for a change, not for every task the planner then adds:
  // an added task waits for their approval however ready it is (ADR-0035).
  // An Act supervisor's added task fans out instead (supervisorAct.test.ts).
  it('leaves a task the planner adds under an armed-but-idle scheduler waiting for the user\'s approval', async () => {
    const spawned: string[] = [];
    const session = makeSession({
      runner: recordingRunner(spawned),
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn().mockResolvedValue({
          kind: 'task_ops',
          ops: [{ op: 'add', task: { title: 'Docs', description: 'write docs', prompt: 'write the docs', dependencies: ['a'] } }],
          text: '', researchLog: [],
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(pausedRunPlan(), 'build it', testWorkspace, { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await session.execute({ command: 'stop_task', task: 'b' }, { kind: 'user' });

    await session.continueConversation('add a docs task after setup');

    const added = session.planTasks.find((t) => t.title === 'Docs')!;
    expect(spawned).not.toContain(added.id);
    expect(added.status).toBe('pending');
  });

  // Only Retry / Force Start / Run release a hold. An edit landing under an
  // armed scheduler must adopt the new tasks without also re-arming everything
  // the user pulled out of the schedule.
  it('leaves a cancelled task on hold when an edit lands under an armed scheduler', async () => {
    const spawned: string[] = [];
    const session = makeSession({
      runner: recordingRunner(spawned),
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn().mockResolvedValue({
          kind: 'task_ops',
          ops: [{ op: 'update', taskId: '#3', changes: { title: 'Sign off with the team' } }],
          text: '', researchLog: [],
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(pausedRunPlan(), 'build it', testWorkspace, { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await session.execute({ command: 'stop_task', task: 'b' }, { kind: 'user' });

    await session.continueConversation('rename the sign-off step');

    expect(spawned).toEqual(['b']); // the one pre-cancel spawn, not a second
  });

  it('does not promise the planner a queue when no runner is live', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'two left', researchLog: [] });
    const session = makeSession({
      runner: recordingRunner([]),
      aiService: {
        startConversation: vi.fn(),
        continueConversation,
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(pausedRunPlan(), 'build it', testWorkspace, { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await session.execute({ command: 'stop_task', task: 'b' }, { kind: 'user' });

    await session.continueConversation('what is left?');

    const outgoing = withoutFacts(String(continueConversation.mock.calls[0][0]));
    expect(outgoing).not.toMatch(/Execution is RUNNING/);
    expect(outgoing).not.toMatch(/queued/i);
  });

  it('names the locked in_progress tasks while a runner is live', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      runner: recordingRunner([]),
      aiService: {
        startConversation: vi.fn(),
        continueConversation,
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(pausedRunPlan(), 'build it', testWorkspace, { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });

    await session.continueConversation('what is left?');

    const outgoing = withoutFacts(String(continueConversation.mock.calls[0][0]));
    expect(outgoing).toMatch(/Execution is RUNNING — these tasks are locked: #2/);
    expect(outgoing).toMatch(/No new task starts until your reply ends/);
    expect(outgoing).not.toMatch(/queued/i);
  });

  // Before batch handles, this needed two turns: add the prerequisite, wait
  // for the plan to re-settle, then send a second edit naming its real id.
  it('applies a compound add-and-depend edit — handle referenced by a later op — in a single turn', async () => {
    const session = makeSession({
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn().mockResolvedValue({
          kind: 'task_ops',
          ops: [
            { op: 'add', task: { title: 'Prereq', description: 'd', prompt: 'p' }, handle: 'h1' },
            { op: 'add', task: { title: 'Followup', description: 'd', prompt: 'p', dependencies: ['h1'] } },
          ],
          text: '', researchLog: [],
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(planWithTasks(), 'build it', testWorkspace, { persist: false });

    await session.continueConversation('add a prerequisite and a followup that depends on it');

    const prereq = session.planTasks.find((t) => t.title === 'Prereq')!;
    const followup = session.planTasks.find((t) => t.title === 'Followup')!;
    expect(followup.dependencies).toEqual([prereq.id]);
  });

  // A rewire used to be refused with "move the dependency earlier", and the
  // only cure was a reorder op listing every task in the plan.
  it('lands a dependency rewire on its own, repairing the display order', async () => {
    const plan = planWithTasks();
    plan.tasks = [
      createTask({ id: 'a', order: 1, title: 'Setup', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 2, title: 'Build', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'c', order: 3, title: 'Docs', prompt: 'p', assignedRunner: 'claude-code' }),
    ];
    const session = makeSession({
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn().mockResolvedValue({
          kind: 'task_ops',
          ops: [{ op: 'update', taskId: '#1', changes: { dependencies: ['#3'] } }],
          text: '', researchLog: [],
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(plan, 'build it', testWorkspace, { persist: false });

    const settled = await session.continueConversation('Setup should wait for Docs');

    expect(session.planTasks.map((t) => t.title)).toEqual(['Build', 'Docs', 'Setup']);
    expect(session.planTasks.map((t) => t.order)).toEqual([1, 2, 3]);
    expect(taskOf(session, 'a')!.dependencies).toEqual(['c']);
    const last = settled.conversationHistory![settled.conversationHistory!.length - 1];
    expect(last.content).toContain('Reordered to keep dependencies first');
  });

  // The refusal reaches the planner as a corrective, not a hard failure — the
  // same repair loop every other invalid op goes through (TaskOps.test.ts,
  // "model and task-mode validity" covers the applier's own rule matrix).
  it('refuses a hallucinated model and applies the corrected retry once the planner names a real one', async () => {
    const continueConversation = vi.fn()
      .mockResolvedValueOnce({
        kind: 'task_ops',
        ops: [{ op: 'update', taskId: 'a', changes: { assignedModel: { modelId: 'gpt-9-imaginary', modelLabel: 'GPT-9' } } }],
        text: '', researchLog: [],
      })
      .mockResolvedValueOnce({
        kind: 'task_ops',
        ops: [{ op: 'update', taskId: 'a', changes: { assignedModel: { modelId: 'claude-haiku-4-5', modelLabel: 'Claude Haiku 4.5' } } }],
        text: '', researchLog: [],
      });
    const modelResolver = {
      modelsForRunners: vi.fn().mockResolvedValue({
        'claude-code': [
          { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5', variants: [] },
          { modelId: 'claude-haiku-4-5', modelLabel: 'Claude Haiku 4.5', variants: [] },
        ],
      }),
    } as unknown as Pick<ModelResolver, 'modelsForRunners'>;
    const session = makeSession({
      modelResolver,
      aiService: {
        startConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'ok, planning', researchLog: [] }),
        continueConversation,
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    await session.startPlanning('goal', ['claude-code']);
    session.loadPlan(planWithTasks(), 'build it', testWorkspace, { persist: false });

    await session.continueConversation('assign a stronger model to setup');

    expect(continueConversation).toHaveBeenCalledTimes(2);
    expect(String(continueConversation.mock.calls[1][0])).toMatch(/rejected/);
    expect(String(continueConversation.mock.calls[1][0])).toContain('claude-code');
    expect(session.planTasks.find((t) => t.id === 'a')!.assignedModel?.modelId).toBe('claude-haiku-4-5');
  });

  it('injects the current plan context into the outgoing message but not the transcript', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'two tasks so far', researchLog: [] });
    const session = makeSession({
      aiService: {
        startConversation: vi.fn(),
        continueConversation,
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(planWithTasks(), 'g', testWorkspace, { persist: false });

    const plan = await session.continueConversation('how many tasks are there?');

    const outgoing = String(continueConversation.mock.calls[0][0]);
    expect(outgoing).toContain('<current_plan>');
    expect(outgoing).toContain('taskOps');
    expect(outgoing).toContain('how many tasks are there?');
    const userEntries = plan.conversationHistory!.filter((m) => m.role === 'user');
    expect(userEntries[userEntries.length - 1].content).toBe('how many tasks are there?');
  });

  it('lists subtasks in the plan block under their dotted labels', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: { startConversation: vi.fn(), continueConversation, hasActiveConversation: () => true, reset: vi.fn() },
    });
    const plan = planWithTasks();
    plan.tasks[1].subtasks = [
      createTask({ id: 'b1', order: 1, title: 'Compile', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'b2', order: 2, title: 'Bundle', prompt: 'p', dependencies: ['b1'], assignedRunner: 'claude-code' }),
    ];
    session.loadPlan(plan, 'g', testWorkspace, { persist: false });

    await session.continueConversation('what is there?');

    const outgoing = String(continueConversation.mock.calls[0][0]);
    expect(outgoing).toMatch(/^#2 id=b "Build"/m);
    expect(outgoing).toMatch(/^ {2}#2\.1 id=b1 "Compile"/m);
    expect(outgoing).toMatch(/^ {2}#2\.2 id=b2 "Bundle" .*deps:\[#2\.1\]/m);
  });
});

/** A plan where 'a' failed and its dependent 'b' waits behind it. */
function failedRunPlan(): LegacyPlanState {
  return {
    tasks: [
      createTask({ id: 'a', order: 1, title: 'Setup', prompt: 'old prompt', status: 'failed', assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 2, title: 'Build', prompt: 'p', dependencies: ['a'], assignedRunner: 'claude-code' }),
    ],
    generatedAt: new Date().toISOString(),
    status: 'approved',
    runners: ['claude-code'],
    lastUpdated: new Date().toISOString(),
    conversationHistory: [
      { role: 'user', content: 'build it', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Plan generated with 2 tasks.', timestamp: '2026-01-01T00:00:01Z', kind: 'plan_generated' },
    ],
  };
}

describe('a plan saved with a stored blocked task', () => {
  it('loads it as pending and runs it once its dependency is done', async () => {
    const spawned: string[] = [];
    const session = makeSession({ runner: recordingRunner(spawned) });
    const plan: LegacyPlanState = {
      ...failedRunPlan(),
      tasks: [
        createTask({ id: 'a', order: 1, title: 'Setup', prompt: 'p', status: 'completed', assignedRunner: 'claude-code' }),
        { ...createTask({ id: 'b', order: 2, title: 'Build', prompt: 'p', dependencies: ['a'], assignedRunner: 'claude-code' }), status: 'blocked' } as never,
      ],
    };

    session.loadPlan(plan, 'build it', testWorkspace, { persist: false });
    expect(taskOf(session, 'b')!.status).toBe('pending');

    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    expect(spawned).toContain('b');
  });
});

describe('rearm — task_ops conversation turn', () => {
  it('reaches the orchestrator during a live run without waking a cancelled/held task', async () => {
    const spawned: string[] = [];
    const session = makeSession({
      runner: recordingRunner(spawned),
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn().mockResolvedValue({
          kind: 'task_ops',
          ops: [{ op: 'rearm', taskId: 'a' }],
          text: '', researchLog: [],
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(pausedRunPlan(), 'build it', testWorkspace, { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await session.execute({ command: 'stop_task', task: 'b' }, { kind: 'user' });

    await session.continueConversation('re-arm task a');

    // The scheduler is still live, so the freshly re-armed 'a' is picked straight
    // back up — but the cancelled 'b' stays held, not re-spawned alongside it.
    expect(session.planTasks.find((t) => t.id === 'a')!.status).toBe('in_progress');
    expect(spawned).toEqual(['b', 'a']);
  });


  it('re-arms a failed task with a corrected prompt and releases its blocked dependent', async () => {
    const session = makeSession({
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn().mockResolvedValue({
          kind: 'task_ops',
          ops: [{ op: 'rearm', taskId: 'a', changes: { prompt: 'corrected prompt' } }],
          text: '{"taskOps":[...]}',
          researchLog: [],
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(failedRunPlan(), 'build it', testWorkspace, { persist: false });

    const plan = await session.continueConversation('fix task a and try again');

    const rearmed = session.planTasks.find((t) => t.id === 'a')!;
    // resetForRun() flips every non-completed AI task to 'approved' as part of
    // committing the edit — the task_ops path always re-arms into a runnable plan.
    expect(rearmed.status).toBe('approved');
    expect(rearmed.prompt).toBe('corrected prompt');
    expect(rearmed.verdict).toBeUndefined();
    expect(session.planTasks.find((t) => t.id === 'b')!.status).toBe('approved');
    const last = plan.conversationHistory![plan.conversationHistory!.length - 1];
    expect(last.content).toContain('Re-armed "Setup"');
  });

  it('refuses to re-arm a running task through the conversation loop, leaving the plan untouched', async () => {
    const continueConversation = vi.fn().mockResolvedValue({
      kind: 'task_ops',
      ops: [{ op: 'rearm', taskId: 'a' }],
      text: '{"taskOps":[...]}',
      researchLog: [],
    });
    const session = makeSession({
      aiService: {
        startConversation: vi.fn(),
        continueConversation,
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(failedRunPlan(), 'build it', testWorkspace, { persist: false });
    await session.execute({ command: 'force_start', task: 'a' }, { kind: 'user' });

    const result = await session.continueConversation('fix task a and try again');

    expect(session.planTasks.find((t) => t.id === 'a')!.status).toBe('in_progress');
    const last = result.conversationHistory![result.conversationHistory!.length - 1];
    expect(last.content).toMatch(/running/i);
  });
});
