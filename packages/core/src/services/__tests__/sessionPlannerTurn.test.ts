import { describe, it, expect, vi } from 'vitest';
import type { LegacyPlanState } from '../../models/Task';
import type { ConversationTurn } from '../AiService';
import { PlannerTurnDiscardedError, PlannerTurnStoppedError } from '../PlannerConversation';
import { makeSession, saves, testWorkspace } from './sessionTestKit';

function dialogue(goal: string): LegacyPlanState {
  return {
    tasks: [],
    generatedAt: '2026-01-01T00:00:00Z',
    status: 'draft',
    runners: ['claude-code'],
    lastUpdated: '2026-01-01T00:00:00Z',
    conversationHistory: [
      { role: 'user', content: goal, timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Which formats?', timestamp: '2026-01-01T00:00:01Z' },
    ],
  };
}

/** A live planner whose replies the test hands back one at a time. */
function heldPlanner() {
  const calls: { finish: (turn: ConversationTurn) => void; signal?: AbortSignal }[] = [];
  const aiService = {
    hasActiveConversation: () => true,
    continueConversation: vi.fn((_m: string, _p: unknown, signal?: AbortSignal) => new Promise<ConversationTurn>((resolve) => {
      calls.push({ finish: resolve, signal });
    })),
  };
  return { aiService, calls };
}

const message = (text: string): ConversationTurn => ({ kind: 'message', text, researchLog: [] });

describe('Session planner turn', () => {
  it('is busy from the message to the settled reply, and takes a second message sent meanwhile in the next turn', async () => {
    const { aiService, calls } = heldPlanner();
    const session = makeSession({ aiService });
    session.loadPlan(dialogue('parser'), 'parser', testWorkspace, { persist: false });

    expect(session.isPlannerBusy).toBe(false);
    const turn = session.continueConversation('JSON');
    expect(session.isPlannerBusy).toBe(true);
    const next = session.continueConversation('and YAML');
    expect(aiService.continueConversation).toHaveBeenCalledTimes(1);

    calls[0].finish(message('Noted'));
    await turn;
    await vi.waitFor(() => expect(aiService.continueConversation).toHaveBeenCalledTimes(2));
    expect(String(aiService.continueConversation.mock.calls[1][0])).toMatch(/and YAML$/);
    calls[1].finish(message('Noted too'));
    await next;
    expect(session.isPlannerBusy).toBe(false);
  });

  it('stops the turn in flight without the caller holding a signal, and has nothing to stop once idle', async () => {
    const { aiService, calls } = heldPlanner();
    const session = makeSession({ aiService });
    session.loadPlan(dialogue('parser'), 'parser', testWorkspace, { persist: false });

    const turn = session.continueConversation('JSON');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(session.abortPlannerTurn()).toBe(true);
    expect(calls[0].signal?.aborted).toBe(true);

    calls[0].finish({ kind: 'message', text: 'Stopped.', researchLog: [], aborted: true });
    await turn;
    expect(session.abortPlannerTurn()).toBe(false);
  });

  it('stops the turn in flight and the message queued behind it on a disk that refuses the save', async () => {
    const { aiService, calls } = heldPlanner();
    const session = makeSession({ aiService });
    session.loadPlan(dialogue('parser'), 'parser', testWorkspace, { persist: false });

    const turn = session.continueConversation('JSON');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const queued = session.continueConversation('and YAML');
    const refusedQueued = expect(queued).rejects.toThrow(PlannerTurnStoppedError);
    saves(session).mockImplementation(() => { throw new Error('disk full'); });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(session.abortPlannerTurn()).toBe(true);
    expect(calls[0].signal?.aborted).toBe(true);
    await refusedQueued;

    calls[0].finish({ kind: 'message', text: 'Stopped.', researchLog: [], aborted: true });
    // What the stopped turn said was not saved, so it lands as nothing but its stop.
    await expect(turn).rejects.toThrow(PlannerTurnStoppedError);
    logged.mockRestore();
    expect(aiService.continueConversation).toHaveBeenCalledTimes(1);
  });

  it('stops the whole subtree on a disk that refuses the save', async () => {
    const { aiService, calls } = heldPlanner();
    const session = makeSession({ aiService });
    session.loadPlan(dialogue('parser'), 'parser', testWorkspace, { persist: false });

    const turn = session.continueConversation('JSON');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const queued = session.continueConversation('and YAML');
    const refusedQueued = expect(queued).rejects.toThrow(PlannerTurnStoppedError);
    saves(session).mockImplementation(() => { throw new Error('disk full'); });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const stopped = session.stopSubtree();
    expect(calls[0].signal?.aborted).toBe(true);
    calls[0].finish({ kind: 'message', text: 'Stopped.', researchLog: [], aborted: true });
    await expect(turn).rejects.toThrow(PlannerTurnStoppedError);
    await expect(stopped).resolves.toBeUndefined();
    await refusedQueued;
    logged.mockRestore();
  });

  it('writes nothing of a turn into the session adopted while it was in flight', async () => {
    const { aiService, calls } = heldPlanner();
    const session = makeSession({ aiService });
    session.loadPlan(dialogue('parser'), 'parser', testWorkspace, { sessionId: 'old', persist: false });

    const turn = session.continueConversation('JSON');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const adopted = dialogue('linter');
    session.loadPlan(adopted, 'linter', testWorkspace, { sessionId: 'new' });
    expect(calls[0].signal?.aborted).toBe(true);
    expect(session.isPlannerBusy).toBe(false);
    saves(session).mockClear();

    calls[0].finish(message('JSON it is.'));
    await expect(turn).rejects.toThrow(PlannerTurnDiscardedError);

    expect(session.planState!.conversationHistory!.map((m) => m.content)).toEqual(['linter', 'Which formats?']);
    expect(saves(session)).not.toHaveBeenCalled();
  });

  it('abandons the turn in flight when the session is closed', async () => {
    const { aiService, calls } = heldPlanner();
    const session = makeSession({ aiService });
    session.loadPlan(dialogue('parser'), 'parser', testWorkspace, { persist: false });

    const turn = session.continueConversation('JSON');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    session.destroy();
    saves(session).mockClear();

    calls[0].finish(message('JSON it is.'));
    await expect(turn).rejects.toThrow(PlannerTurnDiscardedError);
    expect(saves(session)).not.toHaveBeenCalled();
  });
});
