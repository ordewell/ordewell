import { describe, it, expect, vi, type Mock, type Mocked } from 'vitest';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import { initialState, reduce, type Action } from '../reducer';
import type { Effect } from '../reducer';
import { fromTranscript, RUN_SETTINGS_DEFAULTS, type IsolationPreview, type SessionMessage } from '@ordewell/core';
import { DaemonError } from '../../apiClient';
import type { TuiState } from '../state';
import { chatOf, messagesOf } from './chat';
import { emptyEditor } from '../editor';

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
      execute: vi.fn().mockResolvedValue({ ok: true, message: 'Done.' }),
      getTaskLogAttempts: vi.fn().mockResolvedValue({ attempts: [] }),
      getTaskLog: vi.fn().mockResolvedValue({ attempt: 1, events: [] }),
      addTask: vi.fn().mockResolvedValue({ ok: true }),
      updateTask: vi.fn().mockResolvedValue({ ok: true }),
      setMergeAtGatesAutomatically: vi.fn().mockResolvedValue({ ok: true }),
      removeTask: vi.fn().mockResolvedValue({ ok: true }),
      getSessions: vi.fn().mockResolvedValue([]),
      getSession: vi.fn().mockResolvedValue({ meta: { id: 's1', goal: 'g' }, plan: { tasks: [] } }),
      adoptSession: vi.fn().mockResolvedValue({ plan: { tasks: [{ id: 't1' }] }, goal: 'Rate limiting' }),
      deleteSession: vi.fn().mockResolvedValue({ ok: true }),
      getSettings: vi.fn().mockResolvedValue({}),
      updateSettings: vi.fn().mockResolvedValue({}),
      getRunners: vi.fn().mockResolvedValue({ runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true }], orchestratorModel: 'm/1' }),
      setRunnerEnabled: vi.fn().mockResolvedValue({ ok: true }),
      getModels: vi.fn().mockResolvedValue({ models: [], providers: [] }),
      getIsolationPreview: vi.fn().mockResolvedValue({ preview: { status: 'no-repo', repos: [], shared: [] } }),
      streamPlanning: vi.fn().mockReturnValue({ close: vi.fn() }),
      streamExecution: vi.fn().mockImplementation((_id: string, _callback: (event: unknown) => void, onReady?: (error?: Error) => void) => {
        onReady?.();
        return Promise.resolve();
      }),
      closeExecutionStream: vi.fn(),
      followSession: vi.fn().mockReturnValue({ ready: Promise.resolve(true), ended: new Promise(() => {}), close: vi.fn() }),
      ...api,
    } as OrdewellApi,
    workspace: '/ws',
    port: 3742,
    dispatch: (action) => actions.push(action),
    newSessionId: () => 'session-new',
    setEnvVar: (key, value) => { env[key] = value; },
    saveAutonomy: () => ({ overridden: false }),
    setMouseCapture: vi.fn(),
    // Never the real probe or the real clipboard: the defaults would put test
    // fixtures on the developer's actual clipboard.
    hasBin: () => true,
    pipeToClipboard: vi.fn(),
    login: vi.fn().mockResolvedValue({ ok: true }),
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

  it('reads the new session\'s settings once it exists, not the file\'s for the next one', async () => {
    const run = { ...RUN_SETTINGS_DEFAULTS, autorun: true };
    const h = harness({ getSettings: vi.fn().mockResolvedValue({ run }) });

    await runEffect({ type: 'startConversation', goal: 'ship it' }, h.deps);

    expect(h.api.getSettings).toHaveBeenCalledWith('session-new');
    expect(h.actions).toContainEqual(expect.objectContaining({ type: 'settingsLoaded', sessionId: 'session-new', settings: { run } }));
  });

  /** A harness whose planning socket the test drives from inside the REST call. */
  function streaming(call: (emit: (e: unknown) => void) => Promise<unknown>, method: 'startConversation' | 'sendConversationMessage' | 'forceSendPlannerMessage' = 'startConversation') {
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

  it('reloads the runner list after a planner turn, so a login made outside the TUI clears the flag', async () => {
    const h = harness();

    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'carry on' }, h.deps);

    expect(h.api.getRunners).toHaveBeenCalled();
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

  it('send now posts to the force-send route and settles its reply like any turn', async () => {
    const h = streaming(async () => ({
      tasks: [],
      conversationHistory: [
        { role: 'user', content: 'use Postgres instead', forced: true },
        { role: 'assistant', content: 'Switching to Postgres.', timestamp: 'x' },
      ],
    }), 'forceSendPlannerMessage');

    await runEffect({ type: 'forceSendPlannerMessage', sessionId: 's1', message: 'use Postgres instead' }, h.deps);

    expect(h.api.forceSendPlannerMessage).toHaveBeenCalledWith('s1', 'use Postgres instead');
    expect(heard(h.actions)).toEqual([{ type: 'planner_message', content: 'Switching to Postgres.', timestamp: 'x' }]);
    expect(h.actions).toContainEqual(expect.objectContaining({ type: 'planUpdated', sessionId: 's1' }));
  });

  it('falls back to the REST reply when the socket delivered a different turn', async () => {
    const h = streaming(async (emit) => {
      emit({ type: 'planner_message', content: 'Looking into it.', timestamp: 'x' });
      return { tasks: [], conversationHistory: [{ role: 'assistant', content: 'Which database?' }] };
    }, 'sendConversationMessage');

    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'x' }, h.deps);

    expect(heard(h.actions).map((m) => m.type === 'planner_message' && m.content)).toEqual(['Looking into it.', 'Which database?']);
  });

  // ADR-0017 A1: the socket streamed the runs; settled by the backfill, each
  // takes its own segment's place rather than the whole reply landing last.
  it('backfills a reply the socket lost with its runs, for each to settle where it streamed', async () => {
    const runs = [
      { segmentId: 's1', text: 'I\'ll read README.md now.', startedAt: '2026-10-18T10:00:01.000Z' },
      { segmentId: 's2', text: 'The first line of README.md is "hello".', startedAt: '2026-10-18T10:00:03.000Z' },
    ];
    const content = 'I\'ll read README.md now.\n\nThe first line of README.md is "hello".';
    const h = streaming(async () => ({
      tasks: [],
      conversationHistory: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content, timestamp: '2026-10-18T10:00:05.000Z', runs },
      ],
    }), 'sendConversationMessage');

    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'x' }, h.deps);

    expect(heard(h.actions)).toEqual([{ type: 'planner_message', content, timestamp: '2026-10-18T10:00:05.000Z', runs }]);
  });

  // A fixed reply repeats: the same task edit twice says 'Tasks updated' twice.
  it('backfills a reply that repeats an earlier one, by its timestamp rather than its words', async () => {
    const same = 'Tasks updated:\n- #3 updated';
    let turn = 0;
    const h = streaming(async (emit) => {
      turn += 1;
      if (turn === 1) emit({ type: 'planner_message', content: same, timestamp: '2026-10-18T10:00:00.000Z' });
      return {
        tasks: [],
        conversationHistory: [
          { role: 'user', content: 'edit task 3' },
          { role: 'assistant', content: same, timestamp: turn === 1 ? '2026-10-18T10:00:00.000Z' : '2026-10-18T10:05:00.000Z' },
        ],
      };
    }, 'sendConversationMessage');

    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'edit task 3' }, h.deps);
    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'edit task 3 again' }, h.deps);

    expect(heard(h.actions)).toEqual([
      { type: 'planner_message', content: same, timestamp: '2026-10-18T10:00:00.000Z' },
      { type: 'planner_message', content: same, timestamp: '2026-10-18T10:05:00.000Z' },
    ]);
  });

  it('backfills every reply the turn left, in order, not only the last', async () => {
    const h = streaming(async () => ({
      tasks: [],
      conversationHistory: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'An earlier turn.', timestamp: '2026-10-18T09:00:00.000Z' },
        { role: 'user', content: 'x' },
        { role: 'assistant', content: 'Let me check task 2.', timestamp: '2026-10-18T10:00:01.000Z' },
        { role: 'assistant', content: 'Plan generated with 1 task.', kind: 'plan_generated', timestamp: '2026-10-18T10:00:02.000Z' },
        { role: 'assistant', content: 'Tasks updated:\n- #2 updated', timestamp: '2026-10-18T10:00:03.000Z' },
      ],
    }), 'sendConversationMessage');

    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'x' }, h.deps);

    expect(heard(h.actions).map((m) => m.type === 'planner_message' && m.content)).toEqual(['Let me check task 2.', 'Tasks updated:\n- #2 updated']);
  });

  it('speaks only the replies the socket lost', async () => {
    const h = streaming(async (emit) => {
      emit({ type: 'planner_message', content: 'Tasks updated:\n- #2 updated', timestamp: '2026-10-18T10:00:03.000Z' });
      return {
        tasks: [],
        conversationHistory: [
          { role: 'user', content: 'x' },
          { role: 'assistant', content: 'Let me check task 2.', timestamp: '2026-10-18T10:00:01.000Z' },
          { role: 'assistant', content: 'Tasks updated:\n- #2 updated', timestamp: '2026-10-18T10:00:03.000Z' },
        ],
      };
    }, 'sendConversationMessage');

    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'x' }, h.deps);

    expect(heard(h.actions).map((m) => m.type === 'planner_message' && m.content)).toEqual(['Tasks updated:\n- #2 updated', 'Let me check task 2.']);
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

  // Seen live: a plan turn's marker ("Plan generated with 1 task.") was spoken
  // as a second planner reply, and autorun's start line can be last as well.
  it('backfills the turn\'s reply, not the markers the turn left after it', async () => {
    const h = streaming(async () => ({
      tasks: [],
      conversationHistory: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: 'One task: add subtract.' },
        { role: 'assistant', content: 'Plan generated with 1 task.', kind: 'plan_generated' },
        { role: 'assistant', content: 'Started the plan — by autorun.', kind: 'execution' },
      ],
    }), 'sendConversationMessage');

    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'x' }, h.deps);

    expect(heard(h.actions).map((m) => m.type === 'planner_message' && m.content)).toEqual(['One task: add subtract.']);
  });

  it('backfills nothing from an earlier turn when this one left no reply', async () => {
    const h = streaming(async () => ({
      tasks: [],
      conversationHistory: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'Which database?' },
        { role: 'user', content: 'x' },
        { role: 'assistant', content: 'Plan generated with 1 task.', kind: 'plan_generated' },
      ],
    }), 'sendConversationMessage');

    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'x' }, h.deps);

    expect(heard(h.actions).filter((m) => m.type === 'planner_message')).toEqual([]);
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
      throw new DaemonError('no key', 400);
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
    // A refusal the daemon answered leaves no conversation a reply could
    // continue, so keeping the id would route every following message to nothing.
    const h = harness({ startConversation: vi.fn().mockRejectedValue(new DaemonError('no key', 400)) });
    await runEffect({ type: 'startConversation', goal: 'x' }, h.deps);

    expect(types(h.actions)).toContain('sessionCleared');
    expect(types(h.actions)).toContain('failed');
  });

  it('always closes the research stream, even when planning fails', async () => {
    const close = vi.fn();
    const h = harness({
      streamPlanning: vi.fn().mockReturnValue({ close }),
      startConversation: vi.fn().mockRejectedValue(new DaemonError('no key', 400)),
    });

    await runEffect({ type: 'startConversation', goal: 'x' }, h.deps);
    expect(close).toHaveBeenCalled();
    expect(h.actions).toContainEqual({ type: 'failed', message: 'no key', turn: true, sessionId: 'session-new' });
  });

  it('continues an open conversation', async () => {
    const h = harness();
    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'use bcrypt' }, h.deps);
    expect(h.api.sendConversationMessage).toHaveBeenCalledWith('s1', 'use bcrypt');
  });

  // The user can load another session while this turn runs; the reducer drops
  // a failure that names a session no longer on screen.
  it('names the session a failed turn was for', async () => {
    const h = harness({ sendConversationMessage: vi.fn().mockRejectedValue(new DaemonError('planner down', 500)) });
    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'use bcrypt' }, h.deps);
    expect(h.actions).toContainEqual(expect.objectContaining({ type: 'failed', turn: true, sessionId: 's1' }));
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
      type: 'statusUpdate',
      tasks: [{ id: 'a', status: 'in_progress' }],
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
      type: 'statusUpdate',
      tasks: [
        { id: 'a', status: 'completed', verdict: null },
        { id: 'b', status: 'running', verdict: null },
      ],
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
    expect(text).toContain('Add route asks: Line one of reasoning.');
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
      { type: 'planBroadcast', plan, sessionId: 's1' },
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

  // The seam keeps its own line of a Stop in the timeline, and the run's end
  // is announced by the stream: a notice here would say it a third time, and
  // untruly when nothing was running.
  it('stops a run, leaving what it says to the timeline', async () => {
    const h = harness();
    await runEffect({ type: 'stopExecution', sessionId: 's1' }, h.deps);
    expect(h.api.stopExecution).toHaveBeenCalledWith('s1');
    expect(h.actions).toEqual([]);
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
    await vi.waitFor(() => expect(listeners).toHaveLength(2));

    const started = { type: 'task_started', taskId: 't1', order: 1, title: 'Add route', runner: 'opencode' };
    for (const listener of listeners) listener(started);

    settle.forEach((resolve) => resolve());
    await Promise.all(running);

    expect(h.actions.filter((a) => a.type === 'taskStarted')).toHaveLength(1);
  });
});

