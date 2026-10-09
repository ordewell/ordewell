import { describe, it, expect, vi, type Mock, type Mocked } from 'vitest';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import { initialState, reduce, type Action } from '../reducer';
import type { Effect } from '../reducer';
import type { SessionMessage } from '@ordewell/core';
import { DaemonError } from '../../apiClient';
import type { TuiState } from '../state';
import { chatOf, messagesOf } from './chat';

function harness(api: Partial<OrdewellApi> = {}, over: Partial<EffectDeps> = {}) {
  const actions: Action[] = [];
  const env: Record<string, string> = {};
  const exit = vi.fn();

  const deps: EffectDeps = {
    api: {
      startConversation: vi.fn().mockResolvedValue({ tasks: [] }),
      sendConversationMessage: vi.fn().mockResolvedValue({ tasks: [] }),
      executePlan: vi.fn().mockResolvedValue({ status: 'started' }),
      stopExecution: vi.fn().mockResolvedValue({ status: 'stopped' }),
      cancelPlanning: vi.fn().mockResolvedValue({ cancelled: true }),
      taskControl: vi.fn().mockResolvedValue({ ok: true }),
      markTaskComplete: vi.fn().mockResolvedValue({ ok: true }),
      markTaskIncomplete: vi.fn().mockResolvedValue({ ok: true }),
      getTaskLogAttempts: vi.fn().mockResolvedValue([]),
      getTaskLog: vi.fn().mockResolvedValue([]),
      sendTaskMessage: vi.fn().mockResolvedValue({ id: 'm1' }),
      removeQueuedTaskMessage: vi.fn().mockResolvedValue({ removed: true }),
      forceSendTaskMessage: vi.fn().mockResolvedValue({ id: 'm2' }),
      forceSendQueuedTaskMessage: vi.fn().mockResolvedValue({ sent: true }),
      interruptTask: vi.fn().mockResolvedValue({ ok: true }),
      continueTask: vi.fn().mockResolvedValue({ ok: true }),
      addTask: vi.fn().mockResolvedValue({ ok: true }),
      updateTask: vi.fn().mockResolvedValue({ ok: true }),
      removeTask: vi.fn().mockResolvedValue({ ok: true }),
      getSessions: vi.fn().mockResolvedValue([]),
      getSession: vi.fn().mockResolvedValue({ meta: { id: 's1', goal: 'g' }, plan: { tasks: [] } }),
      adoptSession: vi.fn().mockResolvedValue({ plan: { tasks: [{ id: 't1' }] }, goal: 'Rate limiting' }),
      deleteSession: vi.fn().mockResolvedValue({ ok: true }),
      getSettings: vi.fn().mockResolvedValue({}),
      updateSettings: vi.fn().mockResolvedValue({}),
      getRunners: vi.fn().mockResolvedValue({ runners: [], orchestratorModel: 'm/1' }),
      setRunnerEnabled: vi.fn().mockResolvedValue({ ok: true }),
      getModels: vi.fn().mockResolvedValue({ models: [], providers: [] }),
      streamPlanning: vi.fn().mockReturnValue({ close: vi.fn() }),
      streamExecution: vi.fn().mockImplementation((_id: string, _callback: (event: unknown) => void, onReady?: (error?: Error) => void) => {
        onReady?.();
        return Promise.resolve();
      }),
      closeExecutionStream: vi.fn(),
      ...api,
    } as OrdewellApi,
    workspace: '/ws',
    port: 3742,
    dispatch: (action) => actions.push(action),
    newSessionId: () => 'session-new',
    setEnvVar: (key, value) => { env[key] = value; },
    setMouseCapture: vi.fn(),
    // Never the real probe or the real clipboard: the defaults would put test
    // fixtures on the developer's actual clipboard.
    hasBin: () => true,
    pipeToClipboard: vi.fn(),
    writeTerminal: vi.fn(),
    reviveDaemon: vi.fn().mockResolvedValue(true),
    exit,
    ...over,
  };

  return { deps, actions, env, exit, api: deps.api as Mocked<OrdewellApi> };
}

/** The error Node hands back when nothing is listening on the daemon's port. */
function refused(): Error & { code: string } {
  return Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3742'), { code: 'ECONNREFUSED' });
}

/** The `failed`/`notice` message a run produced, or undefined if it produced none. */
function messageOf(actions: Action[], type: 'failed' | 'notice'): string | undefined {
  const match = actions.find((a): a is Extract<Action, { type: 'failed' | 'notice' }> => a.type === type);
  return match?.message;
}

/** The harness's `reviveDaemon`, typed as the mock it is. */
function reviveMock(deps: EffectDeps): Mock<() => Promise<boolean>> {
  return deps.reviveDaemon as Mock<() => Promise<boolean>>;
}

const types = (actions: Action[]) => actions.map((a) => a.type);

