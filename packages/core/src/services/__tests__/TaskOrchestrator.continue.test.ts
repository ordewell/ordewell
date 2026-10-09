import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator, TaskControlError } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { serializeTaskStatus } from '../SessionMessage';
import { continuability } from '../continuation';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeStructuredSession, FakeTerminalSession, FakeWorktreeIsolation } from '../../testing';
import { fakeNotification, makeSession, saves } from './sessionTestKit';
import type { LegacyPlanState } from '../../models/Task';
import type { ITerminalRunner, ITerminalSession } from '../../interfaces/ITerminalRunner';
import type { IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import type { RunnerSpawnOptions } from '../AbstractRunner';

/**
 * A router's view of spawning: a structured Claude Code session for a
 * structured request, a terminal one otherwise. `resumes` says what a resumed
 * spawn's runner announces — the session it took up, or null for one it could
 * not find.
 */
function routingRunner(opts: { resumes?: (id: string) => string | null } = {}) {
  const sessions: FakeTerminalSession[] = [];
  const requests: RunnerSpawnOptions[] = [];
  const runner = {
    spawn: vi.fn(async (o: RunnerSpawnOptions): Promise<ITerminalSession> => {
      requests.push(o);
      const id = `s${sessions.length + 1}`;
      const native = o.resumeSessionId ? (opts.resumes ?? ((resumed) => resumed))(o.resumeSessionId) : `native-${o.taskId}-${sessions.length + 1}`;
      const session = o.transport === 'structured' && o.runner === 'claude-code'
        ? new FakeStructuredSession(id, o.taskId, native)
        : new FakeTerminalSession(id, o.taskId);
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies ITerminalRunner;
  return { runner, sessions, requests };
}

function setup(opts: { runner?: ITerminalRunner; isolation?: IWorktreeIsolation; resumes?: (id: string) => string | null } = {}) {
  const routed = routingRunner({ resumes: opts.resumes });
  const notifications = fakeNotification();
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ worktreeIsolation: opts.isolation !== undefined }),
    notifications,
    terminalRunner: opts.runner ?? routed.runner,
    output: new BufferedTaskOutputSource({ transcripts: { finalAssistantText: async () => null } }),
    registry: new RunnerRegistry(),
    isolation: opts.isolation,
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
  });
  const task = (id: string) => orchestrator.storeInstance.get(id)!;
  return { orchestrator, notifications, task, ...routed };
}

// Spread over `createTask`, which drops the fields only a run sets (transport, awaiting reason).
const plan = (overrides: Partial<Task> = {}): Task => ({
  ...createTask({ id: 't1', order: 1, title: 'Parse JSON', prompt: 'ORIGINAL PROMPT BODY', completionMarker: 'mk-1' }),
  ...overrides,
});

/** Run t1 to a pass on the structured transport, leaving its session id saved. */
async function completedStructured(h: ReturnType<typeof setup>): Promise<void> {
  await h.orchestrator.forceStartTask('t1');
  h.sessions[0].emitOutput('Parsed objects.\n<<<ORDEWELL_DONE_mk-1>>>\n');
  await vi.waitFor(() => expect(h.task('t1').status).toBe('completed'));
}

describe('which tasks can be continued (ADR-0018, K1)', () => {
  const structured = { kind: 'structured' as const, nativeSessionId: 'sess-1' };

  it('a completed or failed task that ran structured and saved its session', () => {
    expect(continuability(plan({ status: 'completed', transport: structured }))).toEqual({ ok: true, sessionId: 'sess-1' });
    expect(continuability(plan({ status: 'failed', transport: structured }))).toEqual({ ok: true, sessionId: 'sess-1' });
  });

  it('not a conflict, which its repair resolves', () => {
    const verdict = continuability(plan({ status: 'awaiting_user', awaitingReason: 'conflict', transport: structured }));
    expect(verdict).toEqual({ ok: false, reason: expect.stringContaining('merge conflict') });
  });

  it('not a task that ran in a terminal, nor one with no saved session', () => {
    expect(continuability(plan({ status: 'completed' }))).toEqual({ ok: false, reason: expect.stringContaining('ran in a terminal') });
    expect(continuability(plan({ status: 'completed', transport: { kind: 'terminal', fallback: 'no connector' } }))).toMatchObject({ ok: false });
    expect(continuability(plan({ status: 'failed', transport: { kind: 'structured' } }))).toEqual({ ok: false, reason: expect.stringContaining('no saved session') });
  });

  it('not a task still running, waiting, or never run, nor a user task', () => {
    for (const status of ['pending', 'in_progress', 'awaiting_user', 'blocked'] as const) {
      expect(continuability(plan({ status, transport: structured })).ok).toBe(false);
    }
    expect(continuability(plan({ type: 'user', status: 'completed', transport: structured })).ok).toBe(false);
  });

  it('is on the task\'s status for surfaces, without the session id itself', () => {
    const status = serializeTaskStatus(plan({ status: 'completed', transport: structured }));
    expect(status.continuable).toBe(true);
    expect(JSON.stringify(status)).not.toContain('sess-1');
    expect(serializeTaskStatus(plan({ status: 'completed' }))).not.toHaveProperty('continuable');
  });
});

