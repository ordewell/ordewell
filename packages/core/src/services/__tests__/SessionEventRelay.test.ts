import { describe, it, expect } from 'vitest';
import { SessionEventRelay } from '../SessionEventRelay';
import { PlanStore } from '../PlanStore';
import { PlannerUsageLedger } from '../PlannerUsage';
import type { SessionMessage, SessionNotice } from '../SessionMessage';
import { createTask, type LegacyPlanState } from '../../models/Task';

function plan(): LegacyPlanState {
  return { tasks: [], generatedAt: '2026-01-01T00:00:00Z', status: 'approved', runners: ['claude-code'], lastUpdated: '2026-01-01T00:00:00Z' };
}

function setup(holds: ReadonlyMap<string, string> = new Map()) {
  const sent: SessionMessage[] = [];
  const notices: SessionNotice[] = [];
  const store = new PlanStore();
  store.load([
    createTask({ id: 't1', order: 1, title: 'First', prompt: 'a', status: 'completed' }),
    createTask({ id: 't2', order: 2, title: 'Second', prompt: 'b', status: 'failed' }),
    createTask({ id: 't3', order: 3, title: 'Third', prompt: 'c' }),
  ], ['claude-code']);
  // Loading re-arms a failed task; a run is what leaves one failed.
  store.markFailed('t2');
  const usage = new PlannerUsageLedger();
  const relay = new SessionEventRelay({
    broadcast: (m) => sent.push(m),
    onNotice: (n) => notices.push(n),
    store,
    orchestrator: { getIdleSince: () => null, getCompletionReceipt: () => null, getToolsAttaching: () => null, getQueuedTaskMessages: () => [], getMergeGate: () => [], holdReason: (id) => holds.get(id) ?? null, runMergeView: () => null, activity: { starting: false, running: false, scheduled: false, resumable: false, advancesOnItsOwn: false }, taskIsolation: () => null },
    usage,
  });
  const types = () => sent.map((m) => m.type);
  return { relay, sent, notices, store, usage, types };
}

