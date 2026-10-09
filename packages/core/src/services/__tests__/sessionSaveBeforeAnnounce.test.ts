import { describe, it, expect, vi } from 'vitest';
import { makeSession, FakeTerminalSession, queue } from './sessionTestKit';
import { fakeConfig, FakeStructuredSession, FakeWorktreeIsolation } from '../../testing';
import { createTask, flattenTasks, type LegacyPlanState, type Task } from '../../models/Task';
import type { ITerminalRunner, ITerminalSession } from '../../interfaces/ITerminalRunner';
import type { IConfig } from '../../interfaces/IConfig';
import type { ConversationTurn } from '../AiService';
import type { Session, SessionPlanner } from '../createSession';
import type { SessionMessage } from '../SessionMessage';

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, completionMarker: `mk-${id}`, ...over });

function plan(tasks: Task[]): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
}

const statuses = (tasks: ReadonlyArray<{ id: string; status: string }>) =>
  tasks.map((t) => `${t.id}:${t.status}`).sort().join(' ');

/**
 * A Session whose every save and status announcement is recorded in order,
 * each with the task statuses it carried.
 */
function setup(tasks: Task[], opts: {
  isolation?: FakeWorktreeIsolation;
  structured?: boolean;
  config?: IConfig;
  planner?: Partial<SessionPlanner>;
} = {}) {
  const terminals: FakeTerminalSession[] = [];
  const runner = {
    spawn: vi.fn(async (spawn: { taskId: string }) => {
      const id = `s${terminals.length + 1}`;
      const t = opts.structured ? new FakeStructuredSession(id, spawn.taskId) : new FakeTerminalSession(id, spawn.taskId);
      terminals.push(t);
      return t;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } as unknown as ITerminalRunner;
  const seen: { kind: 'save' | 'status'; statuses: string }[] = [];
  const messages: SessionMessage[] = [];
  const session = makeSession({
    runner,
    isolation: opts.isolation ?? new FakeWorktreeIsolation(),
    config: opts.config,
    planner: opts.planner,
    settings: () => ({ runnerTransport: opts.structured ? 'structured' : 'terminal' }),
    saveSession: (p) => { seen.push({ kind: 'save', statuses: statuses(flattenTasks(p.tasks)) }); },
    broadcast: (m) => {
      messages.push(m);
      if (m.type === 'status_update') seen.push({ kind: 'status', statuses: statuses(m.tasks) });
    },
  });
  session.loadPlan(plan(tasks), 'goal', '/repo', { persist: false });
  const terminal = (taskId: string) => terminals.find((t) => t.taskId === taskId)!;
  const structured = (taskId: string) => terminal(taskId) as FakeStructuredSession;
  return { session, seen, messages, terminal, structured };
}

/**
 * Run one user control and check that no surface was told a task status the
 * disk did not have yet, and that the disk ends up with what the control left.
 */
async function expectSavedBeforeAnnounced(env: ReturnType<typeof setup>, control: (session: Session) => unknown): Promise<void> {
  env.seen.length = 0;
  await control(env.session);

  let disk: string | undefined;
  for (const { kind, statuses: s } of env.seen) {
    if (kind === 'save') disk = s;
    else expect(s).toBe(disk);
  }
  expect(disk).toBe(statuses(flattenTasks(env.session.planTasks)));
}

describe('every user control saves before it announces', () => {
  it('retry', async () => {
    const env = setup([task('t1', 1)]);
    await env.session.executePlan();
    env.terminal('t1').emitExit(1);
    await vi.waitFor(() => expect(env.session.planTasks[0].status).toBe('failed'));

    await expectSavedBeforeAnnounced(env, (s) => s.retryTask('t1'));
    expect(env.session.planTasks[0].status).toBe('in_progress');
  });

  it('cancel', async () => {
    const env = setup([task('t1', 1)]);
    await env.session.executePlan();

    await expectSavedBeforeAnnounced(env, (s) => s.cancelTask('t1'));
    expect(env.session.planTasks[0].status).toBe('pending');
  });

  it('mark complete, which starts the dependent', async () => {
    const env = setup([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await env.session.executePlan();

    await expectSavedBeforeAnnounced(env, (s) => s.markTaskComplete('t1'));
    expect(env.session.planTasks.map((t) => t.status)).toEqual(['completed', 'in_progress']);
  });

  it('mark not done', async () => {
    const env = setup([task('t1', 1)]);
    await env.session.executePlan();
    await env.session.markTaskComplete('t1');

    await expectSavedBeforeAnnounced(env, (s) => s.markTaskIncomplete('t1'));
    expect(env.session.planTasks[0].status).not.toBe('completed');
  });

  it('force start', async () => {
    const env = setup([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await env.session.executePlan();

    await expectSavedBeforeAnnounced(env, (s) => s.forceStartTask('t2'));
    expect(env.session.planTasks[1].status).toBe('in_progress');
  });

  it('run one task', async () => {
    const env = setup([task('t1', 1)]);

    await expectSavedBeforeAnnounced(env, (s) => s.runTask('t1'));
    expect(env.session.planTasks[0].status).toBe('in_progress');
  });

  it('execute', async () => {
    const env = setup([task('t1', 1)]);

    await expectSavedBeforeAnnounced(env, (s) => s.executePlan());
    expect(env.session.planTasks[0].status).toBe('in_progress');
  });

  it('stop', async () => {
    const env = setup([task('t1', 1)]);
    await env.session.executePlan();

    await expectSavedBeforeAnnounced(env, (s) => s.stopExecution());
    expect(env.session.planTasks[0].status).toBe('pending');
  });

  it.each(['continueWithStash', 'continueWithoutIsolation'] as const)('%s on a dirty tree', async (control) => {
    const isolation = new FakeWorktreeIsolation();
    isolation.availability = { active: false, reason: 'dirty' };
    const env = setup([task('t1', 1)], { isolation });
    await env.session.executePlan();

    await expectSavedBeforeAnnounced(env, (s) => s[control]());
    expect(env.session.planTasks[0].status).toBe('in_progress');
  });

  it.each(['cleanupRun', 'discardRun'] as const)('%s of a settled run', async (control) => {
    const env = setup([task('t1', 1)]);
    await env.session.executePlan();
    env.terminal('t1').emitOutput('<<<ORDEWELL_DONE_mk-t1>>>');
    await vi.waitFor(() => expect(env.messages.map((m) => m.type)).toContain('execution_complete'));

    await expectSavedBeforeAnnounced(env, (s) => s[control]());
  });

  it('approve the review, which starts the run', async () => {
    const env = setup([task('t1', 1)]);

    await expectSavedBeforeAnnounced(env, (s) => s.approveReview());
    expect(env.session.planTasks[0].status).toBe('in_progress');
  });

  it('reschedule after the parallel limit was raised', async () => {
    const config = fakeConfig({ maxParallelSessions: 1 });
    const env = setup([task('t1', 1), task('t2', 2)], { config });
    await env.session.executePlan();
    config.maxParallelSessions = 2;

    await expectSavedBeforeAnnounced(env, (s) => s.reschedule());
    expect(env.session.planTasks.map((t) => t.status)).toEqual(['in_progress', 'in_progress']);
  });

  it('interrupt a structured turn', async () => {
    const env = setup([task('t1', 1)], { structured: true });
    await env.session.executePlan();

    await expectSavedBeforeAnnounced(env, (s) => s.interruptTask('t1'));
    expect(env.session.planTasks[0].status).toBe('awaiting_user');
  });

  it.each(['forceSendQueuedTaskMessage', 'removeQueuedTaskMessage'] as const)('%s', async (control) => {
    const env = setup([task('t1', 1)], { structured: true });
    await env.session.executePlan();
    const id = env.session.sendTaskMessage('t1', 'later');

    await expectSavedBeforeAnnounced(env, (s) => expect(s[control]('t1', id)).toBe(true));
  });

  it('merge all mid-run, which starts the ops task waiting at its gate', async () => {
    const env = setup([task('t1', 1), task('o1', 2, { ops: true, dependencies: ['t1'] })]);
    await env.session.executePlan();
    env.terminal('t1').emitOutput('<<<ORDEWELL_DONE_mk-t1>>>');
    await vi.waitFor(() => expect(env.session.mergeGate('o1')).toEqual(['t1']));

    await expectSavedBeforeAnnounced(env, (s) => s.mergeRun());
    expect(env.session.planTasks.map((t) => t.status)).toEqual(['completed', 'in_progress']);
  });

  it('the run going on after the Session drained a queued edit', async () => {
    const t1 = task('t1', 1);
    const t2 = task('t2', 2, { dependencies: ['t1'] });
    const planner = {
      modifyDuringExecution: vi.fn().mockResolvedValue({ pendingTasks: [{ ...t1, status: 'completed' }, { ...t2, title: 'Second, edited' }], message: 'ok' }),
    };
    const env = setup([t1, t2], { planner });
    await env.session.executePlan();
    queue(env.session, 'an edit');

    await expectSavedBeforeAnnounced(env, async () => {
      env.terminal('t1').emitOutput('<<<ORDEWELL_DONE_mk-t1>>>');
      await vi.waitFor(() => expect(env.session.planTasks[1].status).toBe('in_progress'));
    });
  });
});

describe("a user control's saves while it runs", () => {
  it('are background saves, so a planner turn that fails meanwhile still rolls back', async () => {
    let fail!: (err: Error) => void;
    const spawns: Array<(session: ITerminalSession) => void> = [];
    const runner = {
      spawn: vi.fn(() => new Promise<ITerminalSession>((resolve) => { spawns.push(resolve); })),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } as unknown as ITerminalRunner;
    const session = makeSession({
      runner,
      isolation: new FakeWorktreeIsolation(),
      aiService: {
        hasActiveConversation: () => true,
        continueConversation: vi.fn(() => new Promise<ConversationTurn>((_resolve, reject) => { fail = reject; })),
      },
    });
    const dialogue = plan([task('t1', 1)]);
    dialogue.conversationHistory = [
      { role: 'user', content: 'goal', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Plan generated with 1 task.', timestamp: '2026-01-01T00:00:01Z', kind: 'plan_generated' },
    ];
    session.loadPlan(dialogue, 'goal', '/repo', { persist: false });

    const turn = session.continueConversation('and docs');
    const starting = session.runTask('t1');
    await vi.waitFor(() => expect(spawns).toHaveLength(1));
    fail(new Error('planner transport failed'));
    await expect(turn).rejects.toThrow('planner transport failed');

    expect(session.planState!.conversationHistory!.map((m) => m.content)).toEqual(['goal', 'Plan generated with 1 task.']);
    spawns[0](new FakeTerminalSession('s1', 't1'));
    await starting;
  });
});
