import { describe, it, expect, vi } from 'vitest';
import type { ConversationRequest, ConversationTurn } from '../AiService';
import { makeSession, saves } from './sessionTestKit';

/**
 * A session is saved once its first message is admitted, not when the
 * planner's first turn lands: a surface lists it at once, and a first turn
 * that fails or is stopped leaves it with its goal, and the error, rather
 * than nothing at all.
 */

const GOAL = 'Add a --shout option to hello.py';

function heldOpening() {
  const turns: { req: ConversationRequest; finish: (turn: ConversationTurn) => void; fail: (err: Error) => void }[] = [];
  const startConversation = vi.fn((req: ConversationRequest) => new Promise<ConversationTurn>((resolve, reject) => {
    turns.push({ req, finish: resolve, fail: reject });
    req.signal?.addEventListener('abort', () => resolve({ kind: 'message', text: '', researchLog: [], aborted: true }), { once: true });
  }));
  const session = makeSession({
    aiService: { startConversation, hasActiveConversation: () => false, reset: vi.fn() },
    modelResolver: { modelsForRunners: vi.fn(async () => ({ 'claude-code': [{ modelId: 'claude-sonnet-4', modelLabel: 'Claude Sonnet 4', variants: [] }] })) },
  });
  return { session, turns };
}

/** The opening, its first turn held: wrapped, since an awaited promise would wait for the turn itself. */
async function opened(env: ReturnType<typeof heldOpening>): Promise<{ opening: Promise<unknown> }> {
  const opening = env.session.startPlanning(GOAL, ['claude-code']);
  void opening.catch(() => {});
  await vi.waitFor(() => expect(env.turns).toHaveLength(1));
  return { opening };
}

const lastSave = (env: ReturnType<typeof heldOpening>) => {
  const call = saves(env.session).mock.calls.at(-1);
  if (!call) throw new Error('nothing was saved');
  return { plan: call[0], goal: call[1] };
};

const said = (env: ReturnType<typeof heldOpening>) => (lastSave(env).plan.conversationHistory ?? []).map((m) => `${m.role}${m.kind ? `:${m.kind}` : ''}: ${m.content}`);

describe('a session\'s first message', () => {
  it('is saved, its goal waiting, while the planner\'s first turn is still in flight', async () => {
    const env = heldOpening();
    await opened(env);

    const { plan, goal } = lastSave(env);
    expect(goal).toBe(GOAL);
    expect(plan.pendingTurns?.map((t) => [t.source, t.text])).toEqual([['user', GOAL]]);
    expect(plan.conversationHistory ?? []).toEqual([]);
  });

  it('lands once: the save that carries the reply holds the goal once, and nothing waiting', async () => {
    const env = heldOpening();
    const { opening } = await opened(env);

    env.turns[0].finish({ kind: 'message', text: 'Which greeting?', researchLog: [] });
    await opening;

    expect(said(env)).toEqual([`user: ${GOAL}`, 'assistant: Which greeting?']);
    expect(lastSave(env).plan.pendingTurns ?? []).toEqual([]);
  });

  it('keeps the goal and the error when the first turn fails after it started', async () => {
    const env = heldOpening();
    const { opening } = await opened(env);

    env.turns[0].fail(new Error('claude exited with code 1: the planner crashed'));
    await expect(opening).rejects.toThrow('the planner crashed');

    expect(said(env)).toEqual([`user: ${GOAL}`, 'assistant:error: claude exited with code 1: the planner crashed']);
    expect(lastSave(env).plan.pendingTurns ?? []).toEqual([]);
    expect(env.session.planState?.conversationHistory?.map((m) => m.content)).toEqual([GOAL, 'claude exited with code 1: the planner crashed']);
  });

  it('keeps the goal when the user stops the first turn', async () => {
    const env = heldOpening();
    const { opening } = await opened(env);

    expect(env.session.abortPlannerTurn()).toBe(true);
    // Settled, the stopped opening hands back the session's plan: the daemon keeps it for a reply.
    await opening.catch(() => {});

    expect(said(env)).toEqual([`user: ${GOAL}`, 'assistant: (Stopped before replying.)']);
    expect(lastSave(env).plan.pendingTurns ?? []).toEqual([]);
  });

  it('a reply after a failed first turn continues the conversation on the goal', async () => {
    const env = heldOpening();
    const { opening } = await opened(env);
    env.turns[0].fail(new Error('the planner crashed'));
    await expect(opening).rejects.toThrow();

    const reply = env.session.continueConversation('Try again');
    await vi.waitFor(() => expect(env.turns).toHaveLength(2));
    const history = (env.turns[1].req.priorHistory ?? []).map((m) => m.content);
    expect(history).toContain(GOAL);
    expect(history.join('\n')).not.toContain('the planner crashed');
    env.turns[1].finish({ kind: 'message', text: 'Planning it now.', researchLog: [] });
    await reply;

    expect(said(env)).toEqual([`user: ${GOAL}`, 'assistant:error: the planner crashed', 'user: Try again', 'assistant: Planning it now.']);
  });
});