describe('planning', () => {
  it('allocates a session, tells the reducer, and opens the conversation', async () => {
    const h = harness();
    await runEffect({ type: 'startConversation', goal: 'ship it' }, h.deps);

    expect(h.api.startConversation).toHaveBeenCalledWith('session-new', 'ship it', undefined, '/ws', undefined);
    expect(h.actions[0]).toEqual({ type: 'sessionStarted', sessionId: 'session-new', goal: 'ship it' });
  });

  /** A harness whose planning socket the test drives from inside the REST call. */
  function streaming(call: (emit: (e: unknown) => void) => Promise<unknown>, method: 'startConversation' | 'sendConversationMessage' = 'startConversation') {
    let emit: (e: unknown) => void = () => {};
    return harness({
      streamPlanning: vi.fn().mockImplementation((_id: string, cb: (e: unknown) => void) => {
        emit = cb;
        return { close: vi.fn() };
      }),
      [method]: vi.fn().mockImplementation(() => call(emit)),
    });
  }

  /** The session messages the stream handed the reducer, in order. */
  const heard = (actions: Action[]): SessionMessage[] =>
    actions.flatMap((a) => (a.type === 'sessionMessage' ? [a.message] : []));

  it('opens the planning socket before sending the turn, so the turn\'s start is not broadcast into nothing', async () => {
    let open: () => void = () => {};
    const h = harness({
      streamPlanning: vi.fn().mockReturnValue({ close: vi.fn(), ready: new Promise<void>((resolve) => { open = resolve; }) }),
    });

    const sent = runEffect({ type: 'sendMessage', sessionId: 's1', message: 'add streaming' }, h.deps);
    await Promise.resolve();
    expect(h.api.sendConversationMessage).not.toHaveBeenCalled();

    open();
    await sent;
    expect(h.api.sendConversationMessage).toHaveBeenCalledWith('s1', 'add streaming');
  });

  it('passes the turn\'s messages to the reducer as they came, one action each', async () => {
    const step = {
      id: 'rs-1', tool: 'bash', args: '{"command":"rm -rf /"}', result: 'Command refused: writes are the runners\' job.',
      success: false, outcome: 'refused', toolCallId: 'tc-1', timestamp: '',
    };
    const h = streaming(async (emit) => {
      emit({ type: 'planner_turn_started', turnId: 't1', prompt: 'x' });
      emit({ type: 'research_step', tool: 'bash', args: '{"command":"rm -rf /"}', toolCallId: 'tc-1', turnId: 't1' });
      emit({ type: 'research_step_done', step, turnId: 't1' });
      emit({ type: 'subagent_started', subagentId: 'sa1', brief: 'look', turnId: 't1' });
      emit({ type: 'planner_usage', turnId: 't1', totals: { inputTokens: 10 } });
      emit({ type: 'planner_turn_ended', turnId: 't1', outcome: 'message' });
      return { tasks: [] };
    });

    await runEffect({ type: 'startConversation', goal: 'x' }, h.deps);

    expect(h.actions.filter((a) => a.type === 'sessionMessage')).toEqual([
      { type: 'sessionMessage', message: { type: 'planner_turn_started', turnId: 't1', prompt: 'x' }, sessionId: 'session-new' },
      { type: 'sessionMessage', message: { type: 'research_step', tool: 'bash', args: '{"command":"rm -rf /"}', toolCallId: 'tc-1', turnId: 't1' }, sessionId: 'session-new' },
      { type: 'sessionMessage', message: { type: 'research_step_done', step, turnId: 't1' }, sessionId: 'session-new' },
      { type: 'sessionMessage', message: { type: 'subagent_started', subagentId: 'sa1', brief: 'look', turnId: 't1' }, sessionId: 'session-new' },
      { type: 'sessionMessage', message: { type: 'planner_usage', turnId: 't1', totals: { inputTokens: 10 } }, sessionId: 'session-new' },
      { type: 'sessionMessage', message: { type: 'planner_turn_ended', turnId: 't1', outcome: 'message' }, sessionId: 'session-new' },
    ]);
  });

  it('surfaces a planner question the socket never delivered, from the REST reply', async () => {
    const h = harness({
      startConversation: vi.fn().mockResolvedValue({
        tasks: [],
        conversationHistory: [
          { role: 'user', content: 'x' },
          { role: 'assistant', content: 'Which database?' },
        ],
      }),
    });
    await runEffect({ type: 'startConversation', goal: 'x' }, h.deps);

    expect(heard(h.actions)).toEqual([expect.objectContaining({ type: 'planner_message', content: 'Which database?' })]);
  });

  it('speaks a reply the socket already delivered once, not twice with the REST copy', async () => {
    // The daemon broadcasts the turn and also leaves it as the plan's last
    // assistant entry; the reply is the same one thing either way.
    const h = streaming(async (emit) => {
      emit({ type: 'planner_message', content: 'Tasks updated:\n- #3 added', timestamp: 'x' });
      return {
        tasks: [],
        conversationHistory: [
          { role: 'user', content: 'add a hardening task' },
          { role: 'assistant', content: 'Tasks updated:\n- #3 added' },
        ],
      };
    }, 'sendConversationMessage');

    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'add a hardening task' }, h.deps);

    expect(heard(h.actions)).toEqual([{ type: 'planner_message', content: 'Tasks updated:\n- #3 added', timestamp: 'x' }]);
  });

  it('falls back to the REST reply when the socket delivered a different turn', async () => {
    const h = streaming(async (emit) => {
      emit({ type: 'planner_message', content: 'Looking into it.', timestamp: 'x' });
      return { tasks: [], conversationHistory: [{ role: 'assistant', content: 'Which database?' }] };
    }, 'sendConversationMessage');

    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'x' }, h.deps);

    expect(heard(h.actions).map((m) => m.type === 'planner_message' && m.content)).toEqual(['Looking into it.', 'Which database?']);
  });

  it('backfills the last spoken reply, not a skill-load entry that follows it', async () => {
    const skill = { invokedBy: 'planner' as const, name: 'review-plan', source: 'global' as const, path: '~/s', content: 'BODY' };
    const h = streaming(async () => ({
      tasks: [],
      conversationHistory: [
        { role: 'assistant', content: 'Which database?' },
        { role: 'assistant', content: 'review-plan skill loaded by planner', kind: 'skill_load', skill },
      ],
    }), 'sendConversationMessage');

    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'x' }, h.deps);

    expect(heard(h.actions).map((m) => m.type === 'planner_message' && m.content)).toEqual(['Which database?']);
  });

  it('joins a burst of one stream\'s deltas into a single action', async () => {
    vi.useFakeTimers();
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const h = streaming(async (emit) => {
        emit({ type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'Hel' });
        emit({ type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'lo' });
        await gate;
        return { tasks: [] };
      });

      const pending = runEffect({ type: 'startConversation', goal: 'x' }, h.deps);
      await vi.advanceTimersByTimeAsync(100);
      expect(heard(h.actions)).toEqual([{ type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'Hello' }]);

      release();
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps deltas of different streams apart, in the order they came', async () => {
    const h = streaming(async (emit) => {
      emit({ type: 'planner_thinking_delta', turnId: 't1', segmentId: 's1', text: 'weigh' });
      emit({ type: 'planner_thinking_delta', turnId: 't1', segmentId: 's1', text: 'ing it' });
      emit({ type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'One' });
      emit({ type: 'planner_text_delta', turnId: 't1', segmentId: 's2', text: 'Two' });
      emit({ type: 'plan_token', turnId: 't1', token: '{"ta' });
      emit({ type: 'plan_token', turnId: 't1', token: 'sks":' });
      return { tasks: [] };
    });

    await runEffect({ type: 'startConversation', goal: 'x' }, h.deps);

    expect(heard(h.actions)).toEqual([
      { type: 'planner_thinking_delta', turnId: 't1', segmentId: 's1', text: 'weighing it' },
      { type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'One' },
      { type: 'planner_text_delta', turnId: 't1', segmentId: 's2', text: 'Two' },
      { type: 'plan_token', turnId: 't1', token: '{"tasks":' },
    ]);
  });

  it('flushes a held burst before any other message lands, preserving order', async () => {
    const h = streaming(async (emit) => {
      emit({ type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'Check' });
      emit({ type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'ing' });
      emit({ type: 'research_step', tool: 'grep', args: '{"pattern":"auth"}', turnId: 't1' });
      return { tasks: [] };
    });

    await runEffect({ type: 'startConversation', goal: 'x' }, h.deps);

    expect(heard(h.actions).map((m) => m.type)).toEqual(['planner_text_delta', 'research_step']);
    expect(heard(h.actions)[0]).toMatchObject({ text: 'Checking' });
  });

  it('dispatches a burst still held when the turn fails, ahead of the failure', async () => {
    const h = streaming(async (emit) => {
      emit({ type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'Half a' });
      throw new Error('no key');
    });

    await runEffect({ type: 'startConversation', goal: 'x' }, h.deps);

    const order = h.actions.map((a) => a.type).filter((t) => t === 'sessionMessage' || t === 'failed');
    expect(order).toEqual(['sessionMessage', 'failed']);
  });

  it('a full turn replays through the reducer into the conversation it describes', async () => {
    const h = streaming(async (emit) => {
      emit({ type: 'planner_turn_started', turnId: 't1', prompt: 'x' });
      emit({ type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'Checking' });
      emit({ type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: ' the auth module' });
      emit({ type: 'research_step', tool: 'grep', args: '{"pattern":"auth"}', toolCallId: 'tc-1', turnId: 't1' });
      emit({
        type: 'research_step_done', turnId: 't1',
        step: { id: 'rs-1', tool: 'grep', args: '{"pattern":"auth"}', toolCallId: 'tc-1', success: true, outcome: 'success', result: '3 matches', timestamp: '' },
      });
      emit({ type: 'planner_text_delta', turnId: 't1', segmentId: 's2', text: 'Found it.' });
      emit({ type: 'planner_message', content: 'Found it in middleware/auth.ts.', timestamp: '', turnId: 't1' });
      emit({ type: 'planner_turn_ended', turnId: 't1', outcome: 'message' });
      return { tasks: [], conversationHistory: [] };
    });

    await runEffect({ type: 'startConversation', goal: 'x' }, h.deps);

    let state: TuiState = { ...initialState(), sessionId: 'session-new' };
    for (const action of h.actions) ({ state } = reduce(state, action));

    expect(state.conversation.blocks).toMatchObject([
      { type: 'message', role: 'user', text: 'x' },
      { type: 'message', role: 'planner', text: 'Checking the auth module', streaming: false },
      { type: 'tool', headline: { name: 'Grep', keyArg: 'auth' }, status: 'ok', output: '3 matches' },
      { type: 'message', role: 'planner', text: 'Found it in middleware/auth.ts.', streaming: false },
    ]);
  });

  it('shows a silent approval decision in the conversation instead of leaving it invisible', async () => {
    const h = streaming(async (emit) => {
      emit({ type: 'approval_decided', kind: 'shell_command', subject: 'npm test', scope: 'npm test', granted: true, source: 'pre-approved' });
      return { tasks: [] };
    });

    await runEffect({ type: 'startConversation', goal: 'x' }, h.deps);

    let state: TuiState = { ...initialState(), sessionId: 'session-new' };
    for (const action of h.actions) ({ state } = reduce(state, action));
    expect(state.conversation.blocks).toMatchObject([{ type: 'approval', subject: 'npm test', status: 'granted', decidedBy: 'pre-approved' }]);
  });

  it('hands over a committed plan', async () => {
    const plan = { tasks: [{ id: 'a', title: 'T' }] };
    const h = harness({ startConversation: vi.fn().mockResolvedValue(plan) });
    await runEffect({ type: 'startConversation', goal: 'x' }, h.deps);

    expect(h.actions).toContainEqual({ type: 'planUpdated', plan, sessionId: 'session-new' });
  });

  it('clears the optimistic session id when the very first planning call fails', async () => {
    // The daemon registers a session only after planning succeeds, so keeping
    // the id would route every following message to a session that is not there.
    const h = harness({ startConversation: vi.fn().mockRejectedValue(new Error('no key')) });
    await runEffect({ type: 'startConversation', goal: 'x' }, h.deps);

    expect(types(h.actions)).toContain('sessionCleared');
    expect(types(h.actions)).toContain('failed');
  });

  it('always closes the research stream, even when planning fails', async () => {
    const close = vi.fn();
    const h = harness({
      streamPlanning: vi.fn().mockReturnValue({ close }),
      startConversation: vi.fn().mockRejectedValue(new Error('no key')),
    });

    await runEffect({ type: 'startConversation', goal: 'x' }, h.deps);
    expect(close).toHaveBeenCalled();
    expect(h.actions).toContainEqual({ type: 'failed', message: 'no key' });
  });

  it('continues an open conversation', async () => {
    const h = harness();
    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'use bcrypt' }, h.deps);
    expect(h.api.sendConversationMessage).toHaveBeenCalledWith('s1', 'use bcrypt');
  });

  // Turn serialization moved out of the effect layer and into the reducer:
  // a prompt submitted while a turn is in flight waits in `TuiState.queuedPrompts`
  // and only emits `sendMessage` when the turn settles. See reducer.queue.test.ts.
});

