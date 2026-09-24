import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSession, FakeTerminalSession } from './sessionTestKit';
import { FakeWorktreeIsolation } from '../../testing';
import * as sessionStore from '../../utils/sessionStore';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { ITerminalRunner } from '../../interfaces/ITerminalRunner';
import type { SessionMessage } from '../SessionMessage';

function runner() {
  const sessions: FakeTerminalSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<ITerminalRunner['spawn']>[0]) => {
    const session = new FakeTerminalSession(`s${sessions.length + 1}`, opts.taskId);
    sessions.push(session);
    return session;
  });
  return { sessions, spawn, runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as ITerminalRunner };
}

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, completionMarker: `mk-${id}`, ...over });

function plan(tasks: Task[]): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
}

function setup(isolation = new FakeWorktreeIsolation()) {
  const messages: SessionMessage[] = [];
  const r = runner();
  const session = makeSession({ runner: r.runner, isolation, broadcast: (m) => messages.push(m) });
  const pass = (t: Task) => r.sessions.find((s) => s.taskId === t.id)!.emitOutput(`<<<ORDEWELL_DONE_${t.completionMarker}>>>`);
  const lastStatus = () => [...messages].reverse().find((m): m is Extract<SessionMessage, { type: 'status_update' }> => m.type === 'status_update');
  return { session, isolation, messages, pass, lastStatus, ...r };
}

const saved = () => vi.mocked(sessionStore.saveSession).mock.calls.at(-1)?.[0];

beforeEach(() => { vi.restoreAllMocks(); });

