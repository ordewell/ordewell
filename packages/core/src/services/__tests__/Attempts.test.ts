import { describe, expect, it, vi } from 'vitest';
import { createTask, type Task } from '../../models/Task';
import { PlanStore } from '../PlanStore';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { SkillsService } from '../SkillsService';
import { Attempts, type AttemptEnded, type AttemptsDeps, type AttemptsHost } from '../Attempts';
import { TaskControlError } from '../TaskControlError';
import { McpAttachError, McpAttachTimeout, RunnerStartupExit } from '../harness/ordewellBinding';
import { TaskSkillsError } from '../taskSkills';
import type { LandingOutcome } from '../Landing';
import type { IsolationRunController } from '../IsolationRunController';
import { LocalWorktreeLease } from '../LocalWorktreeLease';
import { SlotPool } from '../SlotPool';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';
import { fakeConfig, FakeRunnerSession } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { recordedRunnerAuth, resetRunnerAuth } from '../runnerAuth';

const LIMIT = "You've hit your session limit · resets 8:10pm (UTC)";
const admitted = { current: () => true };

type Spawn = (opts: RunnerSpawnOptions) => Promise<IRunnerSession>;

/**
 * Attempts on their own: a real plan store and output buffer, a runner that
 * hands out {@link FakeRunnerSession}s, and a host that records every ending
 * it is told of instead of scheduling anything.
 */
function setup(opts: { tasks?: Task[]; runners?: string[]; spawn?: Spawn; repairs?: string[]; landPassed?: () => Promise<LandingOutcome>; settle?: (ended: AttemptEnded) => Promise<void> } = {}) {
  const store = new PlanStore();
  store.load(opts.tasks ?? [createTask({ id: 't1', order: 1, title: 'One', prompt: 'Do it' })], opts.runners ?? ['claude-code']);
  const sessions: FakeRunnerSession[] = [];
  const spawn: Spawn = opts.spawn ?? (async (o) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, o.taskId, `native-${o.taskId}`);
    sessions.push(session);
    return session;
  });
  const runner = { spawn: vi.fn(spawn), stop: vi.fn(async () => undefined), stopAll: vi.fn(), activeCount: 0 } satisfies IRunner;
  const ended: AttemptEnded[] = [];
  const events: string[] = [];
  const told: string[] = [];
  const settle = opts.settle ?? (async () => undefined);
  const host: AttemptsHost = {
    settle: async (outcome) => {
      ended.push(outcome);
      await settle(outcome);
    },
    completing: () => false,
    retried: () => false,
    previousRound: () => undefined,
    emit: (event, ..._args) => { events.push(event); },
    tell: (_level, message) => { told.push(message); },
    unawaited: (work) => { void work.catch(() => undefined); },
  };
  const repairs = new Set(opts.repairs ?? []);
  const runs: AttemptsDeps['runs'] & Pick<IsolationRunController, 'attemptCwd' | 'workspaceCwd' | 'release'> = {
    attemptCwd: async () => ({ cwd: '/repo/.ordewell/worktrees/t1', worktree: true }),
    workspaceCwd: async () => ({ cwd: '/repo', worktree: false }),
    snapshotWorkspace: async () => null,
    filesChangedSince: async () => [],
    release: vi.fn(async () => undefined),
    openRecord: () => undefined,
    skillLayout: () => ({ repos: [], worktrees: false }),
    current: null,
    epoch: 1,
  };
  const landing: AttemptsDeps['landing'] = {
    nextRepair: (taskId) => (repairs.has(taskId) ? { n: 1, limit: 2 } : null),
    landPassed: vi.fn(opts.landPassed ?? (async (): Promise<LandingOutcome> => ({ kind: 'nothing-to-land', messages: [] }))),
    settleRepair: vi.fn(async (): Promise<LandingOutcome> => ({ kind: 'landed', messages: [] })),
    repairPrompt: () => 'Repair the conflict.',
  };
  const notifications = fakeNotification();
  const leases = new LocalWorktreeLease({ pool: new SlotPool(() => Infinity), node: { tick: async () => undefined, openTurn: () => undefined, waitsOnPlanner: () => false, limitFound: () => undefined }, runs, workspaceRoot: () => '/repo' });
  const leaseOf = () => {
    const reserved = leases.reserve({ node: { sessionId: 's' }, role: 'task' });
    if ('refused' in reserved) throw new Error(reserved.refused);
    return reserved.lease;
  };
  const attempts = new Attempts({
    config: fakeConfig(),
    notifications,
    runner,
    scriptRunner: runner,
    childPlanRunner: runner,
    autonomous: () => false,
    store,
    output: new BufferedTaskOutputSource(),
    runs,
    leases,
    landing,
    registry: null,
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
    skillsAt: (roots) => new SkillsService(roots),
    previousAttemptFromLog: () => null,
    previousHandoffFromLog: () => undefined,
    lastLoggedAttempt: () => 0,
    recordHandoff: vi.fn(),
    taskLog: { attempts: () => [], events: () => [] },
    host,
  });
  const start = (taskId = 't1', claim: Partial<Parameters<Attempts['start']>[1]> = {}) => attempts.start(store.get(taskId)!, { admission: admitted, lease: leaseOf(), ...claim });
  return { attempts, store, runner, runs, landing, sessions, ended, events, told, notifications, start, task: (id = 't1') => store.get(id)! };
}