describe('execution', () => {
  it('subscribes before execution so immediate task status updates reach the loading indicator', async () => {
    let onEvent: ((event: unknown) => void) | undefined;
    const h = harness({
      streamExecution: vi.fn().mockImplementation((_id: string, callback: (event: unknown) => void, onReady?: (error?: Error) => void) => {
        onEvent = callback;
        onReady?.();
        return Promise.resolve();
      }),
      executePlan: vi.fn().mockImplementation(async () => {
        // The orchestrator can start independent tasks before this request
        // resolves. Their first status update must not be lost.
        onEvent?.({ type: 'status_update', tasks: [{ id: 'a', status: 'in_progress' }] });
        return { status: 'started' };
      }),
    });

    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    expect(h.actions).toContainEqual({
      type: 'tasksStatus',
      gate: null,
      updates: { a: { status: 'in_progress', idleSince: null } },
      sessionId: 's1',
    });
  });

  it('starts the plan and follows the status stream', async () => {
    const h = harness();
    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);
    expect(h.api.executePlan).toHaveBeenCalledWith('s1');
    expect(h.api.streamExecution).toHaveBeenCalled();
  });

  /** Drive one execution with a scripted list of daemon websocket messages. */
  const withEvents = (...events: unknown[]) =>
    harness({
      streamExecution: vi.fn().mockImplementation((_id: string, cb: (e: unknown) => void, onReady?: (error?: Error) => void) => {
        onReady?.();
        for (const event of events) cb(event);
        return Promise.resolve();
      }),
    });

  it('applies a status_update, which is what the daemon actually broadcasts', async () => {
    const h = withEvents({
      type: 'status_update',
      tasks: [
        { id: 'a', status: 'completed', verdict: null },
        { id: 'b', status: 'running', verdict: null },
      ],
    });
    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    expect(h.actions).toContainEqual({
      type: 'tasksStatus',
      gate: null,
      updates: { a: { status: 'completed', idleSince: null }, b: { status: 'running', idleSince: null } },
      sessionId: 's1',
    });
  });

  it('names the task that just started in the status line', async () => {
    const h = withEvents({ type: 'task_started', taskId: 'a', order: 1, title: 'Add route', runner: 'opencode' });
    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    const started = h.actions.find((a) => a.type === 'taskStarted') as Extract<Action, { type: 'taskStarted' }>;
    expect(started).toMatchObject({ taskId: 'a', title: 'Add route', runner: 'opencode' });
  });

  it('hands a checkpoint to the reducer, which says where it can be answered', async () => {
    const h = withEvents({ type: 'checkpoint', taskId: 'a', taskTitle: 'Add route', summary: 'Wrote the handler' });
    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    expect(h.actions.find((a) => a.type === 'taskCheckpoint')).toMatchObject({ taskId: 'a', title: 'Add route', summary: 'Wrote the handler' });
  });

  it('keeps only the first line of a long checkpoint question in the notice', async () => {
    const longSummary = 'Line one of reasoning.\nLine two with more details that goes on and on and on about the checkpoint reasoning from the agent.';
    const h = withEvents({ type: 'checkpoint', taskId: 'a', taskTitle: 'Add route', summary: longSummary });
    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    const arrived = h.actions.find((a): a is Extract<Action, { type: 'taskCheckpoint' }> => a.type === 'taskCheckpoint');
    const state = reduce(initialState({ sessionId: 's1' }), arrived!).state;
    const text = messagesOf(state).at(-1)?.text ?? '';
    expect(text).not.toContain('\n');
    expect(text).toContain('· Add route asks: Line one of reasoning.');
  });

  it('asks for sign-off when the plan needs review', async () => {
    const h = withEvents({ type: 'review_needed', tasks: [] });
    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    const notice = h.actions.find((a) => a.type === 'notice') as Extract<Action, { type: 'notice' }>;
    expect(notice.message).toMatch(/approve/i);
  });

  it('takes a plan pushed over the stream, and hands its transcript to the conversation', async () => {
    const plan = { tasks: [{ id: 'a', title: 'T' }] };
    const event = { type: 'plan_generated', plan, goal: 'g', runners: [] };
    const h = withEvents(event);
    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    expect(h.actions).toEqual([
      { type: 'sessionMessage', message: event, sessionId: 's1' },
      { type: 'planUpdated', plan, sessionId: 's1' },
    ]);
  });

  it('reports the outcome when the run finishes', async () => {
    const h = withEvents({ type: 'execution_complete', summary: { total: 1, completed: 1, failed: 0 } });
    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    expect(h.actions).toContainEqual({
      type: 'executionComplete',
      summary: { total: 1, completed: 1, failed: 0 },
      sessionId: 's1',
    });
  });

  it('tells the user when the stream closes before the run reported an end', async () => {
    const h = harness({
      streamExecution: vi.fn().mockImplementation((_id: string, _cb: unknown, onReady?: (error?: Error) => void) => {
        onReady?.();
        return Promise.resolve('lost');
      }),
    });
    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    expect(h.actions).toContainEqual({ type: 'executionLost', sessionId: 's1' });
  });

  it('closes the already-open stream when the request that follows it fails', async () => {
    const h = harness({
      executePlan: vi.fn().mockRejectedValue(new Error('No plan to execute')),
    });
    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    const opened = vi.mocked(h.api.streamExecution).mock.results[0].value;
    expect(h.api.closeExecutionStream).toHaveBeenCalledWith(opened);
    expect(types(h.actions)).not.toContain('executionLost');
  });

  it('reports a stopped run too, without inventing a tally it was not sent', async () => {
    // `execution_stopped` carries no summary. While the stream was typed `any`
    // this read `event.summary` for both variants and passed undefined through.
    const h = withEvents({ type: 'execution_stopped' });
    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    const complete = h.actions.find((a) => a.type === 'executionComplete');
    expect(complete).toBeDefined();
    expect(complete).not.toHaveProperty('summary');
  });

  it('a silent approval decision reached mid-execution lands in the conversation', async () => {
    const h = withEvents({ type: 'approval_decided', kind: 'shell_command', subject: 'npm test', scope: 'npm test', granted: false, source: 'mode' });
    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    let state: TuiState = { ...initialState(), sessionId: 's1' };
    for (const action of h.actions) ({ state } = reduce(state, action));
    expect(state.conversation.blocks).toMatchObject([
      { type: 'approval', kind: 'shell_command', subject: 'npm test', status: 'denied', decidedBy: 'mode' },
    ]);
  });

  it('ignores chatter it has no use for', async () => {
    const h = withEvents({ type: 'task_output', taskId: 'a', text: 'npm test' }, { type: 'plan_token', token: 'x' });
    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);
    expect(types(h.actions)).toEqual([]);
  });

  it('stops a run', async () => {
    const h = harness();
    await runEffect({ type: 'stopExecution', sessionId: 's1' }, h.deps);
    expect(h.api.stopExecution).toHaveBeenCalledWith('s1');
  });

  it('cancels a planning turn', async () => {
    const h = harness();
    await runEffect({ type: 'cancelPlanning', sessionId: 's1' }, h.deps);
    expect(h.api.cancelPlanning).toHaveBeenCalledWith('s1');
    expect(h.actions).toContainEqual({ type: 'notice', message: 'Planning stopped.' });
  });

  it('says nothing when there was no planning turn to cancel', async () => {
    const h = harness({ cancelPlanning: vi.fn().mockResolvedValue({ cancelled: false }) });
    await runEffect({ type: 'cancelPlanning', sessionId: 's1' }, h.deps);
    expect(h.actions).toEqual([]);
  });
});

/**
 * During a run there are two live subscriptions to one session, and the daemon
 * sends every broadcast to both (see `OrchestratorPool.broadcast`). A planner
 * turn taken while the run executes therefore arrives twice, and each copy
 * must not be shown twice — one reply, one approval.
 */
describe('one planner turn on both live streams', () => {
  interface Streams {
    /** Deliver on the planning subscription. */
    planning(event: unknown): void;
    /** Deliver on the run's subscription. */
    execution(event: unknown): void;
    /** The daemon's actual fan-out: the same broadcast on both. */
    both(event: unknown): void;
  }

  /** A harness whose run stream stays open while the awaited call replays a turn through `script`. */
  function twoStreams(script: (streams: Streams) => unknown) {
    let onPlanning: (event: unknown) => void = () => {};
    let onExecution: (event: unknown) => void = () => {};
    let finishExecution: () => void = () => {};

    const h = harness({
      streamPlanning: vi.fn().mockImplementation((_id: string, cb: (event: unknown) => void) => {
        onPlanning = cb;
        return { close: vi.fn() };
      }),
      streamExecution: vi.fn().mockImplementation((_id: string, cb: (event: unknown) => void, onReady?: (error?: Error) => void) => {
        onExecution = cb;
        onReady?.();
        return new Promise<void>((resolve) => { finishExecution = resolve; });
      }),
      sendConversationMessage: vi.fn().mockImplementation(async () => script({
        planning: (event) => onPlanning(event),
        execution: (event) => onExecution(event),
        both: (event) => { onExecution(event); onPlanning(event); },
      })),
    });

    return {
      h,
      run: async (): Promise<void> => {
        const running = runEffect({ type: 'execute', sessionId: 's1' }, h.deps);
        await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'use pg' }, h.deps);
        finishExecution();
        await running;
      },
    };
  }

  const conversationOf = (actions: Action[]): TuiState => {
    let state: TuiState = { ...initialState(), sessionId: 's1' };
    for (const action of actions) ({ state } = reduce(state, action));
    return state;
  };

  it('shows the reply and the approval once, whichever subscription delivered them', async () => {
    const reply = { type: 'planner_message', content: 'Which database?', timestamp: '2026-09-27T10:00:00.000Z', turnId: 't1' };
    const decision = { type: 'approval_decided', kind: 'shell_command', subject: 'npm test', scope: 'npm test', granted: true, source: 'pre-approved' };

    const { h, run } = twoStreams((s) => {
      // The daemon commits the turn and broadcasts it before answering the
      // REST call, so both subscriptions standing at that moment carry it.
      for (const event of [reply, decision]) s.both(event);
      return {
        tasks: [],
        conversationHistory: [{ role: 'assistant', content: 'Which database?', timestamp: '2026-09-27T10:00:00.000Z' }],
      };
    });
    await run();

    expect(conversationOf(h.actions).conversation.blocks).toMatchObject([
      { type: 'message', role: 'planner', text: 'Which database?' },
      { type: 'approval', kind: 'shell_command', subject: 'npm test', status: 'granted', decidedBy: 'pre-approved' },
    ]);
  });

  it('still drops the copy when a research record lands between the two deliveries', async () => {
    const reply = { type: 'planner_message', content: 'Which database?', timestamp: '10:00:00', turnId: 't1' };
    const step = { type: 'research_step', tool: 'grep', args: '{"pattern":"db"}', toolCallId: 'c1', turnId: 't1' };

    const { h, run } = twoStreams((s) => {
      // The other subscription's copies lag behind a later record.
      s.execution(reply);
      s.execution(step);
      s.planning(reply);
      s.planning(step);
      return { tasks: [], conversationHistory: [] };
    });
    await run();

    const blocks = conversationOf(h.actions).conversation.blocks;
    expect(blocks.filter((b) => b.type === 'message' && b.role === 'planner')).toHaveLength(1);
    expect(blocks.filter((b) => b.type === 'tool')).toHaveLength(1);
  });

  it('shows the same words again when they are a new turn', async () => {
    const { h, run } = twoStreams((s) => {
      for (const at of ['10:00:00', '10:00:05']) {
        s.both({ type: 'planner_message', content: 'Done.', timestamp: at, turnId: `t-${at}` });
      }
      return { tasks: [], conversationHistory: [] };
    });
    await run();

    expect(conversationOf(h.actions).conversation.blocks.filter((b) => b.type === 'message' && b.role === 'planner')).toHaveLength(2);
  });
});

/**
 * The same run can be watched by more than one execution subscription — the
 * initial Execute holds its socket open through a review pause, and approving
 * opens another. The daemon fans every broadcast to both, so a task start
 * arrives twice and must still be shown once.
 */
describe('duplicate run subscriptions', () => {
  it('shows one task-start notice when the same start arrives on two run streams', async () => {
    const listeners: Array<(event: unknown) => void> = [];
    const settle: Array<() => void> = [];
    const h = harness({
      streamExecution: vi.fn().mockImplementation((_id: string, cb: (event: unknown) => void, onReady?: (error?: Error) => void) => {
        listeners.push(cb);
        onReady?.();
        return new Promise<void>((resolve) => { settle.push(resolve); });
      }),
    });

    const running = [
      runEffect({ type: 'execute', sessionId: 's1' }, h.deps),
      runEffect({ type: 'execute', sessionId: 's1' }, h.deps),
    ];
    await Promise.resolve();
    expect(listeners).toHaveLength(2);

    const started = { type: 'task_started', taskId: 't1', order: 1, title: 'Add route', runner: 'opencode' };
    for (const listener of listeners) listener(started);

    settle.forEach((resolve) => resolve());
    await Promise.all(running);

    expect(h.actions.filter((a) => a.type === 'taskStarted')).toHaveLength(1);
  });
});

