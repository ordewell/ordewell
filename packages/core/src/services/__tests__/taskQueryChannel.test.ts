import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { makeSession, testWorkspace } from './sessionTestKit';
import type { ConversationTurn } from '../AiService';

/**
 * A plan whose long fields are exactly what the per-turn plan block leaves out:
 * a full prompt, a MAN task's steps, and a completed task's verdict/output.
 */
function planWithBodies(): LegacyPlanState {
  return {
    tasks: [
      createTask({
        id: 'a', order: 1, title: 'Setup', description: 'Stand the schema up',
        prompt: 'Create src/db/schema.ts with the users table',
        status: 'completed', assignedRunner: 'claude-code',
        userStoriesCovered: ['As a user, I want an account, so that I can log in'],
        verdict: { outcome: 'pass', reason: 'suite green', checks: [], decidedAt: '2026-01-01T00:00:00Z' },
        outputSummary: { reviewReason: 'all checks passed', logTail: 'tests: 12 passed', capturedAt: '2026-01-01T00:00:00Z' },
      }),
      createTask({
        id: 'b', order: 2, title: 'Build', description: 'Wire the route',
        prompt: 'Add POST /login in src/routes/auth.ts', dependencies: ['a'],
        assignedRunner: 'claude-code',
      }),
      createTask({
        id: 'c', order: 3, title: 'Sign off', type: 'user', dependencies: ['b'],
        assignedRunner: 'claude-code',
        userSteps: [{ order: 1, instruction: 'Deploy to staging', completed: false }],
      }),
    ],
    generatedAt: new Date().toISOString(),
    status: 'draft',
    runners: ['claude-code'],
    lastUpdated: new Date().toISOString(),
    conversationHistory: [
      { role: 'user', content: 'build it', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Plan generated with 3 tasks.', timestamp: '2026-01-01T00:00:01Z', kind: 'plan_generated' },
    ],
  };
}

function read(body: Record<string, unknown>): ConversationTurn {
  return { kind: 'task_query', query: { tasks: [], catalog: false, ...body }, text: '', researchLog: [] } as ConversationTurn;
}

const ops = (changes: Record<string, unknown>): ConversationTurn => ({
  kind: 'task_ops',
  ops: [{ op: 'update', taskId: '#2', changes }],
  text: '', researchLog: [],
}) as ConversationTurn;

/** The message text Ordewell injected on the Nth call into the AI service. */
function sent(continueConversation: ReturnType<typeof vi.fn>, n: number): string {
  return String(continueConversation.mock.calls[n][0]);
}

describe('the task-query read channel', () => {
  it('answers a read with the named task\'s long fields, then applies the ops that follow', async () => {
    const continueConversation = vi.fn()
      .mockResolvedValueOnce(read({ tasks: ['#2'] }))
      .mockResolvedValueOnce(ops({ prompt: 'Add POST /login in src/routes/auth.ts, retrying on 429' }));
    const session = makeSession({
      aiService: { continueConversation, hasActiveConversation: () => true },
    });
    session.loadPlan(planWithBodies(), 'build it', testWorkspace, { persist: false });

    await session.continueConversation('add retry handling to task 2');

    const detail = sent(continueConversation, 1);
    expect(detail).toContain('Add POST /login in src/routes/auth.ts');
    expect(detail).toContain('Wire the route');
    expect(session.planTasks.find((t) => t.id === 'b')!.prompt).toContain('retrying on 429');
  });

  it('reads several tasks in one query, for one round-trip', async () => {
    const continueConversation = vi.fn()
      .mockResolvedValueOnce(read({ tasks: ['#1', '#2', '#3'] }))
      .mockResolvedValueOnce({ kind: 'message', text: 'here is what they do', researchLog: [] });
    const session = makeSession({
      aiService: { continueConversation, hasActiveConversation: () => true },
    });
    session.loadPlan(planWithBodies(), 'build it', testWorkspace, { persist: false });

    await session.continueConversation('summarise all three tasks');

    expect(continueConversation).toHaveBeenCalledTimes(2);
    const detail = sent(continueConversation, 1);
    expect(detail).toContain('Create src/db/schema.ts with the users table');
    expect(detail).toContain('Add POST /login in src/routes/auth.ts');
    expect(detail).toContain('Deploy to staging');
    expect(detail).toContain('PASS — suite green');
    expect(detail).toContain('As a user, I want an account, so that I can log in');
    expect(detail).toContain('all checks passed');
  });

  it('narrows the answer to the fields the query selected', async () => {
    const continueConversation = vi.fn()
      .mockResolvedValueOnce(read({ tasks: ['#1'], fields: ['prompt'] }))
      .mockResolvedValueOnce({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: { continueConversation, hasActiveConversation: () => true },
    });
    session.loadPlan(planWithBodies(), 'build it', testWorkspace, { persist: false });

    await session.continueConversation('what does task 1 tell the agent to do?');

    const detail = sent(continueConversation, 1);
    expect(detail).toContain('Create src/db/schema.ts with the users table');
    expect(detail).not.toContain('Stand the schema up');
    expect(detail).not.toContain('suite green');
  });

  it('answers a read that names an unknown task with a reason, not silence', async () => {
    const continueConversation = vi.fn()
      .mockResolvedValueOnce(read({ tasks: ['#9'] }))
      .mockResolvedValueOnce({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: { continueConversation, hasActiveConversation: () => true },
    });
    session.loadPlan(planWithBodies(), 'build it', testWorkspace, { persist: false });

    await session.continueConversation('read task 9');

    expect(sent(continueConversation, 1)).toContain('#9: no task matches this reference');
  });

  it('answers a catalog read with labels, variants and mode descriptions — before any task exists', async () => {
    const continueConversation = vi.fn()
      .mockResolvedValueOnce(read({ catalog: true }))
      .mockResolvedValueOnce({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: {
        continueConversation,
        hasActiveConversation: () => true,
        startConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'hi', researchLog: [] }),
      },
      modelResolver: {
        modelsForRunners: vi.fn().mockResolvedValue({
          'claude-code': [
            { modelId: 'opus', modelLabel: 'Claude Opus 4', variants: [{ id: 'high', label: 'High' }, { id: 'max', label: 'Max' }] },
          ],
        }),
      },
    });

    await session.startPlanning('goal', ['claude-code']);
    expect(session.planTasks).toHaveLength(0);
    await session.continueConversation('what models can I use?');

    const catalog = sent(continueConversation, 1);
    expect(catalog).toContain('Claude Opus 4');
    expect(catalog).toContain('high');
    expect(catalog).toContain('max');
    // Mode descriptions are the half the always-on id-only block leaves out.
    expect(catalog).toMatch(/acceptEdits — .+:.+/);
    expect(catalog).toContain('(default)');
    expect(catalog).not.toContain('<task_detail>');
  });

  it('never offers a model the allowlist excludes', async () => {
    const continueConversation = vi.fn()
      .mockResolvedValueOnce(read({ catalog: true }))
      .mockResolvedValueOnce({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: {
        continueConversation,
        hasActiveConversation: () => true,
        startConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'hi', researchLog: [] }),
      },
      modelResolver: {
        modelsForRunners: vi.fn().mockResolvedValue({
          'claude-code': [
            { modelId: 'opus', modelLabel: 'Claude Opus 4', variants: [] },
            { modelId: 'haiku', modelLabel: 'Claude Haiku 4', variants: [] },
          ],
        }),
      },
      settings: () => ({ tddEnabled: false, modelAllowlist: { 'claude-code': ['haiku'] } }),
    });

    await session.startPlanning('goal', ['claude-code']);
    await session.continueConversation('what models can I use?');

    const catalog = sent(continueConversation, 1);
    expect(catalog).toContain('Claude Haiku 4');
    expect(catalog).not.toContain('Claude Opus 4');
  });

  it('allows three reads per user turn, then hands the fourth an instruction to land the turn', async () => {
    const continueConversation = vi.fn()
      .mockResolvedValueOnce(read({ tasks: ['#1'] }))
      .mockResolvedValueOnce(read({ tasks: ['#2'] }))
      .mockResolvedValueOnce(read({ tasks: ['#3'] }))
      .mockResolvedValueOnce(read({ catalog: true }))
      .mockResolvedValueOnce({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: { continueConversation, hasActiveConversation: () => true },
    });
    session.loadPlan(planWithBodies(), 'build it', testWorkspace, { persist: false });

    await session.continueConversation('look around');

    // Calls 1..3 answer reads 1..3; call 4 answers the fourth read.
    for (const n of [1, 2, 3]) {
      expect(sent(continueConversation, n), `answer ${n}`).not.toContain('Do not send another taskQuery');
    }
    expect(sent(continueConversation, 4)).toContain('Do not send another taskQuery');
    // The detail still comes back with the instruction — a refusal would leave
    // the planner editing text it has not read.
    expect(sent(continueConversation, 4)).toContain('<runner_catalog>');
  });

  it('answers an identical repeat read with the same content plus the instruction, immediately', async () => {
    const continueConversation = vi.fn()
      .mockResolvedValueOnce(read({ tasks: ['#2'] }))
      .mockResolvedValueOnce(read({ tasks: ['#2'] }))
      .mockResolvedValueOnce({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: { continueConversation, hasActiveConversation: () => true },
    });
    session.loadPlan(planWithBodies(), 'build it', testWorkspace, { persist: false });

    await session.continueConversation('read task 2');

    const first = sent(continueConversation, 1);
    const second = sent(continueConversation, 2);
    expect(first).not.toContain('Do not send another taskQuery');
    expect(second).toContain(first);
    expect(second).toContain('Do not send another taskQuery');
  });

  it('does not spend the repair budget: a read then two malformed op batches still recovers', async () => {
    const badOps = ops({ title: 'x' });
    (badOps as { ops: { taskId: string }[] }).ops[0].taskId = '#99';
    const continueConversation = vi.fn()
      .mockResolvedValueOnce(read({ tasks: ['#2'] }))
      .mockResolvedValueOnce(badOps)
      .mockResolvedValueOnce(badOps)
      .mockResolvedValueOnce(ops({ title: 'Build v2' }));
    const session = makeSession({
      aiService: { continueConversation, hasActiveConversation: () => true },
    });
    session.loadPlan(planWithBodies(), 'build it', testWorkspace, { persist: false });

    const plan = await session.continueConversation('rename task 2');

    expect(session.planTasks.find((t) => t.id === 'b')!.title).toBe('Build v2');
    const last = plan.conversationHistory![plan.conversationHistory!.length - 1];
    expect(last.content).toContain('Updated "Build"');
  });

  it('injects the answer without ever writing it to the transcript', async () => {
    const continueConversation = vi.fn()
      .mockResolvedValueOnce(read({ tasks: ['#2'] }))
      .mockResolvedValueOnce({ kind: 'message', text: 'It posts to /login.', researchLog: [] });
    const session = makeSession({
      aiService: { continueConversation, hasActiveConversation: () => true },
    });
    session.loadPlan(planWithBodies(), 'build it', testWorkspace, { persist: false });

    const plan = await session.continueConversation('what does task 2 do?');

    const transcript = plan.conversationHistory!.map((m) => m.content).join('\n');
    expect(transcript).not.toContain('<task_detail>');
    expect(transcript).not.toContain('Add POST /login in src/routes/auth.ts');
    expect(transcript).toContain('what does task 2 do?');
    expect(transcript).toContain('It posts to /login.');
  });

  // The soft limit still answers, so without a hard stop a planner that ignores
  // the instruction reads on the user's tokens until something else breaks.
  it('stops answering a planner that never lands the turn, and says so visibly', async () => {
    const continueConversation = vi.fn().mockResolvedValue(read({ tasks: ['#1'] }));
    const session = makeSession({
      aiService: { continueConversation, hasActiveConversation: () => true },
    });
    session.loadPlan(planWithBodies(), 'build it', testWorkspace, { persist: false });

    const plan = await session.continueConversation('look around');

    // One user message + six answered reads, then it stops asking.
    expect(continueConversation).toHaveBeenCalledTimes(7);
    const last = plan.conversationHistory![plan.conversationHistory!.length - 1];
    expect(last.content).toMatch(/kept asking to read tasks/i);
    expect(session.planTasks.find((t) => t.id === 'b')!.title).toBe('Build');
  });

  // A read changes nothing, so parking it behind a batch boundary would strand
  // the planner waiting on the detail it needs to write the edit being queued.
  it('answers a read immediately while execution is live, and still queues the ops that follow', async () => {
    const continueConversation = vi.fn()
      .mockResolvedValueOnce(read({ tasks: ['#3'] }))
      .mockResolvedValueOnce(ops({ title: 'Build v2' }));
    const session = makeSession({
      aiService: { continueConversation, hasActiveConversation: () => true },
    });
    session.loadPlan(planWithBodies(), 'build it', testWorkspace, { persist: false });
    await session.executePlan(); // spawns #2 and leaves it running
    expect(session.hasLiveWork).toBe(true);

    const plan = await session.continueConversation('rename task 2');

    expect(sent(continueConversation, 1)).toContain('Deploy to staging');
    expect(session.planTasks.find((t) => t.id === 'b')!.title).toBe('Build');
    expect(session.queuedCount).toBe(1);
    const last = plan.conversationHistory![plan.conversationHistory!.length - 1];
    expect(last.content).toMatch(/queued your change/i);
  });
});