describe('Session with worktree isolation', () => {
  it('reports each task\'s branch, worktree and isolation state on status updates', async () => {
    const { session, lastStatus } = setup();
    session.loadPlan(plan([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]), 'goal', '/repo');

    await session.executePlan();

    expect(lastStatus()!.tasks.find((t) => t.id === 't1')!.isolation).toEqual({
      state: 'active', branch: 'ordewell/run1/1-t1', worktree: '/fake-worktrees/run1/1-t1',
    });
    expect(lastStatus()!.tasks.find((t) => t.id === 't2')!.isolation).toEqual({ state: 'none' });
  });

  it('leaves status updates as they were when the workspace cannot isolate', async () => {
    const isolation = new FakeWorktreeIsolation();
    isolation.availability = { active: false, reason: 'not-git' };
    const { session, lastStatus } = setup(isolation);
    session.loadPlan(plan([task('t1', 1)]), 'goal', '/repo');

    await session.executePlan();

    expect(Object.keys(lastStatus()!.tasks[0]).sort()).toEqual(['id', 'idleSince', 'status', 'verdict']);
  });

  it('broadcasts the handoff before execution completes and persists the run with the plan', async () => {
    const { session, messages, pass } = setup();
    const t1 = task('t1', 1);
    session.loadPlan(plan([t1]), 'goal', '/repo');
    await session.executePlan();

    pass(t1);
    await vi.waitFor(() => expect(messages.map((m) => m.type)).toContain('execution_complete'));

    const types = messages.map((m) => m.type);
    expect(types.indexOf('isolation_handoff')).toBeLessThan(types.indexOf('execution_complete'));
    expect(messages.find((m) => m.type === 'isolation_handoff')).toEqual({
      type: 'isolation_handoff',
      branch: 'ordewell/run1/integration',
      baseRef: 'base0000',
      landed: [{ taskId: 't1', order: 1, title: 'Task t1' }],
    });
    expect(saved()!.isolation).toEqual({
      run: expect.objectContaining({ id: 'run1', integrationBranch: 'ordewell/run1/integration' }),
      resolvers: {},
    });
  });

  describe('on a dirty tree', () => {
    function dirty() {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'dirty' };
      const env = setup(isolation);
      env.session.loadPlan(plan([task('t1', 1)]), 'goal', '/repo');
      return env;
    }

    it('does not start, says why, and does not report the run as complete', async () => {
      const { session, messages, spawn } = dirty();

      await session.executePlan();

      expect(spawn).not.toHaveBeenCalled();
      expect(messages).toContainEqual({ type: 'isolation_blocked', reason: 'dirty', message: expect.stringMatching(/stash/i) });
      expect(messages.map((m) => m.type)).not.toContain('execution_complete');
    });

    it('continues isolated after stashing', async () => {
      const { session, spawn, isolation } = dirty();
      await session.executePlan();

      await session.continueWithStash();

      expect(isolation.calls.map((c) => c.op)).toContain('stash');
      expect(spawn.mock.calls[0][0].cwd).toBe('/fake-worktrees/run1/1-t1');
    });

    it('continues in the workspace root when the user opts out for this run', async () => {
      const { session, spawn } = dirty();
      await session.executePlan();

      await session.continueWithoutIsolation();

      expect(spawn.mock.calls[0][0].cwd).toBe(process.cwd());
    });
  });

  it('adopts a saved plan\'s run: prunes orphans, then continues it', async () => {
    const { session, isolation, spawn } = setup();
    const saved: LegacyPlanState = {
      ...plan([task('t1', 1, { status: 'completed' }), task('t2', 2, { dependencies: ['t1'] })]),
      isolation: {
        run: {
          id: 'old', workspaceRoot: process.cwd(), baseRef: 'abc', integrationBranch: 'ordewell/old/integration',
          tasks: { t1: { taskId: 't1', order: 1, title: 'Task t1', branch: 'ordewell/old/1-t1', worktree: '/wt/1', status: 'merged', linked: [] } },
        },
        resolvers: {},
      },
    };

    session.loadPlan(saved, 'goal', '/repo');
    await vi.waitFor(() => expect(isolation.calls).toEqual([{ op: 'pruneOrphans' }]));
    await session.executePlan();

    expect(spawn.mock.calls[0][0].cwd).toBe('/fake-worktrees/old/2-t2');
  });

  it('adopts without writing: a host that restores with persist off keeps its one session file', async () => {
    const { session, isolation } = setup();
    const restored: LegacyPlanState = {
      ...plan([task('t1', 1)]),
      isolation: {
        run: { id: 'old', workspaceRoot: process.cwd(), baseRef: 'abc', integrationBranch: 'ordewell/old/integration', tasks: {} },
        resolvers: {},
      },
    };

    session.loadPlan(restored, 'goal', '/repo', { persist: false });
    await vi.waitFor(() => expect(isolation.calls).toEqual([{ op: 'pruneOrphans' }]));
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionStore.saveSession).not.toHaveBeenCalled();
  });

  it('starts a new plan without the previous plan\'s run', async () => {
    const { session, pass } = setup();
    const t1 = task('t1', 1);
    session.loadPlan(plan([t1]), 'goal', '/repo');
    await session.executePlan();
    pass(t1);
    await vi.waitFor(() => expect(saved()?.isolation).toBeDefined());

    session.loadPlan(plan([task('x1', 1)]), 'other goal', '/repo');

    expect(session.planState!.isolation).toBeUndefined();
    expect(saved()!.isolation).toBeUndefined();
  });

  describe('end-of-run actions', () => {
    async function landed() {
      const env = setup();
      const t1 = task('t1', 1);
      env.session.loadPlan(plan([t1]), 'goal', '/repo');
      await env.session.executePlan();
      env.pass(t1);
      await vi.waitFor(() => expect(env.messages.map((m) => m.type)).toContain('execution_complete'));
      return env;
    }

    it('reviews the run\'s diff', async () => {
      const { session, isolation } = await landed();
      await session.reviewRunDiff();
      expect(isolation.calls.map((c) => c.op)).toContain('reviewDiff');
    });

    it('merges into the checked-out branch only when asked', async () => {
      const { session, isolation } = await landed();
      expect(isolation.calls.map((c) => c.op)).not.toContain('mergeIntoCheckedOut');

      expect(await session.mergeRun()).toBe('merged');
      expect(isolation.calls.map((c) => c.op)).toContain('mergeIntoCheckedOut');
    });

    it('cleans up worktrees but keeps the branch and the record', async () => {
      const { session, isolation } = await landed();
      await session.cleanupRun();
      expect(isolation.calls).toContainEqual({ op: 'discard', keepIntegration: true });
      expect(saved()!.isolation).toBeDefined();
    });

    it('discards the whole run and forgets it', async () => {
      const { session, isolation } = await landed();
      await session.discardRun();
      expect(isolation.calls).toContainEqual({ op: 'discard', keepIntegration: false });
      expect(saved()!.isolation).toBeUndefined();
    });

    it('refuses while the run is still executing', async () => {
      const { session } = setup();
      session.loadPlan(plan([task('t1', 1)]), 'goal', '/repo');
      await session.executePlan();
      await expect(session.discardRun()).rejects.toThrow(/running/i);
    });
  });

  it('resolves a conflict as an added task on the conflicted task\'s runner, never on its own', async () => {
    const { session, isolation, pass } = setup();
    isolation.outcomes.set('t1', 'conflict');
    const t1 = task('t1', 1, { assignedModel: { modelId: 'sonnet', modelLabel: 'Sonnet' } });
    session.loadPlan(plan([t1, task('t2', 2, { dependencies: ['t1'] })]), 'goal', '/repo');
    await session.executePlan();
    pass(t1);
    await vi.waitFor(() => expect(session.getTask('t1')!.status).toBe('awaiting_user'));
    expect(session.planTasks).toHaveLength(2);

    await session.resolveConflictAsTask('t1');

    const resolver = session.planTasks[2];
    expect(resolver.title).toMatch(/conflict/i);
    expect(resolver.prompt).toContain('ordewell/run1/1-t1');
    expect(resolver.assignedModel?.modelId).toBe('sonnet');
    expect(resolver.dependencies).toEqual([]);
    expect(saved()!.isolation!.resolvers).toEqual({ [resolver.id]: 't1' });
  });

  it('refuses to resolve a task that did not conflict', async () => {
    const { session } = setup();
    session.loadPlan(plan([task('t1', 1)]), 'goal', '/repo');
    await expect(session.resolveConflictAsTask('t1')).rejects.toThrow(/conflict/i);
  });

  describe('what the planner is told', () => {
    function planning(availability: FakeWorktreeIsolation['availability']) {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = availability;
      const startConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'hi', researchLog: [] });
      const generate = vi.fn().mockResolvedValue(plan([task('t1', 1)]));
      const session = makeSession({
        isolation,
        aiService: { startConversation, hasActiveConversation: () => true, reset: vi.fn() },
        planner: { generate },
      });
      return { session, startConversation, generate };
    }

    it('says tasks will run in their own worktrees when the workspace can isolate', async () => {
      const { session, startConversation, generate } = planning({ active: true });

      await session.startPlanning('goal', ['claude-code']);
      await session.generatePlan('goal', ['claude-code']);

      expect(startConversation).toHaveBeenCalledWith(expect.objectContaining({ isolatedExecution: true }));
      expect(generate).toHaveBeenCalledWith(expect.objectContaining({ modes: expect.objectContaining({ isolatedExecution: true }) }));
    });

    it.each([
      ['not-git', { active: false, reason: 'not-git' }],
      ['disabled', { active: false, reason: 'disabled' }],
      ['dirty', { active: false, reason: 'dirty' }],
    ] as const)('keeps the shared-workspace rules when the workspace is %s', async (_name, availability) => {
      const { session, startConversation, generate } = planning(availability);

      await session.startPlanning('goal', ['claude-code']);
      await session.generatePlan('goal', ['claude-code']);

      expect(startConversation).toHaveBeenCalledWith(expect.objectContaining({ isolatedExecution: false }));
      expect(generate).toHaveBeenCalledWith(expect.objectContaining({ modes: expect.objectContaining({ isolatedExecution: false }) }));
    });
  });
});