describe('task control', () => {
  it.each([
    ['retry', 'retry'],
    ['cancel', 'cancel'],
    ['force-start', 'force-start'],
  ] as const)('%s goes to the orchestrator', async (action, segment) => {
    const h = harness();
    await runEffect({ type: 'taskAction', sessionId: 's1', taskId: 't1', action }, h.deps);
    expect(h.api.taskControl).toHaveBeenCalledWith('s1', 't1', segment);
  });

  it('completing a task marks it complete', async () => {
    const h = harness();
    await runEffect({ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'complete' }, h.deps);
    expect(h.api.markTaskComplete).toHaveBeenCalledWith('s1', 't1');
  });

  it('un-completing a task marks it not done', async () => {
    const h = harness();
    await runEffect({ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'uncomplete' }, h.deps);
    expect(h.api.markTaskIncomplete).toHaveBeenCalledWith('s1', 't1');
    expect(h.api.markTaskComplete).not.toHaveBeenCalled();
  });

  it('skipping a task marks it complete, as the VS Code extension does', async () => {
    const h = harness();
    await runEffect({ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'skip' }, h.deps);
    expect(h.api.markTaskComplete).toHaveBeenCalledWith('s1', 't1');
  });

  it('refreshes the plan after a task action so the pane matches the server', async () => {
    const h = harness();
    await runEffect({ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'retry' }, h.deps);
    expect(types(h.actions)).toContain('planUpdated');
  });

  it('a watched start subscribes before the request, so the task cannot start unobserved', async () => {
    const order: string[] = [];
    const h = harness({
      streamExecution: vi.fn().mockImplementation((_id: string, onEvent: (event: unknown) => void, onReady?: () => void) => {
        order.push('streamExecution');
        onReady?.();
        onEvent({ type: 'status_update', tasks: [{ id: 't1', status: 'in_progress' }] });
        return Promise.resolve();
      }),
      taskControl: vi.fn().mockImplementation(async () => {
        order.push('taskControl');
        return { ok: true };
      }),
    });

    await runEffect({ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'force-start', watch: true }, h.deps);

    expect(order).toEqual(['streamExecution', 'taskControl']);
    expect(h.actions).toContainEqual({
      type: 'tasksStatus',
      gate: null,
      updates: { t1: { status: 'in_progress', idleSince: null } },
      sessionId: 's1',
    });
  });

  it('leaves the stream alone for an action that spawns nothing', async () => {
    const h = harness();
    await runEffect({ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'cancel' }, h.deps);
    expect(h.api.streamExecution).not.toHaveBeenCalled();
  });

  it('adds and removes tasks', async () => {
    const h = harness();
    await runEffect({ type: 'addTask', sessionId: 's1', title: 'Docs' }, h.deps);
    expect(h.api.addTask).toHaveBeenCalledWith('s1', expect.objectContaining({ title: 'Docs' }));

    await runEffect({ type: 'removeTask', sessionId: 's1', taskId: 't1' }, h.deps);
    expect(h.api.removeTask).toHaveBeenCalledWith('s1', 't1');
  });

  it('updates a task and refreshes the plan', async () => {
    const h = harness();
    await runEffect({
      type: 'updateTask',
      sessionId: 's1',
      taskId: 't1',
      changes: { thinkingEffort: 'high' },
      message: 'Effort updated.',
    }, h.deps);

    expect(h.api.updateTask).toHaveBeenCalledWith('s1', 't1', { thinkingEffort: 'high' });
    expect(types(h.actions)).toContain('planUpdated');
    expect(h.actions).toContainEqual({ type: 'notice', message: 'Effort updated.' });
  });


});

/**
 * The daemon resolves what a planner switch's model and effort should become
 * (task 2) — the client only sends the provider and consumes what comes back.
 */
describe('planner switch', () => {
  it('shows the restored model in state without a further refresh', async () => {
    const h = harness({
      updateSettings: vi.fn().mockResolvedValue({
        orchestratorModel: 'sonnet',
        plannerThinkingEffort: 'high',
        switchRecall: { model: 'sonnet', effort: 'high', source: 'remembered' },
      }),
    });

    await runEffect({ type: 'setPlanner', provider: 'claude-code' }, h.deps);

    expect(h.actions).toContainEqual({
      type: 'settingsLoaded',
      settings: { aiProvider: 'claude-code', orchestratorModel: 'sonnet', plannerThinkingEffort: 'high' },
    });
  });

  it('says which model it restored, when the daemon remembered one', async () => {
    const h = harness({
      updateSettings: vi.fn().mockResolvedValue({
        orchestratorModel: 'sonnet',
        switchRecall: { model: 'sonnet', effort: '', source: 'remembered' },
      }),
    });

    await runEffect({ type: 'setPlanner', provider: 'claude-code' }, h.deps);

    const notice = h.actions.find((a) => a.type === 'notice') as Extract<Action, { type: 'notice' }>;
    expect(notice.message).toContain('Restored sonnet.');
  });

  it('names the catalog default and points at /model when nothing was remembered', async () => {
    const h = harness({
      updateSettings: vi.fn().mockResolvedValue({ orchestratorModel: 'sonnet', switchRecall: { model: 'sonnet', effort: '', source: 'catalog-default' } }),
    });

    await runEffect({ type: 'setPlanner', provider: 'claude-code' }, h.deps);

    const notice = h.actions.find((a) => a.type === 'notice') as Extract<Action, { type: 'notice' }>;
    expect(notice.message).toContain('default model, sonnet');
    expect(notice.message).toContain('/model');
  });

  it('keeps the "pick a model" guidance when the daemon resolved nothing', async () => {
    const h = harness({ updateSettings: vi.fn().mockResolvedValue({ orchestratorModel: '', switchRecall: { model: '', effort: '', source: 'none' } }) });

    await runEffect({ type: 'setPlanner', provider: 'claude-code' }, h.deps);

    const notice = h.actions.find((a) => a.type === 'notice') as Extract<Action, { type: 'notice' }>;
    expect(notice.message).toContain('Pick a model with /model.');
  });
});

describe('settings', () => {
  it('persists the orchestrator model to .env as well as the running daemon', async () => {
    const h = harness();
    await runEffect({ type: 'setModel', modelId: 'a/b' }, h.deps);

    expect(h.env.ORCHESTRATOR_MODEL).toBe('a/b');
    expect(h.api.updateSettings).toHaveBeenCalledWith({ orchestratorModel: 'a/b' });
  });

  it('stores an api key under that provider env var', async () => {
    const h = harness();
    await runEffect({ type: 'setApiKey', provider: 'openrouter', key: 'sk-or-1' }, h.deps);
    expect(h.env.OPENROUTER_API_KEY).toBe('sk-or-1');
  });

  it('never puts an api key in a message the transcript would show', async () => {
    const h = harness();
    await runEffect({ type: 'setApiKey', provider: 'openrouter', key: 'sk-or-secret' }, h.deps);

    const shown = h.actions.map((a) => JSON.stringify(a)).join(' ');
    expect(shown).not.toContain('sk-or-secret');
  });

  it('sets a runner allowlist', async () => {
    const h = harness();
    await runEffect({ type: 'setAllowlist', runner: 'opencode', modelIds: ['a/b'] }, h.deps);
    expect(h.api.updateSettings).toHaveBeenCalledWith({ modelAllowlist: { opencode: ['a/b'] } });
  });

  it('clearing an allowlist removes the entry rather than storing an empty list', async () => {
    const h = harness();
    await runEffect({ type: 'setAllowlist', runner: 'opencode', modelIds: [] }, h.deps);
    // null tells the daemon to delete the key; [] would linger in settings.json.
    expect(h.api.updateSettings).toHaveBeenCalledWith({ modelAllowlist: { opencode: null } });
  });

  it('enables and disables a runner', async () => {
    const h = harness();
    await runEffect({ type: 'setRunnerEnabled', runner: 'opencode', enabled: false }, h.deps);
    expect(h.api.setRunnerEnabled).toHaveBeenCalledWith('opencode', false);
    expect(types(h.actions)).toContain('runnersLoaded');
  });

  it('applies a confirmed runner set as one batch, reloading and reporting once', async () => {
    const h = harness();
    await runEffect({
      type: 'setRunners',
      changes: [
        { runner: 'claude-code', enabled: false },
        { runner: 'opencode', enabled: true },
      ],
      message: 'Runners enabled: OpenCode.',
    }, h.deps);
    expect(h.api.setRunnerEnabled.mock.calls).toEqual([['claude-code', false], ['opencode', true]]);
    expect(types(h.actions).filter((t) => t === 'runnersLoaded')).toHaveLength(1);
    expect(h.actions).toContainEqual({ type: 'notice', message: 'Runners enabled: OpenCode.' });
  });

  it('persists autonomous mode', async () => {
    const h = harness();
    await runEffect({ type: 'setAutonomous', enabled: false }, h.deps);
    expect(h.env.ORDEWELL_AUTONOMOUS_MODE).toBe('false');
    expect(h.actions).toContainEqual({ type: 'notice', message: 'Autonomy level: Guarded for new plans.' });
  });
});