describe('Attempts: a claim', () => {
  it('marks a task attempted before it is in progress, so a chat known to exist needs no output or usage yet', async () => {
    const env = setup();
    const spawned = env.start();
    expect(env.task().attempted).toBe(true);
    expect(env.task().attemptUsage?.length).toBe(1);
    await spawned;
  });

  it('marks a script task attempted though its ledger counts nothing', async () => {
    const env = setup({ tasks: [createTask({ id: 't1', order: 1, title: 'One', type: 'script', script: 'echo hi' })] });
    await env.start();
    expect(env.task().attempted).toBe(true);
    expect(env.task().attemptUsage).toBeUndefined();
  });

  it('is live, numbered past every attempt the task has run and in progress before its spawn settles', async () => {
    const env = setup({ tasks: [createTask({ id: 't1', order: 1, title: 'One', prompt: 'Do it', attemptUsage: [{ attempt: 2, runner: 'claude-code', startedAt: '2026-10-01T00:00:00Z', wallTimeMs: 0, totals: {}, byModel: [] }] })] });

    const spawned = env.start();

    expect(env.attempts.has('t1')).toBe(true);
    expect(env.attempts.snapshot('t1')).toMatchObject({ attempt: 3, phase: 'starting', sessionId: null, runner: 'claude-code' });
    expect(env.task().status).toBe('in_progress');
    await spawned;
    expect(env.attempts.snapshot('t1')).toMatchObject({ phase: 'running', sessionId: 's1', cwd: '/repo/.ordewell/worktrees/t1' });
    expect(env.attempts.sessionMap()).toEqual(new Map([['t1', 's1']]));
    expect(env.runner.spawn).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't1', attempt: 3, cwd: '/repo/.ordewell/worktrees/t1' }));
    expect(env.notifications.info).toHaveBeenCalledWith('Task "One" started (claude-code)');
  });
});