describe('task control', () => {
  // Every task action is one command at the seam (core's taskActionCommand), whichever button sent it.
  it.each([
    ['retry', { command: 'retry_task', task: 't1', from: 'fresh' }],
    ['cancel', { command: 'stop_task', task: 't1' }],
    ['force-start', { command: 'force_start', task: 't1' }],
    ['resume-now', { command: 'retry_task', task: 't1', from: 'session' }],
    ['cancel-resume', { command: 'cancel_resume', task: 't1' }],
    ['complete', { command: 'mark_complete', task: 't1' }],
    ['uncomplete', { command: 'mark_not_done', task: 't1' }],
    ['skip', { command: 'skip_task', task: 't1' }],
  ] as const)('%s sends its command to the seam, and no other', async (action, command) => {
    const h = harness();
    await runEffect({ type: 'taskAction', sessionId: 's1', taskId: 't1', action }, h.deps);
    expect(h.api.execute).toHaveBeenCalledOnce();
    expect(h.api.execute).toHaveBeenCalledWith('s1', command);
  });

  it('refreshes the plan after a task action so the pane matches the server', async () => {
    const h = harness();
    await runEffect({ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'retry' }, h.deps);
    expect(types(h.actions)).toContain('planRefreshed');
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
      execute: vi.fn().mockImplementation(async () => {
        order.push('execute');
        return { ok: true, message: 'Done.' };
      }),
    });

    await runEffect({ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'force-start', watch: true }, h.deps);

    expect(order).toEqual(['streamExecution', 'execute']);
    expect(h.actions).toContainEqual({
      type: 'statusUpdate',
      tasks: [{ id: 't1', status: 'in_progress' }],
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
    expect(types(h.actions)).toContain('planRefreshed');
    expect(h.actions).toContainEqual({ type: 'notice', message: 'Effort updated.' });
  });


});

/**
 * The daemon resolves what a planner switch's model and effort should become
 * (task 2) — the client only sends the provider and consumes what comes back.
 */