describe('catalogs and sessions', () => {
  it('loads the model catalog', async () => {
    const h = harness({
      getModels: vi.fn().mockResolvedValue({
        models: [{ modelId: 'a/b', modelLabel: 'A B', runnerProvider: 'openrouter' }],
        providers: ['openrouter'],
      }),
    });
    await runEffect({ type: 'loadModels' }, h.deps);

    const loaded = h.actions.find((a) => a.type === 'modelsLoaded') as Extract<Action, { type: 'modelsLoaded' }>;
    expect(loaded.models[0]).toMatchObject({ id: 'a/b', label: 'A B' });
  });

  it('keeps runner compatibility and thinking variants in the executor catalog', async () => {
    const model = {
      modelId: 'gpt-5',
      modelLabel: 'GPT-5',
      runnerProvider: 'openai',
      variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }],
    };
    const h = harness({
      getModels: vi.fn().mockResolvedValue({
        models: [model],
        modelsByRunner: { codex: [model] },
      }),
    });
    await runEffect({ type: 'loadModels' }, h.deps);

    const loaded = h.actions.find((action) => action.type === 'modelsLoaded') as Extract<Action, { type: 'modelsLoaded' }>;
    expect(loaded.models[0]).toMatchObject({
      id: 'gpt-5',
      runners: ['codex'],
      variants: [{ id: 'low' }, { id: 'high' }],
    });
  });

  it('maps the cross-provider orchestrator catalog and provider errors', async () => {
    const h = harness({
      getModels: vi.fn().mockResolvedValue({
        models: [],
        providers: ['openrouter'],
        orchestratorModels: [
          { id: 'deepseek/v4', label: 'DeepSeek V4', provider: 'OpenRouter', pricing: '0.14/0.28' },
        ],
        providerErrors: { openai: 'boom' },
      }),
    });
    await runEffect({ type: 'loadModels' }, h.deps);

    const loaded = h.actions.find((a) => a.type === 'modelsLoaded') as Extract<Action, { type: 'modelsLoaded' }>;
    expect(loaded.orchestratorModels?.[0]).toMatchObject({
      id: 'deepseek/v4',
      label: 'DeepSeek V4',
      provider: 'OpenRouter',
      pricing: '$0.14/0.28/MTok',
    });
    expect(loaded.providerErrors).toEqual({ openai: 'boom' });
  });

  it('forwards which providers are configured — the /key picker checkmarks', async () => {
    const h = harness({
      getModels: vi.fn().mockResolvedValue({ models: [], providers: ['openrouter', 'gemini'] }),
    });
    await runEffect({ type: 'loadModels' }, h.deps);

    const loaded = h.actions.find((a) => a.type === 'modelsLoaded') as Extract<Action, { type: 'modelsLoaded' }>;
    expect(loaded.providers).toEqual(['openrouter', 'gemini']);
  });

  it('loads the session list for the current workspace', async () => {
    const h = harness();
    await runEffect({ type: 'loadSessions' }, h.deps);
    expect(h.api.getSessions).toHaveBeenCalledWith('/ws');
    expect(types(h.actions)).toContain('sessionsLoaded');
  });

  // Reading the file back is not enough: without adoption the daemon has no
  // orchestrator for the session, so the restored plan cannot be run or edited.
  it('loading a session adopts it on the server, not just reads it', async () => {
    const h = harness();
    await runEffect({ type: 'loadSession', sessionId: 's9' }, h.deps);

    expect(h.api.adoptSession).toHaveBeenCalledWith('s9', '/ws');
  });

  it('loading a session restores its plan and goal', async () => {
    const h = harness();
    await runEffect({ type: 'loadSession', sessionId: 's9' }, h.deps);

    expect(h.actions).toContainEqual({ type: 'sessionStarted', sessionId: 's9', goal: 'Rate limiting' });
    expect(h.actions).toContainEqual({ type: 'planUpdated', plan: { tasks: [{ id: 't1' }] }, sessionId: 's9' });
  });

  it('says the session is live once it is loaded', async () => {
    const h = harness();
    await runEffect({ type: 'loadSession', sessionId: 's9' }, h.deps);

    const notice = h.actions.find((a) => a.type === 'notice') as Extract<Action, { type: 'notice' }>;
    expect(notice.message).toMatch(/Rate limiting/);
  });

  it('reports a session the server cannot adopt', async () => {
    const h = harness({ adoptSession: vi.fn().mockRejectedValue(new DaemonError('Session not found', 404, 'session_not_found')) });
    await runEffect({ type: 'loadSession', sessionId: 's9' }, h.deps);

    expect(types(h.actions)).toContain('failed');
    expect(messageOf(h.actions, 'failed')).toContain('Reload it with /sessions');
  });

  it('words a missing session from the daemon\'s code, never from its message', async () => {
    const h = harness({ adoptSession: vi.fn().mockRejectedValue(new Error('Session not found')) });
    await runEffect({ type: 'loadSession', sessionId: 's9' }, h.deps);

    expect(messageOf(h.actions, 'failed')).toBe('Session not found');
  });

  it('deletes a session and refreshes the list', async () => {
    const h = harness();
    await runEffect({ type: 'deleteSession', sessionId: 's9' }, h.deps);
    expect(h.api.deleteSession).toHaveBeenCalledWith('s9', '/ws');
    expect(types(h.actions)).toContain('sessionsLoaded');
  });

  it('refresh re-reads runners, settings and models', async () => {
    const h = harness();
    await runEffect({ type: 'refresh' }, h.deps);
    expect(types(h.actions)).toEqual(expect.arrayContaining(['runnersLoaded', 'settingsLoaded', 'modelsLoaded']));
  });

  it('refresh stays silent unless announced', async () => {
    const h = harness();
    await runEffect({ type: 'refresh' }, h.deps);
    expect(types(h.actions)).not.toContain('notice');
  });

  it('an announced refresh posts the notice', async () => {
    const h = harness();
    await runEffect({ type: 'refresh', announce: true }, h.deps);
    expect(h.actions).toContainEqual({ type: 'notice', message: 'Refreshed runners, settings and models.' });
  });
});

describe('failures', () => {
  // Now that loading adopts the session, this only happens when the daemon has
  // restarted underneath us — so the advice is to reload, not to re-plan.
  it('tells the user to reload a session the daemon no longer holds', async () => {
    const h = harness({ markTaskComplete: vi.fn().mockRejectedValue(new DaemonError('Session not found', 404, 'session_not_found')) });
    await runEffect({ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'complete' }, h.deps);

    const failure = h.actions.find((a) => a.type === 'failed') as Extract<Action, { type: 'failed' }>;
    expect(failure.message).toContain('/sessions');
    expect(failure.message).not.toMatch(/re-?plan/i);
  });

  it('leaves an unrelated error message alone', async () => {
    const h = harness({ markTaskComplete: vi.fn().mockRejectedValue(new Error('disk on fire')) });
    await runEffect({ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'complete' }, h.deps);
    expect(h.actions).toContainEqual({ type: 'failed', message: 'disk on fire' });
  });

  it('reports an api error instead of crashing the app', async () => {
    const h = harness({ executePlan: vi.fn().mockRejectedValue(new Error('daemon down')) });
    await expect(runEffect({ type: 'execute', sessionId: 's1' }, h.deps)).resolves.toBeUndefined();
    expect(h.actions).toContainEqual({ type: 'failed', message: 'daemon down' });
  });
});

/**
 * `ensureDaemonOwned` runs once, at launch, and the TUI then outlives its
 * daemon in every direction: the daemon crashes, another client stops it, a
 * rebuild is followed by a manual restart. Before this, the first refused
 * connection killed the session for good — every later action reported
 * `connect ECONNREFUSED 127.0.0.1:3742` and nothing brought it back.
 */
describe('a daemon that went away mid-session', () => {
  it('restarts it and replays the action', async () => {
    const updateSettings = vi.fn()
      .mockRejectedValueOnce(refused())
      .mockResolvedValue({});
    const h = harness({ updateSettings });

    await runEffect({ type: 'setPlanner', provider: 'claude-code' }, h.deps);

    expect(h.deps.reviveDaemon).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(types(h.actions)).toContain('settingsLoaded');
    expect(h.env.AI_PROVIDER).toBe('claude-code');
  });

  it('says what it did, so a silent retry is not mistaken for a slow one', async () => {
    const h = harness({ updateSettings: vi.fn().mockRejectedValueOnce(refused()).mockResolvedValue({}) });
    await runEffect({ type: 'setModel', modelId: 'haiku' }, h.deps);
    expect(messageOf(h.actions, 'notice')).toMatch(/server had stopped/i);
  });

  // Refused at the handshake means the request was never delivered, which is
  // the property that makes replay safe. A conversation turn is the most
  // expensive thing to double-send, so it is the one worth pinning.
  it('replays a conversation turn, because a refused connection delivered nothing', async () => {
    const startConversation = vi.fn()
      .mockRejectedValueOnce(refused())
      .mockResolvedValue({ tasks: [] });
    const h = harness({ startConversation });

    await runEffect({ type: 'startConversation', goal: 'ship it' }, h.deps);

    expect(startConversation).toHaveBeenCalledTimes(2);
  });

  it('gives up with an actionable message when the daemon will not come back', async () => {
    const h = harness({ executePlan: vi.fn().mockRejectedValue(refused()) });
    reviveMock(h.deps).mockResolvedValue(false);

    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    const failure = messageOf(h.actions, 'failed') ?? '';
    expect(failure).toContain('3742');
    expect(failure).toContain('server.log');
    expect(failure).not.toContain('ECONNREFUSED');
  });

  it('treats a revive that throws as a revive that failed', async () => {
    const h = harness({ executePlan: vi.fn().mockRejectedValue(refused()) });
    reviveMock(h.deps).mockRejectedValue(new Error('web/dist not built'));

    await expect(runEffect({ type: 'execute', sessionId: 's1' }, h.deps)).resolves.toBeUndefined();
    expect(messageOf(h.actions, 'failed')).toContain('3742');
  });

  // A fresh daemon holds no sessions, so a session-scoped replay legitimately
  // 404s. That is a different problem with a different fix.
  it('explains a post-revive 404 as a lost session, not as a dead server', async () => {
    const h = harness({
      markTaskComplete: vi.fn()
        .mockRejectedValueOnce(refused())
        .mockRejectedValue(new DaemonError('Session not found', 404, 'session_not_found')),
    });

    await runEffect({ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'complete' }, h.deps);

    expect(messageOf(h.actions, 'failed')).toContain('/sessions');
  });

  // ECONNRESET can arrive after the server read the request, so replaying it
  // could start a second run. Only a refused handshake is safe.
  it('does not retry an error that could have been half-applied', async () => {
    const executePlan = vi.fn().mockRejectedValue(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    );
    const h = harness({ executePlan });

    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    expect(executePlan).toHaveBeenCalledTimes(1);
    expect(h.deps.reviveDaemon).not.toHaveBeenCalled();
  });
});

/**
 * `.env` is the disk. Writing it before the daemon accepts the change left a
 * failed operation persisted: switching the planner clears the model and the
 * effort in the same breath, so a refused connection wrote a planner with no
 * model that the next daemon then started from — with the TUI still showing
 * the old planner.
 */