describe('Attempts: a verdict is reported, never applied', () => {
  it('reports a done call as passed, the verdict and handoff on the task and its runner stopped', async () => {
    const env = setup();
    await env.start();

    env.sessions[0].reportComplete({ status: 'done', summary: 'Did it.' });

    await vi.waitFor(() => expect(env.ended).toHaveLength(1));
    expect(env.ended[0]).toMatchObject({ kind: 'passed', task: { id: 't1' }, attempt: { taskId: 't1', worktree: true }, landing: { kind: 'nothing-to-land' } });
    expect(env.attempts.has('t1')).toBe(false);
    expect(env.task().verdict?.outcome).toBe('pass');
    expect(env.task().handoff?.summary).toBe('Did it.');
    expect(env.task().runnerSessionId).toBe('native-t1');
    expect(env.runner.stop).toHaveBeenCalledWith('s1');
    // Marking the task is the scheduler's, which this host is not.
    expect(env.task().status).toBe('in_progress');
  });

  it('reports a blocked call as failed, with the runner\'s reason', async () => {
    const env = setup();
    await env.start();

    env.sessions[0].reportComplete({ status: 'blocked', summary: '', reason: 'no access to the registry' });

    await vi.waitFor(() => expect(env.ended).toHaveLength(1));
    expect(env.ended[0]).toMatchObject({ kind: 'failed', unresumed: null, verdict: { outcome: 'fail', reason: 'The runner reported the task blocked: no access to the registry' } });
    expect(env.landing.landPassed).not.toHaveBeenCalled();
  });

  it('reports a runner that exits mid-turn on its usage limit as a pause, with no verdict', async () => {
    const env = setup();
    await env.start();

    env.sessions[0].emitOutput(`Working…\n${LIMIT}\n`);
    env.sessions[0].emitExit(1);

    await vi.waitFor(() => expect(env.ended).toHaveLength(1));
    expect(env.ended[0]).toMatchObject({ kind: 'usage-limited', taskId: 't1', attempt: { runner: 'claude-code' } });
    expect(env.task().verdict).toBeUndefined();
  });

  it('reports a conflict repair as repaired, keeping the verdict the task\'s own work earned', async () => {
    const env = setup({ repairs: ['t1'] });
    await env.start();
    expect(env.attempts.snapshot('t1')?.cwd).toBe('/repo/.ordewell/worktrees/t1');

    env.sessions[0].reportComplete({ status: 'done', summary: 'Resolved it.' });

    await vi.waitFor(() => expect(env.ended).toHaveLength(1));
    expect(env.ended[0]).toMatchObject({ kind: 'repaired', landing: { kind: 'landed' }, attempt: { kind: { kind: 'repair' } } });
    expect(env.task().verdict).toBeUndefined();
  });

  it('keeps a report\'s receipt through its landing, with no verdict on the task until the attempt ends', async () => {
    let land!: (outcome: LandingOutcome) => void;
    const env = setup({ landPassed: () => new Promise((resolve) => { land = resolve; }) });
    await env.start();

    env.sessions[0].emitEvent({ type: 'completion_received', status: 'done' });
    expect(env.attempts.receipt('t1')).toBe('done');
    env.sessions[0].reportComplete({ status: 'done', summary: 'Did it.' });
    await vi.waitFor(() => expect(env.landing.landPassed).toHaveBeenCalled());

    expect(env.attempts.receipt('t1')).toBe('done');
    expect(env.task().verdict).toBeUndefined();
    expect(env.ended).toEqual([]);

    land({ kind: 'nothing-to-land', messages: [] });
    await vi.waitFor(() => expect(env.ended).toHaveLength(1));
    expect(env.attempts.receipt('t1')).toBeNull();
  });

  it('shows only the current attempt\'s receipt, whatever an earlier runner still says', async () => {
    const env = setup();
    await env.start();
    env.attempts.end('t1', 'retry');
    await env.start();
    const [earlier, current] = env.sessions;

    earlier.emitEvent({ type: 'completion_received', status: 'done' });
    expect(env.attempts.receipt('t1')).toBeNull();

    current.emitEvent({ type: 'completion_received', status: 'failed' });
    earlier.emitEvent({ type: 'turn_start', text: 'late' });
    expect(env.attempts.receipt('t1')).toBe('failed');
  });

  it('drops a verdict that arrives once its attempt has ended', async () => {
    const env = setup();
    await env.start();
    env.attempts.end('t1', 'cancel');

    env.sessions[0].reportComplete({ status: 'done', summary: 'Too late.' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(env.ended).toEqual([]);
    expect(env.task().verdict).toBeUndefined();
  });

  it('ends an attempt whose landing threw and reports it unsettled', async () => {
    const env = setup({ landPassed: async () => { throw new Error('the merge queue broke'); } });
    await env.start();

    env.sessions[0].reportComplete({ status: 'done', summary: 'Did it.' });

    await vi.waitFor(() => expect(env.ended).toHaveLength(1));
    expect(env.ended[0]).toMatchObject({ kind: 'unsettled', taskId: 't1', attempt: { taskId: 't1' }, reason: 'the merge queue broke' });
    expect(env.attempts.has('t1')).toBe(false);
  });

  it('reports what follows a verdict throwing as unsettled, with nothing left to end', async () => {
    const env = setup({ settle: async (ended) => { if (ended.kind === 'passed') throw new Error('the tick broke'); } });
    await env.start();

    env.sessions[0].reportComplete({ status: 'done', summary: 'Did it.' });

    await vi.waitFor(() => expect(env.ended.map((e) => e.kind)).toEqual(['passed', 'unsettled']));
    expect(env.ended[1]).toMatchObject({ attempt: null, reason: 'the tick broke' });
  });
});

describe('Attempts: a runner that is not signed in', () => {
  const CURSOR = 'Cursor is not signed in. Sign in with /login cursor-agent, or run cursor-agent login.';
  const CLAUDE = 'Claude Code is not signed in. Sign in with /login claude-code, or run claude auth login.';
  const cursorTask = () => [createTask({ id: 't1', order: 1, title: 'One', prompt: 'Do it', assignedRunner: 'cursor-agent' })];

  it('holds a start the agent refused with the way to sign in, and flags the agent signed out', async () => {
    resetRunnerAuth();
    const env = setup({ tasks: cursorTask(), runners: ['cursor-agent'], spawn: async () => { throw new Error(CURSOR); } });

    await env.start();

    expect(env.ended[0]).toMatchObject({
      kind: 'spawn-failed',
      failure: { leaves: 'held', hold: `${CURSOR} Then start it again.`, notice: { level: 'error', text: `Failed to start task "One": ${CURSOR}` } },
    });
    expect(recordedRunnerAuth('cursor-agent', '/repo')?.state).toBe('signed-out');
  });

  it('puts the way to sign in before a startup exit that only said "not logged in"', async () => {
    resetRunnerAuth();
    const env = setup({ spawn: async () => { throw new RunnerStartupExit('Not logged in · Please run /login'); } });

    await env.start();

    expect(env.ended[0]).toMatchObject({
      kind: 'spawn-failed',
      failure: { leaves: 'failed', summary: { reviewReason: `${CLAUDE}\n\nNot logged in · Please run /login` }, notice: { text: `${CLAUDE}\n\nNot logged in · Please run /login` } },
    });
    expect(recordedRunnerAuth('claude-code', '/repo')?.state).toBe('signed-out');
  });

  it('names the way to sign in when the runner exits on its login', async () => {
    resetRunnerAuth();
    const env = setup();
    await env.start();

    env.sessions[0].emitOutput('Not logged in · Please run /login\n');
    env.sessions[0].emitExit(1);

    await vi.waitFor(() => expect(env.ended).toHaveLength(1));
    expect(env.ended[0]).toMatchObject({ kind: 'failed', signedOut: CLAUDE });
    expect(env.task().outputSummary?.reviewReason).toMatch(new RegExp(`^${CLAUDE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(recordedRunnerAuth('claude-code', '/repo')?.state).toBe('signed-out');
  });

  it('reads no login wall into a task that failed for another reason', async () => {
    resetRunnerAuth();
    const env = setup();
    await env.start();

    env.sessions[0].emitOutput('The tests are red.\n');
    env.sessions[0].emitExit(1);

    await vi.waitFor(() => expect(env.ended).toHaveLength(1));
    expect(env.ended[0]).toMatchObject({ kind: 'failed', signedOut: null });
    expect(recordedRunnerAuth('claude-code', '/repo')).toBeUndefined();
  });
});

describe('Attempts: a spawn that fails is one report', () => {
  const failures: [string, unknown, object][] = [
    ['an error nothing else names', new Error('boom'), { leaves: 'held', hold: 'could not start: boom; start it again', settles: false, notice: { level: 'error', text: 'Failed to start task "One": Error: boom' } }],
    ['a runner that never connected', new McpAttachTimeout('never connected'), { leaves: 'held', settles: true, notice: { level: 'warn' } }],
    ['a runner that reported the server failed', new McpAttachError('the ordewell server failed'), { leaves: 'failed', keepWorktree: true, notice: { level: 'error', text: 'the ordewell server failed' } }],
    ['a skill the plan names that is missing', new TaskSkillsError('Skill "deploy" was not found'), { leaves: 'failed', keepWorktree: false, summary: { reviewReason: 'Skill "deploy" was not found' } }],
  ];

  it.each(failures)('%s', async (_name, error, failure) => {
    const env = setup({ spawn: async () => { throw error; } });

    await env.start();

    expect(env.ended).toHaveLength(1);
    expect(env.ended[0]).toMatchObject({ kind: 'spawn-failed', task: { id: 't1' }, failure });
    expect(env.attempts.has('t1')).toBe(false);
    // How the task is left is the scheduler's to apply.
    expect(env.task().status).toBe('in_progress');
  });

  it('reports a start the usage limit refused as a pause', async () => {
    const env = setup({ spawn: async () => { throw new Error(LIMIT); } });

    await env.start();

    expect(env.ended).toEqual([expect.objectContaining({ kind: 'usage-limited', said: { message: LIMIT }, output: '' })]);
  });

  it('fails a continue whose runner refused its saved session, and forgets that session', async () => {
    const env = setup({
      tasks: [{ ...createTask({ id: 't1', order: 1, title: 'One', prompt: 'Do it' }), runnerSessionId: 'native-old' }],
      spawn: async () => { throw new RunnerStartupExit('No conversation found'); },
    });

    await env.start('t1', { continuation: { message: 'Go on', resumeSessionId: 'native-old' } });

    expect(env.ended).toEqual([expect.objectContaining({
      kind: 'spawn-failed',
      failure: expect.objectContaining({ leaves: 'failed', keepWorktree: false, notice: { level: 'error', toastOnly: true, text: 'Could not continue task "One": claude-code could not find its saved session. Retry starts it afresh.' } }),
    })]);
    expect(env.task().runnerSessionId).toBeUndefined();
  });

  it('leaves a repair that could not start to its conflict', async () => {
    const env = setup({ repairs: ['t1'], spawn: async () => { throw new Error('boom'); } });

    await env.start();

    expect(env.ended).toEqual([expect.objectContaining({ kind: 'spawn-failed', failure: { leaves: 'conflict', why: 'could not start: boom' } })]);
  });

  it('kills the session of an attempt ended while it spawned, takes back its claim and reports nothing', async () => {
    let hand: (session: IRunnerSession) => void = () => undefined;
    const env = setup({ spawn: () => new Promise((resolve) => { hand = resolve; }) });
    const spawned = env.start();
    await vi.waitFor(() => expect(env.runner.spawn).toHaveBeenCalled());

    env.attempts.end('t1', 'cancel');
    const late = new FakeRunnerSession('s-late', 't1');
    hand(late);
    await spawned;

    expect(late.killed).toBe(true);
    expect(env.ended).toEqual([]);
    expect(env.task().status).toBe('pending');
  });
});

describe('Attempts: a turn', () => {
  it('that fails on the usage limit ends the attempt as a pause, with the runner\'s own error', async () => {
    const env = setup();
    await env.start();
    const failure = { message: LIMIT, usageLimit: { resetsAt: '2026-10-11T20:10:00Z' } };

    env.sessions[0].emitEvent({ type: 'error', ...failure });
    env.sessions[0].emitTurnEnd('failed');

    await vi.waitFor(() => expect(env.ended).toHaveLength(1));
    expect(env.ended[0]).toMatchObject({ kind: 'usage-limited', said: failure });
    expect(env.attempts.has('t1')).toBe(false);
  });

  it('that ends without task_complete gets the completion reminder once, then waits for input', async () => {
    const env = setup();
    await env.start();

    env.sessions[0].emitTurnEnd('completed');
    expect(env.sessions[0].fromOrdewell).toHaveLength(1);
    expect(env.task().status).toBe('in_progress');

    env.sessions[0].emitTurnEnd('completed');
    expect(env.task()).toMatchObject({ status: 'awaiting_user', awaitingReason: 'input' });
    expect(env.events).toContain('onTaskSettled');
    expect(env.ended).toEqual([]);
  });

  it('takes a message only while it runs, and a waiting task is back at work once it does', async () => {
    const env = setup();
    expect(() => env.attempts.message('t1', 'hello', 'message', (s, m) => s.sendMessage(m))).toThrow(TaskControlError);
    await env.start();
    env.sessions[0].emitTurnEnd('completed');
    env.sessions[0].emitTurnEnd('completed');

    env.attempts.message('t1', 'Use the staging account.', 'message', (s, m) => s.sendMessage(m));

    expect(env.sessions[0].delivered.at(-1)).toBe('Use the staging account.');
    expect(env.task().status).toBe('in_progress');
  });
});

describe('Attempts: ending all of them', () => {
  it('stops every runner on a Stop, and hands back what each attempt was', async () => {
    const env = setup({ tasks: [createTask({ id: 't1', order: 1, title: 'One', prompt: 'a' }), createTask({ id: 't2', order: 2, title: 'Two', prompt: 'b' })] });
    await Promise.all([env.start('t1'), env.start('t2')]);

    const ended = env.attempts.stopAll();

    expect(ended.map((a) => a.taskId)).toEqual(['t1', 't2']);
    expect(env.attempts.size).toBe(0);
    expect(env.runner.stop).toHaveBeenCalledWith('s1');
    expect(env.runner.stop).toHaveBeenCalledWith('s2');
    expect(env.runner.stopAll).toHaveBeenCalled();
    expect(env.ended).toEqual([]);
  });

  it('closes the plan\'s scope on a load, so a runner still winding down counts into nothing', async () => {
    const env = setup();
    await env.start();
    env.sessions[0].emitEvent({ type: 'usage', record: { source: 'claude-code', inputTokens: 10 } });
    const counted = structuredClone(env.task().attemptUsage);
    expect(env.events).toContain('onUsageChanged');
    env.events.length = 0;

    env.attempts.unload();
    env.sessions[0].emitEvent({ type: 'usage', record: { source: 'claude-code', inputTokens: 999 } });
    env.sessions[0].emitExit(0);

    expect(env.attempts.size).toBe(0);
    expect(env.task().attemptUsage?.[0].totals).toEqual(counted?.[0].totals);
    expect(env.events).not.toContain('onUsageChanged');
    expect(env.ended).toEqual([]);
  });
});
