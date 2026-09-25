import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeSession, FakeTerminalSession } from './sessionTestKit';
import { FakeWorktreeIsolation } from '../../testing';
import * as sessionStore from '../../utils/sessionStore';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { ITerminalRunner } from '../../interfaces/ITerminalRunner';
import type { SessionMessage, SessionNotice } from '../SessionMessage';
import type { IsolationMergeResult } from '../../interfaces/IWorktreeIsolation';
import type { ConversationTurn, IAiService } from '../AiService';

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

function setup(isolation = new FakeWorktreeIsolation(), aiService?: Partial<IAiService>) {
  const messages: SessionMessage[] = [];
  const notices: SessionNotice[] = [];
  const r = runner();
  const session = makeSession({ runner: r.runner, isolation, aiService, broadcast: (m) => messages.push(m), onNotice: (n) => notices.push(n) });
  const pass = (t: Task) => r.sessions.find((s) => s.taskId === t.id)!.emitOutput(`<<<ORDEWELL_DONE_${t.completionMarker}>>>`);
  const lastStatus = () => [...messages].reverse().find((m): m is Extract<SessionMessage, { type: 'status_update' }> => m.type === 'status_update');
  return { session, isolation, messages, notices, pass, lastStatus, ...r };
}

const saved = () => vi.mocked(sessionStore.saveSession).mock.calls.at(-1)?.[0];

beforeEach(() => { vi.restoreAllMocks(); });