describe('settings persistence ordering', () => {
  it('leaves .env untouched when the daemon rejects the change', async () => {
    const h = harness({ updateSettings: vi.fn().mockRejectedValue(new Error('bad request')) });

    await runEffect({ type: 'setPlanner', provider: 'claude-code' }, h.deps);

    expect(h.env).toEqual({});
    expect(types(h.actions)).toContain('failed');
  });

  it.each([
    ['setModel', { type: 'setModel', modelId: 'haiku' } as Effect, 'ORCHESTRATOR_MODEL'],
    ['setPlannerEffort', { type: 'setPlannerEffort', effort: 'high' } as Effect, 'ORDEWELL_PLANNER_EFFORT'],
    ['setApiKey', { type: 'setApiKey', provider: 'openrouter', key: 'sk-x' } as Effect, 'OPENROUTER_API_KEY'],
  ])('%s does not persist a rejected change either', async (_name, effect, key) => {
    const h = harness({ updateSettings: vi.fn().mockRejectedValue(new Error('nope')) });
    await runEffect(effect, h.deps);
    expect(h.env[key]).toBeUndefined();
  });

  it('persists every key of an accepted planner switch, including a daemon that resolved nothing', async () => {
    const h = harness({ updateSettings: vi.fn().mockResolvedValue({}) });

    await runEffect({ type: 'setPlanner', provider: 'claude-code' }, h.deps);

    expect(h.env).toEqual({
      AI_PROVIDER: 'claude-code',
      ORCHESTRATOR_MODEL: '',
      ORDEWELL_PLANNER_EFFORT: '',
    });
  });

  it('persists the model and effort the daemon resolved, not an empty clear', async () => {
    const h = harness({
      updateSettings: vi.fn().mockResolvedValue({ orchestratorModel: 'sonnet', plannerThinkingEffort: 'high' }),
    });

    await runEffect({ type: 'setPlanner', provider: 'claude-code' }, h.deps);

    expect(h.env).toEqual({
      AI_PROVIDER: 'claude-code',
      ORCHESTRATOR_MODEL: 'sonnet',
      ORDEWELL_PLANNER_EFFORT: 'high',
    });
  });
});