describe('planner switch', () => {
  it('refuses a coding agent the daemon does not find installed, naming the ones it does, and switches nothing', async () => {
    const h = harness();

    await runEffect({ type: 'setPlanner', provider: 'codex' }, h.deps);

    expect(h.actions).toContainEqual(expect.objectContaining({ type: 'failed', message: expect.stringContaining('Codex is not installed') }));
    expect(h.actions).toContainEqual(expect.objectContaining({ type: 'failed', message: expect.stringContaining('claude-code') }));
    expect(h.api.updateSettings).not.toHaveBeenCalled();
  });

  it('shows the restored model in state without a further refresh', async () => {
    const h = harness({
      updateSettings: vi.fn().mockResolvedValue({
        orchestratorModel: 'sonnet',
        plannerThinkingEffort: 'high',
        switchRecall: { model: 'sonnet', effort: 'high', source: 'remembered' },
      }),
    });

    await runEffect({ type: 'setPlanner', provider: 'claude-code' }, h.deps);

    expect(h.actions).toContainEqual(expect.objectContaining({
      type: 'settingsLoaded',
      settings: { aiProvider: 'claude-code', orchestratorModel: 'sonnet', plannerThinkingEffort: 'high' },
    }));
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

  it('names the catalog default and points at /planner when nothing was remembered', async () => {
    const h = harness({
      updateSettings: vi.fn().mockResolvedValue({ orchestratorModel: 'sonnet', switchRecall: { model: 'sonnet', effort: '', source: 'catalog-default' } }),
    });

    await runEffect({ type: 'setPlanner', provider: 'claude-code' }, h.deps);

    const notice = h.actions.find((a) => a.type === 'notice') as Extract<Action, { type: 'notice' }>;
    expect(notice.message).toContain('default model, sonnet');
    expect(notice.message).toContain('/planner');
  });

  it('keeps the "pick a model" guidance when the daemon resolved nothing', async () => {
    const h = harness({ updateSettings: vi.fn().mockResolvedValue({ orchestratorModel: '', switchRecall: { model: '', effort: '', source: 'none' } }) });

    await runEffect({ type: 'setPlanner', provider: 'claude-code' }, h.deps);

    const notice = h.actions.find((a) => a.type === 'notice') as Extract<Action, { type: 'notice' }>;
    expect(notice.message).toContain('Pick a model with /planner.');
  });
});

/** `/planner`'s stepper: harness, model and effort reach the daemon in one write. */
describe('planner choice', () => {
  const choice: Effect = {
    type: 'setPlannerChoice', provider: 'claude-code', modelId: 'opus', effort: 'high',
    notice: 'Planner: Claude Code · Claude Opus 5.5 · High effort',
  };

  it('sends provider, model and effort in a single settings write', async () => {
    const h = harness();
    await runEffect(choice, h.deps);

    expect(h.api.updateSettings).toHaveBeenCalledTimes(1);
    expect(h.api.updateSettings).toHaveBeenCalledWith({
      env: { AI_PROVIDER: 'claude-code', ORCHESTRATOR_MODEL: 'opus', ORDEWELL_PLANNER_EFFORT: 'high' },
    });
  });

  it('persists all three to .env once the daemon accepts them', async () => {
    const h = harness();
    await runEffect(choice, h.deps);
    expect(h.env).toEqual({ AI_PROVIDER: 'claude-code', ORCHESTRATOR_MODEL: 'opus', ORDEWELL_PLANNER_EFFORT: 'high' });
  });

  it('leaves .env untouched when the daemon refuses', async () => {
    const h = harness({ updateSettings: vi.fn().mockRejectedValue(new Error('bad request')) });
    await runEffect(choice, h.deps);
    expect(h.env).toEqual({});
    expect(types(h.actions)).toContain('failed');
  });

  it("shows the choice in state with the daemon's updated per-backend memory", async () => {
    const plannerModels = { 'claude-code': { model: 'opus', effort: 'high' } };
    const h = harness({ updateSettings: vi.fn().mockResolvedValue({ plannerModels }) });
    await runEffect(choice, h.deps);

    const loaded = reduce(initialState(), h.actions.find((a) => a.type === 'settingsLoaded')!).state;
    expect(loaded).toMatchObject({ plannerProvider: 'claude-code', orchestratorModel: 'opus', plannerEffort: 'high', plannerModels });
  });

  it('says what was set in one notice', async () => {
    const h = harness();
    await runEffect(choice, h.deps);
    expect(h.actions.filter((a) => a.type === 'notice')).toEqual([
      { type: 'notice', message: 'Planner: Claude Code · Claude Opus 5.5 · High effort' },
    ]);
  });

  it('shows a signed-out pick at error level, the words unchanged', async () => {
    const h = harness();
    await runEffect({ ...choice, noticeLevel: 'error' }, h.deps);
    expect(h.actions.filter((a) => a.type === 'notice')).toEqual([
      { type: 'notice', message: 'Planner: Claude Code · Claude Opus 5.5 · High effort', level: 'error' },
    ]);
  });
});

describe('runner login', () => {
  const loginEffect: Effect = { type: 'plannerLogin', command: ['claude', 'login'], label: 'Claude Code' };

  it('runs the login command, re-probes the runners, then says the agent is signed in', async () => {
    const order: string[] = [];
    const h = harness({}, {
      login: vi.fn(async () => {
        order.push('login');
        return { ok: true };
      }),
    });
    h.api.getRunners.mockImplementation(async () => {
      order.push('runners');
      return {
        runners: [{
          id: 'claude-code', name: 'Claude Code', enabled: true,
          auth: { state: 'signed-in' as const, loginCommand: ['claude', 'auth', 'login'] },
        }],
        orchestratorModel: '',
      };
    });

    await runEffect(loginEffect, h.deps);

    expect(h.deps.login).toHaveBeenCalledWith(['claude', 'login']);
    // The welcome line and the picker read the daemon's fresh probe, so the
    // reload must follow the child rather than run before it.
    expect(order).toEqual(['login', 'runners']);
    expect(messageOf(h.actions, 'notice')).toBe('Claude Code is signed in.');
  });

  it('reloads the runners after a failed login too, and reports the message the login gave as context', async () => {
    const h = harness({}, {
      login: vi.fn(async () => ({ ok: false, message: 'claude exited with status 1 without finishing the login.' })),
    });

    await runEffect(loginEffect, h.deps);

    expect(h.api.getRunners).toHaveBeenCalled();
    expect(messageOf(h.actions, 'notice')).toContain('Could not confirm that Claude Code is signed in');
    expect(messageOf(h.actions, 'notice')).toContain('claude exited with status 1 without finishing the login.');
  });

  it('names the agent when a failed login gave no message', async () => {
    const h = harness({}, { login: vi.fn(async () => ({ ok: false })) });

    await runEffect(loginEffect, h.deps);

    expect(messageOf(h.actions, 'notice')).toBe('Could not confirm that Claude Code is signed in: the login did not finish');
  });

  it('believes a fresh signed-in verdict even when the child exited non-zero', async () => {
    // The child's exit is not the runner's verdict, in either direction: a
    // login that reports a failure can still leave the account signed in.
    const h = harness({
      getRunners: vi.fn().mockResolvedValue({
        runners: [{
          id: 'claude-code', name: 'Claude Code', enabled: true,
          auth: { state: 'signed-in', loginCommand: ['claude', 'auth', 'login'] },
        }],
        orchestratorModel: '',
      }),
    }, { login: vi.fn(async () => ({ ok: false, message: 'claude exited with status 1' })) });

    await runEffect(loginEffect, h.deps);

    expect(messageOf(h.actions, 'notice')).toBe('Claude Code is signed in.');
  });

  it('fails the effect when the login throws, so the runtime restores the terminal', async () => {
    const h = harness({}, {
      login: vi.fn(async () => {
        throw new Error('spawn claude ENOENT');
      }),
    });

    await runEffect(loginEffect, h.deps);

    expect(messageOf(h.actions, 'failed')).toContain('spawn claude ENOENT');
  });

  it('never starts the login twice when the reload after it finds the server gone', async () => {
    // `runEffect` retries a refused connection, and this effect is not one it
    // may replay: the child already ran and the user may already be signed in.
    const login = vi.fn(async () => ({ ok: true }));
    const h = harness({ getRunners: vi.fn().mockRejectedValue(refused()) }, { login });

    await runEffect(loginEffect, h.deps);

    expect(login).toHaveBeenCalledTimes(1);
    expect(messageOf(h.actions, 'notice')).toContain('Could not confirm that Claude Code is signed in.');
    expect(messageOf(h.actions, 'notice')).toContain('could not be refreshed');
  });

  it('does not claim a sign-in the fresh probe still contradicts', async () => {
    // The child's exit code is not the runner's own verdict: a login can print
    // success and still leave the account signed out. Claiming success here
    // leaves the red welcome line and the planner gate disagreeing with the
    // notice the user just read.
    const h = harness({
      getRunners: vi.fn().mockResolvedValue({
        runners: [{
          id: 'claude-code', name: 'Claude Code', enabled: true,
          auth: { state: 'signed-out', loginCommand: ['claude', 'auth', 'login'] },
        }],
        orchestratorModel: '',
      }),
    }, { login: vi.fn(async () => ({ ok: true })) });

    await runEffect(loginEffect, h.deps);

    expect(messageOf(h.actions, 'notice')).not.toBe('Claude Code is signed in.');
    expect(messageOf(h.actions, 'notice')).toMatch(/still|not logged in/i);
  });
});

describe('settings', () => {
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

  it('reloads the saved runner choice without changing it', async () => {
    const h = harness();
    await runEffect({ type: 'loadRunners' }, h.deps);
    expect(h.api.setRunnerEnabled).not.toHaveBeenCalled();
    expect(types(h.actions)).toEqual(['runnersLoaded']);
  });

  it('carries each runner\'s login verdict into the state', async () => {
    const auth = { state: 'signed-out' as const, loginCommand: ['claude', 'login'] };
    const h = harness({
      getRunners: vi.fn().mockResolvedValue({
        runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true, auth }],
        orchestratorModel: 'm/1',
      }),
    });
    await runEffect({ type: 'loadRunners' }, h.deps);
    expect(h.actions).toContainEqual({
      type: 'runnersLoaded',
      runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true, auth }],
      orchestratorModel: 'm/1',
    });
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

  it('reads the settings of the session on screen when the scope reloads', async () => {
    const h = harness();
    await runEffect({ type: 'loadScope', sessionId: 's1' }, h.deps);

    expect(h.api.getSettings).toHaveBeenCalledWith('s1');
    expect(h.actions).toContainEqual(expect.objectContaining({ type: 'settingsLoaded', sessionId: 's1' }));
  });

  it('/settings saves the run settings in one update, then parallel and autonomy, with one notice', async () => {
    const run = { supervisorLevel: 'watch', mergeAtGatesAutomatically: false, autorun: true, supervisorRetryLimit: 3, wakeUpReadBudget: 12 };
    const saved: boolean[] = [];
    const h = harness(
      { updateRunSettings: vi.fn().mockResolvedValue({ run }) },
      { saveAutonomy: (enabled) => { saved.push(enabled); return { overridden: false }; } },
    );
    await runEffect({
      type: 'saveSettings', run: { autorun: true, supervisorRetryLimit: 3 }, maxParallel: 3, autonomous: false,
      message: 'Settings: Autonomy Guarded · Supervisor retries 3 · Autorun on · Parallel 3', sessionId: 's1',
    }, h.deps);
    expect(h.api.updateRunSettings.mock.calls).toEqual([[{ autorun: true, supervisorRetryLimit: 3 }, 's1']]);
    expect(h.actions).toContainEqual(expect.objectContaining({ type: 'settingsLoaded', settings: { run } }));
    expect(h.api.updateSettings).toHaveBeenCalledWith({ env: { ORDEWELL_MAX_PARALLEL: '3' } });
    expect(h.env.ORDEWELL_MAX_PARALLEL).toBe('3');
    expect(saved).toEqual([false]);
    expect(h.actions.filter((a) => a.type === 'notice')).toEqual([
      { type: 'notice', message: 'Settings: Autonomy Guarded · Supervisor retries 3 · Autorun on · Parallel 3' },
    ]);
  });

  it('/settings leaves the run settings and the daemon alone when only autonomy changed', async () => {
    const h = harness({ updateRunSettings: vi.fn() }, { saveAutonomy: () => ({ overridden: true }) });
    await runEffect({ type: 'saveSettings', run: {}, autonomous: true, message: 'Settings: Autonomy Full' }, h.deps);
    expect(h.api.updateRunSettings).not.toHaveBeenCalled();
    expect(h.api.updateSettings).not.toHaveBeenCalled();
    expect(h.actions).toContainEqual({ type: 'notice', message: expect.stringMatching(/^Settings: Autonomy Full: ORDEWELL_AUTONOMOUS_MODE in the environment decides/) });
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

  // The daemon says the planner is compacting; the transcript the chat is
  // drawn from cannot, so the load ends with the compaction folded in and the
  // planner busy until its end arrives.
  it('loading a session that is mid-compaction shows it running and holds the planner until its end', async () => {
    const started = { type: 'planner_compaction', compaction: { phase: 'started', id: 'c1', origin: 'ordewell', trigger: 'auto', at: '2026-01-02T00:00:00.000Z' } } as const;
    const h = harness({ adoptSession: vi.fn().mockResolvedValue({ plan: { tasks: [] }, goal: 'g', plannerCompaction: started }) });
    await runEffect({ type: 'loadSession', sessionId: 's9' }, h.deps);

    let state = h.actions.reduce((s, a) => reduce(s, a).state, initialState({ sessionId: 's9' }));
    expect(state.planner).toBe('compacting');
    expect(state.conversation.blocks.filter((b) => b.type === 'compaction')).toEqual([expect.objectContaining({ compactionId: 'c1', status: 'running' })]);

    state = reduce(state, { type: 'sessionMessage', sessionId: 's9', message: { ...started, compaction: { phase: 'ended', id: 'c1', origin: 'ordewell', trigger: 'auto', outcome: 'condensed', at: '2026-01-02T00:00:05.000Z' } } }).state;
    expect(state.planner).toBe('idle');
  });

  it('loading a session restores its plan and goal', async () => {
    const h = harness();
    await runEffect({ type: 'loadSession', sessionId: 's9' }, h.deps);

    expect(h.actions).toContainEqual({ type: 'sessionLoaded', sessionId: 's9', goal: 'Rate limiting' });
    expect(h.actions).toContainEqual({ type: 'planUpdated', plan: { tasks: [{ id: 't1' }] }, sessionId: 's9' });
  });

  it('re-reads the loaded session\'s own run settings, not the file\'s', async () => {
    const run = { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'act' as const };
    const h = harness({ getSettings: vi.fn().mockResolvedValue({ run }) });

    await runEffect({ type: 'loadSession', sessionId: 's9' }, h.deps);

    expect(h.api.getSettings).toHaveBeenCalledWith('s9');
    expect(h.actions).toContainEqual(expect.objectContaining({ type: 'settingsLoaded', sessionId: 's9', settings: { run } }));
  });

  it('shows the loaded session\'s values once its settings answer lands', async () => {
    const run = { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'act' as const };
    const h = harness({ getSettings: vi.fn().mockResolvedValue({ run }) });

    await runEffect({ type: 'loadSession', sessionId: 's9' }, h.deps);
    const state = h.actions.reduce(
      (s, action) => reduce(s, action).state,
      initialState({ sessionId: 's1', runSettings: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } }),
    );

    expect(state.sessionId).toBe('s9');
    expect(state.runSettings.supervisorLevel).toBe('act');
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

  // ADR-0049: the daemon's words name the host that holds it; the advice to
  // reload with /sessions would be refused the same way.
  it('reports a session another host runs in the daemon\'s words, naming that host', async () => {
    const held = 'This session is open in another Ordewell host: a TUI (pid 76271), through its daemon on port 49558 (pid 76279) has held it since 10/24/2026, 1:40:00 AM. Close it there, or stop that process, then open it here.';
    const h = harness({ adoptSession: vi.fn().mockRejectedValue(new DaemonError(held, 409, 'session_held')) });
    await runEffect({ type: 'loadSession', sessionId: 's9' }, h.deps);

    const failure = h.actions.find((a) => a.type === 'failed') as Extract<Action, { type: 'failed' }>;
    expect(failure).toMatchObject({ message: held, code: 'session_held' });
    expect(types(h.actions)).not.toContain('sessionLoaded');
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
    expect(h.actions).toContainEqual({ type: 'sessionDeleted', sessionId: 's9' });
  });

  it('reports a delete the daemon refused instead of announcing it', async () => {
    const h = harness({ deleteSession: vi.fn().mockResolvedValue({ ok: false }) });
    await runEffect({ type: 'deleteSession', sessionId: 's9' }, h.deps);

    expect(messageOf(h.actions, 'failed')).toBe('Could not delete s9: no saved session was removed.');
    expect(h.actions.some((a) => a.type === 'notice' && /Deleted/.test(a.message))).toBe(false);
  });

  it('refresh re-reads runners, settings and models', async () => {
    const h = harness();
    await runEffect({ type: 'refresh' }, h.deps);
    expect(types(h.actions)).toEqual(expect.arrayContaining(['runnersLoaded', 'settingsLoaded', 'modelsLoaded']));
  });

  it('loadScope re-reads the runners and the allowlist, not the models', async () => {
    const h = harness();
    await runEffect({ type: 'loadScope' }, h.deps);
    expect(types(h.actions)).toEqual(expect.arrayContaining(['runnersLoaded', 'settingsLoaded']));
    expect(types(h.actions)).not.toContain('modelsLoaded');
  });

  it('refresh stays silent unless announced', async () => {
    const h = harness();
    await runEffect({ type: 'refresh' }, h.deps);
    expect(types(h.actions)).not.toContain('notice');
  });

  it('an announced refresh posts the notice', async () => {
    const h = harness();
    await runEffect({ type: 'refresh', announce: true }, h.deps);
    expect(h.actions).toContainEqual({ type: 'notice', message: 'Refreshed runners, settings, models and repositories.' });
  });
});

describe('revert (ADR-0054)', () => {
  const preview = { revertible: true, tasks: [{ taskId: 't1', order: 1, title: 'One', repos: ['.'], dependent: false }] };

  it('reads the preview and hands it to the reducer', async () => {
    const revertPreview = vi.fn().mockResolvedValue(preview);
    const h = harness({ revertPreview });
    await runEffect({ type: 'previewRevert', sessionId: 's1', taskId: 't1' }, h.deps);

    expect(revertPreview).toHaveBeenCalledWith('s1', 't1');
    expect(h.actions).toContainEqual({ type: 'revertPreviewed', sessionId: 's1', taskId: 't1', preview });
  });

  it('sends the yes with the ids the user was shown, then re-reads the plan', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, message: 'Reverted task #1 One.' });
    const h = harness({ execute });
    await runEffect({ type: 'revertTask', sessionId: 's1', taskId: 't1', seen: ['t2', 't1'] }, h.deps);

    expect(execute).toHaveBeenCalledWith('s1', { command: 'revert_task', task: 't1', confirmed: true, seen: ['t2', 't1'] });
    expect(h.api.getSession).toHaveBeenCalledWith('s1', '/ws');
    expect(h.actions).toContainEqual({ type: 'notice', message: 'Reverted task #1 One.' });
  });

  it('shows a conflict in the seam\'s words and no notice of success', async () => {
    const words = 'Reverting task "One" conflicts with what landed after it: a.txt. Nothing was reverted, and the integration branch is as it was.';
    const h = harness({ execute: vi.fn().mockRejectedValue(new DaemonError(words, 400, 'refused')) });
    await runEffect({ type: 'revertTask', sessionId: 's1', taskId: 't1', seen: ['t1'] }, h.deps);

    expect(h.actions).toContainEqual({ type: 'failed', message: words, code: 'refused' });
    expect(h.actions.some((a) => a.type === 'notice')).toBe(false);
  });
});

