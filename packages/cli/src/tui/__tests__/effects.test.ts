import { describe, it, expect, vi, type Mock } from 'vitest';
import { ConversationQueue, runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import { initialState, reduce, type Action } from '../reducer';
import type { Effect } from '../reducer';
import type { TuiState } from '../state';

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
      processQueued: vi.fn().mockResolvedValue({ ok: true }),
      taskControl: vi.fn().mockResolvedValue({ ok: true }),
      markTaskComplete: vi.fn().mockResolvedValue({ ok: true }),
      markTaskIncomplete: vi.fn().mockResolvedValue({ ok: true }),
      addTask: vi.fn().mockResolvedValue({ ok: true }),
      updateTask: vi.fn().mockResolvedValue({ ok: true }),
      removeTask: vi.fn().mockResolvedValue({ ok: true }),
      getSessions: vi.fn().mockResolvedValue([]),
      getSession: vi.fn().mockResolvedValue({ meta: { id: 's1', goal: 'g' }, plan: { tasks: [] } }),
      adoptSession: vi.fn().mockResolvedValue({ plan: { tasks: [{ id: 't1' }] }, goal: 'Rate limiting' }),
      deleteSession: vi.fn().mockResolvedValue({ ok: true }),
      getSettings: vi.fn().mockResolvedValue({}),
      updateSettings: vi.fn().mockResolvedValue({}),
      sendCommand: vi.fn().mockResolvedValue({ ok: true, settings: { tdd: { enabled: true } } }),
      getRunners: vi.fn().mockResolvedValue({ runners: [], orchestratorModel: 'm/1' }),
      setRunnerEnabled: vi.fn().mockResolvedValue({ ok: true }),
      getModels: vi.fn().mockResolvedValue({ models: [], providers: [] }),
      streamPlanning: vi.fn().mockReturnValue({ close: vi.fn() }),
      streamExecution: vi.fn().mockImplementation((_id: string, _callback: (event: any) => void, onReady?: (error?: Error) => void) => {
        onReady?.();
        return Promise.resolve();
      }),
      ...api,
    } as OrdewellApi,
    workspace: '/ws',
    conversationQueue: new ConversationQueue(),
    port: 3742,
    dispatch: (action) => actions.push(action),
    newSessionId: () => 'session-new',
    setEnvVar: (key, value) => { env[key] = value; },
    openTerminal: vi.fn().mockResolvedValue({ ok: true, message: 'Opened a terminal for this task.' }),
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

  return { deps, actions, env, exit, api: deps.api as Record<string, any> };
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

    expect(h.api.startConversation).toHaveBeenCalledWith('session-new', 'ship it', undefined, '/ws');
    expect(h.actions[0]).toEqual({ type: 'sessionStarted', sessionId: 'session-new', goal: 'ship it' });
  });

  it('streams research steps into the status line while planning', async () => {
    let onEvent: (e: any) => void = () => {};
    const h = harness({
      streamPlanning: vi.fn().mockImplementation((_id: string, cb: (e: any) => void) => {
        onEvent = cb;
        return { close: vi.fn() };
      }),
      startConversation: vi.fn().mockImplementation(async () => {
        onEvent({ type: 'research_step', tool: 'grep', args: '{"pattern":"auth"}' });
        return { tasks: [] };
      }),
    });

    await runEffect({ type: 'startConversation', goal: 'x' }, h.deps);
    expect(types(h.actions)).toContain('researchStep');
  });

  it('translates the whole research stream — call, outcome, and reasoning', async () => {
    let onEvent: (e: any) => void = () => {};
    const h = harness({
      streamPlanning: vi.fn().mockImplementation((_id: string, cb: (e: any) => void) => {
        onEvent = cb;
        return { close: vi.fn() };
      }),
      startConversation: vi.fn().mockImplementation(async () => {
        onEvent({ type: 'plan_thinking', text: 'checking the auth module' });
        onEvent({ type: 'research_step', tool: 'bash', args: '{"command":"rm -rf /"}', toolCallId: 'tc-1' });
        onEvent({
          type: 'research_step_done',
          step: {
            id: 'rs-1', tool: 'bash', args: '{"command":"rm -rf /"}',
            result: 'Command refused: writes are the runners\' job.',
            success: false, outcome: 'refused', toolCallId: 'tc-1', timestamp: '',
          },
        });
        return { tasks: [] };
      }),
    });

    await runEffect({ type: 'startConversation', goal: 'x' }, h.deps);

    expect(h.actions).toContainEqual({ type: 'plannerThinking', text: 'checking the auth module', sessionId: 'session-new' });
    expect(h.actions).toContainEqual({
      type: 'researchStep', summary: 'bash: rm -rf /', toolCallId: 'tc-1', sessionId: 'session-new',
    });
    expect(h.actions).toContainEqual({
      type: 'researchStepDone',
      summary: 'bash: rm -rf /',
      toolCallId: 'tc-1',
      outcome: 'refused',
      result: 'Command refused: writes are the runners\' job.',
      sessionId: 'session-new',
    });
  });

  it('surfaces a planner question as a message rather than a plan', async () => {
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

    expect(h.actions).toContainEqual({ type: 'plannerMessage', content: 'Which database?', sessionId: 'session-new' });
  });

  it('speaks a reply the socket already delivered once, not twice with the REST copy', async () => {
    // The daemon broadcasts the turn and also leaves it as the plan's last
    // assistant entry; the reply is the same one thing either way.
    let onEvent: (e: any) => void = () => {};
    const h = harness({
      streamPlanning: vi.fn().mockImplementation((_id: string, cb: (e: any) => void) => {
        onEvent = cb;
        return { close: vi.fn() };
      }),
      sendConversationMessage: vi.fn().mockImplementation(async () => {
        onEvent({ type: 'planner_message', content: 'Tasks updated:\n- #3 added' });
        return {
          tasks: [],
          conversationHistory: [
            { role: 'user', content: 'add a hardening task' },
            { role: 'assistant', content: 'Tasks updated:\n- #3 added' },
          ],
        };
      }),
    });

    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'add a hardening task' }, h.deps);

    const spoken = h.actions.filter((a) => a.type === 'plannerMessage');
    expect(spoken).toEqual([{ type: 'plannerMessage', content: 'Tasks updated:\n- #3 added', sessionId: 's1' }]);
  });

  it('falls back to the REST reply when the socket delivered a different turn', async () => {
    let onEvent: (e: any) => void = () => {};
    const h = harness({
      streamPlanning: vi.fn().mockImplementation((_id: string, cb: (e: any) => void) => {
        onEvent = cb;
        return { close: vi.fn() };
      }),
      sendConversationMessage: vi.fn().mockImplementation(async () => {
        onEvent({ type: 'planner_message', content: 'Looking into it.' });
        return {
          tasks: [],
          conversationHistory: [{ role: 'assistant', content: 'Which database?' }],
        };
      }),
    });

    await runEffect({ type: 'sendMessage', sessionId: 's1', message: 'x' }, h.deps);

    expect(h.actions.filter((a) => a.type === 'plannerMessage')).toEqual([
      { type: 'plannerMessage', content: 'Looking into it.', sessionId: 's1' },
      { type: 'plannerMessage', content: 'Which database?', sessionId: 's1' },
    ]);
  });

  it('debounces plan_token deltas into a single plannerToken dispatch', async () => {
    vi.useFakeTimers();
    try {
      let onEvent: (e: any) => void = () => {};
      let resolveCall: () => void = () => {};
      const gate = new Promise<void>((resolve) => { resolveCall = resolve; });
      const h = harness({
        streamPlanning: vi.fn().mockImplementation((_id: string, cb: (e: any) => void) => {
          onEvent = cb;
          return { close: vi.fn() };
        }),
        startConversation: vi.fn().mockImplementation(async () => {
          onEvent({ type: 'plan_token', token: 'Hel' });
          onEvent({ type: 'plan_token', token: 'lo' });
          await gate;
          return { tasks: [] };
        }),
      });

      const pending = runEffect({ type: 'startConversation', goal: 'x' }, h.deps);
      await vi.advanceTimersByTimeAsync(100);
      expect(h.actions.filter((a) => a.type === 'plannerToken')).toEqual([
        { type: 'plannerToken', text: 'Hello', sessionId: 'session-new' },
      ]);

      resolveCall();
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes a pending token burst before a research_step lands, preserving order', async () => {
    let onEvent: (e: any) => void = () => {};
    const h = harness({
      streamPlanning: vi.fn().mockImplementation((_id: string, cb: (e: any) => void) => {
        onEvent = cb;
        return { close: vi.fn() };
      }),
      startConversation: vi.fn().mockImplementation(async () => {
        onEvent({ type: 'plan_token', token: 'Check' });
        onEvent({ type: 'plan_token', token: 'ing' });
        onEvent({ type: 'research_step', tool: 'grep', args: '{"pattern":"auth"}' });
        return { tasks: [] };
      }),
    });

    await runEffect({ type: 'startConversation', goal: 'x' }, h.deps);

    const relevant = h.actions.filter((a) => a.type === 'plannerToken' || a.type === 'researchStep');
    expect(relevant.map((a) => a.type)).toEqual(['plannerToken', 'researchStep']);
    expect(relevant[0]).toMatchObject({ type: 'plannerToken', text: 'Checking', sessionId: 'session-new' });
  });

  it('a full turn — token burst, a research step, another burst, then the final message — replays through the reducer in arrival order', async () => {
    let onEvent: (e: any) => void = () => {};
    const h = harness({
      streamPlanning: vi.fn().mockImplementation((_id: string, cb: (e: any) => void) => {
        onEvent = cb;
        return { close: vi.fn() };
      }),
      startConversation: vi.fn().mockImplementation(async () => {
        onEvent({ type: 'plan_token', token: 'Checking' });
        onEvent({ type: 'plan_token', token: ' the auth module' });
        onEvent({ type: 'research_step', tool: 'grep', args: '{"pattern":"auth"}', toolCallId: 'tc-1' });
        onEvent({ type: 'research_step_done', toolCallId: 'tc-1', step: { tool: 'grep', args: '{"pattern":"auth"}', toolCallId: 'tc-1', outcome: 'ok', result: '3 matches' } });
        onEvent({ type: 'plan_token', token: 'Found it.' });
        onEvent({ type: 'planner_message', content: 'Found it in middleware/auth.ts.' });
        return { tasks: [], conversationHistory: [] };
      }),
    });

    await runEffect({ type: 'startConversation', goal: 'x' }, h.deps);

    let state: TuiState = { ...initialState(), sessionId: 'session-new' };
    for (const action of h.actions) {
      ({ state } = reduce(state, action));
    }

    expect(state.messages.map((m) => m.role)).toEqual(['assistant', 'research', 'assistant']);
    expect(state.messages[0]).toMatchObject({ content: 'Checking the auth module', streaming: true });
    expect(state.messages[2]).toMatchObject({ content: 'Found it in middleware/auth.ts.' });
    expect(state.messages[2].streaming).toBeFalsy();
  });

  it('notes a silent approval decision instead of leaving it invisible', async () => {
    let onEvent: (e: any) => void = () => {};
    const h = harness({
      streamPlanning: vi.fn().mockImplementation((_id: string, cb: (e: any) => void) => {
        onEvent = cb;
        return { close: vi.fn() };
      }),
      startConversation: vi.fn().mockImplementation(async () => {
        onEvent({ type: 'approval_decided', kind: 'shell_command', subject: 'npm test', scope: 'npm test', granted: true, source: 'pre-approved' });
        return { tasks: [] };
      }),
    });

    await runEffect({ type: 'startConversation', goal: 'x' }, h.deps);

    const notice = h.actions.find((a) => a.type === 'notice') as any;
    expect(notice?.message).toContain('npm test');
    expect(notice?.message).toMatch(/pre-approved/i);
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

  it('queues a follow-up message until the active planner turn settles', async () => {
    let finishFirstTurn: (plan: { tasks: never[] }) => void = () => {};
    const h = harness({
      startConversation: vi.fn().mockImplementation(
        () => new Promise<{ tasks: never[] }>((resolve) => { finishFirstTurn = resolve; }),
      ),
    });

    const firstTurn = runEffect({ type: 'startConversation', goal: 'research the codebase' }, h.deps);
    const followUp = runEffect({ type: 'sendMessage', sessionId: 'session-new', message: 'also cover caching' }, h.deps);

    expect(h.api.sendConversationMessage).not.toHaveBeenCalled();

    finishFirstTurn({ tasks: [] });
    await Promise.all([firstTurn, followUp]);

    expect(h.api.sendConversationMessage).toHaveBeenCalledWith('session-new', 'also cover caching');
  });
});

describe('execution', () => {
  it('subscribes before execution so immediate task status updates reach the loading indicator', async () => {
    let onEvent: ((event: any) => void) | undefined;
    const h = harness({
      streamExecution: vi.fn().mockImplementation((_id: string, callback: (event: any) => void, onReady?: (error?: Error) => void) => {
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
  const withEvents = (...events: any[]) =>
    harness({
      streamExecution: vi.fn().mockImplementation((_id: string, cb: (e: any) => void, onReady?: (error?: Error) => void) => {
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
      updates: { a: { status: 'completed', idleSince: null }, b: { status: 'running', idleSince: null } },
      sessionId: 's1',
    });
  });

  it('drains a queued edit on queue_ready so dependents resume fanning out', async () => {
    const h = withEvents({ type: 'queue_ready' });
    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    expect(h.actions).toContainEqual({ type: 'queueReady', sessionId: 's1' });
  });

  it('the processQueued effect drains the queue over the daemon and refreshes the plan', async () => {
    const h = harness();
    await runEffect({ type: 'processQueued', sessionId: 's1' }, h.deps);

    expect(h.api.processQueued).toHaveBeenCalledWith('s1');
    expect(h.api.getSession).toHaveBeenCalledWith('s1', '/ws');
  });

  it('names the task that just started in the status line', async () => {
    const h = withEvents({ type: 'task_started', taskId: 'a', order: 1, title: 'Add route', runner: 'opencode' });
    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    const step = h.actions.find((a) => a.type === 'researchStep') as any;
    expect(step.summary).toContain('Add route');
  });

  it('shows a checkpoint summary, as the VS Code checkpoint panel does', async () => {
    const h = withEvents({ type: 'checkpoint', taskId: 'a', taskTitle: 'Add route', summary: 'Wrote the handler' });
    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    const notice = h.actions.find((a) => a.type === 'notice') as any;
    expect(notice.message).toBe('· Checkpoint — Add route: Wrote the handler');
  });

  it('truncates a long checkpoint summary to a single line', async () => {
    const longSummary = 'Line one of reasoning.\nLine two with more details that goes on and on and on about the checkpoint reasoning from the agent.';
    const h = withEvents({ type: 'checkpoint', taskId: 'a', taskTitle: 'Add route', summary: longSummary });
    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    const notice = h.actions.find((a) => a.type === 'notice') as any;
    expect(notice.message).not.toContain('\n');
    expect(notice.message).toContain('· Checkpoint — Add route:');
  });

  it('asks for sign-off when the plan needs review', async () => {
    const h = withEvents({ type: 'review_needed', tasks: [] });
    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    const notice = h.actions.find((a) => a.type === 'notice') as any;
    expect(notice.message).toMatch(/approve/i);
  });

  it('takes a plan pushed over the stream', async () => {
    const plan = { tasks: [{ id: 'a', title: 'T' }] };
    const h = withEvents({ type: 'plan_generated', plan, goal: 'g', runners: [] });
    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    expect(h.actions).toContainEqual({ type: 'planUpdated', plan, sessionId: 's1' });
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

  it('reports a stopped run too, without inventing a tally it was not sent', async () => {
    // `execution_stopped` carries no summary. While the stream was typed `any`
    // this read `event.summary` for both variants and passed undefined through.
    const h = withEvents({ type: 'execution_stopped' });
    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    const complete = h.actions.find((a) => a.type === 'executionComplete');
    expect(complete).toBeDefined();
    expect(complete).not.toHaveProperty('summary');
  });

  it('notes a silent approval decision reached mid-execution', async () => {
    const h = withEvents({ type: 'approval_decided', kind: 'shell_command', subject: 'npm test', scope: 'npm test', granted: false, source: 'mode' });
    await runEffect({ type: 'execute', sessionId: 's1' }, h.deps);

    const notice = h.actions.find((a) => a.type === 'notice') as any;
    expect(notice?.message).toMatch(/auto-denied/i);
    expect(notice?.message).toContain('npm test');
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
      streamExecution: vi.fn().mockImplementation((_id: string, onEvent: (event: any) => void, onReady?: () => void) => {
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

  it('opens a terminal for a task and reports success as a notice', async () => {
    const h = harness();
    (h.deps.openTerminal as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, message: 'Opened a terminal for this task.' });

    await runEffect({ type: 'openTaskTerminal', sessionId: 's1', taskId: 't1' }, h.deps);

    expect(h.deps.openTerminal).toHaveBeenCalledWith('s1', 't1');
    expect(h.actions).toContainEqual({ type: 'notice', message: 'Opened a terminal for this task.' });
  });

  it('surfaces a failed terminal open as an error, not a crash', async () => {
    const h = harness();
    (h.deps.openTerminal as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, message: "This task hasn't opened a terminal yet — it may still be pending." });

    await runEffect({ type: 'openTaskTerminal', sessionId: 's1', taskId: 't1' }, h.deps);

    expect(h.actions).toContainEqual({ type: 'failed', message: "This task hasn't opened a terminal yet — it may still be pending." });
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
        plannerModels: { 'claude-code': { model: 'sonnet', effort: 'high' } },
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
        plannerModels: { 'claude-code': { model: 'sonnet' } },
      }),
    });

    await runEffect({ type: 'setPlanner', provider: 'claude-code' }, h.deps);

    const notice = h.actions.find((a) => a.type === 'notice') as any;
    expect(notice.message).toContain('Restored sonnet.');
  });

  it('names the catalog default and points at /model when nothing was remembered', async () => {
    const h = harness({
      updateSettings: vi.fn().mockResolvedValue({ orchestratorModel: 'sonnet', plannerModels: {} }),
    });

    await runEffect({ type: 'setPlanner', provider: 'claude-code' }, h.deps);

    const notice = h.actions.find((a) => a.type === 'notice') as any;
    expect(notice.message).toContain('default model, sonnet');
    expect(notice.message).toContain('/model');
  });

  it('keeps the "pick a model" guidance when the daemon resolved nothing', async () => {
    const h = harness({ updateSettings: vi.fn().mockResolvedValue({ orchestratorModel: '' }) });

    await runEffect({ type: 'setPlanner', provider: 'claude-code' }, h.deps);

    const notice = h.actions.find((a) => a.type === 'notice') as any;
    expect(notice.message).toContain('Pick a model with /model.');
  });
});

describe('skills and settings', () => {
  it('sends a skill toggle and mirrors the settings that come back', async () => {
    const h = harness();
    await runEffect({ type: 'command', name: 'tdd', action: 'on' }, h.deps);

    expect(h.api.sendCommand).toHaveBeenCalledWith('tdd', { action: 'on' });
    expect(h.actions).toContainEqual({ type: 'settingsLoaded', settings: { tdd: { enabled: true } } });
  });

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

    const loaded = h.actions.find((a) => a.type === 'modelsLoaded') as any;
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

    const loaded = h.actions.find((action) => action.type === 'modelsLoaded') as any;
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

    const loaded = h.actions.find((a) => a.type === 'modelsLoaded') as any;
    expect(loaded.orchestratorModels[0]).toMatchObject({
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

    const loaded = h.actions.find((a) => a.type === 'modelsLoaded') as any;
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

    const notice = h.actions.find((a) => a.type === 'notice') as any;
    expect(notice.message).toMatch(/Rate limiting/);
  });

  it('reports a session the server cannot adopt', async () => {
    const h = harness({ adoptSession: vi.fn().mockRejectedValue(new Error('Session not found')) });
    await runEffect({ type: 'loadSession', sessionId: 's9' }, h.deps);

    expect(types(h.actions)).toContain('failed');
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
});

describe('failures', () => {
  // Now that loading adopts the session, this only happens when the daemon has
  // restarted underneath us — so the advice is to reload, not to re-plan.
  it('tells the user to reload a session the daemon no longer holds', async () => {
    const h = harness({ markTaskComplete: vi.fn().mockRejectedValue(new Error('Session not found')) });
    await runEffect({ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'complete' }, h.deps);

    const failure = h.actions.find((a) => a.type === 'failed') as any;
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
        .mockRejectedValue(new Error('Session not found')),
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