describe('the armed stop expiring', () => {
  it('schedules the disarm the reducer asked for, and delivers it after the delay', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      await runEffect({ type: 'disarmStop', afterMs: 2000, arm: 1 }, h.deps);

      // Nothing yet — the arm is still standing.
      expect(h.actions).toEqual([]);

      await vi.advanceTimersByTimeAsync(1999);
      expect(h.actions).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(h.actions).toEqual([{ type: 'stopDisarmed', arm: 1 }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('exit', () => {
  it('asks the runtime to shut down', async () => {
    const h = harness();
    await runEffect({ type: 'exit' }, h.deps);
    expect(h.exit).toHaveBeenCalled();
  });
});

describe('runner modes', () => {
  it('carries each runner declared modes through to the mode picker', async () => {
    const h = harness({
      getModels: vi.fn().mockResolvedValue({
        models: [],
        modesByRunner: {
          codex: [{ id: 'agent', label: 'Agent', description: 'Edit files' }, { id: 'plan', label: 'Plan', description: 'Read only' }],
        },
      }),
    });

    await runEffect({ type: 'loadModels' }, h.deps);

    const loaded = h.actions.find((a) => a.type === 'modelsLoaded') as Extract<Action, { type: 'modelsLoaded' }>;
    expect(loaded.modesByRunner).toEqual({
      codex: [{ id: 'agent', label: 'Agent', description: 'Edit files' }, { id: 'plan', label: 'Plan', description: 'Read only' }],
    });
  });

  it('reports no modes rather than undefined when the daemon omits them', async () => {
    const h = harness({ getModels: vi.fn().mockResolvedValue({ models: [] }) });

    await runEffect({ type: 'loadModels' }, h.deps);

    const loaded = h.actions.find((a) => a.type === 'modelsLoaded') as Extract<Action, { type: 'modelsLoaded' }>;
    expect(loaded.modesByRunner).toEqual({});
  });
});

describe('copying a selection', () => {
  it('pipes the text into the host clipboard command and says so', async () => {
    const pipeToClipboard = vi.fn();
    const h = harness({}, { pipeToClipboard });
    await runEffect({ type: 'copyText', text: 'one\ntwo' }, h.deps);

    expect(pipeToClipboard).toHaveBeenCalledWith(expect.any(String), 'one\ntwo');
    expect(messageOf(h.actions, 'notice')).toContain('2 lines');
  });

  it('hands the text to the terminal as OSC 52 when the host has no clipboard tool', async () => {
    const pipeToClipboard = vi.fn();
    const writeTerminal = vi.fn();
    const h = harness({}, { hasBin: () => false, pipeToClipboard, writeTerminal });
    await runEffect({ type: 'copyText', text: 'hello' }, h.deps);

    expect(pipeToClipboard).not.toHaveBeenCalled();
    // ESC ] 52 ; c ; <base64> BEL — the terminal's own "put this on the clipboard".
    expect(writeTerminal).toHaveBeenCalledWith(`\x1b]52;c;${Buffer.from('hello').toString('base64')}\x07`);
    expect(messageOf(h.actions, 'notice')).toMatch(/clipboard/i);
  });

  it('says nothing and touches nothing when the selection was empty', async () => {
    const pipeToClipboard = vi.fn();
    const writeTerminal = vi.fn();
    const h = harness({}, { pipeToClipboard, writeTerminal });
    await runEffect({ type: 'copyText', text: '' }, h.deps);

    expect(pipeToClipboard).not.toHaveBeenCalled();
    expect(writeTerminal).not.toHaveBeenCalled();
    expect(h.actions).toEqual([]);
  });

  // A missing xclip throws out of the pipe; the user gets the terminal route
  // rather than an error turn saying the copy failed.
  it('falls back to OSC 52 when the clipboard command itself fails', async () => {
    const writeTerminal = vi.fn();
    const h = harness({}, {
      pipeToClipboard: vi.fn(() => { throw new Error('xclip: unable to open display'); }),
      writeTerminal,
    });
    await runEffect({ type: 'copyText', text: 'hi' }, h.deps);

    expect(writeTerminal).toHaveBeenCalledWith(`\x1b]52;c;${Buffer.from('hi').toString('base64')}\x07`);
  });
});

describe('conversation fork and rewind effects', () => {
  const history = [
    { role: 'user' as const, content: 'build me a parser', timestamp: '2026-01-01T00:00:00Z' },
    { role: 'assistant' as const, content: 'Which formats?', timestamp: '2026-01-01T00:00:01Z' },
  ];

  it('forks, then switches the TUI to the fork with its conversation and tasks', async () => {
    const plan = { tasks: [{ id: 't1' }], conversationHistory: history };
    const h = harness({ forkConversation: vi.fn().mockResolvedValue({ sessionId: 'session-fork', goal: 'build me a parser', plan }) });

    await runEffect({ type: 'forkConversation', sessionId: 'session-1' }, h.deps);

    expect(h.api.forkConversation).toHaveBeenCalledWith('session-1');
    expect(h.actions).toEqual([
      { type: 'sessionForked', sessionId: 'session-fork', goal: 'build me a parser' },
      { type: 'chatRestored', history, sessionId: 'session-fork' },
      { type: 'planUpdated', plan, sessionId: 'session-fork' },
      { type: 'notice', message: expect.stringMatching(/Forked session-1.*session-fork/) },
    ]);
  });

  it('reports a refused fork and stays where it was', async () => {
    const h = harness({ forkConversation: vi.fn().mockRejectedValue(new Error('Cannot fork the conversation while the planner is answering')) });

    await runEffect({ type: 'forkConversation', sessionId: 'session-1' }, h.deps);

    expect(types(h.actions)).toEqual(['failed']);
    expect(messageOf(h.actions, 'failed')).toMatch(/planner is answering/);
  });

  it('loads the rewind targets for the session', async () => {
    const targets = [{ index: 2, preview: 'JSON only', content: 'JSON only', timestamp: '2026-01-01T00:00:02Z' }];
    const h = harness({ rewindTargets: vi.fn().mockResolvedValue(targets) });

    await runEffect({ type: 'loadRewindTargets', sessionId: 'session-1' }, h.deps);

    expect(h.api.rewindTargets).toHaveBeenCalledWith('session-1');
    expect(h.actions).toEqual([{ type: 'rewindTargetsLoaded', targets, sessionId: 'session-1' }]);
  });

  it('hands the message a `/rewind <n>` named back with the targets, so the answer can be told from a picker fill', async () => {
    const targets = [{ index: 2, preview: 'JSON only', content: 'JSON only', timestamp: '2026-01-01T00:00:02Z' }];
    const h = harness({ rewindTargets: vi.fn().mockResolvedValue(targets) });

    await runEffect({ type: 'loadRewindTargets', sessionId: 'session-1', pick: 2 }, h.deps);

    expect(h.actions).toEqual([{ type: 'rewindTargetsLoaded', targets, sessionId: 'session-1', pick: 2 }]);
  });

  it('rewinds into a fork, then switches the TUI to it with its conversation and tasks', async () => {
    const plan = { tasks: [{ id: 't1' }], conversationHistory: history };
    const h = harness({ rewindConversation: vi.fn().mockResolvedValue({ sessionId: 'session-fork', goal: 'build me a parser', plan, rewoundMessage: 'JSON only' }) });

    await runEffect({ type: 'rewindConversation', sessionId: 'session-1', index: 2 }, h.deps);

    expect(h.api.rewindConversation).toHaveBeenCalledWith('session-1', 2);
    expect(h.actions).toEqual([
      { type: 'sessionForked', sessionId: 'session-fork', goal: 'build me a parser' },
      { type: 'chatRestored', history, sessionId: 'session-fork' },
      { type: 'planUpdated', plan, sessionId: 'session-fork' },
      { type: 'inputPrefilled', text: 'JSON only', sessionId: 'session-fork' },
      { type: 'notice', message: expect.stringMatching(/session-1.*session-fork.*from before that message.*original is kept.*\/sessions.*ready to edit and resend/) },
    ]);
  });

  it('never calls the fork a branch', async () => {
    const plan = { tasks: [], conversationHistory: history };
    const h = harness({ rewindConversation: vi.fn().mockResolvedValue({ sessionId: 'session-fork', goal: 'g', plan, rewoundMessage: 'JSON only' }) });

    await runEffect({ type: 'rewindConversation', sessionId: 'session-1', index: 2 }, h.deps);

    expect(messageOf(h.actions, 'notice')).not.toMatch(/branch/i);
  });

  it('reports a refused rewind and leaves the state as it was', async () => {
    const h = harness({ rewindConversation: vi.fn().mockRejectedValue(new Error('Cannot rewind the conversation while the planner is answering')) });
    const before: TuiState = initialState({ sessionId: 'session-1', goal: 'g', conversation: chatOf(['user', 'build me a parser'], ['planner', 'Which formats?']) });
    let state = before;

    await runEffect({ type: 'rewindConversation', sessionId: 'session-1', index: 2 }, h.deps);
    for (const action of h.actions) state = reduce(state, action).state;

    expect(types(h.actions)).toEqual(['failed']);
    expect(messageOf(h.actions, 'failed')).toMatch(/planner is answering/);
    expect(state.sessionId).toBe('session-1');
    expect(state.conversation.blocks.slice(0, before.conversation.blocks.length)).toEqual(before.conversation.blocks);
    expect(state.editor.text).toBe('');
  });

  it('shows the fork\'s shorter transcript in place of the original\'s', async () => {
    const plan = { tasks: [], conversationHistory: history };
    const h = harness({ rewindConversation: vi.fn().mockResolvedValue({ sessionId: 'session-fork', goal: 'build me a parser', plan, rewoundMessage: 'left behind' }) });
    let state: TuiState = initialState({
      sessionId: 'session-1',
      conversation: chatOf(['user', 'build me a parser'], ['planner', 'Which formats?'], ['user', 'left behind']),
    });

    await runEffect({ type: 'rewindConversation', sessionId: 'session-1', index: 2 }, h.deps);
    for (const action of h.actions) state = reduce(state, action).state;

    expect(state.sessionId).toBe('session-fork');
    expect(state.editor).toMatchObject({ text: 'left behind', cursor: 11 });
    expect(messagesOf(state).map((m) => m.text)).not.toContain('left behind');
    expect(messagesOf(state).map((m) => m.text)).toEqual(expect.arrayContaining(['build me a parser', 'Which formats?']));
  });
});

describe('conversation compact effect', () => {
  const condensed = [
    { role: 'assistant' as const, content: 'Conversation condensed: …', timestamp: '2026-01-02T00:00:00Z', kind: 'compaction' as const },
    { role: 'user' as const, content: 'add CSV', timestamp: '2026-01-02T00:00:01Z' },
  ];

  it('condenses, then redraws the transcript and plan from what the daemon kept', async () => {
    const plan = { tasks: [{ id: 't1' }], conversationHistory: condensed };
    const h = harness({ compactConversation: vi.fn().mockResolvedValue({ plan, summary: 'the state', keptMessages: 4 }) });

    await runEffect({ type: 'compactConversation', sessionId: 'session-1' }, h.deps);

    expect(h.api.compactConversation).toHaveBeenCalledWith('session-1');
    expect(h.actions).toEqual([
      { type: 'chatRestored', history: condensed, sessionId: 'session-1' },
      { type: 'planUpdated', plan, sessionId: 'session-1' },
    ]);
  });

  it('reports a refusal, and a busy planner goes back to idle', async () => {
    const h = harness({ compactConversation: vi.fn().mockRejectedValue(new Error('The conversation is too short to condense.')) });
    let state: TuiState = initialState({ sessionId: 'session-1', status: 'planning', busyLabel: 'Condensing the conversation…' });

    await runEffect({ type: 'compactConversation', sessionId: 'session-1' }, h.deps);
    for (const action of h.actions) state = reduce(state, action).state;

    expect(types(h.actions)).toEqual(['failed']);
    expect(messageOf(h.actions, 'failed')).toMatch(/too short/);
    expect(state.status).toBe('idle');
    expect(state.busyLabel).toBe('');
  });

  it('keeps the daemon\'s late copy of the summary from landing as a spoken turn too', async () => {
    const plan = { tasks: [], conversationHistory: condensed };
    let onExecution: (event: unknown) => void = () => {};
    let finishExecution: () => void = () => {};
    const h = harness({
      compactConversation: vi.fn().mockResolvedValue({ plan, summary: 'the state', keptMessages: 4 }),
      streamExecution: vi.fn().mockImplementation((_id: string, cb: (event: unknown) => void, onReady?: (error?: Error) => void) => {
        onExecution = cb;
        onReady?.();
        return new Promise<void>((resolve) => { finishExecution = resolve; });
      }),
    });

    // A run is executing, so the session socket is live while the compaction
    // runs — and the daemon broadcasts the summary on it before answering.
    const running = runEffect({ type: 'execute', sessionId: 'session-1' }, h.deps);
    await runEffect({ type: 'compactConversation', sessionId: 'session-1' }, h.deps);
    onExecution({
      type: 'planner_message', content: 'Conversation condensed: …', timestamp: '2026-01-02T00:00:00Z',
    });
    finishExecution();
    await running;

    let state: TuiState = initialState({ sessionId: 'session-1' });
    for (const action of h.actions) ({ state } = reduce(state, action));
    const messages = messagesOf(state);
    expect(messages.filter((m) => m.role === 'planner')).toHaveLength(0);
    expect(messages.filter((m) => m.role === 'system' && m.text === 'Conversation condensed: …')).toHaveLength(1);
  });
});

describe('worktree isolation', () => {
  /** Drive one run with scripted websocket messages, the way `execute` sees them. */
  const running = (events: unknown[], api: Partial<OrdewellApi> = {}) =>
    harness({
      streamExecution: vi.fn().mockImplementation((_id: string, cb: (e: unknown) => void, onReady?: (error?: Error) => void) => {
        onReady?.();
        for (const event of events) cb(event);
        return Promise.resolve();
      }),
      ...api,
    });

  it('carries each task\'s isolation from a status_update into the reducer', async () => {
    const isolation = { state: 'conflict', branch: 'ordewell/r1/2-b', worktree: '/w/2-b' };
    const h = running([{ type: 'status_update', tasks: [{ id: 'b', status: 'awaiting_user', verdict: null, isolation }] }]);

    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    expect(h.actions).toContainEqual({ type: 'tasksStatus', sessionId: 's1', gate: null, updates: { b: { status: 'awaiting_user', idleSince: null, isolation } } });
  });

  it('turns isolation_blocked into the stash / run-without / cancel question', async () => {
    const h = running([{ type: 'isolation_blocked', reason: 'dirty', message: 'Tracked files have uncommitted changes' }]);

    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    expect(h.actions).toContainEqual({ type: 'isolationBlocked', message: 'Tracked files have uncommitted changes', sessionId: 's1' });
  });

  it('keeps showing what still runs while the stash question is open', async () => {
    let emit: (event: unknown) => void = () => {};
    let end: () => void = () => {};
    const h = harness({
      streamExecution: vi.fn().mockImplementation((_id: string, cb: (e: unknown) => void, onReady?: (error?: Error) => void) => {
        emit = cb;
        onReady?.();
        return new Promise<void>((resolve) => { end = resolve; });
      }),
    } as Partial<OrdewellApi>);

    const run = runEffect({ type: 'execute', sessionId: 's1' }, h.deps);
    await vi.waitFor(() => expect(h.api.executePlan).toHaveBeenCalled());
    emit({ type: 'isolation_blocked', reason: 'dirty', message: 'Tracked files have uncommitted changes' });
    emit({ type: 'status_update', tasks: [{ id: 'ops1', status: 'in_progress', verdict: null }] });

    expect(types(h.actions)).toEqual(expect.arrayContaining(['isolationBlocked', 'tasksStatus']));
    end();
    await run;
  });

  it('turns isolation_handoff into the handoff, before the run completes', async () => {
    const landed = [{ taskId: 't1', order: 1, title: 'One' }];
    const repos = [{ path: '.', integrationBranch: 'ordewell/r1/integration', baseRef: 'abc', landed }];
    const h = running([
      { type: 'isolation_handoff', repos, landed },
      { type: 'execution_complete', summary: { total: 1, completed: 1, failed: 0 } },
    ]);

    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    expect(types(h.actions).filter((t) => t === 'isolationHandoff' || t === 'executionComplete')).toEqual(['isolationHandoff', 'executionComplete']);
    expect(h.actions).toContainEqual({ type: 'isolationHandoff', handoff: { repos, landed }, sessionId: 's1' });
  });

  it('hands the dirty repos of a group to the stash question', async () => {
    const h = running([{ type: 'isolation_blocked', reason: 'dirty', repos: ['api', 'web'], message: 'Tracked files have uncommitted changes in api, web' }]);

    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    expect(h.actions).toContainEqual({
      type: 'isolationBlocked', message: 'Tracked files have uncommitted changes in api, web', repos: ['api', 'web'], sessionId: 's1',
    });
  });

  it('shows a run\'s isolation notice as a notice, and a warning as one too', async () => {
    const h = running([
      { type: 'notice', level: 'info', message: 'NOTES.md is shared live with every task, so edits to it are not isolated.' },
      { type: 'notice', level: 'warn', message: 'api/.env could not be linked into task workspaces' },
    ]);

    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    expect(h.actions.filter((a) => a.type === 'notice')).toEqual([
      { type: 'notice', level: 'info', message: 'NOTES.md is shared live with every task, so edits to it are not isolated.' },
      { type: 'notice', level: 'warn', message: 'api/.env could not be linked into task workspaces' },
    ]);
  });

  it('reports a blocked Merge all as a failure that changed nothing, naming each repo and file', async () => {
    const blocked = [{ repo: 'api', reason: 'conflict', files: ['src/a.ts'] }, { repo: 'web', reason: 'merge-in-progress', files: [] }];
    const h = harness({ mergeRun: vi.fn().mockResolvedValue({ outcome: 'blocked', blocked }) } as Partial<OrdewellApi>);

    await runEffect({ type: 'isolationMerge', sessionId: 's1', branch: 'ordewell/r1/integration', group: true }, h.deps);

    const message = messageOf(h.actions, 'failed');
    expect(message).toContain('api would conflict in src/a.ts; web has a merge in progress');
    expect(message).toContain("Each repository's ordewell/r1/integration is a plain branch you can merge by hand.");
    expect(messageOf(h.actions, 'notice')).toBeUndefined();
  });

  it('says which repos a Merge all had landed when it stopped part-way', async () => {
    const h = harness({ mergeRun: vi.fn().mockResolvedValue({ outcome: 'conflict', repo: 'web', files: ['w.txt'], landed: ['api'] }) } as Partial<OrdewellApi>);

    await runEffect({ type: 'isolationMerge', sessionId: 's1', branch: 'ordewell/r1/integration', group: true }, h.deps);

    expect(messageOf(h.actions, 'failed')).toContain('api was merged already and stays merged.');
  });

  it('says a group merged into every repository', async () => {
    const h = harness({ mergeRun: vi.fn().mockResolvedValue({ outcome: 'merged' }) } as Partial<OrdewellApi>);

    await runEffect({ type: 'isolationMerge', sessionId: 's1', branch: 'ordewell/r1/integration', group: true }, h.deps);

    expect(messageOf(h.actions, 'notice')).toBe('Merged ordewell/r1/integration into the checked-out branch of every repository.');
  });

  it('ignores socket greetings that are not session messages', async () => {
    const h = running([{ type: 'connected', sessionId: 's1' }, { type: 'chat_backlog', history: [] }]);

    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    expect(messageOf(h.actions, 'failed')).toBeUndefined();
  });

  it('review hands the diff to the reducer', async () => {
    const h = harness({ reviewRunDiff: vi.fn().mockResolvedValue('diff --git a/x b/x') } as Partial<OrdewellApi>);

    await runEffect({ type: 'isolationReviewDiff', sessionId: 's1' }, h.deps);

    expect(h.actions).toEqual([{ type: 'handoffDiff', diff: 'diff --git a/x b/x', sessionId: 's1' }]);
  });

  it('a merged run says where it landed, and clears the run it no longer has to hand over', async () => {
    const h = harness({ mergeRun: vi.fn().mockResolvedValue({ outcome: 'merged' }) } as Partial<OrdewellApi>);

    await runEffect({ type: 'isolationMerge', sessionId: 's1', branch: 'ordewell/r1/integration' }, h.deps);

    expect(messageOf(h.actions, 'notice')).toMatch(/Merged ordewell\/r1\/integration into your checked-out branch/);
    expect(h.actions).toContainEqual({ type: 'runCleared', sessionId: 's1' });
  });

  it('keeps the run to hand over after a Merge all that did not merge everything', async () => {
    const h = harness({ mergeRun: vi.fn().mockResolvedValue({ outcome: 'conflict', repo: 'web', files: ['w.txt'], landed: ['api'] }) } as Partial<OrdewellApi>);

    await runEffect({ type: 'isolationMerge', sessionId: 's1', branch: 'ordewell/r1/integration', group: true }, h.deps);

    expect(types(h.actions)).not.toContain('runCleared');
  });

  it('clears the run when another surface\'s Merge all merged everything, and only then', async () => {
    const h = running([
      { type: 'isolation_merge', result: { outcome: 'blocked', blocked: [{ repo: 'web', reason: 'conflict', files: ['w.txt'] }] } },
      { type: 'isolation_merge', result: { outcome: 'merged' } },
    ]);

    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    expect(h.actions.filter((a) => a.type === 'runCleared')).toEqual([{ type: 'runCleared', sessionId: 's1' }]);
  });

  it.each([
    ['conflict', /conflicted, so it was aborted — your tree is as it was/],
    ['failed', /merge already in progress/],
  ] as const)('a %s merge is reported as a failure that changed nothing', async (outcome, pattern) => {
    const h = harness({ mergeRun: vi.fn().mockResolvedValue({ outcome, repo: '.' }) } as Partial<OrdewellApi>);

    await runEffect({ type: 'isolationMerge', sessionId: 's1', branch: 'ordewell/r1/integration' }, h.deps);

    expect(messageOf(h.actions, 'failed')).toMatch(pattern);
    expect(messageOf(h.actions, 'notice')).toBeUndefined();
  });

  it('discard tells the reducer the run is gone', async () => {
    const h = harness({ discardRun: vi.fn().mockResolvedValue(undefined) } as Partial<OrdewellApi>);

    await runEffect({ type: 'isolationDiscard', sessionId: 's1', branch: 'ordewell/r1/integration' }, h.deps);

    expect(types(h.actions)).toEqual(['runCleared', 'notice']);
  });

  it('cleanup refreshes the plan, since the worktrees the marks named are gone', async () => {
    const cleanupRun = vi.fn().mockResolvedValue(undefined);
    const h = harness({ cleanupRun } as Partial<OrdewellApi>);

    await runEffect({ type: 'isolationCleanup', sessionId: 's1', branch: 'ordewell/r1/integration' }, h.deps);

    expect(cleanupRun).toHaveBeenCalledWith('s1');
    expect(h.api.getSession).toHaveBeenCalled();
    expect(messageOf(h.actions, 'notice')).toMatch(/ordewell\/r1\/integration is kept/);
  });

  it.each([
    ['stash', 'continueWithStash'],
    ['shared', 'continueWithoutIsolation'],
  ] as const)('%s: opens a stream of its own, then continues, then follows the run', async (mode, method) => {
    const order: string[] = [];
    const h = harness({
      streamExecution: vi.fn().mockImplementation((_id: string, _cb: unknown, onReady?: () => void) => {
        order.push('stream');
        onReady?.();
        return Promise.resolve();
      }),
      [method]: vi.fn().mockImplementation(async () => { order.push(method); }),
    } as Partial<OrdewellApi>);

    await runEffect({ type: 'isolationContinue', sessionId: 's1', mode }, h.deps);

    expect(order).toEqual(['stream', method]);
  });

  it('resolve-as-a-task adds the task, refreshes the plan and says what to do next', async () => {
    const resolveConflictAsTask = vi.fn().mockResolvedValue({});
    const h = harness({ resolveConflictAsTask } as Partial<OrdewellApi>);

    await runEffect({ type: 'resolveConflict', sessionId: 's1', taskId: 't2' }, h.deps);

    expect(resolveConflictAsTask).toHaveBeenCalledWith('s1', 't2');
    expect(types(h.actions)).toEqual(['planUpdated', 'notice']);
  });

  it('a refused action surfaces the daemon\'s reason', async () => {
    const h = harness({ discardRun: vi.fn().mockRejectedValue(new Error('The run is still running — stop it first')) } as Partial<OrdewellApi>);

    await runEffect({ type: 'isolationDiscard', sessionId: 's1', branch: 'b' }, h.deps);

    expect(messageOf(h.actions, 'failed')).toBe('The run is still running — stop it first');
  });
});

describe('a structured task\'s log, messages and interrupt', () => {
  it('opens with the latest saved attempt and reports it to the reducer', async () => {
    const getTaskLogAttempts = vi.fn().mockResolvedValue([1, 2]);
    const getTaskLog = vi.fn().mockResolvedValue([{ type: 'text', text: 'hi' }]);
    const h = harness({ getTaskLogAttempts, getTaskLog } as Partial<OrdewellApi>);

    await runEffect({ type: 'openTaskLog', sessionId: 's1', taskId: 't1' }, h.deps);

    expect(getTaskLog).toHaveBeenCalledWith('s1', 't1', 2, '/ws');
    expect(h.actions).toEqual([
      { type: 'taskLogLoaded', taskId: 't1', attempts: [1, 2], attempt: 2, events: [{ type: 'text', text: 'hi' }], sessionId: 's1' },
    ]);
  });

  it('answers an attempt switch with just that attempt', async () => {
    const getTaskLog = vi.fn().mockResolvedValue([{ type: 'turn_start', message: 'x' }]);
    const h = harness({ getTaskLog } as Partial<OrdewellApi>);

    await runEffect({ type: 'loadTaskAttempt', sessionId: 's1', taskId: 't1', attempt: 1 }, h.deps);

    expect(getTaskLog).toHaveBeenCalledWith('s1', 't1', 1, '/ws');
    expect(h.actions).toEqual([
      { type: 'taskLogLoaded', taskId: 't1', attempt: 1, events: [{ type: 'turn_start', message: 'x' }], sessionId: 's1' },
    ]);
  });

  it('sends a message and leaves the queue to the stream', async () => {
    const sendTaskMessage = vi.fn().mockResolvedValue({ id: 'm1' });
    const h = harness({ sendTaskMessage } as Partial<OrdewellApi>);

    await runEffect({ type: 'sendTaskMessage', sessionId: 's1', taskId: 't1', text: 'use Postgres' }, h.deps);

    expect(sendTaskMessage).toHaveBeenCalledWith('s1', 't1', 'use Postgres');
    expect(h.actions).toEqual([]);
  });

  it('says when a taken-back message had already gone out', async () => {
    const h = harness({ removeQueuedTaskMessage: vi.fn().mockResolvedValue({ removed: false }) } as Partial<OrdewellApi>);

    await runEffect({ type: 'removeTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm1' }, h.deps);

    expect(messageOf(h.actions, 'notice')).toMatch(/already delivered/);
  });

  it('continues a finished task, holding the execution stream open when asked to watch (ADR-0018, K1)', async () => {
    const order: string[] = [];
    const continueTask = vi.fn().mockImplementation(async () => { order.push('continueTask'); return { ok: true }; });
    const streamExecution = vi.fn().mockImplementation((_id: string, _cb: (e: unknown) => void, onReady?: (error?: Error) => void) => {
      order.push('streamExecution');
      onReady?.();
      return Promise.resolve();
    });
    const h = harness({ continueTask, streamExecution } as Partial<OrdewellApi>);

    await runEffect({ type: 'continueTask', sessionId: 's1', taskId: 't1', text: 'also handle arrays', watch: true }, h.deps);

    expect(continueTask).toHaveBeenCalledWith('s1', 't1', 'also handle arrays');
    expect(order).toEqual(['streamExecution', 'continueTask']);
  });

  it('continues without a second stream while a run is already watched', async () => {
    const h = harness();

    await runEffect({ type: 'continueTask', sessionId: 's1', taskId: 't1', text: 'go on' }, h.deps);

    expect(h.deps.api.continueTask).toHaveBeenCalledWith('s1', 't1', 'go on');
    expect(h.deps.api.streamExecution).not.toHaveBeenCalled();
  });

  it('interrupts the task and says so', async () => {
    const interruptTask = vi.fn().mockResolvedValue({ ok: true });
    const h = harness({ interruptTask } as Partial<OrdewellApi>);

    await runEffect({ type: 'interruptTask', sessionId: 's1', taskId: 't1' }, h.deps);

    expect(interruptTask).toHaveBeenCalledWith('s1', 't1');
    expect(messageOf(h.actions, 'notice')).toMatch(/Interrupting/);
  });

  it('answers a runner\'s request with the whole decision', async () => {
    const respondToApproval = vi.fn().mockResolvedValue({ ok: true });
    const h = harness({ respondToApproval } as Partial<OrdewellApi>);

    await runEffect({ type: 'answerTaskApproval', sessionId: 's1', approvalId: 'ap-1', answer: { decision: 'deny', note: 'not there' } }, h.deps);

    expect(respondToApproval).toHaveBeenCalledWith('s1', 'ap-1', { decision: 'deny', note: 'not there' });
    expect(h.actions).toEqual([]);
  });

  it('says a lost answer leaves the task waiting, not denied', async () => {
    const h = harness({ respondToApproval: vi.fn().mockRejectedValue(new Error('HTTP 409')) } as Partial<OrdewellApi>);

    await runEffect({ type: 'answerTaskApproval', sessionId: 's1', approvalId: 'ap-1', answer: { decision: 'allow' } }, h.deps);

    expect(messageOf(h.actions, 'failed')).toMatch(/still waiting for approval/);
  });
});