describe('TaskOrchestrator.continueTask', () => {
  it('resumes the saved session with the message and a protocol reminder, not the original prompt', async () => {
    const h = setup();
    h.orchestrator.loadPlan([plan()]);
    await completedStructured(h);

    await h.orchestrator.continueTask('t1', '  also handle arrays  ');

    const request = h.requests.at(-1)!;
    expect(request).toMatchObject({ transport: 'structured', resumeSessionId: 'native-t1-1', runner: 'claude-code' });
    expect(request.prompt.startsWith('also handle arrays\n')).toBe(true);
    expect(request.prompt).toContain('continuing this task in the same session');
    expect(request.prompt).toContain('`DONE_mk-1>>>`');
    expect(request.prompt).not.toContain('<<<ORDEWELL_DONE_mk-1>>>');
    expect(request.prompt).not.toContain('ORIGINAL PROMPT BODY');
    expect(h.task('t1').status).toBe('in_progress');
  });

  it('is verified by its own marker and summarized from the continued attempt', async () => {
    const h = setup();
    h.orchestrator.loadPlan([plan()]);
    await completedStructured(h);

    await h.orchestrator.continueTask('t1', 'also handle arrays');
    expect(h.task('t1').verdict).toBeUndefined();
    h.sessions[1].emitOutput('Arrays handled too.\n<<<ORDEWELL_DONE_mk-1>>>\n');

    await vi.waitFor(() => expect(h.task('t1').status).toBe('completed'));
    expect(h.task('t1').verdict?.outcome).toBe('pass');
    expect(h.task('t1').outputSummary?.logTail).toContain('Arrays handled too.');
    expect(h.task('t1').outputSummary?.logTail).not.toContain('Parsed objects.');
    expect(h.task('t1').transport).toEqual({ kind: 'structured', nativeSessionId: 'native-t1-1' });
  });

  it('continues a failed task, and a continued turn that ends without the marker waits for input', async () => {
    const h = setup();
    h.orchestrator.loadPlan([plan()]);
    await h.orchestrator.forceStartTask('t1');
    h.sessions[0].emitExit(1);
    await vi.waitFor(() => expect(h.task('t1').status).toBe('failed'));

    await h.orchestrator.continueTask('t1', 'the tests need Node 22');
    (h.sessions[1] as FakeStructuredSession).emitTurnEnd('completed');

    expect(h.task('t1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'input' });
  });

  it('leaves dependents alone, as retry does', async () => {
    const h = setup();
    h.orchestrator.loadPlan([plan(), createTask({ id: 't2', order: 2, title: 'Use it', prompt: 'two', completionMarker: 'mk-2', dependencies: ['t1'] })]);
    await h.orchestrator.approveReview();
    h.sessions[0].emitOutput('<<<ORDEWELL_DONE_mk-1>>>');
    await vi.waitFor(() => expect(h.sessions).toHaveLength(2));
    h.sessions[1].emitOutput('<<<ORDEWELL_DONE_mk-2>>>');
    await vi.waitFor(() => expect(h.orchestrator.status).toBe('completed'));
    const t2Before = { ...h.task('t2') };

    await h.orchestrator.continueTask('t1', 'rename the parser');

    expect(h.sessions).toHaveLength(3);
    expect(h.requests.at(-1)!.taskId).toBe('t1');
    expect(h.task('t2')).toMatchObject({ status: 'completed', verdict: t2Before.verdict, outputSummary: t2Before.outputSummary });
  });

  it('starts from a fresh worktree at the task\'s own path, replacing the kept one', async () => {
    const isolation = new FakeWorktreeIsolation();
    const h = setup({ isolation });
    h.orchestrator.loadPlan([plan(), createTask({ id: 't2', order: 2, title: 'Other', prompt: 'two', completionMarker: 'mk-2' })]);
    await h.orchestrator.forceStartTask('t2');
    await h.orchestrator.forceStartTask('t1');
    h.sessions[1].emitExit(1);
    await vi.waitFor(() => expect(h.task('t1').status).toBe('failed'));

    await h.orchestrator.continueTask('t1', 'try again with the fixture');

    expect(isolation.taskIdsFor('prepare')).toEqual(['t2', 't1', 't1']);
    const cwds = h.requests.filter((r) => r.taskId === 't1').map((r) => r.cwd);
    expect(cwds).toHaveLength(2);
    expect(cwds[1]).toBe(cwds[0]);
  });

  it('refuses a conflict, a terminal task and an unfinished one with the reason', async () => {
    const h = setup();
    h.orchestrator.loadPlan([
      plan({ status: 'awaiting_user', awaitingReason: 'conflict', transport: { kind: 'structured', nativeSessionId: 'sess-1' } }),
      createTask({ id: 't2', order: 2, title: 'Terminal', prompt: 'two', status: 'completed' }),
      createTask({ id: 't3', order: 3, title: 'Pending', prompt: 'three' }),
    ]);

    await expect(h.orchestrator.continueTask('t1', 'go on')).rejects.toThrow(/merge conflict/);
    await expect(h.orchestrator.continueTask('t2', 'go on')).rejects.toThrow(/ran in a terminal.*Retry/);
    await expect(h.orchestrator.continueTask('t3', 'go on')).rejects.toBeInstanceOf(TaskControlError);
    await expect(h.orchestrator.continueTask('t1', '   ')).rejects.toThrow(/cannot be empty/);
    expect(h.requests).toHaveLength(0);
  });

  it('refuses a task whose runner now has no structured connector', async () => {
    const h = setup();
    h.orchestrator.loadPlan([plan({ status: 'completed', assignedRunner: 'my-plugin', transport: { kind: 'structured', nativeSessionId: 'sess-1' } })], ['my-plugin']);

    await expect(h.orchestrator.continueTask('t1', 'go on')).rejects.toThrow(/no structured connector for my-plugin yet.*Retry/);
    expect(h.requests).toHaveLength(0);
  });
});

describe('a continue whose session cannot be resumed', () => {
  it('fails with a message suggesting Retry, and never waits for input in a session that does not exist', async () => {
    const h = setup({ resumes: () => null });
    h.orchestrator.loadPlan([plan()]);
    await completedStructured(h);

    await h.orchestrator.continueTask('t1', 'also handle arrays');
    const resumed = h.sessions[1] as FakeStructuredSession;
    resumed.emitOutput('No conversation found with session ID: native-t1-1\n');
    resumed.emitTurnEnd('failed');

    expect(resumed.killed).toBe(true);
    expect(h.task('t1').status).toBe('in_progress');
    resumed.emitExit(-1);

    await vi.waitFor(() => expect(h.task('t1').status).toBe('failed'));
    expect(h.notifications.error).toHaveBeenCalledWith(expect.stringMatching(/Could not continue task "Parse JSON": claude-code could not find its saved session\. Retry starts it afresh\./));
    expect(h.task('t1').outputSummary?.reviewReason).toMatch(/Retry starts it afresh/);
    expect(h.task('t1').outputSummary?.logTail).toContain('No conversation found');
    // Nothing was taken up, so there is nothing left to offer a continue of.
    expect(continuability(h.task('t1')).ok).toBe(false);
    expect(h.requests).toHaveLength(2);
  });

  it('fails the attempt rather than start a fresh session when the spawn comes back a terminal', async () => {
    const terminalOnly = {
      spawn: vi.fn(async (o: RunnerSpawnOptions) => new FakeTerminalSession('s1', o.taskId)),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies ITerminalRunner;
    const h = setup({ runner: terminalOnly });
    h.orchestrator.loadPlan([plan({ status: 'completed', transport: { kind: 'structured', nativeSessionId: 'sess-1' } })]);

    await h.orchestrator.continueTask('t1', 'go on');

    const session = await terminalOnly.spawn.mock.results[0].value;
    expect(session.killed).toBe(true);
    expect(h.task('t1').status).toBe('failed');
    expect(h.notifications.error).toHaveBeenCalledWith('Could not continue task "Parse JSON": could not start: this surface cannot run structured tasks. Retry starts it afresh.');
    // A failure to start is no evidence the session is gone: it stays continuable.
    expect(continuability(h.task('t1'))).toEqual({ ok: true, sessionId: 'sess-1' });
  });

  it('fails the attempt when the runner cannot be started at all', async () => {
    const failing = {
      spawn: vi.fn(async () => { throw new Error('claude: command not found'); }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies ITerminalRunner;
    const h = setup({ runner: failing });
    h.orchestrator.loadPlan([plan({ status: 'completed', transport: { kind: 'structured', nativeSessionId: 'sess-1' } })]);

    await h.orchestrator.continueTask('t1', 'go on');

    expect(h.task('t1').status).toBe('failed');
    expect(h.task('t1').outputSummary?.reviewReason).toBe('Could not continue task "Parse JSON": could not start: claude: command not found. Retry starts it afresh.');
  });
});

describe('Session.continueTask', () => {
  it('saves the continued attempt\'s start, so a reload does not show the old outcome', async () => {
    const { runner, sessions } = routingRunner();
    const session = makeSession({ runner });
    const saved: LegacyPlanState = {
      tasks: [plan()],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };
    session.loadPlan(saved, 'Goal', '/repo');
    await session.executePlan();
    sessions[0].emitOutput('<<<ORDEWELL_DONE_mk-1>>>');
    await vi.waitFor(() => expect(saves(session).mock.lastCall?.[0].tasks[0].status).toBe('completed'));

    await session.continueTask('t1', 'also handle arrays');

    const last = saves(session).mock.lastCall?.[0].tasks[0];
    expect(last).toMatchObject({ status: 'in_progress', verdict: undefined });
    await expect(session.continueTask('t1', 'again')).rejects.toBeInstanceOf(TaskControlError);
  });
});
