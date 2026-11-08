import { describe, it, expect, vi } from 'vitest';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import { initialState, reduce, type Action } from '../reducer';
import type { TuiState } from '../state';

/**
 * A planner turn this surface did not send — a supervisor or research wake-up,
 * a usage-limit resend, a message sent from another window, a turn a load
 * joined — reaches the TUI only on the session's standing socket. Its prose
 * must stream there as a sent turn's does, and settle where it streamed.
 */

function deps(api: Partial<OrdewellApi>, actions: Action[]): EffectDeps {
  return {
    api: api as OrdewellApi,
    workspace: '/ws',
    port: 3742,
    dispatch: (action) => actions.push(action),
    newSessionId: () => 's1',
    setEnvVar: () => {},
    saveAutonomy: () => ({ overridden: false }),
    setMouseCapture: () => {},
    hasBin: () => true,
    pipeToClipboard: () => {},
    writeTerminal: () => {},
    reviveDaemon: () => Promise.resolve(false),
    login: async () => ({ ok: true }),
    exit: () => {},
  };
}

function fold(state: TuiState, actions: Action[]): TuiState {
  return actions.reduce((current, action) => reduce(current, action).state, state);
}

/** `/load` of s2, answered with nothing running, and the socket it left following the session. */
async function loaded(): Promise<{ actions: Action[]; emit: (event: unknown) => void }> {
  const actions: Action[] = [];
  let onEvent: ((event: unknown) => void) | undefined;
  const api: Partial<OrdewellApi> = {
    followSession: vi.fn().mockImplementation((_id: string, handler: (event: unknown) => void) => {
      onEvent = handler;
      return { ready: Promise.resolve(true), ended: new Promise(() => {}), close: () => {} };
    }),
    adoptSession: vi.fn().mockResolvedValue({ plan: { tasks: [], conversationHistory: [] }, goal: 'g' }),
    getSettings: vi.fn().mockResolvedValue({}),
  };
  await runEffect({ type: 'loadSession', sessionId: 's2' }, deps(api, actions));
  return { actions, emit: (event) => onEvent!(event) };
}

const stamped = (seq: number, frame: Record<string, unknown>) => ({ ...frame, stream: 'd1', seq });
const startedAt = '2026-11-07T10:00:00.000Z';
const step = { id: 'r1', tool: 'read_file', args: '{"path":"a.ts"}', result: 'export {};', success: true, outcome: 'success', toolCallId: 'tc-1', timestamp: startedAt };

/** A wake-up turn: prose, a tool call, more prose, then the reply that settles both runs. */
const wakeUp = [
  stamped(1, { type: 'planner_turn_started', turnId: 'w1', wakeUps: ['Task 1 finished.'], startedAt }),
  stamped(2, { type: 'planner_text_delta', turnId: 'w1', segmentId: 'a', text: 'Checking ' }),
  stamped(3, { type: 'planner_text_delta', turnId: 'w1', segmentId: 'a', text: 'the result.' }),
  stamped(4, { type: 'research_step', tool: 'read_file', args: '{"path":"a.ts"}', toolCallId: 'tc-1', turnId: 'w1' }),
  stamped(5, { type: 'research_step_done', step, turnId: 'w1' }),
  stamped(6, { type: 'planner_text_delta', turnId: 'w1', segmentId: 'b', text: 'It passed.' }),
];
const settled = [
  stamped(7, {
    type: 'planner_message', content: 'Checking the result.\n\nIt passed.', timestamp: '2026-11-07T10:00:05.000Z', turnId: 'w1',
    runs: [{ segmentId: 'a', text: 'Checking the result.', startedAt }, { segmentId: 'b', text: 'It passed.', startedAt }],
  }),
  stamped(8, { type: 'planner_turn_ended', turnId: 'w1', outcome: 'message' }),
];

/** The turn's blocks as kind and text, in screen order. */
const shape = (state: TuiState) => state.conversation.blocks.flatMap((b) => {
  if (b.type === 'message' && b.role === 'planner') return [`${b.streaming ? 'streaming' : 'said'}: ${b.text}`];
  if (b.type === 'tool') return [`tool: ${b.tool}`];
  return [];
});

describe('a planner turn the TUI did not send', () => {
  it('streams its prose on the session socket while the turn runs', async () => {
    const { actions, emit } = await loaded();

    for (const event of wakeUp) emit(event);
    // The burst still held for batching goes out with the next frame of another kind.
    emit(stamped(7, { type: 'planner_liveness' }));

    // A run a tool call followed is closed; the latest one is still being written.
    expect(shape(fold(initialState({ rows: 30, cols: 100 }), actions))).toEqual([
      'said: Checking the result.',
      'tool: read_file',
      'streaming: It passed.',
    ]);
  });

  it('settles its reply in the order it streamed, the tool call between the two runs', async () => {
    const { actions, emit } = await loaded();

    for (const event of [...wakeUp, ...settled]) emit(event);

    expect(shape(fold(initialState({ rows: 30, cols: 100 }), actions))).toEqual([
      'said: Checking the result.',
      'tool: read_file',
      'said: It passed.',
    ]);
  });
});