describe('failures', () => {
  // Now that loading adopts the session, this only happens when the daemon has
  // restarted underneath us — so the advice is to reload, not to re-plan.
  it('tells the user to reload a session the daemon no longer holds', async () => {
    const h = harness({ execute: vi.fn().mockRejectedValue(new DaemonError('Session not found', 404, 'session_not_found')) });
    await runEffect({ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'complete' }, h.deps);

    const failure = h.actions.find((a) => a.type === 'failed') as Extract<Action, { type: 'failed' }>;
    expect(failure.message).toContain('/sessions');
    expect(failure.message).not.toMatch(/re-?plan/i);
    // Another surface may have deleted it: a restart is not the only way a session goes.
    expect(failure.message).toMatch(/deleted/);
  });

  it('names the host that runs the session when a call\'s re-adoption was refused, not a reload', async () => {
    const held = 'This session is open in another Ordewell host: the Ordewell daemon on port 3742 (pid 37797) has held it since 10/24/2026, 1:40:00 AM. Close it there, or stop that process, then open it here.';
    const h = harness({ execute: vi.fn().mockRejectedValue(new DaemonError(held, 409, 'session_held')) });
    await runEffect({ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'complete' }, h.deps);

    const failure = h.actions.find((a) => a.type === 'failed') as Extract<Action, { type: 'failed' }>;
    expect(failure.message).toBe(held);
    expect(failure.message).not.toContain('/sessions');
  });

  it('shows why a model edit was refused, without the success notice (#106)', async () => {
    const reason = '"Build" has a live runner, so its model and effort cannot change now: stop the task first, or use the runner\'s own /model';
    const h = harness({ updateTask: vi.fn().mockRejectedValue(new DaemonError(reason, 400, 'refused')) });
    await runEffect({ type: 'updateTask', sessionId: 's1', taskId: 't1', changes: { assignedModel: { modelId: 'haiku', modelLabel: 'Haiku' } }, message: 'Model updated.' }, h.deps);

    expect(h.actions).toContainEqual({ type: 'failed', message: reason, code: 'refused' });
    expect(h.actions).not.toContainEqual({ type: 'notice', message: 'Model updated.' });
  });

  it('leaves an unrelated error message alone', async () => {
    const h = harness({ execute: vi.fn().mockRejectedValue(new Error('disk on fire')) });
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
    await runEffect({ type: 'setApiKey', provider: 'openrouter', key: 'sk-x' }, h.deps);
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
    // Whether the opening is still the session on screen is the reducer's to say.
    const revived = h.actions.find((a): a is Extract<Action, { type: 'openingRevived' }> => a.type === 'openingRevived');
    expect(revived).toMatchObject({ goal: 'ship it' });
    const { effects } = reduce(initialState({ sessionId: revived!.sessionId, planner: 'planning' }), revived!);
    await runEffect(effects[0], h.deps);

    expect(startConversation).toHaveBeenCalledTimes(2);
    expect(startConversation.mock.calls[1][0]).toBe(startConversation.mock.calls[0][0]);
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
      execute: vi.fn()
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
    ['setApiKey', { type: 'setApiKey', provider: 'openrouter', key: 'sk-x' } as Effect, 'OPENROUTER_API_KEY'],
    ['setPlannerChoice', { type: 'setPlannerChoice', provider: 'claude-code', modelId: 'sonnet', effort: 'high', notice: 'Planner set.' } as Effect, 'ORCHESTRATOR_MODEL'],
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

describe('loading an in-flight conversation', () => {
  it('hydrates pending inputs through the shared view and shows the reply they caused', async () => {
    const h = harness({ adoptSession: vi.fn().mockResolvedValue({ goal: 'Build it', plan: {
      tasks: [], conversationHistory: [], pendingTurns: [
        { id: 'p1', source: 'user', text: '/tdd add tests', timestamp: '2026-10-11T10:00:00Z', skills: [
          { invokedBy: 'user', name: 'tdd', source: 'global', path: '~/tdd/SKILL.md' },
        ] },
        { id: 'p2', source: 'supervisor', text: 'Run update: task 1 failed', timestamp: '2026-10-11T10:00:01Z' },
      ],
    } }) });
    await runEffect({ type: 'loadSession', sessionId: 's1' }, h.deps);
    let state = h.actions.reduce((s, action) => reduce(s, action).state, initialState());
    state = reduce(state, { type: 'sessionMessage', sessionId: 's1', message: { type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'Checking tests.' } }).state;

    expect(messagesOf(state).map((b) => [b.role, b.text])).toEqual([
      ['user', '/tdd add tests'], ['wake_up', 'Run update: task 1 failed'], ['system', 'Loaded "Build it".'], ['planner', 'Checking tests.'],
    ]);
    expect(state.conversation.blocks.filter((b) => b.type === 'skill_load')).toMatchObject([{ name: 'tdd', path: '~/tdd/SKILL.md' }]);
  });

  it('keeps a send failure visible and accepts the same prompt again', async () => {
    let state = initialState({ sessionId: 's1' });
    state = { ...state, editor: { ...state.editor, text: 'check tests', cursor: 11 } };
    const sent = reduce(state, { type: 'key', key: { name: 'enter' } });
    state = sent.state;
    const h = harness({ sendConversationMessage: vi.fn().mockRejectedValue(new DaemonError('planner down', 500)) }, {
      dispatch: (action) => { state = reduce(state, action).state; },
    });
    await runEffect(sent.effects[0], h.deps);

    expect(messagesOf(state).map((b) => [b.role, b.text])).toEqual([['user', 'check tests'], ['error', 'planner down']]);
    state = { ...state, editor: { ...state.editor, text: 'check tests', cursor: 11 } };
    expect(reduce(state, { type: 'key', key: { name: 'enter' } }).effects).toEqual([{ type: 'sendMessage', sessionId: 's1', message: 'check tests' }]);
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
      { type: 'settingsLoaded', settings: {}, read: 1, sessionId: 'session-fork' },
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
      { type: 'settingsLoaded', settings: {}, read: 1, sessionId: 'session-fork' },
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
  const checkpoint = { id: 'c1', keptFrom: 2, trigger: 'manual' as const };
  const before = [
    { role: 'user' as const, content: 'build me a parser', timestamp: '2026-01-02T00:00:00.000Z' },
    { role: 'assistant' as const, content: 'Which formats?', timestamp: '2026-01-02T00:00:01.000Z' },
    { role: 'user' as const, content: 'add CSV', timestamp: '2026-01-02T00:00:02.000Z' },
    { role: 'assistant' as const, content: 'CSV it is.', timestamp: '2026-01-02T00:00:03.000Z' },
  ];
  const summary = { role: 'assistant' as const, content: 'Conversation condensed: the state', timestamp: '2026-01-02T00:00:04.000Z', kind: 'compaction' as const, checkpoint };
  const plan = { tasks: [{ id: 't1' }], conversationHistory: [...before, summary] };
  const startedAt = '2026-01-02T00:00:03.500Z';
  const started = (id = 'c1') => ({ type: 'planner_compaction', compaction: { phase: 'started', id, origin: 'ordewell', trigger: 'manual', at: startedAt } });
  const ended = (outcome: string, id = 'c1') => ({ type: 'planner_compaction', compaction: { phase: 'ended', id, origin: 'ordewell', trigger: 'manual', outcome, at: '2026-01-02T00:00:04.000Z' } });
  const generated = { type: 'plan_generated', plan, goal: 'g', runners: [] };

  /** The TUI as /compact finds it: a session read back, scrolled up, with half a thought in the box. */
  const session = (over: Partial<TuiState> = {}): TuiState => initialState({
    sessionId: 'session-1',
    planner: 'condensing',
    conversation: fromTranscript(before, []),
    scroll: 7,
    editor: { ...emptyEditor(), text: 'half a thought', cursor: 14 },
    ...over,
  });

  /** A harness whose planning and standing-follow sockets the test drives from inside the REST call. */
  function sockets(call: (emit: (e: unknown) => void, both: (e: unknown) => void) => Promise<unknown>) {
    let planning: (e: unknown) => void = () => {};
    let standing: (e: unknown) => void = () => {};
    const h = harness({
      streamPlanning: vi.fn().mockImplementation((_id: string, cb: (e: unknown) => void) => {
        planning = cb;
        return { close: vi.fn() };
      }),
      followSession: vi.fn().mockImplementation((_id: string, cb: (e: unknown) => void) => {
        standing = cb;
        return { ready: Promise.resolve(true), ended: new Promise(() => {}), close: vi.fn() };
      }),
      compactConversation: vi.fn().mockImplementation(() => call((e) => planning(e), (e) => { planning(e); standing(e); })),
    });
    return { h, planning: (e: unknown) => planning(e), standing: (e: unknown) => standing(e) };
  }

  const play = (from: TuiState, actions: Action[]): TuiState => actions.reduce((state, action) => reduce(state, action).state, from);
  const compactionsOf = (state: TuiState) => state.conversation.blocks.filter((b) => b.type === 'compaction');

  it('folds the condensed block in where it happened: nothing is redrawn, so scroll, draft and earlier blocks stay', async () => {
    const { h } = sockets(async (emit) => {
      emit(started());
      emit(generated);
      emit(ended('condensed'));
      return { plan, summary: 'the state', keptMessages: 4 };
    });
    const start = session();

    await runEffect({ type: 'compactConversation', sessionId: 'session-1' }, h.deps);
    const state = play(start, h.actions);

    expect(h.api.compactConversation).toHaveBeenCalledWith('session-1');
    expect(types(h.actions)).not.toContain('chatRestored');
    expect(state.conversation.blocks.slice(0, 4)).toEqual(start.conversation.blocks);
    expect(compactionsOf(state)).toEqual([expect.objectContaining({ compactionId: 'c1', status: 'condensed', summary: 'Conversation condensed: the state', origin: 'ordewell', trigger: 'manual' })]);
    // Held in place: a redraw would have reset it to the tail (0).
    expect(state.scroll).toBeGreaterThanOrEqual(7);
    expect(state.editor.text).toBe('half a thought');
    expect(state.planner).toBe('idle');
  });

  it('shows the compaction running while the planner works, then settles it', async () => {
    let midway: Action[] = [];
    const { h } = sockets(async (emit) => {
      emit(started());
      midway = [...h.actions];
      emit(generated);
      emit(ended('condensed'));
      return { plan, summary: 'the state', keptMessages: 4 };
    });
    const start = session();

    await runEffect({ type: 'compactConversation', sessionId: 'session-1' }, h.deps);

    expect(compactionsOf(play(start, midway))).toEqual([expect.objectContaining({ compactionId: 'c1', status: 'running' })]);
    expect(play(start, midway).planner).toBe('condensing');
  });

  it('draws the one block when the daemon answered but both frames were lost', async () => {
    const { h } = sockets(async () => ({ plan, summary: 'the state', keptMessages: 4 }));
    const start = session();

    await runEffect({ type: 'compactConversation', sessionId: 'session-1' }, h.deps);
    const state = play(start, h.actions);

    expect(compactionsOf(state)).toEqual([expect.objectContaining({ compactionId: 'c1', status: 'condensed', summary: 'Conversation condensed: the state' })]);
    expect(state.scroll).toBeGreaterThanOrEqual(7);
    expect(state.planner).toBe('idle');
  });

  it('draws one block however many subscriptions carry the frames, and ignores a late repeat', async () => {
    let stamp = 0;
    const stamped = (e: object) => ({ ...e, stream: 'daemon', seq: ++stamp });
    const lateEnd = stamped(ended('condensed'));
    const { h, standing } = sockets(async (_emit, both) => {
      both(stamped(started()));
      both(stamped(generated));
      both(lateEnd);
      return { plan, summary: 'the state', keptMessages: 4 };
    });
    const start = session();

    await runEffect({ type: 'compactConversation', sessionId: 'session-1' }, h.deps);
    standing(lateEnd);
    standing(ended('failed'));
    const state = play(start, h.actions);

    expect(compactionsOf(state)).toEqual([expect.objectContaining({ status: 'condensed' })]);
  });

  it('keeps every checkpoint as its own block', async () => {
    const second = { ...summary, content: 'Conversation condensed: later', timestamp: '2026-01-02T00:00:09.000Z', checkpoint: { id: 'c2', keptFrom: 4, trigger: 'manual' as const } };
    const later = { tasks: [], conversationHistory: [...before, summary, { role: 'user' as const, content: 'and JSON', timestamp: '2026-01-02T00:00:05.000Z' }, { role: 'assistant' as const, content: 'JSON too.', timestamp: '2026-01-02T00:00:06.000Z' }, second] };
    const { h } = sockets(async (emit) => {
      emit(started('c2'));
      emit({ ...generated, plan: later });
      emit(ended('condensed', 'c2'));
      return { plan: later, summary: 'later', keptMessages: 2 };
    });
    // The first compaction is already on screen, as a session that lived through it has it.
    const start = session({ conversation: fromTranscript([...before, summary], []) });

    await runEffect({ type: 'compactConversation', sessionId: 'session-1' }, h.deps);
    const state = play(start, h.actions);

    expect(compactionsOf(state).map((b) => [b.compactionId, b.summary])).toEqual([
      ['c1', 'Conversation condensed: the state'],
      ['c2', 'Conversation condensed: later'],
    ]);
  });

  it('reports a refusal, and the planner goes back to idle with nothing drawn', async () => {
    const h = harness({ compactConversation: vi.fn().mockRejectedValue(new DaemonError('The conversation is too short to condense.', 400)) });
    const start = session();

    await runEffect({ type: 'compactConversation', sessionId: 'session-1' }, h.deps);
    const state = play(start, h.actions);

    expect(types(h.actions)).toEqual(['failed']);
    expect(messageOf(h.actions, 'failed')).toMatch(/too short/);
    expect(state.planner).toBe('idle');
    expect(compactionsOf(state)).toEqual([]);
    expect(state.editor.text).toBe('half a thought');
  });

  it('ends the running block as failed when the call fails and the daemon\'s end frame never came', async () => {
    const { h } = sockets(async (emit) => {
      emit(started());
      throw new DaemonError('rate limited', 500);
    });
    const start = session();

    await runEffect({ type: 'compactConversation', sessionId: 'session-1' }, h.deps);
    const state = play(start, h.actions);

    expect(compactionsOf(state)).toEqual([expect.objectContaining({ compactionId: 'c1', status: 'failed' })]);
    expect(state.planner).toBe('idle');
  });

  it('ends the running block as stopped when the user stopped it', async () => {
    const { h } = sockets(async (emit) => {
      emit(started());
      throw new DaemonError('The planner turn was stopped.', 409, 'planner_turn_stopped');
    });
    const start = session({ stopRequested: true });

    await runEffect({ type: 'compactConversation', sessionId: 'session-1' }, h.deps);
    const state = play(start, h.actions);

    expect(compactionsOf(state)).toEqual([expect.objectContaining({ status: 'stopped' })]);
    expect(state.planner).toBe('idle');
  });

  it('holds a message typed meanwhile and sends it after the compaction, never into it', async () => {
    const { h } = sockets(async (emit) => {
      emit(started());
      emit(generated);
      emit(ended('condensed'));
      return { plan, summary: 'the state', keptMessages: 4 };
    });
    const start = reduce(session(), { type: 'key', key: { name: 'enter' } }).state;

    expect(start.queuedPrompts).not.toBe(initialState().queuedPrompts);
    expect(start.editor.text).toBe('');
    await runEffect({ type: 'compactConversation', sessionId: 'session-1' }, h.deps);
    const settled = reduce(play(start, h.actions.slice(0, -1)), h.actions.at(-1)!);

    expect(settled.effects).toEqual([{ type: 'sendMessage', sessionId: 'session-1', message: 'half a thought' }]);
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

    expect(h.actions).toContainEqual({ type: 'statusUpdate', sessionId: 's1', tasks: [{ id: 'b', status: 'awaiting_user', verdict: null, isolation }] });
  });

  it('carries mid-run landings without a gate from status updates and clears them after merging', async () => {
    const landed = [{ taskId: 't1', order: 1, title: 'Change' }];
    const repos = [{ path: '.', integrationBranch: 'ordewell/r1/integration', baseRef: 'abc', landed }];
    const h = running([
      { type: 'status_update', tasks: [], runMerge: { waitingAtGate: false, paused: false, repos, landed } },
      { type: 'status_update', tasks: [] },
    ]);

    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    expect(h.actions.filter((a) => a.type === 'statusUpdate')).toEqual([
      { type: 'statusUpdate', sessionId: 's1', tasks: [], runMerge: { waitingAtGate: false, paused: false, repos, landed } },
      { type: 'statusUpdate', sessionId: 's1', tasks: [] },
    ]);
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

    expect(types(h.actions)).toEqual(expect.arrayContaining(['isolationBlocked', 'statusUpdate']));
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

  it('carries the supervisor deferral of an isolation_handoff through', async () => {
    const landed = [{ taskId: 't1', order: 1, title: 'One' }];
    const repos = [{ path: '.', integrationBranch: 'ordewell/r1/integration', baseRef: 'abc', landed }];
    const h = running([{ type: 'isolation_handoff', repos, landed, deferredTo: 'supervisor' }]);

    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    expect(h.actions).toContainEqual({ type: 'isolationHandoff', handoff: { repos, landed, deferredTo: 'supervisor' }, sessionId: 's1' });
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

  it('a merged run says where it landed, and leaves the run to the Session\'s own word on whether it closed', async () => {
    const h = harness({ mergeRun: vi.fn().mockResolvedValue({ outcome: 'merged' }) } as Partial<OrdewellApi>);

    await runEffect({ type: 'isolationMerge', sessionId: 's1', branch: 'ordewell/r1/integration' }, h.deps);

    expect(messageOf(h.actions, 'notice')).toMatch(/Merged ordewell\/r1\/integration into your checked-out branch/);
    expect(types(h.actions)).toEqual(['notice']);
  });

  it('keeps the run to hand over after a Merge all that did not merge everything', async () => {
    const h = harness({ mergeRun: vi.fn().mockResolvedValue({ outcome: 'conflict', repo: 'web', files: ['w.txt'], landed: ['api'] }) } as Partial<OrdewellApi>);

    await runEffect({ type: 'isolationMerge', sessionId: 's1', branch: 'ordewell/r1/integration', group: true }, h.deps);

    expect(types(h.actions)).not.toContain('runClosed');
  });

  it('folds what any surface\'s Merge all did, and closes the run only when the Session says it closed', async () => {
    const blocked = { outcome: 'blocked' as const, blocked: [{ repo: 'web', reason: 'conflict' as const, files: ['w.txt'] }] };
    const h = running([
      { type: 'isolation_merge', result: blocked },
      { type: 'isolation_merge', result: { outcome: 'merged' } },
      { type: 'run_closed' },
    ]);

    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    expect(h.actions.filter((a) => a.type === 'isolationMerged' || a.type === 'runClosed')).toEqual([
      { type: 'isolationMerged', result: blocked, sessionId: 's1' },
      { type: 'isolationMerged', result: { outcome: 'merged' }, sessionId: 's1' },
      { type: 'runClosed', sessionId: 's1' },
    ]);
  });

  it.each([
    ['conflict', /conflicted, so it was aborted: your tree is as it was/],
    ['failed', /merge already in progress/],
  ] as const)('a %s merge is reported as a failure that changed nothing', async (outcome, pattern) => {
    const h = harness({ mergeRun: vi.fn().mockResolvedValue({ outcome, repo: '.' }) } as Partial<OrdewellApi>);

    await runEffect({ type: 'isolationMerge', sessionId: 's1', branch: 'ordewell/r1/integration' }, h.deps);

    expect(messageOf(h.actions, 'failed')).toMatch(pattern);
    expect(messageOf(h.actions, 'notice')).toBeUndefined();
  });

  it('discard leaves telling the reducer the run is gone to the Session', async () => {
    const h = harness({ discardRun: vi.fn().mockResolvedValue(undefined) } as Partial<OrdewellApi>);

    await runEffect({ type: 'isolationDiscard', sessionId: 's1', branch: 'ordewell/r1/integration' }, h.deps);

    expect(types(h.actions)).toEqual(['notice']);
  });

  it('cleanup refreshes the plan, since the worktrees the marks named are gone', async () => {
    const cleanupRun = vi.fn().mockResolvedValue(undefined);
    const h = harness({ cleanupRun } as Partial<OrdewellApi>);

    await runEffect({ type: 'isolationCleanup', sessionId: 's1', branch: 'ordewell/r1/integration' }, h.deps);

    expect(cleanupRun).toHaveBeenCalledWith('s1');
    expect(h.api.getSession).toHaveBeenCalled();
    expect(messageOf(h.actions, 'notice')).toMatch(/ordewell\/r1\/integration is kept/);
  });

  it('a refresh takes the run the Session holds, so marks are never rebuilt from the saved record', async () => {
    const view = { tasks: [], runMerge: null, handoff: null, mergeResult: null };
    const h = harness({ cleanupRun: vi.fn().mockResolvedValue(undefined), getSession: vi.fn().mockResolvedValue({ meta: { id: 's1' }, plan: { tasks: [] }, run: view }) } as Partial<OrdewellApi>);

    await runEffect({ type: 'isolationCleanup', sessionId: 's1', branch: 'ordewell/r1/integration' }, h.deps);

    expect(h.actions).toContainEqual({ type: 'runSnapshot', view, sessionId: 's1' });
    expect(types(h.actions).indexOf('runSnapshot')).toBeGreaterThan(types(h.actions).indexOf('planUpdated'));
  });

  it('a load takes the run of the session it adopted', async () => {
    const view = { tasks: [], runMerge: null, handoff: null, mergeResult: null };
    const h = harness({ adoptSession: vi.fn().mockResolvedValue({ ok: true, plan: { tasks: [{ id: 't1' }] }, goal: 'Rate limiting', run: view }) } as Partial<OrdewellApi>);

    await runEffect({ type: 'loadSession', sessionId: 's9' }, h.deps);

    expect(h.actions).toContainEqual({ type: 'runSnapshot', view, sessionId: 's9' });
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
    expect(types(h.actions)).toEqual(['planRefreshed', 'notice']);
    expect(h.actions.at(-1)).toMatchObject({ message: expect.stringContaining('starts once a slot is free') });
  });

  it('a refused second resolver surfaces the daemon\'s reason, and says nothing was added', async () => {
    const h = harness({ resolveConflictAsTask: vi.fn().mockRejectedValue(new Error('Task "R" already resolves the conflict of task "T".')) } as Partial<OrdewellApi>);

    await runEffect({ type: 'resolveConflict', sessionId: 's1', taskId: 't2' }, h.deps);

    expect(h.actions.at(-1)).toMatchObject({ type: 'failed', message: expect.stringContaining('already resolves') });
    expect(types(h.actions)).not.toContain('notice');
  });

  it('a refused action surfaces the daemon\'s reason', async () => {
    const h = harness({ discardRun: vi.fn().mockRejectedValue(new Error('The run is still running: stop it first')) } as Partial<OrdewellApi>);

    await runEffect({ type: 'isolationDiscard', sessionId: 's1', branch: 'b' }, h.deps);

    expect(messageOf(h.actions, 'failed')).toBe('The run is still running: stop it first');
  });
});

describe('a structured task\'s log, messages and interrupt', () => {
  it('opens with the latest saved attempt and reports it to the reducer', async () => {
    const getTaskLogAttempts = vi.fn().mockResolvedValue({ attempts: [1, 2] });
    const getTaskLog = vi.fn().mockResolvedValue({ attempt: 2, events: [{ type: 'text', text: 'hi' }], position: { stream: 'd', seq: 5 } });
    const h = harness({ getTaskLogAttempts, getTaskLog } as Partial<OrdewellApi>);

    await runEffect({ type: 'openTaskLog', sessionId: 's1', taskId: 't1' }, h.deps);

    expect(getTaskLog).toHaveBeenCalledWith('s1', 't1', 2, '/ws');
    expect(h.actions).toEqual([
      { type: 'taskLogLoaded', taskId: 't1', attempts: [1, 2], attempt: 2, events: [{ type: 'text', text: 'hi' }], position: { stream: 'd', seq: 5 }, sessionId: 's1' },
    ]);
  });

  it('answers an attempt switch with just that attempt', async () => {
    const getTaskLog = vi.fn().mockResolvedValue({ attempt: 1, events: [{ type: 'turn_start', message: 'x' }] });
    const h = harness({ getTaskLog } as Partial<OrdewellApi>);

    await runEffect({ type: 'loadTaskAttempt', sessionId: 's1', taskId: 't1', attempt: 1 }, h.deps);

    expect(getTaskLog).toHaveBeenCalledWith('s1', 't1', 1, '/ws');
    expect(h.actions).toEqual([
      { type: 'taskLogLoaded', taskId: 't1', attempt: 1, events: [{ type: 'turn_start', message: 'x' }], sessionId: 's1' },
    ]);
  });

  it('sends a message and leaves the queue to the stream', async () => {
    const h = harness();

    await runEffect({ type: 'sendTaskMessage', sessionId: 's1', taskId: 't1', text: 'use Postgres' }, h.deps);

    expect(h.api.execute).toHaveBeenCalledWith('s1', { command: 'message_task', task: 't1', text: 'use Postgres' });
    expect(h.actions).toEqual([]);
  });

  it('takes a queued message back and leaves what it says to the timeline', async () => {
    const h = harness();

    await runEffect({ type: 'removeTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm1' }, h.deps);

    expect(h.api.execute).toHaveBeenCalledWith('s1', { command: 'remove_queued', task: 't1', id: 'm1' });
    expect(h.actions).toEqual([]);
  });

  it('shows the daemon\'s words when a message to take back had already gone out', async () => {
    const refusal = new DaemonError('That message to task #1 "Build" was already delivered or taken back.', 400, 'refused');
    const h = harness({ execute: vi.fn().mockRejectedValue(refusal) });

    await runEffect({ type: 'removeTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm1' }, h.deps);

    expect(h.actions).toEqual([{ type: 'failed', message: refusal.message, code: 'refused' }]);
  });

  it('continues a finished task, holding the execution stream open when asked to watch (ADR-0018, K1)', async () => {
    const order: string[] = [];
    const execute = vi.fn().mockImplementation(async () => { order.push('execute'); return { ok: true, message: 'Done.' }; });
    const streamExecution = vi.fn().mockImplementation((_id: string, _cb: (e: unknown) => void, onReady?: (error?: Error) => void) => {
      order.push('streamExecution');
      onReady?.();
      return Promise.resolve();
    });
    const h = harness({ execute, streamExecution } as Partial<OrdewellApi>);

    await runEffect({ type: 'continueTask', sessionId: 's1', taskId: 't1', text: 'also handle arrays', watch: true }, h.deps);

    expect(execute).toHaveBeenCalledWith('s1', { command: 'retry_task', task: 't1', from: 'session', message: 'also handle arrays' });
    expect(order).toEqual(['streamExecution', 'execute']);
  });

  it('continues without a second stream while a run is already watched', async () => {
    const h = harness();

    await runEffect({ type: 'continueTask', sessionId: 's1', taskId: 't1', text: 'go on' }, h.deps);

    expect(h.deps.api.execute).toHaveBeenCalledWith('s1', { command: 'retry_task', task: 't1', from: 'session', message: 'go on' });
    expect(h.deps.api.streamExecution).not.toHaveBeenCalled();
  });

  it('interrupts the task, leaving what it says to the timeline', async () => {
    const h = harness();

    await runEffect({ type: 'interruptTask', sessionId: 's1', taskId: 't1' }, h.deps);

    expect(h.api.execute).toHaveBeenCalledWith('s1', { command: 'interrupt_task', task: 't1' });
    expect(h.actions).toEqual([]);
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

  // The user may have loaded another session before the answer failed; the
  // reducer drops a failure that names a session no longer on screen.
  it.each([
    { type: 'respondApproval', sessionId: 's1', approvalId: 'ap-1', granted: true },
    { type: 'answerTaskApproval', sessionId: 's1', approvalId: 'ap-1', answer: { decision: 'allow' } },
  ] as Effect[])('names the session a lost $type was for', async (effect) => {
    const h = harness({ respondToApproval: vi.fn().mockRejectedValue(new Error('HTTP 409')) } as Partial<OrdewellApi>);

    await runEffect(effect, h.deps);

    expect(h.actions).toContainEqual(expect.objectContaining({ type: 'failed', sessionId: 's1' }));
  });
});


describe('following the session', () => {
  /** A harness whose follow socket the test drives, and can end. */
  function following(api: Partial<OrdewellApi> = {}) {
    const follows: Array<{ sessionId: string; emit: (e: unknown) => void; close: Mock; end: (outcome?: 'lost') => void }> = [];
    const h = harness({
      followSession: vi.fn().mockImplementation((sessionId: string, cb: (e: unknown) => void) => {
        let end: (outcome?: 'lost') => void = () => {};
        const ended = new Promise<'lost' | void>((resolve) => { end = resolve; });
        const close = vi.fn(() => end());
        follows.push({ sessionId, emit: cb, close, end });
        return { ready: Promise.resolve(true), ended, close };
      }),
      ...api,
    });
    return { ...h, follows };
  }

  it('is open before the first turn is sent, so a run the turn\'s plan starts on its own is drawn', async () => {
    const h = following({ startConversation: vi.fn().mockResolvedValue({ tasks: [{ id: 'a', title: 'A' }] }) });

    await runEffect({ type: 'startConversation', goal: 'ship it' }, h.deps);
    const [follow] = h.follows;
    follow.emit({ type: 'execution_action', record: { command: 'run_plan', actor: 'autorun', outcome: 'done', at: '2026-10-12T10:00:00Z' }, text: 'Started the plan — by autorun.' });
    follow.emit({ type: 'task_started', taskId: 'a', order: 1, title: 'A', runner: 'claude-code' });
    follow.emit({ type: 'execution_complete', summary: { total: 1, completed: 0, failed: 1 } });

    expect(vi.mocked(h.api.followSession).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(h.api.startConversation).mock.invocationCallOrder[0]);
    expect(follow.sessionId).toBe('session-new');
    expect(types(h.actions)).toEqual(expect.arrayContaining(['taskStarted', 'executionComplete']));
    expect(h.actions).toContainEqual(expect.objectContaining({ type: 'sessionMessage', message: expect.objectContaining({ type: 'execution_action' }) }));
  });

  it('keeps one follow for the session across turns and runs', async () => {
    const h = following();
    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'one' }, h.deps);
    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'two' }, h.deps);
    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    expect(h.api.followSession).toHaveBeenCalledTimes(1);
  });

  it('shows a broadcast once when the follow and the run\'s own stream both carry it', async () => {
    let run: (e: unknown) => void = () => {};
    const h = following({
      streamExecution: vi.fn().mockImplementation((_id: string, cb: (e: unknown) => void, onReady?: (error?: Error) => void) => {
        run = cb;
        onReady?.();
        return Promise.resolve();
      }),
    });
    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'one' }, h.deps);
    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);
    const start = { type: 'task_started', taskId: 'a', order: 1, title: 'A', runner: 'claude-code' };
    h.follows[0].emit(start);
    run(start);

    expect(h.actions.filter((a) => a.type === 'taskStarted')).toHaveLength(1);
  });

  it('follows a loaded session, and leaves the one it was on', async () => {
    const h = following();
    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'one' }, h.deps);
    await runEffect({ type: 'loadSession', sessionId: 's9' }, h.deps);

    expect(h.follows.map((f) => f.sessionId)).toEqual(['s1', 's9']);
    expect(h.follows[0].close).toHaveBeenCalled();
    expect(h.follows[1].close).not.toHaveBeenCalled();
  });

  it('lands the connect snapshot of a loaded session even though it arrives before the session is adopted', async () => {
    const view = { tasks: [{ id: 'a', order: 1, title: 'A', type: 'ai', status: 'in_progress', dependencies: [], subtasks: [] }], runMerge: null, handoff: null, mergeResult: null };
    const h: ReturnType<typeof following> = following({
      adoptSession: vi.fn().mockImplementation(async () => {
        h.follows.at(-1)!.emit({ type: 'run_snapshot', sessionId: 's9', view });
        return { plan: { tasks: [{ id: 'a' }] }, goal: 'g' };
      }),
    });
    await runEffect({ type: 'loadSession', sessionId: 's9' }, h.deps);

    const order = types(h.actions);
    expect(h.actions).toContainEqual({ type: 'runSnapshot', view, sessionId: 's9' });
    expect(order.indexOf('runSnapshot')).toBeGreaterThan(order.indexOf('sessionLoaded'));
    // Held while the load was answered, it goes on top of the plan the load read.
    expect(order.indexOf('runSnapshot')).toBeGreaterThan(order.indexOf('planUpdated'));
    const state = h.actions.reduce((s, a) => reduce(s, a).state, initialState({ sessionId: 's1' }));
    expect(state.run.tasks.map((t) => [t.id, t.status])).toEqual([['a', 'in_progress']]);
  });

  it('delivers a connect snapshot arriving after the load as it does any other', async () => {
    const view = { tasks: [], runMerge: null, handoff: null, mergeResult: null };
    const h = following();
    await runEffect({ type: 'loadSession', sessionId: 's9' }, h.deps);
    h.follows.at(-1)!.emit({ type: 'run_snapshot', sessionId: 's9', view });

    expect(h.actions).toContainEqual({ type: 'runSnapshot', view, sessionId: 's9' });
  });

  it('drops the snapshot of a session whose load failed', async () => {
    const view = { tasks: [], runMerge: null, handoff: null, mergeResult: null };
    const h: ReturnType<typeof following> = following({
      adoptSession: vi.fn().mockImplementation(async () => {
        h.follows.at(-1)!.emit({ type: 'run_snapshot', sessionId: 's9', view });
        throw new DaemonError('Session not found', 404, 'session_not_found');
      }),
    });
    await runEffect({ type: 'loadSession', sessionId: 's9' }, h.deps);

    expect(types(h.actions)).not.toContain('runSnapshot');
  });

  it('goes on following the session on screen when loading another fails', async () => {
    const h = following({ adoptSession: vi.fn().mockRejectedValue(new DaemonError('Session not found', 404, 'session_not_found')) });
    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'one' }, h.deps);
    await runEffect({ type: 'loadSession', sessionId: 's9' }, h.deps);

    expect(h.follows.map((f) => f.sessionId)).toEqual(['s1', 's9', 's1']);
    expect(h.follows[1].close).toHaveBeenCalled();
    expect(h.follows[2].close).not.toHaveBeenCalled();
  });

  it('follows a fork it switches to', async () => {
    const h = following({ forkConversation: vi.fn().mockResolvedValue({ sessionId: 'session-fork', goal: 'g', plan: { tasks: [] } }) });
    await runEffect({ type: 'forkConversation', sessionId: 's1' }, h.deps);

    expect(h.follows.map((f) => f.sessionId)).toEqual(['session-fork']);
  });

  it('stops following a session the TUI closes', async () => {
    const h = following();
    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'one' }, h.deps);
    await runEffect({ type: 'closeSession', sessionId: 's1' }, h.deps);

    expect(h.follows[0].close).toHaveBeenCalled();
  });

  it('keeps the session when a force send stopped its opening turn, so the forced turn\'s reply lands', async () => {
    const stopped = new DaemonError('The planner turn was stopped', 409, 'planner_turn_stopped');
    const h = following({ startConversation: vi.fn().mockRejectedValue(stopped) });
    await runEffect({ type: 'startConversation', goal: 'ship it' }, h.deps);

    expect(types(h.actions)).not.toContain('sessionCleared');
    expect(h.follows[0].close).not.toHaveBeenCalled();
    expect(h.actions).toContainEqual({ type: 'failed', message: 'The planner turn was stopped', code: 'planner_turn_stopped', turn: true, sessionId: 'session-new' });
  });

  it('drops the follow of a first turn the daemon never registered', async () => {
    const h = following({ startConversation: vi.fn().mockRejectedValue(new DaemonError('planner down', 500)) });
    await runEffect({ type: 'startConversation', goal: 'ship it' }, h.deps);

    expect(h.follows[0].close).toHaveBeenCalled();
  });

  it('opens a new follow after the last one was lost', async () => {
    const h = following();
    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'one' }, h.deps);
    h.follows[0].end('lost');
    await Promise.resolve();
    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'two' }, h.deps);

    expect(h.api.followSession).toHaveBeenCalledTimes(2);
  });

  it('reports a lost follow, which the reducer speaks only while a run is shown', async () => {
    const h = following();
    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'one' }, h.deps);
    h.follows[0].end('lost');
    await vi.waitFor(() => expect(h.actions).toContainEqual({ type: 'followLost', sessionId: 's1' }));
  });

  it('reopens a follow that dropped while idle, so a run nobody here started is still seen', async () => {
    vi.useFakeTimers();
    try {
      const h = following();
      await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'one' }, h.deps);
      h.follows[0].end('lost');
      await Promise.resolve();
      await Promise.resolve();
      expect(h.api.followSession).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(600);

      expect(h.api.followSession).toHaveBeenCalledTimes(2);
      expect(h.follows[1].sessionId).toBe('s1');
      expect(h.actions).toContainEqual({ type: 'followRestored', sessionId: 's1' });
    } finally {
      vi.useRealTimers();
    }
  });

  // A lost follow leaves no entry, only a pending retry. Closing or deleting
  // the session must cancel that timer, or it reopens a session the user is done with.
  it('does not reopen a session the user closed while its follow was down', async () => {
    vi.useFakeTimers();
    try {
      const h = following();
      await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'one' }, h.deps);
      h.follows[0].end('lost');
      await Promise.resolve();
      await Promise.resolve();
      await runEffect({ type: 'closeSession', sessionId: 's1' }, h.deps);

      await vi.advanceTimersByTimeAsync(9_000);

      expect(h.api.followSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reopen a session the user deleted while its follow was down', async () => {
    vi.useFakeTimers();
    try {
      const h = following();
      await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'one' }, h.deps);
      h.follows[0].end('lost');
      await Promise.resolve();
      await Promise.resolve();
      await runEffect({ type: 'deleteSession', sessionId: 's1' }, h.deps);

      await vi.advanceTimersByTimeAsync(9_000);

      expect(h.api.followSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a loss to the run\'s own stream while one is open, so it is reported once', async () => {
    let lose: () => void = () => {};
    const h = following({
      streamExecution: vi.fn().mockImplementation((_id: string, _cb: unknown, onReady?: (error?: Error) => void) => {
        onReady?.();
        return new Promise<'lost'>((resolve) => { lose = () => resolve('lost'); });
      }),
    });
    const running = runEffect({ type: 'execute', sessionId: 's1' }, h.deps);
    await vi.waitFor(() => expect(h.api.streamExecution).toHaveBeenCalled());
    h.follows[0].end('lost');
    lose();
    await running;
    await Promise.resolve();

    expect(types(h.actions)).toContain('executionLost');
    expect(types(h.actions)).not.toContain('followLost');
  });

  it('a follow that is not the current one says nothing when it ends', async () => {
    const h = following();
    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'one' }, h.deps);
    await runEffect({ type: 'loadSession', sessionId: 's9' }, h.deps);
    h.follows[0].end('lost');
    await Promise.resolve();
    await Promise.resolve();

    expect(types(h.actions)).not.toContain('followLost');
  });
});


