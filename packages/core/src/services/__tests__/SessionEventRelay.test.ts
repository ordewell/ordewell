import { describe, it, expect } from 'vitest';
import { SessionEventRelay } from '../SessionEventRelay';
import { PlanStore } from '../PlanStore';
import { PlannerUsageLedger } from '../PlannerUsage';
import type { SessionMessage, SessionNotice } from '../SessionMessage';
import { createTask, type LegacyPlanState, type ResearchStep } from '../../models/Task';

function plan(): LegacyPlanState {
  return { tasks: [], generatedAt: '2026-01-01T00:00:00Z', status: 'approved', runners: ['claude-code'], lastUpdated: '2026-01-01T00:00:00Z' };
}

function setup() {
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
    orchestrator: { getIdleSince: () => null, getQueuedTaskMessages: () => [], getMergeGate: () => [], mergeGateView: () => null },
    runs: { taskIsolation: () => null },
    usage,
  });
  const types = () => sent.map((m) => m.type);
  return { relay, sent, notices, store, usage, types };
}

function step(id: string, subagentId?: string): ResearchStep {
  return { id, tool: 'grep', args: 'x', result: '', success: true, outcome: 'success', timestamp: '2026-01-01T00:00:00Z', ...(subagentId ? { subagentId } : {}) };
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
    expect(sent[3]).toEqual({ type: 'execution_complete', summary: { total: 3, completed: 1, failed: 1 } });
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
      queuedMessages: [{ id: 'q1', text: '/grilling task 2', timestamp: '2026-01-01T00:00:02Z', skills: [load] }],
    };

    relay.planGenerated(p, 'goal');

    const [msg] = sent;
    expect(msg.type === 'plan_generated' && msg.plan.conversationHistory?.[1].skill).toEqual(notice);
    expect(msg.type === 'plan_generated' && msg.plan.queuedMessages).toEqual([{ id: 'q1', text: '/grilling task 2', timestamp: '2026-01-01T00:00:02Z', skills: [notice] }]);
    expect(JSON.stringify(msg)).not.toContain('Ask hard questions.');
    expect(p.conversationHistory?.[1].skill?.content).toBe('Ask hard questions.');
    expect(p.queuedMessages?.[0].skills?.[0].content).toBe('Ask hard questions.');
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

  it('folds each subagent\'s run into the research log as one group, however the stream interleaved', () => {
    const { relay } = setup();
    const p = { ...plan(), researchLog: [step('a1', 'A')] };

    relay.progress({ type: 'subagent_started', subagentId: 'A', brief: 'look at A' });
    relay.progress({ type: 'subagent_started', subagentId: 'B', brief: 'look at B' });
    relay.progress({ type: 'tool_result', step: step('b1', 'B') });
    relay.progress({ type: 'tool_result', step: step('a1', 'A') });
    relay.progress({ type: 'subagent_finished', subagentId: 'A', outcome: 'done', digest: 'A done' });
    relay.flushSubagentRuns(p);

    expect(p.researchLog.map((e) => e.id)).toEqual(['sa-A', 'a1', 'sa-B', 'b1']);
    expect(p.researchLog[0]).toMatchObject({ brief: 'look at A', outcome: 'done', digest: 'A done' });

    relay.flushSubagentRuns(p);
    expect(p.researchLog).toHaveLength(4);
  });

  it('forgets a turn\'s subagent runs it is told to drop', () => {
    const { relay } = setup();
    const p = plan();

    relay.progress({ type: 'subagent_started', subagentId: 'A', brief: 'look' });
    relay.dropSubagentRuns();
    relay.flushSubagentRuns(p);

    expect(p.researchLog).toBeUndefined();
  });
});
