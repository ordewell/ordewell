import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTask, type LegacyPlanState, type TaskStatus } from '../../models/Task';
import * as sessionStore from '../../utils/sessionStore';
import type { ConversationTurn } from '../AiService';
import { ConversationBusyError, ConversationEditError } from '../PlannerConversation';
import { makeSession } from './sessionTestKit';
import { FakeWorktreeIsolation } from '../../testing';

const GOAL = 'build me a parser';

function task(id: string, order: number, status: TaskStatus) {
  return createTask({ id, order, title: `Task ${id}`, prompt: 'do it', assignedRunner: 'claude-code', status });
}

function runningPlan(): LegacyPlanState {
  return {
    tasks: [
      { ...task('done', 1, 'completed'), verdict: { outcome: 'pass', reason: 'marker seen', checks: [], decidedAt: '2026-01-01T00:01:00Z' } },
      { ...task('running', 2, 'in_progress'), outputSummary: { reviewReason: 'mid-run', logTail: '…', capturedAt: '2026-01-01T00:02:00Z' } },
      task('checkpoint', 3, 'awaiting_user'),
      task('broken', 4, 'failed'),
      task('later', 5, 'pending'),
    ],
    generatedAt: '2026-01-01T00:00:00Z',
    status: 'running',
    runners: ['claude-code'],
    lastUpdated: '2026-01-01T00:00:00Z',
    conversationHistory: [
      { role: 'user', content: GOAL, timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Plan generated with 5 tasks.', timestamp: '2026-01-01T00:00:01Z', kind: 'plan_generated' },
      { role: 'user', content: 'rename task 5', timestamp: '2026-01-01T00:00:02Z' },
    ],
    researchLog: [{ id: 'up-1', type: 'user_prompt', content: GOAL, timestamp: '2026-01-01T00:00:00Z' }],
    queuedMessages: [{ id: 'q-1', text: 'rename task 5', timestamp: '2026-01-01T00:00:02Z' }],
  };
}

describe('Session.forkConversation', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-fork-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  /** A session adopted from the real store, so the fork is read back the way a surface reads it. */
  function adoptedSession() {
    const session = makeSession();
    vi.mocked(sessionStore.saveSession).mockRestore();
    const saved = sessionStore.saveSession(runningPlan(), GOAL, workspace, 'session-original');
    session.loadPlan(sessionStore.loadSession(saved.id, workspace)!.plan, GOAL, workspace, { sessionId: saved.id });
    return session;
  }

  it('persists a new session carrying the conversation and the task list', () => {
    const session = adoptedSession();

    const fork = session.forkConversation();

    expect(fork.sessionId).not.toBe('session-original');
    const saved = sessionStore.loadSession(fork.sessionId, workspace)!;
    expect(saved.meta.goal).toBe(GOAL);
    expect(saved.plan.conversationHistory!.map((m) => m.content)).toEqual([GOAL, 'Plan generated with 5 tasks.', 'rename task 5']);
    expect(saved.plan.researchLog).toEqual(runningPlan().researchLog);
    expect(saved.plan.tasks.map((t) => t.id)).toEqual(['done', 'running', 'checkpoint', 'broken', 'later']);
    expect(saved.plan.runners).toEqual(['claude-code']);
  });

  it('leaves the original session, its file and its live planner context untouched', () => {
    const reset = vi.fn();
    const session = makeSession({ aiService: { reset, hasActiveConversation: () => true } });
    vi.mocked(sessionStore.saveSession).mockRestore();
    sessionStore.saveSession(runningPlan(), GOAL, workspace, 'session-original');
    session.loadPlan(sessionStore.loadSession('session-original', workspace)!.plan, GOAL, workspace, { sessionId: 'session-original' });
    reset.mockClear();
    const before = sessionStore.loadSession('session-original', workspace)!.plan;

    session.forkConversation();

    expect(session.sessionId).toBe('session-original');
    expect(sessionStore.loadSession('session-original', workspace)!.plan).toEqual(before);
    expect(session.planState!.conversationHistory).toHaveLength(3);
    expect(reset).not.toHaveBeenCalled();
  });

  it('carries no run: in-flight and checkpointed tasks become pending, finished ones keep their outcome, queued edits stay behind', () => {
    const session = makeSession();
    session.loadPlan(runningPlan(), GOAL, workspace, { sessionId: 'session-original', persist: false });
    // Adoption re-arms failed tasks, so a failure only exists the way a run leaves one.
    session.planTasks.find((t) => t.id === 'broken')!.status = 'failed';
    vi.mocked(sessionStore.saveSession).mockRestore();

    const fork = session.forkConversation();

    const saved = sessionStore.loadSession(fork.sessionId, workspace)!.plan;
    expect(saved.tasks.map((t) => [t.id, t.status])).toEqual([
      ['done', 'completed'], ['running', 'pending'], ['checkpoint', 'pending'], ['broken', 'failed'], ['later', 'pending'],
    ]);
    expect(saved.tasks[0].verdict?.reason).toBe('marker seen');
    expect(saved.tasks[1].outputSummary).toBeUndefined();
    expect(saved.queuedMessages).toBeUndefined();
    expect(session.planTasks.map((t) => t.status)).toEqual(['completed', 'in_progress', 'awaiting_user', 'failed', 'pending']);
  });

  it('leaves the isolation run and its branches with the original plan', async () => {
    const session = makeSession({ isolation: new FakeWorktreeIsolation() });
    const plan = runningPlan();
    plan.tasks = [task('first', 1, 'pending')];
    delete plan.queuedMessages;
    session.loadPlan(plan, GOAL, workspace, { sessionId: 'session-original', persist: false });
    await session.executePlan();
    const persisted = vi.mocked(sessionStore.saveSession).mock.calls.at(-1)![0];
    expect(persisted.isolation?.run.tasks.first.branch).toBeTruthy();
    vi.mocked(sessionStore.saveSession).mockRestore();

    const fork = session.forkConversation();

    // The original was never written to disk here, so everything in the store is the fork.
    const dir = path.join(workspace, '.ordewell', 'sessions');
    const raw = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    expect(sessionStore.loadSession(fork.sessionId, workspace)!.plan.isolation).toBeUndefined();
    expect(raw).not.toContain(persisted.isolation!.run.repos[0].integrationBranch);
    expect(raw).not.toContain(persisted.isolation!.run.tasks.first.workspace);
  });

  it('carries the condensed transcript when forked after a compaction, and the fork rewinds no further than its summary', async () => {
    const summaryTurn: ConversationTurn = { kind: 'message', text: '<conversation_summary>A parser; task 5 renamed.</conversation_summary>', researchLog: [] };
    const session = makeSession({
      aiService: { hasActiveConversation: () => true, continueConversation: vi.fn().mockResolvedValue(summaryTurn) },
    });
    const plan = runningPlan();
    plan.conversationHistory!.push(
      { role: 'assistant', content: 'Renamed.', timestamp: '2026-01-01T00:00:03Z' },
      { role: 'user', content: 'and add CSV', timestamp: '2026-01-01T00:00:04Z' },
      { role: 'assistant', content: 'Added.', timestamp: '2026-01-01T00:00:05Z' },
    );
    session.loadPlan(plan, GOAL, workspace, { sessionId: 'session-original', persist: false });
    await session.compactConversation();
    vi.mocked(sessionStore.saveSession).mockRestore();

    const fork = session.forkConversation();

    const forked = sessionStore.loadSession(fork.sessionId, workspace)!.plan;
    expect(forked.conversationHistory).toEqual(session.planState!.conversationHistory);
    expect(forked.conversationHistory![0]).toMatchObject({ kind: 'compaction', content: expect.stringContaining('task 5 renamed') });
    const adopted = makeSession();
    adopted.loadPlan(forked, GOAL, workspace, { sessionId: fork.sessionId, persist: false });
    expect(adopted.rewindTargets().map((t) => t.preview)).toEqual(['rename task 5', 'and add CSV']);
    expect(() => adopted.rewindConversation(0)).toThrow(/condensed/);
  });

  it('forks again from either side', () => {
    const session = adoptedSession();
    const first = session.forkConversation();

    const second = session.forkConversation();
    const forkOfFork = makeSession();
    vi.mocked(sessionStore.saveSession).mockRestore();
    forkOfFork.loadPlan(sessionStore.loadSession(first.sessionId, workspace)!.plan, GOAL, workspace, { sessionId: first.sessionId });
    const third = forkOfFork.forkConversation();

    const ids = new Set(['session-original', first.sessionId, second.sessionId, third.sessionId]);
    expect(ids.size).toBe(4);
    expect(sessionStore.listSessions(workspace)).toHaveLength(4);
    expect(sessionStore.loadSession(third.sessionId, workspace)!.plan.conversationHistory).toHaveLength(3);
  });

  it('refuses while a planner turn is in flight', async () => {
    let finish: (turn: ConversationTurn) => void = () => {};
    const session = makeSession({
      aiService: {
        hasActiveConversation: () => true,
        continueConversation: vi.fn(() => new Promise<ConversationTurn>((resolve) => { finish = resolve; })),
      },
    });
    session.loadPlan(runningPlan(), GOAL, workspace, { persist: false });

    const turn = session.continueConversation('and a CSV reader');
    expect(() => session.forkConversation()).toThrow(ConversationBusyError);

    finish({ kind: 'message', text: 'Noted', researchLog: [] });
    await turn;
    expect(() => session.forkConversation()).not.toThrow();
  });

  it('refuses with no conversation to fork', () => {
    expect(() => makeSession().forkConversation()).toThrow(ConversationEditError);
  });
});