describe('the welcome repositories and branches', () => {
  const ready = { status: 'ready' as const, repos: [{ path: '.', head: { kind: 'branch' as const, branch: 'main', commit: 'a1b2c3d' }, dirty: false }], shared: [] };

  it('reads the preview at startup with the workspace, and says it is loading first', async () => {
    const h = harness({ getIsolationPreview: vi.fn().mockResolvedValue({ preview: ready }) });

    await runEffect({ type: 'refresh' }, h.deps);

    expect(h.api.getIsolationPreview).toHaveBeenCalledWith('/ws');
    expect(h.actions).toContainEqual({ type: 'isolationPreviewLoading', read: 1 });
    expect(h.actions).toContainEqual({ type: 'isolationPreviewLoaded', preview: ready, read: 1 });
  });

  it('reads it again when the shared settings change what a run would isolate', async () => {
    const h = harness({ getIsolationPreview: vi.fn().mockResolvedValue({ preview: ready }) });

    await runEffect({ type: 'loadScope' }, h.deps);

    expect(h.api.getIsolationPreview).toHaveBeenCalledWith('/ws');
    expect(types(h.actions)).toEqual(expect.arrayContaining(['isolationPreviewLoading', 'isolationPreviewLoaded']));
  });

  it('keeps a failed read as failed, with the reason, instead of claiming no repository', async () => {
    const h = harness({ getIsolationPreview: vi.fn().mockRejectedValue(new Error('the server had stopped')) });

    await runEffect({ type: 'loadIsolationPreview' }, h.deps);

    expect(h.actions).toContainEqual({ type: 'isolationPreviewFailed', read: 1, message: 'the server had stopped' });
    expect(h.actions.some((a) => a.type === 'failed')).toBe(false);
  });

  it('revives a stopped daemon and reads the preview once on the retry', async () => {
    const getIsolationPreview = vi.fn()
      .mockRejectedValueOnce(refused())
      .mockResolvedValueOnce({ preview: ready });
    const h = harness({ getIsolationPreview });

    await runEffect({ type: 'loadIsolationPreview' }, h.deps);

    expect(getIsolationPreview).toHaveBeenCalledTimes(2);
    expect(reviveMock(h.deps)).toHaveBeenCalledTimes(1);
    expect(h.actions).toContainEqual({ type: 'isolationPreviewLoaded', preview: ready, read: 2 });
  });

  it('asks the welcome to read again when a revive replaces the daemon', async () => {
    const h = harness({
      getRunners: vi.fn()
        .mockRejectedValueOnce(refused())
        .mockResolvedValue({ runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true }], orchestratorModel: 'm/1' }),
    });

    await runEffect({ type: 'loadRunners' }, h.deps);

    expect(types(h.actions)).toContain('daemonReconnected');
  });

  it('numbers overlapping reads so the reducer can drop the older answer', async () => {
    const answers: Array<(value: { preview: IsolationPreview }) => void> = [];
    const h = harness({ getIsolationPreview: vi.fn().mockImplementation(() => new Promise((resolve) => { answers.push(resolve); })) });

    const first = runEffect({ type: 'loadIsolationPreview' }, h.deps);
    const second = runEffect({ type: 'loadIsolationPreview' }, h.deps);
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[1]({ preview: ready });
    await second;
    answers[0]({ preview: { status: 'no-repo', repos: [], shared: [] } });
    await first;

    expect(h.actions).toContainEqual({ type: 'isolationPreviewLoaded', preview: ready, read: 2 });
    expect(h.actions).toContainEqual({ type: 'isolationPreviewLoaded', preview: { status: 'no-repo', repos: [], shared: [] }, read: 1 });
  });
});