describe('Session with worktree isolation', () => {
  it('reports each task\'s branch, worktree and isolation state on status updates', async () => {
    const { session, lastStatus } = setup();
    session.loadPlan(plan([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]), 'goal', '/repo');

    await session.executePlan();

    expect(lastStatus()!.tasks.find((t) => t.id === 't1')!.isolation).toEqual({
      state: 'active', branch: 'ordewell/run1/1-t1', worktree: '/fake-worktrees/run1/1-t1', repos: [],
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
      repos: [{ path: '.', integrationBranch: 'ordewell/run1/integration', baseRef: 'base0000', landed: [{ taskId: 't1', order: 1, title: 'Task t1' }] }],
      landed: [{ taskId: 't1', order: 1, title: 'Task t1' }],
    });
    expect(saved()!.isolation).toEqual({
      run: expect.objectContaining({ id: 'run1', repos: [expect.objectContaining({ path: '.', integrationBranch: 'ordewell/run1/integration' })] }),
      resolvers: {},
    });
  });

  it('hands a surface the notice of a run that falls back to the workspace root, apart from the session stream', async () => {
    const isolation = new FakeWorktreeIsolation();
    isolation.availability = { active: false, reason: 'not-git' };
    const { session, notices, messages } = setup(isolation);
    session.loadPlan(plan([task('t1', 1)]), 'goal', '/repo');

    await session.executePlan();

    expect(notices).toEqual([{ type: 'notice', level: 'info', message: 'Not a git repository — tasks run in the workspace root without worktree isolation.' }]);
    expect(messages.map((m) => m.type)).not.toContain('notice');
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

    it('names the dirty repositories of a group', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'dirty', repos: ['api', 'web'] };
      const { session, messages } = setup(isolation);
      session.loadPlan(plan([task('t1', 1)]), 'goal', '/group');

      await session.executePlan();

      expect(messages).toContainEqual({
        type: 'isolation_blocked',
        reason: 'dirty',
        repos: ['api', 'web'],
        message: 'Tracked files have uncommitted changes in api, web, so tasks cannot run in isolated worktrees. Stash them, or run this plan without isolation.',
      });
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
          id: 'old', workspaceRoot: process.cwd(), shared: [], sharedRepos: [],
          repos: [{ path: '.', root: process.cwd(), baseRef: 'abc', integrationBranch: 'ordewell/old/integration' }],
          tasks: { t1: { taskId: 't1', order: 1, title: 'Task t1', branch: 'ordewell/old/1-t1', workspace: '/wt/1', status: 'merged', repos: { '.': { worktree: '/wt/1', linked: [], changed: true } } } },
        },
        resolvers: {},
      },
    };

    session.loadPlan(saved, 'goal', '/repo');
    await vi.waitFor(() => expect(isolation.calls).toEqual([{ op: 'pruneOrphans' }]));
    await session.executePlan();

    expect(spawn.mock.calls[0][0].cwd).toBe('/fake-worktrees/old/2-t2');
  });

  it('resumes a session saved by 0.4.23 with an unfinished run, and hands it off as before', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-legacy-'));
    try {
      const saved = {
        ...plan([task('t1', 1, { status: 'completed' }), task('t2', 2, { dependencies: ['t1'] })]),
        // The ADR-0013 record, as 0.4.23 wrote it: the refs on the run, one worktree per task.
        isolation: {
          run: {
            id: 'old', workspaceRoot: process.cwd(), baseRef: 'abc', baseBranch: 'main', integrationBranch: 'ordewell/old/integration',
            tasks: { t1: { taskId: 't1', order: 1, title: 'Task t1', branch: 'ordewell/old/1-t1', worktree: '/wt/1', status: 'merged', linked: [] } },
          },
          resolvers: {},
        },
      };
      fs.mkdirSync(path.join(dir, '.ordewell', 'sessions'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.ordewell', 'sessions', '2026-09-20T10-00-00_goal_legacy1.json'),
        JSON.stringify({ meta: { id: 'session-legacy1', goal: 'goal', runners: ['claude-code'], taskCount: 2, status: 'approved', createdAt: saved.generatedAt, updatedAt: saved.generatedAt }, plan: saved }),
      );
      const { session, isolation, spawn, pass, messages } = setup();

      const loaded = sessionStore.loadSession('session-legacy1', dir)!;
      session.loadPlan(loaded.plan, loaded.meta.goal, '/repo');
      await vi.waitFor(() => expect(isolation.calls).toEqual([{ op: 'pruneOrphans' }]));
      await session.executePlan();

      expect(spawn.mock.calls[0][0].cwd).toBe('/fake-worktrees/old/2-t2');
      pass(session.planState!.tasks[1]);
      await vi.waitFor(() => expect(messages.map((m) => m.type)).toContain('isolation_handoff'));
      const landed = [{ taskId: 't1', order: 1, title: 'Task t1' }, { taskId: 't2', order: 2, title: 'Task t2' }];
      expect(messages.find((m) => m.type === 'isolation_handoff')).toEqual({
        type: 'isolation_handoff',
        repos: [{ path: '.', integrationBranch: 'ordewell/old/integration', baseRef: 'abc', landed }],
        landed,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('describes an adopted run to a surface no stream has told: each task\'s mark and the handoff', () => {
    const { session } = setup();
    const record = (taskId: string, order: number, status: 'merged' | 'conflict') => ({
      taskId, order, title: `Task ${taskId}`, branch: `ordewell/old/${order}-${taskId}`, workspace: `/wt/${order}`, status,
      repos: { '.': { worktree: `/wt/${order}`, linked: [], ...(status === 'merged' ? { changed: true } : {}) } },
      ...(status === 'conflict' ? { conflictRepo: '.' } : {}),
    });
    session.loadPlan({
      ...plan([task('t1', 1, { status: 'completed' }), task('t2', 2, { status: 'awaiting_user' }), task('t3', 3)]),
      isolation: {
        run: {
          id: 'old', workspaceRoot: process.cwd(), shared: [], sharedRepos: [],
          repos: [{ path: '.', root: process.cwd(), baseRef: 'abc', integrationBranch: 'ordewell/old/integration' }],
          tasks: { t2: record('t2', 2, 'conflict'), t1: record('t1', 1, 'merged') },
        },
        resolvers: {},
      },
    }, 'goal', '/repo', { persist: false });

    expect(session.isolationView()).toEqual({
      tasks: {
        t1: { state: 'integrated', branch: 'ordewell/old/1-t1', worktree: '/wt/1', repos: ['.'] },
        t2: { state: 'conflict', branch: 'ordewell/old/2-t2', worktree: '/wt/2', repos: [], conflictRepo: '.' },
      },
      handoff: {
        repos: [{ path: '.', integrationBranch: 'ordewell/old/integration', baseRef: 'abc', landed: [{ taskId: 't1', order: 1, title: 'Task t1' }] }],
        landed: [{ taskId: 't1', order: 1, title: 'Task t1' }],
      },
    });
  });

  it('has no isolation to describe for a plan that never isolated', () => {
    const { session } = setup();
    session.loadPlan(plan([task('t1', 1)]), 'goal', '/repo', { persist: false });

    expect(session.isolationView()).toBeNull();
  });

  it('adopts without writing: a host that restores with persist off keeps its one session file', async () => {
    const { session, isolation } = setup();
    const restored: LegacyPlanState = {
      ...plan([task('t1', 1)]),
      isolation: {
        run: {
          id: 'old', workspaceRoot: process.cwd(), shared: [], sharedRepos: [], tasks: {},
          repos: [{ path: '.', root: process.cwd(), baseRef: 'abc', integrationBranch: 'ordewell/old/integration' }],
        },
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

      expect(await session.mergeRun()).toEqual({ outcome: 'merged' });
      expect(isolation.calls.map((c) => c.op)).toContain('mergeIntoCheckedOut');
    });

    it('tells every surface what Merge all did, down to each repository that blocked it', async () => {
      const { session, isolation, messages } = await landed();
      const result: IsolationMergeResult = { outcome: 'blocked', blocked: [{ repo: 'web', reason: 'conflict', files: ['web.txt'] }] };
      isolation.mergeResult = result;

      expect(await session.mergeRun()).toEqual(result);
      expect(messages.at(-1)).toEqual({ type: 'isolation_merge', result });
    });

    it('saves the run with its landing before anything merges, and again once it has landed', async () => {
      const { session, isolation, pass } = setup();
      const t1 = task('t1', 1);
      session.loadPlan(plan([t1]), 'goal', '/repo');
      await session.executePlan();
      const openMerge = isolation.holdIntegration('t1');

      pass(t1);
      await vi.waitFor(() => expect(saved()!.isolation?.run.landing).toEqual({ taskId: 't1', tips: { '.': 'tip-.' } }));

      openMerge();
      await vi.waitFor(() => expect(saved()!.isolation?.run.tasks.t1.status).toBe('merged'));
      expect(saved()!.isolation?.run.landing).toBeUndefined();
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

  it('asks a resolver to merge the conflicted branch in every repository the task changed, naming where it conflicted', async () => {
    const isolation = new FakeWorktreeIsolation();
    isolation.repos = ['api', 'web'];
    isolation.outcomes.set('t1', 'conflict');
    isolation.stopsIn.set('t1', 'web');
    const { session, pass } = setup(isolation);
    const t1 = task('t1', 1);
    session.loadPlan(plan([t1]), 'goal', '/group');
    await session.executePlan();
    pass(t1);
    await vi.waitFor(() => expect(session.getTask('t1')!.status).toBe('awaiting_user'));

    await session.resolveConflictAsTask('t1');

    const { prompt } = session.planTasks[1];
    expect(prompt).toContain('conflicted in web');
    expect(prompt).toContain('In each repository the task changed — api, web — run `git merge --no-ff ordewell/run1/1-t1`');
  });

  it('refuses to resolve a task that did not conflict', async () => {
    const { session } = setup();
    session.loadPlan(plan([task('t1', 1)]), 'goal', '/repo');
    await expect(session.resolveConflictAsTask('t1')).rejects.toThrow(/conflict/i);
  });

  describe('beside the planner conversation', () => {
    const talk = (...exchanges: [string, string][]) => exchanges.flatMap(([user, reply], i) => [
      { role: 'user' as const, content: user, timestamp: `2026-01-01T00:00:0${2 * i}Z` },
      { role: 'assistant' as const, content: reply, timestamp: `2026-01-01T00:00:0${2 * i + 1}Z` },
    ]);
    const read = (tasks: string[]): ConversationTurn => ({ kind: 'task_query', query: { tasks, fields: ['output'], catalog: false }, text: '', researchLog: [] });
    const say = (text: string): ConversationTurn => ({ kind: 'message', text, researchLog: [] });

    /** One task landed, one conflicted: a run record with something to lose. */
    async function settledRun(continueConversation: IAiService['continueConversation']) {
      const isolation = new FakeWorktreeIsolation();
      isolation.outcomes.set('t2', 'conflict');
      const env = setup(isolation, { continueConversation, hasActiveConversation: () => true });
      const t1 = task('t1', 1);
      const t2 = task('t2', 2);
      env.session.loadPlan({
        ...plan([t1, t2]),
        conversationHistory: talk(['goal', 'Plan generated.'], ['split task 2', 'Done.'], ['rename it', 'Renamed.'], ['and test it', 'Added.']),
      }, 'goal', '/repo');
      await env.session.executePlan();
      env.pass(t1);
      env.pass(t2);
      await vi.waitFor(() => expect(env.session.getTask('t2')!.status).toBe('awaiting_user'));
      return env;
    }

    it('leaves the run record and every task\'s isolation as they are through a rewind and a compaction', async () => {
      const { session, lastStatus } = await settledRun(vi.fn().mockResolvedValue(say('<conversation_summary>A goal, split and renamed.</conversation_summary>')));
      const record = structuredClone(saved()!.isolation);
      const marks = lastStatus()!.tasks.map((t) => [t.id, t.status, t.isolation]);
      expect(marks.map(([, , i]) => (i as { state: string }).state)).toEqual(['integrated', 'conflict']);

      session.rewindConversation(6);
      expect(saved()!.conversationHistory).toHaveLength(6);
      expect(saved()!.isolation).toEqual(record);

      await session.compactConversation();
      expect(saved()!.conversationHistory![0].kind).toBe('compaction');
      expect(saved()!.isolation).toEqual(record);
      expect(lastStatus()!.tasks.map((t) => [t.id, t.status, t.isolation])).toEqual(marks);
    });

    it('reads a task running in its worktree from its live output, and points a conflicted task at its verdict instead', async () => {
      const continueConversation = vi.fn().mockResolvedValueOnce(read(['#2', '#3'])).mockResolvedValueOnce(say('ok'));
      const { session, spawn, sessions } = await settledRun(continueConversation);
      // The run is paused on the conflict, not over, so it picks the new task up at once.
      await session.addTask({ title: 'Task t3', prompt: 'do t3' });
      expect(spawn.mock.calls.at(-1)![0].cwd).toMatch(/^\/fake-worktrees\/run1\/3-/);
      sessions.at(-1)!.emitOutput('building in the worktree\n');

      await session.continueConversation('how are tasks 2 and 3 doing?');

      const answer = String(continueConversation.mock.calls[1][0]);
      const [conflicted, running] = answer.split(/^#3 /m);
      expect(conflicted).toMatch(/\[awaiting_user\]/);
      expect(conflicted).toMatch(/not running — read "outputSummary" and "verdict"/);
      expect(running).toMatch(/output: \(running;/);
      expect(running).toContain('building in the worktree');
    });
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

      const lone = { repos: ['.'], shared: [] };
      expect(startConversation).toHaveBeenCalledWith(expect.objectContaining({ isolatedExecution: lone }));
      expect(generate).toHaveBeenCalledWith(expect.objectContaining({ modes: expect.objectContaining({ isolatedExecution: lone }) }));
    });

    it('describes a repo group to the planner: its repositories and the paths its tasks share', async () => {
      const layout = { repos: ['api', 'web'], shared: ['NOTES.md'] };
      const { session, startConversation, generate } = planning({ active: true, ...layout });

      await session.startPlanning('goal', ['claude-code']);
      await session.generatePlan('goal', ['claude-code']);

      expect(startConversation).toHaveBeenCalledWith(expect.objectContaining({ isolatedExecution: layout }));
      expect(generate).toHaveBeenCalledWith(expect.objectContaining({ modes: expect.objectContaining({ isolatedExecution: layout }) }));
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