describe('SessionEventRelay', () => {
  it('announces task status and brings the plan object up to date first', () => {
    const { relay, sent } = setup();
    const p = plan();

    relay.status(p);

    expect(p.tasks.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    expect(sent).toHaveLength(1);
    const [update] = sent;
    expect(update.type === 'status_update' && update.tasks.map((t) => t.status)).toEqual(['completed', 'failed', 'pending']);
  });

  it('carries a task\'s hold reason to every surface', () => {
    const { relay, sent } = setup(new Map([['t3', 'could not connect to Ordewell\'s tools; start it again']]));

    relay.status(plan());

    const [update] = sent;
    expect(update.type === 'status_update' && update.tasks.find((t) => t.id === 't3')?.holdReason)
      .toBe('could not connect to Ordewell\'s tools; start it again');
  });

  it('carries what marks a research task to every surface', () => {
    const { relay, sent, store } = setup();
    store.update('t3', { research: true });

    relay.status(plan());

    const [update] = sent;
    const third = update.type === 'status_update' ? update.tasks.find((t) => t.id === 't3') : undefined;
    expect(third).toMatchObject({ research: true });
    expect(update.type === 'status_update' && update.tasks.find((t) => t.id === 't1')).not.toHaveProperty('research');
  });

  it('saves and broadcasts an attempt’s session billing even when its runner reports no cost', () => {
    const { relay, sent, store } = setup();
    const p = plan();
    store.startAttemptUsage('t1', 1, 'codex', '2026-10-17T18:00:00Z');
    store.recordAttemptUsage('t1', 1, { source: 'codex', aggregate: true, sessionBilling: { type: 'subscription', plan: 'plus' } }, '2026-10-17T18:00:01Z');
    relay.status(p);
    expect(p.tasks[0].attemptUsage?.[0].sessionBilling).toEqual({ type: 'subscription', plan: 'plus' });
    expect(p.tasks[0].attemptUsage?.[0].totals.reportedCost).toBeUndefined();
    expect(sent[0]).toMatchObject({ type: 'status_update', tasks: [{ id: 't1', attemptUsage: [{ sessionBilling: { type: 'subscription', plan: 'plus' }, totals: {} }] }, { id: 't2' }, { id: 't3' }] });
  });

  it('says nothing about tasks when there is no plan', () => {
    const { relay, sent } = setup();
    const observer = relay.observer(() => null);

    relay.status(null);
    observer.onTaskChanged();
    observer.onTick();
    observer.onExecutionComplete();

    expect(sent).toEqual([]);
  });

  it('holds status updates back until released, then sends one', () => {
    const { relay, types } = setup();
    const p = plan();

    relay.holdStatus(() => {
      relay.status(p);
      relay.status(p);
      relay.holdStatus(() => relay.status(p));
    });
    expect(types()).toEqual([]);

    relay.releaseStatus(p);
    expect(types()).toEqual(['status_update']);

    relay.releaseStatus(p);
    expect(types()).toEqual(['status_update']);
  });

  it('counts the tasks a failure blocks in the run\'s summary (ADR-0034)', () => {
    const { relay, sent, store } = setup();
    store.update('t3', { dependencies: ['t2'] });

    relay.observer(() => plan()).onExecutionComplete();

    expect(sent.at(-1)).toEqual({ type: 'execution_complete', summary: { total: 3, completed: 1, failed: 1, blocked: 1, skipped: 0 } });
  });

  it('translates the orchestrator\'s events', () => {
    const { relay, sent, notices, types } = setup();
    const observer = relay.observer(() => plan());

    observer.onReviewApproved({ tasks: [] });
    observer.onCheckpoint({ taskId: 't3', taskTitle: 'Third', summary: 'look' });
    observer.onIsolationBlocked({ reason: 'dirty', repos: ['api', 'web'] });
    observer.onIsolationNotice({ level: 'warn', message: 'shared paths' });
    observer.onExecutionComplete();

    expect(types()).toEqual(['review_approved', 'checkpoint', 'isolation_blocked', 'execution_complete']);
    expect(sent[2]).toMatchObject({ repos: ['api', 'web'], message: expect.stringContaining('in api, web') });
    expect(sent[3]).toEqual({ type: 'execution_complete', summary: { total: 3, completed: 1, failed: 1, blocked: 0, skipped: 0 } });
    expect(notices).toEqual([{ type: 'notice', level: 'warn', message: 'shared paths' }]);
  });

  it('announces a plan with the turn that committed it, and only then', () => {
    const { relay, sent } = setup();

    relay.planGenerated(plan(), 'goal');
    relay.planGenerated(plan(), 'goal', 'turn-1');
    relay.planGenerated(null, 'goal');

    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toHaveProperty('turnId');
    expect(sent[1]).toMatchObject({ type: 'plan_generated', goal: 'goal', turnId: 'turn-1' });
  });

  it('announces each task\'s status, subtasks and the reason a waiting task waits included', () => {
    const { relay, sent, store } = setup();
    store.load([
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'a', status: 'completed' }),
      createTask({
        id: 't2', order: 2, title: 'Second', prompt: 'b',
        subtasks: [createTask({ id: 't2a', order: 1, title: 'Second A', prompt: 'c', status: 'completed' })],
      }),
      createTask({ id: 't3', order: 3, title: 'Third', prompt: 'd' }),
    ], ['claude-code']);
    store.markAwaitingUser('t3', 'usage-limit');
    store.setTaskResumeAt('t3', '2026-01-01T05:00:00Z');

    relay.planGenerated(plan(), 'goal');

    const [msg] = sent;
    if (msg.type !== 'plan_generated') throw new Error('expected plan_generated');
    expect(msg.plan.tasks).toMatchObject([
      { id: 't1', status: 'completed' },
      { id: 't2', status: 'pending', subtasks: [{ id: 't2a', status: 'completed' }] },
      { id: 't3', status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt: '2026-01-01T05:00:00Z' },
    ]);
    expect(msg.plan.tasks[0]).not.toHaveProperty('awaitingReason');
  });

  it('announces a plan\'s skill loads without their bodies, which stay in the session for replay', () => {
    const { relay, sent } = setup();
    const notice = { invokedBy: 'user' as const, name: 'grilling', source: 'global' as const, path: '~/.ordewell/skills/grilling/SKILL.md' };
    const load = { ...notice, content: 'Ask hard questions.' };
    const p: LegacyPlanState = {
      ...plan(),
      conversationHistory: [
        { role: 'user', content: '/grilling the plan', timestamp: '2026-01-01T00:00:01Z' },
        { role: 'user', content: '/grilling skill loaded', timestamp: '2026-01-01T00:00:01Z', kind: 'skill_load', skill: load },
      ],
      pendingTurns: [{ id: 'turn-1', source: 'user', text: '/grilling task 2', timestamp: '2026-01-01T00:00:02Z', skills: [load] }],
    };

    relay.planGenerated(p, 'goal');

    const [msg] = sent;
    expect(msg.type === 'plan_generated' && msg.plan.conversationHistory?.[1].skill).toEqual(notice);
    expect(JSON.stringify(msg)).not.toContain('Ask hard questions.');
    expect(p.conversationHistory?.[1].skill?.content).toBe('Ask hard questions.');
    expect(p.pendingTurns?.[0].skills?.[0].content).toBe('Ask hard questions.');
  });

  it('records planner usage on the shared ledger as it announces it', () => {
    const { relay, sent, usage } = setup();

    relay.progress({ type: 'usage', turnId: 'turn-1', record: { source: 'openai', inputTokens: 10, outputTokens: 5 } });

    expect(usage.hasUsage).toBe(true);
    expect(sent.map((m) => m.type)).toEqual(['planner_usage']);
  });

  it('drops streamed prose that belongs to no turn', () => {
    const { relay, sent } = setup();

    relay.progress({ type: 'text_delta', text: 'hello' });
    relay.progress({ type: 'text_retracted' });

    expect(sent).toEqual([]);
  });
});

describe('SessionEventRelay — the planner compaction in flight', () => {
  it('holds a compaction from its start to its own end, with its turn, and lets no other end clear it', () => {
    const { relay, sent } = setup();
    const at = '2026-01-01T00:00:00Z';

    relay.progress({ type: 'compaction', turnId: 'turn-1', compaction: { phase: 'started', id: 'a1', origin: 'ordewell', trigger: 'auto', at } });
    const started = sent.at(-1);
    expect(started).toEqual({ type: 'planner_compaction', turnId: 'turn-1', compaction: { phase: 'started', id: 'a1', origin: 'ordewell', trigger: 'auto', at } });
    expect(relay.currentCompaction()).toEqual(started);

    relay.progress({ type: 'compaction', turnId: 'turn-1', compaction: { phase: 'ended', id: 'n1', origin: 'native', trigger: 'auto', outcome: 'condensed', at } });
    expect(relay.currentCompaction()).toEqual(started);

    relay.progress({ type: 'compaction', turnId: 'turn-1', compaction: { phase: 'ended', id: 'a1', origin: 'ordewell', trigger: 'auto', outcome: 'pruned', at } });
    expect(relay.currentCompaction()).toBeUndefined();
    expect(sent.map((m) => m.type === 'planner_compaction' && m.compaction.id)).toEqual(['a1', 'n1', 'a1']);
  });
});
